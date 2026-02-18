/**
 * Phantom OAuth session validation.
 *
 * Identity is established exclusively through Phantom's SSO flow, handled by
 * the Chrome extension background service worker. There are no user accounts,
 * email/password, or Better Auth in this project.
 *
 * The session token obtained during the SSO flow is passed as an argument to
 * every Convex mutation/action that touches wallet operations. The stamper
 * secret key (generated client-side during SSO) is stored alongside it and
 * forwarded to the mcp-host server on every tool call.
 */

import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";

/** Resolved identity data for an authenticated Phantom session. */
export type PhantomSessionData = {
  userId: string;
  walletId: string;
  organizationId: string;
  /**
   * The stamper secret key generated in the extension during the SSO flow.
   * Forwarded to the mcp-host server per tool call so it can construct a
   * per-request PhantomClient. Treat as a sensitive credential.
   */
  stamperSecretKey: string;
};

/**
 * Internal validator. Returns resolved session data or null.
 * All wallet-touching actions must call this and abort on null.
 */
export const getSessionByToken = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }): Promise<PhantomSessionData | null> => {
    const session = await ctx.db
      .query("phantomSessions")
      .withIndex("by_sessionToken", (q) => q.eq("sessionToken", sessionToken))
      .unique();

    if (!session) return null;

    return {
      userId: session.userId,
      walletId: session.walletId,
      organizationId: session.organizationId,
      stamperSecretKey: session.stamperSecretKey,
    };
  },
});

/**
 * Public query: returns the identity for the current session token.
 * The extension UI calls this to determine whether to show the Connect button.
 * Note: stamperSecretKey is intentionally omitted from the public response.
 */
export const getCurrentSession = query({
  args: { sessionToken: v.string() },
  handler: async (
    ctx,
    { sessionToken },
  ): Promise<Omit<PhantomSessionData, "stamperSecretKey"> | null> => {
    const session = await ctx.db
      .query("phantomSessions")
      .withIndex("by_sessionToken", (q) => q.eq("sessionToken", sessionToken))
      .unique();

    if (!session) return null;

    return {
      userId: session.userId,
      walletId: session.walletId,
      organizationId: session.organizationId,
    };
  },
});

/**
 * Called by the extension background service worker after a successful SSO
 * flow. Upserts the session record keyed on userId so that re-auth replaces
 * the old record rather than accumulating stale rows.
 */
export const registerSession = mutation({
  args: {
    userId: v.string(),
    walletId: v.string(),
    organizationId: v.string(),
    sessionToken: v.string(),
    stamperSecretKey: v.string(),
  },
  handler: async (
    ctx,
    { userId, walletId, organizationId, sessionToken, stamperSecretKey },
  ) => {
    const existing = await ctx.db
      .query("phantomSessions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();

    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("phantomSessions", {
      userId,
      walletId,
      organizationId,
      sessionToken,
      stamperSecretKey,
      createdAt: Date.now(),
    });
  },
});

/**
 * Called when the user disconnects their wallet. Removes the session record.
 */
export const revokeSession = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const session = await ctx.db
      .query("phantomSessions")
      .withIndex("by_sessionToken", (q) => q.eq("sessionToken", sessionToken))
      .unique();

    if (session !== null) {
      await ctx.db.delete(session._id);
    }
  },
});
