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

/** The theme's help line under a field (D328): 11px / 1.45, muted. */
export const HELP = 'text-[11px] leading-[1.45] text-[var(--muted)]';

/** A field's error, in the theme's red, under its control. */
export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-[11px] leading-[1.45] text-danger">
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
    <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={sizeId}>Chunk size (tokens)</Label>
        <Input
          id={sizeId}
          type="number"
          inputMode="numeric"
          min={CHUNK_SIZE_MIN}
          max={CHUNK_SIZE_MAX}
          className="font-machine text-[12px]"
          value={chunkSize}
          aria-invalid={errors['chunkSize'] ? true : undefined}
          aria-describedby={errors['chunkSize'] ? `${sizeId}-error` : `${sizeId}-hint`}
          onChange={(event) => onChunkSize(event.target.value)}
        />
        <p id={`${sizeId}-hint`} className={HELP}>
          {CHUNK_SIZE_MIN}–{CHUNK_SIZE_MAX}
        </p>
        <FieldError id={`${sizeId}-error`} message={errors['chunkSize']} />
      </div>
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={overlapId}>Overlap (tokens)</Label>
        <Input
          id={overlapId}
          type="number"
          inputMode="numeric"
          min={CHUNK_OVERLAP_MIN}
          max={CHUNK_OVERLAP_MAX}
          className="font-machine text-[12px]"
          value={chunkOverlap}
          aria-invalid={errors['chunkOverlap'] ? true : undefined}
          aria-describedby={errors['chunkOverlap'] ? `${overlapId}-error` : `${overlapId}-hint`}
          onChange={(event) => onChunkOverlap(event.target.value)}
        />
        <p id={`${overlapId}-hint`} className={HELP}>
          {CHUNK_OVERLAP_MIN}–{CHUNK_OVERLAP_MAX}, smaller than the chunk size
        </p>
        <FieldError id={`${overlapId}-error`} message={errors['chunkOverlap']} />
      </div>
    </div>
  );
}
