/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Uses Phantom REST API directly to avoid CSP issues
 */

/// <reference types="chrome" />

const PHANTOM_APP_ID = "d3e0eba3-5c4b-40ed-9417-37ff874d9f6e";
const PHANTOM_API_BASE = "https://api.phantom.app";

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
let authPromiseResolve: ((s: PhantomSession) => void) | null = null;
let authPromiseReject: ((e: Error) => void) | null = null;

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
// Direct API Auth Flow
// ---------------------------------------------------------------------------

async function initiateAuth(): Promise<PhantomSession> {
  console.log("[Phantom] Starting direct API auth...");
  await logToStorage("AUTH_START", { appId: PHANTOM_APP_ID });
  
  const redirectUrl = chrome.identity.getRedirectURL("callback");
  console.log("[Phantom] Redirect URL:", redirectUrl);
  await logToStorage("REDIRECT_URL", redirectUrl);
  
  // Try calling Phantom's SSO init endpoint directly
  try {
    const initResponse = await fetch(`${PHANTOM_API_BASE}/v1/connect/init`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-App-Id": PHANTOM_APP_ID,
      },
      body: JSON.stringify({
        provider: "google",
        redirect_uri: redirectUrl,
        app_id: PHANTOM_APP_ID,
      }),
    });
    
    console.log("[Phantom] Init response status:", initResponse.status);
    await logToStorage("INIT_RESPONSE", { status: initResponse.status });
    
    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error("[Phantom] Init failed:", errorText);
      throw new Error(`Phantom API error: ${initResponse.status} - ${errorText}`);
    }
    
    const initData = await initResponse.json();
    console.log("[Phantom] Init data:", initData);
    await logToStorage("INIT_DATA", initData);
    
    // Should return an auth_url to open
    const authUrl = initData.auth_url || initData.url;
    if (!authUrl) {
      throw new Error("No auth_url returned from Phantom");
    }
    
    return openAuthTab(authUrl);
  } catch (error) {
    // If API fails, fallback to direct URL construction
    console.warn("[Phantom] API init failed, trying direct URL:", error);
    await logToStorage("API_FALLBACK", { error: String(error) });
    
    // Construct direct auth URL
    const params = new URLSearchParams({
      app_id: PHANTOM_APP_ID,
      redirect_uri: redirectUrl,
      provider: "google",
    });
    
    const directUrl = `https://connect.phantom.app/login?${params.toString()}`;
    return openAuthTab(directUrl);
  }
}

function openAuthTab(authUrl: string): Promise<PhantomSession> {
  console.log("[Phantom] Opening auth URL:", authUrl);
  
  return new Promise((resolve, reject) => {
    authPromiseResolve = resolve;
    authPromiseReject = reject;
    
    chrome.tabs.create({
      url: authUrl,
      active: true,
    }, (tab) => {
      if (!tab.id) {
        authPromiseResolve = null;
        authPromiseReject = null;
        reject(new Error("Failed to open auth tab"));
        return;
      }
      
      authTabId = tab.id;
      console.log("[Phantom] Auth tab opened:", tab.id);
      
      // Timeout after 5 minutes
      setTimeout(() => {
        if (authTabId === tab.id && authPromiseReject) {
          chrome.tabs.remove(tab.id).catch(() => {});
          authPromiseReject(new Error("Authentication timeout"));
          cleanupAuth();
        }
      }, 300000);
    });
  });
}

function cleanupAuth(): void {
  authTabId = null;
  authPromiseResolve = null;
  authPromiseReject = null;
}

// ---------------------------------------------------------------------------
// Tab Update Handler - Watch for redirect
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== authTabId || !authPromiseResolve) return;
  
  if (changeInfo.url) {
    console.log("[Phantom] Tab URL updated:", changeInfo.url);
    
    // Check if this is our redirect URL
    if (changeInfo.url.includes("chromiumapp.org/callback")) {
      handleAuthCallback(changeInfo.url, tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === authTabId && authPromiseReject) {
    authPromiseReject(new Error("Authentication cancelled"));
    cleanupAuth();
  }
});

async function handleAuthCallback(url: string, tabId: number): Promise<void> {
  console.log("[Phantom] Handling auth callback:", url);
  await logToStorage("AUTH_CALLBACK", url);
  
  try {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;
    
    const error = params.get("error");
    const errorDescription = params.get("error_description");
    
    if (error) {
      const errMsg = `Auth error: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`;
      console.error("[Phantom]", errMsg);
      await logToStorage("AUTH_ERROR", { error, errorDescription });
      
      if (authPromiseReject) {
        authPromiseReject(new Error(errMsg));
      }
      cleanupAuth();
      chrome.tabs.remove(tabId).catch(() => {});
      return;
    }
    
    // Extract session data
    const walletId = params.get("wallet_id");
    const organizationId = params.get("organization_id");
    const userId = params.get("user_id") || params.get("auth_user_id");
    const publicKey = params.get("public_key");
    
    console.log("[Phantom] Auth data:", { walletId, organizationId, userId });
    await logToStorage("AUTH_DATA", { walletId, organizationId, userId });
    
    if (!walletId || !organizationId || !userId) {
      const missing = [];
      if (!walletId) missing.push("wallet_id");
      if (!organizationId) missing.push("organization_id");
      if (!userId) missing.push("user_id");
      
      const err = `Missing auth params: ${missing.join(", ")}`;
      if (authPromiseReject) {
        authPromiseReject(new Error(err));
      }
      cleanupAuth();
      chrome.tabs.remove(tabId).catch(() => {});
      return;
    }
    
    // Success!
    const session: PhantomSession = {
      userId,
      walletId,
      organizationId,
      publicKey: publicKey || "",
      createdAt: Date.now(),
    };
    
    await saveSession(session);
    broadcastSessionChange(session);
    
    if (authPromiseResolve) {
      authPromiseResolve(session);
    }
    
    cleanupAuth();
    chrome.tabs.remove(tabId).catch(() => {});
    
  } catch (error) {
    console.error("[Phantom] Error handling callback:", error);
    if (authPromiseReject) {
      authPromiseReject(error instanceof Error ? error : new Error(String(error)));
    }
    cleanupAuth();
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Message Handler
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
