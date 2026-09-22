import { Toaster as Sonner, toast } from 'sonner';

/** App-wide toast host (FR-WF-005 conflict toast, FR-CON-002 refusal reasons). */
export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: 'bg-panel text-fg border border-border font-human',
          description: 'text-fg-muted',
        },
      }}
    />
  );
}

export { toast };
