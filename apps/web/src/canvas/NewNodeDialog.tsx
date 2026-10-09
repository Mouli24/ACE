import type { Model, Provider } from '@ace/contracts';
import { Button, Input, PROVIDER_STATE_LABEL, cn } from '@ace/ui';
import { Braces, Plus, Search, Shield, X, type LucideIcon } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { KIND_ICON, NodeCardView } from '../nodes/NodeCard';
import {
  NODE_KIND_LABEL,
  PALETTE_NODE_KINDS,
  applyNewNodeInit,
  createNode,
  type CanvasNodeKind,
  type NewNodeInit,
} from '../nodes/factory';
import { modelsByProvider, useModels, useProviders } from '../providers/hooks';

import { PALETTE_DRAG_TYPE, PALETTE_INIT_TYPE } from './drag';

export interface NewNodeDialogProps {
  workflowId: string;
  /** Shown in the eyebrow, so the user knows which workflow the node lands in. */
  workflowName: string;
  open: boolean;
  onClose: () => void;
  /** Click-to-add (double-click, Enter, the CTA). The dialog calls `onClose()` right after. */
  onAdd: (kind: CanvasNodeKind, init: NewNodeInit) => void;
}

/** Kinds the list shows but cannot place yet (Rounds 6+). */
type LaterKind = 'guardrail' | 'custom';
type ListKind = CanvasNodeKind | LaterKind;

const LATER: Readonly<Record<LaterKind, { label: string; icon: LucideIcon; round: string }>> = {
  guardrail: { label: 'Guardrail', icon: Shield, round: 'Round 6+' },
  custom: { label: 'Custom', icon: Braces, round: 'Round 6+' },
};

/** One line per kind; the placeable ones keep the old palette's wording. */
const DESCRIPTION: Readonly<Record<ListKind, string>> = {
  input: 'Text or files the run starts from',
  agent: 'An AI model working toward the goal you give it',
  model: 'A bare model call',
  output: 'Marks the end; shows the final result',
  merge: 'Waits for all or any inputs',
  transform: 'Template, extract JSON field, join',
  retrieval: 'Searches a knowledge base; hits out as JSON',
  guardrail: 'A check as its own step',
  custom: 'Your own node type',
};

/** The longer story, under the preview. */
const LONG: Readonly<Record<CanvasNodeKind, string>> = {
  input:
    'Where a run begins. Type the brief or drop files — they travel downstream as artifact references, never as pasted history.',
  agent:
    'Pick a model and give it a goal. Run the workflow and its answer appears in the chat column, where you can keep talking to it. Connect agents to hand one’s result to the next.',
  model:
    'One bare model call — no instructions, no tools. Good for a quick classify or rewrite step.',
  merge: 'Waits for all — or any — of its inputs, then hands one envelope downstream.',
  transform:
    'No model involved. Fill a template, pull a JSON field or join parts, the same way every time.',
  output: 'Marks the end of the run and shows the final result right on the canvas.',
  retrieval:
    'Searches one of the project’s knowledge bases and hands the hits downstream as JSON, labelled untrusted.',
};

/**
 * D285: the Canvas offers one node — an Agent with a goal. The input, output, model, merge,
 * transform and retrieval kinds are no longer added from here; workflows that have them keep them.
 */
const GROUPS: ReadonlyArray<{ label: string; kinds: readonly ListKind[] }> = [
  { label: 'Nodes', kinds: PALETTE_NODE_KINDS },
];

const isPlaceable = (kind: ListKind): kind is CanvasNodeKind =>
  (PALETTE_NODE_KINDS as readonly string[]).includes(kind);

const labelOf = (kind: ListKind): string =>
  isPlaceable(kind) ? NODE_KIND_LABEL[kind] : LATER[kind].label;

const matches = (kind: ListKind, query: string): boolean =>
  query === '' ||
  labelOf(kind).toLowerCase().includes(query) ||
  DESCRIPTION[kind].toLowerCase().includes(query);

/** The kinds that can be chosen with the current search, in list order (↑/↓ walk this). */
const choosableKinds = (query: string): CanvasNodeKind[] =>
  GROUPS.flatMap((group) => group.kinds)
    .filter(isPlaceable)
    .filter((kind) => matches(kind, query));

const isModelKind = (kind: CanvasNodeKind): boolean => kind === 'agent' || kind === 'model';

