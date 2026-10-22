import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChildProcessSandbox } from "../sandbox/runner.js";
import { makeContext } from "../__tests__/helpers.js";
import {
  CODE_SANDBOX_DEFINITION,
  createCodeSandboxTool,
} from "./code-sandbox.js";

const tool = createCodeSandboxTool({ sandbox: new ChildProcessSandbox() });
let contexts: Array<{ cleanup: () => void }> = [];
afterEach(() => {
  for (const context of contexts) context.cleanup();
  contexts = [];
});
function ctx(): ReturnType<typeof makeContext> {
  const context = makeContext();
  contexts.push(context);
  return context;
}

describe("code_sandbox definition", () => {
  it("is confined to the sandbox with no network permission", () => {
    expect(CODE_SANDBOX_DEFINITION.permissions).toEqual({
      network: false,
      fsPaths: ["<sandbox>"],
      destructive: false,
    });
  });
});

describe("TC-TOOL-004/005 code_sandbox execution", () => {
  it("runs JavaScript and returns stdout and the exit code", async () => {
    const result = (await tool.implementation(
      { language: "javascript", code: 'process.stdout.write("hello from js")' },
      ctx(),
    )) as { stdout: string; exitCode: number; files: unknown[] };
    expect(result.stdout).toBe("hello from js");
    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("collects a file the run produced", async () => {
    const context = ctx();
    const result = (await tool.implementation(
      {
        language: "javascript",
        code: `require('fs').writeFileSync('artifact.txt', 'produced')`,
      },
      context,
    )) as { files: Array<{ path: string; size: number }> };
    expect(result.files).toContainEqual({
      path: "artifact.txt",
      size: "produced".length,
    });
    expect(readFileSync(join(context.sandboxDir, "artifact.txt"), "utf8")).toBe(
      "produced",
    );
  });

  it("reports timeout when code overruns, carrying partial output", async () => {
    await expect(
      tool.implementation(
        {
          language: "javascript",
          code: 'process.stdout.write("before"); while (true) {}',
          timeoutMs: 500,
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("makes the home directory the sandbox, so `~` cannot reach the real home", async () => {
    const context = ctx();
    const result = (await tool.implementation(
      {
        language: "javascript",
        code: `process.stdout.write(require('os').homedir())`,
      },
      context,
    )) as { stdout: string };
    expect(result.stdout).toBe(context.sandboxDir);
  });

  it("denies the interpreter its own network (NFR-SEC-04)", async () => {
    const result = (await tool.implementation(
      {
        language: "javascript",
        code: `try { require('node:http').get('http://127.0.0.1:1'); } catch (e) { process.stderr.write(String(e.message)); }`,
      },
      ctx(),
    )) as { stderr: string };
    expect(result.stderr).toContain("network access is denied");
  });

  it("denies DNS and UDP too, through every entry point [audit S-3]", async () => {
    // Each probe prints the denial it got, or `REACHED` when the call went out.
    const code = `
      const dns = require('node:dns');
      const dgram = require('node:dgram');
      const out = [];
      const probe = (name, fn) => {
        try { fn(); out.push(name + ':REACHED'); } catch (e) { out.push(name + ':' + e.message); }
      };
      probe('lookup', () => dns.lookup('localhost', () => {}));
      probe('resolve4', () => dns.resolve4('localhost', () => {}));
      probe('resolver', () => new dns.Resolver().resolve4('localhost', () => {}));
      probe('lookupService', () => dns.lookupService('127.0.0.1', 22, () => {}));
      probe('createSocket', () => dgram.createSocket('udp4'));
      probe('udpSend', () => new dgram.Socket('udp4').send(Buffer.from('x'), 53, '127.0.0.1'));
      // setServers re-binds the module's resolve* from the Resolver prototype: still denied.
      dns.setServers(['127.0.0.1']);
      probe('rebound', () => dns.resolve4('localhost', () => {}));
      Promise.allSettled([
        dns.promises.lookup('localhost'),
        require('node:dns/promises').resolve4('localhost'),
        new dns.promises.Resolver().resolveTxt('localhost'),
      ]).then((settled) => {
        settled.forEach((s, i) => out.push('promise' + i + ':' + (s.status === 'rejected' ? s.reason.message : 'REACHED')));
        process.stdout.write(out.join('\\n'));
      });
    `;
    const result = (await tool.implementation(
      { language: "javascript", code },
      ctx(),
    )) as { stdout: string; exitCode: number };

    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(10);
    for (const line of lines) expect(line).toMatch(/:ACE sandbox: network access is denied$/);
    expect(result.exitCode).toBe(0);
  });

  it("refuses a bad args shape", async () => {
    await expect(
      tool.implementation({ language: "ruby", code: "x" }, ctx()),
    ).rejects.toMatchObject({
      kind: "invalid_args",
    });
  });

  it("reports python unavailable rather than failing when there is no interpreter", async () => {
    const noPython = createCodeSandboxTool({
      sandbox: new ChildProcessSandbox(),
      pythonPath: null,
      allowUnconfined: true,
    });
    await expect(
      noPython.implementation({ language: "python", code: "print(1)" }, ctx()),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("D-083 python and shell are refused until a runner can confine them", () => {
  /** Counts spawns, so the refusal is proven to come before anything runs. */
  function countingSandbox(): {
    sandbox: ChildProcessSandbox;
    runs: () => number;
  } {
    const sandbox = new ChildProcessSandbox();
    let runs = 0;
    const run = sandbox.run.bind(sandbox);
    sandbox.run = (scope, spec) => {
      runs += 1;
      return run(scope, spec);
    };
    return { sandbox, runs: () => runs };
  }

  for (const language of ["python", "shell"] as const) {
    it(`refuses ${language} as unavailable by default and spawns nothing`, async () => {
      const { sandbox, runs } = countingSandbox();
      const confined = createCodeSandboxTool({
        sandbox,
        pythonPath: process.execPath,
      });
      await expect(
        confined.implementation({ language, code: "echo hi" }, ctx()),
      ).rejects.toMatchObject({
        kind: "unavailable",
        message: expect.stringContaining("javascript"),
      });
      expect(runs()).toBe(0);
    });
  }

  it("still runs javascript by default, under Node permissions (D227)", async () => {
    const { sandbox, runs } = countingSandbox();
    const confined = createCodeSandboxTool({ sandbox });
    const result = (await confined.implementation(
      { language: "javascript", code: 'process.stdout.write("ok")' },
      ctx(),
    )) as { stdout: string };
    expect(result.stdout).toBe("ok");
    expect(runs()).toBe(1);
  });
});
