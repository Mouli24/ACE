import {
  AssistantApplyRequestSchema,
  AssistantProposeRequestSchema,
  type AssistantAgent,
  type AssistantProposal,
  type AssistantRole,
  type AssistantTeam,
  type Model,
  type Provider,
} from '@ace/contracts';
import { Badge, Button, Input, Label, Textarea, cn, toast } from '@ace/ui';
import { Bot, Sparkles, Wand2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { selectClass } from '../knowledge/fields';
import { useModels, useProviders } from '../providers/hooks';
import { useAssistantApply, useAssistantPropose } from './hooks';

/** "Drafted by" and each agent's model, as one select value: `providerId|modelId`, or none. */
const NONE = '';
const SEPARATOR = '|';

const TEAM_LABEL: Readonly<Record<AssistantTeam, { name: string; hint: string }>> = {
  'single-builder': { name: 'Single builder', hint: 'One builder agent does each task.' },
  'plan-build-review': {
    name: 'Plan, build and review',
    hint: 'A planner, a builder, and a reviewer that sends work back until it is right.',
  },
};

const ROLE_LABEL: Readonly<Record<AssistantRole, string>> = {
  planner: 'Planner',
  builder: 'Builder',
  reviewer: 'Reviewer',
};

interface ModelChoice {
  value: string;
  label: string;
}

const choiceValue = (providerId: string, modelId: string): string =>
  `${providerId}${SEPARATOR}${modelId}`;

function parseChoice(value: string): { providerId: string; modelId: string } | undefined {
  if (value === NONE) return undefined;
  const at = value.indexOf(SEPARATOR);
  return { providerId: value.slice(0, at), modelId: value.slice(at + 1) };
}

function modelChoices(models: readonly Model[], providers: readonly Provider[]): ModelChoice[] {
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  return models
    .filter((model) => model.available && model.outputTypes.includes('text'))
    .map((model) => ({
      value: choiceValue(model.providerId, model.modelId),
      label: `${names.get(model.providerId) ?? 'Provider'} · ${model.displayName}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The Ace Assistant on the projects page (ACE parity P2, D283): describe the work, and Ace proposes
 * a project, a team (with each agent's name, instructions and model) and a run budget. The proposal
 * says honestly who drafted it — the model picked under "Drafted by", or ACE's rules. Its fields can
 * be edited, or Ace asked to change it; nothing is created until *Create project*, which opens the
 * new team's canvas.
 */
export function AssistantPanel() {
  const navigate = useNavigate();
  const propose = useAssistantPropose();
  const apply = useAssistantApply();
  const providers = useProviders();
  const models = useModels({ available: true });
  const choices = useMemo(
    () => modelChoices(models.data?.items ?? [], providers.data ?? []),
    [models.data, providers.data],
  );
  const labelOf = (value: string): string =>
    choices.find((choice) => choice.value === value)?.label ?? value.replace(SEPARATOR, ' · ');

  const [prompt, setPrompt] = useState('');
  const [drafter, setDrafter] = useState(NONE);
  /** The model the shown proposal was asked of, if any — what "drafted by" names. */
  const [askedModel, setAskedModel] = useState(NONE);
  const [draft, setDraft] = useState<AssistantProposal | null>(null);
  const [budget, setBudget] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [change, setChange] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  const drafterFields = () => {
    const chosen = parseChoice(drafter);
    return chosen === undefined ? {} : chosen;
  };

  /** The proposal as edited on screen, budget included. */
  const edited = (): AssistantProposal | undefined => {
    if (draft === null) return undefined;
    const { maxCostPerRunUsd: _previous, ...rest } = draft;
    return budget.trim() === '' ? rest : { ...rest, maxCostPerRunUsd: Number(budget) };
  };

  const receive = (proposal: AssistantProposal) => {
    setDraft(proposal);
    setBudget(proposal.maxCostPerRunUsd === undefined ? '' : String(proposal.maxCostPerRunUsd));
    setAskedModel(drafter);
    setProblem(undefined);
  };

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const parsed = AssistantProposeRequestSchema.safeParse({ prompt, ...drafterFields() });
    if (!parsed.success) {
      setProblem('Describe what you want to build first.');
      return;
    }
    setProblem(undefined);
    propose.mutate(parsed.data, { onSuccess: receive });
  };

  const revise = (event: FormEvent) => {
    event.preventDefault();
    const parsed = AssistantProposeRequestSchema.safeParse({
      prompt: change,
      previous: edited(),
      ...drafterFields(),
    });
    if (!parsed.success) {
      setProblem(
        change.trim() === ''
          ? 'Say what Ace should change.'
          : 'Fix the proposal’s fields first: every agent needs a name and instructions, and a budget must be more than $0.',
      );
      return;
    }
    setProblem(undefined);
    propose.mutate(parsed.data, {
      onSuccess: (proposal) => {
        receive(proposal);
        setChange('');
      },
    });
  };

  const confirm = () => {
    const parsed = AssistantApplyRequestSchema.safeParse({
      proposal: edited(),
      ...(folderPath.trim() === '' ? {} : { folderPath: folderPath.trim() }),
    });
    if (!parsed.success) {
      setProblem(
        'Fix the proposal’s fields first: the project needs a name, every agent a name and instructions, and a budget must be more than $0.',
      );
      return;
    }
    setProblem(undefined);
    apply.mutate(parsed.data, {
      onSuccess: ({ project, workflow }) => {
        toast.success(`Created ${project.name}`, {
          description: `Its team is "${workflow.name}". Opening its canvas.`,
        });
        navigate(`/projects/${project.id}/workflows/${workflow.id}`);
      },
    });
  };

  const setAgent = (role: AssistantRole, patch: (agent: AssistantAgent) => AssistantAgent) =>
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            agents: current.agents.map((agent) => (agent.role === role ? patch(agent) : agent)),
          },
    );

  const engineError = apply.error ?? propose.error;

  return (
    <section
      aria-labelledby="assistant-heading"
      data-testid="assistant-panel"
      className="flex flex-col gap-4 rounded-card border border-border bg-panel p-4"
    >
      <header className="flex items-start gap-3">
        <Sparkles className="mt-1 h-5 w-5 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0">
          <h2 id="assistant-heading" className="font-human text-lg font-semibold">
            Ace Assistant
          </h2>
          <p className="font-human text-sm text-fg-muted">
            Describe the work; Ace proposes a project, a team and a run budget. Nothing is created
            until you confirm.
          </p>
        </div>
      </header>

      <form onSubmit={ask} noValidate className="flex flex-col gap-3" aria-label="Ask Ace">
        <Label htmlFor="assistant-prompt" className="sr-only">
          What do you want to build?
        </Label>
        <Textarea
          id="assistant-prompt"
          rows={3}
          value={prompt}
          maxLength={4_000}
          placeholder="Describe what you want to build… e.g. “Build a booking app. Have one agent plan it and another review it, $2 per run.”"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1 sm:w-80">
            <Label htmlFor="assistant-drafter" className="text-xs text-fg-muted">
              Drafted by
            </Label>
            <select
              id="assistant-drafter"
              className={selectClass}
              value={drafter}
              onChange={(event) => setDrafter(event.target.value)}
            >
              <option value={NONE}>ACE’s rules (no model)</option>
              {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" className="sm:ml-auto" disabled={propose.isPending}>
            <Wand2 className="h-4 w-4" aria-hidden />
            {propose.isPending ? 'Proposing…' : 'Propose'}
          </Button>
        </div>
      </form>

      {problem !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
      {engineError && (
        <p role="alert" className="text-sm text-danger">
          {engineError.message}
        </p>
      )}

      {draft !== null && (
        <div
          data-testid="assistant-proposal"
          className="flex flex-col gap-4 border-t border-border pt-4"
        >
          <div className="flex flex-col gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <h3 className="font-human text-base font-semibold">Proposal</h3>
              <Badge data-testid="proposal-source" data-source={draft.source}>
                <Bot className="h-3 w-3" aria-hidden />
                {draft.source === 'model'
                  ? `Drafted by ${askedModel === NONE ? 'a model' : labelOf(askedModel)}`
                  : 'Drafted by ACE’s rules'}
              </Badge>
            </span>
            {draft.source === 'rules' && askedModel !== NONE && (
              <p className="font-human text-xs text-fg-muted">
                You asked {labelOf(askedModel)}, but this proposal comes from ACE’s rules — the
                notes say why.
              </p>
            )}
            <p className="font-human text-sm" data-testid="proposal-summary">
              {draft.summary}
            </p>
            {draft.notes.length > 0 && (
              <ul
                aria-label="What Ace assumed"
                className="list-disc pl-5 font-human text-xs text-fg-muted"
              >
                {draft.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proposal-name">Project name</Label>
              <Input
                id="proposal-name"
                value={draft.projectName}
                maxLength={120}
                disabled={draft.projectId !== undefined}
                onChange={(event) => setDraft({ ...draft, projectName: event.target.value })}
              />
              {draft.projectId !== undefined && (
                <p className="text-xs text-fg-muted">The team is added to an existing project.</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proposal-folder">Folder (optional)</Label>
              <Input
                id="proposal-folder"
                className="font-machine"
                value={folderPath}
                placeholder="the engine’s default projects folder"
                disabled={draft.projectId !== undefined}
                onChange={(event) => setFolderPath(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Team</span>
              <p className="font-human text-sm" data-testid="proposal-team">
                {TEAM_LABEL[draft.team].name}
              </p>
              <p className="text-xs text-fg-muted">
                {TEAM_LABEL[draft.team].hint} To change it, ask Ace below.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proposal-budget">Most a run may spend (USD)</Label>
              <Input
                id="proposal-budget"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={budget}
                placeholder="no limit"
                onChange={(event) => setBudget(event.target.value)}
              />
            </div>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">Agents</legend>
            {draft.agents.map((agent) => (
              <AgentFields
                key={agent.role}
                agent={agent}
                choices={choices}
                labelOf={labelOf}
                onChange={(patch) => setAgent(agent.role, patch)}
              />
            ))}
          </fieldset>

          <form
            onSubmit={revise}
            noValidate
            aria-label="Ask Ace to change the proposal"
            className="flex flex-col gap-2"
          >
            <Label htmlFor="assistant-change">Tell Ace what to change</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="assistant-change"
                value={change}
                maxLength={4_000}
                placeholder="e.g. Add a reviewer, or call it Bookings"
                onChange={(event) => setChange(event.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={propose.isPending}>
                Revise
              </Button>
            </div>
          </form>

          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center">
            <p className="font-human text-xs text-fg-muted">
              Creates the project, adds the team’s workflow with these agents, and sets the run
              budget.
            </p>
            <Button
              className="sm:ml-auto"
              disabled={apply.isPending}
              onClick={confirm}
              data-testid="assistant-apply"
            >
              {apply.isPending ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function AgentFields({
  agent,
  choices,
  labelOf,
  onChange,
}: {
  agent: AssistantAgent;
  choices: readonly ModelChoice[];
  labelOf: (value: string) => string;
  onChange: (patch: (agent: AssistantAgent) => AssistantAgent) => void;
}) {
  const prefix = `agent-${agent.role}`;
  const current =
    agent.providerId === undefined
      ? NONE
      : choiceValue(agent.providerId, agent.modelId ?? 'default');
  const options =
    current === NONE || choices.some((choice) => choice.value === current)
      ? choices
      : [{ value: current, label: labelOf(current) }, ...choices];

  return (
    <div
      role="group"
      aria-label={`${ROLE_LABEL[agent.role]} agent`}
      className={cn('flex flex-col gap-2 rounded-field border border-border p-3')}
    >
      <span className="font-machine text-[10.5px] uppercase tracking-[0.08em] text-fg-soft">
        {ROLE_LABEL[agent.role]}
      </span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${prefix}-name`} className="text-xs">
            Name
          </Label>
          <Input
            id={`${prefix}-name`}
            value={agent.name}
            maxLength={80}
            onChange={(event) => {
              const name = event.target.value;
              onChange((own) => ({ ...own, name }));
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${prefix}-model`} className="text-xs">
            Model
          </Label>
          <select
            id={`${prefix}-model`}
            className={selectClass}
            value={current}
            onChange={(event) => {
              const chosen = parseChoice(event.target.value);
              onChange(({ providerId: _p, modelId: _m, ...rest }) =>
                chosen === undefined ? rest : { ...rest, ...chosen },
              );
            }}
          >
            <option value={NONE}>The template’s (no-key Mock)</option>
            {options.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${prefix}-instructions`} className="text-xs">
          Instructions
        </Label>
        <Textarea
          id={`${prefix}-instructions`}
          rows={3}
          value={agent.instructions}
          maxLength={8_000}
          onChange={(event) => {
            const instructions = event.target.value;
            onChange((own) => ({ ...own, instructions }));
          }}
        />
      </div>
    </div>
  );
}
