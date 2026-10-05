import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-chip font-machine text-[11px] tracking-[0.04em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg font-semibold hover:opacity-90',
        secondary: 'border border-border bg-card text-fg hover:border-fg-muted',
        ghost: 'text-fg-muted hover:bg-border hover:text-fg',
        destructive: 'border border-danger/50 text-danger hover:bg-danger/10',
        outline: 'border border-border-strong bg-transparent text-fg hover:border-fg-muted',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-[30px] px-3.5',
        lg: 'h-10 px-6',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        type={asChild ? type : (type ?? 'button')}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
