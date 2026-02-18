/**
 * HTTP router for the Phantom Agent Convex backend.
 *
 * Endpoints:
 *   POST /phantom-approval  — receives wallet-initiated approval events from
 *                             the hosted Phantom MCP server via webhook.
 */

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

/**
 * Phantom MCP server webhook: fired when the embedded wallet receives an
 * external approval request (e.g. a dApp requesting a signature or
 * connection). The MCP server POSTs the raw approval event JSON here.
 *
 * This handler:
 * 1. Validates the shared webhook secret sent in the Authorization header.
 * 2. Reads the raw payload from the request body.
 * 3. Schedules an internal action that summarises the payload with the LLM
 *    and injects the plain-English description into the active thread.
 */
http.route({
  path: "/phantom-approval",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.PHANTOM_WEBHOOK_SECRET;
    const authHeader = request.headers.get("Authorization");

    if (!webhookSecret || authHeader !== `Bearer ${webhookSecret}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !("threadId" in body) ||
      typeof (body as Record<string, unknown>).threadId !== "string"
    ) {
      return new Response(
        "Request body must include threadId: string",
        { status: 400 },
      );
    }

    const payload = body as { threadId: string; [key: string]: unknown };

    await ctx.runMutation(internal.approvals.createPendingApproval, {
      threadId: payload.threadId,
      approvalPayload: JSON.stringify(body),
    });

    return new Response(null, { status: 202 });
  }),
});

export default http;
