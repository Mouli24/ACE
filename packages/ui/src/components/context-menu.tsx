import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
} from 'react';

import { cn } from '../lib/cn.js';

/**
 * Right-click menus (FR-CAN-011: the Canvas's node and pane menus). Radix handles the pointer and
 * keyboard (Shift+F10 / the context-menu key), focus and dismissal; styled like `DropdownMenu`.
 */

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;

export const ContextMenuContent = forwardRef<
  ElementRef<typeof ContextMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        'z-50 min-w-[10rem] overflow-hidden rounded-md border border-border bg-panel p-1 text-fg shadow-md',
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = 'ContextMenuContent';

export const ContextMenuItem = forwardRef<
  ElementRef<typeof ContextMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-border/60 data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      destructive && 'text-danger',
      className,
    )}
    {...props}
  />
));
ContextMenuItem.displayName = 'ContextMenuItem';

export const ContextMenuSeparator = forwardRef<
  ElementRef<typeof ContextMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = 'ContextMenuSeparator';

/** The keyboard shortcut shown at the end of an item, e.g. `⌘D`. */
export function ContextMenuShortcut({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('ml-auto pl-4 font-machine text-[11px] tracking-wide text-fg-muted', className)}
      {...props}
    />
  );
}
