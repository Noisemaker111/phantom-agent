/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Uses Phantom browser extension directly instead of Phantom Connect
 * This avoids the CSP bugs in Phantom Connect
 */

/// <reference types="chrome" />

const PHANTOM_APP_ID = "d3e0eba3-5c4b-40ed-9417-37ff874d9f6e";

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
// Connect using Phantom browser extension
// ---------------------------------------------------------------------------

async function initiateAuth(): Promise<PhantomSession> {
  console.log("[Phantom] Connecting via browser extension...");
  await logToStorage("EXTENSION_AUTH_START", {});
  
  // Use Phantom's connect method
  console.log("[Phantom] Sending connect request...");
  return new Promise((resolve, reject) => {
    // Send connect request to Phantom extension
    chrome.runtime.sendMessage(
      "bfnaelmomeimhlpmgjnjophhpkkoljpa", // Phantom extension ID
      {
        method: "connect",
        params: {
          appId: PHANTOM_APP_ID,
          // Request permissions
          permissions: {
            wallet: ["read", "write"],
          },
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message;
          console.error("[Phantom] Connect error:", err);
          logToStorage("CONNECT_ERROR", { error: err });
          reject(new Error(`Phantom connection failed: ${err}`));
          return;
        }
        
        console.log("[Phantom] Connect response:", response);
        logToStorage("CONNECT_RESPONSE", response);
        
        if (response?.error) {
          reject(new Error(response.error.message || "Connection rejected"));
          return;
        }
        
        if (!response?.publicKey) {
          reject(new Error("No public key returned from Phantom"));
          return;
        }
        
        // Build session from Phantom response
        const session: PhantomSession = {
          userId: response.publicKey,
          walletId: response.publicKey,
          organizationId: "phantom-browser",
          publicKey: response.publicKey,
          createdAt: Date.now(),
        };
        
        saveSession(session).then(() => {
          broadcastSessionChange(session);
          resolve(session);
        });
      }
    );
  });
}

async function disconnect(): Promise<void> {
  // Disconnect from Phantom extension
  chrome.runtime.sendMessage(
    "bfnaelmomeimhlpmgjnjophhpkkoljpa",
    { method: "disconnect" },
    () => {}
  );
  
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
