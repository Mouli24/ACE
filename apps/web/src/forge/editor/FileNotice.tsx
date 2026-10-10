import { FileIcon } from '../explorer/FileIcon';
import { nameOf } from '../files/paths';

const sizeOf = (bytes = 0): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/** A file Forge does not open as text, and why (§6.1, §6.2). */
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
      className="grid h-full place-items-center p-6 text-center text-[13px] text-fg-muted"
    >
      <div className="flex max-w-sm flex-col items-center gap-2">
        <FileIcon path={path} className="h-8 w-8 text-fg-faint" />
        <p className="font-machine text-fg-soft">{nameOf(path)}</p>
        <p>{text}</p>
      </div>
    </div>
  );
}
