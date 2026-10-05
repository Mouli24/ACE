import { forwardRef, type TextareaHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full rounded-field border border-border bg-card px-3 py-2.5 font-human text-[14.5px] leading-normal text-fg placeholder:text-fg-faint focus-visible:border-selection focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
