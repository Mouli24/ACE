import type {
  AcceptSuggestionRequest,
  CreateProjectNoteRequest,
  CreateResponsibilityRequest,
  CreateTaskRequest,
  Id,
  ImportEmailRequest,
  Project,
  ProjectNote,
  Responsibility,
  Suggestion,
  SuggestionEvidence,
  SuggestionListQuery,
  Task,
  UpdateProjectNoteRequest,
  UpdateResponsibilityRequest,
} from '@ace/contracts';
import { DEFAULT_WATCH_INTERVAL_MINUTES, TASK_TITLE_MAX } from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { HttpError, notFound, notImplemented } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type {
  GitHubPort,
  GitPort,
  ProjectNoteRepository,
  Repository,
  ResponsibilityRepository,
  Scope,
  SuggestionRepository,
} from '../ports/index.js';
import { parseGitHubRemote } from '../tasks/github-delivery.js';
import { parseEmail } from './email.js';

/**
 * Suggestions, responsibilities, team notes and email import (ACE parity P2, D280–D282).
 *
 * A scan runs only on *Scan now* or, with *Watch automatically* on, on a timer while the engine runs
 * — never while the responsibility or its project is paused, never two at once for one
 * responsibility, and cancellable. What it finds becomes suggestions, deduplicated by fingerprint so
 * a dismissed one never returns; accepting one creates an Inbox task and starts nothing.
 */
export interface SuggestionService {
  listResponsibilities(projectId: Id): Promise<Responsibility[]>;
  createResponsibility(projectId: Id, body: CreateResponsibilityRequest): Promise<Responsibility>;
  updateResponsibility(id: Id, body: UpdateResponsibilityRequest): Promise<Responsibility>;
  deleteResponsibility(id: Id): Promise<void>;
  /** Starts a scan in the background and answers at once (`lastScanStatus: running`). */
  scan(id: Id): Promise<Responsibility>;
  cancelScan(id: Id): Promise<Responsibility>;

  listSuggestions(projectId: Id, query: SuggestionListQuery): Promise<Suggestion[]>;
  accept(id: Id, body: AcceptSuggestionRequest): Promise<Suggestion>;
  later(id: Id): Promise<Suggestion>;
  dismiss(id: Id): Promise<Suggestion>;

  listNotes(projectId: Id): Promise<ProjectNote[]>;
  createNote(projectId: Id, body: CreateProjectNoteRequest): Promise<ProjectNote>;
  updateNote(id: Id, body: UpdateProjectNoteRequest): Promise<ProjectNote>;
  deleteNote(id: Id): Promise<void>;

  importEmail(projectId: Id, body: ImportEmailRequest): Promise<Task>;

  /** Starts the watch timer; returns its stop. */
  start(checkEveryMs?: number): () => void;
  /** One pass of the watch timer (exposed for tests). */
  watchTick(): Promise<void>;
  idle(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SuggestionServiceDeps {
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  /** The task service's create — how an accepted suggestion or an imported email becomes a task. */
  createTask: (projectId: Id, body: CreateTaskRequest) => Promise<Task>;
  git?: GitPort;
  github?: GitHubPort;
  /** Masks secret-shaped text in evidence copied from check output or issues (BR-07). */
  mask?: (text: string) => string;
  now?: () => string;
  nextId?: () => string;
}

const MAX_NEW_PER_SCAN = 20;
const DETAIL_MAX = 1_500;
const DEFAULT_WATCH_CHECK_MS = 60_000;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

class ScanCancelled extends Error {}

export function createSuggestionService(deps: SuggestionServiceDeps): SuggestionService {
  const { repository, scope, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;
  const mask = deps.mask ?? ((text: string) => text);
  const scans = new Map<Id, AbortController>();
  const background = new Set<Promise<unknown>>();

  function repos(): {
    responsibilities: ResponsibilityRepository;
    suggestions: SuggestionRepository;
    notes: ProjectNoteRepository;
  } {
    const { responsibilities, suggestions, projectNotes } = repository;
    if (responsibilities === undefined || suggestions === undefined || projectNotes === undefined) {
      throw notImplemented('suggestions');
    }
    return { responsibilities, suggestions, notes: projectNotes };
  }

  async function project(projectId: Id): Promise<Project> {
    const found = await repository.projects.get(scope, projectId);
    if (found === null) throw notFound(`Project ${projectId}`);
    return found;
  }

  async function responsibility(id: Id): Promise<Responsibility> {
    const found = await repos().responsibilities.get(scope, id);
    if (found === null) throw notFound(`Responsibility ${id}`);
    return found;
  }

  async function suggestion(id: Id): Promise<Suggestion> {
    const found = await repos().suggestions.get(scope, id);
    if (found === null) throw notFound(`Suggestion ${id}`);
    return found;
  }

  async function changed(
    projectId: Id,
    what: 'suggestions' | 'responsibilities' | 'notes',
  ): Promise<void> {
    await bus.emit({ type: 'project.changed', payload: { projectId, what } });
  }

  function track(work: () => Promise<unknown>): void {
    const promise = work().catch((error: unknown) =>
      logger.error({ subsystem: 'suggestions', err: error }, 'background step failed'),
    );
    background.add(promise);
    void promise.finally(() => background.delete(promise));
  }

  /* ------------------------------------------------------------------------ */
  /* Software health                                                           */
  /* ------------------------------------------------------------------------ */

  interface Finding {
    fingerprint: string;
    title: string;
    reason: string;
    evidence: SuggestionEvidence[];
    proposedAction: string;
  }

  async function softwareHealth(owner: Responsibility, signal: AbortSignal): Promise<Finding[]> {
    const findings: Finding[] = [];
    const halt = (): void => {
      if (signal.aborted) throw new ScanCancelled();
    };
    const tasks = (await repository.tasks?.listByProject(scope, owner.projectId)) ?? [];

    // ACE's own records: the latest result of each check, for each task's current head.
    for (const task of tasks) {
      halt();
      if (task.stage === 'done') continue;
      const workspace = await repository.taskWorkspaces?.getByTask(scope, task.id);
      if (workspace?.status !== 'ready') continue;
      const checks = (await repository.taskChecks?.listByTask(scope, task.id)) ?? [];
      const latest = new Map<string, (typeof checks)[number]>();
      for (const check of checks) {
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
              detail: clip(mask(check.output), DETAIL_MAX),
              taskId: task.id,
            },
          ],
          proposedAction: `Task #${task.number} ("${task.title}") fails its "${check.name}" check: \`${check.command}\`. Find the cause and make it pass without weakening the check.`,
        });
      }
    }

