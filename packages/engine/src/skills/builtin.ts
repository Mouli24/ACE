import type { Id, Skill, Timestamp } from '@ace/contracts';

/**
 * The skills ACE ships with (D272). They are read-only — a user who wants to change one duplicates
 * it — and their ids are fixed, so an agent that enables one keeps it across installs, backups and
 * the mock engine (`apps/web/src/mocks/builtin-skills.ts` mirrors this list).
 *
 * When a built-in's name or instructions change in a release, its `version` goes up by one:
 * `ensureBuiltinSkills` replaces a stored copy with an older version, and the prompt version of
 * every agent using it changes with it (FR-PRM-001). A run that already started keeps the text it
 * froze (BR-04).
 */

export const BUILTIN_SKILL_IDS = {
  smallSafeChanges: '01K6SK00000000000000000001',
  testFirst: '01K6SK00000000000000000002',
  explainTheChange: '01K6SK00000000000000000003',
  followTheStyle: '01K6SK00000000000000000004',
  securityReview: '01K6SK00000000000000000005',
} as const satisfies Record<string, Id>;

/** When the built-ins were written: their `createdAt`, whatever day an install first stores them. */
export const BUILTIN_SKILLS_AT: Timestamp = '2026-10-07T00:00:00.000Z';

const builtin = (
  id: Id,
  name: string,
  description: string,
  instructions: readonly string[],
): Skill => ({
  id,
  name,
  description,
  instructions: instructions.join('\n'),
  version: 1,
  source: 'builtin',
  createdAt: BUILTIN_SKILLS_AT,
  updatedAt: BUILTIN_SKILLS_AT,
});

export const BUILTIN_SKILLS: readonly Skill[] = [
  builtin(
    BUILTIN_SKILL_IDS.smallSafeChanges,
    'Small, safe changes',
    'Make the smallest change that does the job, one reversible step at a time.',
    [
      'Work in small, reversible steps.',
      '- Change only what the task needs. Leave unrelated code, formatting and names as they are, even where you would have written them differently.',
      '- Prefer the smallest change that fully solves the problem over a broad rewrite. If a larger change really is necessary, say why before making it.',
      '- Keep every step working: the code should build and its tests should pass after each change, not only at the end.',
      '- Do not delete or rename public functions, files, settings or data formats unless the task asks for it. When you must, keep the old name working or say exactly what breaks.',
      '- Never run destructive commands (deleting files, rewriting history, dropping data) unless the task explicitly asks for them.',
      '- When you are unsure what a piece of code does, read it and its callers before changing it instead of guessing.',
    ],
  ),
  builtin(
    BUILTIN_SKILL_IDS.testFirst,
    'Test first',
    'Write a failing test that describes the change, then make it pass.',
    [
      'Prove the change with a test written before the change.',
      '1. Write a test for the behaviour the task asks for. Run it and check that it fails, and fails for the reason you expect: a test that passes before the change proves nothing.',
      '2. Make the smallest change that makes the test pass.',
      '3. Run the whole related test suite, not only the new test, and fix anything you broke.',
      '4. Tidy the code while every test stays green.',
      '- For a bug, the first test reproduces the bug.',
      '- Test behaviour through public interfaces rather than private details, so the test survives a refactor.',
      '- Cover the cases the task implies: empty input, boundary values and the error path.',
      '- Never weaken, skip or delete an existing test to make the suite pass. If a test is wrong, say why.',
      '- Report which tests you added and the result of the final run.',
    ],
  ),
  builtin(
    BUILTIN_SKILL_IDS.explainTheChange,
    'Explain the change',
    'Finish with a short, honest summary a reviewer can check quickly.',
    [
      'When you finish, explain what you changed so a reviewer can check it quickly. Write a short summary with:',
      '- What: the change in one or two sentences, in plain words.',
      '- Why: the problem it solves or the requirement it meets.',
      '- Where: the files or areas you changed, and anything you deliberately left alone.',
      '- How it was checked: the tests you ran or added and their result. Say plainly when something was not tested.',
      '- Risks and follow-ups: what could break, the assumptions you made, and anything left to do.',
      'Be concrete and honest. Do not claim something works unless you checked it, and mention anything you were unsure about.',
    ],
  ),
  builtin(
    BUILTIN_SKILL_IDS.followTheStyle,
    "Follow the codebase's style",
    'Write code that looks as if the existing team wrote it.',
    [
      'Make your change look as if the people who wrote this codebase made it.',
      '- Before writing code, read the files around the change and do what they do: naming, file layout, formatting, error handling, logging, comments and test style.',
      '- Reuse the helpers, libraries and patterns the project already has instead of adding new ones. Do not add a dependency unless the task needs it, and say so when you do.',
      '- Stay within the language and framework versions the project uses.',
      "- Keep the project's formatter and linter checks passing, with its own configuration.",
      '- Write comments and documentation in the voice and language of the text around them.',
      '- Where the existing style is inconsistent, follow the closest and most recent code.',
    ],
  ),
  builtin(
    BUILTIN_SKILL_IDS.securityReview,
    'Security review',
    'Check the work for security problems before calling it done.',
    [
      'Review the work for security problems before you call it done. Check at least:',
      '- Input: everything from users, files, the network or other programs is untrusted. Validate it, and never pass it unescaped into a shell command, an SQL query, a file path, an HTML page or a template.',
      '- Secrets: no keys, passwords or tokens in code, logs, error messages, test data or output. Read them from the configured secret store or the environment.',
      '- Access: every action checks that the caller may perform it, and nothing private is exposed.',
      '- Files and paths: no path escapes the folder it belongs to, and temporary files are cleaned up.',
      '- Dependencies: no new package without a reason; prefer maintained, widely used ones.',
      '- Errors: failures are handled without revealing internal details.',
      'Report each problem you find with where it is, why it matters and how to fix it, most severe first. If you find none, say what you checked.',
    ],
  ),
];
