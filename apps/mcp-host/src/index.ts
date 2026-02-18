/**
 * Phantom MCP Host — Express REST shim.
 *
 * Deployed on Railway as a persistent Node.js service. The Convex backend
 * calls this server's endpoints from internalActions. Each request carries
 * the user's per-request stamper credentials so this server is stateless —
 * no filesystem session files, no shared state across requests.
 *
 * Endpoints
 * ---------
 *   POST /call
 *     Body: { tool: string; args: object; session: RequestSession }
 *     Auth: Authorization: Bearer <PHANTOM_MCP_SHARED_SECRET>
 *     Returns: { success: true; result: unknown }
 *           | { success: false; error: string }
 *
 *   POST /resolve-approval
 *     Body: { approvalId: string; decision: "approved"|"rejected"; sessionToken: string }
 *     Auth: Authorization: Bearer <PHANTOM_MCP_SHARED_SECRET>
 *     Returns: { success: true }
 *
 *   GET /health
 *     Returns: { ok: true; uptime: number }
 *
 * Required env vars
 * -----------------
 *   PHANTOM_APP_ID            Your Phantom Portal application ID
 *   PHANTOM_MCP_SHARED_SECRET Secret shared with the Convex backend
 *
 * Optional env vars
 * -----------------
 *   PORT                      HTTP port (default: 3000)
 *   PHANTOM_API_BASE_URL      Phantom API base URL (default: https://api.phantom.app)
 *   PHANTOM_MCP_DEBUG         Set to "1" to enable debug logging
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { dispatchTool, ToolNotFoundError } from "./tools.js";
import { Logger } from "./logger.js";
import type { RequestSession } from "./client.js";

// ---------------------------------------------------------------------------
// Boot-time validation
// ---------------------------------------------------------------------------

const SHARED_SECRET = process.env.PHANTOM_MCP_SHARED_SECRET;
const PHANTOM_APP_ID = process.env.PHANTOM_APP_ID;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

if (!SHARED_SECRET) {
  throw new Error(
    "PHANTOM_MCP_SHARED_SECRET environment variable is required. " +
      "Set it in your Railway service variables.",
  );
}

if (!PHANTOM_APP_ID) {
  throw new Error(
    "PHANTOM_APP_ID environment variable is required. " +
      "Set it in your Railway service variables.",
  );
}

const log = new Logger("server");

// ---------------------------------------------------------------------------
// Request shape types
// ---------------------------------------------------------------------------

interface CallRequestBody {
  tool: string;
  args: Record<string, unknown>;
  session: {
    walletId: string;
    organizationId: string;
    stamperSecretKey: string;
  };
}

interface ResolveApprovalRequestBody {
  approvalId: string;
  decision: "approved" | "rejected";
  sessionToken: string; // Not used by this server yet — reserved for future use
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Auth middleware — validates the shared secret on every non-health request
// ---------------------------------------------------------------------------

function requireSharedSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${SHARED_SECRET}`) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Health check — no auth required, used by Railway's health check config
// ---------------------------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// POST /call — dispatch a Phantom MCP tool call
// ---------------------------------------------------------------------------

app.post("/call", requireSharedSecret, async (req: Request, res: Response) => {
  const body = req.body as Partial<CallRequestBody>;

  // Validate required fields
  if (typeof body.tool !== "string" || !body.tool) {
    res.status(400).json({ success: false, error: "Missing required field: tool" });
    return;
  }

  if (
    typeof body.session?.walletId !== "string" ||
    typeof body.session?.organizationId !== "string" ||
    typeof body.session?.stamperSecretKey !== "string"
  ) {
    res.status(400).json({
      success: false,
      error:
        "Missing required session fields: walletId, organizationId, stamperSecretKey",
    });
    return;
  }

  const session: RequestSession = {
    walletId: body.session.walletId,
    organizationId: body.session.organizationId,
    stamperSecretKey: body.session.stamperSecretKey,
  };

  const args = (body.args ?? {}) as Record<string, unknown>;

  try {
    const result = await dispatchTool(body.tool, args, session);
    res.json({ success: true, result });
  } catch (err) {
    if (err instanceof ToolNotFoundError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Tool ${body.tool} failed: ${message}`);
    res.status(500).json({ success: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /resolve-approval — forward an approval decision
// ---------------------------------------------------------------------------

app.post(
  "/resolve-approval",
  requireSharedSecret,
  async (req: Request, res: Response) => {
    const body = req.body as Partial<ResolveApprovalRequestBody>;

    if (typeof body.approvalId !== "string" || !body.approvalId) {
      res.status(400).json({ success: false, error: "Missing required field: approvalId" });
      return;
    }

    if (body.decision !== "approved" && body.decision !== "rejected") {
      res.status(400).json({
        success: false,
        error: "decision must be 'approved' or 'rejected'",
      });
      return;
    }

    // Approval resolution is handled by the Phantom embedded wallet
    // infrastructure. For now we acknowledge receipt; the Convex backend
    // tracks the decision in the pendingApprovals table.
    log.info(`Approval ${body.approvalId} resolved as: ${body.decision}`);
    res.json({ success: true });
  },
);

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  log.error(`Unhandled error: ${message}`);
  res.status(500).json({ success: false, error: message });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  log.info(`Phantom MCP Host listening on port ${PORT}`);
  log.info(`PHANTOM_APP_ID: ${PHANTOM_APP_ID}`);
});
