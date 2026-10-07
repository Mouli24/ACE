import type {
  AssistantAgent,
  AssistantApplyRequest,
  AssistantApplyResponse,
  AssistantProposal,
  AssistantProposeRequest,
  AssistantRole,
  AssistantTeam,
  GraphOp,
  Id,
  Project,
  Provider,
} from '@ace/contracts';
import { AssistantRoleSchema, AssistantTeamSchema } from '@ace/contracts';
import { z } from 'zod';

import type { GraphService } from '../graph/index.js';
import type { Logger } from '../logging/index.js';
import type { TemplateService } from '../templates/service.js';

/**
 * Ace Assistant project setup (ACE parity P2, D283). `propose` drafts — with a connected model when
 * one is chosen, with plain rules otherwise — and never writes anything; `apply` (the confirmation
 * tick) creates the project, instantiates the team template, renames and instructs its agents, sets
 * their models and the run budget, and answers with the workflow so the client opens its canvas.
 */
export interface AssistantService {
  propose(body: AssistantProposeRequest): Promise<AssistantProposal>;
  apply(body: AssistantApplyRequest): Promise<AssistantApplyResponse>;
}

export interface AssistantServiceDeps {
  graph: Pick<
    GraphService,
    'createProject' | 'getProject' | 'updateProject' | 'getWorkflowGraph' | 'applyGraphOps'
  >;
  templates: Pick<TemplateService, 'instantiate'>;
  /** The connected providers, to match "use Claude Code" to one. */
  providers: () => Promise<Provider[]>;
  /** One text completion on a connected model; absent, every proposal comes from the rules. */
  complete?: (input: {
    providerId: Id;
    modelId: string;
    system: string;
    prompt: string;
  }) => Promise<string>;
  logger: Logger;
}

/** What the template's agents are called, by role (engine `templates/definitions.ts`, D279). */
const TEMPLATE_AGENT_NAME: Record<AssistantRole, string> = {
  planner: 'Planner',
  builder: 'Builder',
  reviewer: 'Reviewer',
};

const ROLES_OF: Record<AssistantTeam, AssistantRole[]> = {
  'single-builder': ['builder'],
  'plan-build-review': ['planner', 'builder', 'reviewer'],
};

