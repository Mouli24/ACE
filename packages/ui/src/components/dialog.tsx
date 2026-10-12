import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
} from 'react';

import { cn } from '../lib/cn.js';

/*
 * The Ace UI theme's modal shell (D328): a warm, lightly blurred overlay and an 18px-radius surface
 * with the theme's long soft shadow. Clicking outside or Esc closes it (Radix).
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-[rgba(20,14,10,0.38)] backdrop-blur-[3px]', className)}
    {...props}
  />
));
DialogOverlay.displayName = 'DialogOverlay';

/** The theme's close control for a dialog: a 28px square with ✕, named "Close". */
export const DIALOG_CLOSE_CLASS =
  'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border border-[var(--line)] bg-transparent text-[12px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f]';

export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100vh-48px)] w-[calc(100vw-48px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-[18px] border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[0_40px_100px_-30px_rgba(20,12,6,0.6)] outline-none',
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className={cn(DIALOG_CLOSE_CLASS, 'absolute right-4 top-4')}>
          <span aria-hidden>✕</span>
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = 'DialogContent';

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 pr-10', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-end gap-2', className)} {...props} />;
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-[18px] font-bold tracking-[-0.01em] text-[var(--ink)]', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-[12px] leading-[1.45] text-[var(--muted)]', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';
