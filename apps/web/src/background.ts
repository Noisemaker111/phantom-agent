/**
 * Phantom Agent — Chrome Extension Background Service Worker
 *
 * Responsibilities:
 * 1. Phantom SSO flow with stamper keypair generation
 * 2. Secure session + stamper secret key persistence in chrome.storage.local
 * 3. Session refresh (stamper keys don't expire, but session may be revoked)
 * 4. Message passing to/from sidepanel and popup UIs
 * 5. Side panel open-on-click behaviour
 *
 * The session stored here is the source of truth. The UI surfaces read it
 * via chrome.storage.local.get and message passing.
 *
 * SSO Flow (Phantom's custom flow, not standard OAuth):
 * 1. Generate ed25519 keypair (stamper keys) locally
 * 2. Build SSO URL: https://connect.phantom.app/login?public_key=<pubkey>&...
 * 3. chrome.identity.launchWebAuthFlow opens browser tab
 * 4. User authenticates with Phantom (Google/Apple SSO)
 * 5. Redirect back with wallet_id, organization_id, auth_user_id in URL
 * 6. Store stamper secret key + wallet data
 *
 * No token exchange — stamper keys authenticate API requests directly.
 */

/// <reference types="chrome" />

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHANTOM_APP_ID = process.env.VITE_PHANTOM_APP_ID ?? "";
const PHANTOM_CONNECT_URL = "https://connect.phantom.app/login";

const STORAGE_KEY_SESSION = "phantom_session";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhantomSession = {
  userId: string;
  walletId: string;
  organizationId: string;
  /** Base64url-encoded ed25519 private key (stamper secret key) */
  stamperSecretKey: string;
  /** Base64url-encoded ed25519 public key */
  stamperPublicKey: string;
  createdAt: number;
};

type StoredSession = {
  session: PhantomSession;
};

export type ExtensionMessage =
  | { type: "GET_SESSION" }
  | { type: "CONNECT" }
  | { type: "DISCONNECT" }
  | { type: "SESSION_CHANGED"; session: PhantomSession | null }
  | { type: "SESSION_RESULT"; session: PhantomSession | null }
  | { type: "ERROR"; message: string };

// ---------------------------------------------------------------------------
// Crypto helpers — generate ed25519 keypair for stamper
// ---------------------------------------------------------------------------

/**
 * Generate an ed25519 keypair for use as stamper keys.
 * Returns base64url-encoded keys.
 */
async function generateStamperKeypair(): Promise<{ publicKey: string; secretKey: string }> {
  // Ed25519 is available in Web Crypto as "Ed25519"
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true, // extractable
    ["sign", "verify"]
  );

  // Export public key
  const publicKeyBuffer = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKey = base64UrlEncode(publicKeyBuffer);

  // Export private key
  const privateKeyBuffer = await crypto.subtle.exportKey("raw", keyPair.privateKey);
  const secretKey = base64UrlEncode(privateKeyBuffer);

  return { publicKey, secretKey };
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateSessionId(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64UrlEncode(array.buffer);
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

async function loadSession(): Promise<PhantomSession | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY_SESSION);
  const stored = result[STORAGE_KEY_SESSION] as StoredSession | undefined;
  return stored?.session ?? null;
}

async function saveSession(session: PhantomSession): Promise<void> {
  const stored: StoredSession = { session };
  await chrome.storage.local.set({ [STORAGE_KEY_SESSION]: stored });
}

async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_SESSION);
}

function broadcastSessionChange(session: PhantomSession | null): void {
  const message: ExtensionMessage = { type: "SESSION_CHANGED", session };
  chrome.runtime.sendMessage(message).catch(() => {
    // No listeners open — safe to ignore
  });
}

// ---------------------------------------------------------------------------
// SSO Flow (Phantom's custom flow, not OAuth)
// ---------------------------------------------------------------------------

