/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Uses Phantom Connect HTTP API directly (not SDK)
 * Docs: https://docs.phantom.com/connect
 */

/// <reference types="chrome" />

const PHANTOM_APP_ID = "d3e0eba3-5c4b-40ed-9417-37ff874d9f6e"; // Your App ID
const PHANTOM_CONNECT_URL = "https://connect.phantom.app/login";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhantomSession = {
  userId: string;
  walletId: string;
  organizationId: string;
  publicKey: string;
  createdAt: number;
};

export type ExtensionMessage =
  | { type: "GET_SESSION" }
  | { type: "CONNECT" }
  | { type: "DISCONNECT" }
  | { type: "SESSION_CHANGED"; session: PhantomSession | null }
  | { type: "SESSION_RESULT"; session: PhantomSession | null }
  | { type: "ERROR"; message: string; details?: string };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function saveSession(session: PhantomSession): Promise<void> {
  await chrome.storage.local.set({ phantom_session: session });
}

async function loadSession(): Promise<PhantomSession | null> {
  const result = await chrome.storage.local.get("phantom_session");
  return result.phantom_session ?? null;
}

async function clearSession(): Promise<void> {
  await chrome.storage.local.remove("phantantom_session");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function logToStorage(context: string, data: unknown): Promise<void> {
  const logs = (await chrome.storage.local.get("phantom_logs")).phantom_logs || [];
  logs.push({
    timestamp: Date.now(),
    context,
    data: typeof data === "string" ? data : JSON.stringify(data),
  });
  // Keep only last 50 logs
  if (logs.length > 50) logs.shift();
  await chrome.storage.local.set({ phantom_logs: logs });
}

// ---------------------------------------------------------------------------
// SSO Flow
// ---------------------------------------------------------------------------

async function initiateSSOFlow(): Promise<PhantomSession> {
  console.log("[Phantom] Starting SSO flow...");
  await logToStorage("SSO_START", { appId: PHANTOM_APP_ID });
  
  const redirectUrl = chrome.identity.getRedirectURL("callback");
  console.log("[Phantom] Redirect URL:", redirectUrl);
  await logToStorage("REDIRECT_URL", redirectUrl);
  
  // Build SSO URL
  // Phantom Connect login endpoint
  const params = new URLSearchParams({
    app_id: PHANTOM_APP_ID,
    redirect_uri: redirectUrl,
    provider: "google",
    // Add a random state parameter for security
    state: Math.random().toString(36).substring(7),
  });
  
  const ssoUrl = `${PHANTOM_CONNECT_URL}?${params.toString()}`;
  console.log("[Phantom] SSO URL:", ssoUrl);
  await logToStorage("SSO_URL", ssoUrl);
  
  // Launch auth flow
  let responseUrl: string;
  try {
    responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: ssoUrl, interactive: true },
        (url) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message;
            console.error("[Phantom] launchWebAuthFlow error:", err);
            reject(new Error(`Chrome error: ${err}`));
            return;
          }
          if (!url) {
            reject(new Error("No redirect URL returned"));
            return;
          }
          resolve(url);
        }
      );
    });
  } catch (error) {
    await logToStorage("WEBAUTH_ERROR", error);
    throw error;
  }
  
  console.log("[Phantom] Got response URL:", responseUrl);
  await logToStorage("RESPONSE_URL", responseUrl);
  
  // Parse the response
  const url = new URL(responseUrl);
  const searchParams = url.searchParams;
  
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");
  
  if (error) {
    const errMsg = `Auth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`;
    console.error("[Phantom]", errMsg);
    await logToStorage("AUTH_ERROR", { error, errorDescription });
    throw new Error(errMsg);
  }
  
  // Extract tokens/data from URL
  // Phantom returns wallet info in the URL after successful auth
  const walletId = searchParams.get("wallet_id");
  const organizationId = searchParams.get("organization_id");
  const userId = searchParams.get("user_id") || searchParams.get("auth_user_id");
  const publicKey = searchParams.get("public_key");
  
  console.log("[Phantom] Response params:", { walletId, organizationId, userId, publicKey });
  await logToStorage("RESPONSE_PARAMS", { walletId, organizationId, userId, hasPublicKey: !!publicKey });
  
  if (!walletId || !organizationId || !userId) {
    const missing = [];
    if (!walletId) missing.push("wallet_id");
    if (!organizationId) missing.push("organization_id");
    if (!userId) missing.push("user_id/auth_user_id");
    const err = `Missing required params: ${missing.join(", ")}`;
    await logToStorage("MISSING_PARAMS", { walletId, organizationId, userId });
    throw new Error(err);
  }
  
  const session: PhantomSession = {
    userId,
    walletId,
    organizationId,
    publicKey: publicKey || "",
    createdAt: Date.now(),
  };
  
  await saveSession(session);
  await logToStorage("SESSION_SAVED", session);
  
  // Register with Convex
  try {
    const convexUrl = process.env.VITE_CONVEX_SITE_URL;
    if (convexUrl) {
      await fetch(`${convexUrl}/auth/register-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          walletId,
          organizationId,
          sessionToken: publicKey || walletId,
        }),
      });
    }
  } catch (e) {
    console.warn("[Phantom] Convex registration failed:", e);
  }
  
  return session;
}

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  console.log("[Phantom] Message received:", message.type);
  
  switch (message.type) {
    case "GET_SESSION":
      loadSession()
        .then(session => sendResponse({ type: "SESSION_RESULT", session }))
        .catch(err => sendResponse({ 
          type: "ERROR", 
          message: err.message,
          details: err.stack 
        }));
      return true;
      
    case "CONNECT":
      initiateSSOFlow()
        .then(session => sendResponse({ type: "SESSION_RESULT", session }))
        .catch(err => {
          logToStorage("CONNECT_ERROR", { message: err.message, stack: err.stack });
          sendResponse({
            type: "ERROR",
            message: err.message,
            details: err.stack,
          });
        });
      return true;
      
    case "DISCONNECT":
      clearSession()
        .then(() => sendResponse({ type: "SESSION_RESULT", session: null }))
        .catch(err => sendResponse({ type: "ERROR", message: err.message }));
      return true;
      
    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Side Panel
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

console.log("[Phantom] Background service worker loaded");
console.log("[Phantom] App ID:", PHANTOM_APP_ID);