const titleCase = (text: string): string =>
  text
    .trim()
    .split(/\s+/)
    .map((word) => (word === '' ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');

function firstSentence(text: string): string {
  const match = /^(.{1,240}?[.!?])(\s|$)/s.exec(text.trim());
  return (match?.[1] ?? text.trim().slice(0, 240)).replace(/\s+/g, ' ');
}

/** "build a simple booking app" → "Booking app"; else the first words. */
export function projectNameFrom(prompt: string): string {
  const named = /\b(?:call it|name it|called)\s+"?([^".\n]{2,60})"?/i.exec(prompt);
  if (named?.[1] !== undefined) return titleCase(named[1]).slice(0, 120);
  const built =
    /\b(?:build|make|create|write|set up)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:simple\s+|small\s+|tiny\s+|new\s+)*([a-z0-9][a-z0-9 -]{1,40}?)\s+(app|site|website|tool|api|service|cli|game|bot)\b/i.exec(
      prompt,
    );
  if (built?.[1] !== undefined && built[2] !== undefined) {
    const name = `${built[1].trim()} ${built[2].toLowerCase()}`;
    return name[0]!.toUpperCase() + name.slice(1);
  }
  return (
    titleCase(
      prompt
        .replace(/[^\w\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .join(' '),
    ) || 'New project'
  );
}

function instructionsFor(role: AssistantRole, projectName: string, context: string): string {
  const about = `This team works on ${projectName}: ${context}`;
  switch (role) {
    case 'planner':
      return `${about}\nRestate the task in full, then write a short numbered plan: the files to change and how to check the result. Do not change any files.`;
    case 'builder':
      return `${about}\nMake the change the task asks for and nothing else; keep it small and consistent with the code around it. Run the project's tests if you can. End with a short summary of what you changed and how you checked it.`;
    case 'reviewer':
      return `${about}\nReview the change against the task and the plan. Answer with a score out of ten, a verdict and the issues you found.`;
  }
}

/** A provider the prompt names ("use Claude Code", "on Ollama"), and its first usable model. */
function namedModel(
  prompt: string,
  providers: Provider[],
): { providerId: Id; modelId: string; label: string } | undefined {
  const wanted: [RegExp, Provider['type']][] = [
    [/claude code/i, 'claude_code'],
    [/codex/i, 'codex_cli'],
    [/gemini cli/i, 'gemini_cli'],
    [/ollama|local model/i, 'ollama'],
    [/\bclaude\b|anthropic/i, 'anthropic'],
    [/\bgpt\b|openai/i, 'openai'],
    [/gemini|google/i, 'google'],
  ];
  for (const [pattern, type] of wanted) {
    if (!pattern.test(prompt)) continue;
    const provider = providers.find((candidate) => candidate.type === type);
    if (provider !== undefined) {
      const cli = type === 'claude_code' || type === 'codex_cli' || type === 'gemini_cli';
      return cli
        ? { providerId: provider.id, modelId: 'default', label: provider.name }
        : undefined;
    }
  }
  return undefined;
}

/** The rules: what a proposal is when no model drafts it, or when a model's draft is unusable. */
export function ruleProposal(
  body: AssistantProposeRequest,
  providers: Provider[],
): AssistantProposal {
  const text = body.prompt;
  const previous = body.previous;
  const notes: string[] = [];

  let team: AssistantTeam = previous?.team ?? 'single-builder';
  if (previous === undefined) {
    if (/\b(review|reviewer|plan|planner|check (my|the|its) work)\b/i.test(text))
      team = 'plan-build-review';
  } else if (/\b(add|with|include)\b.*\b(review(er)?|plan(ner)?)\b/i.test(text)) {
    team = 'plan-build-review';
  } else if (
    /\b(remove|no|without|drop)\b.*\b(review(er)?|plan(ner)?)\b|\b(single|one agent|just one)\b/i.test(
      text,
    )
  ) {
    team = 'single-builder';
  }

  const budget = /\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:dollars|usd)\b/i.exec(text);
  const maxCost = budget === null ? previous?.maxCostPerRunUsd : Number(budget[1] ?? budget[2]);

  const projectName =
    previous !== undefined && !/\b(call it|name it|called)\b/i.test(text)
      ? previous.projectName
      : projectNameFrom(text);
  const context = previous === undefined ? firstSentence(text) : firstSentence(previous.summary);

  const model = namedModel(text, providers);
  if (model !== undefined) notes.push(`Every agent runs on ${model.label}.`);
  else if (previous === undefined) {
    notes.push(
      'The agents start on the no-key Mock models; choose real models on the canvas or ask me to use one (for example "use Claude Code").',
    );
  }

  const agents: AssistantAgent[] = ROLES_OF[team].map((role) => {
    const kept = previous?.agents.find((agent) => agent.role === role);
    const chosen =
      model ??
      (kept?.providerId === undefined
        ? undefined
        : { providerId: kept.providerId, modelId: kept.modelId ?? 'default' });
    return {
      role,
      name: kept?.name ?? TEMPLATE_AGENT_NAME[role],
      instructions: kept?.instructions ?? instructionsFor(role, projectName, context),
      ...(chosen === undefined ? {} : { providerId: chosen.providerId, modelId: chosen.modelId }),
    };
  });

  const who =
    team === 'single-builder'
      ? 'one builder agent'
      : 'a planner, a builder and a reviewer that sends work back until it is right';
  return {
    summary: `Set up ${projectName} with ${who}.${maxCost === undefined ? '' : ` Each run may spend at most $${maxCost}.`} Tasks on its board will be done in their own Git branch and reviewed before anything reaches the project.`,
    projectName,
    ...(body.projectId === undefined
      ? previous?.projectId === undefined
        ? {}
        : { projectId: previous.projectId }
      : { projectId: body.projectId }),
    team,
    agents,
    ...(maxCost === undefined ? {} : { maxCostPerRunUsd: maxCost }),
    notes,
    source: 'rules',
  };
}

/** What a model is asked to answer. */
const ModelDraftSchema = z.object({
  summary: z.string().min(1).max(2_000),
  projectName: z.string().trim().min(1).max(120),
  team: AssistantTeamSchema,
  agents: z
    .array(
      z.object({
        role: AssistantRoleSchema,
        name: z.string().trim().min(1).max(80),
        instructions: z.string().trim().min(1).max(8_000),
      }),
    )
    .min(1)
    .max(3),
  maxCostPerRunUsd: z.number().positive().optional(),
  notes: z.array(z.string().max(500)).max(10).optional(),
});

