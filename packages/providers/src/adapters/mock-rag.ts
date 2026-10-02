import { SUMMARY_PROMPT_VERSION } from '@ace/engine';

/**
 * The mock provider's round 5 models (round 5 §2.10): `mock-embed`, `mock-cite`, `mock-memory` and
 * `mock-summary`. Pure functions, so the adapter stays a router and these are testable on their own.
 */

/* -------------------------------------------------------------------------- */
/* mock-embed — 64 dimensions, token hashing, a synonym table                  */
/* -------------------------------------------------------------------------- */

export const MOCK_EMBED_DIMENSIONS = 64;

/** FNV-1a over UTF-16 code units. Stable across processes. */
function fnv(input: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** Words that carry no meaning of their own; they never reach the vector. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'each',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'our',
  'should',
  'so',
  'that',
  'the',
  'this',
  'to',
  'up',
  'we',
  'will',
  'with',
  'you',
  'your',
]);

/** Light stemming: strip one of `ing`, `ed`, `es`, `s`, leaving at least three characters. */
export function stemToken(token: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

/**
 * The concept each group of synonyms resolves to. A group is built from the round 5 fixture corpus's
 * paraphrase pairs (`tests/acceptance/fixtures/round-5/`): the word the document uses, and the words
 * a question uses for the same idea. Both inflections are listed where the light stemmer would not
 * bring them together.
 */
const CONCEPT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  delay: [
    'postpone',
    'postponed',
    'defer',
    'deferred',
    'delay',
    'delayed',
    'reschedule',
    'rescheduled',
  ],
  plan: ['plan', 'planning', 'strategy', 'strategic', 'roadmap'],
  quarter: ['quarter', 'quarterly', 'ninety'],
  offsite: ['offsite', 'retreat', 'getaway'],
  autumn: ['autumn', 'fall'],
  purchase: ['purchase', 'buy', 'procure', 'acquire'],
  laptop: ['laptop', 'notebook', 'computer'],
  intern: ['intern', 'trainee', 'apprentice'],
  customer: ['customer', 'shopper', 'buyer', 'patron'],
  complain: ['complain', 'complained', 'complaint', 'grievance', 'gripe', 'objection'],
  checkout: ['checkout', 'payment'],
  page: ['page', 'screen'],
  slow: ['slow', 'slowly', 'sluggish', 'sluggishly'],
  shrink: ['shrink', 'reduce', 'cut', 'trim', 'lower', 'decrease', 'curb'],
  cost: ['bill', 'cost', 'expenditure', 'spend', 'spending'],
  idle: ['idle', 'unused', 'dormant', 'inactive'],
  server: ['server', 'machine', 'host', 'instance'],
  plant: ['plant', 'greenery', 'foliage', 'flora'],
  water: ['water', 'watering', 'irrigate', 'hydrate'],
  approve: ['approve', 'approval', 'endorse', 'endorsement', 'sign-off', 'signoff'],
  merge: ['merge', 'merged', 'integrate', 'integration'],
  before: ['before', 'prior', 'ahead', 'preceding'],
  rotate: ['rotate', 'rotation', 'renew', 'refresh', 'regenerate'],
  secret: ['key', 'password', 'credential', 'secret', 'token'],
  rollback: ['rollback', 'revert', 'reverting', 'undo', 'undoing', 'backout'],
  notify: ['announce', 'announced', 'notify', 'notified', 'alert', 'broadcast'],
  oncall: ['on-call', 'oncall', 'standby', 'pager'],
  channel: ['channel', 'chatroom'],
  release: ['release', 'deploy', 'deployment', 'ship', 'shipping'],
  mentorship: ['mentor', 'buddy', 'coach'],
  greet: ['meet', 'introduction', 'introduce'],
  huddle: ['stand-up', 'standup', 'huddle', 'scrum'],
  security: ['security', 'protection', 'safety'],
  training: ['train', 'training', 'course', 'workshop'],
  mandatory: ['mandatory', 'compulsory', 'obligatory'],
  leave: ['leave', 'holiday', 'vacation', 'pto', 'time-off'],
  entitle: ['receive', 'entitlement', 'allowance', 'quota'],
  year: ['year', 'yearly', 'annual', 'annually'],
  staff: ['staff', 'personnel', 'employee', 'worker'],
  remote: ['remote', 'home', 'telecommute', 'telecommuting', 'wfh'],
  permit: ['may', 'permit', 'permitted', 'allow', 'allowed'],
  claim: ['claim', 'outlay', 'expense'],
  refund: [
    'refund',
    'refunded',
    'reimburse',
    'reimbursed',
    'repay',
    'repayment',
    'repaid',
    'payback',
  ],
  day: ['day', 'turnaround'],
  offline: ['offline', 'disconnected'],
  sync: ['sync', 'syncs', 'synchronise', 'synchronisation', 'resynchronise', 'resynchronisation'],
  change: ['change', 'amend', 'modify', 'edit', 'alter'],
  address: ['address', 'location', 'postal'],
  invoice: ['invoice', 'statement', 'receipt'],
  pause: ['wait', 'pause', 'pauses', 'sleep'],
  grow: ['longer', 'lengthen', 'lengthening', 'growing', 'increasing', 'escalating'],
  fail: ['fail', 'failed', 'unsuccessful', 'unsuccessfully'],
  attempt: ['attempt', 'try', 'tries', 'tried', 'trial'],
  random: ['random', 'randomness', 'noise', 'entropy', 'stochastic'],
};

