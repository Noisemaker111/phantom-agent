/**
 * Tool dispatch layer.
 *
 * Imports the `tools` array from @phantom/mcp-server, finds the requested
 * tool by name, builds a PhantomClient from the per-request session, then
 * calls the tool's handler.
 *
 * The tools array contains the actual implementations of all five Phantom
 * wallet operations. We reuse them verbatim — this file is purely plumbing.
 */

import { tools, type SessionData } from "@phantom/mcp-server";
import { Logger } from "./logger.js";
import { buildClient, buildSessionData, type RequestSession } from "./client.js";

// The MCP tools expect a logger that matches @phantom/mcp-server's internal
// Logger interface. Our Logger class has the same shape (info/warn/error/debug/child),
// so we cast it — the runtime behaviour is identical.
type McpLogger = Parameters<(typeof tools)[0]["handler"]>[1]["logger"];

const log = new Logger("tools");

/** Names of all valid Phantom MCP tools. */
export type PhantomToolName =
  | "get_wallet_addresses"
  | "sign_transaction"
  | "transfer_tokens"
  | "buy_token"
  | "sign_message";

const VALID_TOOLS = new Set<string>([
  "get_wallet_addresses",
  "sign_transaction",
  "transfer_tokens",
  "buy_token",
  "sign_message",
]);

/**
 * Dispatches a single MCP tool call.
 *
 * @throws {ToolNotFoundError} when the tool name is not in the registry
 * @throws Whatever the underlying tool handler throws on failure
 */
export async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  session: RequestSession,
): Promise<unknown> {
  if (!VALID_TOOLS.has(toolName)) {
    throw new ToolNotFoundError(toolName);
  }

  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    // The @phantom/mcp-server package is missing this tool — version mismatch.
    throw new ToolNotFoundError(toolName);
  }

  const client = buildClient(session);
  const sessionData = buildSessionData(session) as SessionData;
  const logger = new Logger(`tool:${toolName}`) as unknown as McpLogger;

  log.info(`Calling tool: ${toolName}`);

  const result = await tool.handler(args, { client, session: sessionData, logger });

  log.info(`Tool ${toolName} completed successfully`);

  return result;
}

export class ToolNotFoundError extends Error {
  constructor(toolName: string) {
    super(
      `Unknown tool: "${toolName}". Valid tools are: ${[...VALID_TOOLS].join(", ")}`,
    );
    this.name = "ToolNotFoundError";
  }
}
