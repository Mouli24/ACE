import type { Part, Provider, Template, TemplateId } from '@ace/contracts';
import { Button, Input, Label, Textarea, cn } from '@ace/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../app/api';
import { getSocket } from '../app/socket';
import { HelpLink } from '../help/HelpLink';
import { useCreateProvider, useProviderDetect, useProviders } from '../providers/hooks';
import { useRunEvents } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';
import { usePatchSettings } from '../settings/hooks';
import { queryKeys } from '../workflows/query-keys';
import { TemplateThumbnail } from './TemplateThumbnail';
import {
  TEMPLATE_QUESTIONS,
  clearWizardState,
  loadWizardState,
  saveWizardState,
  type WizardState,
  type WizardStep,
} from './wizard-state';

const STEPS: ReadonlyArray<{ step: WizardStep; label: string }> = [
  { step: 1, label: 'Add a provider' },
  { step: 2, label: 'Pick a template' },
  { step: 3, label: 'Create and run' },
];

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Try again.';

/**
 * `/onboarding` — the first-run wizard (FR-ONB-001/002/003, Arch §33.1 steps 1–3, TC-ONB-001):
 * add a provider (the Mock one in one click), pick one of the four templates, then create the
 * project and start its first run on the Canvas.
 *
 * - **Never creates a project unprompted:** the only call that does is behind "Create project and
 *   run" on step 3.
 * - **Skippable:** "Skip setup" marks onboarding done and opens the project list.
 * - **Resumable:** the step and the choices so far live in `sessionStorage` (wizard-state.ts).
 * - **Sets `settings.onboardingCompleted`** when the project is created or the wizard is skipped.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const patchSettings = usePatchSettings();
  const [state, setState] = useState<WizardState>(loadWizardState);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Run frames for the first run are folded from the moment it starts, before the Canvas mounts.
  useRunEvents();

  useEffect(() => saveWizardState(state), [state]);

  // Moving to a step moves focus to its heading, so a screen reader announces where it landed.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [state.step]);

  const update = (patch: Partial<WizardState>) => setState((current) => ({ ...current, ...patch }));

  const skip = async () => {
    try {
      await patchSettings.mutateAsync({ onboardingCompleted: true });
    } finally {
      clearWizardState();
      navigate('/projects');
    }
  };

  const current = STEPS.find((s) => s.step === state.step) ?? STEPS[0]!;

  return (
    <main
      data-testid="onboarding-page"
      data-step={state.step}
      className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-4 sm:p-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-human text-2xl font-semibold">Welcome to ACE</h1>
          <p className="font-human text-sm text-fg-muted">
            Three steps to your first completed run. Nothing here needs an API key.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <HelpLink page="getting-started">Getting started</HelpLink>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void skip()}
            disabled={patchSettings.isPending}
            data-testid="onboarding-skip"
          >
            Skip setup
          </Button>
        </div>
      </header>

      <ol aria-label="Setup progress" className="flex flex-wrap gap-2" data-testid="onboarding-steps">
        {STEPS.map(({ step, label }) => {
          const done = step < state.step;
          const active = step === state.step;
          return (
            <li
              key={step}
              aria-current={active ? 'step' : undefined}
              data-testid={`onboarding-step-${step}`}
              data-state={done ? 'done' : active ? 'current' : 'todo'}
              className={cn(
                'flex items-center gap-2 rounded-chip border px-3 py-1 font-human text-xs',
                active ? 'border-accent text-fg' : 'border-border text-fg-muted',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full border font-machine text-[10px]',
                  done ? 'border-accent bg-accent text-canvas' : 'border-current',
                )}
              >
                {done ? <Check className="h-3 w-3" /> : step}
              </span>
              <span>
                <span className="sr-only">
                  Step {step} of {STEPS.length}
                  {done ? ', done' : ''}:{' '}
                </span>
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      <section aria-labelledby="onboarding-step-heading" className="flex flex-col gap-4">
        <h2
          id="onboarding-step-heading"
          ref={headingRef}
          tabIndex={-1}
          className="font-human text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {current.label}
        </h2>

        {state.step === 1 && (
          <ProviderStep onDone={(providerId) => update({ providerId, step: 2 })} />
        )}
        {state.step === 2 && (
          <TemplateStep
            selected={state.templateId}
            onSelect={(templateId) => update({ templateId })}
            onBack={() => update({ step: 1 })}
            onNext={() => update({ step: 3 })}
          />
        )}
        {state.step === 3 && state.templateId !== undefined && (
          <CreateStep
            templateId={state.templateId}
            projectName={state.projectName}
            question={state.question ?? TEMPLATE_QUESTIONS[state.templateId]}
            onChange={update}
            onBack={() => update({ step: 2 })}
          />
        )}
      </section>
    </main>
  );
}

/* -------------------------------------------------------------------- step 1 */

