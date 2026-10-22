import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/*
 * The Ace UI theme's pill buttons (D328): `default` is the modal's Done pill (ink on canvas),
 * `secondary` the Close pill (soft fill, hairline), `outline` the ink-bordered pill, `ghost` the
 * toolbar's quiet button, `destructive` the "Remove node" red. Plus Jakarta Sans 600.
 */
export const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-semibold outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'border-none bg-[var(--ink)] text-[var(--canvas)] hover:opacity-90',
        secondary:
          'border border-[var(--line)] bg-[var(--soft)] text-[var(--ink)] hover:bg-[var(--hover)]',
        ghost: 'border-none bg-transparent text-[var(--ink)] hover:bg-[var(--hover)]',
        destructive:
          'border border-[var(--line)] bg-transparent text-danger hover:bg-[var(--hover)]',
        outline:
          'border border-[var(--ink)] bg-transparent text-[var(--ink)] hover:bg-[var(--hover)]',
      },
      size: {
        default: 'h-[34px] px-[22px] text-[13px]',
        sm: 'h-[30px] px-[14px] text-[12px]',
        lg: 'h-[38px] px-6 text-[13px]',
        icon: 'h-7 w-7 rounded-[7px] text-[12px]',
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
