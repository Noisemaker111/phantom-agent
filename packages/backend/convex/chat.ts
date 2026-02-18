/**
 * Chat layer — thread lifecycle + message exchange.
 *
 * Authentication: every mutation/action that touches wallet operations requires
 * a valid Phantom session token passed as an argument. The token is validated
 * against the `phantomSessions` table via auth.getSessionByToken before any
 * agent action is dispatched.
 *
 * The session credentials (walletId, organizationId, sessionToken, stamperSecretKey)
 * are forwarded to generateResponseAsync so that each MCP tool call is
 * authenticated with the correct user's Phantom session.
 */

import {
  createThread,
  listUIMessages,
  saveMessage,
  syncStreams,
  vStreamArgs,
} from "@convex-dev/agent";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction, mutation, query } from "./_generated/server";
import { chatAgent } from "./agent";

// ---------------------------------------------------------------------------
// Thread lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new conversation thread.
 * Validates the Phantom session before creating the thread.
 */
export const createNewThread = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const session = await ctx.runQuery(internal.auth.getSessionByToken, { sessionToken });
    if (session === null) {
      throw new Error("Invalid or expired Phantom session. Please reconnect your wallet.");
    }
    const threadId = await createThread(ctx, components.agent, { title: "Phantom Agent" });
    return threadId;
  },
});

// ---------------------------------------------------------------------------
// Message list — subscribed to by the UI via useUIMessages
// ---------------------------------------------------------------------------

export const listMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    const paginated = await listUIMessages(ctx, components.agent, args);
    const streams = await syncStreams(ctx, components.agent, args);
    return { ...paginated, streams };
  },
});

// ---------------------------------------------------------------------------
// Send message + schedule async agent response
// ---------------------------------------------------------------------------

/**
 * Saves the user's message and schedules the async agent response.
 * Session validation runs here; validated credentials are forwarded to the
 * agent action so every MCP tool call carries the correct Phantom session.
 */
export const sendMessage = mutation({
  args: {
    threadId: v.string(),
    prompt: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, { threadId, prompt, sessionToken }) => {
    const session = await ctx.runQuery(internal.auth.getSessionByToken, { sessionToken });
    if (session === null) {
      throw new Error("Invalid or expired Phantom session. Please reconnect your wallet.");
    }

    const { messageId } = await saveMessage(ctx, components.agent, { threadId, prompt });

    await ctx.scheduler.runAfter(0, internal.chat.generateResponseAsync, {
      threadId,
      promptMessageId: messageId,
      sessionToken,
      walletId: session.walletId,
      organizationId: session.organizationId,
      stamperSecretKey: session.stamperSecretKey,
    });

    return messageId;
  },
});

// ---------------------------------------------------------------------------
// Async agent response generation
// ---------------------------------------------------------------------------

/**
 * The core agent action. Receives validated session credentials from
 * sendMessage and injects them into the conversation as a hidden system
 * message so the model passes them verbatim in every tool call argument
 * object.
 *
 * @convex-dev/agent does not yet support per-call tool context injection,
 * so session credentials are carried as explicit tool args in each tool's
 * zod schema. The model is instructed to include them unconditionally.
 */
export const generateResponseAsync = internalAction({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
    sessionToken: v.string(),
    walletId: v.string(),
    organizationId: v.string(),
    stamperSecretKey: v.string(),
  },
  handler: async (
    ctx,
    { threadId, promptMessageId, sessionToken, walletId, organizationId, stamperSecretKey },
  ) => {
    const sessionContext =
      `[SYSTEM CONTEXT — not visible to user]\n` +
      `Include these exact values in every tool call:\n` +
      `  sessionToken: ${sessionToken}\n` +
      `  walletId: ${walletId}\n` +
      `  organizationId: ${organizationId}\n` +
      `  stamperSecretKey: ${stamperSecretKey}\n` +
      `\n` +
      `Do NOT omit any of these fields. They are required for authentication.`;

    await chatAgent.streamText(
      ctx,
      { threadId },
      {
        promptMessageId,
        system: sessionContext,
      },
      { saveStreamDeltas: true },
    );
  },
});
