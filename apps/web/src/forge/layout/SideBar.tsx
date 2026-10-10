import { useLayoutStore } from '../../app/stores/layout';
import { ExplorerView } from '../explorer/ExplorerView';

export function SideBar({ projectId }: { projectId: string }) {
  const view = useLayoutStore((s) => s.sidebarView);
  return (
    <aside
      aria-label="Side bar"
      className="flex h-full min-h-0 flex-col border-r border-border bg-panel"
    >
      {view === 'explorer' && <ExplorerView projectId={projectId} />}
    </aside>
  );
}
