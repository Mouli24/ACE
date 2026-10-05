import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export const badgeVariants = cva(
  'inline-flex items-center rounded-chip border font-machine leading-4',
  {
    variants: {
      variant: {
        default: 'h-[22px] gap-1.5 border-border bg-transparent px-[9px] text-[10px] text-fg-soft',
        accent: 'border-transparent bg-accent px-2 py-0.5 text-[11px] text-accent-fg',
        danger: 'border-transparent bg-danger px-2 py-0.5 text-[11px] text-canvas',
        outline: 'border-border px-2 py-0.5 text-[11px] text-fg',
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
