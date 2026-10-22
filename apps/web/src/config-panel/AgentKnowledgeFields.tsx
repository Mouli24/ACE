import type { AgentConfig, Id } from '@ace/contracts';
import { Checkbox, FIELD_LABEL_CLASS } from '@ace/ui';
import { Link } from 'react-router-dom';

import { useKnowledgeBases } from '../nodes/retrieval/hooks';
import { ERROR_CLASS, HELP_CLASS } from './fields';

/** A titled group in the node settings modal: the theme's mono label over its rows. */
const GROUP_CLASS = 'flex min-w-0 flex-col gap-[7px]';

/**
 * The Agent's long-term memory switch (FR-MEM-001). On, the prompt gains the memory instructions and
 * the agent's saved facts ride into its next run's envelope; off, nothing is saved or injected. The
 * facts themselves are listed, deleted and cleared in the sheet's Memory tab (FR-MEM-004).
 */
export function AgentMemoryField({
  memory,
  onChange,
}: {
  memory: AgentConfig['memory'];
  onChange: (memory: AgentConfig['memory']) => void;
}) {
  return (
    <fieldset className={GROUP_CLASS} data-testid="agent-memory">
      <legend className="sr-only">Memory</legend>
      <span aria-hidden className={FIELD_LABEL_CLASS}>
        Memory
      </span>
      <div className="flex items-start gap-2.5 rounded-[9px] border border-[var(--line)] px-3 py-2.5">
        <Checkbox
          id="agent-memory-enabled"
          data-testid="agent-memory-enabled"
          className="mt-px"
          checked={memory.enabled}
          onCheckedChange={(checked) => onChange({ ...memory, enabled: checked === true })}
        />
        <div className="flex min-w-0 flex-col gap-px">
          <label
            htmlFor="agent-memory-enabled"
            className="cursor-pointer text-[12.5px] font-semibold text-[var(--ink)]"
          >
            Remember facts between runs
          </label>
          <p className="text-[10.5px] text-[var(--muted)]">
            Saved facts are untrusted context on the next run. See and delete them in the Memory
            tab.
          </p>
        </div>
      </div>
    </fieldset>
  );
}

/**
 * Which of the project's knowledge bases the Agent searches before it answers (FR-RAG-005): its
 * incoming text becomes the query, five hits per base land in its context, and the chunks used are
 * listed on its node run. A base deleted since it was attached stays listed so it can be removed.
 */
export function AgentKnowledgeBasesField({
  value,
  projectId,
  onChange,
}: {
  value: readonly Id[];
  projectId: Id | undefined;
  onChange: (knowledgeBaseIds: Id[]) => void;
}) {
  const bases = useKnowledgeBases(projectId);
  const known = new Set((bases.data ?? []).map((base) => base.id));
  const missing = bases.data === undefined ? [] : value.filter((id) => !known.has(id));

  const toggle = (id: Id, on: boolean) =>
    onChange(
      on ? [...value.filter((each) => each !== id), id] : value.filter((each) => each !== id),
    );

  return (
    <fieldset className={GROUP_CLASS} data-testid="agent-knowledge-bases">
      <legend className="sr-only">Knowledge bases</legend>
      <span aria-hidden className={FIELD_LABEL_CLASS}>
        Knowledge bases
      </span>
      {bases.isPending && projectId !== undefined && (
        <p className={HELP_CLASS}>Loading knowledge bases…</p>
      )}
      {bases.isError && (
        <p role="alert" className={ERROR_CLASS}>
          Could not load knowledge bases: {bases.error.message}
        </p>
      )}
      {bases.data !== undefined && bases.data.length === 0 && (
        <p className={HELP_CLASS} data-testid="agent-kb-empty">
          No knowledge bases in this project yet.{' '}
          {projectId !== undefined && (
            <Link to={`/projects/${projectId}/knowledge`}>Create one</Link>
          )}
        </p>
      )}
      <div className="flex flex-col gap-1" role="group" aria-label="Attached knowledge bases">
        {bases.data?.map((base) => {
          const boxId = `agent-kb-${base.id}`;
          return (
            <div
              key={base.id}
              className="flex h-[38px] items-center gap-2.5 rounded-[9px] border border-[var(--line)] px-3"
              data-testid={boxId}
            >
              <Checkbox
                id={boxId}
                checked={value.includes(base.id)}
                onCheckedChange={(checked) => toggle(base.id, checked === true)}
              />
              <label
                htmlFor={boxId}
                className="min-w-0 flex-1 cursor-pointer truncate text-[12.5px] text-[var(--ink)]"
              >
                {base.name}
              </label>
              <span className="shrink-0 font-machine text-[10px] text-[var(--muted)]">
                {base.documentCount} docs
              </span>
            </div>
          );
        })}
        {missing.map((id) => (
          <div
            key={id}
            role="alert"
            className={`flex items-center gap-2 ${ERROR_CLASS}`}
            data-testid={`agent-kb-missing-${id}`}
          >
            <span>A deleted knowledge base is still attached.</span>
            <button
              type="button"
              className="ml-auto cursor-pointer border-none bg-transparent p-0 text-[11.5px] font-semibold text-danger outline-none focus-visible:underline"
              onClick={() => toggle(id, false)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
