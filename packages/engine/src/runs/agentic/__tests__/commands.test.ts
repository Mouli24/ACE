import {
  AgentConfigSchema,
  NodeSchema,
  derivePorts,
  type AgentWorkspace,
  type Node,
} from '@ace/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../../__tests__/fake-repository.js';
import { staleVersion } from '../../../gateway/errors.js';
import { createGraphService, type GraphService } from '../../../graph/index.js';
import { newId } from '../../../ids.js';
import { createLogger } from '../../../logging/index.js';
import { LOCAL_SCOPE } from '../../../ports/index.js';
import {
  commandGate,
  createAlwaysAllow,
  createRunAllowlist,
  saveAllowedCommand,
  toolCommandFor,
  type CommandClassification,
  type CommandClassifier,
} from '../commands.js';

/**
 * D376 (agentic nodes, FR-GRD-006, D342/D348): the command gate, the run's allowlist and Always
 * allow saving the prefix on the node.
 *
 * The engine may not import `@ace/tools` (CLAUDE.md §3.4 rule 3), so `classifyCommand` arrives as
 * an injected `CommandClassifier`. `RECORDED` is what the real classifier answers for the brief's
 * five commands; `packages/tools/src/agent/command-gate.test.ts` runs the same five through the
 * real `classifyCommand`, so a drift between the two shows up there.
 */

const RECORDED: Record<string, CommandClassification> = {
  'pnpm test': { autoAllowed: true, alwaysAllowPrefix: 'pnpm test', denied: [] },
  'pnpm install && pnpm test': { autoAllowed: false, denied: [] },
  'git push --force': { autoAllowed: false, denied: ['git-force-push'] },
  'npm run build': { autoAllowed: false, alwaysAllowPrefix: 'npm run build', denied: [] },
  'echo $(whoami)': { autoAllowed: false, denied: [] },
};

const recorded: CommandClassifier = (command) => {
  const answer = RECORDED[command];
  if (answer === undefined) throw new Error(`no recorded classification for ${command}`);
  return answer;
};

/** A classifier that allows exactly the listed lines and offers the whole line as the prefix. */
const exact: CommandClassifier = (command, allowlist) => ({
  autoAllowed: allowlist.includes(command),
  alwaysAllowPrefix: command,
  denied: [],
});

describe('D376 commandGate', () => {
  it('allows a command the allowlist covers', () => {
    expect(commandGate('pnpm test', ['pnpm test'], recorded)).toEqual({ kind: 'allow' });
  });

  it('asks for a compound line the allowlist covers only in part, offering no prefix', () => {
    expect(commandGate('pnpm install && pnpm test', ['pnpm install'], recorded)).toEqual({
      kind: 'ask',
      denylisted: false,
    });
  });

  it('asks for a denylisted command even when its prefix is allowed, and never offers Always', () => {
    expect(commandGate('git push --force', ['git push'], recorded)).toEqual({
      kind: 'ask',
      denylisted: true,
    });
  });

  it('asks for an unlisted command and offers its prefix', () => {
    expect(commandGate('npm run build', [], recorded)).toEqual({
      kind: 'ask',
      allowPrefix: 'npm run build',
      denylisted: false,
    });
  });

  it('asks for a line it cannot read confidently, offering no prefix', () => {
    expect(commandGate('echo $(whoami)', [], recorded)).toEqual({
      kind: 'ask',
      denylisted: false,
    });
  });

  it('hands the classifier the command and the allowlist as given', () => {
    const classify = vi.fn<CommandClassifier>(() => ({ autoAllowed: false, denied: [] }));
    commandGate('ls -la', ['ls'], classify);
    expect(classify).toHaveBeenCalledWith('ls -la', ['ls']);
  });

  it('fails closed on a classification that contradicts itself', () => {
    // Allowed and denied at once: the denylist wins, and nothing is offered.
    expect(
      commandGate('x', [], () => ({ autoAllowed: true, alwaysAllowPrefix: 'x', denied: ['d'] })),
    ).toEqual({ kind: 'ask', denylisted: true });
  });

  it('offers no prefix that could not be saved as an allowed command', () => {
    const long = 'x'.repeat(201);
    expect(
      commandGate(long, [], () => ({ autoAllowed: false, alwaysAllowPrefix: long, denied: [] })),
    ).toEqual({ kind: 'ask', denylisted: false });
    expect(
      commandGate('x', [], () => ({ autoAllowed: false, alwaysAllowPrefix: '', denied: [] })),
    ).toEqual({ kind: 'ask', denylisted: false });
  });
});

/* -------------------------------------------------------------------------- */
/* Nodes                                                                       */
/* -------------------------------------------------------------------------- */

const WORKFLOW_ID = newId();

function agent(workspace?: AgentWorkspace, name = 'Builder'): Node {
  const id = newId();
  const config = AgentConfigSchema.parse({
    instructions: `Act as ${name}.`,
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...(workspace === undefined ? {} : { workspace }),
  });
  return NodeSchema.parse({
    id,
    workflowId: WORKFLOW_ID,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    config,
    ...derivePorts({ id, kind: 'agent', config } as Parameters<typeof derivePorts>[0]),
  });
}

