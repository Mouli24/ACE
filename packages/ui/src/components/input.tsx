import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/**
 * The Ace UI theme's text field (D328): 38px, radius 9, orange border on focus, no outline. Audit
 * U-6: keyboard focus draws a 2px ring (border and shadow) in the AA `--focus` colour.
 */
export const INPUT_CLASS =
  'h-[38px] w-full rounded-[9px] border border-[var(--line)] bg-[var(--canvas)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--focus)] focus-visible:border-[var(--focus)] focus-visible:shadow-[0_0_0_1px_var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-[#c94c27]';

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(INPUT_CLASS, className)} {...props} />
));
Input.displayName = 'Input';
