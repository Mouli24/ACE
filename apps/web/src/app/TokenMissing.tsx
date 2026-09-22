import { DEFAULT_ENGINE_ORIGIN } from '@ace/contracts';

/** No session token in the URL or sessionStorage (round 1 §2.10). */
export function TokenMissing() {
  return (
    <main className="mx-auto flex h-full max-w-lg flex-col justify-center gap-4 px-6 font-human">
      <h1 className="text-2xl font-semibold">Open ACE from the engine link</h1>
      <p className="text-fg-muted">
        The web app needs the session token the engine prints when it starts. Run{' '}
        <code className="font-machine text-fg">pnpm dev</code> and open the URL it prints, which
        looks like
      </p>
      <pre className="rounded-md border border-border bg-panel p-3 font-machine text-xs">
        ACE engine ready · {DEFAULT_ENGINE_ORIGIN} · open http://localhost:5173/?token=…
      </pre>
    </main>
  );
}
