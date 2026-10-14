/**
 * The human's hands on a running debate (D349, D358): "Judge now", "Pause after this round",
 * resume, and (D351) an interrupt to one debater. A control can be made before its debate starts
 * — a pause asked for early holds after the first round — and is attached by the runner.
 */

export interface DebateControl {
  judgeNow(): void;
  pauseAfterRound(): void;
  resume(): void;
  /** Kill one debater's turn in flight; it re-runs in the same round. False when it has none. */
  interrupt(nodeId: string): boolean;
}

/** The runner's side of a control. */
export interface DebateControlBinding {
  onJudgeNow(): void;
  onPause(): void;
  onResume(): void;
  onInterrupt(nodeId: string): boolean;
}

export interface AttachableDebateControl extends DebateControl {
  attach(binding: DebateControlBinding): void;
  detach(): void;
  readonly judgeNowRequested: boolean;
  readonly pauseRequested: boolean;
}

export function createDebateControl(): AttachableDebateControl {
  let binding: DebateControlBinding | undefined;
  let judgeNowRequested = false;
  let pauseRequested = false;

  return {
    get judgeNowRequested() {
      return judgeNowRequested;
    },
    get pauseRequested() {
      return pauseRequested;
    },
    judgeNow() {
      if (judgeNowRequested) return;
      judgeNowRequested = true;
      binding?.onJudgeNow();
    },
    pauseAfterRound() {
      if (pauseRequested) return;
      pauseRequested = true;
      binding?.onPause();
    },
    resume() {
      if (!pauseRequested) return;
      pauseRequested = false;
      binding?.onResume();
    },
    interrupt(nodeId) {
      return binding?.onInterrupt(nodeId) ?? false;
    },
    attach(next) {
      binding = next;
    },
    detach() {
      binding = undefined;
    },
  };
}
