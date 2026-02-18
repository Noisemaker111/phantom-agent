/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Uses hosted auth page on Convex to avoid CSP issues
 */

/// <reference types="chrome" />

const CONVEX_SITE_URL = "https://tough-nightingale-94.convex.site";

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
  | { type: "ERROR"; message: string; details?: string }
  // External messages from auth page
  | { type: "AUTH_COMPLETE"; session: PhantomSession }
  | { type: "AUTH_ERROR"; error: string };

let authTabId: number | null = null;
let pendingResolve: ((s: PhantomSession) => void) | null = null;
let pendingReject: ((e: Error) => void) | null = null;

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

// ---------------------------------------------------------------------------
// Auth Flow - Open hosted page on Convex
// ---------------------------------------------------------------------------

async function initiateAuth(): Promise<PhantomSession> {
  console.log("[Phantom] Starting hosted auth flow...");
  await logToStorage("HOSTED_AUTH_START", { extensionId: chrome.runtime.id });
  
  const authUrl = `${CONVEX_SITE_URL}/auth/callback?extension_id=${chrome.runtime.id}`;
  console.log("[Phantom] Opening:", authUrl);
  await logToStorage("AUTH_URL", authUrl);
  
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    
    chrome.tabs.create({ url: authUrl, active: true }, (tab) => {
      if (!tab.id) {
        cleanupAuth();
        reject(new Error("Failed to open auth tab"));
        return;
      }
      
      authTabId = tab.id;
      console.log("[Phantom] Auth tab opened:", tab.id);
      
      // Timeout after 5 minutes
      setTimeout(() => {
        if (authTabId === tab.id && pendingReject) {
          chrome.tabs.remove(tab.id).catch(() => {});
          pendingReject(new Error("Authentication timeout"));
          cleanupAuth();
        }
      }, 300000);
    });
  });
}

function cleanupAuth(): void {
  authTabId = null;
  pendingResolve = null;
  pendingReject = null;
}

// ---------------------------------------------------------------------------
// Listen for external messages from hosted auth page
// ---------------------------------------------------------------------------

chrome.runtime.onMessageExternal.addListener((message: any, sender, sendResponse) => {
  console.log("[Phantom] External message:", message?.type, "from:", sender.origin);
  
  // Only accept from our Convex site
  if (!sender.origin?.includes("convex.site")) {
    console.warn("[Phantom] Rejected message from:", sender.origin);
    return false;
  }
  
  if (message?.type === "AUTH_COMPLETE" && message.session) {
    console.log("[Phantom] Auth complete!");
    
    const session: PhantomSession = {
      userId: message.session.userId,
      walletId: message.session.walletId,
      organizationId: message.session.organizationId,
      publicKey: message.session.publicKey || "",
      createdAt: Date.now(),
    };
    
    // Save session
    saveSession(session).then(() => {
      broadcastSessionChange(session);
      if (pendingResolve) {
        pendingResolve(session);
        cleanupAuth();
      }
    });
    
    // Close the auth tab
    if (authTabId) {
      chrome.tabs.remove(authTabId).catch(() => {});
    }
    
    sendResponse({ success: true });
    return true;
  }
  
  if (message?.type === "AUTH_ERROR") {
    console.error("[Phantom] Auth error:", message.error);
    if (pendingReject) {
      pendingReject(new Error(message.error || "Authentication failed"));
      cleanupAuth();
    }
    if (authTabId) {
      chrome.tabs.remove(authTabId).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }
  
  return false;
});

// Also listen for tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === authTabId && pendingReject) {
    console.log("[Phantom] Auth tab closed by user");
    pendingReject(new Error("Authentication cancelled"));
    cleanupAuth();
  }
});

// ---------------------------------------------------------------------------
// Internal message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  console.log("[Phantom] Message:", message.type);
  
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
      initiateAuth()
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

// Side panel
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id });
});

console.log("[Phantom] Extension loaded, ID:", chrome.runtime.id);
