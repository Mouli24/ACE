import { Toaster as Sonner, toast } from 'sonner';

/**
 * App-wide toast host (FR-WF-005 conflict toast, FR-CON-002 refusal reasons), in the Ace UI
 * theme's surface (D328). `theme` follows the page's light/dark choice.
 */
export function Toaster({ theme = 'light' }: { theme?: 'light' | 'dark' }) {
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'bg-[var(--surface)] text-[var(--ink)] border border-[var(--line)] font-human rounded-[12px] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]',
          description: 'text-[var(--muted)]',
        },
      }}
    />
  );
}

export { toast };
