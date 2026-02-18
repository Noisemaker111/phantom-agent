/**
 * HTTP router for the Phantom Agent Convex backend.
 *
 * Endpoints:
 *   GET  /auth/callback    — Hosted auth page for Phantom Connect
 *   POST /phantom-approval — receives wallet-initiated approval events
 */

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

/**
 * Hosted auth callback page for Chrome extension.
 * This page loads Phantom Connect in a regular web context (avoiding CSP issues)
 * and handles the redirect back to the extension.
 */
http.route({
  path: "/auth/callback",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const params = url.searchParams;
    
    // Check if this is a callback from Phantom (has wallet data)
    const walletId = params.get("wallet_id");
    const organizationId = params.get("organization_id");
    const userId = params.get("user_id") || params.get("auth_user_id");
    const publicKey = params.get("public_key");
    const error = params.get("error");
    const errorDescription = params.get("error_description");
    const extensionId = params.get("extension_id") || "cbojakbkbiepfeccbakkemmfhjpinhmd";
    
    // If we have auth data, show success page
    if (walletId && organizationId && userId) {
      const html = generateSuccessHtml({ walletId, organizationId, userId, publicKey, extensionId });
      return new Response(html, { 
        headers: { "Content-Type": "text/html" } 
      });
    }
    
    // If there's an error, show error page with details
    if (error) {
      console.error("Phantom auth error:", error, errorDescription);
      const html = generateErrorHtml(error, errorDescription, extensionId);
      return new Response(html, { 
        headers: { "Content-Type": "text/html" } 
      });
    }
    
    // Otherwise, this is the initial request - redirect to Phantom Connect
    const phantomAppId = "d3e0eba3-5c4b-40ed-9417-37ff874d9f6e";
    const redirectUrl = `${url.origin}/auth/callback?extension_id=${extensionId}`;
    
    const phantomParams = new URLSearchParams({
      app_id: phantomAppId,
      redirect_uri: redirectUrl,
      provider: "google",
      state: Math.random().toString(36).substring(2, 15),
    });
    
    const phantomUrl = `https://connect.phantom.app/login?${phantomParams.toString()}`;
    
    return Response.redirect(phantomUrl, 302);
  }),
});

