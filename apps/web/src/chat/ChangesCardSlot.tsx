/**
 * Where a chat turn's Changes card goes (D300/D302, design §5.3). Track A builds the card as
 * `ChangesCard({ projectId, checkpointId })` in Forge's Changes; the merge replaces this adapter's
 * body with it. Until then a turn with a checkpoint renders nothing here — never an inert card.
 */
export function ChangesCardSlot(_props: { projectId: string; checkpointId: string }) {
  return null;
}
