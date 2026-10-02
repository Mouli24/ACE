import { TEMPLATE_IDS, type TemplateId } from '@ace/contracts';

/**
 * Where the first-run wizard is (FR-ONB-001: resumable). Kept in `sessionStorage`, so leaving for
 * the Providers screen or the guide and coming back resumes the same step with the same choices,
 * while a new browser session starts clean. Storage can be missing or refuse a write (a private
 * window, blocked site data); the wizard then simply does not resume.
 */

export type WizardStep = 1 | 2 | 3;

export interface WizardState {
  step: WizardStep;
  providerId?: string;
  templateId?: TemplateId;
  projectName: string;
  /** `undefined` until the user types one; until then the template's own question is offered. */
  question?: string;
}

export const WIZARD_STORAGE_KEY = 'ace.onboarding';

export const DEFAULT_PROJECT_NAME = 'My first project';

export const INITIAL_WIZARD_STATE: WizardState = { step: 1, projectName: DEFAULT_PROJECT_NAME };

/** The question each template's Input node is seeded with, offered as the first run's input. */
export const TEMPLATE_QUESTIONS: Readonly<Record<TemplateId, string>> = {
  'linear-chain': 'Summarise why envelopes beat raw chat history.',
  'review-fix': 'Write a short product announcement for offline mode.',
  'parallel-research': 'What should a small team know before adopting local models?',
  'rag-qa': 'What does ACE pass between nodes?',
};

const isTemplateId = (value: unknown): value is TemplateId =>
  typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value);

export function loadWizardState(): WizardState {
  try {
    const raw = sessionStorage.getItem(WIZARD_STORAGE_KEY);
    if (raw === null) return INITIAL_WIZARD_STATE;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const step = parsed['step'];
    const state: WizardState = {
      step: step === 2 || step === 3 ? step : 1,
      projectName:
        typeof parsed['projectName'] === 'string' ? parsed['projectName'] : DEFAULT_PROJECT_NAME,
    };
    if (typeof parsed['providerId'] === 'string') state.providerId = parsed['providerId'];
    if (isTemplateId(parsed['templateId'])) state.templateId = parsed['templateId'];
    if (typeof parsed['question'] === 'string') state.question = parsed['question'];
    // A step whose earlier choice is missing cannot be resumed; fall back to the one that is.
    if (state.step === 3 && state.templateId === undefined) state.step = 2;
    if (state.step >= 2 && state.providerId === undefined) state.step = 1;
    return state;
  } catch {
    return INITIAL_WIZARD_STATE;
  }
}

export function saveWizardState(state: WizardState): void {
  try {
    sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not resumable this time; the wizard itself still works.
  }
}

export function clearWizardState(): void {
  try {
    sessionStorage.removeItem(WIZARD_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
