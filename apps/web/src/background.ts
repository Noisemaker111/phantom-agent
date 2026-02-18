/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Auth approach: Use Phantom Connect via Convex-hosted redirect page
 * This avoids CSP issues by having the auth flow happen through a proper web origin
 */

/// <reference types="chrome" />

const PHANTOM_APP_ID = "d3e0eba3-5c4b-40ed-9417-37ff874d9f6e";
const PHANTOM_CONNECT_URL = "https://connect.phantom.app/login";
const CONVEX_SITE_URL = "https://tough-nightingale-94.convex.site"; // Your Convex site

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

// Auth state
let authInProgress = false;
let pendingAuthPromise: { resolve: (s: PhantomSession) => void; reject: (e: Error) => void } | null = null;

async function logToStorage(context: string, data: unknown): Promise<void> {
  const result = await chrome.storage.local.get("phantom_logs");
  const logs = result.phantom_logs || [];
  logs.push({
    timestamp: Date.now(),
    context,
    data: typeof data === "string" ? data : JSON.stringify(data),
  });
  if (logs.length > 50) logs.shift();
  await chrome.storage.local.set({ phantom_logs: logs });
}

async function saveSession(session: PhantomSession): Promise<void> {
  await chrome.storage.local.set({ phantom_session: session });
}

async function loadSession(): Promise<PhantomSession | null> {
  const result = await chrome.storage.local.get("phantom_session");
  return result.phantom_session ?? null;
}

async function clearSession(): Promise<void> {
  await chrome.storage.local.remove("phantom_session");
}

function broadcastSessionChange(session: PhantomSession | null): void {
  const message: ExtensionMessage = { type: "SESSION_CHANGED", session };
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Build auth URL that goes through Convex first, then to Phantom
function buildAuthUrl(): string {
  // Use a simple state parameter
  const state = Math.random().toString(36).substring(2, 15);
  
  // Store state temporarily
  chrome.storage.local.set({ phantom_auth_state: state });
  
  // Build URL: Extension -> Convex auth page -> Phantom -> back to Extension
  // The Convex page will handle the Phantom redirect and send data back
  const params = new URLSearchParams({
    app_id: PHANTOM_APP_ID,
    state: state,
    extension_id: chrome.runtime.id,
  });
  
  return `${CONVEX_SITE_URL}/auth/phantom-connect?${params.toString()}`;
}

async function initiateSSOFlow(): Promise<PhantomSession> {
  console.log("[Phantom] Starting auth flow...");
  await logToStorage("AUTH_START", { appId: PHANTOM_APP_ID });
  
  if (authInProgress) {
    throw new Error("Authentication already in progress");
  }
  
  authInProgress = true;
  
  // Open auth in new tab (not popup) to avoid CSP issues
  const authUrl = buildAuthUrl();
  console.log("[Phantom] Auth URL:", authUrl);
  await logToStorage("AUTH_URL", authUrl);
  
  return new Promise((resolve, reject) => {
    pendingAuthPromise = { resolve, reject };
    
    chrome.tabs.create({
      url: authUrl,
      active: true,
    }, (tab) => {
      if (!tab.id) {
        authInProgress = false;
        pendingAuthPromise = null;
        reject(new Error("Failed to open auth tab"));
        return;
      }
      
      const tabId = tab.id;
      console.log("[Phantom] Auth tab opened:", tabId);
      
      // Timeout after 10 minutes
      setTimeout(() => {
        if (authInProgress && pendingAuthPromise) {
          authInProgress = false;
          pendingAuthPromise = null;
          chrome.tabs.remove(tabId).catch(() => {});
          reject(new Error("Authentication timeout"));
        }
      }, 600000);
    });
  });
}

// Listen for messages from the auth page
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.log("[Phantom] External message:", message, "from:", sender.origin);
  
  // Only accept messages from our Convex site
  if (!sender.origin?.includes("convex.site")) {
    return false;
  }
  
  if (message.type === "PHANTOM_AUTH_COMPLETE") {
    const { walletId, organizationId, userId, publicKey, state } = message;
    
    // Verify state matches
    chrome.storage.local.get("phantom_auth_state").then((result) => {
      if (result.phantom_auth_state !== state) {
        console.error("[Phantom] State mismatch!");
        if (pendingAuthPromise) {
          pendingAuthPromise.reject(new Error("Security error: state mismatch"));
        }
        return;
      }
      
      // Clear state
      chrome.storage.local.remove("phantom_auth_state");
      
      if (!walletId || !organizationId || !userId) {
        if (pendingAuthPromise) {
          pendingAuthPromise.reject(new Error("Missing auth data"));
        }
        return;
      }
      
      const session: PhantomSession = {
        userId,
        walletId,
        organizationId,
        publicKey: publicKey || "",
        createdAt: Date.now(),
      };
      
      saveSession(session).then(() => {
        broadcastSessionChange(session);
        if (pendingAuthPromise) {
          pendingAuthPromise.resolve(session);
        }
        authInProgress = false;
        pendingAuthPromise = null;
      });
    });
    
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === "PHANTOM_AUTH_ERROR") {
    const { error } = message;
    console.error("[Phantom] Auth error from page:", error);
    
    if (pendingAuthPromise) {
      pendingAuthPromise.reject(new Error(error));
    }
    authInProgress = false;
    pendingAuthPromise = null;
    
    sendResponse({ success: true });
    return true;
  }
  
  return false;
});

async function disconnect(): Promise<void> {
  await clearSession();
  broadcastSessionChange(null);
}

// Internal message handler
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  console.log("[Phantom] Internal message:", message.type);
  
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
      disconnect()
        .then(() => sendResponse({ type: "SESSION_RESULT", session: null }))
        .catch(err => sendResponse({ type: "ERROR", message: err.message }));
      return true;
      
    default:
      return false;
  }
});

// Side panel
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id });
});

console.log("[Phantom] Background service worker loaded");
console.log("[Phantom] Extension ID:", chrome.runtime.id);
console.log("[Phantom] Convex URL:", CONVEX_SITE_URL);
