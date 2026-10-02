import {
  CHUNK_OVERLAP_MAX,
  CHUNK_OVERLAP_MIN,
  CHUNK_SIZE_MAX,
  CHUNK_SIZE_MIN,
} from '@ace/contracts';
import { Input, Label } from '@ace/ui';
import type { ZodError } from 'zod';

/** A form's field errors by path, from a contract schema's `safeParse` (FR-RAG-001). */
export type FieldErrors = Partial<Record<string, string>>;

export function fieldErrors(error: ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] ??= issue.message;
  }
  return errors;
}

/** A number typed into a field, or `NaN` when it is empty — the schema then says what is wrong. */
export const toNumber = (value: string): number =>
  value.trim() === '' ? Number.NaN : Number(value);

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-danger">
      {message}
    </p>
  );
}

/**
 * The chunk size and overlap inputs, shared by the create dialog and the settings dialog. The
 * bounds come from the contract (§2.1); the overlap-below-size rule is the schema's refine.
 */
export function ChunkFields({
  idPrefix,
  chunkSize,
  chunkOverlap,
  errors,
  onChunkSize,
  onChunkOverlap,
}: {
  idPrefix: string;
  chunkSize: string;
  chunkOverlap: string;
  errors: FieldErrors;
  onChunkSize: (value: string) => void;
  onChunkOverlap: (value: string) => void;
}) {
  const sizeId = `${idPrefix}-chunk-size`;
  const overlapId = `${idPrefix}-chunk-overlap`;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={sizeId}>Chunk size (tokens)</Label>
        <Input
          id={sizeId}
          type="number"
          inputMode="numeric"
          min={CHUNK_SIZE_MIN}
          max={CHUNK_SIZE_MAX}
          value={chunkSize}
          aria-invalid={errors['chunkSize'] ? true : undefined}
          aria-describedby={errors['chunkSize'] ? `${sizeId}-error` : `${sizeId}-hint`}
          onChange={(event) => onChunkSize(event.target.value)}
        />
        <p id={`${sizeId}-hint`} className="text-[11px] text-fg-muted">
          {CHUNK_SIZE_MIN}–{CHUNK_SIZE_MAX}
        </p>
        <FieldError id={`${sizeId}-error`} message={errors['chunkSize']} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={overlapId}>Overlap (tokens)</Label>
        <Input
          id={overlapId}
          type="number"
          inputMode="numeric"
          min={CHUNK_OVERLAP_MIN}
          max={CHUNK_OVERLAP_MAX}
          value={chunkOverlap}
          aria-invalid={errors['chunkOverlap'] ? true : undefined}
          aria-describedby={errors['chunkOverlap'] ? `${overlapId}-error` : `${overlapId}-hint`}
          onChange={(event) => onChunkOverlap(event.target.value)}
        />
        <p id={`${overlapId}-hint`} className="text-[11px] text-fg-muted">
          {CHUNK_OVERLAP_MIN}–{CHUNK_OVERLAP_MAX}, smaller than the chunk size
        </p>
        <FieldError id={`${overlapId}-error`} message={errors['chunkOverlap']} />
      </div>
    </div>
  );
}

/** A native select styled like the other inputs: accessible and keyboard-usable as is. */
export const selectClass =
  'h-9 w-full min-w-0 rounded-md border border-border bg-canvas px-3 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50';
