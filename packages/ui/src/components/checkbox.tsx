import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A checkbox in the Ace UI theme's colours (D328): hairline box, orange when checked — the AA
 * `--accent-strong` under a white check icon (PG-1.2, D360: white on #ef6b3f measured 2.9:1).
 */
export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-[4px] border border-[var(--iconLine)] bg-[var(--surface)] outline-none focus-visible:shadow-[0_0_0_2px_rgba(239,107,63,0.35)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[var(--accent-strong)] data-[state=checked]:bg-[var(--accent-strong)] data-[state=checked]:text-[#fff]',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="grid place-items-center leading-none">
      <Check aria-hidden size={11} strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';
