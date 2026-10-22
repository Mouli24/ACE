import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/*
 * The Ace UI theme's custom dropdown (D328): a 38px trigger on the canvas colour that turns its
 * border orange while open, a ▾, and a menu 4px below it with a ✓ column. Radix keeps the
 * listbox semantics, keyboard and outside-click; the look is the theme's. Audit U-6: keyboard focus
 * on the trigger draws a 2px ring in the AA `--focus` colour.
 */

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-[38px] w-full cursor-pointer items-center justify-between gap-2 rounded-[9px] border border-[var(--line)] bg-[var(--canvas)] px-3 text-left text-[13px] text-[var(--ink)] outline-none focus-visible:border-[var(--focus)] focus-visible:shadow-[0_0_0_1px_var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-[#ef6b3f] [&>span]:min-w-0 [&>span]:truncate',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown aria-hidden size={13} className="shrink-0 text-[var(--muted)]" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', sideOffset = 4, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={position === 'popper' ? sideOffset : undefined}
      className={cn(
        'relative z-50 max-h-[320px] min-w-[8rem] overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]',
        position === 'popper' && 'w-full min-w-[var(--radix-select-trigger-width)]',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="flex flex-col gap-px p-1">
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = 'SelectContent';

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & { icon?: ReactNode }
>(({ className, children, icon, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex h-8 w-full shrink-0 cursor-pointer select-none items-center gap-2 rounded-[7px] px-[10px] text-left text-[12.5px] font-normal text-[var(--ink)] outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[state=checked]:bg-[var(--hover)] data-[state=checked]:font-semibold data-[highlighted]:!bg-[rgba(239,107,63,0.12)]',
      className,
    )}
    {...props}
  >
    <span aria-hidden className="w-3 shrink-0 text-[11px] text-[#e8572e]">
      <SelectPrimitive.ItemIndicator>
        <Check aria-hidden size={11} strokeWidth={2.6} />
      </SelectPrimitive.ItemIndicator>
    </span>
    {icon}
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';
