import type { Part, ProjectNote, TaskExecution, TaskWorkspace } from '@ace/contracts';

import type { TaskRecord } from '../ports/index.js';

/**
 * The Input text a task's runs are given (p0-tasks-build-design.md §3, D268). A task never hands
 * its team a chat history: each run gets one self-contained brief, as every envelope is (BR-02).
 */

const NO_PLAN = 'No written plan.';
const NOT_STATED = 'Not stated.';

function header(task: TaskRecord): string {
  return `# Task #${task.number}: ${task.title}`;
}

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim() === '' ? NOT_STATED : body.trim()}`;
}

type NoteLine = Pick<ProjectNote, 'text' | 'status'>;

/**
 * The project's team notes (D281): what the board knows, the unverified ones labelled so a run does
 * not take an automatic note for a confirmed fact. Empty when there are none.
 */
export function notesSection(notes: readonly NoteLine[] | undefined): string {
  if (notes === undefined || notes.length === 0) return '';
  const lines = notes.map((note) =>
    note.status === 'verified' ? `- ${note.text}` : `- (unverified) ${note.text}`,
  );
  return [
    '## Team notes',
    'Shared notes for this project. Lines marked (unverified) were saved automatically; check them ' +
      'before relying on them.',
    ...lines,
  ].join('\n');
}

/** What a planner run is asked. */
export function planPrompt(task: TaskRecord, notes?: readonly NoteLine[]): string {
  return [
    header(task),
    task.brief.trim(),
    section('How the result will be checked', task.acceptance),
    notesSection(notes),
    '## What to do\nWrite a step-by-step plan for this task: the changes to make, where, and how to ' +
      'check them. Do not change any files.',
  ]
    .filter((block) => block !== '')
    .join('\n\n');
}

/** What a work run is asked: the first one, or a follow-up carrying a correction. */
export function workPrompt(input: {
  task: TaskRecord;
  workspace: TaskWorkspace | null;
  request: string | undefined;
  previous: TaskExecution | undefined;
  /** What a Document or Email task must produce (D275); absent for an App task. */
  produce?: string | undefined;
  /** The project's team notes (D281). */
  notes?: readonly NoteLine[] | undefined;
}): string {
  const { task, workspace, request, previous, produce, notes } = input;
  const blocks = [
    header(task),
    task.brief.trim(),
    `## Plan\n${task.plan.trim() === '' ? NO_PLAN : task.plan.trim()}`,
    section('How the result will be checked', task.acceptance),
    notesSection(notes),
  ];
  if (workspace !== null) {
    blocks.push(
      '## Where to work\n' +
        `You are working in an isolated Git worktree of the project, on branch ${workspace.branch} ` +
        `(from ${workspace.baseBranch}). Make your changes in this folder. Do not commit, push or ` +
        'switch branches — ACE records your changes and the user reviews them before anything ' +
        `reaches ${workspace.baseBranch}.`,
    );
  }
  if (request !== undefined && request.trim() !== '') {
    blocks.push(`## Requested changes\n${request.trim()}`);
  }
  if (produce !== undefined) {
    blocks.push(produce);
  }
  if (previous?.summary !== undefined && previous.summary.trim() !== '') {
    blocks.push(`## Your previous summary\n${previous.summary.trim()}`);
  }
  return blocks.filter((block) => block !== '').join('\n\n');
}

/**
 * The text a run ended with: every Output node's parts, text as it is, JSON and code rendered, media
 * named. What a plan run writes into the plan and what a work execution keeps as its summary.
 */
export function outputText(finalOutput: Record<string, Part[]> | undefined): string {
  if (finalOutput === undefined) return '';
  const pieces: string[] = [];
  for (const parts of Object.values(finalOutput)) {
    for (const part of parts) {
      switch (part.type) {
        case 'text':
          pieces.push(part.text);
          break;
        case 'json':
          pieces.push('```json\n' + JSON.stringify(part.value, null, 2) + '\n```');
          break;
        case 'code':
          pieces.push('```' + part.language + '\n' + part.text + '\n```');
          break;
        default:
          pieces.push(`[${part.type}]`);
      }
    }
  }
  return pieces.join('\n\n').trim();
}

/** `ace/task-<n>-<slug>`: lowercase letters, digits and dashes, the slug at most 40 characters. */
export function branchName(task: Pick<TaskRecord, 'number' | 'title'>): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? `ace/task-${task.number}` : `ace/task-${task.number}-${slug}`;
}
