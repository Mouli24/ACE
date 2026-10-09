import { DEFAULT_ENGINE_ORIGIN } from '@ace/contracts';

export interface TokenMissingProps {
  /**
   * The page runs in the desktop app, but the bridge it was handed did not parse (D294). The browser
   * instructions — run `pnpm dev`, open the printed link — would be wrong there.
   */
  desktop?: boolean;
}

/**
 * No session token in the URL or sessionStorage (round 1 §2.10), or an unusable desktop bridge. A
 * centred theme card on the canvas colour (D328).
 */
export function TokenMissing({ desktop = false }: TokenMissingProps) {
  if (desktop) {
    return (
      <main
        data-testid="token-missing-desktop"
        className="flex h-full items-center justify-center bg-[var(--canvas)] px-4 py-8 text-[var(--ink)]"
      >
        <div className="flex w-full max-w-[520px] flex-col gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-5">
          <h1 className="text-[20px] font-bold tracking-[-0.01em]">
            ACE could not connect to its engine
          </h1>
          <p className="text-[13px] leading-[1.55] text-[var(--muted)]">
            The desktop app handed this window an engine address or session token it could not
            use. Reload the window with{' '}
            <code className="rounded-[4px] bg-[var(--hover)] px-[5px] py-px font-machine text-[12px] text-[var(--ink)]">
              Ctrl+R
            </code>
            . If this keeps happening, quit ACE and open it again.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-full items-center justify-center bg-[var(--canvas)] px-4 py-8 text-[var(--ink)]">
      <div className="flex w-full max-w-[520px] flex-col gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-5">
        <h1 className="text-[20px] font-bold tracking-[-0.01em]">Open ACE from the engine link</h1>
        <p className="text-[13px] leading-[1.55] text-[var(--muted)]">
          The web app needs the session token the engine prints when it starts. Run{' '}
          <code className="rounded-[4px] bg-[var(--hover)] px-[5px] py-px font-machine text-[12px] text-[var(--ink)]">
            pnpm dev
          </code>{' '}
          and open the URL it prints, which looks like
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[8px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] font-machine text-[12px] leading-[1.55]">
          ACE engine ready · {DEFAULT_ENGINE_ORIGIN} · open http://localhost:5173/?token=…
        </pre>
      </div>
    </main>
  );
}
