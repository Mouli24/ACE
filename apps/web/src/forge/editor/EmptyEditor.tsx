import { SHORTCUTS, shortcutLabel, type Shortcut } from '../../app/shortcuts';

/** What the editor area shows with no file open: real actions, with their keys (design §2.2). */
const HINTS: ReadonlyArray<{ label: string; shortcut: Shortcut }> = [
  { label: 'Show or hide the Explorer', shortcut: SHORTCUTS.toggleSidebar },
  { label: 'Show or hide the panel', shortcut: SHORTCUTS.togglePanel },
  { label: 'Show or hide the chat', shortcut: SHORTCUTS.toggleChat },
  { label: 'Back to Ideate', shortcut: SHORTCUTS.ideate },
];

export function EmptyEditor() {
  return (
    <div className="grid h-full place-items-center bg-canvas">
      <div className="space-y-4 text-center">
        <p className="font-human text-2xl text-fg-soft">Forge</p>
        <p className="text-[13px] text-fg-muted">Open a file from the Explorer.</p>
        <dl className="mx-auto grid w-max grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-left text-[12px]">
          {HINTS.map(({ label, shortcut }) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="font-machine text-fg-soft">{shortcutLabel(shortcut)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
