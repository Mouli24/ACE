import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/** The Ace UI theme's mono chip (D328): JetBrains Mono 8.5px, 0.08em, radius 4. */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] px-[6px] py-[2px] font-machine text-[8.5px] font-medium uppercase leading-[1.4] tracking-[0.08em]',
  {
    variants: {
      variant: {
        default: 'bg-[var(--hover)] text-[var(--ink)]',
        accent: 'bg-[rgba(239,107,63,0.12)] text-[#e8572e]',
        danger: 'bg-[rgba(201,76,39,0.12)] text-[#c94c27]',
        outline: 'border border-[var(--line)] text-[var(--muted)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
