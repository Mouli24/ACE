import type { BackupImportResponse } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '@ace/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { api } from '../app/api';
import { HELP_CLASS } from './SettingFields';

/** `ace-backup-YYYY-MM-DD.zip`, dated in the operator's own day (FR-SYS-012). */
export function backupFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `ace-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}

/** Hand a blob to the browser as a download, then let the object URL go. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong.';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Backup and restore (FR-SYS-012, TC-SYS-014). Export downloads the engine's zip — database copy,
 * artifacts and settings, never a key. Import replaces the current data, so it asks first; the
 * engine backs the current data up before it restores. Afterwards every query is stale, so all of
 * them are invalidated rather than guessing which screens the restore touched. A theme card (D328).
 */
export function BackupSection() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | undefined>(undefined);
  const [restored, setRestored] = useState<BackupImportResponse['restored'] | undefined>(undefined);

  const exportBackup = useMutation({
    mutationFn: () => api().exportBackup(),
    onSuccess: (blob) => {
      saveBlob(blob, backupFilename());
      toast.success('Backup downloaded');
    },
  });

  const importBackup = useMutation({
    mutationFn: (file: File) => api().importBackup(file),
    onSuccess: async (response) => {
      setRestored(response.restored);
      toast.success('Backup restored');
      await queryClient.invalidateQueries();
    },
  });

  return (
    <section
      className="flex flex-col gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid="settings-backup"
    >
      <h2 className="text-[14px] font-bold">Backup</h2>
      <p className={HELP_CLASS}>
        A backup holds the database, the artifacts folder and these settings. API keys stay in the
        OS keychain and are never in it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          data-testid="backup-export"
          disabled={exportBackup.isPending}
          onClick={() => exportBackup.mutate()}
        >
          {exportBackup.isPending ? 'Exporting…' : 'Export backup'}
        </Button>
        <Button
          variant="secondary"
          data-testid="backup-import"
          disabled={importBackup.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {importBackup.isPending ? 'Restoring…' : 'Import backup'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          tabIndex={-1}
          aria-label="Backup file"
          data-testid="backup-import-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) {
              importBackup.reset();
              setRestored(undefined);
              setPending(file);
            }
          }}
        />
      </div>
      {exportBackup.isError && (
        <p role="alert" className="text-[12px] text-danger" data-testid="backup-export-error">
          Export failed: {messageOf(exportBackup.error)}
        </p>
      )}
      {importBackup.isError && (
        <p role="alert" className="text-[12px] text-danger" data-testid="backup-import-error">
          Import failed: {messageOf(importBackup.error)}
        </p>
      )}
      {restored !== undefined && (
        <p className="text-[12px]" data-testid="backup-restored" role="status">
          Restored {plural(restored.projects, 'project')}, {plural(restored.runs, 'run')} and{' '}
          {plural(restored.artifacts, 'artifact')}.
        </p>
      )}

      <Dialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              Restoring <span className="font-machine">{pending?.name}</span> replaces every
              project, workflow, run and artifact you have now. The engine keeps a backup of the
              current data first, so this can be undone by importing that one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="backup-import-confirm"
              onClick={() => {
                if (pending !== undefined) importBackup.mutate(pending);
                setPending(undefined);
              }}
            >
              Replace and restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
