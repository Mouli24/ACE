import { useReviewStore } from './review-store';

/**
 * Review one file of a checkpoint (D300 §5.3): a read-only "<file> (agent change)" tab in Forge's
 * editor area, before on the left and after on the right.
 */
export function openReview(projectId: string, checkpointId: string, path: string): void {
  useReviewStore.getState().open(projectId, checkpointId, path);
}
