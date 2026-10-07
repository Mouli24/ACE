import {
  DOCUMENT_CONTENT_MAX,
  EMAIL_BODY_MAX,
  EmailAddressSchema,
  ProjectRelativePathSchema,
  TaskDeliverableSchema,
  type Task,
  type TaskDeliverable,
} from '@ace/contracts';
import { Button, Input, Label, Markdown, Textarea, toast } from '@ace/ui';
import { useState } from 'react';

import { FieldError } from '../knowledge/fields';
import { usePutDeliverable } from './hooks';
import { parseAddresses } from './meta';

/**
 * The Draft (ACE parity P1, D275): what a Document or Email task's run wrote, edited before it is
 * accepted — a document's file and Markdown (with a rendered preview), an email's recipients,
 * subject and body — and saved whole through `PUT /tasks/:id/deliverable`. The engine refuses an
 * edit while a run is going or once the task is Done, so the editor is read-only then.
 */
export function TaskDraft({ task }: { task: Task }) {
  const deliverable = task.deliverable;
  if (deliverable === undefined) return null;
  const editable = task.stage !== 'done' && task.state !== 'running' && task.state !== 'waiting';
  const note =
    task.stage === 'done'
      ? 'The task is Done: this is the draft as it was accepted.'
      : editable
        ? undefined
        : 'The team is working on the draft; it can be edited once the run is over.';
  // a new draft from the engine (a run, or our own save) starts the form over
  const key = JSON.stringify(deliverable);
  return (
    <section
      aria-labelledby={`draft-${task.id}`}
      data-testid="task-draft"
      className="flex flex-col gap-3 rounded-card border border-border bg-panel p-4"
    >
      <h2 id={`draft-${task.id}`} className="font-human text-base font-semibold">
        Draft
      </h2>
      {note !== undefined && <p className="text-xs text-fg-muted">{note}</p>}
      {deliverable.kind === 'document' ? (
        <DocumentDraft key={key} task={task} draft={deliverable} editable={editable} />
      ) : (
        <EmailDraft key={key} task={task} draft={deliverable} editable={editable} />
      )}
    </section>
  );
}

type DocumentDeliverable = Extract<TaskDeliverable, { kind: 'document' }>;
type EmailDeliverable = Extract<TaskDeliverable, { kind: 'email' }>;

/** Saves the draft whole; what the contract refuses is said, never silently dropped. */
function useSaveDraft(task: Task) {
  const put = usePutDeliverable(task.id);
  const [invalid, setInvalid] = useState<Error | null>(null);
  const save = (deliverable: TaskDeliverable) => {
    const parsed = TaskDeliverableSchema.safeParse(deliverable);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setInvalid(new Error(`${issue?.path.join('.') ?? 'draft'}: ${issue?.message ?? 'invalid'}`));
      return;
    }
    setInvalid(null);
    put.mutate(parsed.data, { onSuccess: () => toast.success('Draft saved') });
  };
  return { save, pending: put.isPending, error: invalid ?? put.error };
}

function SaveRow({
  disabled,
  pending,
  error,
  onSave,
}: {
  disabled: boolean;
  pending: boolean;
  error: Error | null;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-danger">
          Draft not saved: {error.message}
        </p>
      )}
      <Button size="sm" className="self-start" disabled={disabled || pending} onClick={onSave}>
        Save draft
      </Button>
    </div>
  );
}

