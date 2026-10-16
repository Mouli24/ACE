import { Button, Icons } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';

import { requestTerminalFocus } from './focus';
import { useProjectScripts } from './hooks';
import { runScript } from './session';

/**
 * The project's own scripts (D301, design §6.3), one of the kit's secondary pills each (D328) at the
 * end of the terminal's tab strip; a click runs the script in a new tab.
 */
export function ScriptButtons({
  projectId,
  disabled = false,
}: {
  projectId: string;
  disabled?: boolean;
}) {
  const scripts = useProjectScripts(projectId);
  const queryClient = useQueryClient();
  const manager = scripts.data?.packageManager ?? 'npm';
  const list = scripts.data?.scripts ?? [];
  if (list.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Scripts"
      className="flex min-w-0 max-w-[55%] items-center gap-[6px] overflow-x-auto px-[8px]"
    >
      {list.map((script) => (
        <Button
          key={script.name}
          variant="secondary"
          size="sm"
          disabled={disabled}
          title={`${manager} run ${script.name}: ${script.command}`}
          onClick={() => {
            requestTerminalFocus();
            void runScript(projectId, script.name, manager, queryClient);
          }}
          className="h-[22px] shrink-0 gap-[5px] px-[10px] font-machine text-[10.5px] font-medium"
        >
          <span aria-hidden className="text-[8px] text-[#ef6b3f]">
            <Icons.Play aria-hidden size={12} />
          </span>
          {script.name}
        </Button>
      ))}
    </div>
  );
}
