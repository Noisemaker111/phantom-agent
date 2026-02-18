/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Uses Phantom Connect HTTP API via popup window
 */

/// <reference types="chrome" />

const PHANTOM_APP_ID = "d3e0eba3-5c4b-40ed-9417-37ff874d9f6e";
const PHANTOM_CONNECT_URL = "https://connect.phantom.app/login";

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

// Store the current auth attempt
let currentAuthTabId: number | null = null;
let authCallback: ((session: PhantomSession | null, error?: string) => void) | null = null;

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

// Build SSO URL
function buildSSOUrl(redirectUrl: string): string {
  const params = new URLSearchParams({
    app_id: PHANTOM_APP_ID,
    redirect_uri: redirectUrl,
    provider: "google",
    state: Math.random().toString(36).substring(2, 15),
  });
  return `${PHANTOM_CONNECT_URL}?${params.toString()}`;
}

// Listen for tab updates to catch the redirect
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!currentAuthTabId || tabId !== currentAuthTabId) return;
  if (!authCallback) return;
  
  // Check if URL changed
  if (changeInfo.url) {
    logToStorage("TAB_UPDATED", { url: changeInfo.url });
    
    // Check if this is our redirect URL
    if (changeInfo.url.includes("chromiumapp.org/callback")) {
      logToStorage("REDIRECT_DETECTED", changeInfo.url);
      
      // Parse the URL
      const url = new URL(changeInfo.url);
      const searchParams = url.searchParams;
      
      const error = searchParams.get("error");
      const errorDescription = searchParams.get("error_description");
      
      if (error) {
        const errMsg = `Auth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`;
        logToStorage("AUTH_ERROR", { error, errorDescription });
        authCallback(null, errMsg);
      } else {
        // Extract tokens/data from URL
        const walletId = searchParams.get("wallet_id");
        const organizationId = searchParams.get("organization_id");
        const userId = searchParams.get("user_id") || searchParams.get("auth_user_id");
        const publicKey = searchParams.get("public_key");
        
        logToStorage("AUTH_SUCCESS", { walletId, organizationId, userId, hasPublicKey: !!publicKey });
        
        if (!walletId || !organizationId || !userId) {
          const missing = [];
          if (!walletId) missing.push("wallet_id");
          if (!organizationId) missing.push("organization_id");
          if (!userId) missing.push("user_id");
          authCallback(null, `Missing required params: ${missing.join(", ")}`);
        } else {
          const session: PhantomSession = {
            userId,
            walletId,
            organizationId,
            publicKey: publicKey || "",
            createdAt: Date.now(),
          };
          authCallback(session);
        }
      }
      
      // Close the tab
      chrome.tabs.remove(tabId).catch(() => {});
      currentAuthTabId = null;
      authCallback = null;
    }
  }
  
  // Handle tab close
  if (changeInfo.status === "complete" && tab.url?.includes("chromiumapp.org/callback")) {
    setTimeout(() => {
      if (currentAuthTabId === tabId && authCallback) {
        authCallback(null, "Authentication cancelled");
        currentAuthTabId = null;
        authCallback = null;
      }
    }, 1000);
  }
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentAuthTabId === tabId && authCallback) {
    logToStorage("TAB_CLOSED", { tabId });
    authCallback(null, "Authentication cancelled - tab closed");
    currentAuthTabId = null;
    authCallback = null;
  }
});

async function initiateSSOFlow(): Promise<PhantomSession> {
  console.log("[Phantom] Starting SSO flow...");
  await logToStorage("SSO_START", { appId: PHANTOM_APP_ID });
  
  const redirectUrl = chrome.identity.getRedirectURL("callback");
  console.log("[Phantom] Redirect URL:", redirectUrl);
  await logToStorage("REDIRECT_URL", redirectUrl);
  
  const ssoUrl = buildSSOUrl(redirectUrl);
  console.log("[Phantom] SSO URL:", ssoUrl);
  await logToStorage("SSO_URL", ssoUrl);
  
  return new Promise((resolve, reject) => {
    // Open a popup window
    chrome.windows.create({
      url: ssoUrl,
      type: "popup",
      width: 500,
      height: 700,
      focused: true,
    }, (window) => {
      if (!window || !window.tabs || window.tabs.length === 0) {
        reject(new Error("Failed to open authentication window"));
        return;
      }
      
      currentAuthTabId = window.tabs[0].id!;
      authCallback = (session, error) => {
        if (error) {
          reject(new Error(error));
        } else if (session) {
          // Save session
          saveSession(session).then(() => {
            broadcastSessionChange(session);
            resolve(session);
          });
        } else {
          reject(new Error("Authentication failed"));
        }
      };
      
      // Timeout after 5 minutes
      setTimeout(() => {
        if (currentAuthTabId === window.tabs![0].id && authCallback) {
          chrome.windows.remove(window.id!).catch(() => {});
          authCallback(null, "Authentication timeout");
          currentAuthTabId = null;
          authCallback = null;
        }
      }, 300000);
    });
  });
}

async function disconnect(): Promise<void> {
  await clearSession();
  broadcastSessionChange(null);
}

// Message handler
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
console.log("[Phantom] App ID:", PHANTOM_APP_ID);
