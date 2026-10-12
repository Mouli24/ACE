import type { Artifact } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../app/api';
import { startSocket, stopSocket } from '../app/socket';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { setIngestPace, stopAllIngestion } from '../mocks/knowledge';
import {
  CORRUPT_PDF_FIXTURE,
  KB_FIXTURES,
  PARAPHRASE_QUERY,
  RARE_TERM,
  type KbFixture,
} from '../mocks/knowledge-fixtures';
import { seedKnowledgeBase } from '../mocks/seeds-round5';
import { db, installMockServer, queryClient, renderApp } from '../test/app';

installMockServer();

/**
 * The XHR transport of `uploadArtifact` is round 4's and tested there; here the bytes go straight
 * into the mock engine's artifact store, so everything after the upload — `POST /documents`, the
 * staged ingestion, `kb.ingest` on the socket — is the real mock path.
 */
async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(
    await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    }),
  );
}

beforeEach(() => {
  setIngestPace(5);
  vi.spyOn(api(), 'uploadArtifact').mockImplementation(
    async (file: Blob, options?: { filename?: string }): Promise<Artifact> =>
      db.putArtifact({
        name: options?.filename ?? (file instanceof File ? file.name : 'upload.bin'),
        mime: file.type,
        bytes: await bytesOf(file as File),
      }),
  );
});

afterEach(() => {
  stopAllIngestion();
  stopSocket();
  vi.restoreAllMocks();
  setIngestPace(150);
});

function connectSocket(): void {
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
}

const fileOf = (fixture: KbFixture): File =>
  new File([new Uint8Array(fixture.bytes())], fixture.name, { type: fixture.mime });

function seedProjectWithMock() {
  const project = db.createProject({ name: 'Handbook project' });
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  return { project, provider };
}

describe('TC-RAG-001 Create a knowledge base (FR-RAG-001)', () => {
  it('shows the empty state, creates a base on the mock embedder and lists it with its counts', async () => {
    const { project, provider } = seedProjectWithMock();
    const user = userEvent.setup();
    const { router } = renderApp(`/projects/${project.id}/knowledge`);

    expect(await screen.findByTestId('kb-empty')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /new knowledge base/i }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Team handbook');
    // the mock embedder is preselected once the catalogue is in (theme dropdowns, D328)
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Embedding model' })).toHaveTextContent(
        '(mock-embed)',
      ),
    );
    expect(within(dialog).getByRole('combobox', { name: 'Embedding provider' })).toHaveTextContent(
      provider.name,
    );
    expect(within(dialog).getByLabelText('Chunk size (tokens)')).toHaveValue(700);
    expect(within(dialog).getByLabelText('Overlap (tokens)')).toHaveValue(90);

    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/knowledge\//));
    const kbId = router.state.location.pathname.split('/')[2]!;
    const created = db.getKnowledgeBase(kbId);
    expect(created).toMatchObject({
      name: 'Team handbook',
      embeddingProviderId: provider.id,
      embeddingModelId: 'mock-embed',
      chunkSize: 700,
      chunkOverlap: 90,
    });
    await waitFor(() => expect(screen.getByTestId('kb-name')).toHaveTextContent('Team handbook'));

    act(() => {
      void router.navigate(`/projects/${project.id}/knowledge`);
    });
    const card = await screen.findByTestId(`kb-card-${kbId}`);
    expect(card).toHaveTextContent('Team handbook');
    expect(card).toHaveTextContent('0 documents · 0 chunks');
  });

  it('refuses an overlap that is not smaller than the chunk size, and sizes out of range', async () => {
    const { project } = seedProjectWithMock();
    const user = userEvent.setup();
    renderApp(`/projects/${project.id}/knowledge`);

    await user.click(await screen.findByRole('button', { name: /new knowledge base/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Bad chunks');
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Embedding model' })).toHaveTextContent(
        '(mock-embed)',
      ),
    );
    const size = within(dialog).getByLabelText('Chunk size (tokens)');
    const overlap = within(dialog).getByLabelText('Overlap (tokens)');
    await user.clear(size);
    await user.type(size, '300');
    await user.clear(overlap);
    await user.type(overlap, '300');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(
      await within(dialog).findByText(/smaller than the chunk size/i, {
        selector: '[role="alert"]',
      }),
    ).toBeInTheDocument();
    expect(overlap).toHaveAttribute('aria-invalid', 'true');

    await user.clear(size);
    await user.type(size, '5000');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(size).toHaveAttribute('aria-invalid', 'true');
    expect(db.listKnowledgeBases(project.id)).toHaveLength(0);
  });
});

