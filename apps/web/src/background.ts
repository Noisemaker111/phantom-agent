/**
 * Phantom Agent — Chrome Extension Background Service Worker
 * 
 * Injects content script programmatically to ensure it's loaded
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
// Ensure content script is injected
// ---------------------------------------------------------------------------

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    // Try to ping the content script
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    console.log("[Phantom] Content script already injected");
  } catch {
    // Content script not loaded, inject it
    console.log("[Phantom] Injecting content script...");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    console.log("[Phantom] Content script injected");
    // Wait a moment for it to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---------------------------------------------------------------------------
// Connect using Phantom via content script
// ---------------------------------------------------------------------------

async function initiateAuth(): Promise<PhantomSession> {
  console.log("[Phantom] Starting auth...");
  await logToStorage("AUTH_START", {});
  
  // Get or create a tab for auth
  let tabId: number;
  
  try {
    // Try to use current active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].id && tabs[0].url?.startsWith("http")) {
      tabId = tabs[0].id;
      console.log("[Phantom] Using current tab:", tabId);
    } else {
      // Create a new tab
      console.log("[Phantom] Creating new tab...");
      const tab = await chrome.tabs.create({
        url: "https://phantom.app",
        active: true,
      });
      if (!tab.id) throw new Error("Failed to create tab");
      tabId = tab.id;
      // Wait for page load
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    
    // Ensure content script is loaded
    await ensureContentScript(tabId);
    
    // Check for Phantom
    console.log("[Phantom] Checking for Phantom...");
    const checkResponse = await chrome.tabs.sendMessage(tabId, { type: "CHECK_PHANTOM" });
    console.log("[Phantom] Check response:", checkResponse);
    await logToStorage("PHANTOM_CHECK", checkResponse);
    
    if (!checkResponse?.hasPhantom) {
      chrome.tabs.create({
        url: "https://phantom.app/download",
        active: true,
      });
      throw new Error("Phantom wallet not detected. Please install the Phantom browser extension and refresh.");
    }
    
    // Connect
    console.log("[Phantom] Connecting...");
    const connectResponse = await chrome.tabs.sendMessage(tabId, { type: "CONNECT_PHANTOM" });
    console.log("[Phantom] Connect response:", connectResponse);
    await logToStorage("CONNECT_RESPONSE", connectResponse);
    
    if (connectResponse?.error) {
      throw new Error(connectResponse.error);
    }
    
    if (!connectResponse?.success || !connectResponse?.publicKey) {
      throw new Error("Connection failed");
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
  } catch (error) {
    console.error("[Phantom] Auth error:", error);
    throw error;
  }
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
