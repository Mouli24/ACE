import { slugHandle } from '@ace/contracts';
import { Icons } from '@ace/ui';
import { useEffect, useState } from 'react';
import { useInRouterContext } from 'react-router-dom';

import { useFollowNode } from '../../app/follow-node';
import { useProject } from '../../projects/hooks';
import { estimateTitle } from '../../runs/estimate';
import { OpenRunEnd, useStartRunFlow } from '../../runs/useStartRunFlow';
import type { AgentLook } from '../../theme/agents';
import { ago } from '../../theme/format';
import { touchedLines, useNodeModel, type FileTouch, type LineSpan } from '../attribution';
import { formatDocument } from './actions';
import { useEditorStore } from './editor-store';
import { languageOf } from './languages';
import { getModel } from './models';

/** The languages Monaco formats itself (D299 Phase 4): TS/JS by range, the others by document. */
const FORMATTABLE: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'json',
  'css',
  'scss',
  'less',
  'html',
]);

/**
 * The lines the run's last write to this file covers in the buffer now, following every edit to
 * the buffer. `undefined` with no write, or when an edit's new text is no longer there (D334).
 */
function useTouchedLines(
  projectId: string,
  path: string,
  touch: FileTouch | undefined,
): LineSpan | undefined {
  // the model exists once the file's text has loaded; that is when its base version is set
  const loaded = useEditorStore(
    (state) => state.projects[projectId]?.files[path]?.baseVersion !== undefined,
  );
  // bumped on every edit, only to render again: the text itself is read from the model below
  const [, setEdits] = useState(0);
  useEffect(() => {
    const model = getModel(projectId, path);
    if (model === undefined || touch === undefined) return;
    setEdits((value) => value + 1);
    const subscription = model.onDidChangeContent(() => setEdits((value) => value + 1));
    return () => subscription.dispose();
  }, [projectId, path, touch, loaded]);
  const model = getModel(projectId, path);
  return touch === undefined || model === undefined
    ? undefined
    : touchedLines(model.getValue(), touch.edit);
}

/** Re-render every half minute, so "4m ago" keeps telling the truth. */
function useClock(enabled: boolean): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => tick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
}

/**
 * The theme's path bar over the open file (D334): the project slug and the path as crumbs, who
 * last edited which lines of it in the current run, Format (D299 Phase 4: Monaco's Format
 * Document, as Shift+Alt+F), and "▶ Run pipeline", which starts a real run of the workflow (asking
 * for Input-node text first when a node has none).
 */
export function PathBar({
  projectId,
  workflowId,
  path,
  touch,
}: {
  projectId: string;
  workflowId?: string;
  path: string;
  touch?: FileTouch | undefined;
}) {
  const project = useProject(projectId);
  const lines = useTouchedLines(projectId, path, touch);
  const shown = touch !== undefined && lines !== undefined;
  useClock(shown);
  // PG-3.4: the model the writing node ran on
  const model = useNodeModel(workflowId, touch?.agent.nodeId, touch?.nodeRunId);
  const crumbs = [
    ...(project.data === undefined ? [] : [slugHandle(project.data.name)]),
    ...path.split('/'),
  ];
  return (
    <div
      data-testid="path-bar"
      className="flex h-[34px] min-w-0 shrink-0 items-center gap-[6px] overflow-hidden border-b border-[var(--line)] pl-[18px] pr-[12px] font-machine text-[11px]"
    >
      <div
        aria-label="Path"
        className="flex min-w-0 flex-[0_1_auto] items-center gap-[6px] overflow-hidden"
      >
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <span key={`${index}:${crumb}`} className="contents">
              <span
                data-testid="crumb"
                className={
                  last
                    ? 'whitespace-nowrap text-[var(--ink)]'
                    : 'whitespace-nowrap text-[var(--muted)]'
                }
              >
                {crumb}
              </span>
              {!last && <span className="text-[var(--muted)]">›</span>}
            </span>
          );
        })}
      </div>
      <div className="flex-1" />
      {shown && (
        <span
          data-testid="path-touch"
          className="flex min-w-0 shrink items-center gap-[6px] font-human text-[11px] text-[var(--muted)]"
        >
          <span
            aria-hidden
            className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-[#fff]"
            style={{ background: touch.agent.color }}
          >
            {touch.agent.letter}
          </span>
          <span className="min-w-0 truncate">
            <AgentName workflowId={workflowId} agent={touch.agent} /> edited lines {lines.from}–
            {lines.to} · {ago(touch.at)}
            {model !== undefined && (
              <>
                {' · '}
                <span data-testid="path-touch-model" className="font-machine text-[10.5px]">
                  {model}
                </span>
              </>
            )}
          </span>
          <NodeInDomain workflowId={workflowId} agent={touch.agent} />
        </span>
      )}
      <button
        type="button"
        aria-label="Format Document"
        title="Format Document (Shift+Alt+F)"
        onClick={() => void formatDocument(projectId, path)}
        disabled={!FORMATTABLE.has(languageOf(path))}
        className="flex h-[24px] shrink-0 cursor-pointer items-center whitespace-nowrap rounded-[999px] border border-[var(--line)] bg-[var(--chip)] px-[10px] font-human text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f] disabled:cursor-default disabled:opacity-[0.45] disabled:hover:bg-[var(--chip)]"
      >
        Format
      </button>
      {workflowId !== undefined && workflowId !== '' && <RunPipeline workflowId={workflowId} />}
    </div>
  );
}

