import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createNode } from '../nodes/factory';
import { db, installMockServer, renderApp } from '../test/app';

installMockServer();

vi.mock('../canvas/Canvas', () => ({ Canvas: () => <div data-testid="canvas" /> }));

function file(contents: unknown, name = 'flow.ace.json'): File {
  return new File([JSON.stringify(contents)], name, { type: 'application/json' });
}

describe('Import workflow JSON (FR-WF-008, UI side)', () => {
  it('a valid export creates a workflow with the same graph and opens it', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const source = db.createWorkflow(project.id, 'Source');
    const node = createNode('input', source.id, { x: 1, y: 2 });
    db.commitGraph(source.id, [node], []);
    const exported = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      name: 'Source',
      nodes: [node],
      edges: [],
    };
    const { router } = renderApp(`/projects/${project.id}`);
    await screen.findByRole('button', { name: /import json/i });
    await user.upload(screen.getByLabelText(/import json/i), file(exported));
    await waitFor(() => expect(db.listWorkflows(project.id)).toHaveLength(2));
    const imported = db.listWorkflows(project.id).find((w) => w.id !== source.id)!;
    expect(db.nodesOf(imported.id)).toHaveLength(1);
    expect(db.nodesOf(imported.id)[0]?.id).not.toBe(node.id);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/projects/${project.id}/workflows/${imported.id}`,
      ),
    );
  });

  it('TC-WF-008: an unsupported formatVersion is a clear error and creates nothing', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    await screen.findByRole('button', { name: /import json/i });
    await user.upload(
      screen.getByLabelText(/import json/i),
      file({ formatVersion: 99, exportedAt: 'x', name: 'n', nodes: [], edges: [] }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/format version 99/i);
    expect(db.listWorkflows(project.id)).toHaveLength(0);
  });

  it('a file that is not JSON is a clear error', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    renderApp(`/projects/${project.id}`);
    await screen.findByRole('button', { name: /import json/i });
    await user.upload(
      screen.getByLabelText(/import json/i),
      new File(['not json'], 'x.json', { type: 'application/json' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid json/i);
  });
});
