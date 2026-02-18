/**
 * Wallet-initiated approval handling.
 *
 * When the hosted Phantom MCP server intercepts an external approval request
 * (e.g. a dApp requesting a signature or wallet connection), it POSTs to the
 * /phantom-approval HTTP endpoint (see http.ts). This module:
 *
 * 1. Persists the raw approval payload to the `pendingApprovals` table.
 * 2. Schedules an LLM summarisation action that describes the approval in plain
 *    English and injects it into the active conversation thread.
 * 3. Exposes a mutation for the UI to call when the user approves or rejects.
 *
 * The agent formats its approval description with two inline action options
 * that the UI renders as buttons:
 *   [Approve] [Reject]
 *
 * The user's button click (or natural language "yes"/"no") resolves the
 * pending approval and notifies the MCP server via phantom.resolveApproval.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { chatAgent } from "./agent";

// ---------------------------------------------------------------------------
// Internal mutation — called by the HTTP handler
// ---------------------------------------------------------------------------

/**
 * Persists a pending approval and schedules summarisation.
 */
export const createPendingApproval = internalMutation({
  args: {
    threadId: v.string(),
    approvalPayload: v.string(),
  },
  handler: async (ctx, { threadId, approvalPayload }) => {
    const approvalId = await ctx.db.insert("pendingApprovals", {
      threadId,
      approvalPayload,
      status: "pending",
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.approvals.summariseApproval, {
      approvalId: approvalId.toString(),
      threadId,
      approvalPayload,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal action — LLM summarisation
// ---------------------------------------------------------------------------

/**
 * Asks the agent to describe the approval in plain English and inject the
 * description into the conversation thread as an agent message.
 *
 * The agent always ends its approval description with a clear decision prompt
 * and the exact strings "[Approve]" and "[Reject]" so the frontend can render
 * them as action buttons.
 */
export const summariseApproval = internalAction({
  args: {
    approvalId: v.string(),
    threadId: v.string(),
    approvalPayload: v.string(),
  },
  handler: async (ctx, { approvalId, threadId, approvalPayload }) => {
    const systemContext = `You are describing a Phantom wallet approval request to the user.
The following JSON payload was received from an external source requesting wallet interaction.
Describe in plain English:
1. What is being requested
2. What it would actually do to the user's wallet (signs what, transfers what, authorises what)
3. Whether there are any risk indicators in the payload (unknown domains, large amounts, unusual permissions)

End your response with exactly:

**What would you like to do?**
[Approve] [Reject]

APPROVAL_ID: ${approvalId}

Raw approval payload:
${approvalPayload}`;

    await chatAgent.streamText(
      ctx,
      { threadId },
      {
        messages: [
          {
            role: "user" as const,
            content: systemContext,
          },
        ],
      },
      { saveStreamDeltas: true },
    );
  },
});

// ---------------------------------------------------------------------------
// Public mutation — resolves the user's decision
// ---------------------------------------------------------------------------

/**
 * Called by the extension UI when the user clicks Approve or Reject (or types
 * an equivalent natural language response). Updates the database record and
 * dispatches the decision to the hosted MCP server.
 */
export const resolveApproval = mutation({
  args: {
    approvalId: v.id("pendingApprovals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    sessionToken: v.string(),
  },
  handler: async (ctx, { approvalId, decision, sessionToken }) => {
    const approval = await ctx.db.get(approvalId);
    if (!approval) {
      throw new Error(`Approval ${approvalId.toString()} not found`);
    }
    if (approval.status !== "pending") {
      throw new Error(
        `Approval ${approvalId.toString()} has already been ${approval.status}`,
      );
    }

    await ctx.db.patch(approvalId, { status: decision });

    // Schedule the MCP server notification as an action (network I/O).
    await ctx.scheduler.runAfter(0, internal.phantom.resolveApproval, {
      approvalId: approvalId.toString(),
      decision,
      sessionToken,
    });
  },
});
