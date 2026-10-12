import type { ProcessStream, ProjectScripts } from '@ace/contracts';

import type {
  ProcessHandlers,
  ProcessRunner,
  ProcessSpec,
  RunningProcess,
} from '../../ports/index.js';

/** One process the fake started; the test plays its side. */
export interface FakeProcess {
  readonly spec: ProcessSpec;
  /** What was written to stdin, in order. */
  readonly written: string[];
  /** How many times Stop was asked for. */
  stops: number;
  print(text: string, stream?: ProcessStream): void;
  exit(code: number | null, signal?: string | null): void;
  /** It never started: the runner reports a spawn error. */
  fail(message: string): void;
}

export type FakeRunner = ProcessRunner & {
  readonly started: FakeProcess[];
  /** How many times `scripts()` was called. */
  readonly scriptsAsked: number;
  /** The newest process started. */
  last(): FakeProcess;
};

export interface FakeRunnerOptions {
  scripts?: ProjectScripts;
  /** `scripts()` answers only once this settles: a test can change things meanwhile. */
  scriptsGate?: Promise<void>;
  /** Refuse a start the way the real runner refuses a working folder: throw from `start`. */
  refuse?: (spec: ProcessSpec) => Error | undefined;
  /** A Stop ends the process on the next microtask, as a kill would. Default true. */
  exitOnStop?: boolean;
}

/** A `ProcessRunner` with no processes in it: every output and every end is the test's to play. */
export function fakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const started: FakeProcess[] = [];
  let asked = 0;
  return {
    started,
    get scriptsAsked() {
      return asked;
    },
    last() {
      const newest = started.at(-1);
      if (newest === undefined) throw new Error('the fake runner started nothing');
      return newest;
    },
    start(spec: ProcessSpec, handlers: ProcessHandlers): RunningProcess {
      const refusal = options.refuse?.(spec);
      if (refusal !== undefined) throw refusal;
      let ended = false;
      const played: FakeProcess = {
        spec,
        written: [],
        stops: 0,
        print: (text, stream = 'stdout') => {
          if (!ended) handlers.onOutput(stream, text);
        },
        exit: (code, signal = null) => {
          if (ended) return;
          ended = true;
          handlers.onExit(code, signal);
        },
        fail: (message) => {
          if (ended) return;
          ended = true;
          handlers.onError(new Error(message));
        },
      };
      started.push(played);
      return {
        pid: 1000 + started.length,
        write: (data) => {
          if (!ended) played.written.push(data);
        },
        stop: () => {
          played.stops += 1;
          if (options.exitOnStop !== false) queueMicrotask(() => played.exit(null, 'SIGKILL'));
        },
      };
    },
    scripts: async () => {
      asked += 1;
      await options.scriptsGate;
      return options.scripts ?? { packageManager: 'npm', scripts: [] };
    },
  };
}
