/**
 * Content script to communicate with Phantom wallet
 * Injected into all pages to access window.phantom
 */

const win = window as unknown as {
  phantom?: {
    solana?: { connect: () => Promise<{ toString: () => string }> };
    ethereum?: { connect: () => Promise<{ toString: () => string }> };
  };
};

console.log("[Phantom Agent] Content script loaded");

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  console.log("[Phantom Agent Content] Received message:", request.type);

  if (request.type === "PING") {
    sendResponse({ pong: true });
    return true;
  }

  if (request.type === "CHECK_PHANTOM") {
    // Check if window.phantom exists
    const hasPhantom = typeof win.phantom !== "undefined";
    console.log("[Phantom Agent Content] Phantom detected:", hasPhantom);
    sendResponse({ hasPhantom });
    return true;
  }

  if (request.type === "CONNECT_PHANTOM") {
    // Try to connect to Phantom
    if (typeof win.phantom === "undefined") {
      sendResponse({ error: "Phantom not installed" });
      return true;
    }

    try {
      // Phantom injects window.phantom.solana or window.phantom.ethereum
      const provider = win.phantom?.solana || win.phantom?.ethereum;

      if (!provider) {
        sendResponse({ error: "Phantom provider not found" });
        return true;
      }

      // Request connection
      provider.connect().then((publicKey: { toString: () => string }) => {
        console.log("[Phantom Agent Content] Connected:", publicKey);
        sendResponse({
          success: true,
          publicKey: publicKey?.toString()
        });
      }).catch((err: { message?: string }) => {
        console.error("[Phantom Agent Content] Connect error:", err);
        sendResponse({
          error: err?.message || "Connection rejected"
        });
      });

      return true; // Will respond asynchronously
    } catch (error) {
      console.error("[Phantom Agent Content] Error:", error);
      sendResponse({
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }
  }

  return false;
});

// Also expose to window for debugging
(window as unknown as { phantomAgentContentScript?: boolean }).phantomAgentContentScript = true;
