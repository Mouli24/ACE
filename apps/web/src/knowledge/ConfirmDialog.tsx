import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ace/ui';
import type { ReactNode } from 'react';

/**
 * A destructive action asks first (deleting a document or a whole base, FR-RAG-009). ACE parity P0
 * reuses it for actions that are weighty rather than destructive — Apply, Initialize Git — with the
 * `default` button and what is about to happen spelled out as `children`.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  pending = false,
  error,
  variant = 'destructive',
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  error?: Error | null;
  variant?: 'destructive' | 'default';
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error.message}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant={variant} disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
