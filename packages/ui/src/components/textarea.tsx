import { forwardRef, type TextareaHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * The Ace UI theme's textarea (D328): radius 9, 13px / 1.55, orange border on focus. Audit U-6:
 * keyboard focus draws a 2px ring (border and shadow) in the AA `--focus` colour.
 */
export const TEXTAREA_CLASS =
  'w-full resize-y rounded-[9px] border border-[var(--line)] bg-[var(--canvas)] p-3 text-[13px] leading-[1.55] text-[var(--ink)] outline-none focus:border-[var(--focus)] focus-visible:border-[var(--focus)] focus-visible:shadow-[0_0_0_1px_var(--focus)] disabled:cursor-not-allowed disabled:opacity-50';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(TEXTAREA_CLASS, className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';
