import type BetterSqlite3 from 'better-sqlite3';

import { appendContextChecks, backfillDefaultPolicies } from './default-policy.js';

/** Named so a test can apply the chain up to, but not including, round 3 (FR-GRD-018). */
export const ROUND_3_MIGRATION_ID = '20260926T120000_round_3_guardrails_approvals_and_budgets';

/**
 * Round 3's second migration in this package, and the reason it is a second one: the guardrails
 * migration above is written and tested, and rule 5 of CLAUDE.md §3.4 is that a migration is never
 * edited — a correction is a new migration. D104 preferred one migration per round per package, and
 * this is the exception that proves the older rule wins when the two disagree (D170).
 *
 * Named so a test can apply the chain up to, but not including, the run columns.
 */
export const ROUND_3_RUN_COLUMNS_MIGRATION_ID =
  '20260926T140000_round_3_run_controls_and_budget_halt';

/**
 * Round 4's tables (Arch §15.3): artifacts, tool calls, MCP servers, messages, chat threads and
 * chat messages. Named so a test can apply the chain up to, but not including, round 4.
 */
export const ROUND_4_MIGRATION_ID = '20260929T120000_round_4_artifacts_tools_messages_chat';

/**
 * Round 5's tables (Arch §15.3, §21.3): knowledge bases, documents, chunks, vectors, the FTS5
 * index, agent memory, the summary cache, the round 5 `node_runs` columns and DN-2's data step.
 * Named so a test can apply the chain up to, but not including, round 5.
 */
export const ROUND_5_MIGRATION_ID = '20261001T120000_round_5_knowledge_memory_usage';

/** X1 (D262): a CLI provider's permission preset. Named so a test can apply the chain before it. */
export const X1_CLI_PROVIDERS_MIGRATION_ID = '20261006T120000_x1_cli_providers';

/**
 * ACE parity P0 (D267–D271): a project's Build settings, and tasks with their workspaces,
 * executions, checks, reviews, deliveries and activity. Named so a test can apply the chain before
 * it.
 */
export const PARITY_P0_MIGRATION_ID = '20261006T180000_parity_p0_tasks';

/**
 * ACE parity P1 (D272, D273): installed skills and imported bundles. Named so a test can apply the
 * chain before it.
 */
export const PARITY_P1_SKILLS_MIGRATION_ID = '20261007T100000_parity_p1_skills';

/**
 * ACE parity P1 (D275–D278): a task's deliverable and source, a workspace's pull request, a
 * project's preview command and URL, and task schedules. Named so a test can apply the chain
 * before it.
 */
export const PARITY_P1_MIGRATION_ID = '20261007T100200_parity_p1_tasks';
export const PARITY_P2_MIGRATION_ID = '20261007T110000_parity_p2_suggestions';

/**
 * Forward-only migrations. Once a migration is on `main` it is never edited — a correction is a new
 * migration (CLAUDE.md §3.4 rule 5). Ids are timestamped so they apply in the order they were
 * written.
 */