function ProviderStep({ onDone }: { onDone: (providerId: string) => void }) {
  const providers = useProviders();
  const detect = useProviderDetect();
  const create = useCreateProvider();
  const list = providers.data ?? [];
  const mock = list.find((provider) => provider.type === 'mock');
  const ollamaAdded = list.some((provider) => provider.type === 'ollama');
  const ollama = detect.data?.ollama;
  const others = list.filter((provider) => provider.type !== 'mock');

  const chooseMock = async () => {
    // One mock is enough: an existing one is reused rather than duplicated.
    if (mock) return onDone(mock.id);
    const created = await create.mutateAsync({ type: 'mock', name: 'Mock' });
    onDone(created.id);
  };

  const addOllama = async (baseUrl: string) => {
    const created = await create.mutateAsync({ type: 'ollama', name: 'Ollama', baseUrl });
    onDone(created.id);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="font-human text-sm text-fg-muted">
        A provider is where models come from. The Mock provider answers on your machine, with no key
        and no network, so it is the quickest way to see a run finish.
      </p>

      <Button
        size="lg"
        className="h-auto justify-start whitespace-normal py-3 text-left"
        onClick={() => void chooseMock()}
        disabled={create.isPending || providers.isPending}
        data-testid="onboarding-use-mock"
      >
        {mock
          ? 'Use the built-in Mock provider (already added — no key, works offline)'
          : 'Use the built-in Mock provider (no key, works offline)'}
      </Button>

      {ollama?.detected && !ollamaAdded && (
        <div
          data-testid="onboarding-ollama"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-panel p-3"
        >
          <p className="font-human text-sm">
            Ollama is running at <span className="font-machine">{ollama.baseUrl}</span>.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void addOllama(ollama.baseUrl)}
            disabled={create.isPending}
            data-testid="onboarding-add-ollama"
          >
            Add Ollama
          </Button>
        </div>
      )}

      {others.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="onboarding-existing-providers">
          <p className="font-human text-sm text-fg-muted">Or continue with one you already have:</p>
          <ul className="flex flex-wrap gap-2">
            {others.map((provider: Provider) => (
              <li key={provider.id}>
                <Button variant="secondary" size="sm" onClick={() => onDone(provider.id)}>
                  Continue with {provider.name}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="font-human text-sm text-fg-muted">
        Have an API key for Anthropic, Google or OpenAI?{' '}
        <Link
          to="/providers"
          className="text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          data-testid="onboarding-keyed-provider"
        >
          Add a provider with a key
        </Link>{' '}
        and come back here — the wizard keeps your place.
      </p>

      {create.isError && (
        <p role="alert" className="font-human text-sm text-danger">
          {message(create.error)}
        </p>
      )}

      <HelpLink page="providers">About providers, and the free local route</HelpLink>
    </div>
  );
}

/* -------------------------------------------------------------------- step 2 */

function TemplateStep({
  selected,
  onSelect,
  onBack,
  onNext,
}: {
  selected: TemplateId | undefined;
  onSelect: (id: TemplateId) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api().listTemplates() });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected !== undefined) onNext();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {templates.isError && (
        <p role="alert" className="font-human text-sm text-danger">
          {message(templates.error)}
        </p>
      )}
      {templates.isPending && <p className="font-human text-sm text-fg-muted">Loading templates…</p>}

      <div
        role="radiogroup"
        aria-label="Templates"
        className="grid gap-3 sm:grid-cols-2"
        data-testid="onboarding-templates"
      >
        {(templates.data ?? []).map((template: Template) => (
          <TemplateCard
            key={template.id}
            template={template}
            checked={selected === template.id}
            onSelect={() => onSelect(template.id)}
          />
        ))}
      </div>

      <StepActions onBack={onBack}>
        <Button type="submit" disabled={selected === undefined} data-testid="onboarding-next">
          Continue
        </Button>
      </StepActions>

      <HelpLink page="building-a-workflow">How workflows are built</HelpLink>
    </form>
  );
}

