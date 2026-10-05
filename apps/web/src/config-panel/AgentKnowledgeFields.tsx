import type { AgentConfig, Id } from '@ace/contracts';
import { Checkbox, Label } from '@ace/ui';
import { Link } from 'react-router-dom';

import { useKnowledgeBases } from '../nodes/retrieval/hooks';

const legendClass = 'mb-1 font-machine text-[10px] uppercase tracking-wider text-fg-muted';

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
    <fieldset className="flex flex-col gap-2" data-testid="agent-memory">
      <legend className={legendClass}>Memory</legend>
      <div className="flex items-start gap-2">
        <Checkbox
          id="agent-memory-enabled"
          data-testid="agent-memory-enabled"
          checked={memory.enabled}
          onCheckedChange={(checked) => onChange({ ...memory, enabled: checked === true })}
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="agent-memory-enabled">Remember facts between runs</Label>
          <p className="text-xs text-fg-muted">
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
    <fieldset className="flex flex-col gap-2" data-testid="agent-knowledge-bases">
      <legend className={legendClass}>Knowledge bases</legend>
      {bases.isPending && projectId !== undefined && (
        <p className="text-xs text-fg-muted">Loading knowledge bases…</p>
      )}
      {bases.isError && (
        <p role="alert" className="text-xs text-danger">
          Could not load knowledge bases: {bases.error.message}
        </p>
      )}
      {bases.data !== undefined && bases.data.length === 0 && (
        <p className="text-xs text-fg-muted" data-testid="agent-kb-empty">
          No knowledge bases in this project yet.{' '}
          {projectId !== undefined && (
            <Link className="text-accent underline" to={`/projects/${projectId}/knowledge`}>
              Create one
            </Link>
          )}
        </p>
      )}
      <div className="flex flex-col gap-1.5" role="group" aria-label="Attached knowledge bases">
        {bases.data?.map((base) => {
          const boxId = `agent-kb-${base.id}`;
          return (
            <div key={base.id} className="flex items-center gap-2" data-testid={boxId}>
              <Checkbox
                id={boxId}
                checked={value.includes(base.id)}
                onCheckedChange={(checked) => toggle(base.id, checked === true)}
              />
              <label htmlFor={boxId} className="font-human text-sm text-fg">
                {base.name}
              </label>
              <span className="ml-auto font-machine text-[10px] text-fg-muted">
                {base.documentCount} docs
              </span>
            </div>
          );
        })}
        {missing.map((id) => (
          <div
            key={id}
            role="alert"
            className="flex items-center gap-2 text-xs text-danger"
            data-testid={`agent-kb-missing-${id}`}
          >
            <span>A deleted knowledge base is still attached.</span>
            <button type="button" className="ml-auto underline" onClick={() => toggle(id, false)}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
