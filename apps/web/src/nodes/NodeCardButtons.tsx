import type { Node } from '@ace/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
  cn,
} from '@ace/ui';
import { useContext } from 'react';

import { NodeActionsContext } from './card-context';
import { isStageKind } from './anchors';

/** A card's icon button: 22px, the theme's hairline pill, its icon in the muted ink. */
const BUTTON =
  'nodrag nopan flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--muted)] outline-none hover:border-[#ef6b3f] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] data-[state=open]:border-[#ef6b3f] data-[state=open]:text-[var(--ink)]';

/**
 * PG-1.2 (D360): every card's always-visible ⚙ Settings and ⋯ More, top right. More holds the
 * node's actions — Open in Domain (Agent and Model), Connect to… (the route for trackpads and touch,
 * D350), Duplicate, Delete and Run from here. Read-only (FR-MOB-003) keeps only what does not edit.
 * Outside a Canvas there are no actions to take, so nothing is drawn.
 */
export function NodeCardButtons({ node, className }: { node: Node; className?: string }) {
  const actions = useContext(NodeActionsContext);
  if (actions === undefined) return null;
  const { readOnly } = actions;
  const name = node.name || 'node';
  return (
    <div
      data-testid={`node-buttons-${node.id}`}
      className={cn('absolute z-[1] flex items-center gap-[4px]', className)}
    >
      {!readOnly && (
        <button
          type="button"
          aria-label="Settings"
          title={`Settings for ${name}`}
          data-testid={`node-settings-${node.id}`}
          className={BUTTON}
          onClick={(event) => {
            event.stopPropagation();
            actions.openSettings(node.id);
          }}
        >
          <Icons.Settings aria-hidden size={12} strokeWidth={2} />
        </button>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More"
            title={`More actions for ${name}`}
            data-testid={`node-more-${node.id}`}
            className={BUTTON}
            onClick={(event) => event.stopPropagation()}
          >
            <Icons.MoreHorizontal aria-hidden size={13} strokeWidth={2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          collisionPadding={8}
          aria-label={`Actions for ${name}`}
          data-testid={`node-more-menu-${node.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          {actions.openInDomain !== undefined && isStageKind(node.kind) && (
            <DropdownMenuItem onSelect={() => actions.openInDomain?.(node.id)}>
              Open in Domain
            </DropdownMenuItem>
          )}
          {!readOnly && (
            <>
              <DropdownMenuItem onSelect={() => actions.connectTo(node.id)}>
                Connect to…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.duplicate(node.id)}>
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.runFromHere(node.id)}>
                Run from here
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => actions.remove(node.id)}>
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
