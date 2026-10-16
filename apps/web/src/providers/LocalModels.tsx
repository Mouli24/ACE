import {
  OLLAMA_DOWNLOAD_URL,
  TRY_PROMPT_MAX,
  type Id,
  type Model,
  type ModelPullPayload,
  type Provider,
  type TryModelResponse,
} from '@ace/contracts';
import { Button, Icons, Input, cn, formatBytes } from '@ace/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../app/api';
import { getSocket } from '../app/socket';
import { LOCAL_COST_TEXT } from '../runs/CostValue';
import { queryKeys } from '../workflows/query-keys';
import { SUGGESTED_LOCAL_MODEL } from './provider-groups';

/**
 * Models on this machine (PG-1.4, D359): the local Ollama found and started by the engine, its
 * models loaded and unloaded, a model pulled with live progress, and "Try this model" — all from
 * the picker or the Providers page, never from a terminal.
 */

export const localQueryKeys = {
  runtime: () => ['local-runtime'] as const,
  running: (providerId: Id) => ['providers', providerId, 'local', 'running'] as const,
};

/* ------------------------------------------------------------------------------- hooks */

/** `GET /local-runtime`: installed? running? started by ACE? */
export function useLocalRuntime() {
  return useQuery({
    queryKey: localQueryKeys.runtime(),
    queryFn: () => api().localRuntime(),
    staleTime: 5_000,
    retry: false,
  });
}

function useInvalidateLocal() {
  const queryClient = useQueryClient();
  return (providerId?: Id) => {
    void queryClient.invalidateQueries({ queryKey: localQueryKeys.runtime() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.modelsRoot() });
    if (providerId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: localQueryKeys.running(providerId) });
    }
  };
}

/** Start Ollama (and add its provider when there is none). */
export function useStartLocalRuntime() {
  const invalidate = useInvalidateLocal();
  return useMutation({
    mutationFn: () => api().startLocalRuntime(),
    onSettled: () => invalidate(),
  });
}

/** Which models Ollama holds in memory now; polled while shown. */
export function useRunningLocalModels(providerId: Id, enabled = true) {
  return useQuery({
    queryKey: localQueryKeys.running(providerId),
    queryFn: async () => (await api().localRunningModels(providerId)).items,
    enabled,
    refetchInterval: 10_000,
    retry: false,
  });
}

export function useLoadLocalModel(providerId: Id) {
  const invalidate = useInvalidateLocal();
  return useMutation({
    mutationFn: (modelId: string) => api().loadLocalModel(providerId, modelId),
    onSettled: () => invalidate(providerId),
  });
}

export function useUnloadLocalModel(providerId: Id) {
  const invalidate = useInvalidateLocal();
  return useMutation({
    mutationFn: (modelId: string) => api().unloadLocalModel(providerId, modelId),
    onSettled: () => invalidate(providerId),
  });
}

/** The latest `model.pull` frame per model name for one provider; the catalogue refetches on done. */
export function usePullProgress(providerId: Id): Record<string, ModelPullPayload> {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<Record<string, ModelPullPayload>>({});
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    return socket.on('model.pull', (payload) => {
      if (payload.providerId !== providerId) return;
      setProgress((current) => ({ ...current, [payload.name]: payload }));
      if (payload.done) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.modelsRoot() });
      }
    });
  }, [providerId, queryClient]);
  return progress;
}

export function useTryModel(providerId: Id) {
  return useMutation({
    mutationFn: (body: { modelId: string; prompt: string }) => api().tryModel(providerId, body),
  });
}

/* ---------------------------------------------------------------------------- pieces */

const NOTE = 'text-[12px] text-[var(--muted)]';
const ERROR = 'text-[12px] text-[#c94c27]';

/**
 * What the Local & open section says when there is no Ollama provider: not installed (with the
 * download address, as text), installed but stopped (Start Ollama), or running but not added.
 */
