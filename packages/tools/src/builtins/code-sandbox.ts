import { z } from "zod";

import { SANDBOX_LANGUAGES, type ToolDefinition } from "@ace/contracts";
import { type Sandbox } from "@ace/engine";

import { ToolError } from "../errors.js";
import { SANDBOX_DENIED_MESSAGE } from "../logging.js";
import { type RegisteredTool } from "../registry.js";
import { collectProducedFiles } from "../sandbox/collect-files.js";
import { prepareCodeRun } from "../sandbox/languages.js";

/**
 * `code_sandbox { language, code, timeoutMs? } → { stdout, stderr, exitCode, files }` (§2.2,
 * FR-TOOL-004, D13).
 *
 * The tool builds the invocation (`languages.ts`) and runs it through the {@link Sandbox} port —
 * the child-process runner locally, a container when Docker is available (D13); every test uses the
 * child process (round 4 §2). Two outcomes are turned into `ToolError`s the executor maps to a
 * `ToolCallStatus`:
 *
 * - a `while (true)` that overruns `timeoutMs` is killed and reported `timeout` (TC-TOOL-004),
 *   carrying whatever it had printed;
 * - a `python` run with no interpreter on the machine is `unavailable`, not a raw spawn error — so
 *   `pnpm test` on a box without Python is a clean skip, never a failure;
 * - a `python` or `shell` run is `unavailable` unless `allowUnconfined` is set (D-083): only
 *   `javascript` is confined to its folder by the child-process runner (Node's permission model,
 *   D227), and there is no Docker runner yet to confine the other two. Refused before anything runs.
 *
 * **`files`** — §2.2 types this `Artifact[]`. This package returns `{ path, size }` per produced
 * file (see `collect-files.ts`): hashing a file into an `Artifact` is the engine's artifact store,
 * which a tool must not reach. The executor maps these paths to artifacts as it logs the call.
 */

export const CODE_SANDBOX_DEFAULT_TIMEOUT_MS = 10_000;
export const CODE_SANDBOX_MAX_TIMEOUT_MS = 30_000;

const CodeArgs = z.strictObject({
  language: z.enum(SANDBOX_LANGUAGES),
  code: z.string(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(CODE_SANDBOX_MAX_TIMEOUT_MS)
    .optional(),
});

export const CODE_SANDBOX_DEFINITION: ToolDefinition = {
  name: "code_sandbox",
  description:
    "Runs a short JavaScript program in an isolated sandbox folder. Python and shell are refused until a runner can confine them.",
  inputSchema: {
    type: "object",
    properties: {
      language: { type: "string", enum: [...SANDBOX_LANGUAGES] },
      code: { type: "string" },
      timeoutMs: { type: "number", maximum: CODE_SANDBOX_MAX_TIMEOUT_MS },
    },
    required: ["language", "code"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "number" },
      files: {
        type: "array",
        description:
          "Files the run produced (path relative to the sandbox, and size in bytes).",
        items: {
          type: "object",
          properties: { path: { type: "string" }, size: { type: "number" } },
          required: ["path", "size"],
        },
      },
    },
    required: ["stdout", "stderr", "exitCode", "files"],
  },
  permissions: { network: false, fsPaths: ["<sandbox>"], destructive: false },
  timeoutMs: CODE_SANDBOX_MAX_TIMEOUT_MS,
  source: "builtin",
};

/**
 * The refusal Node's permission model prints when a `javascript` run dies reaching outside its
 * folder (`nodePermissionFlags` in `sandbox/languages.ts`): an uncaught error whose `code` is
 * `ERR_ACCESS_DENIED`, with the `permission` it lacked and the `resource` it asked for. A program
 * that catches the error itself finishes normally — the access was refused all the same.
 */
