import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/*
 * "Changes save automatically" (D333): a text or number field in the node settings modal saves
 * while the user types — debounced, so one graph-op per pause rather than per keystroke — and at
 * once on blur. Every close path (Done, Close, Esc, a click outside) first commits whatever is still
 * waiting, which is what the registry below is for: each debounced field registers its flush.
 */

/** How long a field waits after the last keystroke before it saves. */
export const SAVE_DEBOUNCE_MS = 400;

export interface PendingEdits {
  /** Adds a field's flush; the returned function removes it. */
  register(flush: () => void): () => void;
  /** Commits every field's pending edit now. */
  flushAll(): void;
}

const PendingEditsContext = createContext<PendingEdits | undefined>(undefined);

export const PendingEditsProvider = PendingEditsContext.Provider;

/** A stable registry for one modal: its fields register here, its close paths call `flushAll`. */
export function usePendingEditsRegistry(): PendingEdits {
  const flushes = useRef(new Set<() => void>());
  return useMemo(
    () => ({
      register(flush) {
        flushes.current.add(flush);
        return () => void flushes.current.delete(flush);
      },
      flushAll() {
        for (const flush of [...flushes.current]) flush();
      },
    }),
    [],
  );
}

/**
 * One debounced commit. `schedule` replaces whatever was waiting; `flush` commits it now; `cancel`
 * drops it. What is waiting is committed on unmount too, so closing never loses a keystroke.
 */
export function useDebouncedCommit<T>(
  commit: (value: T) => void,
  delayMs: number = SAVE_DEBOUNCE_MS,
): { schedule(value: T): void; flush(): void; cancel(): void } {
  const commitRef = useRef(commit);
  useLayoutEffect(() => {
    commitRef.current = commit;
  });
  const pending = useRef<{ value: T } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancel = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    pending.current = undefined;
  }, []);

  const flush = useCallback(() => {
    const waiting = pending.current;
    cancel();
    if (waiting !== undefined) commitRef.current(waiting.value);
  }, [cancel]);

  const schedule = useCallback(
    (value: T) => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      pending.current = { value };
      timer.current = setTimeout(flush, delayMs);
    },
    [flush, delayMs],
  );

  const registry = useContext(PendingEditsContext);
  useEffect(() => registry?.register(flush), [registry, flush]);
  useEffect(() => flush, [flush]);

  return useMemo(() => ({ schedule, flush, cancel }), [schedule, flush, cancel]);
}

/**
 * A field's local draft that autosaves (D333). `parse` turns the draft into a value to save, or
 * `undefined` while it cannot be saved (an out-of-range number, an empty name). The field ignores
 * the echo of its own save coming back through the graph cache, so saving "Writer " as "Writer"
 * never eats the space being typed; any other change of `value` (undo, another tab) replaces the
 * draft.
 */
export function useAutosaveDraft<V, D>({
  value,
  toDraft,
  parse,
  onCommit,
  revertInvalidOnBlur = false,
}: {
  value: V;
  toDraft: (value: V) => D;
  parse: (draft: D) => V | undefined;
  onCommit: (value: V) => void;
  /** On blur, put back the saved value when the draft cannot be saved (e.g. an empty name). */
  revertInvalidOnBlur?: boolean;
}): { draft: D; change(next: D): void; blur(): void } {
  const [draft, setDraft] = useState<D>(() => toDraft(value));
  /** The value this field last saved or was given. */
  const saved = useRef<V>(value);
  const toDraftRef = useRef(toDraft);
  const parseRef = useRef(parse);
  useLayoutEffect(() => {
    toDraftRef.current = toDraft;
    parseRef.current = parse;
  });

  const debounced = useDebouncedCommit<V>((next) => {
    if (Object.is(next, saved.current)) return;
    saved.current = next;
    onCommit(next);
  });

  useEffect(() => {
    if (Object.is(value, saved.current)) return;
    saved.current = value;
    debounced.cancel();
    setDraft(toDraftRef.current(value));
  }, [value, debounced]);

  const change = (next: D) => {
    setDraft(next);
    const parsed = parseRef.current(next);
    if (parsed === undefined) debounced.cancel();
    else debounced.schedule(parsed);
  };

  const blur = () => {
    debounced.flush();
    setDraft((current) => {
      const parsed = parseRef.current(current);
      if (parsed === undefined)
        return revertInvalidOnBlur ? toDraftRef.current(saved.current) : current;
      return Object.is(parsed, saved.current) ? toDraftRef.current(saved.current) : current;
    });
  };

  return { draft, change, blur };
}
