import { afterEach, describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import { writeStdioMcpFixture } from '../__tests__/helpers.js';
import { McpClient } from './client.js';

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

async function connectFixture(): Promise<McpClient> {
  const fixture = writeStdioMcpFixture();
  cleanups.push(fixture.cleanup);
  const client = await McpClient.connect({ transport: 'stdio', command: process.execPath, args: [fixture.path] });
  cleanups.push(() => client.close());
  return client;
}

describe('McpClient', () => {
  it('refuses a stdio connection with no command and an http one with no url', async () => {
    await expect(McpClient.connect({ transport: 'stdio' })).rejects.toBeInstanceOf(ToolError);
    await expect(McpClient.connect({ transport: 'http' })).rejects.toBeInstanceOf(ToolError);
  });

  it('lists tools with their schemas and annotations', async () => {
    const client = await connectFixture();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['reverse', 'wipe']);
    expect(tools[1]?.annotations?.destructiveHint).toBe(true);
  });

  it('flattens a text result and flags an error result', async () => {
    const client = await connectFixture();
    expect(await client.callTool('reverse', { text: 'ace' })).toEqual({ text: 'eca', isError: false });
    expect((await client.callTool('nope', {})).isError).toBe(true);
  });

  it('pings true while up and false after close', async () => {
    const client = await connectFixture();
    expect(await client.ping()).toBe(true);
    await client.close();
    expect(await client.ping()).toBe(false);
  });
});