const mix = (colour: string, percent: number, base: string): string =>
  `color-mix(in oklab, ${colour} ${percent}%, ${base})`;

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** The preview is a picture of the node, not a second set of ports to tab through or drag from. */
const makeInert = (element: HTMLElement | null): void => element?.setAttribute('inert', '');

const EYEBROW = 'font-machine text-[9px] uppercase tracking-[0.22em] text-fg-faint';
const NO_PORTS = new Set<string>();

/**
 * The New node dialog (FR-CAN-002, FR-NODE-001): the node palette as a window over the Canvas.
 * Choose a kind (click, ↑/↓), name it, pick a provider and model for Agent/Model, then add it with
 * Enter, a double-click or the CTA — or drag the kind onto the Canvas to drop it where you let go.
 *
 * Not a Radix Dialog: Radix's modal sets `pointer-events: none` on <body>, which would swallow the
 * drop on the Canvas. This overlay traps Tab itself, and turns `pointer-events-none` as soon as a
 * drag starts so the Canvas underneath receives the drop.
 */
export function NewNodeDialog(props: NewNodeDialogProps): JSX.Element | null {
  // The last kind chosen survives a close, so reopening lands where the user left off.
  const lastKind = useRef<CanvasNodeKind>('agent');
  if (!props.open) return null;
  return createPortal(<NewNodeWindow {...props} lastKind={lastKind} />, document.body);
}

interface NewNodeWindowProps extends Omit<NewNodeDialogProps, 'open'> {
  lastKind: MutableRefObject<CanvasNodeKind>;
}

