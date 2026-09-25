/**
 * The clock behind a scripted run (round 2 §5 item 11). Round 2 armed one `setTimeout` per frame at
 * its offset from the start and could only cancel the lot; round 3's controls need the queue itself
 * to be something you can pause, resume and cancel per run, because `POST /runs/:id/pause` must stop
 * the next node from ever starting (FR-CTL-001) and `POST /runs/:id/resume` must carry on from
 * exactly where it stopped (FR-CTL-002).
 *
 * The timing is round 2's, deliberately: every step keeps its own place on one timeline, armed
 * up front, so a step whose callback takes 40 ms to render does not push everything after it 40 ms
 * later. A pause rearms what is left with the wait each step had still to go.
 *
 * A step can also pause its own queue — that is how the `paused` and `waiting-approval` scenarios
 * stop dead and wait for a decision that arrives over REST.
 */

export interface PlaybackStep {
  /** Milliseconds after the previous step. */
  after: number;
  play(): void;
}

interface Playback {
  steps: PlaybackStep[];
  /** When each step is due, absolute; rewritten on a resume. */
  due: number[];
  timers: Map<number, ReturnType<typeof setTimeout>>;
  played: Set<number>;
  paused: boolean;
}

const playbacks = new Map<string, Playback>();

/** Arm every step that has not played yet, each at its own due time. */
function arm(runId: string, playback: Playback): void {
  playback.steps.forEach((step, index) => {
    if (playback.played.has(index) || playback.timers.has(index)) return;
    const timer = setTimeout(
      () => {
        playback.timers.delete(index);
        playback.played.add(index);
        step.play();
        if (playback.played.size === playback.steps.length && playbacks.get(runId) === playback) {
          // the run has told its whole story
          playbacks.delete(runId);
        }
      },
      Math.max(0, playback.due[index]! - Date.now()),
    );
    playback.timers.set(index, timer);
  });
}

function disarm(playback: Playback): void {
  for (const timer of playback.timers.values()) clearTimeout(timer);
  playback.timers.clear();
}

/** Start (or replace) this run's queue. */
export function startPlayback(runId: string, steps: readonly PlaybackStep[]): void {
  cancelPlayback(runId);
  if (steps.length === 0) return;
  let elapsed = Date.now();
  const playback: Playback = {
    steps: [...steps],
    due: steps.map((step) => (elapsed += step.after)),
    timers: new Map(),
    played: new Set(),
    paused: false,
  };
  playbacks.set(runId, playback);
  arm(runId, playback);
}

/** Hold the queue where it is; answers whether anything was still waiting to play. */
export function pausePlayback(runId: string): boolean {
  const playback = playbacks.get(runId);
  if (playback === undefined || playback.paused) return false;
  playback.paused = true;
  const at = Date.now();
  // what each remaining step had still to wait, so a resume owes exactly that and no more
  playback.due = playback.due.map((due) => Math.max(0, due - at));
  disarm(playback);
  return true;
}

/** Carry on from the step the pause stopped at. */
export function resumePlayback(runId: string): boolean {
  const playback = playbacks.get(runId);
  if (playback === undefined || !playback.paused) return false;
  playback.paused = false;
  const at = Date.now();
  playback.due = playback.due.map((remaining) => remaining + at);
  arm(runId, playback);
  return true;
}

/** Drop the rest of the queue — a stop, or a restart taking the run's place. */
export function cancelPlayback(runId: string): void {
  const playback = playbacks.get(runId);
  if (playback === undefined) return;
  disarm(playback);
  playbacks.delete(runId);
}

/** Every queue, cancelled: what a test calls between cases so one run cannot leak into the next. */
export function stopAllPlayback(): void {
  for (const runId of [...playbacks.keys()]) cancelPlayback(runId);
}

/** How many steps this run has left — a test asserting that a pause really stopped the queue. */
export function pendingPlaybackSteps(runId: string): number {
  const playback = playbacks.get(runId);
  return playback === undefined ? 0 : playback.steps.length - playback.played.size;
}

/** Whether this run's queue is held (paused) rather than finished or cancelled. */
export function isPlaybackPaused(runId: string): boolean {
  return playbacks.get(runId)?.paused ?? false;
}
