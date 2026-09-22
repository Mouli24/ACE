import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export const badgeVariants = cva(
  'inline-flex items-center rounded-chip border px-2 py-0.5 text-[11px] font-machine leading-4',
  {
    variants: {
      variant: {
        default: 'border-border bg-canvas text-fg-muted',
        accent: 'border-transparent bg-accent text-accent-fg',
        danger: 'border-transparent bg-danger text-canvas',
        outline: 'border-border text-fg',
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
