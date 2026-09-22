import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-9 w-full rounded-md border border-border bg-canvas px-3 py-1 text-sm text-fg shadow-sm transition-colors placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
