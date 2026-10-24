# Debate falsification bench

Does a debate beat one agent? `scripts/live/debate-eval.ts` answers it on your own questions, with the real CLIs.

## The questions

`questions.jsonl` holds one question per line:

```json
{"id": "q1", "question": "…", "options": ["…", "…"], "answer": "…"}
```

- `options` is required for a question to be scored. A free-form question (no `options`) is skipped and counted as skipped.
- `answer` must be exactly one of the options. Scoring is exact match after trimming and lower-casing.
- The three items shipped here are marked `SAMPLE`. They exist for a smoke run only, so replace them before you draw a conclusion.

Pick about 30 questions where one agent scores roughly 50–80%. If the single agent already gets them all right, debate has nothing to show.

## Running it

```sh
pnpm exec tsx scripts/live/debate-eval.ts                # live: claude, codex and gemini debate; claude judges
pnpm exec tsx scripts/live/debate-eval.ts --single codex # the SINGLE arm on another CLI (default claude)
pnpm exec tsx scripts/live/debate-eval.ts --rounds 1     # rebuttal rounds, 1–4 (default 2)
pnpm exec tsx scripts/live/debate-eval.ts --fake         # the mock provider: no CLI, no cost, checks the script only
```

- **Live runs cost money.** They use real tokens on whatever accounts the three CLIs are signed in to.
- **Before running live:** every CLI must be installed and signed in.
- **Where results go:** each run writes `results-<timestamp>.json` next to this file.
