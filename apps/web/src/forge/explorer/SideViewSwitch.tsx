import { Tabs, TabsList, TabsTrigger } from '@ace/ui';

import { SIDE_VIEWS, useSideViewStore, type SideView } from './side-view-store';

/**
 * EXPLORER · SEARCH · CHANGES (D299 Phase 4, D339): the kit's segmented pill (D328), compact —
 * mono caps, as the column's old "EXPLORER" label read — at the top of Forge's left column. It
 * lists {@link SIDE_VIEWS}.
 */
export function SideViewSwitch() {
  const view = useSideViewStore((state) => state.view);
  const show = useSideViewStore((state) => state.show);
  return (
    <Tabs value={view} onValueChange={(next) => show(next as SideView)}>
      <TabsList aria-label="Side bar views" className="p-[2px]">
        {SIDE_VIEWS.map(({ view: each, label }) => (
          <TabsTrigger
            key={each}
            value={each}
            data-testid={`side-view-${each}`}
            className="h-[22px] flex-none px-[9px] font-machine text-[9.5px] tracking-[0.08em]"
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
