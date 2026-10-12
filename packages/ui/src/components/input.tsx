import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** The Ace UI theme's text field (D328): 38px, radius 9, orange border on focus, no outline. */
export const INPUT_CLASS =
  'h-[38px] w-full rounded-[9px] border border-[var(--line)] bg-[var(--canvas)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[#ef6b3f] disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-[#c94c27]';

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(INPUT_CLASS, className)} {...props} />
));
Input.displayName = 'Input';