function input(): Node {
  const id = newId();
  const config = { artifactIds: [], outputTypes: ['text'] };
  return NodeSchema.parse({
    id,
    workflowId: WORKFLOW_ID,
    kind: 'input',
    name: 'Brief',
    position: { x: 0, y: 0 },
    config,
    ...derivePorts({ id, kind: 'input', config } as Parameters<typeof derivePorts>[0]),
  });
}

const commandsWs = (allowedCommands: string[] = []): AgentWorkspace => ({
  access: 'edit_commands',
  maxTurns: 50,
  allowedCommands,
});

describe('D376 the run allowlist', () => {
  it("is seeded from each node's saved allowed commands, and empty for anything else", () => {
    const builder = agent(commandsWs(['pnpm test']));
    const off = agent(undefined, 'Writer');
    const brief = input();
    const allowlist = createRunAllowlist([builder, off, brief]);

    expect(allowlist.for(builder.id)).toEqual(['pnpm test']);
    expect(allowlist.for(off.id)).toEqual([]);
    expect(allowlist.for(brief.id)).toEqual([]);
    expect(allowlist.for(newId())).toEqual([]);
  });

  it('adds a prefix to one node, once, and never writes the snapshot', () => {
    const builder = agent(commandsWs(['pnpm test']));
    const other = agent(commandsWs(), 'Tester');
    const allowlist = createRunAllowlist([builder, other]);

    allowlist.add(builder.id, 'npm run build');
    allowlist.add(builder.id, 'npm run build');

    expect(allowlist.for(builder.id)).toEqual(['pnpm test', 'npm run build']);
    expect(allowlist.for(other.id)).toEqual([]);
    // BR-04, D345: the snapshot node is written once.
    expect(builder.kind === 'agent' && builder.config.workspace?.allowedCommands).toEqual([
      'pnpm test',
    ]);
  });

  it('hands out a copy, so a caller cannot widen it by mutation', () => {
    const builder = agent(commandsWs());
    const allowlist = createRunAllowlist([builder]);
    (allowlist.for(builder.id) as string[]).push('rm -rf /');
    expect(allowlist.for(builder.id)).toEqual([]);
  });
});

describe('D376 the command in the tool bag', () => {
  it("gates an agentic node's run_command against the run allowlist, live", () => {
    const builder = agent(commandsWs());
    const allowlist = createRunAllowlist([builder]);
    const bagFor = () =>
      toolCommandFor({
        node: builder,
        toolName: 'run_command',
        args: { command: 'npm run build' },
        allowlist,
        classify: exact,
      });

    expect(bagFor()).toEqual({
      text: 'npm run build',
      gate: { kind: 'ask', allowPrefix: 'npm run build', denylisted: false },
    });
    allowlist.add(builder.id, 'npm run build');
    expect(bagFor()).toEqual({ text: 'npm run build', gate: { kind: 'allow' } });
  });

  it('leaves an Off node, another tool and an unreadable call alone', () => {
    const builder = agent(commandsWs());
    const off = agent(undefined, 'Writer');
    const allowlist = createRunAllowlist([builder, off]);
    const of = (node: Node, toolName: string, args: unknown) =>
      toolCommandFor({ node, toolName, args, allowlist, classify: exact });

    expect(of(off, 'run_command', { command: 'npm run build' })).toBeUndefined();
    expect(of(builder, 'write_file', { path: 'a.txt', content: '' })).toBeUndefined();
    expect(of(builder, 'run_command', { command: 7 })).toBeUndefined();
    expect(of(builder, 'run_command', null)).toBeUndefined();
    expect(of(input(), 'run_command', { command: 'ls' })).toBeUndefined();
  });

  it('asks, with nothing offered, when no classifier is wired', () => {
    const builder = agent(commandsWs(['npm run build']));
    expect(
      toolCommandFor({
        node: builder,
        toolName: 'run_command',
        args: { command: 'npm run build' },
        allowlist: createRunAllowlist([builder]),
      }),
    ).toEqual({ text: 'npm run build', gate: { kind: 'ask', denylisted: false } });
  });
});

/* -------------------------------------------------------------------------- */
/* Always allow → the saved workflow                                           */
/* -------------------------------------------------------------------------- */

const silent = () => createLogger({ level: 'silent', destination: { write: () => undefined } });

async function savedWorkflow(nodes: (graph: GraphService, workflowId: string) => Node[]) {
  const repository = new FakeRepository();
  const updates: number[] = [];
  const graph = createGraphService({
    repository,
    scope: LOCAL_SCOPE,
    logger: silent(),
    onWorkflowUpdated: async (_workflowId, version) => {
      updates.push(version);
    },
  });
  const project = await graph.createProject({ name: 'Builds' });
  const workflow = await graph.createWorkflow(project.id, 'Flow');
  const added = nodes(graph, workflow.id).map((node) => ({ ...node, workflowId: workflow.id }));
  await graph.applyGraphOps(workflow.id, {
    baseVersion: workflow.version,
    ops: added.map((node) => ({ op: 'add_node', node })),
  });
  updates.length = 0;
  const nodeOf = async (nodeId: string) => {
    const { nodes: saved, workflow: row } = await graph.getWorkflowGraph(workflow.id);
    return { node: saved.find((node) => node.id === nodeId), version: row.version };
  };
  return { graph, workflowId: workflow.id, nodes: added, updates, nodeOf };
}

