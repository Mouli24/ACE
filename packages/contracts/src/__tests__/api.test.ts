import { describe, expect, it } from 'vitest';

import {
  API_BASE_PATH,
  CreateProjectRequestSchema,
  CreateWorkflowRequestSchema,
  CursorQuerySchema,
  DEFAULT_ENGINE_ORIGIN,
  DEFAULT_ENGINE_PORT,
  DEFAULT_PAGE_LIMIT,
  HealthResponseSchema,
  UpdateProjectRequestSchema,
  UpdateWorkflowRequestSchema,
  ValidateWorkflowResponseSchema,
  WorkflowGraphResponseSchema,
  pageSchema,
} from '../api.js';
import { ProjectSchema } from '../graph.js';
import { NOW, PROJECT_ID, WORKFLOW_ID } from './fixtures.js';

describe('TC-SYS-005 Health check', () => {
  it('is exactly { status: ok, version, db: ok }', () => {
    const body = { status: 'ok', version: '0.1.0', db: 'ok' };

    expect(HealthResponseSchema.parse(body)).toEqual(body);
  });

  it.each([
    ['a status other than ok', { status: 'degraded', version: '0.1.0', db: 'ok' }],
    ['a db other than ok', { status: 'ok', version: '0.1.0', db: 'down' }],
    ['a missing version', { status: 'ok', db: 'ok' }],
  ])('rejects %s', (_label, body) => {
    expect(HealthResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('FR-SYS-004 engine address constants', () => {
  it('matches round 1 §2.1 and §2.8', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
    expect(DEFAULT_ENGINE_PORT).toBe(4747);
    expect(DEFAULT_ENGINE_ORIGIN).toBe('http://127.0.0.1:4747');
  });
});

describe('FR-WF-003 cursor pagination', () => {
  it('defaults the limit to 50', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('accepts a cursor and an explicit limit', () => {
    expect(CursorQuerySchema.parse({ cursor: 'abc', limit: 10 })).toEqual({
      cursor: 'abc',
      limit: 10,
    });
  });

  it('reads a limit that arrived as a query string', () => {
    expect(CursorQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it.each([0, -1, 1.5])('rejects limit %s', (limit) => {
    expect(CursorQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('wraps any item schema as { items, nextCursor? }', () => {
    const schema = pageSchema(ProjectSchema);
    const project = {
      id: PROJECT_ID,
      name: 'Demo',
      folderPath: 'D:/demo',
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(schema.parse({ items: [project] })).toEqual({ items: [project] });
    expect(schema.parse({ items: [], nextCursor: 'next' })).toEqual({
      items: [],
      nextCursor: 'next',
    });
    expect(schema.safeParse({ items: [{ id: 'nope' }] }).success).toBe(false);
  });
});

describe('FR-PRJ-001 project request bodies', () => {
  it('creates with a name and an optional folderPath', () => {
    expect(CreateProjectRequestSchema.parse({ name: 'Demo' })).toEqual({ name: 'Demo' });
    expect(CreateProjectRequestSchema.parse({ name: 'Demo', folderPath: 'D:/demo' })).toEqual({
      name: 'Demo',
      folderPath: 'D:/demo',
    });
  });

  it.each([
    ['an empty name', ''],
    ['a name over 120 chars', 'x'.repeat(121)],
  ])('rejects %s', (_label, name) => {
    expect(CreateProjectRequestSchema.safeParse({ name }).success).toBe(false);
  });

  it('requires a name on create but not on update', () => {
    expect(CreateProjectRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({}).success).toBe(true);
    expect(UpdateProjectRequestSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });
});

describe('FR-WF-001 workflow request bodies', () => {
  it('requires a name on create but not on update', () => {
    expect(CreateWorkflowRequestSchema.safeParse({}).success).toBe(false);
    expect(CreateWorkflowRequestSchema.parse({ name: 'Flow 1' })).toEqual({ name: 'Flow 1' });
    expect(UpdateWorkflowRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('FR-WF-003 workflow graph response', () => {
  const workflow = {
    id: WORKFLOW_ID,
    projectId: PROJECT_ID,
    name: 'Flow 1',
    version: 3,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('is { workflow, nodes, edges }', () => {
    const body = { workflow, nodes: [], edges: [] };

    expect(WorkflowGraphResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a response without the workflow', () => {
    expect(WorkflowGraphResponseSchema.safeParse({ nodes: [], edges: [] }).success).toBe(false);
  });
});

describe('FR-WF-006 validate response', () => {
  it('is { issues }', () => {
    const body = {
      issues: [{ severity: 'warning', code: 'missing_model', message: 'pick a model' }],
    };

    expect(ValidateWorkflowResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts an empty issue list', () => {
    expect(ValidateWorkflowResponseSchema.parse({ issues: [] })).toEqual({ issues: [] });
  });
});
