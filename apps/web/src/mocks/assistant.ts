import type {
  AssistantAgent,
  AssistantApplyRequest,
  AssistantApplyResponse,
  AssistantProposal,
  AssistantProposeRequest,
  AssistantRole,
  AssistantTeam,
  Node,
  Project,
  Provider,
} from '@ace/contracts';

import { isUnwritablePath, type MockDb } from './db';
import { SuggestionEngineError } from './suggestions';
import { instantiateTemplate } from './templates';

/**
 * The mock Ace Assistant (ACE parity P2, D283), mirroring `packages/engine/src/assistant`: `propose`
 * drafts and writes nothing; `apply` (the confirmation) creates the project, instantiates the team
 * template, renames and instructs its agents, sets their models and the run cap.
 *
 * The rules are the engine's, ported. A model draft is a stand-in: with a model chosen on a
 * provider this engine has, the proposal is the rules' content marked `source: 'model'` (the mock
 * has no model to ask); with a provider it does not have, the rules answer and say why, as the
 * engine does when a model's answer cannot be used.
 */

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

/** A CLI provider the prompt names ("use Claude Code"), on its `default` model. */
function namedModel(
  prompt: string,
  providers: Provider[],
): { providerId: string; modelId: string; label: string } | undefined {
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

/** The engine's rules (`ruleProposal`), ported. */
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

/** `POST /assistant/propose`: drafts, writes nothing. */
export function proposeSetup(db: MockDb, body: AssistantProposeRequest): AssistantProposal {
  const rules = ruleProposal(body, db.listProviders());
  if (body.providerId === undefined || body.modelId === undefined) return rules;
  if (db.getProvider(body.providerId) === undefined) {
    return {
      ...rules,
      notes: [
        ...rules.notes,
        `The model's answer could not be used (Provider ${body.providerId} was not found.); this proposal comes from ACE's rules.`,
      ].slice(0, 10),
    };
  }
  return { ...rules, source: 'model' };
}

/** `POST /assistant/apply`: the confirmation creates the project and the team. */
export function applySetup(db: MockDb, body: AssistantApplyRequest): AssistantApplyResponse {
  const { proposal } = body;
  let project: Project;
  if (proposal.projectId !== undefined) {
    const found = db.getProject(proposal.projectId);
    if (found === undefined) {
      throw new SuggestionEngineError(
        404,
        'workflow',
        'not_found',
        `Project ${proposal.projectId} was not found.`,
      );
    }
    project = found;
  } else {
    if (body.folderPath !== undefined && isUnwritablePath(body.folderPath)) {
      throw new SuggestionEngineError(
        400,
        'invalid_config',
        'invalid_path',
        `Folder "${body.folderPath}" is not writable.`,
      );
    }
    project = db.createProject({
      name: proposal.projectName,
      ...(body.folderPath === undefined ? {} : { folderPath: body.folderPath }),
    });
  }

  const outcome = instantiateTemplate(db, proposal.team, { projectId: project.id });
  if (!outcome.ok) {
    throw new SuggestionEngineError(404, 'workflow', 'not_found', `${outcome.what} not found.`);
  }
  const { workflow, nodes, edges } = outcome.response;
  let renamed = false;
  const next = nodes.map((node): Node => {
    if (node.kind !== 'agent') return node;
    const agent = proposal.agents.find((own) => TEMPLATE_AGENT_NAME[own.role] === node.name);
    if (agent === undefined) return node;
    renamed = true;
    return {
      ...node,
      name: agent.name,
      config: {
        ...node.config,
        instructions: agent.instructions,
        ...(agent.providerId === undefined ? {} : { providerId: agent.providerId }),
        ...(agent.modelId === undefined ? {} : { modelId: agent.modelId }),
      },
    } as Node;
  });
  const committed = renamed ? db.commitGraph(workflow.id, next, edges) : workflow;
  if (proposal.maxCostPerRunUsd !== undefined) {
    db.updateProject(project.id, { maxCostPerRunUsd: proposal.maxCostPerRunUsd });
  }
  return { project: db.getProject(project.id) ?? project, workflow: { ...committed } };
}
