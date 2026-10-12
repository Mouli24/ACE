import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '../lib/cn.js';

/*
 * The Ace UI theme's menu (D328), as in its custom dropdowns: radius 10, padding 4, the long soft
 * shadow, 32px items with an orange hover wash. Radix handles focus, keys and dismissal.
 */

export const MENU_CONTENT_CLASS =
  'z-50 flex min-w-[180px] flex-col gap-px overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--surface)] p-1 text-[var(--ink)] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)] outline-none';
export const MENU_ITEM_CLASS =
  'relative flex h-8 shrink-0 cursor-pointer select-none items-center gap-2 rounded-[7px] px-[10px] text-[12.5px] text-[var(--ink)] outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-[rgba(239,107,63,0.12)]';
export const MENU_LABEL_CLASS =
  'px-[10px] pb-1 pt-2 font-machine text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]';
export const MENU_SEPARATOR_CLASS = '-mx-1 my-1 h-px shrink-0 bg-[var(--line)]';

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn(MENU_SEPARATOR_CLASS, className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label ref={ref} className={cn(MENU_LABEL_CLASS, className)} {...props} />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(MENU_CONTENT_CLASS, className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(MENU_ITEM_CLASS, destructive && 'text-[#c94c27]', className)}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';