const SYSTEM = [
  'You set up coding projects in ACE. A project gets one team:',
  '- "single-builder": one agent with role "builder";',
  '- "plan-build-review": agents with roles "planner", "builder" and "reviewer" (the reviewer sends work back until it is right).',
  'Answer with JSON only, no prose, matching:',
  '{"summary": string, "projectName": string, "team": "single-builder"|"plan-build-review",',
  ' "agents": [{"role": "planner"|"builder"|"reviewer", "name": string, "instructions": string}],',
  ' "maxCostPerRunUsd"?: number, "notes"?: string[]}',
  'Include exactly the roles the team has. Instructions say how that agent should work on this project.',
].join('\n');

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export function createAssistantService(deps: AssistantServiceDeps): AssistantService {
  return {
    async propose(body) {
      const providers = await deps.providers();
      const rules = ruleProposal(body, providers);
      if (
        body.providerId === undefined ||
        body.modelId === undefined ||
        deps.complete === undefined
      ) {
        return rules;
      }
      try {
        const prompt = [
          body.previous === undefined
            ? `The user wants: ${body.prompt}`
            : `The current proposal:\n${JSON.stringify(body.previous)}\n\nThe user asks to change: ${body.prompt}`,
        ].join('\n');
        const answer = await deps.complete({
          providerId: body.providerId,
          modelId: body.modelId,
          system: SYSTEM,
          prompt,
        });
        const draft = ModelDraftSchema.parse(extractJson(answer));
        const roles = ROLES_OF[draft.team];
        const agents = roles.map((role) => {
          const drafted = draft.agents.find((agent) => agent.role === role);
          const fallback = rules.agents.find((agent) => agent.role === role);
          return {
            role,
            name: drafted?.name ?? fallback?.name ?? TEMPLATE_AGENT_NAME[role],
            instructions:
              drafted?.instructions ??
              fallback?.instructions ??
              instructionsFor(role, draft.projectName, body.prompt),
            ...(fallback?.providerId === undefined
              ? {}
              : { providerId: fallback.providerId, modelId: fallback.modelId ?? 'default' }),
          };
        });
        return {
          summary: draft.summary,
          projectName: draft.projectName,
          ...(rules.projectId === undefined ? {} : { projectId: rules.projectId }),
          team: draft.team,
          agents,
          ...(draft.maxCostPerRunUsd === undefined
            ? rules.maxCostPerRunUsd === undefined
              ? {}
              : { maxCostPerRunUsd: rules.maxCostPerRunUsd }
            : { maxCostPerRunUsd: draft.maxCostPerRunUsd }),
          notes: draft.notes ?? [],
          source: 'model',
        };
      } catch (error) {
        deps.logger.warn(
          { subsystem: 'assistant', err: error },
          'model proposal unusable; rules used',
        );
        return {
          ...rules,
          notes: [
            ...rules.notes,
            `The model's answer could not be used (${error instanceof Error ? error.message : String(error)}); this proposal comes from ACE's rules.`,
          ].slice(0, 10),
        };
      }
    },

    async apply(body) {
      const proposal = body.proposal;
      let project: Project;
      if (proposal.projectId !== undefined) {
        project = await deps.graph.getProject(proposal.projectId);
      } else {
        project = await deps.graph.createProject({
          name: proposal.projectName,
          ...(body.folderPath === undefined ? {} : { folderPath: body.folderPath }),
        });
      }
      const created = await deps.templates.instantiate(proposal.team, { projectId: project.id });
      const ops: GraphOp[] = [];
      for (const agent of proposal.agents) {
        const node = created.nodes.find(
          (candidate) =>
            candidate.kind === 'agent' && candidate.name === TEMPLATE_AGENT_NAME[agent.role],
        );
        if (node === undefined) continue;
        ops.push({
          op: 'update_node',
          nodeId: node.id,
          patch: {
            name: agent.name,
            config: {
              instructions: agent.instructions,
              ...(agent.providerId === undefined ? {} : { providerId: agent.providerId }),
              ...(agent.modelId === undefined ? {} : { modelId: agent.modelId }),
            },
          },
        });
      }
      if (ops.length > 0) {
        await deps.graph.applyGraphOps(created.workflow.id, {
          baseVersion: created.workflow.version,
          ops,
        });
      }
      if (proposal.maxCostPerRunUsd !== undefined) {
        project = await deps.graph.updateProject(project.id, {
          maxCostPerRunUsd: proposal.maxCostPerRunUsd,
        });
      }
      const graph = await deps.graph.getWorkflowGraph(created.workflow.id);
      return { project, workflow: graph.workflow };
    },
  };
}
