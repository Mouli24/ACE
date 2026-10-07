import type {
  EvidenceKind,
  NoteSource,
  ResponsibilityKind,
  ScanStatus,
  SuggestionStatus,
} from '@ace/contracts';

/** Words for the P2 enums (ACE parity P2, D280, D281), as the Suggestions and Notes pages show them. */

export const KIND_LABEL: Readonly<Record<ResponsibilityKind, string>> = {
  software_health: 'Software health',
  email: 'Email',
};

/** What each kind looks at — said before the user saves one (contract `RESPONSIBILITY_KINDS`). */
export const KIND_HINT: Readonly<Record<ResponsibilityKind, string>> = {
  software_health:
    'Looks at this project’s failing checks and failed tasks, and — when the repository has a GitHub remote and gh is signed in — its open issues and failed workflow runs.',
  email:
    'Looks at messages matching a search. This needs a mail connection, which this version of ACE does not have: a scan answers that it is not connected.',
};

export const SCAN_STATUS_LABEL: Readonly<Record<ScanStatus, string>> = {
  running: 'Scanning',
  completed: 'Last scan completed',
  failed: 'Last scan failed',
  cancelled: 'Last scan cancelled',
};

export const STATUS_LABEL: Readonly<Record<SuggestionStatus, string>> = {
  new: 'New',
  later: 'Later',
  accepted: 'Added to Inbox',
  dismissed: 'Dismissed',
};

export const EVIDENCE_LABEL: Readonly<Record<EvidenceKind, string>> = {
  failed_check: 'Failed check',
  failed_task: 'Failed task',
  github_issue: 'GitHub issue',
  github_run: 'GitHub workflow run',
};

export const NOTE_SOURCE_LABEL: Readonly<Record<NoteSource, string>> = {
  user: 'Written by you',
  task: 'Saved from a task',
  chat: 'Saved from a chat',
};

/** Watch intervals offered, in minutes; the contract allows 15 minutes to a day. */
export const WATCH_INTERVALS = [15, 30, 60, 120, 240, 480, 720, 1440] as const;

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return '1 hour';
  if (minutes % 60 === 0) return minutes === 1440 ? '24 hours' : `${minutes / 60} hours`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