export function accessDenial(
  stderr: string,
): { permission: string; resource?: string } | undefined {
  if (!stderr.includes("ERR_ACCESS_DENIED")) return undefined;
  const permission = /permission: '([A-Za-z]+)'/.exec(stderr)?.[1] ?? "unknown";
  const resource = /resource: '((?:[^'\\]|\\.)*)'/
    .exec(stderr)?.[1]
    ?.replace(/\\\\/g, "\\");
  return resource === undefined ? { permission } : { permission, resource };
}

export interface CodeSandboxToolOptions {
  readonly sandbox: Sandbox;
  readonly platform?: NodeJS.Platform;
  readonly nodePath?: string;
  readonly pythonPath?: string | null;
  readonly maxOldSpaceMb?: number;
  readonly defaultTimeoutMs?: number;
  /**
   * Run `python` and `shell` although nothing confines their filesystem (D-083). Off by default;
   * for tests of the runner and for a future Docker runner that does confine them.
   */
  readonly allowUnconfined?: boolean;
}

export function createCodeSandboxTool(
  options: CodeSandboxToolOptions,
): RegisteredTool {
  const { sandbox } = options;
  const defaultTimeoutMs =
    options.defaultTimeoutMs ?? CODE_SANDBOX_DEFAULT_TIMEOUT_MS;

  return {
    definition: CODE_SANDBOX_DEFINITION,
    implementation: async (args, context) => {
      const parsed = CodeArgs.safeParse(args);
      if (!parsed.success) {
        throw new ToolError(
          "invalid_args",
          "code_sandbox",
          "code_sandbox needs { language, code }.",
          {
            issues: parsed.error.issues.map((issue) => issue.message),
          },
        );
      }

      if (
        parsed.data.language !== "javascript" &&
        options.allowUnconfined !== true
      ) {
        throw new ToolError(
          "unavailable",
          "code_sandbox",
          `code_sandbox cannot run ${parsed.data.language} yet: only javascript is confined to its ` +
            "sandbox folder on this engine (D-083). Rewrite the program in javascript.",
          { language: parsed.data.language },
        );
      }

      const timeoutMs = Math.min(
        parsed.data.timeoutMs ?? defaultTimeoutMs,
        CODE_SANDBOX_MAX_TIMEOUT_MS,
      );

      const prepared = prepareCodeRun({
        sandboxDir: context.sandboxDir,
        language: parsed.data.language,
        code: parsed.data.code,
        timeoutMs,
        platform: options.platform,
        nodePath: options.nodePath,
        pythonPath: options.pythonPath,
        maxOldSpaceMb: options.maxOldSpaceMb,
      });

      if ("unavailable" in prepared) {
        throw new ToolError(
          "unavailable",
          "code_sandbox",
          "No Python interpreter is available on this machine.",
          { language: parsed.data.language },
        );
      }

      const result = await sandbox.run(context.scope, prepared.spec);

      if (result.timedOut) {
        throw new ToolError(
          "timeout",
          "code_sandbox",
          `code_sandbox did not finish within ${timeoutMs} ms and was stopped.`,
          { timeoutMs, stdout: result.stdout, stderr: result.stderr },
        );
      }

      // TC-TOOL-005: the runtime refused a reach outside the sandbox and the program died of it.
      const denial =
        parsed.data.language === "javascript"
          ? accessDenial(result.stderr)
          : undefined;
      if (denial !== undefined) {
        context.logger.warn(
          {
            tool: "code_sandbox",
            operation: "run",
            language: parsed.data.language,
            permission: denial.permission,
            resource: denial.resource,
            exitCode: result.exitCode,
            sandboxDir: context.sandboxDir,
            runId: context.runId,
          },
          SANDBOX_DENIED_MESSAGE,
        );
        throw new ToolError(
          "denied",
          "code_sandbox",
          `code_sandbox: the program reached outside its sandbox folder and was denied ` +
            `(ERR_ACCESS_DENIED, ${denial.permission}); nothing outside was read or changed.`,
          {
            permission: denial.permission,
            resource: denial.resource,
            exitCode: result.exitCode,
          },
        );
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        files: collectProducedFiles(context.sandboxDir),
      };
    },
  };
}
