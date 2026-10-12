import type { Project } from '@ace/contracts';
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';

import { AG, ORB, T, type Tint } from '../theme/constants';
import { ago } from '../theme/format';
import { useThemeMode } from '../theme/mode';
import type { ProjectSummary } from './useProjectSummaries';

/*
 * A Recent card on Home (`Ace Home.dc.html`, the Board preview, D337): a tinted preview with the
 * project's real agents orbiting a doc glyph, then its name and "N agents · Repository · ago".
 */

/** The tints in the theme's order; a project's tint is a hash of its id over these. */
export const TINTS: readonly Tint[] = ['blue', 'red', 'pink', 'purple', 'green', 'teal', 'amber'];

/** A deterministic tint per project id. */
export function tintOf(projectId: string): Tint {
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return TINTS[hash % TINTS.length] ?? 'blue';
}

/** "1 agent", "3 agents" — the theme's `agentLabel`. */
const agentLabel = (n: number) => `${n}${n === 1 ? ' agent' : ' agents'}`;

const DOC_LINE = 'h-[1.5px] bg-[var(--iconLine)]';
const CENTERED = 'absolute left-1/2 top-1/2 rounded-full [transform:translate(-50%,-50%)]';

export function ProjectCard({
  project,
  summary,
  onOpen,
}: {
  project: Project;
  summary: ProjectSummary | undefined;
  /** Open the project (records it as the last one, then navigates). */
  onOpen: () => void;
}) {
  const { dark } = useThemeMode();
  const tint = tintOf(project.id);
  const [light, accent] = T[tint];
  const ring = `${accent}40`;
  const agents = summary?.agents;
  const lastActivity = summary?.lastActivity;

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // A modified click (new tab or window) is the browser's; a plain one opens it here.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    onOpen();
  };

  return (
    <Link
      to={`/projects/${project.id}`}
      onClick={open}
      aria-label={project.name}
      data-testid={`project-card-${project.id}`}
      className="block cursor-pointer overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_3px_rgba(40,30,20,0.06),0_6px_20px_rgba(40,30,20,0.04)] outline-none [transition:transform_.2s,box-shadow_.2s] hover:text-[var(--ink)] hover:shadow-[0_4px_24px_rgba(40,30,20,0.1)] hover:[transform:translateY(-2px)] focus-visible:border-[#ef6b3f]"
    >
      <div
        aria-hidden
        className="relative h-[124px] overflow-hidden"
        style={{ background: dark ? `linear-gradient(135deg,${accent}33,#1d1b1a 75%)` : light }}
      >
        <div className="absolute inset-0 bg-[radial-gradient(var(--dot)_1px,transparent_1.2px)] bg-[length:10px_10px]" />
        <div className="absolute left-[8px] top-[8px] flex items-center gap-[4px] rounded-[3px] bg-[var(--surface)] px-[5px] py-[2px] text-[6.5px] font-semibold tracking-[0.1em] text-[var(--muted)]">
          <span className="h-[4px] w-[4px] rounded-full" style={{ background: accent }} />
          BOARD
        </div>
        <div
          className={`${CENTERED} h-[96px] w-[96px] animate-[pulseRing_5s_ease-in-out_infinite]`}
          style={{ border: `1px solid ${ring}` }}
        />
        <div
          className={`${CENTERED} h-[76px] w-[76px] animate-[pulseRing_5s_ease-in-out_1.2s_infinite]`}
          style={{ border: `1px solid ${ring}` }}
        />
        <div className={`${CENTERED} h-[60px] w-[60px]`} style={{ background: `${accent}14` }} />
        <div className="absolute left-1/2 top-1/2 flex h-[26px] w-[26px] flex-col justify-center gap-[2px] rounded-[7px] bg-[var(--surface)] px-[6px] shadow-[0_3px_10px_rgba(0,0,0,0.12)] [transform:translate(-50%,-50%)]">
          <div className={DOC_LINE} />
          <div className={DOC_LINE} />
          <div className={`${DOC_LINE} w-[60%]`} />
        </div>
        {agents?.map((agent, i) => {
          // One tile per agent, up to the theme's four orbits.
          const orbit = ORB[i];
          if (!orbit) return null;
          const [keyframes, seconds, phase] = orbit;
          return (
            <div
              key={agent.nodeId}
              data-testid="project-agent-tile"
              className="absolute left-1/2 top-1/2 flex h-[13px] w-[13px] items-center justify-center rounded-[4px] text-[6.5px] font-bold text-[#fff] shadow-[0_0_0_2px_rgba(255,255,255,0.6)] [margin:-6.5px_0_0_-6.5px]"
              style={{
                animation: `${keyframes} ${seconds}s linear ${-seconds * phase}s infinite`,
                background: AG[tint][i % 3] ?? accent,
              }}
            >
              {agent.letter}
            </div>
          );
        })}
      </div>
      <div className="px-[12px] pb-[12px] pt-[16px]">
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium tracking-[-0.01em]">
          {project.name}
        </div>
        <div className="mb-[9px] mt-[16px] h-px bg-[var(--line)]" />
        {/* min-h 1lh: the row keeps its height while the fields are still empty. */}
        <div className="flex min-h-[1lh] gap-[8px] text-[9px] text-[var(--muted)]">
          <span>{agents === undefined ? '' : agentLabel(agents.length)}</span>
          {summary?.repo === true && <span>Repository</span>}
          <span className="flex-1" />
          <span>{lastActivity === undefined ? '' : ago(lastActivity)}</span>
        </div>
      </div>
    </Link>
  );
}
