import { ChangesCard } from '../forge/changes/ChangesCard';

/**
 * Where a chat turn's Changes card goes (D300/D302, design §5.3): Forge's `ChangesCard` for the
 * turn's checkpoint — its files with +/−, Review, Keep all and Revert all.
 */
export function ChangesCardSlot({
  projectId,
  checkpointId,
}: {
  projectId: string;
  checkpointId: string;
}) {
  return <ChangesCard projectId={projectId} checkpointId={checkpointId} />;
}
