/**
 * Phantom MCP proxy layer.
 *
 * The Phantom MCP server is a Node.js process that cannot run inside a Chrome
 * extension. This module acts as the bridge: Convex internal actions call
 * `callMcpTool` which forwards the request to the separately-hosted Phantom
 * MCP service over HTTP, passing the caller's per-request session credentials.
 *
 * The hosted MCP server URL is set via the PHANTOM_MCP_SERVER_URL environment
 * variable in the Convex deployment settings.
 *
 * Session credentials (walletId, organizationId, sessionToken) are passed in
 * every request so the MCP server can authenticate with Phantom on behalf of
 * the specific user. The hosted MCP server must be patched to accept these
 * per-request credentials rather than reading from the filesystem.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Phantom MCP tool name. Kept as a discriminated union so that
 *  call sites get a compile-time reminder of valid tool names. */
export type PhantomToolName =
  | "get_wallet_addresses"
  | "sign_transaction"
  | "transfer_tokens"
  | "buy_token"
  | "sign_message";

/** The per-user session credentials forwarded with every MCP tool call. */
export type McpSessionCredentials = {
  walletId: string;
  organizationId: string;
  sessionToken: string;
};

/** Shape the hosted MCP server is expected to return on success. */
type McpToolResult = {
  success: true;
  result: unknown;
};

/** Shape the hosted MCP server returns on failure. */
type McpToolError = {
  success: false;
  error: string;
};

type McpResponse = McpToolResult | McpToolError;

// ---------------------------------------------------------------------------
// Internal action — called by the agent inside generateResponseAsync
// ---------------------------------------------------------------------------

/**
 * Proxies a single Phantom MCP tool call to the hosted MCP server.
 *
 * @param toolName  - One of the five Phantom MCP tool names.
 * @param toolArgs  - JSON-serialisable arguments for the tool (tool-specific).
 * @param session   - The caller's Phantom session credentials.
 * @returns The raw result from the MCP server, JSON-encoded as a string so
 *          the agent can include it verbatim in its reasoning without the
 *          Convex action layer needing to understand the schema.
 */
export const callMcpTool = internalAction({
  args: {
    toolName: v.string(),
    toolArgs: v.string(), // JSON-encoded tool arguments
    walletId: v.string(),
    organizationId: v.string(),
    sessionToken: v.string(),
    stamperSecretKey: v.string(),
  },
  handler: async (
    _ctx,
    { toolName, toolArgs, walletId, organizationId, sessionToken, stamperSecretKey },
  ): Promise<string> => {
    const mcpServerUrl = process.env.PHANTOM_MCP_SERVER_URL;
    if (!mcpServerUrl) {
      throw new Error(
        "PHANTOM_MCP_SERVER_URL is not configured. " +
          "Set this environment variable in your Convex deployment settings.",
      );
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(toolArgs);
    } catch {
      throw new Error(`toolArgs is not valid JSON: ${toolArgs}`);
    }

    const requestBody = {
      tool: toolName,
      args: parsedArgs,
      session: {
        walletId,
        organizationId,
        sessionToken,
        stamperSecretKey,
      },
    };

    let response: Response;
    try {
      response = await fetch(`${mcpServerUrl}/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The MCP server validates this shared secret to prevent
          // unauthenticated callers from reaching the Phantom API.
          Authorization: `Bearer ${process.env.PHANTOM_MCP_SHARED_SECRET ?? ""}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      throw new Error(
        `Network error reaching Phantom MCP server at ${mcpServerUrl}: ${String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable body)");
      throw new Error(
        `Phantom MCP server returned HTTP ${response.status}: ${body}`,
      );
    }

    let mcpResponse: McpResponse;
    try {
      mcpResponse = (await response.json()) as McpResponse;
    } catch {
      throw new Error("Phantom MCP server returned non-JSON response");
    }

    if (!mcpResponse.success) {
      throw new Error(`Phantom MCP tool error: ${mcpResponse.error}`);
    }

    return JSON.stringify(mcpResponse.result);
  },
});

/**
 * Resolves an approval decision back to the hosted MCP server.
 * Called after the user clicks Approve or Reject in the conversation.
 */
export const resolveApproval = internalAction({
  args: {
    approvalId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    sessionToken: v.string(),
  },
  handler: async (_ctx, { approvalId, decision, sessionToken }): Promise<void> => {
    const mcpServerUrl = process.env.PHANTOM_MCP_SERVER_URL;
    if (!mcpServerUrl) {
      throw new Error("PHANTOM_MCP_SERVER_URL is not configured.");
    }

    const response = await fetch(`${mcpServerUrl}/resolve-approval`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PHANTOM_MCP_SHARED_SECRET ?? ""}`,
      },
      body: JSON.stringify({ approvalId, decision, sessionToken }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable body)");
      throw new Error(
        `Failed to resolve approval with MCP server: HTTP ${response.status}: ${body}`,
      );
    }
  },
});