describe('TC-RAG-002 Six document types reach ready (FR-RAG-002, FR-RAG-003)', () => {
  it('uploads all six fixtures and watches each one go through the pipeline to ready', async () => {
    connectSocket();
    const { projectId, knowledgeBaseId } = seedKnowledgeBase(db, undefined, []);
    const user = userEvent.setup();
    renderApp(`/knowledge/${knowledgeBaseId}`);
    await screen.findByText(/no documents yet/i);

    await user.upload(screen.getByTestId('kb-upload-input'), KB_FIXTURES.map(fileOf));

    await waitFor(() => expect(db.kbDocumentsOf(knowledgeBaseId)).toHaveLength(6), {
      timeout: 4000,
    });
    const docs = db.kbDocumentsOf(knowledgeBaseId);
    expect(docs.map((doc) => doc.name).sort()).toEqual(
      KB_FIXTURES.map((fixture) => fixture.name).sort(),
    );
    for (const doc of docs) {
      await waitFor(
        () =>
          expect(screen.getByTestId(`kb-doc-status-${doc.id}`)).toHaveAttribute(
            'data-status',
            'ready',
          ),
        { timeout: 4000 },
      );
    }
    for (const doc of db.kbDocumentsOf(knowledgeBaseId)) {
      expect(doc.chunkCount).toBeGreaterThan(0);
      await waitFor(() =>
        expect(screen.getByTestId(`kb-doc-chunks-${doc.id}`)).toHaveTextContent(
          `${doc.chunkCount} chunk`,
        ),
      );
    }
    // the counts in the header follow the engine
    await waitFor(() => expect(screen.getByTestId('kb-meta')).toHaveTextContent('6 documents'));
    expect(projectId).toBeTruthy();
  });

  it('shows a live progress bar while a document is in the pipeline', async () => {
    setIngestPace(60);
    connectSocket();
    const { knowledgeBaseId, documentIds } = seedKnowledgeBase(db, undefined, ['onboarding.md'], {
      staged: true,
    });
    renderApp(`/knowledge/${knowledgeBaseId}`);
    const row = await screen.findByTestId(`kb-doc-${documentIds[0]!}`);

    const bar = await within(row).findByRole('progressbar');
    expect(bar).toHaveAccessibleName(/ingesting onboarding\.md/i);
    await waitFor(() =>
      expect(screen.getByTestId(`kb-doc-status-${documentIds[0]!}`)).toHaveAttribute(
        'data-status',
        'embedding',
      ),
    );
    expect(
      Number(within(row).getByRole('progressbar').getAttribute('aria-valuenow')),
    ).toBeGreaterThan(0.3);
    await waitFor(
      () =>
        expect(screen.getByTestId(`kb-doc-status-${documentIds[0]!}`)).toHaveAttribute(
          'data-status',
          'ready',
        ),
      { timeout: 4000 },
    );
    expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('TC-RAG-003 A corrupt PDF fails with a reason; the others are unaffected (FR-RAG-003)', () => {
  it('marks only the corrupt PDF failed, inline with the reason, and the rest ready', async () => {
    connectSocket();
    const { knowledgeBaseId } = seedKnowledgeBase(db, undefined, []);
    const user = userEvent.setup();
    renderApp(`/knowledge/${knowledgeBaseId}`);
    await screen.findByText(/no documents yet/i);

    const files = [...KB_FIXTURES.slice(0, 3), CORRUPT_PDF_FIXTURE, ...KB_FIXTURES.slice(3)];
    await user.upload(screen.getByTestId('kb-upload-input'), files.map(fileOf));

    await waitFor(() => expect(db.kbDocumentsOf(knowledgeBaseId)).toHaveLength(7), {
      timeout: 4000,
    });
    for (const doc of db.kbDocumentsOf(knowledgeBaseId)) {
      const expected = doc.name === CORRUPT_PDF_FIXTURE.name ? 'failed' : 'ready';
      await waitFor(
        () =>
          expect(screen.getByTestId(`kb-doc-status-${doc.id}`)).toHaveAttribute(
            'data-status',
            expected,
          ),
        { timeout: 4000 },
      );
    }
    const corrupt = db
      .kbDocumentsOf(knowledgeBaseId)
      .find((doc) => doc.name === CORRUPT_PDF_FIXTURE.name)!;
    expect(screen.getByTestId(`kb-doc-error-${corrupt.id}`)).toHaveTextContent(
      'Could not parse PDF: the file is damaged or not a PDF.',
    );
    expect(
      screen
        .getAllByRole('alert')
        .filter((el) => el.dataset['testid']?.startsWith('kb-doc-error-')),
    ).toHaveLength(1);
  });
});

/** Run the test search with this query, mode and k. */
async function searchFor(
  user: ReturnType<typeof userEvent.setup>,
  query: string,
  mode: 'hybrid' | 'vector' | 'keyword',
  k = 5,
) {
  const panel = screen.getByRole('search');
  const input = within(panel).getByLabelText('Query');
  await user.clear(input);
  await user.type(input, query);
  const kInput = within(panel).getByLabelText('Results (k)');
  await user.clear(kInput);
  await user.type(kInput, String(k));
  // The mode is the theme's dropdown (D328): open it, then pick the option that starts with it.
  await user.click(within(panel).getByRole('combobox', { name: 'Mode' }));
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${mode}`, 'i') }));
  await user.click(within(panel).getByRole('button', { name: /search/i }));
}

describe('FR-RAG-008 Test search panel', () => {
  it('finds the rare term through keyword search, highlights it and shows score, source and via', async () => {
    const { knowledgeBaseId } = seedKnowledgeBase(db);
    const user = userEvent.setup();
    renderApp(`/knowledge/${knowledgeBaseId}`);
    await screen.findByRole('search');

    await searchFor(user, RARE_TERM, 'keyword');

    const results = await screen.findByRole('list', { name: 'Search results' });
    const first = within(results).getAllByRole('listitem')[0]!;
    expect(first).toHaveTextContent(RARE_TERM);
    expect(first.querySelector('mark')).toHaveTextContent(RARE_TERM);
    expect(within(first).getByTestId('source-chip')).toHaveTextContent('security-handbook.pdf');
    expect(within(first).getByTestId('source-via')).toHaveTextContent('keyword');
    expect(within(first).getByTestId('kb-hit-score').textContent).toMatch(/^[01]\.\d\d$/);
    expect(first.dataset['testid']).toMatch(/^kb-search-hit-/);
  });

  it('finds the leave-policy sentence from a paraphrase through vector search', async () => {
    const { knowledgeBaseId } = seedKnowledgeBase(db);
    const user = userEvent.setup();
    renderApp(`/knowledge/${knowledgeBaseId}`);
    await screen.findByRole('search');

    await searchFor(user, PARAPHRASE_QUERY, 'vector', 3);

    const results = await screen.findByRole('list', { name: 'Search results' });
    const hits = within(results).getAllByRole('listitem');
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits[0]).toHaveTextContent(/twenty-five days of paid annual leave/i);
    expect(within(hits[0]!).getByTestId('source-via')).toHaveTextContent('vector');
    for (const hit of hits) {
      expect(within(hit).getByTestId('kb-hit-score')).toBeInTheDocument();
    }
  });

  it('refuses an empty query and a k outside 1–20 without calling the engine', async () => {
    const { knowledgeBaseId } = seedKnowledgeBase(db, undefined, ['onboarding.md']);
    const user = userEvent.setup();
    renderApp(`/knowledge/${knowledgeBaseId}`);
    const panel = await screen.findByRole('search');

    await user.click(within(panel).getByRole('button', { name: /search/i }));
    expect(await within(panel).findByText(/type something to search for/i)).toBeInTheDocument();

    await user.type(within(panel).getByLabelText('Query'), 'laptop');
    const kInput = within(panel).getByLabelText('Results (k)');
    await user.clear(kInput);
    await user.type(kInput, '21');
    await user.click(within(panel).getByRole('button', { name: /search/i }));
    expect(await within(panel).findByText(/k must be between 1 and 20/i)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
  });
});

describe('TC-RAG-008 Delete a document: its content is no longer returned (FR-RAG-009)', () => {
  it('asks first, removes the row, and the open search re-runs without its chunk', async () => {
    const { knowledgeBaseId } = seedKnowledgeBase(db);
    const handbook = db
      .kbDocumentsOf(knowledgeBaseId)
      .find((doc) => doc.name === 'security-handbook.pdf')!;
    const user = userEvent.setup();
    renderApp(`/knowledge/${knowledgeBaseId}`);
    await screen.findByTestId(`kb-doc-${handbook.id}`);

    await searchFor(user, RARE_TERM, 'keyword');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(
      within(results)
        .getAllByRole('listitem')
        .some((hit) => hit.dataset['documentId'] === handbook.id),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Delete security-handbook.pdf' }));
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete document' }));

    await waitFor(() =>
      expect(screen.queryByTestId(`kb-doc-${handbook.id}`)).not.toBeInTheDocument(),
    );
    expect(db.getKbDocument(handbook.id)).toBeUndefined();
    await waitFor(() => {
      const hits = screen.queryAllByTestId(/^kb-search-hit-/);
      expect(hits.some((hit) => hit.dataset['documentId'] === handbook.id)).toBe(false);
      expect(screen.queryByText(new RegExp(RARE_TERM))).not.toBeInTheDocument();
    });
  });
});

describe('FR-RAG-009 Base settings, reindex and delete', () => {
  it('renames and re-chunks through PATCH, reindexes, and deletes the base after confirming', async () => {
    connectSocket();
    const { projectId, knowledgeBaseId } = seedKnowledgeBase(db, undefined, ['onboarding.md']);
    const user = userEvent.setup();
    const { router } = renderApp(`/knowledge/${knowledgeBaseId}`);
    await screen.findByTestId('kb-meta');

    // exactly "Settings": the app's settings gear (D338) is the "Settings menu"
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    let dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed base');
    const size = within(dialog).getByLabelText('Chunk size (tokens)');
    await user.clear(size);
    await user.type(size, '400');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('kb-name')).toHaveTextContent('Renamed base'));
    expect(db.getKnowledgeBase(knowledgeBaseId)).toMatchObject({
      name: 'Renamed base',
      chunkSize: 400,
    });

    const [doc] = db.kbDocumentsOf(knowledgeBaseId);
    await user.click(screen.getByTestId('kb-reindex'));
    await waitFor(
      () =>
        expect(screen.getByTestId(`kb-doc-status-${doc!.id}`)).toHaveAttribute(
          'data-status',
          'ready',
        ),
      { timeout: 4000 },
    );
    expect(db.getKbDocument(doc!.id)?.status).toBe('ready');

    await user.click(screen.getByRole('button', { name: /delete knowledge base/i }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete knowledge base' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${projectId}/knowledge`),
    );
    expect(db.getKnowledgeBase(knowledgeBaseId)).toBeUndefined();
    expect(await screen.findByTestId('kb-empty')).toBeInTheDocument();
  });
});

describe('FR-RAG-007 A source link opens the document it came from', () => {
  it('marks the `?doc=` document and names the `?chunk=` it was opened from', async () => {
    const { knowledgeBaseId, documentIds } = seedKnowledgeBase(db);
    const target = documentIds[2]!;
    renderApp(`/knowledge/${knowledgeBaseId}?doc=${target}&chunk=chunk-42`);

    const row = await screen.findByTestId(`kb-doc-${target}`);
    expect(row).toHaveAttribute('data-focused', 'true');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId(`kb-doc-${documentIds[0]!}`)).not.toHaveAttribute('data-focused');
    expect(screen.getByTestId('kb-opened-chunk')).toHaveTextContent('chunk-42');
  });
});
