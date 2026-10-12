import { Button } from '@ace/ui';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { HelpLink } from '../help/HelpLink';
import { useProject } from '../projects/hooks';
import { CreateKnowledgeBaseDialog } from './CreateKnowledgeBaseDialog';
import { useKnowledgeBases } from './hooks';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * `/projects/:projectId/knowledge` — the project's knowledge bases (FR-RAG-001, TC-RAG-001), as
 * theme cards (D328).
 */
export function KnowledgeListPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const bases = useKnowledgeBases(projectId);
  const [creating, setCreating] = useState(false);

  return (
    <main data-testid="knowledge-list-page" className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Link
              to={`/projects/${projectId}`}
              className="text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
            >
              ← {project.data?.name ?? 'Project'}
            </Link>
            <h1 className="mt-1 text-[20px] font-bold tracking-[-0.01em]">Knowledge</h1>
            <p className="mt-1 text-[13px] text-[var(--muted)]">
              Documents your agents can search and cite (FR-RAG-001).
            </p>
          </div>
          <Button onClick={() => setCreating(true)} className="self-start">
            New knowledge base
          </Button>
        </header>

        {bases.isPending && (
          <p className="text-[13px] text-[var(--muted)]">Loading knowledge bases…</p>
        )}
        {bases.isError && (
          <p role="alert" className="text-[12px] text-[#c94c27]">
            Could not load knowledge bases: {bases.error.message}
          </p>
        )}
        {bases.data?.length === 0 && (
          <div
            data-testid="kb-empty"
            className="flex flex-col items-center gap-3 py-10 text-center"
          >
            <p className="text-[13px] text-[var(--muted)]">
              No knowledge bases yet. Create one, upload documents, and test a search before you
              attach it to an agent.
            </p>
            <Button variant="secondary" onClick={() => setCreating(true)}>
              Create your first knowledge base
            </Button>
            <HelpLink page="knowledge-bases">How knowledge bases work</HelpLink>
          </div>
        )}

        {bases.data && bases.data.length > 0 && (
          <ul
            aria-label="Knowledge bases"
            className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[10px]"
          >
            {bases.data.map((kb) => (
              <li key={kb.id}>
                <Link
                  to={`/knowledge/${kb.id}`}
                  data-testid={`kb-card-${kb.id}`}
                  className="flex h-full flex-col gap-1 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3 text-[var(--ink)] outline-none transition-colors hover:border-[#ef6b3f] hover:text-[var(--ink)] focus-visible:border-[#ef6b3f]"
                >
                  <span className="truncate text-[13.5px] font-bold">{kb.name}</span>
                  <span
                    className="font-machine text-[10px] text-[var(--muted)]"
                    data-testid="kb-card-counts"
                  >
                    {plural(kb.documentCount, 'document')} · {plural(kb.chunkCount, 'chunk')}
                  </span>
                  <span className="mt-1 truncate rounded-[8px] border border-[var(--line)] bg-[var(--soft)] px-[10px] py-[6px] font-machine text-[10px] text-[var(--muted)]">
                    {kb.embeddingModelId} · {kb.chunkSize}/{kb.chunkOverlap} tokens
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <CreateKnowledgeBaseDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/knowledge/${id}`);
          }}
        />
      )}
    </main>
  );
}
