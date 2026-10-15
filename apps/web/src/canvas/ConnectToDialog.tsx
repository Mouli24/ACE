import type { Node } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ace/ui';
import { useState } from 'react';

import { NODE_KIND_LABEL, type CanvasNodeKind } from '../nodes/factory';
import {
  connectChoices,
  portLabel,
  type CheckConnection,
  type ConnectChoice,
} from './interactions/ports';

const ROW =
  'flex w-full cursor-pointer items-center justify-between gap-3 rounded-[9px] border border-[var(--line)] bg-transparent px-3 py-2 text-left text-[13px] text-[var(--ink)] outline-none hover:border-[#ef6b3f] hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f]';

/**
 * PG-1.1 (D350): the node menu's "Connect to…" — for a trackpad or a touch screen, where drawing a
 * line from a dot is hard. Pick the node to send this node's output to; when more than one of its
 * inputs fits, pick which; when none does, the reason is said here, in the dialog.
 */
export function ConnectToDialog({
  nodes,
  fromNodeId,
  check,
  onConnect,
  onClose,
}: {
  nodes: readonly Node[];
  fromNodeId: string;
  check: CheckConnection;
  onConnect: (choice: ConnectChoice) => void;
  onClose: () => void;
}) {
  const from = nodes.find((node) => node.id === fromNodeId);
  const [choices, setChoices] = useState<ConnectChoice[]>();
  const [refusal, setRefusal] = useState<string>();
  const targets = nodes.filter((node) => node.id !== fromNodeId && node.inputs.length > 0);

  const pick = (toNodeId: string) => {
    const outcome = connectChoices(nodes, fromNodeId, toNodeId, check);
    if (outcome.kind === 'connect') {
      onConnect(outcome.choice);
      onClose();
      return;
    }
    setRefusal(outcome.kind === 'refuse' ? outcome.reason : undefined);
    setChoices(outcome.kind === 'choose' ? outcome.choices : undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="connect-to-dialog" className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Connect {from?.name || 'this node'} to…</DialogTitle>
          <DialogDescription>
            {choices === undefined
              ? 'Pick the node its output goes to.'
              : 'More than one input fits. Pick which one.'}
          </DialogDescription>
        </DialogHeader>
        {choices === undefined ? (
          <ul className="m-0 flex list-none flex-col gap-[6px] p-0" aria-label="Nodes">
            {targets.length === 0 && (
              <li className="text-[13px] text-[var(--muted)]">No other node takes an input.</li>
            )}
            {targets.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  className={ROW}
                  data-testid={`connect-to-${node.id}`}
                  onClick={() => pick(node.id)}
                >
                  <span className="min-w-0 truncate font-semibold">{node.name || 'Untitled'}</span>
                  <span className="shrink-0 font-machine text-[11px] text-[var(--muted)]">
                    {NODE_KIND_LABEL[node.kind as CanvasNodeKind] ?? node.kind}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-[6px] p-0" aria-label="Inputs">
            {choices.map((choice) => (
              <li key={`${choice.from.id}>${choice.to.id}`}>
                <button
                  type="button"
                  className={ROW}
                  onClick={() => {
                    onConnect(choice);
                    onClose();
                  }}
                >
                  {portLabel(choice.from, 'out')} → {portLabel(choice.to, 'in')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {refusal !== undefined && (
          <p role="alert" className="m-0 text-[12.5px] text-[var(--danger-ink)]">
            {refusal}
          </p>
        )}
        <DialogFooter>
          {choices !== undefined && (
            <Button variant="ghost" onClick={() => setChoices(undefined)}>
              Back
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
