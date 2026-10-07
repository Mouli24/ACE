import type { AssistantProposal } from '@ace/contracts';
import { createAceClient, type AceApiError } from '@ace/sdk';
import { setupServer } from 'msw/node';

import { subscribeMockEvents } from './event-bus';
import { MockDb, type MockEvent } from './db';
import { createHandlers } from './handlers';
import { createRound5Handlers } from './handlers-round5';
import { createSuggestionHandlers } from './handlers-suggestions';
import { createTaskHandlers } from './handlers-tasks';
import {
  parseMockEmail,
  completeMockScan,
  failNextScan,
  resetMockSuggestions,
  setScanPace,
} from './suggestions';
import {
  completeMockWork,
  createTask,
  failNextChecks,
  failNextWork,
  resetMockTasks,
  setTaskWorkPace,
  workTask,
} from './tasks';

/**
 * The ACE parity P2 MSW seam (D280–D283): the mock suggestions engine and Assistant answered through
 * the real SDK, so every reply is parsed with the contract schema the engine must also satisfy.
 */

const db = new MockDb({ persist: false });
const server = setupServer(
  ...createSuggestionHandlers(db),
  ...createTaskHandlers(db),
  ...createRound5Handlers(db),
  ...createHandlers(db),
);
const client = createAceClient({
  baseUrl: 'http://mock.local',
  token: 'mock',
  fetch: (input, init) => globalThis.fetch(input, init),
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  resetMockTasks();
  resetMockSuggestions();
  setTaskWorkPace('manual');
  setScanPace('manual');
  db.reset();
});

async function failure(promise: Promise<unknown>): Promise<AceApiError> {
  try {
    await promise;
  } catch (error) {
    return error as AceApiError;
  }
  throw new Error('expected the call to fail');
}

function seedProject() {
  const project = db.createProject({ name: 'Shop' });
  const team = db.createWorkflow(project.id, 'Builders');
  return { project, team };
}

/** Task #1 fails its work run; task #2 lands in review with its check failing. */
function seedFailures(projectId: string, teamId: string) {
  const stuck = createTask(db, projectId, { title: 'Add filters', workflowId: teamId });
  failNextWork('The model ran out of budget.');
  workTask(db, stuck.id);
  completeMockWork(stuck.id);
  const red = createTask(db, projectId, { title: 'Fix search', workflowId: teamId });
  workTask(db, red.id);
  failNextChecks();
  completeMockWork(red.id);
  return { stuck, red };
}

describe('D280 mock responsibilities', () => {
  it('creates with the engine defaults, lists, edits, pauses and deletes', async () => {
    const { project } = seedProject();
    const created = await client.createResponsibility(project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
    });
    expect(created).toMatchObject({
      projectId: project.id,
      why: '',
      goodWork: '',
      watch: false,
      watchIntervalMinutes: 60,
      paused: false,
    });
    expect(created.lastScanStatus).toBeUndefined();

    const edited = await client.updateResponsibility(created.id, {
      watch: true,
      watchIntervalMinutes: 30,
      paused: true,
      goodWork: 'Every check passes.',
    });
    expect(edited).toMatchObject({ watch: true, watchIntervalMinutes: 30, paused: true });
    expect((await client.listResponsibilities(project.id)).items).toEqual([edited]);

    await client.deleteResponsibility(created.id);
    expect((await client.listResponsibilities(project.id)).items).toEqual([]);
    expect((await failure(client.deleteResponsibility(created.id))).status).toBe(404);
  });

  it('answers 404 for an unknown project, and forgets rows whose project is gone', async () => {
    expect((await failure(client.listResponsibilities(db.nextId()))).code).toBe('not_found');
    const { project } = seedProject();
    const created = await client.createResponsibility(project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
    });
    db.reset();
    expect((await failure(client.scanResponsibility(created.id))).status).toBe(404);
  });

  it('refuses to scan an email responsibility: there is no mail connection', async () => {
    const { project } = seedProject();
    const mail = await client.createResponsibility(project.id, {
      kind: 'email',
      title: 'Customer mail',
      query: 'to:support@example.com',
    });
    const refused = await failure(client.scanResponsibility(mail.id));
    expect(refused).toMatchObject({ status: 422, code: 'not_connected' });
  });
});

