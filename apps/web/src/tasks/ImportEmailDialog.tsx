import {
  EMAIL_IMPORT_MAX,
  ImportEmailRequestSchema,
  type Id,
  type ImportEmailRequest,
  type Task,
  type Workflow,
} from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
  toast,
} from '@ace/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';

import { api } from '../app/api';
import { selectClass } from '../knowledge/fields';
import { taskKeys } from './keys';
import { writeTask } from './task-cache';

const NO_WORKFLOW = '';

/** `File.text()`, with FileReader where a host lacks it (jsdom does). */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/** `POST /projects/:id/tasks/import-email` — one message into the Inbox; nothing starts (D282). */
export function useImportEmail(projectId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportEmailRequest): Promise<Task> => api().importEmail(projectId, body),
    onSuccess: (task) => {
      writeTask(queryClient, task);
      void queryClient.invalidateQueries({ queryKey: taskKeys.lists(projectId) });
    },
  });
}

/** The board's *Import email* button and the dialog it opens. */
export function ImportEmailButton({
  projectId,
  workflows,
  className,
}: {
  projectId: Id;
  workflows: readonly Workflow[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" className={className} onClick={() => setOpen(true)}>
        <Mail className="h-4 w-4" aria-hidden /> Import email
      </Button>
      {open && (
        <ImportEmailDialog
          projectId={projectId}
          workflows={workflows}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Import an email (ACE parity P2, D282): paste the message as an `.eml` file holds it — headers,
 * a blank line, the body — or pick the file. The engine keeps From, To, Subject, Date and the text
 * body, drops attachments, and saves it to the Inbox as a task; it never starts an agent.
 */
export function ImportEmailDialog({
  projectId,
  workflows,
  onClose,
}: {
  projectId: Id;
  workflows: readonly Workflow[];
  onClose: () => void;
}) {
  const importEmail = useImportEmail(projectId);
  const [raw, setRaw] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  const [workflowId, setWorkflowId] = useState<Id>(NO_WORKFLOW);
  const [problem, setProblem] = useState<string | undefined>();

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    try {
      const text = await readText(file);
      setRaw(text);
      setFileName(file.name);
      setProblem(undefined);
    } catch (error) {
      setProblem(
        `Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (raw.trim() === '') {
      setProblem('Paste a message or pick an .eml file.');
      return;
    }
    const parsed = ImportEmailRequestSchema.safeParse({
      raw,
      ...(workflowId === NO_WORKFLOW ? {} : { workflowId }),
    });
    if (!parsed.success) {
      setProblem(
        raw.length > EMAIL_IMPORT_MAX
          ? `This message is ${raw.length.toLocaleString()} characters; the most ACE imports is ${EMAIL_IMPORT_MAX.toLocaleString()}.`
          : parsed.error.issues[0]?.message,
      );
      return;
    }
    setProblem(undefined);
    importEmail.mutate(parsed.data, {
      onSuccess: (task) => {
        toast.success(`Task #${task.number} added to the Inbox`, { description: task.title });
        onClose();
      },
    });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Import an email</DialogTitle>
            <DialogDescription>
              Paste the whole message — its headers, a blank line, then the body — or pick an .eml
              file. It is saved to the Inbox as a task with its sender, recipients, subject, date
              and text; attachments are dropped. Nothing starts until you start it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email-file">.eml file</Label>
            <input
              id="email-file"
              type="file"
              accept=".eml,message/rfc822"
              className="font-human text-sm file:mr-3 file:rounded-chip file:border file:border-border file:bg-card file:px-3 file:py-1 file:font-machine file:text-[11px] file:text-fg"
              onChange={(event) => void pick(event)}
            />
            {fileName !== undefined && (
              <p className="text-xs text-fg-muted" data-testid="email-file-name">
                Read {fileName} into the message below.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email-raw">Message</Label>
            <Textarea
              id="email-raw"
              rows={10}
              value={raw}
              spellCheck={false}
              className="font-machine text-xs"
              placeholder={'From: Ann <ann@example.com>\nSubject: Search is slow\n\nIt takes 3 s.'}
              aria-invalid={problem !== undefined ? true : undefined}
              onChange={(event) => setRaw(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email-team">Team</Label>
            <select
              id="email-team"
              className={selectClass}
              value={workflowId}
              onChange={(event) => setWorkflowId(event.target.value)}
            >
              <option value={NO_WORKFLOW}>No team yet</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-fg-muted">
              The project workflow that will do the work. You can choose it later.
            </p>
          </div>

          {problem !== undefined && (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          )}
          {importEmail.error && (
            <p role="alert" className="text-sm text-danger">
              {importEmail.error.message}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={importEmail.isPending}>
              Add to Inbox
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
