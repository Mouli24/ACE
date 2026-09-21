import { THEMES, type Theme } from '@ace/contracts';
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ace/ui';

import { usePatchSettings, useSettings } from './hooks';

/** `/settings` — theme only in round 1 (round 1 §5 step 3). */
export function SettingsPage() {
  const settings = useSettings();
  const patch = usePatchSettings();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <h1 className="font-human text-2xl font-semibold">Settings</h1>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="theme">Theme</Label>
        <Select
          value={settings.data?.theme ?? 'dark'}
          onValueChange={(value) => patch.mutate({ theme: value as Theme })}
          disabled={!settings.data}
        >
          <SelectTrigger id="theme" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((theme) => (
              <SelectItem key={theme} value={theme}>
                {theme}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-fg-muted">
          Light and system themes render in a later round; dark is the design.
        </p>
      </div>
    </main>
  );
}