function TemplateCard({
  template,
  checked,
  onSelect,
}: {
  template: Template;
  checked: boolean;
  onSelect: () => void;
}) {
  const descriptionId = `template-description-${template.id}`;
  return (
    <label
      data-testid={`template-card-${template.id}`}
      data-checked={checked}
      className={cn(
        'flex cursor-pointer gap-3 rounded-md border bg-panel p-3 transition-colors',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
        checked ? 'border-accent' : 'border-border hover:border-fg-muted',
      )}
    >
      {/* A native radio: arrow keys move between cards and Space selects, with no custom keys. */}
      <input
        type="radio"
        name="template"
        value={template.id}
        checked={checked}
        onChange={onSelect}
        aria-describedby={descriptionId}
        className="sr-only"
      />
      <TemplateThumbnail id={template.id} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-human text-sm font-semibold">{template.name}</span>
        <span id={descriptionId} className="font-human text-xs text-fg-muted">
          {template.description}
        </span>
        {template.requires.knowledgeBase && (
          <span className="font-machine text-[10px] uppercase tracking-wider text-fg-muted">
            includes a sample knowledge base
          </span>
        )}
      </span>
    </label>
  );
}

/* -------------------------------------------------------------------- step 3 */

function CreateStep({
  templateId,
  projectName,
  question,
  onChange,
  onBack,
}: {
  templateId: TemplateId;
  projectName: string;
  question: string;
  onChange: (patch: Partial<WizardState>) => void;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const patchSettings = usePatchSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = projectName.trim() !== '' && question.trim() !== '';

  /**
   * The one place a project is created (FR-ONB-001: never without the user's confirmation). Then
   * the first run starts here rather than on the Canvas, so the question typed above is what it is
   * given — but the workflow's frames are subscribed to and folded into the run overlay *before*
   * the start, so the Canvas this navigates to shows the run from its first frame, and the
   * subscription is left for the Canvas to take over rather than dropped in between.
   */
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    let created;
    try {
      created = await api().instantiateTemplate(templateId, { projectName: projectName.trim() });
    } catch (cause) {
      setError(message(cause));
      setBusy(false);
      return;
    }
    const { project, workflow, nodes } = created;
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    try {
      await patchSettings.mutateAsync({ onboardingCompleted: true });
    } catch {
      // The project exists either way; the flag only decides where `/` opens next time.
    }
    clearWizardState();

    const input = nodes.find((node) => node.kind === 'input');
    const inputs: Record<string, Part[]> | undefined = input
      ? { [input.id]: [{ type: 'text', text: question.trim() }] }
      : undefined;
    getSocket()?.subscribe({ scope: 'workflow', id: workflow.id });
    const store = useRunStore.getState();
    store.arm(workflow.id);
    try {
      const run = await api().startRun(workflow.id, inputs ? { inputs } : {});
      useRunStore.getState().begin(workflow.id, run.id, run.status);
      queryClient.setQueryData(queryKeys.run(run.id), run);
    } catch {
      // The Canvas still opens; its Start button runs the workflow by hand.
      useRunStore.getState().reset();
    }
    navigate(`/projects/${project.id}/workflows/${workflow.id}`);
  };

  return (
    <form onSubmit={(event) => void confirm(event)} className="flex flex-col gap-4">
      <p className="font-human text-sm text-fg-muted">
        Nothing is created until you confirm. ACE then opens the Canvas and starts the first run
        with your question.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-project-name">Project name</Label>
        <Input
          id="onboarding-project-name"
          value={projectName}
          onChange={(event) => onChange({ projectName: event.target.value })}
          maxLength={120}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-question">First question</Label>
        <Textarea
          id="onboarding-question"
          rows={3}
          value={question}
          onChange={(event) => onChange({ question: event.target.value })}
          required
        />
      </div>

      {error && (
        <p role="alert" className="font-human text-sm text-danger" data-testid="onboarding-error">
          {error}
        </p>
      )}

      <StepActions onBack={onBack} disabled={busy}>
        <Button type="submit" disabled={!ready || busy} data-testid="onboarding-create">
          {busy ? 'Creating…' : 'Create project and run'}
        </Button>
      </StepActions>

      <HelpLink page="getting-started">What happens next</HelpLink>
    </form>
  );
}

function StepActions({
  onBack,
  disabled = false,
  children,
}: {
  onBack: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="ghost" onClick={onBack} disabled={disabled}>
        Back
      </Button>
      {children}
    </div>
  );
}