function buildConceptTable(): Record<string, string> {
  const table: Record<string, string> = {};
  for (const [concept, words] of Object.entries(CONCEPT_GROUPS)) {
    for (const word of words) {
      table[word] = concept;
      table[stemToken(word)] = concept;
    }
  }
  return table;
}

/** Synonym (raw or stemmed) to concept. Exported so the fixture README can say what resolves. */
export const MOCK_EMBED_CONCEPTS: Readonly<Record<string, string>> = buildConceptTable();

const TOKEN = /[a-z0-9-]+/g;

/** What a text becomes before hashing: lowercased tokens, stopwords dropped, stemmed, concept-mapped. */
export function mockEmbedTokens(text: string): string[] {
  const out: string[] = [];
  for (const token of text.toLowerCase().match(TOKEN) ?? []) {
    if (STOPWORDS.has(token)) continue;
    const stem = stemToken(token);
    const concept = Object.hasOwn(MOCK_EMBED_CONCEPTS, stem)
      ? MOCK_EMBED_CONCEPTS[stem]
      : Object.hasOwn(MOCK_EMBED_CONCEPTS, token)
        ? MOCK_EMBED_CONCEPTS[token]
        : stem;
    out.push(concept ?? stem);
  }
  return out;
}

/** 64 dimensions, L2-normalised, deterministic: same text, same vector, in any process. */
export function mockEmbed(text: string): number[] {
  const vector = new Array<number>(MOCK_EMBED_DIMENSIONS).fill(0);
  for (const concept of mockEmbedTokens(text)) {
    const h = fnv(concept);
    const dimension = h % MOCK_EMBED_DIMENSIONS;
    vector[dimension] = (vector[dimension] ?? 0) + (((h >>> 16) & 1) === 1 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    // No tokens at all: a fixed unit vector keeps "unit length" true for every input.
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

/* -------------------------------------------------------------------------- */
/* mock-cite                                                                   */
/* -------------------------------------------------------------------------- */

/** `- (<source>, score <n>) <text>` — the line the prompt manager renders per retrieved chunk. */
const RETRIEVED_LINE = /^- \((.+?), score [^)]*\) (.*)$/;

/** The text of the `### Retrieved` block: from its heading to the next heading, or the end. */
function retrievedBlock(prompt: string): string | undefined {
  const lines = prompt.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === '### Retrieved');
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3} /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  return /^.*?[.!?](?=\s|$)/s.exec(trimmed)?.[0] ?? trimmed;
}

/**
 * `According to [source: <first source>], <first sentence of that chunk>` — or `I found no
 * sources.` when the prompt carries no retrieved chunk (§2.10, FR-RAG-005).
 */
export function mockCiteAnswer(prompt: string): string {
  const block = retrievedBlock(prompt);
  for (const line of block?.split('\n') ?? []) {
    const match = RETRIEVED_LINE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return `According to [source: ${match[1]}], ${firstSentence(match[2])}`;
    }
  }
  return 'I found no sources.';
}

/* -------------------------------------------------------------------------- */
/* mock-memory                                                                 */
/* -------------------------------------------------------------------------- */

const INPUT_HEADING = '## Input';

/**
 * The node's input as the model sees it: the `## Input` section of an assembled prompt without its
 * untrusted-content label lines, or the whole prompt when it is not an assembled one.
 */
export function inputOf(prompt: string): string {
  const lines = prompt.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line === INPUT_HEADING);
  if (start === -1) return prompt;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const section = end === -1 ? rest : rest.slice(0, end);
  // An untrusted block is "<label>:", the marker line, then the body: the body is the input.
  const marker = section.findIndex((line) => line.startsWith('UNTRUSTED CONTENT'));
  return (marker === -1 ? section : section.slice(marker + 1)).join('\n').trim();
}

/**
 * `{ answer: "Hello, <first word>.", __memory: [save user_name = <first word>] }` (§2.10, FR-MEM-002).
 * An input with no word in it saves nothing.
 */
export function mockMemoryValue(prompt: string): { answer: string; __memory: unknown[] } {
  const word = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/u.exec(inputOf(prompt))?.[0];
  if (word === undefined) return { answer: 'Hello.', __memory: [] };
  return {
    answer: `Hello, ${word}.`,
    __memory: [{ op: 'save', key: 'user_name', value: word }],
  };
}

/* -------------------------------------------------------------------------- */
/* mock-summary                                                                */
/* -------------------------------------------------------------------------- */

export const MOCK_SUMMARY_WORDS = 30;

/** Whether this call is the summariser's: its system text carries the prompt-version marker. */
export function isSummaryCall(system: string | undefined): boolean {
  return system !== undefined && system.includes(SUMMARY_PROMPT_VERSION);
}

/** The first 30 words of the input (§2.10). */
export function mockSummaryText(prompt: string): string {
  return prompt.trim().split(/\s+/).slice(0, MOCK_SUMMARY_WORDS).join(' ');
}
