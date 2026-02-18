import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /**
   * One row per authenticated Phantom user.
   * Upserted by the background service worker after each successful OAuth
   * exchange. Keyed on userId so re-auth replaces the old row.
   */
  phantomSessions: defineTable({
    /** Phantom user ID from the OAuth response (stable across re-auths). */
    userId: v.string(),
    /** The embedded wallet ID associated with this user. */
    walletId: v.string(),
    /** The Phantom organization ID for this user's embedded wallet. */
    organizationId: v.string(),
    /**
     * The OAuth access token passed by the extension on every Convex call.
     * Treated as a bearer credential — keep this row private.
     */
    sessionToken: v.string(),
    /**
     * The stamper secret key generated during the SSO flow in the Chrome
     * extension. This is the private half of the keypair whose public key was
     * registered with Phantom's auth server. Passed to the mcp-host server on
     * every tool call so it can construct a per-request PhantomClient.
     *
     * Security: this is a sensitive credential. Convex stores it encrypted
     * at rest, and it is only transmitted over TLS to the mcp-host server.
     */
    stamperSecretKey: v.string(),
    /** Unix ms timestamp of when this session was created / last refreshed. */
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_sessionToken", ["sessionToken"]),

  /**
   * Pending wallet-initiated approval requests intercepted by the MCP server
   * webhook. The agent summarises each one in plain English and presents it
   * in the conversation with Approve / Reject actions.
   */
  pendingApprovals: defineTable({
    /** The conversation thread where this approval was surfaced. */
    threadId: v.string(),
    /**
     * The raw JSON payload from the Phantom MCP server webhook, serialised as
     * a string. The agent receives this verbatim and summarises it.
     */
    approvalPayload: v.string(),
    /** Lifecycle state of the approval request. */
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    /** Unix ms timestamp of when the approval request arrived. */
    createdAt: v.number(),
  })
    .index("by_threadId", ["threadId"])
    .index("by_status", ["status"]),

  /**
   * Cached token address lookups from the data_integrity tool.
   * Entries expire after 24 hours to limit staleness risk.
   */
  tokenAddressCache: defineTable({
    /**
     * Normalised lookup key, e.g. "solana:BONK" or "ethereum:USDC".
     * Constructed by the dataIntegrity action before querying registries.
     */
    cacheKey: v.string(),
    /** The verified on-chain address returned by the registry. */
    address: v.string(),
    /** Human-readable token name for disambiguation. */
    name: v.string(),
    /** The chain this address belongs to: "solana" | "ethereum" | "bitcoin" | "sui". */
    chain: v.string(),
    /**
     * Whether the entry is for a native asset (SOL, ETH, BTC).
     * Native assets have no contract address — tool callers must use the
     * isNative flag in buy_token / transfer_tokens instead.
     */
    isNative: v.boolean(),
    /** Unix ms timestamp of when this cache entry was written. */
    cachedAt: v.number(),
  }).index("by_cacheKey", ["cacheKey"]),
});
