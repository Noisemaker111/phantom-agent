/**
 * PhantomClient factory.
 *
 * Constructs a PhantomClient from per-request stamper credentials rather than
 * reading from the filesystem session file. This is what makes the hosted MCP
 * server multi-user: each request carries its own stamperSecretKey so we never
 * share a client instance across users.
 *
 * The stamperSecretKey is the private half of the keypair that was generated
 * during the user's initial SSO flow in the Chrome extension background service
 * worker. The matching public key was registered with Phantom's auth server at
 * that time, so requests signed with this key are accepted.
 */

import { ApiKeyStamper } from "@phantom/api-key-stamper";
import { PhantomClient } from "@phantom/client";

const PHANTOM_API_BASE_URL =
  process.env.PHANTOM_API_BASE_URL ?? "https://api.phantom.app";

/** Credentials forwarded from the Convex backend on every tool call. */
export interface RequestSession {
  walletId: string;
  organizationId: string;
  /** The stamper secret key stored in chrome.storage.local after the SSO flow. */
  stamperSecretKey: string;
}

/**
 * Builds a fully configured PhantomClient for a single request.
 * Call this at the top of every tool handler — it is cheap and stateless.
 */
export function buildClient(session: RequestSession): PhantomClient {
  const stamper = new ApiKeyStamper({
    apiSecretKey: session.stamperSecretKey,
  });

  const client = new PhantomClient(
    {
      apiBaseUrl: PHANTOM_API_BASE_URL,
      organizationId: session.organizationId,
      walletType: "user-wallet",
      // headers shape is SdkAnalyticsHeaders — omit custom keys
      headers: {},
    },
    stamper,
  );

  return client;
}

/** Minimal SessionData shape the MCP tools expect as context. */
export function buildSessionData(session: RequestSession) {
  return {
    walletId: session.walletId,
    organizationId: session.organizationId,
    authUserId: session.walletId, // tools only use walletId/organizationId from this
    stamperKeys: {
      publicKey: "", // not needed at this stage — already registered
      secretKey: session.stamperSecretKey,
    },
    appId: process.env.PHANTOM_APP_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