const LINK =
  'cursor-pointer rounded-[4px] text-[var(--ink)] underline-offset-2 outline-none hover:underline focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/**
 * PG-3.4: the writing agent's name — a link to its node on the canvas (selected, centred, the
 * selected run kept) inside a workflow route; plain text anywhere else.
 */
function AgentName({ workflowId, agent }: { workflowId?: string | undefined; agent: AgentLook }) {
  if (!useInRouterContext() || workflowId === undefined || workflowId === '') {
    return <>{agent.name}</>;
  }
  return <FollowLink workflowId={workflowId} agent={agent} mode="ideate" />;
}

/** PG-3.4: the same node's lens in Domain, beside the name. */
function NodeInDomain({
  workflowId,
  agent,
}: {
  workflowId?: string | undefined;
  agent: AgentLook;
}) {
  if (!useInRouterContext() || workflowId === undefined || workflowId === '') return null;
  return <FollowLink workflowId={workflowId} agent={agent} mode="domain" />;
}

function FollowLink({
  workflowId,
  agent,
  mode,
}: {
  workflowId: string;
  agent: AgentLook;
  mode: 'ideate' | 'domain';
}) {
  const follow = useFollowNode({ workflowId });
  const label = mode === 'ideate' ? `Show ${agent.name} on canvas` : `Open ${agent.name} in Domain`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={mode === 'ideate' ? 'path-touch-node' : 'path-touch-domain'}
      onClick={() => follow(agent.nodeId, mode)}
      className={
        mode === 'ideate'
          ? `${LINK} border-none bg-transparent p-0 font-semibold`
          : 'flex h-[20px] shrink-0 cursor-pointer items-center rounded-full border border-[var(--line)] bg-transparent px-[7px] font-human text-[10.5px] text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]'
      }
    >
      {mode === 'ideate' ? agent.name : 'Domain'}
    </button>
  );
}

/** "▶ Run pipeline": the workflow's real run, refused while one is already going. */
function RunPipeline({ workflowId }: { workflowId: string }) {
  const { start, dialog, active, pending, open, estimate } = useStartRunFlow(workflowId);
  // PG-3.5 (D323): a Domain run still open waits for the person — say so and offer its End.
  if (open !== undefined) return <OpenRunEnd open={open} />;
  return (
    <>
      <button
        type="button"
        // PG-4.3: the estimate and what the budget leaves, before the run starts.
        {...(estimate === undefined ? {} : { title: estimateTitle(estimate) })}
        onClick={start}
        disabled={active || pending}
        className="flex h-[24px] shrink-0 cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[999px] border border-[var(--line)] bg-[var(--chip)] px-[10px] font-human text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f] disabled:cursor-default disabled:opacity-[0.45] disabled:hover:bg-[var(--chip)]"
      >
        <span aria-hidden className="text-[9px] text-[#2f9e63]">
          <Icons.Play aria-hidden size={12} />
        </span>
        Run pipeline
      </button>
      {dialog}
    </>
  );
}
