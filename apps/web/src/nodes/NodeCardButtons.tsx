import { isAgentic, type Node } from '@ace/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
  cn,
} from '@ace/ui';
import { useContext, useState } from 'react';

import { RUN_GOING_TITLE, useRunGoing } from '../runs/hooks';
import { AgenticMenuItems, RevertStepDialog } from './AgenticCardMenu';
import { NodeActionsContext } from './card-context';
import { isStageKind } from './anchors';

/** A card's icon button: 22px, the theme's hairline pill, its icon in the muted ink. */
const BUTTON =
  'nodrag nopan flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--muted)] outline-none hover:border-[#ef6b3f] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)] data-[state=open]:border-[#ef6b3f] data-[state=open]:text-[var(--ink)]';

/**
 * PG-1.2 (D360): every card's always-visible ⚙ Settings and ⋯ More, top right. More holds the
 * node's actions — Open in Domain (Agent and Model), Connect to… (the route for trackpads and touch,
 * D350), Duplicate, Delete and Run from here. Read-only (FR-MOB-003) keeps only what does not edit.
 * Outside a Canvas there are no actions to take, so nothing is drawn.
 */
export function NodeCardButtons({ node, className }: { node: Node; className?: string }) {
  const actions = useContext(NodeActionsContext);
  /*
   * The menu is mounted on first use: 200 cards each holding a Radix menu cost the 200-node pan
   * (TC-NFR-001) a third of its frame rate. Until then More is a plain button that opens it.
   */
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // D382: the Revert step confirm outlives the menu that opened it.
  const [revert, setRevert] = useState<{ projectId: string; checkpointId: string }>();
  if (actions === undefined) return null;
  const { readOnly } = actions;
  const name = node.name || 'node';
  // D378: Open in Forge / Revert step belong to a node that works in the project, and need a router.
  const agentic =
    node.kind === 'agent' && isAgentic(node.config) && actions.openInDomain !== undefined;
  const moreButton = (
    <button
      type="button"
      aria-label="More"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      title={`More actions for ${name}`}
      data-testid={`node-more-${node.id}`}
      className={BUTTON}
      onClick={(event) => {
        event.stopPropagation();
        if (!menuMounted) {
          setMenuMounted(true);
          setMenuOpen(true);
        }
      }}
    >
      <Icons.MoreHorizontal aria-hidden size={13} strokeWidth={2} />
    </button>
  );
  return (
    <div
      data-testid={`node-buttons-${node.id}`}
      className={cn('ace-card-buttons absolute z-[1] flex items-center gap-[4px]', className)}
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
      {menuMounted ? (
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>{moreButton}</DropdownMenuTrigger>
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
            {agentic && (
              <AgenticMenuItems
                workflowId={node.workflowId}
                nodeId={node.id}
                onRevert={(projectId, checkpointId) => setRevert({ projectId, checkpointId })}
              />
            )}
            {!readOnly && (
              <>
                <DropdownMenuItem onSelect={() => actions.connectTo(node.id)}>
                  Connect to…
                </DropdownMenuItem>
                {actions.runAfter !== undefined && (
                  <DropdownMenuItem
                    aria-label={`Run ${name} after another node`}
                    onSelect={() => actions.runAfter?.(node.id)}
                  >
                    Run after…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => actions.duplicate(node.id)}>
                  Duplicate
                </DropdownMenuItem>
                <RunFromHereItem
                  workflowId={node.workflowId}
                  onSelect={() => actions.runFromHere(node.id)}
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => actions.remove(node.id)}>
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        moreButton
      )}
      {revert !== undefined && (
        <RevertStepDialog
          projectId={revert.projectId}
          checkpointId={revert.checkpointId}
          onClose={() => setRevert(undefined)}
        />
      )}
    </div>
  );
}

/**
 * [audit W-8] "Run from here" starts a new run, so while one is going it waits, saying why — a
 * second run would go beside the first. Its own component: only an open menu subscribes to the run.
 */
function RunFromHereItem({ workflowId, onSelect }: { workflowId: string; onSelect: () => void }) {
  const going = useRunGoing(workflowId);
  return (
    <DropdownMenuItem
      disabled={going}
      {...(going ? { title: RUN_GOING_TITLE } : {})}
      onSelect={onSelect}
    >
      Run from here
    </DropdownMenuItem>
  );
}
