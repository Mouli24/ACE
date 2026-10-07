import type { GraphOp, Node, Project, Provider, Workflow } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import { createAssistantService, projectNameFrom, ruleProposal } from '../service.js';

const NOW = '2026-10-07T10:00:00.000Z';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

const provider = (type: Provider['type'], name: string): Provider =>
  ({
    id: newId(),
    type,
    name,
    status: 'CONNECTED',
    keySet: false,
    concurrency: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as Provider;

describe('D283 rule proposals', () => {
  it('names the project from the request', () => {
    expect(projectNameFrom('Build a simple booking app for my salon')).toBe('Booking app');
    expect(projectNameFrom('Please make me a recipe site')).toBe('Recipe site');
    expect(projectNameFrom('Call it "Clinic Planner" and add tests')).toBe('Clinic Planner');
    expect(projectNameFrom('refactor everything quickly please')).toBe(
      'Refactor Everything Quickly Please',
    );
  });

  it('picks a team, a budget and a model from the words', () => {
    const single = ruleProposal({ prompt: 'Build a todo app' }, []);
    expect(single).toMatchObject({
      team: 'single-builder',
      projectName: 'Todo app',
      source: 'rules',
    });
    expect(single.agents.map((agent) => agent.role)).toEqual(['builder']);
    expect(single.notes[0]).toContain('Mock');

    const claude = provider('claude_code', 'Claude Code');
    const team = ruleProposal(
      {
        prompt:
          'Build a booking app. Have one agent plan it and another review it, $0.50 per run, use Claude Code.',
      },
      [claude],
    );
    expect(team.team).toBe('plan-build-review');
    expect(team.agents.map((agent) => agent.role)).toEqual(['planner', 'builder', 'reviewer']);
    expect(team.maxCostPerRunUsd).toBe(0.5);
    expect(
      team.agents.every((agent) => agent.providerId === claude.id && agent.modelId === 'default'),
    ).toBe(true);
    expect(team.agents[1]?.instructions).toContain('Booking app');
  });

  it('revises a previous proposal from a change request', () => {
    const first = ruleProposal({ prompt: 'Build a todo app' }, []);
    const reviewed = ruleProposal(
      { prompt: 'Add a reviewer and keep it under 2 dollars', previous: first },
      [],
    );
    expect(reviewed).toMatchObject({
      team: 'plan-build-review',
      projectName: 'Todo app',
      maxCostPerRunUsd: 2,
    });
    const back = ruleProposal(
      { prompt: 'Remove the reviewer, just one agent', previous: reviewed },
      [],
    );
    expect(back.team).toBe('single-builder');
    expect(back.maxCostPerRunUsd).toBe(2);
  });
});

describe('D283 model proposals', () => {
  it('uses a model draft when it is valid, and falls back to the rules when not', async () => {
    let answer = JSON.stringify({
      summary: 'A careful team for invoices.',
      projectName: 'Invoices',
      team: 'plan-build-review',
      agents: [
        { role: 'planner', name: 'Architect', instructions: 'Plan with care.' },
        { role: 'builder', name: 'Engineer', instructions: 'Build with tests.' },
        { role: 'reviewer', name: 'Critic', instructions: 'Review strictly.' },
      ],
      maxCostPerRunUsd: 1,
    });
    const service = createAssistantService({
      graph: {} as never,
      templates: {} as never,
      providers: async () => [],
      complete: async () => `Here you go:\n${answer}`,
      logger,
    });
    const drafted = await service.propose({
      prompt: 'invoices',
      providerId: newId(),
      modelId: 'gpt-x',
    });
    expect(drafted).toMatchObject({
      source: 'model',
      projectName: 'Invoices',
      maxCostPerRunUsd: 1,
    });
    expect(drafted.agents.map((agent) => agent.name)).toEqual(['Architect', 'Engineer', 'Critic']);

    answer = 'I cannot help with that.';
    const fallback = await service.propose({
      prompt: 'Build a todo app',
      providerId: newId(),
      modelId: 'gpt-x',
    });
    expect(fallback.source).toBe('rules');
    expect(fallback.notes.at(-1)).toContain('answer could not be used');
  });
});

describe('D283 applying a proposal', () => {
  it('creates the project and team, renames and instructs its agents and sets the budget', async () => {
    const project: Project = {
      id: newId(),
      name: 'Todo app',
      folderPath: 'D:/p',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const workflow: Workflow = {
      id: newId(),
      projectId: project.id,
      name: 'Plan, build and review',
      version: 1,
      formatVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const agent = (name: string) => ({ id: newId(), kind: 'agent', name }) as unknown as Node;
    const nodes = [agent('Planner'), agent('Builder'), agent('Reviewer')];
    const calls: { ops?: GraphOp[]; budget?: number | null } = {};
    const service = createAssistantService({
      graph: {
        createProject: async () => project,
        getProject: async () => project,
        updateProject: async (_id, patch) => {
          calls.budget = patch.maxCostPerRunUsd;
          return { ...project, maxCostPerRunUsd: patch.maxCostPerRunUsd ?? null };
        },
        applyGraphOps: async (_id, request) => {
          calls.ops = (request as { ops: GraphOp[] }).ops;
          return { version: 2 } as never;
        },
        getWorkflowGraph: async () => ({
          workflow: { ...workflow, version: 2 },
          nodes,
          edges: [],
        }),
      },
      templates: {
        instantiate: async () => ({ project, workflow, nodes, edges: [] }),
      },
      providers: async () => [],
      logger,
    });
    const proposal = ruleProposal({ prompt: 'Build a todo app, plan and review it, $3 a run' }, []);
    const applied = await service.apply({
      proposal: {
        ...proposal,
        agents: proposal.agents.map((each) =>
          each.role === 'reviewer' ? { ...each, name: 'Critic' } : each,
        ),
      },
    });
    expect(applied.workflow.version).toBe(2);
    expect(calls.budget).toBe(3);
    expect(calls.ops).toHaveLength(3);
    expect(calls.ops?.[2]).toMatchObject({
      op: 'update_node',
      nodeId: nodes[2]?.id,
      patch: { name: 'Critic' },
    });
  });
});
