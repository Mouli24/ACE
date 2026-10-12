import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '../lib/cn.js';

/** A checkbox in the Ace UI theme's colours (D328): hairline box, orange when checked. */
export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-[4px] border border-[var(--iconLine)] bg-[var(--surface)] outline-none focus-visible:shadow-[0_0_0_2px_rgba(239,107,63,0.35)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[#ef6b3f] data-[state=checked]:bg-[#ef6b3f] data-[state=checked]:text-[#fff]',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="text-[10px] leading-none font-bold">
      ✓
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';
