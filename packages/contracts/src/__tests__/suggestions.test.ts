import { describe, expect, it } from 'vitest';

import { EngineEventSchema } from '../events.js';
import {
  CreateResponsibilityRequestSchema,
  ImportEmailRequestSchema,
  ProjectNoteSchema,
  SuggestionSchema,
  UpdateResponsibilityRequestSchema,
} from '../suggestions.js';
import { NOW, PROJECT_ID } from './fixtures.js';

const RESP_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RSP1';
const SUGG_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0SGG1';

describe('ACE parity P2 — responsibilities and suggestions', () => {
  it('takes a responsibility with a watch interval inside its bounds', () => {
    expect(
      CreateResponsibilityRequestSchema.safeParse({
        kind: 'software_health',
        title: 'Keep main green',
      }).success,
    ).toBe(true);
    expect(
      CreateResponsibilityRequestSchema.safeParse({
        kind: 'software_health',
        title: 'x',
        watchIntervalMinutes: 5,
      }).success,
    ).toBe(false);
    expect(UpdateResponsibilityRequestSchema.safeParse({ paused: true }).success).toBe(true);
  });

  it('needs evidence on a suggestion and keeps its fingerprint', () => {
    const suggestion = {
      id: SUGG_ID,
      projectId: PROJECT_ID,
      responsibilityId: RESP_ID,
      title: 'Fix the failing tests check',
      reason: 'The tests check failed on task #4.',
      evidence: [{ kind: 'failed_check', label: 'Check tests failed on #4', detail: '1 failed' }],
      proposedAction: 'Make the tests pass again.',
      completionCriteria: 'pnpm test passes.',
      status: 'new',
      fingerprint: 'check:task4:tests',
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(SuggestionSchema.safeParse(suggestion).success).toBe(true);
    expect(SuggestionSchema.safeParse({ ...suggestion, evidence: [] }).success).toBe(false);
    expect(
      SuggestionSchema.safeParse({
        ...suggestion,
        evidence: [
          { kind: 'github_issue', label: 'Issue #12', url: 'https://github.com/a/b/issues/12' },
        ],
      }).success,
    ).toBe(true);
  });

  it('tells the client which project list changed', () => {
    expect(
      EngineEventSchema.safeParse({
        type: 'project.changed',
        payload: { projectId: PROJECT_ID, what: 'suggestions' },
        seq: 4,
      }).success,
    ).toBe(true);
  });
});

describe('ACE parity P2 — notes and email import', () => {
  it('parses a verified and an unverified note', () => {
    for (const status of ['verified', 'unverified'] as const) {
      expect(
        ProjectNoteSchema.safeParse({
          id: SUGG_ID,
          projectId: PROJECT_ID,
          text: 'Deploys go out on Tuesdays.',
          status,
          source: 'user',
          createdAt: NOW,
          updatedAt: NOW,
        }).success,
      ).toBe(true);
    }
  });

  it('takes a raw message to import', () => {
    expect(ImportEmailRequestSchema.safeParse({ raw: 'From: a@b.c\r\n\r\nhi' }).success).toBe(true);
    expect(ImportEmailRequestSchema.safeParse({ raw: '' }).success).toBe(false);
  });
});
