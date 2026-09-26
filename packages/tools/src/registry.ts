import { ToolDefinitionSchema, TOOL_NAME_REGEX, type ToolDefinition } from '@ace/contracts';

import { ToolRegistrationError } from './errors.js';
import { type ToolImplementation } from './tool.js';

/** A definition and the code behind it (FR-TOOL-001). */
export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly implementation: ToolImplementation;
}

/**
 * The tool registry (FR-TOOL-001, Arch §16).
 *
 * A `Map` keeps insertion order, which is what makes `list()` return the built-ins in §2.2's order
 * without a sort that could drift from the contract's `BUILTIN_TOOL_NAMES`.
 *
 * Two refusals, both of them deliberate rather than defensive:
 *
 * - **A name that is not snake_case.** `ToolDefinitionSchema` already says so, but an MCP server
 *   names its own tools (FR-TOOL-007) and the registry is the last thing standing between a
 *   server's `Read File` and an agent's `tools.enabled` list. The check is re-run here rather than
 *   assumed, so no caller can skip it by handing over an unparsed object.
 * - **A name already taken.** `tools.enabled` holds names, so two tools called the same thing make
 *   "which tool did the agent enable?" unanswerable (§2.2). The first registration wins: a later
 *   MCP server cannot shadow `code_sandbox` and inherit its enablement.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Adds a tool. Throws {@link ToolRegistrationError} if the name is not snake_case, the name is
   * taken, or the definition does not satisfy the contract.
   */
  register(definition: ToolDefinition, implementation: ToolImplementation): void {
    const name = (definition as { name?: unknown }).name;

    if (typeof name !== 'string' || !TOOL_NAME_REGEX.test(name)) {
      throw new ToolRegistrationError(
        String(name),
        `Tool name ${JSON.stringify(name)} is not snake_case, such as web_search.`,
      );
    }

    if (this.tools.has(name)) {
      throw new ToolRegistrationError(
        name,
        `Tool ${name} is already registered; a name is unique across the whole registry.`,
      );
    }

    const parsed = ToolDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      throw new ToolRegistrationError(
        name,
        `Tool ${name} does not satisfy ToolDefinition: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; ')}`,
      );
    }

    this.tools.set(name, { definition: parsed.data, implementation });
  }

  /** Every registered definition, in registration order (`GET /tools` → `{ items }`). */
  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  /** The tool called `name`, or `undefined`. */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Whether `name` is registered — what pre-flight's `tool_not_registered` asks (§2.4). */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Removes one tool. `false` if it was not there. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Removes every tool contributed by one MCP server, in registration order, and returns their
   * names. This is what a removed server's `DELETE /mcp-servers/:id` needs (FR-TOOL-007): the
   * names it returns are exactly the ones an agent's `tools.enabled` must now report as
   * `tool_not_registered`.
   */
  unregisterServer(mcpServerId: string): string[] {
    const removed = this.list()
      .filter((definition) => definition.mcpServerId === mcpServerId)
      .map((definition) => definition.name);
    for (const name of removed) this.tools.delete(name);
    return removed;
  }
}
