import type { TerminalTrust } from '@ace/contracts';
import { cn } from '@ace/ui';
import { Link } from 'react-router-dom';

import { HELP_CLASS } from '../../settings/SettingFields';

/**
 * With `scripts` or `off`, the Terminal says so above its card, in the theme's help line (D328),
 * and where to change it: the theme's accent link to the project page (D301).
 */
export function TrustNotice({ projectId, trust }: { projectId: string; trust: TerminalTrust }) {
  if (trust === 'on') return null;
  return (
    <p role="status" data-testid="terminal-trust-notice" className={cn('m-0 shrink-0', HELP_CLASS)}>
      {trust === 'off'
        ? 'The terminal is off for this project.'
        : 'This project runs only its own package.json scripts here.'}{' '}
      <Link to={`/projects/${projectId}`} className="font-semibold">
        Change it on the project page
      </Link>
    </p>
  );
}