export interface Migration {
  id: string;
  up: string;
  /**
   * An optional data step, run in the same transaction immediately after `up`.
   *
   * Some backfills cannot be written as SQL: the round 3 default policy needs fresh ULIDs and the
   * check list from `@ace/contracts`, and retyping that list as a SQL literal is exactly the second
   * copy that drifts. A function keeps one definition and still commits with the schema change, so
   * a database is never left with the new tables but not the rows they require.
   */
  seed?: (sqlite: BetterSqlite3.Database) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '20260921T120000_initial_schema',
    up: `
      CREATE TABLE projects (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        name          TEXT NOT NULL,
        folder_path   TEXT NOT NULL,
        last_opened_at TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX projects_workspace_idx ON projects (workspace_id, id);

      CREATE TABLE workflows (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        name           TEXT NOT NULL,
        version        INTEGER NOT NULL,
        format_version INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX workflows_project_idx ON workflows (workspace_id, project_id, id);

      CREATE TABLE nodes (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workflow_id  TEXT NOT NULL,
        kind         TEXT NOT NULL,
        name         TEXT NOT NULL,
        position_x   REAL NOT NULL,
        position_y   REAL NOT NULL,
        inputs       TEXT NOT NULL,
        outputs      TEXT NOT NULL,
        config       TEXT NOT NULL
      );
      CREATE INDEX nodes_workflow_idx ON nodes (workspace_id, workflow_id, id);

      CREATE TABLE edges (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workflow_id  TEXT NOT NULL,
        kind         TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        from_port_id TEXT NOT NULL,
        to_node_id   TEXT NOT NULL,
        to_port_id   TEXT NOT NULL,
        loop         TEXT
      );
      CREATE INDEX edges_workflow_idx ON edges (workspace_id, workflow_id, id);
      CREATE INDEX edges_from_idx ON edges (workspace_id, from_node_id);
      CREATE INDEX edges_to_idx ON edges (workspace_id, to_node_id);

      CREATE TABLE events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        type         TEXT NOT NULL,
        workflow_id  TEXT,
        run_id       TEXT,
        payload      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX events_workflow_idx ON events (workspace_id, workflow_id, seq);
      CREATE INDEX events_seq_idx ON events (workspace_id, seq);

      CREATE TABLE settings (
        workspace_id TEXT PRIMARY KEY,
        data         TEXT NOT NULL
      );
    `,
  },
  {
    id: '20260922T120000_round_2_providers_and_runs',
    up: `
      CREATE TABLE providers (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        type            TEXT NOT NULL,
        name            TEXT NOT NULL,
        base_url        TEXT,
        key_set         INTEGER NOT NULL,
        status          TEXT NOT NULL,
        status_message  TEXT,
        last_checked_at TEXT,
        concurrency     INTEGER NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX providers_workspace_idx ON providers (workspace_id, id);

      CREATE TABLE models (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        provider_id     TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        input_types     TEXT NOT NULL,
        output_types    TEXT NOT NULL,
        context_window  INTEGER NOT NULL,
        supports_tools  INTEGER NOT NULL,
        supports_json   INTEGER NOT NULL,
        available       INTEGER NOT NULL,
        source          TEXT NOT NULL,
        last_checked_at TEXT NOT NULL,
        pricing         TEXT
      );
      CREATE INDEX models_provider_idx ON models (workspace_id, provider_id, model_id);

      CREATE TABLE price_tables (
        workspace_id TEXT NOT NULL,
        version      TEXT NOT NULL,
        data         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (workspace_id, version)
      );

      CREATE TABLE runs (
        id               TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        workflow_id      TEXT NOT NULL,
        project_id       TEXT NOT NULL,
        status           TEXT NOT NULL,
        halt_reason      TEXT,
        snapshot         TEXT NOT NULL,
        inputs           TEXT NOT NULL,
        preflight_issues TEXT NOT NULL,
        totals           TEXT NOT NULL,
        started_at       TEXT NOT NULL,
        ended_at         TEXT,
        duration_ms      INTEGER,
        final_output     TEXT
      );
      CREATE INDEX runs_workflow_idx ON runs (workspace_id, workflow_id, id);
      CREATE INDEX runs_status_idx ON runs (workspace_id, status);

      CREATE TABLE node_runs (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        run_id          TEXT NOT NULL,
        node_id         TEXT NOT NULL,
        iteration       INTEGER NOT NULL,
        attempt         INTEGER NOT NULL,
        status          TEXT NOT NULL,
        failure_reason  TEXT,
        error           TEXT,
        model_used      TEXT,
        input_envelopes TEXT NOT NULL,
        output          TEXT,
        prompt          TEXT,
        usage           TEXT NOT NULL,
        verdicts        TEXT NOT NULL,
        tool_calls      TEXT NOT NULL,
        started_at      TEXT,
        ended_at        TEXT,
        duration_ms     INTEGER
      );
      CREATE INDEX node_runs_run_idx ON node_runs (workspace_id, run_id, id);
    `,
  },
  {
    id: ROUND_3_MIGRATION_ID,
    up: `
      -- One row per policy version: a PATCH inserts version + 1 and never rewrites what came
      -- before it, so the policy id and version a node run recorded still resolve years later
      -- (FR-GRD-001, FR-GRD-002, Arch 13.4, BR-04).
      CREATE TABLE guardrail_policies (
        id                 TEXT NOT NULL,
        workspace_id       TEXT NOT NULL,
        project_id         TEXT NOT NULL,
        name               TEXT NOT NULL,
        version            INTEGER NOT NULL,
        is_project_default INTEGER NOT NULL,
        checks             TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE INDEX guardrail_policies_project_idx
        ON guardrail_policies (workspace_id, project_id, id);
      -- One default per project is a constraint, not a convention (FR-GRD-018). Only the latest
      -- version of the default policy carries the flag, which is what keeps this index unique while
      -- the table holds every version.
      CREATE UNIQUE INDEX guardrail_policies_default_idx
        ON guardrail_policies (workspace_id, project_id) WHERE is_project_default = 1;

      -- No value column, ever: a verdict records the types it redacted, never the text (FR-GRD-014).
      CREATE TABLE guardrail_verdicts (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        node_run_id    TEXT NOT NULL,
        point          TEXT NOT NULL,
        check_type     TEXT NOT NULL,
        action         TEXT NOT NULL,
        passed         INTEGER NOT NULL,
        reason         TEXT NOT NULL,
        redacted_types TEXT,
        at             TEXT NOT NULL
      );
      CREATE INDEX guardrail_verdicts_node_run_idx
        ON guardrail_verdicts (workspace_id, node_run_id, id);

      CREATE TABLE approvals (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        node_run_id  TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        node_name    TEXT NOT NULL,
        point        TEXT NOT NULL,
        check_type   TEXT NOT NULL,
        reason       TEXT NOT NULL,
        preview      TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decision     TEXT,
        note         TEXT,
        decided_at   TEXT
      );
      CREATE INDEX approvals_run_idx ON approvals (workspace_id, run_id, decision);
      CREATE INDEX approvals_node_run_idx ON approvals (workspace_id, node_run_id, decision);

      -- Round 3 §2.3: the per-run cost cap the budget check compares against.
      ALTER TABLE projects ADD COLUMN max_cost_per_run_usd REAL;

      -- Round 3 additions to NodeRun (§2.1, §2.2, §2.4).
      ALTER TABLE node_runs ADD COLUMN approvals TEXT;
      ALTER TABLE node_runs ADD COLUMN guardrail_policy TEXT;
      ALTER TABLE node_runs ADD COLUMN loop_stop TEXT;
      ALTER TABLE node_runs ADD COLUMN reused_from_node_run_id TEXT;
      CREATE INDEX node_runs_started_idx ON node_runs (workspace_id, started_at);
    `,
    /** Every project that existed before this migration gets the §2.2 default (FR-GRD-018). */
    seed: (sqlite) => {
      backfillDefaultPolicies(sqlite);
    },
  },
  {
    id: ROUND_3_RUN_COLUMNS_MIGRATION_ID,
    up: `
      -- Round 3 additions to Run. The contract, the port and the scheduler all carry these four
      -- since C3; the table did not, so every write of them was silently dropped and
      -- 'GET /runs/:id' answered 'allowedActions: undefined' (FR-CTL-002, FR-CTL-004, FR-CTL-006,
      -- FR-GRD-008).
      --
      -- No backfill and no data step. A run that predates this migration reads the four as NULL,
      -- which 'toRun' leaves absent, and that is the honest answer: 'allowedActions' is the engine's
      -- record of what it allowed at the time, 'paused_at' and the other two are events that either
      -- happened or did not. Inventing 'allowedRunActions(status)' for a finished run would be
      -- writing history the engine never wrote (BR-04). 'Run.allowedActions' is optional exactly so
      -- that an old row stays valid (D71).
      ALTER TABLE runs ADD COLUMN paused_at TEXT;
      ALTER TABLE runs ADD COLUMN allowed_actions TEXT;
      ALTER TABLE runs ADD COLUMN budget_halt TEXT;
      ALTER TABLE runs ADD COLUMN restarted_from_run_id TEXT;
    `,
  },
  {
    id: ROUND_4_MIGRATION_ID,
    up: `
      -- Every uploaded or produced file (round 4 §2.1, FR-MM-001..004, Arch §15.1, §15.4). The
      -- bytes are in the content-addressed blob store; this row is the metadata plus the address.
      -- The unique index on (workspace, hash) is what makes the dedupe a constraint rather than a
      -- convention: the same bytes uploaded twice cannot make a second row (FR-MM-002).
      CREATE TABLE artifacts (
        id                 TEXT PRIMARY KEY,
        workspace_id       TEXT NOT NULL,
        hash               TEXT NOT NULL,
        mime               TEXT NOT NULL,
        name               TEXT NOT NULL,
        size               INTEGER NOT NULL,
        created_at         TEXT NOT NULL,
        last_referenced_at TEXT
      );
      CREATE INDEX artifacts_workspace_idx ON artifacts (workspace_id, id);
      CREATE UNIQUE INDEX artifacts_hash_idx ON artifacts (workspace_id, hash);

      -- One logged tool call (round 4 §2.2, FR-TOOL-009). 'args' is redacted before it gets here
      -- (BR-07); the full result never lands, only its summary. 'run_id' is a column of its own so
      -- the inspector and the 'tool.call' event can filter by run without parsing the node run.
      CREATE TABLE tool_calls (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL,
        run_id         TEXT NOT NULL,
        node_run_id    TEXT NOT NULL,
        tool_name      TEXT NOT NULL,
        args           TEXT NOT NULL,
        result_summary TEXT NOT NULL,
        duration_ms    INTEGER NOT NULL,
        status         TEXT NOT NULL,
        verdicts       TEXT NOT NULL,
        at             TEXT NOT NULL
      );
      CREATE INDEX tool_calls_node_run_idx ON tool_calls (workspace_id, node_run_id, id);
      CREATE INDEX tool_calls_run_idx ON tool_calls (workspace_id, run_id, id);

      -- A connected MCP server (round 4 §2.2, FR-TOOL-007, D16). No key column: it is addressed by
      -- a command or a URL, and its liveness is status + tool_count + error.
      CREATE TABLE mcp_servers (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        name            TEXT NOT NULL,
        transport       TEXT NOT NULL,
        command         TEXT,
        args            TEXT,
        url             TEXT,
        status          TEXT NOT NULL,
        tool_count      INTEGER NOT NULL,
        last_checked_at TEXT,
        error           TEXT
      );
      CREATE INDEX mcp_servers_workspace_idx ON mcp_servers (workspace_id, id);

      -- One row of a workflow's timeline (round 4 §2.3, FR-CHAT-001..003). 'content' is Part[], so
      -- a file in a message is an artifact reference and never bytes (FR-MM-004, BR-02).
      CREATE TABLE messages (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workflow_id  TEXT NOT NULL,
        run_id       TEXT,
        node_id      TEXT,
        node_run_id  TEXT,
        type         TEXT NOT NULL,
        content      TEXT NOT NULL,
        at           TEXT NOT NULL
      );
      CREATE INDEX messages_workflow_idx ON messages (workspace_id, workflow_id, id);
      CREATE INDEX messages_run_idx ON messages (workspace_id, run_id, id);
      CREATE INDEX messages_node_idx ON messages (workspace_id, node_id, id);

      -- A direct-chat conversation with one agent (round 4 §2.3, FR-CHAT-004). It never reads or
      -- writes runs/node_runs (FR-CHAT-005), which is why its turns are a separate id space.
      CREATE TABLE chat_threads (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        title        TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX chat_threads_node_idx ON chat_threads (workspace_id, node_id, id);

      -- One turn of a direct chat (round 4 §2.3, FR-CHAT-006/008). 'verdicts' are ChatVerdict[]
      -- (no node_run_id), 'usage' is present only on an agent reply.
      CREATE TABLE chat_messages (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        thread_id    TEXT NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        verdicts     TEXT NOT NULL,
        usage        TEXT,
        at           TEXT NOT NULL
      );
      CREATE INDEX chat_messages_thread_idx ON chat_messages (workspace_id, thread_id, id);
    `,
  },
  {
    id: ROUND_5_MIGRATION_ID,
    up: `
      -- A knowledge base (round 5 §2.1, FR-RAG-001). No document or chunk count column: both are
      -- counted from the rows on every read, so they cannot drift from what is stored.
      CREATE TABLE knowledge_bases (
        id                    TEXT PRIMARY KEY,
        workspace_id          TEXT NOT NULL,
        project_id            TEXT NOT NULL,
        name                  TEXT NOT NULL,
        embedding_provider_id TEXT NOT NULL,
        embedding_model_id    TEXT NOT NULL,
        chunk_size            INTEGER NOT NULL,
        chunk_overlap         INTEGER NOT NULL,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX knowledge_bases_project_idx ON knowledge_bases (workspace_id, project_id, id);

      -- An uploaded artifact going through ingestion (§2.1, FR-RAG-002, 003, Arch §21.3). The
      -- bytes stay in the blob store; 'verdicts' are the ingestion-time context checks, types only.
      CREATE TABLE kb_documents (
        id                TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL,
        artifact_id       TEXT NOT NULL,
        name              TEXT NOT NULL,
        mime              TEXT NOT NULL,
        size              INTEGER NOT NULL,
        status            TEXT NOT NULL,
        chunk_count       INTEGER NOT NULL,
        error             TEXT,
        ingested_at       TEXT,
        verdicts          TEXT,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX kb_documents_kb_idx ON kb_documents (workspace_id, knowledge_base_id, id);
      CREATE INDEX kb_documents_status_idx ON kb_documents (workspace_id, status, id);

      -- One indexed piece of a document (§2.1). 'seq' is an INTEGER PRIMARY KEY, so it is the
      -- table's rowid and stays put through VACUUM: the FTS index below is keyed by that rowid, and
      -- a rowid that VACUUM renumbered would point every keyword hit at the wrong chunk.
      CREATE TABLE kb_chunks (
        seq               INTEGER PRIMARY KEY,
        id                TEXT NOT NULL UNIQUE,
        workspace_id      TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL,
        document_id       TEXT NOT NULL,
        ordinal           INTEGER NOT NULL,
        text              TEXT NOT NULL,
        tokens            INTEGER NOT NULL,
        source            TEXT NOT NULL,
        headings          TEXT NOT NULL
      );
      CREATE INDEX kb_chunks_document_idx ON kb_chunks (workspace_id, document_id, ordinal);
      CREATE INDEX kb_chunks_kb_idx ON kb_chunks (workspace_id, knowledge_base_id);

      -- Every embedding, as Float32 bytes (F8). The table of record for vectors: the sqlite-vec
      -- index is built from it at open and is never in a migration, because the extension may be
      -- absent — and when it is, the vector search scans this table instead.
      CREATE TABLE kb_vectors (
        chunk_id          TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL,
        knowledge_base_id TEXT NOT NULL,
        document_id       TEXT NOT NULL,
        dims              INTEGER NOT NULL,
        embedding         BLOB NOT NULL
      );
      CREATE INDEX kb_vectors_kb_idx ON kb_vectors (workspace_id, knowledge_base_id);
      CREATE INDEX kb_vectors_document_idx ON kb_vectors (workspace_id, document_id);

      -- The keyword index (F8, FR-RAG-004): external content over kb_chunks, so the text is stored
      -- once. 'tokenchars' keeps '-' and '_' inside a token, so zephyrine-protocol-7 is one term
      -- and an exact identifier is found whole (TC-RAG-004). The triggers keep it in step.
      CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
        text,
        content = 'kb_chunks',
        content_rowid = 'rowid',
        tokenize = "unicode61 tokenchars '-_'"
      );
      CREATE TRIGGER kb_chunks_fts_insert AFTER INSERT ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts (rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER kb_chunks_fts_delete AFTER DELETE ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts (kb_chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER kb_chunks_fts_update AFTER UPDATE OF text ON kb_chunks BEGIN
        INSERT INTO kb_chunks_fts (kb_chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO kb_chunks_fts (rowid, text) VALUES (new.rowid, new.text);
      END;

      -- Long-term agent memory (round 5 §2.2, FR-MEM-001..004, Arch §12.8): one value per key per
      -- node, so a save of a key the node already has replaces it.
      CREATE TABLE agent_memory (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        last_used_at TEXT,
        UNIQUE (workspace_id, node_id, key)
      );
      CREATE INDEX agent_memory_node_idx ON agent_memory (workspace_id, node_id, created_at, id);

      -- Model summaries by content hash (§2.5, FR-RAG-010): 30 days from creation, pruned to 5,000
      -- rows per workspace, least recently used first.
      CREATE TABLE summary_cache (
        workspace_id TEXT NOT NULL,
        key          TEXT NOT NULL,
        summary      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, key)
      );
      CREATE INDEX summary_cache_lru_idx ON summary_cache (workspace_id, last_used_at);

      -- Round 5 additions to NodeRun (§2.2, §2.4, D233): the chunks its context used, the chunks
      -- that did not fit the budget, and the memory ops it applied. NULL reads as none.
      ALTER TABLE node_runs ADD COLUMN sources TEXT;
      ALTER TABLE node_runs ADD COLUMN dropped_sources TEXT;
      ALTER TABLE node_runs ADD COLUMN memory_ops TEXT;

      -- C5's Verdict.strippedTypes (D232): what the context point stripped, by kind and never by
      -- text. Without the column the table of record would drop it while the node run's copy kept
      -- it, and the two would disagree (TC-GRD-005).
      ALTER TABLE guardrail_verdicts ADD COLUMN stripped_types TEXT;
    `,
    /** DN-2: policies written before the context point get its three checks as a new version. */
    seed: (sqlite) => {
      appendContextChecks(sqlite);
    },
  },
  {
    id: X1_CLI_PROVIDERS_MIGRATION_ID,
    up: `
      -- X1 (D262): what a CLI provider may do in the project folder. NULL for every other type.
      ALTER TABLE providers ADD COLUMN cli_permission TEXT;
    `,
  },
  {
    id: PARITY_P0_MIGRATION_ID,
    up: `
      -- A project's Build settings (D269, D271). Every project written before reads not paused,
      -- the default capacity, no check commands and no setup command. 'check_commands' is a JSON
      -- CheckCommand[]; NULL is none.
      ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN build_capacity INTEGER;
      ALTER TABLE projects ADD COLUMN check_commands TEXT;
      ALTER TABLE projects ADD COLUMN setup_command TEXT;

      -- A task on a project's board (D267, D268). The schema's first foreign keys: a task and
      -- everything below it go with its project, and a deleted workflow leaves the task without a
      -- team or planner rather than pointing at nothing. 'number' is per project, from 1, which the
      -- unique constraint makes a fact rather than a convention. 'labels' is a JSON string[].
      CREATE TABLE tasks (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        number              INTEGER NOT NULL,
        title               TEXT NOT NULL,
        brief               TEXT NOT NULL,
        type                TEXT NOT NULL,
        stage               TEXT NOT NULL,
        state               TEXT NOT NULL,
        state_reason        TEXT,
        outcome             TEXT,
        finish_line         TEXT NOT NULL,
        automation          TEXT NOT NULL,
        priority            TEXT NOT NULL,
        labels              TEXT NOT NULL,
        workflow_id         TEXT REFERENCES workflows (id) ON DELETE SET NULL,
        planner_workflow_id TEXT REFERENCES workflows (id) ON DELETE SET NULL,
        plan                TEXT NOT NULL,
        acceptance          TEXT NOT NULL,
        run_checks          INTEGER NOT NULL,
        paused              INTEGER NOT NULL,
        pending_request     TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        started_at          TEXT,
        completed_at        TEXT,
        UNIQUE (workspace_id, project_id, number)
      );
      CREATE INDEX tasks_project_idx ON tasks (workspace_id, project_id);
      CREATE INDEX tasks_state_idx ON tasks (workspace_id, state);

      -- The rows below belong to one task each. Their indexes lead with task_id, not
      -- workspace_id: a task id is unique on its own, and the cascade of a task delete looks the
      -- children up by task_id alone, which an index led by workspace_id could not serve.

      -- A task's Git worktree (D269): at most one per task.
      CREATE TABLE task_workspaces (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id      TEXT NOT NULL UNIQUE REFERENCES tasks (id) ON DELETE CASCADE,
        repo_path    TEXT NOT NULL,
        path         TEXT NOT NULL,
        branch       TEXT NOT NULL,
        base_branch  TEXT NOT NULL,
        base_sha     TEXT NOT NULL,
        head_sha     TEXT NOT NULL,
        status       TEXT NOT NULL,
        error        TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      -- The plan and work runs a task made, numbered per task. 'workflow_id' and 'run_id' are
      -- history, as on runs: no foreign key, so deleting a workflow does not rewrite them.
      CREATE TABLE task_executions (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        task_id       TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        sequence      INTEGER NOT NULL,
        workflow_id   TEXT NOT NULL,
        run_id        TEXT,
        status        TEXT NOT NULL,
        request       TEXT NOT NULL,
        summary       TEXT,
        commit_sha    TEXT,
        changed_files INTEGER,
        error         TEXT,
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        UNIQUE (task_id, sequence)
      );
      CREATE INDEX task_executions_run_idx ON task_executions (workspace_id, run_id);

      -- One run of one project check command in the workspace (D271); 'output' is the masked tail.
      CREATE TABLE task_checks (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id      TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        execution_id TEXT,
        name         TEXT NOT NULL,
        command      TEXT NOT NULL,
        status       TEXT NOT NULL,
        exit_code    INTEGER,
        output       TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        head_sha     TEXT NOT NULL,
        at           TEXT NOT NULL
      );
      CREATE INDEX task_checks_task_idx ON task_checks (task_id, at);

      CREATE TABLE task_reviews (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id      TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        decision     TEXT NOT NULL,
        note         TEXT,
        head_sha     TEXT,
        at           TEXT NOT NULL
      );
      CREATE INDEX task_reviews_task_idx ON task_reviews (task_id, at);

      CREATE TABLE task_deliveries (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id      TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        status       TEXT NOT NULL,
        destination  TEXT NOT NULL,
        detail       TEXT,
        sha          TEXT,
        url          TEXT,
        at           TEXT NOT NULL
      );
      CREATE INDEX task_deliveries_task_idx ON task_deliveries (task_id, at);

      -- The task's activity feed, append-only. 'seq' is an INTEGER PRIMARY KEY, so it is the rowid
      -- and keeps the insertion order through VACUUM (as kb_chunks' does); AUTOINCREMENT means a
      -- seq is never handed out twice, even after the newest rows were deleted.
      CREATE TABLE task_activity (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        task_id      TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind         TEXT NOT NULL,
        message      TEXT NOT NULL,
        execution_id TEXT,
        run_id       TEXT,
        at           TEXT NOT NULL
      );
      CREATE INDEX task_activity_task_idx ON task_activity (task_id, seq);
    `,
  },
  {
    id: PARITY_P1_SKILLS_MIGRATION_ID,
    up: `
      -- An installed skill (D272): reusable instructions an agent enables by id. 'source' is
      -- builtin, user or bundle; 'bundle_id' names the bundle a bundle skill came from. No foreign
      -- key to bundles: the skill service removes a bundle's skills with it, in one transaction,
      -- and a skill the user deleted on its own leaves the bundle as it was imported.
      CREATE TABLE skills (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL,
        instructions TEXT NOT NULL,
        version      INTEGER NOT NULL,
        source       TEXT NOT NULL,
        bundle_id    TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      -- One skill per name in a workspace, whatever its case: "Test first" and "test first" would
      -- be the same skill to the person choosing one for an agent.
      CREATE UNIQUE INDEX skills_name_idx ON skills (workspace_id, lower(name));

      -- An imported bundle (D273). 'skill_ids' is a JSON Id[] of the skills the import created;
      -- 'mcp_servers' is a JSON CreateMcpServerRequest[] of the plugin definitions it named, kept
      -- as named and never connected by the import.
      CREATE TABLE bundles (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL,
        skill_ids    TEXT NOT NULL,
        mcp_servers  TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX bundles_workspace_idx ON bundles (workspace_id, created_at);
    `,
  },
  {
    id: PARITY_P1_MIGRATION_ID,
    up: `
      -- A Document or Email task's draft (D275) and where a task came from: each a JSON object,
      -- NULL when the task has none. Every task written before reads with neither.
      ALTER TABLE tasks ADD COLUMN deliverable TEXT;
      ALTER TABLE tasks ADD COLUMN source TEXT;

      -- The pull request opened from a task branch, as GitHub last reported it (D276): JSON, or
      -- NULL before one is opened.
      ALTER TABLE task_workspaces ADD COLUMN pull_request TEXT;

      -- A project's preview (D278): the command line, and the URL to open ('{port}' in it is the
      -- port the preview was given). NULL is none.
      ALTER TABLE projects ADD COLUMN preview_command TEXT;
      ALTER TABLE projects ADD COLUMN preview_url TEXT;

      -- When a task starts by itself (D277): at most one schedule per task, gone with its task.
      -- 'trigger' is the JSON TaskTrigger; 'kind' and 'after_task_id' repeat its kind and awaited
      -- task so the scheduler's two reads are indexed queries rather than a scan of the JSON.
      -- 'after_task_id' and 'last_task_id' name tasks without a foreign key: a schedule waiting
      -- on a deleted task, or recording one, is the engine's to resolve, not a cascade's.
      CREATE TABLE task_schedules (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        task_id       TEXT NOT NULL UNIQUE REFERENCES tasks (id) ON DELETE CASCADE,
        "trigger"     TEXT NOT NULL,
        kind          TEXT NOT NULL,
        after_task_id TEXT,
        enabled       INTEGER NOT NULL,
        next_run_at   TEXT,
        last_run_at   TEXT,
        last_task_id  TEXT,
        skipped       INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX task_schedules_enabled_idx ON task_schedules (workspace_id, enabled);
      CREATE INDEX task_schedules_after_task_idx ON task_schedules (workspace_id, after_task_id);
    `,
  },
  {
    id: PARITY_P2_MIGRATION_ID,
    up: `
      -- What ACE watches in a project, why and what good work looks like (D280). A scan's outcome
      -- is kept on the row; nothing here scans.
      CREATE TABLE responsibilities (
        id                     TEXT PRIMARY KEY,
        workspace_id           TEXT NOT NULL,
        project_id             TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        kind                   TEXT NOT NULL,
        title                  TEXT NOT NULL,
        why                    TEXT NOT NULL,
        good_work              TEXT NOT NULL,
        query                  TEXT,
        watch                  INTEGER NOT NULL,
        watch_interval_minutes INTEGER NOT NULL,
        paused                 INTEGER NOT NULL,
        last_scan_at           TEXT,
        last_scan_status       TEXT,
        last_scan_message      TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE INDEX responsibilities_project_idx ON responsibilities (workspace_id, project_id);
      CREATE INDEX responsibilities_watch_idx ON responsibilities (workspace_id, watch, paused);

      -- What a scan found (D280). The fingerprint is unique per project: the same thing is never
      -- suggested twice, and a dismissed suggestion stays dismissed. 'task_id' names the task an
      -- accepted one became, without a foreign key: the task's life is its own.
      CREATE TABLE suggestions (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        responsibility_id   TEXT NOT NULL REFERENCES responsibilities (id) ON DELETE CASCADE,
        title               TEXT NOT NULL,
        reason              TEXT NOT NULL,
        evidence            TEXT NOT NULL,
        proposed_action     TEXT NOT NULL,
        completion_criteria TEXT NOT NULL,
        status              TEXT NOT NULL,
        task_id             TEXT,
        fingerprint         TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        UNIQUE (workspace_id, project_id, fingerprint)
      );
      CREATE INDEX suggestions_project_idx ON suggestions (workspace_id, project_id, status);
      CREATE INDEX suggestions_responsibility_idx ON suggestions (responsibility_id);

      -- A project's team notes (D281), verified or not.
      CREATE TABLE project_notes (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id   TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        text         TEXT NOT NULL,
        status       TEXT NOT NULL,
        source       TEXT NOT NULL,
        ref_id       TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX project_notes_project_idx ON project_notes (workspace_id, project_id);
    `,
  },
];

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _ace_migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

export function appliedMigrations(sqlite: BetterSqlite3.Database): Set<string> {
  sqlite.exec(MIGRATIONS_TABLE);
  const rows = sqlite.prepare('SELECT id FROM _ace_migrations').all() as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export function pendingMigrations(
  sqlite: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  const applied = appliedMigrations(sqlite);
  return migrations.filter((migration) => !applied.has(migration.id));
}

/**
 * Applies the pending migrations, each in its own transaction so a failure leaves the database on
 * the last migration that succeeded rather than half way through one.
 */
export function applyMigrations(
  sqlite: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): string[] {
  const pending = pendingMigrations(sqlite, migrations);

  for (const migration of pending) {
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.up);
      // The data step commits with the schema change, so the tables and the rows they require can
      // never be half applied.
      migration.seed?.(sqlite);
      sqlite
        .prepare('INSERT INTO _ace_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString());
    });
    run();
  }

  return pending.map((migration) => migration.id);
}
