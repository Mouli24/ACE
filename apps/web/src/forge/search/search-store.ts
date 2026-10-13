import type { FileSearchRequest } from '@ace/contracts';
import { create } from 'zustand';

/** What the Search view's boxes and toggles hold for one project. */
export interface SearchForm {
  query: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
}

export const EMPTY_SEARCH: SearchForm = {
  query: '',
  regex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
};

/**
 * Search's form per project (D299 Phase 4), kept outside the view so switching to the Explorer
 * and back — or to another project and back — finds the search as it was left, as in VS Code.
 */
export const useSearchStore = create<{
  byProject: Record<string, SearchForm>;
  update(projectId: string, change: Partial<SearchForm>): void;
}>()((set) => ({
  byProject: {},
  update: (projectId, change) =>
    set((state) => ({
      byProject: {
        ...state.byProject,
        [projectId]: { ...(state.byProject[projectId] ?? EMPTY_SEARCH), ...change },
      },
    })),
}));

/** The request a form asks for: only what is set, so an unchanged default never travels. */
export function requestOf(form: SearchForm): FileSearchRequest {
  const include = form.include.trim();
  const exclude = form.exclude.trim();
  return {
    query: form.query,
    ...(form.regex ? { regex: true } : {}),
    ...(form.matchCase ? { matchCase: true } : {}),
    ...(form.wholeWord ? { wholeWord: true } : {}),
    ...(include === '' ? {} : { include }),
    ...(exclude === '' ? {} : { exclude }),
  };
}