    for (const task of tasks) {
      halt();
      if (task.state !== 'failed') continue;
      findings.push({
        fingerprint: `task:${task.id}`,
        title: clip(`Unblock task #${task.number}: ${task.title}`, TASK_TITLE_MAX),
        reason: `Task #${task.number} is stuck in ${task.stage}.`,
        evidence: [
          {
            kind: 'failed_task',
            label: `Task #${task.number} failed in ${task.stage}`,
            detail: clip(mask(task.stateReason ?? 'No reason recorded.'), DETAIL_MAX),
            taskId: task.id,
          },
        ],
        proposedAction: `Task #${task.number} ("${task.title}") failed: ${task.stateReason ?? 'no reason recorded'}. Work out what blocks it and fix that, or say why it should be closed.`,
      });
    }

    // GitHub, when the repository has a remote there and `gh` is signed in.
    const github = deps.github;
    if (github?.listOpenIssues === undefined && github?.listFailedRuns === undefined)
      return findings;
    if (github === undefined || deps.git === undefined) return findings;
    const where = await project(owner.projectId);
    const repo = await deps.git.inspect(where.folderPath);
    if (parseGitHubRemote(repo.remoteUrl) === undefined) return findings;
    const status = await github.status();
    if (!status.installed || !status.loggedIn) return findings;
    halt();
    for (const issue of (await github.listOpenIssues?.({ cwd: where.folderPath, limit: 20 })) ??
      []) {
      findings.push({
        fingerprint: `issue:${issue.number}`,
        title: clip(`Look into issue #${issue.number}: ${issue.title}`, TASK_TITLE_MAX),
        reason: `GitHub issue #${issue.number} is open${issue.labels.length === 0 ? '' : ` (${issue.labels.join(', ')})`}.`,
        evidence: [
          {
            kind: 'github_issue',
            label: `Issue #${issue.number}: ${clip(issue.title, 300)}`,
            url: issue.url,
            detail: clip(mask(issue.body), DETAIL_MAX),
          },
        ],
        proposedAction: `Investigate GitHub issue #${issue.number} (${issue.url}): "${issue.title}". Reproduce it, and fix it if it is a real defect.\n\n${clip(issue.body, 2_000)}`,
      });
    }
    halt();
    for (const run of (await github.listFailedRuns?.({ cwd: where.folderPath, limit: 10 })) ?? []) {
      findings.push({
        fingerprint: `run:${run.name}:${run.branch}`,
        title: clip(`Fix the failing "${run.name}" workflow on ${run.branch}`, TASK_TITLE_MAX),
        reason: `The "${run.name}" GitHub workflow failed on ${run.branch} (${run.createdAt}).`,
        evidence: [
          {
            kind: 'github_run',
            label: `Workflow "${run.name}" failed on ${run.branch}`,
            url: run.url,
          },
        ],
        proposedAction: `The "${run.name}" workflow fails on ${run.branch}: ${run.url}. Find why from its log and fix it.`,
      });
    }
    return findings;
  }

  async function runScan(id: Id, controller: AbortController): Promise<void> {
    const owner = await responsibility(id);
    let message: string;
    let status: Responsibility['lastScanStatus'];
    try {
      const findings = await softwareHealth(owner, controller.signal);
      let added = 0;
      for (const finding of findings) {
        if (controller.signal.aborted) throw new ScanCancelled();
        if (added >= MAX_NEW_PER_SCAN) break;
        const seen = await repos().suggestions.getByFingerprint(
          scope,
          owner.projectId,
          finding.fingerprint,
        );
        if (seen !== null) continue;
        const at = now();
        await repos().suggestions.create(scope, {
          id: nextId(),
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
    } catch (error) {
      if (error instanceof ScanCancelled) {
        status = 'cancelled';
        message = 'The scan was cancelled.';
      } else {
        status = 'failed';
        message = `The scan failed: ${mask(error instanceof Error ? error.message : String(error))}`;
      }
    } finally {
      scans.delete(id);
    }
    const current = await repos().responsibilities.get(scope, id);
    if (current !== null) {
      await repos().responsibilities.save(scope, {
        ...current,
        lastScanAt: now(),
        lastScanStatus: status,
        lastScanMessage: clip(message, 2_000),
        updatedAt: now(),
      });
    }
    await changed(owner.projectId, 'suggestions');
    await changed(owner.projectId, 'responsibilities');
  }

  async function decide(id: Id, status: 'later' | 'dismissed'): Promise<Suggestion> {
    const found = await suggestion(id);
    if (found.status === 'accepted' || found.status === 'dismissed') {
      throw new HttpError(
        'workflow',
        'invalid_task_state',
        `This suggestion was already ${found.status}.`,
      );
    }
    const saved = await repos().suggestions.save(scope, { ...found, status, updatedAt: now() });
    await changed(found.projectId, 'suggestions');
    return saved;
  }

  const service: SuggestionService = {
    async listResponsibilities(projectId) {
      await project(projectId);
      return repos().responsibilities.listByProject(scope, projectId);
    },

    async createResponsibility(projectId, body) {
      await project(projectId);
      const at = now();
      const created = await repos().responsibilities.create(scope, {
        id: nextId(),
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
      await changed(projectId, 'responsibilities');
      return created;
    },

    async updateResponsibility(id, body) {
      const found = await responsibility(id);
      const next: Responsibility = { ...found, updatedAt: now() };
      if (body.title !== undefined) next.title = body.title;
      if (body.why !== undefined) next.why = body.why;
      if (body.goodWork !== undefined) next.goodWork = body.goodWork;
      if (body.query !== undefined) next.query = body.query;
      if (body.watch !== undefined) next.watch = body.watch;
      if (body.watchIntervalMinutes !== undefined)
        next.watchIntervalMinutes = body.watchIntervalMinutes;
      if (body.paused !== undefined) next.paused = body.paused;
      const saved = await repos().responsibilities.save(scope, next);
      await changed(found.projectId, 'responsibilities');
      return saved;
    },

    async deleteResponsibility(id) {
      const found = await responsibility(id);
      scans.get(id)?.abort();
      await repos().responsibilities.delete(scope, id);
      await changed(found.projectId, 'responsibilities');
      await changed(found.projectId, 'suggestions');
    },

    async scan(id) {
      const found = await responsibility(id);
      if (found.kind === 'email') {
        throw new HttpError(
          'invalid_config',
          'not_connected',
          'Watching email needs a mail connection, which this version of ACE does not have.',
        );
      }
      if (scans.has(id)) {
        throw new HttpError(
          'workflow',
          'scan_running',
          'A scan of this responsibility is already running.',
        );
      }
      const controller = new AbortController();
      scans.set(id, controller);
      const running = await repos().responsibilities.save(scope, {
        ...found,
        lastScanStatus: 'running',
        lastScanMessage: 'Scanning…',
        updatedAt: now(),
      });
      await changed(found.projectId, 'responsibilities');
      track(() => runScan(id, controller));
      return running;
    },

    async cancelScan(id) {
      const found = await responsibility(id);
      scans.get(id)?.abort();
      await service.idle();
      return (await repos().responsibilities.get(scope, id)) ?? found;
    },

    async listSuggestions(projectId, query) {
      await project(projectId);
      return repos().suggestions.listByProject(scope, projectId, query.status);
    },

    async accept(id, body) {
      const found = await suggestion(id);
      if (found.status === 'accepted' || found.status === 'dismissed') {
        throw new HttpError(
          'workflow',
          'invalid_task_state',
          `This suggestion was already ${found.status}.`,
        );
      }
      const owner = await repos().responsibilities.get(scope, found.responsibilityId);
      const evidence = found.evidence
        .map((item) => `- ${item.label}${item.url === undefined ? '' : ` (${item.url})`}`)
        .join('\n');
      const task = await deps.createTask(found.projectId, {
        title: found.title,
        brief: `${found.proposedAction}\n\nWhy: ${found.reason}\n\nEvidence:\n${evidence}`,
        acceptance: found.completionCriteria,
        // ACE: suggested tasks keep a review step for their final action.
        finishLine: 'review',
        ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
        source: {
          kind: 'suggestion',
          refId: found.id,
          ...(owner === null ? {} : { label: owner.title }),
        },
        start: 'inbox',
      });
      const saved = await repos().suggestions.save(scope, {
        ...found,
        status: 'accepted',
        taskId: task.id,
        updatedAt: now(),
      });
      await changed(found.projectId, 'suggestions');
      return saved;
    },

    later: (id) => decide(id, 'later'),
    dismiss: (id) => decide(id, 'dismissed'),

    async listNotes(projectId) {
      await project(projectId);
      return repos().notes.listByProject(scope, projectId);
    },

    async createNote(projectId, body) {
      await project(projectId);
      const at = now();
      const source = body.source ?? 'user';
      const note = await repos().notes.create(scope, {
        id: nextId(),
        projectId,
        text: body.text,
        status: body.status ?? (source === 'user' ? 'verified' : 'unverified'),
        source,
        ...(body.refId === undefined ? {} : { refId: body.refId }),
        createdAt: at,
        updatedAt: at,
      });
      await changed(projectId, 'notes');
      return note;
    },

    async updateNote(id, body) {
      const found = await repos().notes.get(scope, id);
      if (found === null) throw notFound(`Note ${id}`);
      // Correcting a note's text is confirming it (ACE: "confirm, correct or forget").
      const saved = await repos().notes.save(scope, {
        ...found,
        ...(body.text === undefined ? {} : { text: body.text, status: 'verified' as const }),
        ...(body.status === undefined ? {} : { status: body.status }),
        updatedAt: now(),
      });
      await changed(found.projectId, 'notes');
      return saved;
    },

    async deleteNote(id) {
      const found = await repos().notes.get(scope, id);
      if (found === null) throw notFound(`Note ${id}`);
      await repos().notes.delete(scope, id);
      await changed(found.projectId, 'notes');
    },

    async importEmail(projectId, body) {
      await project(projectId);
      const mail = parseEmail(body.raw);
      const header = [
        mail.from === '' ? '' : `From: ${mail.from}`,
        mail.to === '' ? '' : `To: ${mail.to}`,
        mail.date === '' ? '' : `Date: ${mail.date}`,
      ]
        .filter((line) => line !== '')
        .join('\n');
      return deps.createTask(projectId, {
        title: clip(mail.subject === '' ? '(no subject)' : mail.subject, TASK_TITLE_MAX),
        brief: clip(`${header}\n\n${mail.text === '' ? '(no text)' : mail.text}`, 20_000),
        ...(body.workflowId === undefined ? {} : { workflowId: body.workflowId }),
        source: { kind: 'email', ...(mail.from === '' ? {} : { label: clip(mail.from, 400) }) },
        start: 'inbox',
      });
    },

    async watchTick() {
      const due = (await repos().responsibilities.listWatched(scope)).filter((owner) => {
        if (owner.kind !== 'software_health' || scans.has(owner.id)) return false;
        if (owner.lastScanAt === undefined) return true;
        return (
          Date.parse(owner.lastScanAt) + owner.watchIntervalMinutes * 60_000 <= Date.parse(now())
        );
      });
      for (const owner of due) {
        const where = await repository.projects.get(scope, owner.projectId);
        if (where === null || where.paused === true) continue;
        try {
          await service.scan(owner.id);
        } catch (error) {
          logger.warn({ subsystem: 'suggestions', err: error }, 'watch scan did not start');
        }
      }
    },

    start(checkEveryMs = DEFAULT_WATCH_CHECK_MS) {
      const timer = setInterval(() => track(() => service.watchTick()), checkEveryMs);
      timer.unref();
      return () => clearInterval(timer);
    },

    async idle() {
      while (background.size > 0) await Promise.allSettled([...background]);
    },

    async shutdown() {
      for (const controller of scans.values()) controller.abort();
      await service.idle();
    },
  };
  return service;
}
