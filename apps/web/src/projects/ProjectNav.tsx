import { cn } from '@ace/ui';
import { NavLink } from 'react-router-dom';

/**
 * The project's own navigation (ACE parity P0, design §8): Overview (its workflows) · Tasks · Runs ·
 * Knowledge · Settings, as a pill row at the top of every project page. The current page is marked
 * `aria-current="page"`; a task page counts as Tasks. The Settings pill is named "Project settings"
 * for assistive tech, so it is never mistaken for the engine's Settings in the top bar.
 */
const ITEMS = [
  { path: '', label: 'Overview', end: true },
  { path: '/tasks', label: 'Tasks', end: false },
  { path: '/runs', label: 'Runs', end: true },
  { path: '/knowledge', label: 'Knowledge', end: true },
  { path: '/settings', label: 'Settings', end: true, name: 'Project settings' },
] as const;

export function ProjectNav({ projectId, className }: { projectId: string; className?: string }) {
  return (
    <nav aria-label="Project" data-testid="project-nav" className={cn('max-w-full', className)}>
      <ul className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-chip border border-border bg-card p-[3px]">
        {ITEMS.map((item) => (
          <li key={item.label} className="shrink-0">
            <NavLink
              to={`/projects/${projectId}${item.path}`}
              end={item.end}
              {...('name' in item ? { 'aria-label': item.name } : {})}
              className={({ isActive }) =>
                cn(
                  'inline-flex h-[26px] items-center rounded-chip px-[13px] font-machine text-[10.5px] tracking-[0.04em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection',
                  isActive ? 'bg-fg text-canvas' : 'text-fg-muted hover:text-fg',
                )
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
