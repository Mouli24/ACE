import { nameOf } from '../files/paths';

const sizeOf = (bytes = 0): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/** A file Forge does not open as text, and why (§6.1, §6.2), in the theme's muted empty-state line. */
export function FileNotice({
  path,
  kind,
  size,
  message,
}: {
  path: string;
  kind: 'binary' | 'too_large' | 'missing';
  size?: number;
  message?: string;
}) {
  const text =
    kind === 'binary'
      ? 'This file is binary, or not UTF-8 text, so Forge does not open it as text.'
      : kind === 'too_large'
        ? `This file is ${sizeOf(size)}; Forge opens text files up to 2 MB.`
        : (message ?? 'This file could not be opened.');
  return (
    <div
      role="status"
      data-testid="file-notice"
      className="flex h-full items-center justify-center p-[24px] text-center text-[13px] text-[var(--muted)]"
    >
      <div className="flex max-w-[360px] flex-col items-center gap-[6px]">
        <p className="font-machine text-[11px] text-[var(--ink)]">{nameOf(path)}</p>
        <p>{text}</p>
      </div>
    </div>
  );
}