const allowedOf = (node: Node | undefined): string[] | undefined =>
  node?.kind === 'agent' ? node.config.workspace?.allowedCommands : undefined;

describe("D376 Always allow saves the prefix on the workflow's node", () => {
  it('through a normal node update: the version moves on and the workflow event fires', async () => {
    const w = await savedWorkflow(() => [agent(commandsWs(['pnpm test']))]);
    const [builder] = w.nodes;
    const before = await w.nodeOf(builder!.id);

    expect(await saveAllowedCommand(w.graph, w.workflowId, builder!.id, 'npm run build')).toBe(
      'saved',
    );

    const after = await w.nodeOf(builder!.id);
    expect(allowedOf(after.node)).toEqual(['pnpm test', 'npm run build']);
    expect(after.version).toBe(before.version + 1);
    expect(w.updates).toEqual([after.version]);
    // Only the list changed: the rest of the workspace is as it was.
    expect(after.node?.kind === 'agent' && after.node.config.workspace?.access).toBe(
      'edit_commands',
    );
  });

  it('writes nothing when the node already lists it, or is gone, or is not an agent', async () => {
    const w = await savedWorkflow(() => [agent(commandsWs(['npm run build'])), input()]);
    const [builder, brief] = w.nodes;
    const { version } = await w.nodeOf(builder!.id);

    expect(await saveAllowedCommand(w.graph, w.workflowId, builder!.id, 'npm run build')).toBe(
      'unchanged',
    );
    expect(await saveAllowedCommand(w.graph, w.workflowId, newId(), 'ls')).toBe('missing');
    expect(await saveAllowedCommand(w.graph, w.workflowId, brief!.id, 'ls')).toBe('missing');
    expect((await w.nodeOf(builder!.id)).version).toBe(version);
    expect(w.updates).toEqual([]);
  });

  it('writes nothing to a node whose list is full', async () => {
    const full = Array.from({ length: 100 }, (_, index) => `tool${index}`);
    const w = await savedWorkflow(() => [agent(commandsWs(full))]);
    const [builder] = w.nodes;

    expect(await saveAllowedCommand(w.graph, w.workflowId, builder!.id, 'npm run build')).toBe(
      'full',
    );
    expect(allowedOf((await w.nodeOf(builder!.id)).node)).toHaveLength(100);
  });

  it('reads the graph again and retries when someone saved the workflow in between', async () => {
    const w = await savedWorkflow(() => [agent(commandsWs())]);
    const [builder] = w.nodes;
    let raced = false;
    const racing: Pick<GraphService, 'getWorkflowGraph' | 'applyGraphOps'> = {
      getWorkflowGraph: (id) => w.graph.getWorkflowGraph(id),
      applyGraphOps: async (id, request) => {
        if (!raced) {
          raced = true;
          throw staleVersion(99);
        }
        return w.graph.applyGraphOps(id, request);
      },
    };

    expect(await saveAllowedCommand(racing, w.workflowId, builder!.id, 'npm run build')).toBe(
      'saved',
    );
    expect(allowedOf((await w.nodeOf(builder!.id)).node)).toEqual(['npm run build']);
  });

  it('createAlwaysAllow adds to the live run first, then saves, and never throws', async () => {
    const w = await savedWorkflow(() => [agent(commandsWs())]);
    const [builder] = w.nodes;
    const live = createRunAllowlist([builder!]);
    const runId = newId();
    const alwaysAllow = createAlwaysAllow({
      allowlistFor: (id) => (id === runId ? live : undefined),
      workflowOf: async (id) => (id === runId ? w.workflowId : undefined),
      graph: w.graph,
      logger: silent(),
    });

    await alwaysAllow(runId, builder!.id, 'npm run build');
    expect(live.for(builder!.id)).toEqual(['npm run build']);
    expect(allowedOf((await w.nodeOf(builder!.id)).node)).toEqual(['npm run build']);

    // A failing save is logged, not thrown: the decision has already been recorded.
    const failing = createAlwaysAllow({
      allowlistFor: () => live,
      workflowOf: async () => w.workflowId,
      graph: {
        getWorkflowGraph: async () => {
          throw new Error('disk full');
        },
        applyGraphOps: async () => {
          throw new Error('unreachable');
        },
      },
      logger: silent(),
    });
    await expect(failing(runId, builder!.id, 'pnpm lint')).resolves.toBeUndefined();
    expect(live.for(builder!.id)).toEqual(['npm run build', 'pnpm lint']);
  });
});
