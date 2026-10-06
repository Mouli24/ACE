import { describe, expect, it } from 'vitest';

import { CloneProjectRequestSchema, UpdateProjectRequestSchema } from '../api.js';
import {
  BundleFileSchema,
  CreateSecretRequestSchema,
  CreateSkillRequestSchema,
  SecretSchema,
  SkillSchema,
} from '../capabilities.js';
import { RunSnapshotSchema } from '../runs.js';
import {
  AcceptTaskRequestSchema,
  CreateTaskRequestSchema,
  MergePullRequestRequestSchema,
  ProjectRelativePathSchema,
  PutTaskScheduleRequestSchema,
  TaskDeliverableSchema,
  TaskPreviewSchema,
} from '../tasks.js';
import { NOW, PROJECT_ID } from './fixtures.js';

const SKILL_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0SK11';

describe('ACE parity P1 — skills and bundles', () => {
  it('parses a skill and a create request', () => {
    expect(
      SkillSchema.safeParse({
        id: SKILL_ID,
        name: 'Write tests first',
        description: 'TDD',
        instructions: 'Write a failing test before the code.',
        version: 1,
        source: 'user',
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(CreateSkillRequestSchema.safeParse({ name: 'x', instructions: '  ' }).success).toBe(
      false,
    );
  });

  it('freezes skills into a run snapshot, and reads a snapshot without them', () => {
    expect(RunSnapshotSchema.safeParse({ version: 1, nodes: [], edges: [] }).success).toBe(true);
    expect(
      RunSnapshotSchema.safeParse({
        version: 1,
        nodes: [],
        edges: [],
        skills: [{ id: SKILL_ID, name: 'TDD', version: 2, instructions: 'Test first.' }],
      }).success,
    ).toBe(true);
  });

  it('reads a bundle file with skills and plugin definitions', () => {
    expect(
      BundleFileSchema.safeParse({
        format: 'ace-bundle',
        formatVersion: 1,
        name: 'Web app kit',
        skills: [{ name: 'Accessibility', instructions: 'Check contrast.' }],
        mcpServers: [{ name: 'files', transport: 'stdio', command: 'npx', args: ['mcp-files'] }],
      }).success,
    ).toBe(true);
    expect(
      BundleFileSchema.safeParse({ format: 'zip', formatVersion: 1, name: 'x', skills: [] })
        .success,
    ).toBe(false);
  });
});

describe('ACE parity P1 — secrets', () => {
  it('takes an environment-variable name and refuses reserved ones', () => {
    expect(CreateSecretRequestSchema.safeParse({ name: 'STRIPE_KEY', value: 'v' }).success).toBe(
      true,
    );
    expect(CreateSecretRequestSchema.safeParse({ name: 'stripe_key', value: 'v' }).success).toBe(
      false,
    );
    expect(CreateSecretRequestSchema.safeParse({ name: 'PATH', value: 'v' }).success).toBe(false);
  });

  it('never carries a value in the shape the API returns', () => {
    const secret = {
      name: 'API_TOKEN',
      description: '',
      projectIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(SecretSchema.safeParse(secret).success).toBe(true);
    expect(SecretSchema.safeParse({ ...secret, value: 'x' }).success).toBe(false);
  });
});

describe('ACE parity P1 — documents, email, schedules, GitHub, preview', () => {
  it('keeps a document path inside the project folder', () => {
    expect(ProjectRelativePathSchema.safeParse('docs/notes.md').success).toBe(true);
    for (const bad of ['../x.md', '/etc/x', 'C:/x.md', 'docs\\x.md', '.git/config', 'a//b.md']) {
      expect(ProjectRelativePathSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('needs a destination for a document task, and no start-now for a scheduled one', () => {
    expect(CreateTaskRequestSchema.safeParse({ title: 'Doc', type: 'document' }).success).toBe(
      false,
    );
    expect(
      CreateTaskRequestSchema.safeParse({
        title: 'Doc',
        type: 'document',
        documentPath: 'docs/a.md',
        finishLine: 'accept_document',
      }).success,
    ).toBe(true);
    expect(
      CreateTaskRequestSchema.safeParse({
        title: 'x',
        start: 'now',
        trigger: { kind: 'once', at: NOW },
      }).success,
    ).toBe(false);
  });

  it('parses document and email deliverables', () => {
    expect(
      TaskDeliverableSchema.safeParse({ kind: 'document', path: 'a.md', content: '# A' }).success,
    ).toBe(true);
    expect(
      TaskDeliverableSchema.safeParse({
        kind: 'email',
        to: ['ann@example.com'],
        cc: [],
        subject: 'Hi',
        body: 'Hello',
      }).success,
    ).toBe(true);
    expect(
      TaskDeliverableSchema.safeParse({
        kind: 'email',
        to: ['nope'],
        cc: [],
        subject: '',
        body: '',
      }).success,
    ).toBe(false);
    expect(AcceptTaskRequestSchema.safeParse({ path: 'notes.md' }).success).toBe(true);
  });

  it('parses the three triggers and refuses a cron with the wrong field count', () => {
    for (const trigger of [
      { kind: 'once', at: NOW },
      { kind: 'recurring', cron: '0 9 * * 1-5', timezone: 'Europe/London' },
      { kind: 'after_task', taskId: SKILL_ID },
    ]) {
      expect(PutTaskScheduleRequestSchema.safeParse({ trigger }).success, trigger.kind).toBe(true);
    }
    expect(
      PutTaskScheduleRequestSchema.safeParse({
        trigger: { kind: 'recurring', cron: '0 9 * *', timezone: 'UTC' },
      }).success,
    ).toBe(false);
  });

  it('makes a GitHub merge repeat the repository and base', () => {
    expect(MergePullRequestRequestSchema.safeParse({ method: 'squash' }).success).toBe(false);
    expect(
      MergePullRequestRequestSchema.safeParse({
        method: 'squash',
        confirm: { repo: 'acme/shop', base: 'main' },
      }).success,
    ).toBe(true);
    expect(CloneProjectRequestSchema.safeParse({ repo: 'acme/shop' }).success).toBe(true);
  });

  it('parses a preview and the project preview settings', () => {
    expect(
      TaskPreviewSchema.safeParse({
        taskId: SKILL_ID,
        status: 'running',
        command: 'pnpm dev',
        url: 'http://localhost:5199',
        port: 5199,
        output: 'ready',
      }).success,
    ).toBe(true);
    expect(
      UpdateProjectRequestSchema.safeParse({ previewCommand: 'pnpm dev', previewUrl: null })
        .success,
    ).toBe(true);
    expect(PROJECT_ID).toBeTruthy();
  });
});