describe('D280 mock scans', () => {
  it('answers running at once, then finds the failing check and the failed task', async () => {
    const { project, team } = seedProject();
    const { stuck, red } = seedFailures(project.id, team.id);
    const owner = await client.createResponsibility(project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
      goodWork: 'Every check passes.',
    });
    const events: MockEvent[] = [];
    const stop = subscribeMockEvents((event) => events.push(event));

    const running = await client.scanResponsibility(owner.id);
    expect(running).toMatchObject({ lastScanStatus: 'running', lastScanMessage: 'Scanning…' });
    expect((await failure(client.scanResponsibility(owner.id))).code).toBe('scan_running');
    expect((await client.listSuggestions(project.id)).items).toEqual([]);

    expect(completeMockScan(owner.id)).toBe(true);
    stop();
    const items = (await client.listSuggestions(project.id)).items;
    expect(items.map((item) => item.fingerprint).sort()).toEqual(
      [`check:${red.id}:test`, `task:${stuck.id}`].sort(),
    );
    const check = items.find((item) => item.fingerprint.startsWith('check:'));
    expect(check).toMatchObject({
      title: 'Fix the failing "test" check on task #2',
      status: 'new',
      completionCriteria: 'Every check passes.',
      responsibilityId: owner.id,
    });
    expect(check?.evidence[0]).toMatchObject({ kind: 'failed_check', taskId: red.id });
    const [after] = (await client.listResponsibilities(project.id)).items;
    expect(after).toMatchObject({
      lastScanStatus: 'completed',
      lastScanMessage: 'Found 2 new suggestions.',
    });
    expect(after?.lastScanAt).toBeDefined();
    expect(
      events
        .filter(
          (event) =>
            event.type === 'project.changed' &&
            (event.payload as { projectId: string }).projectId === project.id,
        )
        .map((event) => [event.scope, (event.payload as { what: string }).what]),
    ).toEqual([
      ['engine', 'responsibilities'],
      ['engine', 'suggestions'],
      ['engine', 'responsibilities'],
    ]);
  });

  it('never suggests the same thing twice, even once dismissed', async () => {
    const { project, team } = seedProject();
    seedFailures(project.id, team.id);
    const owner = await client.createResponsibility(project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
    });
    await client.scanResponsibility(owner.id);
    completeMockScan(owner.id);
    const first = (await client.listSuggestions(project.id)).items;
    await client.dismissSuggestion(first[0]!.id);

    await client.scanResponsibility(owner.id);
    completeMockScan(owner.id);
    expect((await client.listSuggestions(project.id)).items).toHaveLength(2);
    expect((await client.listResponsibilities(project.id)).items[0]?.lastScanMessage).toBe(
      'Nothing new worth doing was found.',
    );
  });

  it('cancels a running scan, and records a failed one', async () => {
    const { project } = seedProject();
    const owner = await client.createResponsibility(project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
    });
    await client.scanResponsibility(owner.id);
    const cancelled = await client.cancelResponsibilityScan(owner.id);
    expect(cancelled).toMatchObject({
      lastScanStatus: 'cancelled',
      lastScanMessage: 'The scan was cancelled.',
    });
    expect(completeMockScan(owner.id)).toBe(false);

    failNextScan('gh answered: HTTP 502');
    await client.scanResponsibility(owner.id);
    completeMockScan(owner.id);
    expect((await client.listResponsibilities(project.id)).items[0]).toMatchObject({
      lastScanStatus: 'failed',
      lastScanMessage: 'The scan failed: gh answered: HTTP 502',
    });
  });

  it('deletes a responsibility with its suggestions', async () => {
    const { project, team } = seedProject();
    seedFailures(project.id, team.id);
    const owner = await client.createResponsibility(project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
    });
    await client.scanResponsibility(owner.id);
    completeMockScan(owner.id);
    await client.deleteResponsibility(owner.id);
    expect((await client.listSuggestions(project.id)).items).toEqual([]);
  });
});

