import { Button } from '@ace/ui';
import { BookOpen, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { HelpLink } from '../help/HelpLink';
import { useProject } from '../projects/hooks';
import { CreateKnowledgeBaseDialog } from './CreateKnowledgeBaseDialog';
import { useKnowledgeBases } from './hooks';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** `/projects/:projectId/knowledge` — the project's knowledge bases (FR-RAG-001, TC-RAG-001). */
export function KnowledgeListPage() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const bases = useKnowledgeBases(projectId);
  const [creating, setCreating] = useState(false);

  return (
    <main
      data-testid="knowledge-list-page"
      className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto px-4 py-10"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link
            to={`/projects/${projectId}`}
            className="font-human text-xs text-fg-muted underline-offset-2 hover:underline"
          >
            ← {project.data?.name ?? 'Project'}
          </Link>
          <h1 className="font-human text-2xl font-semibold">Knowledge</h1>
          <p className="mt-1 font-human text-sm text-fg-muted">
            Documents your agents can search and cite (FR-RAG-001).
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="self-start">
          <Plus className="h-4 w-4" aria-hidden /> New knowledge base
        </Button>
      </header>

      {bases.isPending && <p className="text-fg-muted">Loading knowledge bases…</p>}
      {bases.isError && (
        <p role="alert" className="text-danger">
          Could not load knowledge bases: {bases.error.message}
        </p>
      )}
      {bases.data?.length === 0 && (
        <div
          data-testid="kb-empty"
          className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-8 text-center"
        >
          <BookOpen className="h-6 w-6 text-fg-muted" aria-hidden />
          <p className="font-human text-fg-muted">
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
        <ul aria-label="Knowledge bases" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {bases.data.map((kb) => (
            <li key={kb.id}>
              <Link
                to={`/knowledge/${kb.id}`}
                data-testid={`kb-card-${kb.id}`}
                className="flex h-full flex-col gap-1 rounded-card border border-border bg-panel px-4 py-3 hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="truncate font-human font-semibold">{kb.name}</span>
                <span className="font-machine text-xs text-fg-muted" data-testid="kb-card-counts">
                  {plural(kb.documentCount, 'document')} · {plural(kb.chunkCount, 'chunk')}
                </span>
                <span className="truncate font-machine text-[11px] text-fg-muted">
                  {kb.embeddingModelId} · {kb.chunkSize}/{kb.chunkOverlap} tokens
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

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
