import { cn } from '@ace/ui';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { IconAction } from '../layout/IconAction';
import { useOutputStore, type OutputLine } from './output-store';

const EMPTY: OutputLine[] = [];
const LEVEL_CLASS = {
  info: 'text-fg-muted',
  warn: 'text-[var(--color-status-WAITING)]',
  error: 'text-danger',
} as const;

export function OutputView({ projectId }: { projectId: string }) {
  const lines = useOutputStore((s) => s.lines[projectId] ?? EMPTY);
  const clear = useOutputStore((s) => s.clear);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines.length]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-end px-2">
        <IconAction
          label="Clear output"
          Icon={Trash2}
          onClick={() => clear(projectId)}
          disabled={lines.length === 0}
        />
      </div>
      <div
        role="log"
        aria-label="Output"
        className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-machine text-[12px]"
      >
        {lines.length === 0 && (
          <p className="text-fg-muted">
            Nothing yet. Saves, conflicts and file errors appear here.
          </p>
        )}
        {lines.map((line) => (
          <div key={line.id} className="flex gap-3 leading-5">
            <time className="shrink-0 text-fg-faint" dateTime={line.at}>
              {new Date(line.at).toLocaleTimeString()}
            </time>
            <span className={cn('whitespace-pre-wrap', LEVEL_CLASS[line.level])}>
              {line.message}
            </span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