describe('D280 mock suggestion decisions', () => {
  async function scanned() {
    const { project, team } = seedProject();
    seedFailures(project.id, team.id);
    const owner = await client.createResponsibility(project.id, {
      kind: 'software_health',
      title: 'Keep checks green',
      goodWork: 'Every check passes.',
    });
    await client.scanResponsibility(owner.id);
    completeMockScan(owner.id);
    const items = (await client.listSuggestions(project.id)).items;
    return { project, team, owner, items };
  }

  it('Add to Inbox creates an idle Inbox task that names its source, and starts nothing', async () => {
    const { project, team, owner, items } = await scanned();
    const target = items[0]!;
    const accepted = await client.acceptSuggestion(target.id, { workflowId: team.id });
    expect(accepted.status).toBe('accepted');
    const detail = await client.getTask(accepted.taskId!);
    expect(detail.task).toMatchObject({
      projectId: project.id,
      title: target.title,
      stage: 'inbox',
      state: 'idle',
      finishLine: 'review',
      workflowId: team.id,
      acceptance: 'Every check passes.',
      source: { kind: 'suggestion', refId: target.id, label: owner.title },
    });
    expect(detail.task.brief).toContain(`Why: ${target.reason}`);
    expect(detail.executions).toEqual([]);

    const again = await failure(client.acceptSuggestion(target.id));
    expect(again).toMatchObject({ status: 409, code: 'invalid_task_state' });
  });

  it('Later keeps it, Dismiss is final, and the status filter finds each', async () => {
    const { project, items } = await scanned();
    const [one, two] = items;
    await client.laterSuggestion(one!.id);
    await client.dismissSuggestion(two!.id);
    expect((await client.listSuggestions(project.id, { status: 'later' })).items).toEqual([
      expect.objectContaining({ id: one!.id, status: 'later' }),
    ]);
    expect(
      (await client.listSuggestions(project.id, { status: 'dismissed' })).items.map((s) => s.id),
    ).toEqual([two!.id]);
    expect((await client.listSuggestions(project.id, { status: 'new' })).items).toEqual([]);
    // A later one can still be added; a dismissed one cannot.
    expect((await client.acceptSuggestion(one!.id)).status).toBe('accepted');
    expect((await failure(client.laterSuggestion(two!.id))).code).toBe('invalid_task_state');
  });

  it('refuses a team from another project, and keeps the suggestion new', async () => {
    const { items } = await scanned();
    const other = seedProject();
    const refused = await failure(
      client.acceptSuggestion(items[0]!.id, { workflowId: other.team.id }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
  });
});

describe('D281 mock team notes', () => {
  it('a note written here is verified; correcting text confirms it; Forget deletes', async () => {
    const { project } = seedProject();
    const mine = await client.createProjectNote(project.id, {
      text: 'Search lives in src/search.ts.',
    });
    expect(mine).toMatchObject({ status: 'verified', source: 'user' });
    const saved = await client.createProjectNote(project.id, {
      text: 'The API is slow on Mondays.',
      source: 'task',
    });
    expect(saved.status).toBe('unverified');

    expect((await client.updateProjectNote(saved.id, { status: 'verified' })).status).toBe(
      'verified',
    );
    expect((await client.updateProjectNote(saved.id, { status: 'unverified' })).status).toBe(
      'unverified',
    );
    const corrected = await client.updateProjectNote(saved.id, {
      text: 'The API is slow at 9:00.',
    });
    expect(corrected).toMatchObject({ text: 'The API is slow at 9:00.', status: 'verified' });

    expect((await client.listProjectNotes(project.id)).items.map((n) => n.id)).toEqual([
      mine.id,
      saved.id,
    ]);
    await client.deleteProjectNote(mine.id);
    expect((await client.listProjectNotes(project.id)).items.map((n) => n.id)).toEqual([saved.id]);
    expect((await failure(client.deleteProjectNote(mine.id))).status).toBe(404);
  });
});

describe('D282 mock email import', () => {
  it('saves the message as an Inbox task named by its subject, from its sender', async () => {
    const { project, team } = seedProject();
    const raw = [
      'From: Ann <ann@example.com>',
      'To: support@example.com',
      'Subject: Search is',
      ' slow',
      'Date: Tue, 6 Oct 2026 09:00:00 +0000',
      '',
      'It takes 3 s.',
    ].join('\r\n');
    const task = await client.importEmail(project.id, { raw, workflowId: team.id });
    expect(task).toMatchObject({
      title: 'Search is slow',
      stage: 'inbox',
      state: 'idle',
      workflowId: team.id,
      source: { kind: 'email', label: 'Ann <ann@example.com>' },
    });
    expect(task.brief).toBe(
      'From: Ann <ann@example.com>\nTo: support@example.com\nDate: Tue, 6 Oct 2026 09:00:00 +0000\n\nIt takes 3 s.',
    );
  });

  it('keeps the text part of a multipart message and drops the attachment', () => {
    const raw = [
      'Subject: Report',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'See the numbers.',
      '--b1',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="r.pdf"',
      '',
      'JVBERi0=',
      '--b1--',
    ].join('\n');
    expect(parseMockEmail(raw)).toMatchObject({ subject: 'Report', text: 'See the numbers.' });
  });

  it('names a message without a subject, and refuses an unknown project', async () => {
    const { project } = seedProject();
    expect((await client.importEmail(project.id, { raw: 'hello' })).title).toBe('(no subject)');
    expect((await failure(client.importEmail(db.nextId(), { raw: 'Subject: x' }))).status).toBe(
      404,
    );
  });
});

describe('D283 mock Ace Assistant', () => {
  it('proposes by the rules, revises with the previous proposal, and writes nothing', async () => {
    const before = db.listProjects().length;
    const proposal = await client.assistantPropose({
      prompt: 'Build a booking app. Have one agent plan it and another review it, $2 per run.',
    });
    expect(proposal).toMatchObject({
      projectName: 'Booking app',
      team: 'plan-build-review',
      maxCostPerRunUsd: 2,
      source: 'rules',
    });
    expect(proposal.agents.map((a) => a.role)).toEqual(['planner', 'builder', 'reviewer']);

    const revised = await client.assistantPropose({
      prompt: 'Just one agent.',
      previous: proposal,
    });
    expect(revised.team).toBe('single-builder');
    expect(revised.projectName).toBe('Booking app');
    expect(db.listProjects()).toHaveLength(before);
  });

  it('says a proposal is model-drafted only when the model is on a provider it has', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    const drafted = await client.assistantPropose({
      prompt: 'Build a quiz game.',
      providerId: provider.id,
      modelId: 'mock-coder',
    });
    expect(drafted.source).toBe('model');
    const unknown = await client.assistantPropose({
      prompt: 'Build a quiz game.',
      providerId: db.nextId(),
      modelId: 'x',
    });
    expect(unknown.source).toBe('rules');
    expect(unknown.notes.at(-1)).toMatch(/could not be used/);
  });

  it('applies: a project in the folder, the team renamed and instructed, the run cap set', async () => {
    const proposal: AssistantProposal = await client.assistantPropose({
      prompt: 'Build a booking app with a reviewer, $2 per run.',
    });
    const applied = await client.assistantApply({
      proposal: {
        ...proposal,
        agents: proposal.agents.map((agent) => ({ ...agent, name: `${agent.name} One` })),
      },
      folderPath: '/work/booking',
    });
    expect(applied.project).toMatchObject({
      name: 'Booking app',
      folderPath: '/work/booking',
      maxCostPerRunUsd: 2,
    });
    expect(applied.workflow.projectId).toBe(applied.project.id);
    const graph = await client.getWorkflow(applied.workflow.id);
    expect(
      graph.nodes
        .filter((node) => node.kind === 'agent')
        .map((node) => node.name)
        .sort(),
    ).toEqual(['Builder One', 'Planner One', 'Reviewer One']);
    expect(graph.workflow.version).toBe(applied.workflow.version);
  });

  it('refuses an unwritable folder and creates nothing', async () => {
    const proposal = await client.assistantPropose({ prompt: 'Build a booking app.' });
    const before = db.listProjects().length;
    const refused = await failure(
      client.assistantApply({ proposal, folderPath: '/readonly/booking' }),
    );
    expect(refused).toMatchObject({ status: 400, code: 'invalid_path' });
    expect(db.listProjects()).toHaveLength(before);
  });
});
