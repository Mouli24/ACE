import * as LabelPrimitive from '@radix-ui/react-label';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

import { cn } from '../lib/cn.js';

/** The Ace UI theme's field label (D328): JetBrains Mono 9.5px, 0.1em, muted, 500, uppercase. */
export const FIELD_LABEL_CLASS =
  'font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]';

export const Label = forwardRef<
  ElementRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      FIELD_LABEL_CLASS,
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';