function DocumentDraft({
  task,
  draft,
  editable,
}: {
  task: Task;
  draft: DocumentDeliverable;
  editable: boolean;
}) {
  const { save, pending, error } = useSaveDraft(task);
  const [path, setPath] = useState(draft.path);
  const [content, setContent] = useState(draft.content);
  const [preview, setPreview] = useState(false);
  const [pathError, setPathError] = useState<string>();
  const dirty = path !== draft.path || content !== draft.content;

  const submit = () => {
    const parsed = ProjectRelativePathSchema.safeParse(path);
    if (!parsed.success) {
      setPathError(parsed.error.issues[0]?.message ?? 'Not a path inside the project folder.');
      return;
    }
    setPathError(undefined);
    save({ kind: 'document', path: parsed.data, content });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`draft-path-${task.id}`}>Save as</Label>
        <Input
          id={`draft-path-${task.id}`}
          value={path}
          disabled={!editable}
          className="font-machine"
          aria-invalid={pathError ? true : undefined}
          onChange={(event) => setPath(event.target.value)}
        />
        <FieldError id={`draft-path-${task.id}-error`} message={pathError} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`draft-content-${task.id}`}>Document</Label>
          <div className="flex gap-1" role="group" aria-label="Document view">
            <Button
              size="sm"
              variant={preview ? 'ghost' : 'secondary'}
              aria-pressed={!preview}
              onClick={() => setPreview(false)}
            >
              Markdown
            </Button>
            <Button
              size="sm"
              variant={preview ? 'secondary' : 'ghost'}
              aria-pressed={preview}
              onClick={() => setPreview(true)}
            >
              Preview
            </Button>
          </div>
        </div>
        {preview ? (
          <div
            data-testid="draft-preview"
            className="min-h-[8rem] rounded-field border border-border bg-canvas px-4 py-3"
          >
            {content.trim() === '' ? (
              <p className="text-sm text-fg-muted">Nothing written yet.</p>
            ) : (
              <Markdown text={content} className="font-human text-sm" />
            )}
          </div>
        ) : (
          <Textarea
            id={`draft-content-${task.id}`}
            rows={12}
            value={content}
            maxLength={DOCUMENT_CONTENT_MAX}
            disabled={!editable}
            placeholder="The team writes the document when work runs. You can write or edit it here too."
            className="font-machine text-xs"
            onChange={(event) => setContent(event.target.value)}
          />
        )}
      </div>
      <SaveRow disabled={!editable || !dirty} pending={pending} error={error} onSave={submit} />
    </div>
  );
}

function EmailDraft({
  task,
  draft,
  editable,
}: {
  task: Task;
  draft: EmailDeliverable;
  editable: boolean;
}) {
  const { save, pending, error } = useSaveDraft(task);
  const [to, setTo] = useState(draft.to.join(', '));
  const [cc, setCc] = useState(draft.cc.join(', '));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [errors, setErrors] = useState<{ to?: string; cc?: string }>({});
  const dirty =
    to !== draft.to.join(', ') ||
    cc !== draft.cc.join(', ') ||
    subject !== draft.subject ||
    body !== draft.body;

  const addressError = (raw: string): string | undefined => {
    const bad = parseAddresses(raw).filter((each) => !EmailAddressSchema.safeParse(each).success);
    return bad.length === 0 ? undefined : `Not an email address: ${bad.join(', ')}.`;
  };

  const submit = () => {
    const next = { to: addressError(to), cc: addressError(cc) };
    setErrors(next);
    if (next.to !== undefined || next.cc !== undefined) return;
    save({ kind: 'email', to: parseAddresses(to), cc: parseAddresses(cc), subject, body });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`draft-to-${task.id}`}>To</Label>
          <Input
            id={`draft-to-${task.id}`}
            value={to}
            disabled={!editable}
            aria-invalid={errors.to ? true : undefined}
            onChange={(event) => setTo(event.target.value)}
          />
          <FieldError id={`draft-to-${task.id}-error`} message={errors.to} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`draft-cc-${task.id}`}>Cc</Label>
          <Input
            id={`draft-cc-${task.id}`}
            value={cc}
            disabled={!editable}
            aria-invalid={errors.cc ? true : undefined}
            onChange={(event) => setCc(event.target.value)}
          />
          <FieldError id={`draft-cc-${task.id}-error`} message={errors.cc} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`draft-subject-${task.id}`}>Subject</Label>
        <Input
          id={`draft-subject-${task.id}`}
          value={subject}
          maxLength={400}
          disabled={!editable}
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`draft-body-${task.id}`}>Body</Label>
        <Textarea
          id={`draft-body-${task.id}`}
          rows={10}
          value={body}
          maxLength={EMAIL_BODY_MAX}
          disabled={!editable}
          placeholder="The team writes the email when work runs."
          className="font-human"
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <SaveRow disabled={!editable || !dirty} pending={pending} error={error} onSave={submit} />
    </div>
  );
}