function generateSuccessHtml(data: { 
  walletId: string; 
  organizationId: string; 
  userId: string; 
  publicKey: string | null;
  extensionId: string;
}) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Phantom Agent - Connected</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117; 
      color: #fff; 
      display: flex; 
      flex-direction: column;
      align-items: center; 
      justify-content: center; 
      min-height: 100vh; 
      margin: 0;
      padding: 20px;
    }
    .container { text-align: center; max-width: 400px; }
    .logo { 
      width: 80px; 
      height: 80px; 
      background: linear-gradient(135deg, #23c55e 0%, #16a34a 100%);
      border-radius: 20px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
    }
    h1 { font-size: 24px; margin: 0 0 12px; }
    .success { 
      background: rgba(35, 197, 94, 0.1); 
      color: #23c55e; 
      padding: 16px; 
      border-radius: 8px; 
      margin: 24px 0;
    }
    .wallet { font-family: monospace; font-size: 14px; word-break: break-all; }
    button {
      background: linear-gradient(135deg, #ab9ff2 0%, #7b6fd9 100%);
      color: white;
      border: none;
      padding: 14px 28px;
      font-size: 16px;
      font-weight: 600;
      border-radius: 12px;
      cursor: pointer;
      margin-top: 16px;
    }
    .instructions { 
      color: #8b949e; 
      margin-top: 24px; 
      font-size: 14px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">✓</div>
    <h1>Successfully Connected!</h1>
    <div class="success">
      <p><strong>Wallet ID:</strong></p>
      <p class="wallet">${data.walletId}</p>
    </div>
    <p class="instructions">
      Your Phantom wallet has been connected to the Chrome extension.
      You can close this window and return to the extension to start using Phantom Agent.
    </p>
    <button onclick="window.close()">Close Window</button>
  </div>
  <script>
    // Try to notify the extension
    try {
      chrome.runtime.sendMessage('${data.extensionId}', {
        type: 'AUTH_COMPLETE',
        session: ${JSON.stringify(data)}
      });
    } catch(e) {
      console.log('Could not notify extension automatically');
    }
    // Auto-close after 5 seconds
    setTimeout(() => window.close(), 5000);
  </script>
</body>
</html>`;
}

function generateErrorHtml(error: string, description: string | null, extensionId: string) {
  const isCSPError = error.includes("unknown_error") || !description;
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Phantom Agent - Error</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117; 
      color: #fff; 
      display: flex; 
      flex-direction: column;
      align-items: center; 
      justify-content: center; 
      min-height: 100vh; 
      margin: 0;
      padding: 20px;
    }
    .container { text-align: center; max-width: 500px; }
    .logo { 
      width: 80px; 
      height: 80px; 
      background: #f85149;
      border-radius: 20px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 40px;
    }
    h1 { font-size: 24px; margin: 0 0 12px; }
    .error { 
      background: rgba(248, 81, 73, 0.1); 
      color: #f85149; 
      padding: 16px; 
      border-radius: 8px; 
      margin: 24px 0;
      text-align: left;
    }
    .error pre {
      background: rgba(0,0,0,0.3);
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 12px;
      margin-top: 10px;
    }
    .info {
      background: rgba(171, 159, 242, 0.1);
      color: #ab9ff2;
      padding: 16px;
      border-radius: 8px;
      margin: 24px 0;
      text-align: left;
      font-size: 14px;
      line-height: 1.5;
    }
    .info code {
      background: rgba(0,0,0,0.3);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
    }
    button {
      background: linear-gradient(135deg, #ab9ff2 0%, #7b6fd9 100%);
      color: white;
      border: none;
      padding: 14px 28px;
      font-size: 16px;
      font-weight: 600;
      border-radius: 12px;
      cursor: pointer;
      margin-top: 16px;
    }
    button.secondary {
      background: transparent;
      border: 2px solid #ab9ff2;
      margin-left: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">✕</div>
    <h1>Connection Failed</h1>
    
    ${isCSPError ? `
    <div class="info">
      <p><strong>Phantom Connect Issue Detected</strong></p>
      <p>Phantom Connect appears to have a technical issue with Chrome extensions. This is a known issue on Phantom's side.</p>
      <br>
      <p><strong>Workarounds:</strong></p>
      <ol>
        <li>Make sure you have the <a href="https://phantom.app" target="_blank" style="color: #ab9ff2;">Phantom browser extension</a> installed</li>
        <li>Try refreshing the page and connecting again</li>
        <li>Check that your redirect URL is whitelisted in the <a href="https://phantom.com/portal" target="_blank" style="color: #ab9ff2;">Phantom Portal</a>:</li>
      </ol>
      <pre>https://${extensionId}.chromiumapp.org/callback</pre>
    </div>
    ` : ''}
    
    <div class="error">
      <p><strong>Error:</strong> ${error}</p>
      ${description ? `<p>${description}</p>` : ''}
    </div>
    
    <div>
      <button onclick="window.close()">Close Window</button>
      <button class="secondary" onclick="window.location.reload()">Try Again</button>
    </div>
  </div>
  <script>
    try {
      chrome.runtime.sendMessage('${extensionId}', {
        type: 'AUTH_ERROR',
        error: '${error}${isCSPError ? ' (Phantom Connect CSP issue)' : ''}'
      });
    } catch(e) {}
  </script>
</body>
</html>`;
}

/**
 * Phantom MCP server webhook: fired when the embedded wallet receives an
 * external approval request (e.g. a dApp requesting a signature or
 * connection). The MCP server POSTs the raw approval event JSON here.
 *
 * This handler:
 * 1. Validates the shared webhook secret sent in the Authorization header.
 * 2. Reads the raw payload from the request body.
 * 3. Schedules an internal action that summarises the payload with the LLM
 *    and injects the plain-English description into the active thread.
 */
http.route({
  path: "/phantom-approval",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.PHANTOM_WEBHOOK_SECRET;
    const authHeader = request.headers.get("Authorization");

    if (!webhookSecret || authHeader !== `Bearer ${webhookSecret}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (
      typeof body !== "object" ||
      body === null ||
      !("threadId" in body) ||
      typeof (body as Record<string, unknown>).threadId !== "string"
    ) {
      return new Response(
        "Request body must include threadId: string",
        { status: 400 },
      );
    }

    const payload = body as { threadId: string; [key: string]: unknown };

    // TODO: Re-enable when approvals.ts is properly set up
    // await ctx.runMutation(internal.approvals.createPendingApproval, {
    //   threadId: payload.threadId,
    //   approvalPayload: JSON.stringify(body),
    // });

    return new Response(null, { status: 202 });
  }),
});

export default http;
