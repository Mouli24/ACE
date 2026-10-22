import type { Checkpoint } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { cn } from '@ace/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ago, nodeStatusLook } from '../../theme/format';
import { useWorkflowGraph } from '../../workflows/hooks';
import { useProjectChanges } from './changes-store';
import { CheckpointFiles, ROW_ACTION } from './CheckpointFiles';
import { useCheckpointAction, useCheckpointEvents, useCheckpoints } from './hooks';
import {
  COVERAGE_NOTE,
  STATUS_LABEL,
  actionFailure,
  failureNote,
  pendingFiles,
  runLink,
  sourceLabel,
} from './present';
import { openReview } from './review-actions';
import { RevertAllDialog } from './RevertAllDialog';

const messageOf = (error: unknown): string =>
  AceApiError.is(error) || error instanceof Error ? error.message : String(error);

/**
 * Forge's Changes (D300, design §5.3): every checkpoint of the project, the ones to review first —
 * where it came from, when, and each file with its `+/−`. Review opens a file's diff in the editor
 * area; Keep all, Revert all (after a confirm, fix A-M9), and Keep or Revert per file decide it. A
 * revert the engine refused says why on that file. Live from `checkpoint.updated`. A standalone
 * column body: the left column's header switch (EXPLORER · SEARCH · CHANGES) mounts it (D339, at
 * the merge).
 */
export function ChangesView({
  projectId,
  workflowId,
}: {
  projectId: string;
  /** The workflow whose nodes name a chat's checkpoints ("Chat with Writer"). */
  workflowId?: string;
}) {
  useCheckpointEvents(projectId);
  const list = useCheckpoints(projectId);
  const nodes = useWorkflowGraph(workflowId).data?.nodes;
  const names = useMemo(() => new Map((nodes ?? []).map((node) => [node.id, node.name])), [nodes]);
  const { focus } = useProjectChanges(projectId);
  const items = list.data ?? [];
  const note = 'px-[4px] py-[4px] text-[12px] text-[var(--muted)]';

  return (
    <section
      aria-label="Changes"
      className="flex min-h-0 flex-1 flex-col gap-[8px] overflow-y-auto px-[10px] pb-[10px] pt-[2px]"
    >
      {list.isPending && <p className={note}>Reading the checkpoints…</p>}
      {list.error && (
        <p role="alert" className={cn(note, 'text-danger')}>
          Couldn’t read the checkpoints: {messageOf(list.error)}
        </p>
      )}
      {list.isSuccess && items.length === 0 && (
        <p className={note}>
          No agent changes yet. Each chat turn and run that edits files lands here.
        </p>
      )}
      {items.map((checkpoint) => (
        <CheckpointEntry
          key={checkpoint.id}
          projectId={projectId}
          checkpoint={checkpoint}
          label={sourceLabel(checkpoint, (nodeId) => names.get(nodeId))}
          focused={focus === checkpoint.id}
        />
      ))}
      {items.length > 0 && (
        <p className="m-0 px-[4px] text-[10.5px] text-[var(--muted)]">{COVERAGE_NOTE}</p>
      )}
    </section>
  );
}

function StatusChip({ checkpoint }: { checkpoint: Checkpoint }) {
  const recording = checkpoint.status === 'recording';
  return (
    <span
      data-testid={`checkpoint-status-${checkpoint.id}`}
      className="flex shrink-0 items-center gap-[4px] font-machine text-[9.5px] text-[var(--muted)]"
    >
      {recording && (
        <span
          aria-hidden
          className="h-[6px] w-[6px] rounded-full"
          style={{
            background: nodeStatusLook('RUNNING').color,
            animation: 'livePulse 2s ease-in-out infinite',
          }}
        />
      )}
      {STATUS_LABEL[checkpoint.status]}
    </span>
  );
}

function CheckpointEntry({
  projectId,
  checkpoint,
  label,
  focused,
}: {
  projectId: string;
  checkpoint: Checkpoint;
  label: string;
  focused: boolean;
}) {
  const element = useRef<HTMLElement>(null);
  const action = useCheckpointAction(projectId, checkpoint.id);
  const pending = pendingFiles(checkpoint);
  const failure = actionFailure(action.error);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const toRun = runLink(checkpoint);
  useEffect(() => {
    if (focused) element.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);

  return (
    <article
      ref={element}
      aria-label={`${label}, ${STATUS_LABEL[checkpoint.status]}`}
      data-testid={`checkpoint-${checkpoint.id}`}
      className={cn(
        'flex flex-col gap-[4px] rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[8px]',
        focused && 'shadow-[0_0_0_1.5px_#ef6b3f]',
      )}
    >
      <header className="flex items-center gap-[6px]">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--ink)]">
          {label}
        </span>
        <StatusChip checkpoint={checkpoint} />
      </header>
      <span className="flex items-center gap-[8px]">
        <time
          dateTime={checkpoint.createdAt}
          title={new Date(checkpoint.createdAt).toLocaleString()}
          className="font-machine text-[9.5px] text-[var(--muted)]"
        >
          {ago(checkpoint.createdAt)}
        </time>
        {/* PG-5.1: back to the run that made these changes, on the node whose step it was. */}
        {toRun !== undefined && (
          <Link
            to={toRun}
            data-testid={`checkpoint-run-link-${checkpoint.id}`}
            className="font-machine text-[9.5px] text-[var(--muted)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
          >
            {checkpoint.nodeId === undefined ? 'open the run' : 'open the run at this node'}
            <span aria-hidden>&nbsp;→</span>
          </Link>
        )}
      </span>
      {checkpoint.status === 'failed' && (
        <p role="alert" className="m-0 text-[11.5px] leading-[1.4] text-danger">
          {failureNote(checkpoint)}
        </p>
      )}
      {checkpoint.files.length > 0 && (
        <CheckpointFiles
          checkpoint={checkpoint}
          busy={action.isPending}
          onReview={(path) => openReview(projectId, checkpoint.id, path)}
          onAction={(kind, path) => action.mutate({ action: kind, paths: [path] })}
        />
      )}
      {checkpoint.skipped.length > 0 && (
        <p className="m-0 text-[10.5px] text-[var(--muted)]" title={checkpoint.skipped.join('\n')}>
          {checkpoint.skipped.length} file{checkpoint.skipped.length === 1 ? '' : 's'} over 5 MB not
          checkpointed
        </p>
      )}
      {failure !== undefined && (
        <p role="alert" className="m-0 text-[11px] text-danger">
          {failure}
        </p>
      )}
      {pending.length > 0 && (
        <footer className="flex items-center justify-end gap-[2px] pt-[2px]">
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate({ action: 'keep' })}
            className={ROW_ACTION}
          >
            Keep all
          </button>
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => setConfirmRevert(true)}
            className={cn(ROW_ACTION, 'text-danger hover:text-danger')}
          >
            Revert all
          </button>
        </footer>
      )}
      {confirmRevert && pending.length > 0 && (
        <RevertAllDialog
          files={pending}
          onConfirm={() => action.mutate({ action: 'revert' })}
          onClose={() => setConfirmRevert(false)}
        />
      )}
    </article>
  );
}
