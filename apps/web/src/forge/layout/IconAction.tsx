import { cn } from '@ace/ui';
import type { LucideIcon } from 'lucide-react';

/** A small icon button with its name as the label and the tooltip. */
export function IconAction({
  label,
  Icon,
  onClick,
  disabled = false,
  pressed,
}: {
  label: string;
  Icon: LucideIcon;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid h-6 w-6 place-items-center rounded text-fg-muted hover:bg-card hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40',
        pressed === true && 'bg-card text-fg',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
