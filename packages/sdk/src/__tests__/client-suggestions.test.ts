import type {
  AssistantProposal,
  Project,
  ProjectNote,
  Responsibility,
  Suggestion,
  Task,
  Workflow,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceApiError, createAceClient } from '../index.js';

/**
 * The ACE parity P2 methods: responsibilities and suggestions (D280), team notes (D281), email
 * import (D282) and the Ace Assistant (D283) — each on its route, its body the contract's parse,
 * its reply checked against the contract.
 */

const P = '01K6P2000000000000000000P1';
const R = '01K6P2000000000000000000R1';
const S = '01K6P2000000000000000000S1';
const N = '01K6P2000000000000000000N1';
const T = '01K6P2000000000000000000T1';
const W = '01K6P2000000000000000000W1';
const NOW = '2026-10-07T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown };

/** The recorder of the other client tests: every call kept, replies answered from a queue. */
function recorder(responses: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: body === undefined || body === null ? undefined : JSON.parse(String(body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

const refusal = (status: number, kind: string, code: string) => ({
  status,
  body: { error: { kind, code, message: code, retryable: false } },
});

const responsibility: Responsibility = {
  id: R,
  projectId: P,
  kind: 'software_health',
  title: 'Keep checks green',
  why: 'Broken checks block delivery.',
  goodWork: 'Every check passes.',
  watch: false,
  watchIntervalMinutes: 60,
  paused: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const suggestion: Suggestion = {
  id: S,
  projectId: P,
  responsibilityId: R,
  title: 'Fix the failing "tests" check on task #1',
  reason: 'The "tests" check failed.',
  evidence: [{ kind: 'failed_check', label: 'Check "tests" failed on task #1', taskId: T }],
  proposedAction: 'Make it pass.',
  completionCriteria: 'Every check passes.',
  status: 'new',
  fingerprint: `check:${T}:tests`,
  createdAt: NOW,
  updatedAt: NOW,
};

const note: ProjectNote = {
  id: N,
  projectId: P,
  text: 'Search lives in src/search.ts.',
  status: 'verified',
  source: 'user',
  createdAt: NOW,
  updatedAt: NOW,
};

const task: Task = {
  id: T,
  projectId: P,
  number: 2,
  title: 'Search is slow',
  brief: 'From: Ann <ann@example.com>\n\nIt takes 3 s.',
  type: 'app',
  stage: 'inbox',
  state: 'idle',
  finishLine: 'apply_local',
  automation: 'assisted',
  priority: 'normal',
  labels: [],
  plan: '',
  acceptance: '',
  runChecks: true,
  paused: false,
  source: { kind: 'email', label: 'Ann <ann@example.com>' },
  allowedActions: ['start', 'close', 'delete'],
  createdAt: NOW,
  updatedAt: NOW,
};

const proposal: AssistantProposal = {
  summary: 'Set up Booking app with one builder agent.',
  projectName: 'Booking app',
  team: 'single-builder',
  agents: [{ role: 'builder', name: 'Builder', instructions: 'Make the change.' }],
  notes: [],
  source: 'rules',
};

const project: Project = {
  id: P,
  name: 'Booking app',
  folderPath: 'D:\\ace-projects\\booking',
  createdAt: NOW,
  updatedAt: NOW,
};

const workflow: Workflow = {
  id: W,
  projectId: P,
  name: 'Single builder',
  version: 2,
  formatVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('ACE parity P2 — responsibilities (D280)', () => {
  it('lists, creates, edits, scans, cancels and deletes on their routes', async () => {
    const running: Responsibility = { ...responsibility, lastScanStatus: 'running' };
    const { calls, client } = recorder([
      { body: { items: [responsibility] } },
      { status: 201, body: responsibility },
      { body: { ...responsibility, watch: true, watchIntervalMinutes: 30 } },
      { body: running },
      { body: { ...responsibility, lastScanStatus: 'cancelled', lastScanAt: NOW } },
      { status: 204 },
    ]);

    expect((await client.listResponsibilities(P)).items).toEqual([responsibility]);
    expect(
      await client.createResponsibility(P, {
        kind: 'software_health',
        title: '  Keep checks green  ',
        goodWork: 'Every check passes.',
      }),
    ).toEqual(responsibility);
    expect(
      (await client.updateResponsibility(R, { watch: true, watchIntervalMinutes: 30 })).watch,
    ).toBe(true);
    expect((await client.scanResponsibility(R)).lastScanStatus).toBe('running');
    expect((await client.cancelResponsibilityScan(R)).lastScanStatus).toBe('cancelled');
    await expect(client.deleteResponsibility(R)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      `GET /projects/${P}/responsibilities`,
      `POST /projects/${P}/responsibilities`,
      `PATCH /responsibilities/${R}`,
      `POST /responsibilities/${R}/scan`,
      `POST /responsibilities/${R}/cancel-scan`,
      `DELETE /responsibilities/${R}`,
    ]);
    // The body is the contract's parse: the title is trimmed before it leaves.
    expect(calls[1]!.body).toEqual({
      kind: 'software_health',
      title: 'Keep checks green',
      goodWork: 'Every check passes.',
    });
    expect(calls[2]!.body).toEqual({ watch: true, watchIntervalMinutes: 30 });
    expect(calls[3]!.body).toEqual({});
    expect(calls[4]!.body).toEqual({});
  });

  it('refuses a body the contract refuses, before any request', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.createResponsibility(P, { kind: 'software_health', title: '   ' }),
    ).rejects.toBeInstanceOf(AceApiError);
    // The watch interval is 15 minutes to a day.
    await expect(client.updateResponsibility(R, { watchIntervalMinutes: 5 })).rejects.toMatchObject(
      { code: 'validation_failed' },
    );
    await expect(
      client.createResponsibility(P, {
        kind: 'calendar',
        title: 'x',
      } as unknown as Parameters<typeof client.createResponsibility>[1]),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toEqual([]);
  });

  it('surfaces the scan refusals with their codes', async () => {
    const { client } = recorder([
      refusal(409, 'workflow', 'scan_running'),
      refusal(422, 'invalid_config', 'not_connected'),
    ]);
    await expect(client.scanResponsibility(R)).rejects.toMatchObject({
      status: 409,
      code: 'scan_running',
    });
    await expect(client.scanResponsibility(R)).rejects.toMatchObject({
      status: 422,
      code: 'not_connected',
    });
  });

  it('refuses a reply that is not a responsibility', async () => {
    const { client } = recorder([{ body: { ...responsibility, lastScanStatus: 'paused' } }]);
    await expect(client.scanResponsibility(R)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('ACE parity P2 — suggestions (D280)', () => {
  it('lists with and without a status, and decides on their routes', async () => {
    const accepted: Suggestion = { ...suggestion, status: 'accepted', taskId: T };
    const { calls, client } = recorder([
      { body: { items: [suggestion] } },
      { body: { items: [] } },
      { body: accepted },
      { body: accepted },
      { body: { ...suggestion, status: 'later' } },
      { body: { ...suggestion, status: 'dismissed' } },
    ]);

    expect((await client.listSuggestions(P)).items).toEqual([suggestion]);
    expect((await client.listSuggestions(P, { status: 'later' })).items).toEqual([]);
    expect((await client.acceptSuggestion(S)).taskId).toBe(T);
    expect((await client.acceptSuggestion(S, { workflowId: W })).status).toBe('accepted');
    expect((await client.laterSuggestion(S)).status).toBe('later');
    expect((await client.dismissSuggestion(S)).status).toBe('dismissed');

    expect(paths(calls)).toEqual([
      `GET /projects/${P}/suggestions`,
      `GET /projects/${P}/suggestions?status=later`,
      `POST /suggestions/${S}/accept`,
      `POST /suggestions/${S}/accept`,
      `POST /suggestions/${S}/later`,
      `POST /suggestions/${S}/dismiss`,
    ]);
    expect(calls[2]!.body).toEqual({});
    expect(calls[3]!.body).toEqual({ workflowId: W });
    expect(calls[4]!.body).toEqual({});
    expect(calls[5]!.body).toEqual({});
  });

  it('refuses a status filter or a team id the contract refuses, before any request', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.listSuggestions(P, { status: 'open' } as unknown as { status: 'new' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(client.acceptSuggestion(S, { workflowId: 'team-1' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toEqual([]);
  });

  it('surfaces a decision on a decided suggestion as the engine refusal', async () => {
    const { client } = recorder([refusal(409, 'workflow', 'invalid_task_state')]);
    await expect(client.dismissSuggestion(S)).rejects.toMatchObject({
      status: 409,
      code: 'invalid_task_state',
    });
  });

  it('refuses a reply whose evidence is empty', async () => {
    const { client } = recorder([{ body: { items: [{ ...suggestion, evidence: [] }] } }]);
    await expect(client.listSuggestions(P)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('ACE parity P2 — team notes (D281)', () => {
  it('lists, adds, corrects, confirms and forgets notes on their routes', async () => {
    const { calls, client } = recorder([
      { body: { items: [note] } },
      { status: 201, body: note },
      { body: { ...note, text: 'Search is in src/find.ts.' } },
      { body: { ...note, status: 'unverified' } },
      { status: 204 },
    ]);

    expect((await client.listProjectNotes(P)).items).toEqual([note]);
    expect(await client.createProjectNote(P, { text: ' Search lives in src/search.ts. ' })).toEqual(
      note,
    );
    expect((await client.updateProjectNote(N, { text: 'Search is in src/find.ts.' })).text).toBe(
      'Search is in src/find.ts.',
    );
    expect((await client.updateProjectNote(N, { status: 'unverified' })).status).toBe('unverified');
    await expect(client.deleteProjectNote(N)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      `GET /projects/${P}/notes`,
      `POST /projects/${P}/notes`,
      `PATCH /notes/${N}`,
      `PATCH /notes/${N}`,
      `DELETE /notes/${N}`,
    ]);
    expect(calls[1]!.body).toEqual({ text: 'Search lives in src/search.ts.' });
    expect(calls[3]!.body).toEqual({ status: 'unverified' });
  });

  it('refuses an empty or over-long note before any request', async () => {
    const { calls, client } = recorder([]);
    await expect(client.createProjectNote(P, { text: '  ' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(client.updateProjectNote(N, { text: 'x'.repeat(2_001) })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toEqual([]);
  });
});

describe('ACE parity P2 — email import (D282)', () => {
  it('posts the raw message and the team, and answers the Inbox task', async () => {
    const raw = 'From: Ann <ann@example.com>\r\nSubject: Search is slow\r\n\r\nIt takes 3 s.';
    const { calls, client } = recorder([{ status: 201, body: task }]);
    expect(await client.importEmail(P, { raw, workflowId: W })).toEqual(task);
    expect(paths(calls)).toEqual([`POST /projects/${P}/tasks/import-email`]);
    expect(calls[0]!.body).toEqual({ raw, workflowId: W });
  });

  it('refuses an empty message before any request, and surfaces the engine refusal', async () => {
    const { calls, client } = recorder([refusal(404, 'workflow', 'not_found')]);
    await expect(client.importEmail(P, { raw: '' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toEqual([]);
    await expect(client.importEmail(P, { raw: 'Subject: x\r\n\r\ny' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('ACE parity P2 — the Ace Assistant (D283)', () => {
  it('proposes and applies on their routes', async () => {
    const { calls, client } = recorder([
      { body: proposal },
      { body: { ...proposal, team: 'plan-build-review' } },
      { status: 201, body: { project, workflow } },
    ]);

    expect(await client.assistantPropose({ prompt: ' Build a booking app. ' })).toEqual(proposal);
    expect(
      (await client.assistantPropose({ prompt: 'Add a reviewer.', previous: proposal })).team,
    ).toBe('plan-build-review');
    expect(
      await client.assistantApply({ proposal, folderPath: 'D:\\ace-projects\\booking' }),
    ).toEqual({ project, workflow });

    expect(paths(calls)).toEqual([
      'POST /assistant/propose',
      'POST /assistant/propose',
      'POST /assistant/apply',
    ]);
    expect(calls[0]!.body).toEqual({ prompt: 'Build a booking app.' });
    expect(calls[1]!.body).toEqual({ prompt: 'Add a reviewer.', previous: proposal });
    expect(calls[2]!.body).toEqual({ proposal, folderPath: 'D:\\ace-projects\\booking' });
  });

  it('refuses an empty prompt or a proposal with no agent, before any request', async () => {
    const { calls, client } = recorder([]);
    await expect(client.assistantPropose({ prompt: ' ' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      client.assistantApply({ proposal: { ...proposal, agents: [] } }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toEqual([]);
  });

  it('refuses a reply that does not say who drafted it', async () => {
    const { client } = recorder([{ body: { ...proposal, source: undefined } }]);
    await expect(client.assistantPropose({ prompt: 'x' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
