import * as TabsPrimitive from '@radix-ui/react-tabs';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '../lib/cn.js';

/*
 * The Ace UI theme's segmented pill (D328), as in its Ideate / Forge / Domain switch: a soft track
 * with a hairline, 26px options, ink fill on the active one.
 */

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex items-center gap-[2px] rounded-full border border-[var(--line)] bg-[var(--soft)] p-[3px]',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-[26px] flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-full border border-transparent bg-transparent px-4 text-[12px] font-semibold text-[var(--muted)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-[var(--seg)] data-[state=active]:bg-[var(--seg)] data-[state=active]:text-[var(--segInk)]',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('outline-none', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';
