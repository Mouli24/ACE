import {
  DEFAULT_WATCH_INTERVAL_MINUTES,
  TASK_BRIEF_MAX,
  TASK_TITLE_MAX,
  type AcceptSuggestionRequest,
  type CreateProjectNoteRequest,
  type CreateResponsibilityRequest,
  type ErrorKind,
  type ImportEmailRequest,
  type ProjectNote,
  type Responsibility,
  type Suggestion,
  type SuggestionEvidence,
  type SuggestionStatus,
  type Task,
  type TaskSource,
  type UpdateProjectNoteRequest,
  type UpdateResponsibilityRequest,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';
import { createTask, readTask } from './tasks';

/**
 * The mock suggestions engine (ACE parity P2, D280–D282), mirroring
 * `packages/engine/src/suggestions`: responsibilities that scan nothing until *Scan now*, a scan
 * that answers at once `running` and finishes after the scan pace, a *Software health* scan over
 * the mock task store (the latest failing check of each open task's head, and every failed task),
 * suggestions deduplicated by fingerprint so a dismissed one never returns, *Add to Inbox* making
 * an Inbox task that starts nothing, team notes, and an `.eml` import. Every change is announced as
 * `project.changed` on the engine scope, as the engine's bus does.
 *
 * The rows live beside the `MockDb` rather than in it, one store per db. A row whose project is gone
 * (a reset, a deleted project) is treated as gone too, as the engine's foreign keys would have it.
 *
 * Knobs, like the task work pace: `setScanPace` (`'manual'` holds every scan until a test calls
 * `completeMockScan`), `failNextScan`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** A refusal the handlers turn into the `ApiError` envelope. */
export class SuggestionEngineError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const notFound = (what: string) =>
  new SuggestionEngineError(404, 'workflow', 'not_found', `${what} was not found.`);

/* -------------------------------------------------------------------------- */
/* Knobs                                                                       */
/* -------------------------------------------------------------------------- */

const DEFAULT_SCAN_PACE = 600;

/** How long a scan takes before it completes, in ms; `'manual'` waits for a test. */
let scanPace: number | 'manual' = DEFAULT_SCAN_PACE;
export function setScanPace(pace: number | 'manual'): void {
  scanPace = pace === 'manual' ? pace : Math.max(0, pace);
}

let failNextScanReason: string | undefined;
/** The next scan fails with this reason instead of completing. */
export function failNextScan(reason: string | false = 'gh answered: HTTP 502'): void {
  failNextScanReason = reason === false ? undefined : reason;
}

/** Every scan still running, by responsibility: one at a time per responsibility. */
const pending = new Map<
  string,
  { run: () => void; timer: ReturnType<typeof setTimeout> | undefined }
>();

function cancelPending(id: string): void {
  const entry = pending.get(id);
  if (entry?.timer !== undefined) clearTimeout(entry.timer);
  pending.delete(id);
}

/** Finish this responsibility's running scan now. Answers whether one was running. */
export function completeMockScan(responsibilityId: string): boolean {
  const entry = pending.get(responsibilityId);
  if (entry === undefined) return false;
  cancelPending(responsibilityId);
  entry.run();
  return true;
}

/** The responsibilities with a scan still running — what a test waits on. */
export function pendingMockScans(): string[] {
  return [...pending.keys()];
}

/** Every running scan dropped and every knob back to its default: what a test calls between cases. */
export function resetMockSuggestions(): void {
  for (const id of [...pending.keys()]) cancelPending(id);
  scanPace = DEFAULT_SCAN_PACE;
  failNextScanReason = undefined;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

interface Tables {
  responsibilities: Responsibility[];
  suggestions: Suggestion[];
  notes: ProjectNote[];
}

const emptyTables = (): Tables => ({ responsibilities: [], suggestions: [], notes: [] });

export const MOCK_P2_STORAGE_KEY = 'ace.mock.p2';

export interface SuggestionStoreOptions {
  /** Persist to localStorage, as the browser mock's `MockDb` does, so a reload keeps the rows. */
  persist?: boolean;
  storageKey?: string;
}

class SuggestionStore {
  private tables: Tables = emptyTables();

  constructor(
    private readonly db: MockDb,
    private readonly options: SuggestionStoreOptions,
  ) {
    this.load();
  }

  /** Re-read the shared copy: another tab may have written since. */
  load(): void {
    if (this.options.persist !== true) return;
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      if (raw) this.tables = { ...emptyTables(), ...(JSON.parse(raw) as Tables) };
    } catch {
      this.tables = emptyTables();
    }
  }

  save(): void {
    if (this.options.persist !== true) return;
    // What a reset or a deleted project left behind is dropped rather than kept in storage.
    this.tables = {
      responsibilities: this.responsibilities,
      suggestions: this.suggestions,
      notes: this.notes,
    };
    try {
      globalThis.localStorage?.setItem(this.key, JSON.stringify(this.tables));
    } catch {
      /* storage full or unavailable: the in-memory copy still serves this tab */
    }
  }

  private get key(): string {
    return this.options.storageKey ?? MOCK_P2_STORAGE_KEY;
  }

  /** A row counts only while its project exists. */
  private live<T extends { projectId: string }>(rows: T[]): T[] {
    return rows.filter((row) => this.db.getProject(row.projectId) !== undefined);
  }

  get responsibilities(): Responsibility[] {
    return this.live(this.tables.responsibilities);
  }

  get suggestions(): Suggestion[] {
    return this.live(this.tables.suggestions);
  }

  get notes(): ProjectNote[] {
    return this.live(this.tables.notes);
  }

  putResponsibility(row: Responsibility): Responsibility {
    this.tables.responsibilities = [
      ...this.tables.responsibilities.filter((own) => own.id !== row.id),
      row,
    ].sort((a, b) => a.id.localeCompare(b.id));
    this.save();
    return row;
  }

  /** Its suggestions go with it, as the engine's foreign key cascade does. */
  deleteResponsibility(id: string): void {
    this.tables.responsibilities = this.tables.responsibilities.filter((own) => own.id !== id);
    this.tables.suggestions = this.tables.suggestions.filter((own) => own.responsibilityId !== id);
    this.save();
  }

  putSuggestion(row: Suggestion): Suggestion {
    this.tables.suggestions = [
      ...this.tables.suggestions.filter((own) => own.id !== row.id),
      row,
    ].sort((a, b) => a.id.localeCompare(b.id));
    this.save();
    return row;
  }

  putNote(row: ProjectNote): ProjectNote {
    this.tables.notes = [...this.tables.notes.filter((own) => own.id !== row.id), row].sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    this.save();
    return row;
  }

  deleteNote(id: string): void {
    this.tables.notes = this.tables.notes.filter((own) => own.id !== id);
    this.save();
  }
}

const stores = new WeakMap<MockDb, SuggestionStore>();

/** The P2 rows that go with this db; the first call's options decide whether they persist. */
export function suggestionStore(db: MockDb, options: SuggestionStoreOptions = {}): SuggestionStore {
  let store = stores.get(db);
  if (store === undefined) {
    store = new SuggestionStore(db, options);
    stores.set(db, store);
  }
  return store;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const now = (): string => new Date().toISOString();

const MAX_NEW_PER_SCAN = 20;
const DETAIL_MAX = 1_500;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

function requireProject(db: MockDb, projectId: string): void {
  if (db.getProject(projectId) === undefined) throw notFound(`Project ${projectId}`);
}

function requireResponsibility(db: MockDb, id: string): Responsibility {
  const found = suggestionStore(db).responsibilities.find((row) => row.id === id);
  if (found === undefined) throw notFound(`Responsibility ${id}`);
  return found;
}

function requireSuggestion(db: MockDb, id: string): Suggestion {
  const found = suggestionStore(db).suggestions.find((row) => row.id === id);
  if (found === undefined) throw notFound(`Suggestion ${id}`);
  return found;
}

function requireNote(db: MockDb, id: string): ProjectNote {
  const found = suggestionStore(db).notes.find((row) => row.id === id);
  if (found === undefined) throw notFound(`Note ${id}`);
  return found;
}

function changed(
  db: MockDb,
  projectId: string,
  what: 'suggestions' | 'responsibilities' | 'notes',
): void {
  db.emit({ type: 'project.changed', scope: 'engine', payload: { projectId, what } });
}

/** A task made here keeps where it came from — the mock task store's create leaves `source` out. */
function createInboxTask(
  db: MockDb,
  projectId: string,
  body: Parameters<typeof createTask>[2],
  source: TaskSource,
): Task {
  const task = createTask(db, projectId, { ...body, start: 'inbox' });
  const stored = db.updateTask(task.id, { source });
  return stored === undefined ? task : readTask(db, stored);
}

/* -------------------------------------------------------------------------- */
/* Responsibilities                                                            */
/* -------------------------------------------------------------------------- */

export function listResponsibilities(db: MockDb, projectId: string): Responsibility[] {
  requireProject(db, projectId);
  return suggestionStore(db).responsibilities.filter((row) => row.projectId === projectId);
}

export function createResponsibility(
  db: MockDb,
  projectId: string,
  body: CreateResponsibilityRequest,
): Responsibility {
  requireProject(db, projectId);
  const at = now();
  const row = suggestionStore(db).putResponsibility({
    id: newId(),
    projectId,
    kind: body.kind,
    title: body.title,
    why: body.why ?? '',
    goodWork: body.goodWork ?? '',
    ...(body.query === undefined ? {} : { query: body.query }),
    watch: body.watch ?? false,
    watchIntervalMinutes: body.watchIntervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES,
    paused: false,
    createdAt: at,
    updatedAt: at,
  });
  changed(db, projectId, 'responsibilities');
  return row;
}

export function updateResponsibility(
  db: MockDb,
  id: string,
  body: UpdateResponsibilityRequest,
): Responsibility {
  const found = requireResponsibility(db, id);
  const next: Responsibility = { ...found, updatedAt: now() };
  if (body.title !== undefined) next.title = body.title;
  if (body.why !== undefined) next.why = body.why;
  if (body.goodWork !== undefined) next.goodWork = body.goodWork;
  if (body.query !== undefined) next.query = body.query;
  if (body.watch !== undefined) next.watch = body.watch;
  if (body.watchIntervalMinutes !== undefined)
    next.watchIntervalMinutes = body.watchIntervalMinutes;
  if (body.paused !== undefined) next.paused = body.paused;
  const saved = suggestionStore(db).putResponsibility(next);
  changed(db, found.projectId, 'responsibilities');
  return saved;
}

export function deleteResponsibility(db: MockDb, id: string): void {
  const found = requireResponsibility(db, id);
  cancelPending(id);
  suggestionStore(db).deleteResponsibility(id);
  changed(db, found.projectId, 'responsibilities');
  changed(db, found.projectId, 'suggestions');
}

interface Finding {
  fingerprint: string;
  title: string;
  reason: string;
  evidence: SuggestionEvidence[];
  proposedAction: string;
}

/**
 * *Software health* over the mock task store, as the engine reads its own records: the latest
 * result of each check on each open task's current head, then every failed task. The mock has no
 * GitHub, so open issues and failed workflow runs never appear (the engine adds them only with a
 * GitHub remote and a signed-in `gh`).
 */
function softwareHealth(db: MockDb, projectId: string): Finding[] {
  const findings: Finding[] = [];
  const tasks = [...db.listTasks(projectId)].sort((a, b) => a.number - b.number);
  for (const task of tasks) {
    if (task.stage === 'done') continue;
    const workspace = db.taskWorkspaceOf(task.id);
    if (workspace?.status !== 'ready') continue;
    const latest = new Map<string, ReturnType<MockDb['taskChecksOf']>[number]>();
    for (const check of db.taskChecksOf(task.id)) {
      if (check.headSha === workspace.headSha && check.name !== 'setup')
        latest.set(check.name, check);
    }
    for (const check of latest.values()) {
      if (check.status === 'passed') continue;
      findings.push({
        fingerprint: `check:${task.id}:${check.name}`,
        title: clip(
          `Fix the failing "${check.name}" check on task #${task.number}`,
          TASK_TITLE_MAX,
        ),
        reason: `The "${check.name}" check (${check.command}) ${check.status === 'timeout' ? 'timed out' : 'failed'} on ${workspace.headSha.slice(0, 7)}, the commit task #${task.number} would deliver.`,
        evidence: [
          {
            kind: 'failed_check',
            label: `Check "${check.name}" ${check.status} on task #${task.number} (exit ${check.exitCode ?? 'none'})`,
            detail: clip(check.output, DETAIL_MAX),
            taskId: task.id,
          },
        ],
        proposedAction: `Task #${task.number} ("${task.title}") fails its "${check.name}" check: \`${check.command}\`. Find the cause and make it pass without weakening the check.`,
      });
    }
  }
  for (const task of tasks) {
    if (task.state !== 'failed') continue;
    findings.push({
      fingerprint: `task:${task.id}`,
      title: clip(`Unblock task #${task.number}: ${task.title}`, TASK_TITLE_MAX),
      reason: `Task #${task.number} is stuck in ${task.stage}.`,
      evidence: [
        {
          kind: 'failed_task',
          label: `Task #${task.number} failed in ${task.stage}`,
          detail: clip(task.stateReason ?? 'No reason recorded.', DETAIL_MAX),
          taskId: task.id,
        },
      ],
      proposedAction: `Task #${task.number} ("${task.title}") failed: ${task.stateReason ?? 'no reason recorded'}. Work out what blocks it and fix that, or say why it should be closed.`,
    });
  }
  return findings;
}

function finishScan(db: MockDb, id: string): void {
  const store = suggestionStore(db);
  const owner = store.responsibilities.find((row) => row.id === id);
  if (owner === undefined) return;
  let status: Responsibility['lastScanStatus'];
  let message: string;
  const failure = failNextScanReason;
  failNextScanReason = undefined;
  if (failure !== undefined) {
    status = 'failed';
    message = `The scan failed: ${failure}`;
  } else {
    let added = 0;
    for (const finding of softwareHealth(db, owner.projectId)) {
      if (added >= MAX_NEW_PER_SCAN) break;
      const seen = store.suggestions.some(
        (row) => row.projectId === owner.projectId && row.fingerprint === finding.fingerprint,
      );
      if (seen) continue;
      const at = now();
      store.putSuggestion({
        id: newId(),
        projectId: owner.projectId,
        responsibilityId: owner.id,
        title: finding.title,
        reason: finding.reason,
        evidence: finding.evidence,
        proposedAction: finding.proposedAction,
        completionCriteria: owner.goodWork,
        status: 'new',
        fingerprint: finding.fingerprint,
        createdAt: at,
        updatedAt: at,
      });
      added += 1;
    }
    status = 'completed';
    message =
      added === 0
        ? 'Nothing new worth doing was found.'
        : `Found ${added} new suggestion${added === 1 ? '' : 's'}.`;
  }
  settleScan(db, owner, status, message);
}

function settleScan(
  db: MockDb,
  owner: Responsibility,
  status: NonNullable<Responsibility['lastScanStatus']>,
  message: string,
): void {
  const store = suggestionStore(db);
  const current = store.responsibilities.find((row) => row.id === owner.id);
  if (current !== undefined) {
    const at = now();
    store.putResponsibility({
      ...current,
      lastScanAt: at,
      lastScanStatus: status,
      lastScanMessage: message,
      updatedAt: at,
    });
  }
  changed(db, owner.projectId, 'suggestions');
  changed(db, owner.projectId, 'responsibilities');
}

/** *Scan now*: answers at once `running`; the findings land after the scan pace. */
export function scanResponsibility(db: MockDb, id: string): Responsibility {
  const found = requireResponsibility(db, id);
  if (found.kind === 'email') {
    throw new SuggestionEngineError(
      422,
      'invalid_config',
      'not_connected',
      'Watching email needs a mail connection, which this version of ACE does not have.',
    );
  }
  if (pending.has(id)) {
    throw new SuggestionEngineError(
      409,
      'workflow',
      'scan_running',
      'A scan of this responsibility is already running.',
    );
  }
  const running = suggestionStore(db).putResponsibility({
    ...found,
    lastScanStatus: 'running',
    lastScanMessage: 'Scanning…',
    updatedAt: now(),
  });
  changed(db, found.projectId, 'responsibilities');
  const run = () => finishScan(db, id);
  pending.set(id, {
    run,
    timer:
      scanPace === 'manual'
        ? undefined
        : setTimeout(() => {
            pending.delete(id);
            run();
          }, scanPace),
  });
  return running;
}

/** Stops a running scan (`cancelled`); with none running, the responsibility as it stands. */
export function cancelResponsibilityScan(db: MockDb, id: string): Responsibility {
  const found = requireResponsibility(db, id);
  if (pending.has(id)) {
    cancelPending(id);
    settleScan(db, found, 'cancelled', 'The scan was cancelled.');
  }
  return requireResponsibility(db, id);
}

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                 */
/* -------------------------------------------------------------------------- */

/** Newest first, as the engine lists them. */
export function listSuggestions(
  db: MockDb,
  projectId: string,
  status?: SuggestionStatus,
): Suggestion[] {
  requireProject(db, projectId);
  return suggestionStore(db)
    .suggestions.filter(
      (row) => row.projectId === projectId && (status === undefined || row.status === status),
    )
    .sort((a, b) => b.id.localeCompare(a.id));
}

function requireUndecided(found: Suggestion): void {
  if (found.status === 'accepted' || found.status === 'dismissed') {
    throw new SuggestionEngineError(
      409,
      'workflow',
      'invalid_task_state',
      `This suggestion was already ${found.status}.`,
    );
  }
}

/** *Add to Inbox*: an Inbox task with finish line Pass review; nothing starts. */
export function acceptSuggestion(
  db: MockDb,
  id: string,
  body: AcceptSuggestionRequest,
): Suggestion {
  const found = requireSuggestion(db, id);
  requireUndecided(found);
  const owner = suggestionStore(db).responsibilities.find(
    (row) => row.id === found.responsibilityId,
  );
  const evidence = found.evidence
    .map((item) => `- ${item.label}${item.url === undefined ? '' : ` (${item.url})`}`)
    .join('\n');
  const task = createInboxTask(
    db,
    found.projectId,
    {
      title: found.title,
      brief: clip(
        `${found.proposedAction}\n\nWhy: ${found.reason}\n\nEvidence:\n${evidence}`,
        TASK_BRIEF_MAX,
      ),
      acceptance: found.completionCriteria,
      finishLine: 'review',
      ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
    },
    {
      kind: 'suggestion',
      refId: found.id,
      ...(owner === undefined ? {} : { label: owner.title }),
    },
  );
  const saved = suggestionStore(db).putSuggestion({
    ...found,
    status: 'accepted',
    taskId: task.id,
    updatedAt: now(),
  });
  changed(db, found.projectId, 'suggestions');
  return saved;
}

function decide(db: MockDb, id: string, status: 'later' | 'dismissed'): Suggestion {
  const found = requireSuggestion(db, id);
  requireUndecided(found);
  const saved = suggestionStore(db).putSuggestion({ ...found, status, updatedAt: now() });
  changed(db, found.projectId, 'suggestions');
  return saved;
}

export const laterSuggestion = (db: MockDb, id: string): Suggestion => decide(db, id, 'later');
export const dismissSuggestion = (db: MockDb, id: string): Suggestion =>
  decide(db, id, 'dismissed');

/** A suggestion as a scan would leave it — for tests and seeds that need one without a scan. */
export function seedSuggestion(
  db: MockDb,
  responsibility: Responsibility,
  fields: Partial<Suggestion> & Pick<Suggestion, 'title'>,
): Suggestion {
  const at = now();
  return suggestionStore(db).putSuggestion({
    id: newId(),
    projectId: responsibility.projectId,
    responsibilityId: responsibility.id,
    reason: 'Task #1 is stuck in work.',
    evidence: [{ kind: 'failed_task', label: 'Task #1 failed in work' }],
    proposedAction: 'Work out what blocks it and fix that.',
    completionCriteria: responsibility.goodWork,
    status: 'new',
    fingerprint: `seed:${newId()}`,
    createdAt: at,
    updatedAt: at,
    ...fields,
  });
}

/* -------------------------------------------------------------------------- */
/* Team notes (D281)                                                           */
/* -------------------------------------------------------------------------- */

/** Oldest first — the order a task run's prompt gets them in. */
export function listNotes(db: MockDb, projectId: string): ProjectNote[] {
  requireProject(db, projectId);
  return suggestionStore(db).notes.filter((row) => row.projectId === projectId);
}

export function createNote(
  db: MockDb,
  projectId: string,
  body: CreateProjectNoteRequest,
): ProjectNote {
  requireProject(db, projectId);
  const at = now();
  const source = body.source ?? 'user';
  const note = suggestionStore(db).putNote({
    id: newId(),
    projectId,
    text: body.text,
    status: body.status ?? (source === 'user' ? 'verified' : 'unverified'),
    source,
    ...(body.refId === undefined ? {} : { refId: body.refId }),
    createdAt: at,
    updatedAt: at,
  });
  changed(db, projectId, 'notes');
  return note;
}

/** Correcting a note's text is confirming it (ACE: "confirm, correct or forget"). */
export function updateNote(db: MockDb, id: string, body: UpdateProjectNoteRequest): ProjectNote {
  const found = requireNote(db, id);
  const saved = suggestionStore(db).putNote({
    ...found,
    ...(body.text === undefined ? {} : { text: body.text, status: 'verified' as const }),
    ...(body.status === undefined ? {} : { status: body.status }),
    updatedAt: now(),
  });
  changed(db, found.projectId, 'notes');
  return saved;
}

export function deleteNote(db: MockDb, id: string): void {
  const found = requireNote(db, id);
  suggestionStore(db).deleteNote(id);
  changed(db, found.projectId, 'notes');
}

/* -------------------------------------------------------------------------- */
/* Email import (D282)                                                         */
/* -------------------------------------------------------------------------- */

interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  date: string;
  text: string;
}

function splitHeaders(raw: string): { headers: Map<string, string>; body: string } {
  const normalised = raw.replace(/\r\n/g, '\n');
  const blank = normalised.indexOf('\n\n');
  const head = blank === -1 ? normalised : normalised.slice(0, blank);
  const body = blank === -1 ? '' : normalised.slice(blank + 2);
  const headers = new Map<string, string>();
  let current: string | undefined;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && current !== undefined) {
      headers.set(current, `${headers.get(current) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    // The first occurrence wins (a forwarded message repeats headers further down).
    if (!headers.has(current)) headers.set(current, line.slice(colon + 1).trim());
    else current = undefined;
  }
  return { headers, body };
}

/**
 * A smaller reader than the engine's (`suggestions/email.ts`): the From/To/Subject/Date headers
 * and the text body — the first `text/plain` part of a multipart message, attachments dropped. It
 * decodes no RFC 2047 words, quoted-printable or base64; the engine does.
 */
export function parseMockEmail(raw: string): ParsedEmail {
  const message = splitHeaders(raw);
  const header = (name: string): string => (message.headers.get(name) ?? '').trim();
  let text = message.body;
  const type = message.headers.get('content-type') ?? '';
  const boundary = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary !== undefined) {
    text = '';
    for (const chunk of message.body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break;
      const part = splitHeaders(chunk.replace(/^\n/, ''));
      const partType = (part.headers.get('content-type') ?? 'text/plain').toLowerCase();
      const disposition = (part.headers.get('content-disposition') ?? '').toLowerCase();
      if (disposition.startsWith('attachment')) continue;
      if (partType.startsWith('text/plain')) {
        text = part.body;
        break;
      }
    }
  }
  return {
    from: header('from'),
    to: header('to'),
    subject: header('subject'),
    date: header('date'),
    text: text.trim().slice(0, 20_000),
  };
}

/** One message saved to the Inbox as a task whose source names the sender; nothing starts. */
export function importEmail(db: MockDb, projectId: string, body: ImportEmailRequest): Task {
  requireProject(db, projectId);
  const mail = parseMockEmail(body.raw);
  const header = [
    mail.from === '' ? '' : `From: ${mail.from}`,
    mail.to === '' ? '' : `To: ${mail.to}`,
    mail.date === '' ? '' : `Date: ${mail.date}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
  return createInboxTask(
    db,
    projectId,
    {
      title: clip(mail.subject === '' ? '(no subject)' : mail.subject, TASK_TITLE_MAX),
      brief: clip(`${header}\n\n${mail.text === '' ? '(no text)' : mail.text}`, TASK_BRIEF_MAX),
      ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
    },
    { kind: 'email', ...(mail.from === '' ? {} : { label: clip(mail.from, 400) }) },
  );
}
