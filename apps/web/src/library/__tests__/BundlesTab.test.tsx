import type { BundleFile } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { db, installMockServer, renderApp } from '../../test/app';
import { bundleFileProblems } from '../BundlesTab';

installMockServer();

/**
 * Library › Bundles (ACE parity P1, D273): importing an `ace-bundle` file — checked in the browser
 * first — installs its skills and lists its plugins, connected one by one only when the user
 * presses Connect; nothing is enabled for any agent, and deleting the bundle takes its skills.
 */

const file: BundleFile = {
  format: 'ace-bundle',
  formatVersion: 1,
  name: 'Docs team',
  description: 'How the docs team writes.',
  skills: [
    {
      name: 'Plain words',
      description: 'Short sentences.',
      instructions: 'Write short sentences.',
    },
    { name: 'Cite sources', instructions: 'Link every claim.' },
  ],
  mcpServers: [
    { name: 'files', transport: 'stdio', command: 'node', args: ['files.js', '--stdio'] },
    { name: 'search', transport: 'http', url: 'http://127.0.0.1:8000/mcp' },
  ],
};

const jsonFile = (content: unknown, name = 'docs.bundle.json') =>
  new File([typeof content === 'string' ? content : JSON.stringify(content)], name, {
    type: 'application/json',
  });

async function upload(user: ReturnType<typeof userEvent.setup>, content: unknown) {
  await user.upload(await screen.findByLabelText('Bundle file'), jsonFile(content));
}

describe('FR-SKL-003 D273 importing a bundle', () => {
  it('starts empty, and says that an import connects and enables nothing', async () => {
    renderApp('/library/bundles');
    expect(await screen.findByTestId('bundles-empty')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/connects nothing and enables nothing/);
    expect(screen.getByRole('button', { name: /import bundle/i })).toBeInTheDocument();
  });

  it('installs the skills and lists the plugins, unconnected', async () => {
    const user = userEvent.setup();
    renderApp('/library/bundles');
    await screen.findByTestId('bundles-empty');
    await upload(user, file);

    const bundle = await waitFor(() => {
      const [only] = db.listBundles();
      if (only === undefined) throw new Error('not imported yet');
      return only;
    });
    const card = await screen.findByTestId(`bundle-card-${bundle.id}`);
    expect(within(card).getByRole('heading', { name: 'Docs team' })).toBeInTheDocument();
    expect(within(card).getByText('How the docs team writes.')).toBeInTheDocument();
    const skills = within(card).getByRole('list', { name: 'Skills of Docs team' });
    expect(within(skills).getByText('Plain words')).toBeInTheDocument();
    expect(within(skills).getByText('Cite sources')).toBeInTheDocument();
    const plugins = within(card).getByRole('list', { name: 'Plugins of Docs team' });
    expect(within(plugins).getByText('stdio · node files.js --stdio')).toBeInTheDocument();
    expect(within(plugins).getByText('http · http://127.0.0.1:8000/mcp')).toBeInTheDocument();

    // Installed, as bundle skills; connected and enabled: nothing.
    expect(db.findSkillByName('Plain words')).toMatchObject({
      source: 'bundle',
      bundleId: bundle.id,
    });
    expect(db.listMcpServers()).toEqual([]);
    expect(within(plugins).getByRole('button', { name: 'Connect files' })).toBeInTheDocument();
  });

  it('connects one plugin through the MCP route when asked, and says so', async () => {
    const user = userEvent.setup();
    db.addBundle({
      id: db.nextId(),
      name: 'Docs team',
      description: '',
      skillIds: [],
      mcpServers: file.mcpServers ?? [],
      createdAt: new Date().toISOString(),
    });
    renderApp('/library/bundles');
    await user.click(await screen.findByRole('button', { name: 'Connect files' }));

    await waitFor(() =>
      expect(db.listMcpServers().map((server) => server.name)).toEqual(['files']),
    );
    expect(db.listMcpServers()[0]).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['files.js', '--stdio'],
    });
    expect(await screen.findByTestId('bundle-plugin-connected-files')).toHaveTextContent(
      'Connected',
    );
    // The other one stays as it was.
    expect(screen.getByRole('button', { name: 'Connect search' })).toBeInTheDocument();
  });

  it('refuses a file that is not JSON, and one that is not a bundle, saying why', async () => {
    const user = userEvent.setup();
    renderApp('/library/bundles');
    await screen.findByTestId('bundles-empty');

    await upload(user, '{ not json');
    expect(await screen.findByRole('alert')).toHaveTextContent('is not valid JSON');

    const { name: _name, ...nameless } = file;
    await upload(user, { ...nameless, skills: [{ name: 'x' }] });
    const problems = await screen.findByTestId('bundle-problems');
    expect(problems).toHaveTextContent('is not a bundle ACE can import');
    expect(problems).toHaveTextContent(/name:/);
    expect(problems).toHaveTextContent(/skills\.0\.instructions:/);
    expect(db.listBundles()).toEqual([]);
  });

  it('names a bundle written in another format version', async () => {
    const user = userEvent.setup();
    renderApp('/library/bundles');
    await screen.findByTestId('bundles-empty');
    await upload(user, { ...file, formatVersion: 2 });
    expect(await screen.findByTestId('bundle-problems')).toHaveTextContent(
      'format version 2; this ACE reads version 1',
    );
  });

  it('deletes a bundle and its skills after asking', async () => {
    const user = userEvent.setup();
    renderApp('/library/bundles');
    await screen.findByTestId('bundles-empty');
    await upload(user, file);
    const card = await screen.findByTestId(/^bundle-card-/);

    await user.click(within(card).getByRole('button', { name: 'Delete bundle Docs team' }));
    const confirm = await screen.findByRole('dialog', {
      name: 'Delete the bundle "Docs team"?',
    });
    expect(within(confirm).getByText(/2 skills are removed with it/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Delete bundle' }));

    expect(await screen.findByTestId('bundles-empty')).toBeInTheDocument();
    expect(db.findSkillByName('Plain words')).toBeUndefined();
  });

  it('marks a skill of the bundle that was removed on its own', async () => {
    db.addBundle({
      id: db.nextId(),
      name: 'Old',
      description: '',
      skillIds: ['01K6SKGNE00000000000000000'],
      mcpServers: [],
      createdAt: new Date().toISOString(),
    });
    renderApp('/library/bundles');
    expect(await screen.findByText('Removed skill')).toBeInTheDocument();
    expect(screen.getByText('This bundle names no plugins.')).toBeInTheDocument();
  });
});

describe('bundleFileProblems', () => {
  it('accepts a valid file and lists every problem of an invalid one', () => {
    expect(bundleFileProblems(file)).toEqual([]);
    expect(bundleFileProblems(null).length).toBeGreaterThan(0);
    expect(
      bundleFileProblems({ ...file, mcpServers: [{ name: 'x', transport: 'stdio' }] }),
    ).toEqual([expect.stringMatching(/^mcpServers\.0\.command:/)]);
  });
});
