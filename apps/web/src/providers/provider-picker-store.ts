import type { CapabilityNeeds, Id } from '@ace/contracts';
import { create } from 'zustand';

/** What the picker hands back: both halves, never one (PG-1.3, D351). */
export interface ProviderChoice {
  providerId: Id;
  modelId: string;
}

export interface ProviderChoiceRequest {
  /** The dialog's title; it always names the provider (e.g. "Choose a provider for the new node"). */
  title?: string;
  /** The confirm button's label — "Add node", "Duplicate", "Use this model". */
  confirmLabel?: string;
  /** Pre-selected, e.g. a duplicated node's own provider and model. */
  initial?: Partial<ProviderChoice>;
  /** What the node asks of its model (a schema, tools), so a model that cannot is marked (D353). */
  needs?: CapabilityNeeds;
  onChosen: (choice: ProviderChoice) => void;
  onCancel?: () => void;
}

interface ProviderPickerState {
  request: ProviderChoiceRequest | undefined;
  open(request: ProviderChoiceRequest): void;
  close(): void;
}

/**
 * PG-1.3 (D351): the one provider-first picker on the Canvas. Add node, a palette drop, Duplicate
 * and a card's "Choose a provider" ask it; a `ProviderPickerHost` mounted by the Canvas shows it.
 * Nothing is created until `onChosen` runs, and Cancel runs only `onCancel`.
 */
export const useProviderPicker = create<ProviderPickerState>((set) => ({
  request: undefined,
  open: (request) => set({ request }),
  close: () => set({ request: undefined }),
}));

export const requestProviderChoice = (request: ProviderChoiceRequest) =>
  useProviderPicker.getState().open(request);
