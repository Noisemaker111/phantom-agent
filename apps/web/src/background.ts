/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Supports both Phantom browser extension AND web-based auth
 */

/// <reference types="chrome" />

const PHANTOM_APP_ID = "d3e0eba3-5c4b-40ed-9417-37ff874d9f6e";
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
  | { type: "ERROR"; message: string; details?: string };

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
// Ensure content script is injected
// ---------------------------------------------------------------------------

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    console.log("[Phantom] Content script already injected");
  } catch {
    console.log("[Phantom] Injecting content script...");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    console.log("[Phantom] Content script injected");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---------------------------------------------------------------------------
// Method 1: Try browser extension
// ---------------------------------------------------------------------------

async function tryBrowserExtension(): Promise<PhantomSession | null> {
  console.log("[Phantom] Trying browser extension...");
  await logToStorage("TRY_EXTENSION", {});
  
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0 || !tabs[0].id || !tabs[0].url?.startsWith("http")) {
    console.log("[Phantom] No suitable tab for extension check");
    return null;
  }
  
  const tabId = tabs[0].id;
  
  try {
    await ensureContentScript(tabId);
    
    const checkResponse = await chrome.tabs.sendMessage(tabId, { type: "CHECK_PHANTOM" });
    console.log("[Phantom] Extension check:", checkResponse);
    
    if (!checkResponse?.hasPhantom) {
      console.log("[Phantom] Browser extension not detected");
      return null;
    }
    
    // Try to connect
    const connectResponse = await chrome.tabs.sendMessage(tabId, { type: "CONNECT_PHANTOM" });
    console.log("[Phantom] Extension connect:", connectResponse);
    await logToStorage("EXTENSION_CONNECT", connectResponse);
    
    if (connectResponse?.error) {
      throw new Error(connectResponse.error);
    }
    
    if (!connectResponse?.success || !connectResponse?.publicKey) {
      return null;
    }
    
    return {
      userId: connectResponse.publicKey,
      walletId: connectResponse.publicKey,
      organizationId: "phantom-browser",
      publicKey: connectResponse.publicKey,
      createdAt: Date.now(),
    };
  } catch (error) {
    console.log("[Phantom] Extension method failed:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Method 2: Use hosted web auth
// ---------------------------------------------------------------------------

async function tryWebAuth(): Promise<PhantomSession> {
  console.log("[Phantom] Trying web auth...");
  await logToStorage("TRY_WEB_AUTH", {});
  
  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    
    const authUrl = `${CONVEX_SITE_URL}/auth/callback?extension_id=${chrome.runtime.id}`;
    
    chrome.tabs.create({ url: authUrl, active: true }, (tab) => {
      if (!tab.id) {
        cleanupAuth();
        reject(new Error("Failed to open auth tab"));
        return;
      }
      
      authTabId = tab.id;
      
      // Timeout
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
// Main auth flow - tries extension first, falls back to web
// ---------------------------------------------------------------------------

async function initiateAuth(): Promise<PhantomSession> {
  console.log("[Phantom] Starting auth...");
  await logToStorage("AUTH_START", {});
  
  // Try browser extension first
  const extensionResult = await tryBrowserExtension();
  if (extensionResult) {
    await saveSession(extensionResult);
    broadcastSessionChange(extensionResult);
    return extensionResult;
  }
  
  // Fall back to web auth
  console.log("[Phantom] Falling back to web auth...");
  const webResult = await tryWebAuth();
  await saveSession(webResult);
  broadcastSessionChange(webResult);
  return webResult;
}

// ---------------------------------------------------------------------------
// Listen for web auth completion
// ---------------------------------------------------------------------------

chrome.runtime.onMessageExternal.addListener((message: any, sender, sendResponse) => {
  console.log("[Phantom] External message:", message?.type, "from:", sender.origin);
  
  if (!sender.origin?.includes("convex.site")) {
    return false;
  }
  
  if (message?.type === "AUTH_COMPLETE" && message.session) {
    const session: PhantomSession = {
      userId: message.session.userId,
      walletId: message.session.walletId,
      organizationId: message.session.organizationId,
      publicKey: message.session.publicKey || "",
      createdAt: Date.now(),
    };
    
    if (pendingResolve) {
      pendingResolve(session);
      cleanupAuth();
    }
    
    if (authTabId) {
      chrome.tabs.remove(authTabId).catch(() => {});
    }
    
    sendResponse({ success: true });
    return true;
  }
  
  if (message?.type === "AUTH_ERROR") {
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

// Listen for tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === authTabId && pendingReject) {
    pendingReject(new Error("Authentication cancelled"));
    cleanupAuth();
  }
});

async function disconnect(): Promise<void> {
  await clearSession();
  broadcastSessionChange(null);
}

// ---------------------------------------------------------------------------
// Message handler
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

console.log("[Phantom] Extension loaded, ID:", chrome.runtime.id);
