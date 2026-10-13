import { create } from 'zustand';

/** One read-only "<file> (agent change)" tab: a file of a checkpoint (D300 §5.3). */
export interface Review {
  key: string;
  checkpointId: string;
  path: string;
}

export interface ProjectReviews {
  reviews: Review[];
  /** The review the editor area shows instead of the active file; none shows the file. */
  active: string | undefined;
}

export const NO_REVIEWS: ProjectReviews = { reviews: [], active: undefined };

export const reviewKey = (checkpointId: string, path: string): string => `${checkpointId}:${path}`;

interface ReviewState {
  projects: Record<string, ProjectReviews>;
  /** Opens the review tab (or brings it forward) and shows it. */
  open(projectId: string, checkpointId: string, path: string): void;
  activate(projectId: string, key: string): void;
  /** A file tab took the editor area: the reviews stay open, behind it. */
  deactivate(projectId: string): void;
  close(projectId: string, key: string): void;
}

/**
 * The editor area's review tabs (D300), beside the file tabs and outside every component, as the
 * editor store is, so a mode switch never closes them.
 */
export const useReviewStore = create<ReviewState>()((set) => {
  const update = (projectId: string, change: (reviews: ProjectReviews) => ProjectReviews) =>
    set((state) => ({
      projects: {
        ...state.projects,
        [projectId]: change(state.projects[projectId] ?? NO_REVIEWS),
      },
    }));

  return {
    projects: {},

    open: (projectId, checkpointId, path) =>
      update(projectId, (current) => {
        const key = reviewKey(checkpointId, path);
        const reviews = current.reviews.some((review) => review.key === key)
          ? current.reviews
          : [...current.reviews, { key, checkpointId, path }];
        return { reviews, active: key };
      }),

    activate: (projectId, key) =>
      update(projectId, (current) =>
        current.reviews.some((review) => review.key === key)
          ? { ...current, active: key }
          : current,
      ),

    deactivate: (projectId) =>
      update(projectId, (current) =>
        current.active === undefined ? current : { ...current, active: undefined },
      ),

    close: (projectId, key) =>
      update(projectId, (current) => {
        const index = current.reviews.findIndex((review) => review.key === key);
        if (index === -1) return current;
        const reviews = current.reviews.filter((review) => review.key !== key);
        if (current.active !== key) return { ...current, reviews };
        // the neighbour takes over, as a closed file tab's does; none left shows the file again
        const next = reviews[index] ?? reviews[index - 1];
        return { reviews, active: next?.key };
      }),
  };
});

export const useProjectReviews = (projectId: string): ProjectReviews =>
  useReviewStore((state) => state.projects[projectId] ?? NO_REVIEWS);