async function initiateSSOFlow(): Promise<PhantomSession> {
  const redirectUrl = chrome.identity.getRedirectURL("callback");
  
  // 1. Generate stamper keypair
  const { publicKey, secretKey } = await generateStamperKeypair();
  const sessionId = generateSessionId();

  // 2. Build SSO URL
  const params = new URLSearchParams({
    provider: "google", // Phantom supports google, apple, email
    app_id: PHANTOM_APP_ID,
    redirect_uri: redirectUrl,
    public_key: publicKey,
    session_id: sessionId,
    sdk_version: "1.0.0",
    sdk_type: "phantom-agent",
  });

  const ssoUrl = `${PHANTOM_CONNECT_URL}?${params.toString()}`;

  // 3. Launch WebAuthFlow
  const responseUrl = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: ssoUrl, interactive: true },
      (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!url) {
          reject(new Error("SSO flow completed with no redirect URL."));
          return;
        }
        resolve(url);
      }
    );
  });

  // 4. Parse callback params
  const redirectParams = new URL(responseUrl).searchParams;
  const returnedSessionId = redirectParams.get("session_id");
  const walletId = redirectParams.get("wallet_id");
  const organizationId = redirectParams.get("organization_id");
  const authUserId = redirectParams.get("auth_user_id");
  const error = redirectParams.get("error");

  if (error) {
    throw new Error(`SSO error: ${error} — ${redirectParams.get("error_description") ?? ""}`);
  }

  if (returnedSessionId !== sessionId) {
    throw new Error("SSO session ID mismatch — possible CSRF attack. Aborting.");
  }

  if (!walletId || !organizationId || !authUserId) {
    throw new Error("SSO callback missing required wallet data.");
  }

  // 5. Build and store session
  const session: PhantomSession = {
    userId: authUserId,
    walletId,
    organizationId,
    stamperSecretKey: secretKey,
    stamperPublicKey: publicKey,
    createdAt: Date.now(),
  };

  await saveSession(session);

  // 6. Register with Convex backend (optional, for validation)
  const convexUrl = process.env.VITE_CONVEX_SITE_URL ?? "";
  if (convexUrl) {
    try {
      await fetch(`${convexUrl}/auth/register-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: authUserId,
          walletId,
          organizationId,
          sessionToken: "stamper-auth", // Placeholder — Convex validates via session lookup
          stamperSecretKey: secretKey,
        }),
      });
    } catch {
      // Non-fatal: the Convex mutation is also callable directly from the UI
    }
  }

  broadcastSessionChange(session);
  return session;
}

async function disconnect(): Promise<void> {
  await clearSession();
  broadcastSessionChange(null);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse: (response: ExtensionMessage) => void) => {
    switch (message.type) {
      case "GET_SESSION": {
        loadSession()
          .then((session) => {
            sendResponse({ type: "SESSION_RESULT", session });
          })
          .catch(() => {
            sendResponse({ type: "SESSION_RESULT", session: null });
          });
        return true; // Async response
      }

      case "CONNECT": {
        initiateSSOFlow()
          .then((session) => {
            sendResponse({ type: "SESSION_RESULT", session });
          })
          .catch((err: unknown) => {
            sendResponse({
              type: "ERROR",
              message: err instanceof Error ? err.message : "Connection failed.",
            });
          });
        return true;
      }

      case "DISCONNECT": {
        disconnect()
          .then(() => {
            sendResponse({ type: "SESSION_RESULT", session: null });
          })
          .catch(() => {
            sendResponse({ type: "SESSION_RESULT", session: null });
          });
        return true;
      }

      default:
        return false;
    }
  }
);

// ---------------------------------------------------------------------------
// Side panel open on click
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void chrome.sidePanel.open({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const session = await loadSession();
  if (session) {
    log.info("Session restored", { walletId: session.walletId });
  }
}

const log = {
  info: (msg: string, meta?: object) => console.log(`[BG] ${msg}`, meta ?? ""),
  error: (msg: string, err?: unknown) => console.error(`[BG] ${msg}`, err ?? ""),
};

void init();
