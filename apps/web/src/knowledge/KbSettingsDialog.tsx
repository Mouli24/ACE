import {
  KNOWLEDGE_BASE_NAME_MAX,
  UpdateKnowledgeBaseRequestSchema,
  type KnowledgeBase,
} from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@ace/ui';
import { useState, type FormEvent } from 'react';

import { ChunkFields, FieldError, fieldErrors, toNumber, type FieldErrors } from './fields';
import { useUpdateKnowledgeBase } from './hooks';

/**
 * Rename a base or change its chunking (`PATCH`, D235). New chunk settings apply at the next ingest
 * or reindex; the embedder is shown but fixed.
 */
export function KbSettingsDialog({ kb, onClose }: { kb: KnowledgeBase; onClose: () => void }) {
  const update = useUpdateKnowledgeBase(kb.id);
  const [name, setName] = useState(kb.name);
  const [chunkSize, setChunkSize] = useState(String(kb.chunkSize));
  const [chunkOverlap, setChunkOverlap] = useState(String(kb.chunkOverlap));
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = UpdateKnowledgeBaseRequestSchema.safeParse({
      name: name.trim(),
      chunkSize: toNumber(chunkSize),
      chunkOverlap: toNumber(chunkOverlap),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    update.mutate(parsed.data, { onSuccess: onClose });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-[560px]">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Knowledge base settings</DialogTitle>
            <DialogDescription>
              New chunk settings apply to documents ingested from now on, and to every document on a
              reindex.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-[7px]">
            <Label htmlFor="kb-settings-name">Name</Label>
            <Input
              id="kb-settings-name"
              value={name}
              maxLength={KNOWLEDGE_BASE_NAME_MAX}
              aria-invalid={errors['name'] ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldError id="kb-settings-name-error" message={errors['name']} />
          </div>
          <p className="rounded-[8px] border border-[var(--line)] bg-[var(--soft)] px-[10px] py-2 font-machine text-[11px] text-[var(--muted)]">
            Embedder: {kb.embeddingModelId} (fixed at creation)
          </p>
          <ChunkFields
            idPrefix="kb-settings"
            chunkSize={chunkSize}
            chunkOverlap={chunkOverlap}
            errors={errors}
            onChunkSize={setChunkSize}
            onChunkOverlap={setChunkOverlap}
          />
          {update.error && (
            <p role="alert" className="text-[12px] text-[#c94c27]">
              {update.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