export function LocalRuntimeNote({ className }: { className?: string }) {
  const runtime = useLocalRuntime();
  const start = useStartLocalRuntime();
  const status = runtime.data;
  if (runtime.isPending) return <p className={cn(NOTE, className)}>Looking for Ollama…</p>;
  if (status === undefined) return null;

  if (!status.installed) {
    return (
      <p className={cn(NOTE, className)} data-testid="local-runtime-not-installed">
        Ollama is not installed on this computer. Download it from{' '}
        <span className="font-machine text-[var(--ink)]">{OLLAMA_DOWNLOAD_URL}</span>{' '}
        <a
          href={OLLAMA_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="underline"
          aria-label="Open the Ollama download page"
        >
          (open)
        </a>
        , then come back — ACE starts it for you.
      </p>
    );
  }

  const starting = start.isPending;
  const label = status.running ? 'Add Ollama' : 'Start Ollama';
  return (
    <div
      className={cn('flex flex-wrap items-center gap-2', className)}
      data-testid="local-runtime-note"
    >
      <span className="min-w-0 flex-1 text-[12px]">
        {starting
          ? 'Starting Ollama…'
          : status.running
            ? `Ollama ${status.version ?? ''} is running on this computer.`
            : 'Ollama is installed but not running.'}
      </span>
      <Button
        size="sm"
        variant="secondary"
        disabled={starting}
        onClick={() => start.mutate()}
        data-testid="local-runtime-start"
      >
        {starting ? 'Starting Ollama…' : label}
      </Button>
      {(start.data?.error ?? status.error) !== undefined && (
        <p role="alert" className={cn(ERROR, 'w-full')}>
          {start.data?.error ?? status.error}
        </p>
      )}
      {start.isError && (
        <p role="alert" className={cn(ERROR, 'w-full')}>
          {start.error.message}
        </p>
      )}
    </div>
  );
}

/** "Loaded" badge and Load/Unload, with "Starting Ollama…" / "Loading model…" while it works. */
export function LocalModelActions({
  provider,
  model,
  loaded,
}: {
  provider: Provider;
  model: Pick<Model, 'modelId'>;
  loaded: boolean;
}) {
  const runtime = useLocalRuntime();
  const load = useLoadLocalModel(provider.id);
  const unload = useUnloadLocalModel(provider.id);
  const busy = load.isPending || unload.isPending;
  const needsStart = runtime.data !== undefined && !runtime.data.running;
  const loadingText = needsStart ? 'Starting Ollama…' : 'Loading model…';

  return (
    <span className="flex shrink-0 items-center gap-[6px]">
      {loaded && !busy && (
        <span
          className="rounded-[5px] bg-[#e3f1e8] px-[6px] py-[1px] font-machine text-[10px] text-[#2f7d52]"
          data-testid={`local-model-loaded-${model.modelId}`}
        >
          Loaded
        </span>
      )}
      {load.isPending && <span className="font-machine text-[10px]">{loadingText}</span>}
      {unload.isPending && <span className="font-machine text-[10px]">Unloading…</span>}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-[24px] px-[9px] text-[11px]"
        disabled={busy}
        data-testid={`local-model-${loaded ? 'unload' : 'load'}-${model.modelId}`}
        onClick={(event) => {
          event.stopPropagation();
          if (loaded) unload.mutate(model.modelId);
          else load.mutate(model.modelId);
        }}
      >
        {loaded ? 'Unload' : 'Load'}
      </Button>
      {(load.isError || unload.isError) && (
        <span role="alert" className="text-[10.5px] text-[#c94c27]">
          {(load.error ?? unload.error)?.message}
        </span>
      )}
    </span>
  );
}

/** "Pull a model": a name, a button, then live progress from `model.pull`. */
export function PullModelForm({ provider }: { provider: Provider }) {
  const [name, setName] = useState('');
  const progress = usePullProgress(provider.id);
  const pull = useMutation({
    mutationFn: (model: string) => api().pullLocalModel(provider.id, model),
  });
  const wanted = name.trim() === '' ? SUGGESTED_LOCAL_MODEL : name.trim();
  const active = Object.values(progress).filter(
    (frame) => !frame.done || frame.error !== undefined,
  );

  return (
    <div className="flex flex-col gap-[6px]" data-testid={`pull-model-${provider.id}`}>
      <form
        className="flex items-center gap-[6px]"
        onSubmit={(event) => {
          event.preventDefault();
          pull.mutate(wanted);
        }}
      >
        <Input
          aria-label="Model to pull"
          placeholder={SUGGESTED_LOCAL_MODEL}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-[28px] flex-1 font-machine text-[12px]"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={pull.isPending}>
          <Icons.Download aria-hidden size={13} />
          Pull a model
        </Button>
      </form>
      {pull.isError && (
        <p role="alert" className={ERROR}>
          {pull.error.message}
        </p>
      )}
      {active.map((frame) => (
        <PullRow key={frame.name} frame={frame} />
      ))}
      {Object.values(progress)
        .filter((frame) => frame.done && frame.error === undefined)
        .map((frame) => (
          <p key={frame.name} className="text-[11.5px] text-[#2f7d52]">
            Pulled {frame.name}.
          </p>
        ))}
    </div>
  );
}

function PullRow({ frame }: { frame: ModelPullPayload }) {
  const percent =
    frame.total !== undefined && frame.total > 0 && frame.completed !== undefined
      ? Math.min(100, Math.round((frame.completed / frame.total) * 100))
      : undefined;
  if (frame.error !== undefined) {
    return (
      <p role="alert" className={ERROR}>
        Pulling {frame.name} failed: {frame.error}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-[3px]" data-testid={`pull-progress-${frame.name}`}>
      <span className="font-machine text-[10.5px] text-[var(--muted)]">
        {frame.name} — {frame.status}
        {percent === undefined ? '' : ` · ${percent}%`}
        {frame.total !== undefined && frame.completed !== undefined
          ? ` · ${formatBytes(frame.completed)} of ${formatBytes(frame.total)}`
          : ''}
      </span>
      <div className="h-[4px] w-full overflow-hidden rounded-full bg-[var(--soft)]">
        <div
          role="progressbar"
          aria-label={`Pulling ${frame.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? 0}
          className="h-full bg-[#ef6b3f] transition-[width]"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/** "Try this model": a one-line prompt, one call, the answer with its tokens and time. */
export function TryModelBox({
  provider,
  modelId,
  local,
}: {
  provider: Provider;
  modelId: string;
  local: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  const run = useTryModel(provider.id);
  const answer: TryModelResponse | undefined = run.data;
  // A different model forgets the last answer.
  const { reset } = run;
  useEffect(() => reset(), [modelId, reset]);

  return (
    <div
      className="flex flex-col gap-[6px] rounded-[10px] border border-[var(--line)] p-[8px]"
      data-testid="try-model"
    >
      <span className="text-[11.5px] font-semibold">Try this model</span>
      <form
        className="flex items-center gap-[6px]"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim() !== '') run.mutate({ modelId, prompt: prompt.trim() });
        }}
      >
        <Input
          aria-label="Prompt to try"
          placeholder="Say hello in one sentence."
          maxLength={TRY_PROMPT_MAX}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="h-[28px] flex-1 text-[12px]"
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={run.isPending || prompt.trim() === ''}
        >
          {run.isPending ? 'Trying…' : 'Try'}
        </Button>
      </form>
      <span className="text-[10.5px] text-[var(--muted)]">
        {local
          ? LOCAL_COST_TEXT
          : 'One call to this provider — it is billed at the model’s price, like any run.'}
      </span>
      {run.isError && (
        <p role="alert" className={ERROR}>
          {run.error.message}
        </p>
      )}
      {answer !== undefined && (
        <div className="flex flex-col gap-[3px]" data-testid="try-model-answer">
          <p className="max-h-[140px] overflow-y-auto whitespace-pre-wrap text-[12px]">
            {answer.text === '' ? '(no text)' : answer.text}
          </p>
          <span className="font-machine text-[10px] text-[var(--muted)]">
            {answer.tokensIn} in · {answer.tokensOut} out · {(answer.ms / 1000).toFixed(1)} s
            {answer.costUsd === undefined ? '' : ` · $${answer.costUsd.toFixed(4)}`}
          </span>
        </div>
      )}
    </div>
  );
}
