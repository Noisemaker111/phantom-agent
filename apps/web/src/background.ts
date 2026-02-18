/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Uses content script to communicate with Phantom wallet (avoids CSP issues)
 */

/// <reference types="chrome" />

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
// Connect using Phantom via content script
// ---------------------------------------------------------------------------

async function initiateAuth(): Promise<PhantomSession> {
  console.log("[Phantom] Starting auth via content script...");
  await logToStorage("CONTENT_AUTH_START", {});
  
  // Find an active tab to inject content script
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0 || !tabs[0].id) {
    throw new Error("No active tab found");
  }
  
  const tabId = tabs[0].id;
  console.log("[Phantom] Using tab:", tabId);
  
  // First check if Phantom is available
  console.log("[Phantom] Checking for Phantom...");
  const checkResponse = await chrome.tabs.sendMessage(tabId, { type: "CHECK_PHANTOM" });
  console.log("[Phantom] Check response:", checkResponse);
  await logToStorage("PHANTOM_CHECK", checkResponse);
  
  if (!checkResponse?.hasPhantom) {
    // Open Phantom download page
    chrome.tabs.create({
      url: "https://phantom.app/download",
      active: true,
    });
    throw new Error("Phantom wallet extension not detected. Please install it and refresh the page.");
  }
  
  // Try to connect
  console.log("[Phantom] Connecting...");
  const connectResponse = await chrome.tabs.sendMessage(tabId, { type: "CONNECT_PHANTOM" });
  console.log("[Phantom] Connect response:", connectResponse);
  await logToStorage("CONNECT_RESPONSE", connectResponse);
  
  if (connectResponse?.error) {
    throw new Error(connectResponse.error);
  }
  
  if (!connectResponse?.success || !connectResponse?.publicKey) {
    throw new Error("Connection failed - no public key returned");
  }
  
  // Build session
  const session: PhantomSession = {
    userId: connectResponse.publicKey,
    walletId: connectResponse.publicKey,
    organizationId: "phantom-browser",
    publicKey: connectResponse.publicKey,
    createdAt: Date.now(),
  };
  
  await saveSession(session);
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
