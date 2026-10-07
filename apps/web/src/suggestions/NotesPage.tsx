import {
  CreateProjectNoteRequestSchema,
  NOTE_TEXT_MAX,
  UpdateProjectNoteRequestSchema,
  type ProjectNote,
} from '@ace/contracts';
import { Badge, Button, Label, Textarea, cn, toast } from '@ace/ui';
import { BadgeCheck, CircleHelp, NotebookPen, Pencil, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { useProject } from '../projects/hooks';
import { ProjectNav } from '../projects/ProjectNav';
import { timeAgo } from '../tasks/meta';
import {
  useCreateProjectNote,
  useDeleteProjectNote,
  useProjectNotes,
  useUpdateProjectNote,
} from './hooks';
import { NOTE_SOURCE_LABEL } from './meta';

/**
 * `/projects/:projectId/notes` — team notes (ACE parity P2, D281): what everyone working on the
 * project should know. Every plan and work run of the project's tasks gets them in its prompt
 * (engine `notesSection`), oldest first, unverified ones labelled. A note written here is verified;
 * one saved by a task or a chat is unverified until confirmed or corrected — correcting its text
 * confirms it. Forget deletes it.
 */
export function NotesPage() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const notes = useProjectNotes(projectId);
  const remove = useDeleteProjectNote(projectId);
  const [forgetting, setForgetting] = useState<ProjectNote | null>(null);

  const confirmForget = () => {
    if (forgetting === null) return;
    remove.mutate(forgetting.id, {
      onSuccess: () => {
        toast.success('Note forgotten');
        setForgetting(null);
      },
    });
  };

  return (
    <main
      data-testid="notes-page"
      className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto px-4 py-8"
    >
      <ProjectNav projectId={projectId} />
      <header>
        <h1 className="font-human text-2xl font-semibold">Team notes</h1>
        <p className="mt-1 font-human text-sm text-fg-muted">
          What everyone working on {project.data?.name ?? 'this project'} should know. Every plan
          and work run of this project’s tasks gets these notes in its prompt, under “Team notes”,
          oldest first. A note marked unverified is labelled so there, and the agent is told to
          check it before relying on it.
        </p>
      </header>

      <AddNote projectId={projectId} />

      <section aria-labelledby="notes-heading" className="flex flex-col gap-3">
        <h2 id="notes-heading" className="font-human text-lg font-semibold">
          Notes
        </h2>
        {notes.isPending && <p className="text-fg-muted">Loading notes…</p>}
        {notes.isError && (
          <p role="alert" className="text-danger">
            Could not load notes: {notes.error.message}
          </p>
        )}
        {notes.data?.length === 0 && (
          <div
            data-testid="notes-empty"
            className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border p-8 text-center"
          >
            <NotebookPen className="h-6 w-6 text-fg-muted" aria-hidden />
            <p className="max-w-md font-human text-fg-muted">
              No notes yet. Write down what an agent would otherwise have to rediscover: where
              things live, how to run the tests, what not to touch.
            </p>
          </div>
        )}
        {notes.data !== undefined && notes.data.length > 0 && (
          <ul aria-label="Team notes" className="flex flex-col gap-2">
            {notes.data.map((note) => (
              <li key={note.id}>
                <NoteRow note={note} projectId={projectId} onForget={() => setForgetting(note)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {forgetting !== null && (
        <ConfirmDialog
          title="Forget this note?"
          description="It is deleted, and later task runs no longer get it. Runs already going keep the prompt they started with."
          confirmLabel="Forget"
          pending={remove.isPending}
          error={remove.error}
          onConfirm={confirmForget}
          onClose={() => {
            remove.reset();
            setForgetting(null);
          }}
        >
          <blockquote className="whitespace-pre-wrap rounded-field border border-border px-3 py-2 font-human text-sm">
            {forgetting.text}
          </blockquote>
        </ConfirmDialog>
      )}
    </main>
  );
}

function AddNote({ projectId }: { projectId: string }) {
  const create = useCreateProjectNote(projectId);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CreateProjectNoteRequestSchema.safeParse({ text });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(parsed.data, {
      onSuccess: () => {
        setText('');
        toast.success('Note added');
      },
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Add a note"
      className="flex flex-col gap-2 rounded-card border border-border bg-panel p-4"
    >
      <Label htmlFor="new-note">New note</Label>
      <Textarea
        id="new-note"
        rows={3}
        value={text}
        maxLength={NOTE_TEXT_MAX}
        placeholder="e.g. Search lives in src/search.ts; its tests run with npm test."
        aria-invalid={invalid ? true : undefined}
        aria-describedby="new-note-hint"
        onChange={(event) => setText(event.target.value)}
      />
      <p id="new-note-hint" className="text-xs text-fg-muted">
        A note you write is verified. Up to {NOTE_TEXT_MAX.toLocaleString()} characters.
      </p>
      {invalid && (
        <p role="alert" className="text-xs text-danger">
          Write the note first.
        </p>
      )}
      {create.error && (
        <p role="alert" className="text-sm text-danger">
          {create.error.message}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={create.isPending}>
        Add note
      </Button>
    </form>
  );
}

function NoteRow({
  note,
  projectId,
  onForget,
}: {
  note: ProjectNote;
  projectId: string;
  onForget: () => void;
}) {
  const update = useUpdateProjectNote(projectId);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const verified = note.status === 'verified';
  const editId = `note-edit-${note.id}`;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = UpdateProjectNoteRequestSchema.safeParse({ text: draft ?? '' });
    if (!parsed.success || parsed.data.text === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    update.mutate(
      { id: note.id, body: parsed.data },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success('Note saved');
        },
      },
    );
  };

  const mark = () =>
    update.mutate(
      { id: note.id, body: { status: verified ? 'unverified' : 'verified' } },
      {
        onError: (error) => toast.error('Note not saved', { description: error.message }),
      },
    );

  return (
    <article
      data-testid={`note-${note.id}`}
      data-status={note.status}
      aria-label={`${verified ? 'Verified' : 'Unverified'} note`}
      className={cn(
        'flex flex-col gap-2 rounded-card border bg-card px-4 py-3',
        verified ? 'border-border' : 'border-dashed border-[var(--color-status-WAITING)]/60',
      )}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        {verified ? (
          <Badge data-testid="note-status">
            <BadgeCheck className="h-3 w-3" aria-hidden /> Verified
          </Badge>
        ) : (
          <Badge data-testid="note-status" className="text-[var(--color-status-WAITING)]">
            <CircleHelp className="h-3 w-3" aria-hidden /> Unverified
          </Badge>
        )}
        <span className="font-machine text-[10.5px] text-fg-muted">
          {NOTE_SOURCE_LABEL[note.source]} ·{' '}
          <time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>
            {timeAgo(note.updatedAt)}
          </time>
        </span>
      </span>

      {draft === null ? (
        <p className="whitespace-pre-wrap font-human text-sm">{note.text}</p>
      ) : (
        <form onSubmit={save} noValidate className="flex flex-col gap-2">
          <Label htmlFor={editId} className="sr-only">
            Note text
          </Label>
          <Textarea
            id={editId}
            rows={3}
            value={draft}
            maxLength={NOTE_TEXT_MAX}
            autoFocus
            aria-invalid={invalid ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
          {!verified && (
            <p className="text-xs text-fg-muted">Saving a correction also verifies the note.</p>
          )}
          {invalid && (
            <p role="alert" className="text-xs text-danger">
              A note cannot be empty; use Forget to delete it.
            </p>
          )}
          <span className="flex gap-1.5">
            <Button type="submit" size="sm" disabled={update.isPending}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setInvalid(false);
                update.reset();
              }}
            >
              Cancel
            </Button>
          </span>
        </form>
      )}

      {update.error && (
        <p role="alert" className="text-sm text-danger">
          {update.error.message}
        </p>
      )}

      {draft === null && (
        <span className="flex flex-wrap gap-1">
          <Button variant="secondary" size="sm" disabled={update.isPending} onClick={mark}>
            {verified ? 'Mark unverified' : 'Mark verified'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDraft(note.text)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={onForget}>
            <Trash2 className="h-3.5 w-3.5 text-danger" aria-hidden /> Forget
          </Button>
        </span>
      )}
    </article>
  );
}
