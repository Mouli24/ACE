import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type {
  AcceptTaskRequest,
  CreateTaskRequest,
  PutDeliverableRequest,
  Task,
  TaskDeliverable,
  TaskType,
} from '@ace/contracts';
import { DOCUMENT_CONTENT_MAX, EMAIL_BODY_MAX } from '@ace/contracts';

import { HttpError } from '../gateway/errors.js';
import type { TaskRecord } from '../ports/index.js';
import type { TaskKernel } from './kernel.js';

/**
 * Document and Email deliverables (ACE parity P1, D275). A Document task's work run writes its
 * Markdown; an Email task's writes the message body. Review may edit either. Accept writes a
 * document into the project folder — never over an existing file — or accepts an email draft; Send
 * needs a mail connection this version does not have, and says so rather than pretending.
 */

/** The file operations Accept needs, so tests can run it without touching a real folder. */
export interface DeliverableFiles {
  exists(path: string): Promise<boolean>;
  /** Writes the file, creating its parent folders. */
  write(path: string, content: string): Promise<void>;
  /**
   * Whether `path`, once the symbolic links of its existing ancestors are resolved, is still inside
   * `root` — a link inside the project must not carry a document out of it.
   */
  inside(root: string, path: string): Promise<boolean>;
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export function createNodeDeliverableFiles(): DeliverableFiles {
  return {
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async write(path, content) {
      await mkdir(dirname(path), { recursive: true });
      // `wx`: fail rather than overwrite if a file appeared since the existence check.
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    },
    async inside(root, path) {
      const realRoot = await realpath(root);
      const existing = await realpath(await nearestExisting(path));
      const rest = relative(await nearestExisting(path), path);
      const target = resolve(existing, rest);
      const fromRoot = relative(realRoot, target);
      return fromRoot !== '' && !fromRoot.startsWith(`..${sep}`) && fromRoot !== '..';
    },
  };
}

/** The empty deliverable a new Document or Email task starts with. */
export function initialDeliverable(
  type: TaskType,
  body: Pick<CreateTaskRequest, 'documentPath' | 'emailTo' | 'title'>,
): TaskDeliverable | undefined {
  if (type === 'document' && body.documentPath !== undefined) {
    return { kind: 'document', path: body.documentPath, content: '' };
  }
  if (type === 'email') {
    return { kind: 'email', to: body.emailTo ?? [], cc: [], subject: body.title, body: '' };
  }
  return undefined;
}

/** What a Document or Email task's work run is told to produce, appended to its prompt. */
export function deliverableInstructions(task: TaskRecord): string | undefined {
  const deliverable = task.deliverable;
  if (deliverable === undefined) return undefined;
  if (deliverable.kind === 'document') {
    return [
      '## What to produce',
      `Write the complete Markdown document that will be saved as \`${deliverable.path}\` in the ` +
        'project. Answer with the document only — no preamble, no closing remarks.',
      deliverable.content.trim() === ''
        ? ''
        : `The current draft, to revise:\n\n${deliverable.content.trim()}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }
  const to = deliverable.to.length === 0 ? 'the recipient' : deliverable.to.join(', ');
  return [
    '## What to produce',
    `Write the email to ${to} with the subject "${deliverable.subject}". Answer with the message ` +
      'body only. The user reviews it before anything is sent.',
    deliverable.body.trim() === ''
      ? ''
      : `The current draft, to revise:\n\n${deliverable.body.trim()}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The deliverable a completed work run produced from its output text. */
export function deliverableFromOutput(task: TaskRecord, text: string): TaskDeliverable | undefined {
  const deliverable = task.deliverable;
  if (deliverable === undefined) return undefined;
  if (deliverable.kind === 'document') {
    return { ...deliverable, content: text.slice(0, DOCUMENT_CONTENT_MAX) };
  }
  // A model that answers "Subject: …" on its first line has proposed a subject; keep it.
  const subjectLine = /^subject:\s*(.+)\r?\n+/i.exec(text);
  const body = (subjectLine === null ? text : text.slice(subjectLine[0].length)).slice(
    0,
    EMAIL_BODY_MAX,
  );
  return {
    ...deliverable,
    ...(subjectLine?.[1] === undefined ? {} : { subject: subjectLine[1].trim() }),
    body,
  };
}

/** `PUT /tasks/:id/deliverable` — the user's edit of the draft. */
export async function putDeliverable(
  kernel: TaskKernel,
  id: string,
  body: PutDeliverableRequest,
): Promise<Task> {
  return kernel.withLock(id, async () => {
    const task = await kernel.load(id);
    if (task.deliverable === undefined || task.deliverable.kind !== body.deliverable.kind) {
      throw new HttpError(
        'invalid_config',
        'validation_failed',
        `Task #${task.number} has no ${body.deliverable.kind} to edit.`,
      );
    }
    if (task.stage === 'done' || task.state === 'running' || task.state === 'waiting') {
      throw new HttpError(
        'workflow',
        'invalid_task_state',
        `Task #${task.number} is ${task.stage} / ${task.state}; its draft cannot be edited now.`,
      );
    }
    return kernel.commit(kernel.set(task, { deliverable: body.deliverable }), {
      kind: 'edited',
      message: body.deliverable.kind === 'document' ? 'Document edited.' : 'Email draft edited.',
    });
  });
}

/** `POST /tasks/:id/accept` — the Document or Email finish line (D275). */
export async function acceptDeliverable(
  kernel: TaskKernel,
  files: DeliverableFiles,
  id: string,
  body: AcceptTaskRequest,
): Promise<Task> {
  return kernel.withLock(id, async () => {
    const task = await kernel.load(id);
    await kernel.assertAllowed(task, 'accept', 'be accepted');
    const deliverable = task.deliverable;
    if (deliverable === undefined) {
      throw new HttpError(
        'workflow',
        'invalid_task_state',
        `Task #${task.number} has nothing to accept.`,
      );
    }
    const at = kernel.now();

    if (deliverable.kind === 'email') {
      const destination =
        deliverable.to.length === 0 ? 'no recipient yet' : deliverable.to.join(', ');
      await kernel.repos().deliveries.create(kernel.scope, {
        id: kernel.nextId(),
        taskId: id,
        kind: 'email_accept',
        status: 'succeeded',
        destination,
        detail: `Draft accepted: "${deliverable.subject}". It was not sent.`,
        at,
      });
      return kernel.commit(
        kernel.set(kernel.moveTo(task, 'done', 'done'), { outcome: 'accepted', completedAt: at }),
        { kind: 'delivered', message: `Email draft accepted for ${destination}.` },
      );
    }

    if (body.path !== undefined && body.path !== deliverable.path) {
      throw new HttpError(
        'workflow',
        'destination_changed',
        `The document is now set to be saved as ${deliverable.path}, not ${body.path}. Check it and accept again.`,
        { path: deliverable.path },
      );
    }
    const project = await kernel.loadProject(task.projectId);
    const target = join(project.folderPath, ...deliverable.path.split('/'));
    if (!(await files.inside(project.folderPath, target))) {
      throw new HttpError(
        'invalid_config',
        'invalid_path',
        `${deliverable.path} resolves outside the project folder.`,
        { path: deliverable.path },
      );
    }
    if (await files.exists(target)) {
      throw new HttpError(
        'workflow',
        'file_exists',
        `${deliverable.path} already exists in the project folder; ACE never overwrites a file on accept. Choose another path.`,
        { path: deliverable.path },
      );
    }
    try {
      await files.write(target, deliverable.content);
    } catch (error) {
      const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
      throw new HttpError(
        'workflow',
        exists ? 'file_exists' : 'delivery_failed',
        exists
          ? `${deliverable.path} appeared in the project folder meanwhile; it was not overwritten.`
          : `The document could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await kernel.repos().deliveries.create(kernel.scope, {
      id: kernel.nextId(),
      taskId: id,
      kind: 'document_accept',
      status: 'succeeded',
      destination: target,
      at,
    });
    return kernel.commit(
      kernel.set(kernel.moveTo(task, 'done', 'done'), { outcome: 'accepted', completedAt: at }),
      { kind: 'delivered', message: `Document accepted as ${deliverable.path}.` },
    );
  });
}

/** `POST /tasks/:id/send` — no mail connection exists yet (D275); never a pretend send. */
export async function sendDeliverable(kernel: TaskKernel, id: string): Promise<Task> {
  const task = await kernel.load(id);
  await kernel.assertAllowed(task, 'send', 'be sent');
  throw new HttpError(
    'invalid_config',
    'not_connected',
    'Sending needs an email connection, which this version of ACE does not have. Accept the draft and send it from your mail app.',
  );
}