/** Mounted only while open, so the name, search and provider picks start fresh each time. */
function NewNodeWindow({
  workflowId,
  workflowName,
  onClose,
  onAdd,
  lastKind,
}: NewNodeWindowProps): JSX.Element {
  const [kind, setKind] = useState<CanvasNodeKind>(lastKind.current);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [pickedProviderId, setPickedProviderId] = useState<string>();
  const [pickedModelId, setPickedModelId] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  // Focus the search on open; hand focus back to whatever opened the dialog on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  /* ---------------------------------------------------------------- provider and model */

  const providerQuery = useProviders();
  const providers = providerQuery.data ?? [];
  const models = useModels().data?.items;
  const byProvider = useMemo(() => modelsByProvider(models ?? []), [models]);
  const defaultProvider = providers.find((each) => each.status === 'CONNECTED') ?? providers[0];
  const provider = providers.find((each) => each.id === pickedProviderId) ?? defaultProvider;
  const providerModels = provider === undefined ? [] : (byProvider.get(provider.id) ?? []);
  const model =
    providerModels.find((each) => each.available && each.modelId === pickedModelId) ??
    providerModels.find((each) => each.available);

  const pickProvider = (id: string) => {
    setPickedProviderId(id);
    setPickedModelId(undefined);
  };

  /* ---------------------------------------------------------------- the would-be node */

  const choose = (next: CanvasNodeKind) => {
    lastKind.current = next;
    setKind(next);
  };

  const initFor = (target: CanvasNodeKind): NewNodeInit => {
    const init: NewNodeInit = {};
    const trimmed = name.trim();
    if (trimmed !== '') init.name = trimmed;
    if (isModelKind(target) && provider !== undefined) {
      init.providerId = provider.id;
      if (model !== undefined) init.modelId = model.modelId;
    }
    return init;
  };

  const blank = useMemo(() => createNode(kind, workflowId, { x: 0, y: 0 }), [kind, workflowId]);
  const preview = applyNewNodeInit(blank, initFor(kind));
  const showsProvider = isModelKind(kind);

  // the kinds the search leaves choosable; with none, nothing can be added (the old choice is hidden)
  const choosable = choosableKinds(query.trim().toLowerCase());
  const nothingMatches = choosable.length === 0;

  const accent =
    !nothingMatches && showsProvider && provider !== undefined
      ? `var(--color-provider-${provider.type})`
      : 'var(--color-fg-soft)';

  const add = (target: CanvasNodeKind) => {
    onAdd(target, initFor(target));
    onClose();
  };

  /* ---------------------------------------------------------------- search and keys */

  const onQuery = (value: string) => {
    setQuery(value);
    const visible = choosableKinds(value.trim().toLowerCase());
    const first = visible[0];
    if (first !== undefined && !visible.includes(kind)) choose(first);
  };

  const listKindOf = (element: HTMLElement): CanvasNodeKind | undefined => {
    const value = element.dataset['nodeKind'];
    return value !== undefined && isPlaceable(value as ListKind)
      ? (value as CanvasNodeKind)
      : undefined;
  };

  const moveChoice = (delta: 1 | -1, from: HTMLElement) => {
    const fromItem = listKindOf(from);
    const index = choosable.indexOf(fromItem ?? kind);
    const count = choosable.length;
    if (count === 0) return;
    const next =
      index < 0 ? choosable[delta > 0 ? 0 : count - 1] : choosable[(index + delta + count) % count];
    if (next === undefined) return;
    choose(next);
    // a keyboard user walking the list keeps their place in it
    if (fromItem !== undefined) {
      windowRef.current?.querySelector<HTMLElement>(`[data-node-kind="${next}"]`)?.focus();
    }
  };

  /** Tab and Shift+Tab cycle through the window's own stops and never leave it. */
  const cycleFocus = (delta: 1 | -1) => {
    const root = windowRef.current;
    if (!root) return;
    const stops = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.closest('[inert]') === null,
    );
    const count = stops.length;
    if (count === 0) return;
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next =
      index < 0 ? stops[delta > 0 ? 0 : count - 1] : stops[(index + delta + count) % count];
    next?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The Canvas listens on window for its shortcuts (F, Ctrl+Z, Ctrl+D…); none apply under a modal.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    const inTextarea = target.tagName === 'TEXTAREA';
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        return;
      case 'Tab':
        event.preventDefault();
        cycleFocus(event.shiftKey ? -1 : 1);
        return;
      case 'ArrowDown':
      case 'ArrowUp':
        if (inTextarea) return;
        event.preventDefault();
        moveChoice(event.key === 'ArrowDown' ? 1 : -1, target);
        return;
      case 'Enter': {
        if (inTextarea) return;
        const itemKind = listKindOf(target);
        // Close, Cancel, the CTA, provider and model buttons keep their own Enter
        if (target.tagName === 'BUTTON' && itemKind === undefined) return;
        event.preventDefault();
        // a search that hides every kind leaves nothing to add, not the stale choice
        if (itemKind === undefined && nothingMatches) return;
        add(itemKind ?? kind);
        return;
      }
      default:
    }
  };

  /* ---------------------------------------------------------------- drag to the Canvas */

  const onDragStart = (event: DragEvent<HTMLButtonElement>, dragged: CanvasNodeKind) => {
    choose(dragged);
    event.dataTransfer.setData(PALETTE_DRAG_TYPE, dragged);
    event.dataTransfer.setData(PALETTE_INIT_TYPE, JSON.stringify(initFor(dragged)));
    event.dataTransfer.effectAllowed = 'move';
    // from here on every pointer event — the drop included — goes to the Canvas underneath
    setDragging(true);
  };

  const onDragEnd = () => {
    setDragging(false);
    onClose();
  };

  const onOverlayPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  /* ---------------------------------------------------------------- render */

  const groups = GROUPS.map((group) => ({
    ...group,
    kinds: group.kinds.filter((each) => matches(each, query.trim().toLowerCase())),
  })).filter((group) => group.kinds.length > 0);

  const chosenItem: CSSProperties = {
    borderColor: mix(accent, 45, 'var(--color-border)'),
    background: mix(accent, 7, 'var(--color-card)'),
    boxShadow: `0 0 26px -10px ${mix(accent, 55, 'transparent')}`,
  };
  const chosenTile: CSSProperties = {
    borderColor: mix(accent, 40, 'var(--color-border)'),
    background: mix(accent, 14, 'transparent'),
    color: accent,
  };
  const ports = [
    ...preview.inputs.map((port) => ({ port, dir: '←' })),
    ...preview.outputs.map((port) => ({ port, dir: '→' })),
  ];
  const fade = dragging && 'pointer-events-none opacity-0';

  return (
    <div
      data-testid="new-node-overlay"
      onPointerDown={onOverlayPointerDown}
      className={cn(
        'fixed inset-0 z-[100] grid place-items-center p-7 font-human text-fg',
        'bg-[color-mix(in_oklab,var(--color-canvas)_70%,transparent)] backdrop-blur-[8px]',
        'transition-opacity duration-150',
        fade,
      )}
    >
      <div
        ref={windowRef}
        role="dialog"
        aria-modal="true"
        aria-label="New node"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          boxShadow: `0 0 0 1px var(--ace-hi), 0 50px 120px -40px #000000, 0 0 120px -30px color-mix(in oklab, ${accent} calc(40% * var(--ace-glow-k)), transparent)`,
        }}
        className={cn(
          'grid h-[min(660px,100%)] w-[min(1040px,100%)] grid-rows-[auto_minmax(0,1fr)_auto]',
          'overflow-hidden rounded-[22px] border border-border-strong bg-panel outline-none',
          'transition-[opacity,box-shadow] duration-300',
          fade,
        )}
      >
        {/* ------------------------------------------------------------ header */}
        <div className="flex items-center gap-[18px] border-b border-border pb-[18px] pl-[26px] pr-[22px] pt-[22px]">
          <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>Add to · {workflowName}</span>
            <h2 className="text-[28px] font-semibold leading-none tracking-[-0.01em]">New node</h2>
          </div>
          <div className="flex-1" />
          <label
            className={cn(
              'flex h-[38px] w-[min(280px,40vw)] items-center gap-[9px] rounded-chip border border-border',
              'bg-card px-3.5 text-fg-muted focus-within:border-selection',
            )}
          >
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Search node types"
              aria-label="Search node types"
              className={cn(
                'min-w-0 flex-1 border-0 bg-transparent font-machine text-[12px] text-fg outline-none',
                'placeholder:text-fg-faint [&::-webkit-search-cancel-button]:appearance-none',
              )}
            />
          </label>
          <button
            type="button"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
            className={cn(
              'grid h-[38px] w-[38px] place-items-center rounded-full border border-border text-fg-muted',
              'transition-colors hover:border-border-strong hover:text-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection',
            )}
          >
            <X className="h-[13px] w-[13px]" strokeWidth={2.4} aria-hidden />
          </button>
        </div>

        {/* ------------------------------------------------------------ body */}
        <div className="grid min-h-0 grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
          {/* the kinds — labelled as the old left palette was, so tests can scope to it */}
          <div
            role="group"
            aria-label="Node palette"
            className="flex flex-col gap-4 overflow-y-auto border-r border-border px-3 pb-[18px] pt-4"
          >
            {groups.map((group, index) => {
              const labelId = `${ids}-group-${index}`;
              return (
                <div
                  key={group.label}
                  role="group"
                  aria-labelledby={labelId}
                  className="flex flex-col gap-[3px]"
                >
                  <span id={labelId} className={cn(EYEBROW, 'px-2.5 pb-1.5')}>
                    {group.label}
                  </span>
                  {group.kinds.map((each) => {
                    if (!isPlaceable(each)) {
                      const later = LATER[each];
                      return (
                        <KindItem
                          key={each}
                          kind={each}
                          icon={later.icon}
                          tag={later.round}
                          title={`${later.label} nodes arrive in ${later.round}`}
                        />
                      );
                    }
                    const on = each === kind;
                    return (
                      <KindItem
                        key={each}
                        kind={each}
                        icon={KIND_ICON[each]}
                        chosen={on}
                        itemStyle={on ? chosenItem : undefined}
                        tileStyle={on ? chosenTile : undefined}
                        title={`Add ${NODE_KIND_LABEL[each]} node (double-click, Enter, or drag onto the Canvas)`}
                        onClick={() => choose(each)}
                        onDoubleClick={() => add(each)}
                        onDragStart={(event) => onDragStart(event, each)}
                        onDragEnd={onDragEnd}
                      />
                    );
                  })}
                </div>
              );
            })}
            {groups.length === 0 && (
              <p className="mx-2.5 my-2 italic text-fg-muted">No node type matches that.</p>
            )}
          </div>

          {/* the would-be node — when the window is shorter than the preview (200 % zoom) the
              column scrolls, keeping the details at least 160 px tall, rather than spilling over
              the footer and its Add button */}
          <div
            data-testid="new-node-details"
            className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(160px,1fr)] overflow-y-auto"
          >
            <div
              className="relative grid h-[236px] place-items-center border-b border-border bg-canvas"
              style={{
                backgroundImage: `radial-gradient(var(--color-canvas-dot) 1.1px, transparent 1.2px), radial-gradient(ellipse at center, ${mix(accent, 12, 'transparent')}, transparent 62%)`,
                backgroundSize: '20px 20px, 100% 100%',
              }}
            >
              <span className={cn(EYEBROW, 'absolute left-[18px] top-3.5')}>Preview</span>
              <span className="absolute right-[18px] top-3.5 font-machine text-[9.5px] text-fg-faint">
                lands at the centre of your view
              </span>
              {nothingMatches ? (
                <p className="m-0 font-machine text-[11px] text-fg-faint">Nothing to preview</p>
              ) : (
                <div ref={makeInert} aria-hidden className="pointer-events-none">
                  {/* `preview`: static port dots, so no React Flow handles and no flow store */}
                  <NodeCardView
                    node={preview}
                    state="IDLE"
                    selected={false}
                    connectedPortIds={NO_PORTS}
                    provider={showsProvider ? provider?.type : undefined}
                    preview
                  />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-[18px] overflow-y-auto px-[26px] pb-[22px] pt-5">
              {nothingMatches ? (
                <p className="m-0 max-w-[56ch] text-[16px] italic leading-[1.5] text-fg-muted">
                  Nothing to add — clear the search or try another word.
                </p>
              ) : (
                <>
                  <p className="m-0 max-w-[56ch] text-[16px] leading-[1.5] text-fg-soft [text-wrap:pretty]">
                    {LONG[kind]}
                  </p>

                  <label className="flex flex-col gap-[7px]">
                    <span className={EYEBROW}>Name</span>
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={NODE_KIND_LABEL[kind]}
                      className="h-[42px] max-w-[420px] rounded-[12px] px-3.5 text-[17px]"
                    />
                  </label>

                  {showsProvider && (
                    <>
                      <Section id={`${ids}-provider`} label="Provider">
                        {providers.length === 0 ? (
                          <p className="m-0 text-[14px] italic text-fg-muted">
                            {providerQuery.data === undefined
                              ? 'Loading providers…'
                              : 'No providers yet — add one on the Providers screen.'}
                          </p>
                        ) : (
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-2">
                            {providers.map((each) => (
                              <ProviderCard
                                key={each.id}
                                provider={each}
                                models={byProvider.get(each.id) ?? []}
                                chosen={each.id === provider?.id}
                                onPick={() => pickProvider(each.id)}
                              />
                            ))}
                          </div>
                        )}
                      </Section>
                      {provider !== undefined && (
                        <Section id={`${ids}-model`} label="Model">
                          {providerModels.length === 0 ? (
                            <p className="m-0 text-[14px] italic text-fg-muted">
                              {models === undefined
                                ? 'Loading models…'
                                : `No models listed for ${provider.name} yet.`}
                            </p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {providerModels.map((each) => (
                                <ModelChip
                                  key={each.id}
                                  model={each}
                                  chosen={each.id === model?.id}
                                  accent={accent}
                                  onPick={() => setPickedModelId(each.modelId)}
                                />
                              ))}
                            </div>
                          )}
                        </Section>
                      )}
                    </>
                  )}

                  <Section id={`${ids}-ports`} label="Ports">
                    <div className="flex flex-wrap gap-1.5">
                      {ports.map(({ port, dir }) => (
                        <span
                          key={port.id}
                          className="inline-flex h-[26px] items-center gap-1.5 rounded-chip border border-border px-[11px] font-machine text-[10.5px] text-fg-soft"
                        >
                          {dir} {port.name}
                          <span className="text-fg-faint">
                            {port.dataType}
                            {port.multi ? ' · many' : ''}
                          </span>
                        </span>
                      ))}
                    </div>
                  </Section>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------ footer */}
        <div className="flex items-center gap-2.5 border-t border-border bg-card py-3.5 pl-[26px] pr-[18px]">
          <span className="font-machine text-[10px] tracking-[0.04em] text-fg-faint">
            ↑ ↓ choose · Enter add · Esc close
          </span>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="new-node-add"
            className="pl-3.5 pr-[18px]"
            disabled={nothingMatches}
            onClick={() => add(kind)}
          >
            <Plus className="h-3 w-3" strokeWidth={2.6} aria-hidden />
            {nothingMatches
              ? 'Add to canvas'
              : `Add ${NODE_KIND_LABEL[kind].toLowerCase()} to canvas`}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One kind in the list. Placeable kinds choose on click, add on double-click and drag out. */
function KindItem({
  kind,
  icon: Icon,
  chosen,
  tag,
  title,
  itemStyle,
  tileStyle,
  onClick,
  onDoubleClick,
  onDragStart,
  onDragEnd,
}: {
  kind: ListKind;
  icon: LucideIcon;
  /** Undefined for a kind that cannot be placed yet. */
  chosen?: boolean;
  tag?: string;
  title: string;
  itemStyle?: CSSProperties | undefined;
  tileStyle?: CSSProperties | undefined;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
}) {
  const placeable = isPlaceable(kind);
  return (
    <button
      type="button"
      data-testid={`palette-${kind}`}
      data-node-kind={placeable ? kind : undefined}
      aria-pressed={placeable ? Boolean(chosen) : undefined}
      disabled={!placeable}
      draggable={placeable}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={itemStyle}
      className={cn(
        'flex w-full items-start gap-3 rounded-[12px] border border-transparent p-2.5 text-left',
        'transition-[background-color,border-color,box-shadow] duration-200',
        'cursor-grab hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection',
        'disabled:cursor-not-allowed disabled:opacity-[0.48] disabled:hover:bg-transparent',
      )}
    >
      <span
        style={tileStyle}
        className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] border border-border bg-card text-fg-soft"
      >
        <Icon className="h-4 w-4" strokeWidth={1.7} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-center gap-2">
          <span className="text-[16px] leading-[1.15]">{labelOf(kind)}</span>
          {tag !== undefined && (
            <span className="rounded-chip border border-border px-[7px] py-0.5 font-machine text-[8.5px] tracking-[0.1em] text-fg-faint">
              {tag}
            </span>
          )}
        </span>
        <span className="font-machine text-[10px] leading-[1.45] text-fg-muted">
          {DESCRIPTION[kind]}
        </span>
      </span>
    </button>
  );
}

/** A labelled block of the details column (Provider, Model, Ports). */
function Section({ id, label, children }: { id: string; label: string; children: JSX.Element }) {
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2">
      <span id={id} className={EYEBROW}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** A provider to run an Agent/Model on: its accent, its name, and how many models or its state. */
function ProviderCard({
  provider,
  models,
  chosen,
  onPick,
}: {
  provider: Provider;
  models: readonly Model[];
  chosen: boolean;
  onPick: () => void;
}) {
  const colour = `var(--color-provider-${provider.type})`;
  const connected = provider.status === 'CONNECTED';
  const available = models.filter((each) => each.available).length;
  const note = connected
    ? `${available} model${available === 1 ? '' : 's'}`
    : PROVIDER_STATE_LABEL[provider.status];
  return (
    <button
      type="button"
      aria-pressed={chosen}
      aria-label={`${provider.name}, ${note}`}
      onClick={onPick}
      style={
        chosen
          ? {
              borderColor: mix(colour, 55, 'var(--color-border)'),
              background: mix(colour, 9, 'var(--color-card)'),
              boxShadow: `0 0 24px -10px ${mix(colour, 60, 'transparent')}`,
            }
          : undefined
      }
      className={cn(
        'flex h-[52px] items-center gap-2.5 rounded-[12px] border border-border bg-card px-3',
        'transition-[border-color,background-color] duration-150 hover:border-border-strong',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection',
      )}
    >
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: colour, boxShadow: `0 0 10px ${mix(colour, 60, 'transparent')}` }}
      />
      <span className="flex min-w-0 flex-col gap-0.5 text-left">
        <span className="truncate text-[14.5px] leading-[1.15]">{provider.name}</span>
        <span
          className={cn('font-machine text-[9.5px]', connected && 'text-fg-faint')}
          style={
            connected ? undefined : { color: `var(--color-provider-status-${provider.status})` }
          }
        >
          {note}
        </span>
      </span>
    </button>
  );
}

/** One of the chosen provider's models; one it no longer offers stays listed, disabled. */
function ModelChip({
  model,
  chosen,
  accent,
  onPick,
}: {
  model: Model;
  chosen: boolean;
  accent: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      disabled={!model.available}
      title={model.available ? model.displayName : `${model.displayName} — unavailable`}
      onClick={onPick}
      style={
        chosen
          ? {
              borderColor: mix(accent, 55, 'var(--color-border)'),
              background: mix(accent, 12, 'transparent'),
              color: 'var(--color-fg)',
            }
          : undefined
      }
      className={cn(
        'h-[30px] rounded-chip border border-border px-[13px] font-machine text-[11px] text-fg-muted',
        'transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-fg-muted',
      )}
    >
      {model.modelId}
    </button>
  );
}
