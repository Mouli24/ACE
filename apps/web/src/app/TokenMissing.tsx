import { DEFAULT_ENGINE_ORIGIN } from '@ace/contracts';

/**
 * No session token in the URL or sessionStorage (round 1 §2.10). A centred theme card on the
 * canvas colour (D328).
 */
export function TokenMissing() {
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
