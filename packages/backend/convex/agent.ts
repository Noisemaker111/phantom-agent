/**
 * Phantom Agent — core agent definition.
 *
 * Model:   openrouter/aurora-alpha (via @ai-sdk/openrouter)
 * Backend: @convex-dev/agent
 *
 * Tools defined here proxy through to the hosted Phantom MCP server
 * (phantom.ts) and the local data_integrity actions (dataIntegrity.ts).
 * Session credentials are forwarded per-call as tool arguments; the agent
 * receives them from the thread context injected by chat.ts.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { Agent, createTool, type ToolCtx } from "@convex-dev/agent";
import { z } from "zod";

import { components, internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Forwards a Phantom MCP tool call through the Convex internal proxy action
 * and returns the parsed JSON result.
 *
 * Using a named helper avoids TypeScript's circular inference problem that
 * arises when an arrow function inside createTool references itself via the
 * tool variable before it is fully typed.
 */
async function runMcpTool(
  ctx: ToolCtx,
  toolName: string,
  toolArgs: Record<string, unknown>,
  session: {
    walletId: string;
    organizationId: string;
    sessionToken: string;
    stamperSecretKey: string;
  },
): Promise<unknown> {
  const result = await ctx.runAction(internal.phantom.callMcpTool, {
    toolName,
    toolArgs: JSON.stringify(toolArgs),
    walletId: session.walletId,
    organizationId: session.organizationId,
    sessionToken: session.sessionToken,
    stamperSecretKey: session.stamperSecretKey,
  });
  return JSON.parse(result) as unknown;
}

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Use .chat() explicitly to get OpenRouterChatLanguageModel (LanguageModelV2),
// not OpenRouterCompletionLanguageModel (LanguageModelV3) which is the first
// overload of the callable form and is incompatible with @convex-dev/agent v0.3.x.
const languageModel = openrouter.chat("openrouter/aurora-alpha");

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Phantom Agent — an autonomous AI wallet agent with direct control over the user's Phantom embedded wallet. You execute wallet operations immediately, in natural language, without confirmation dialogs or button clicks.

## Your Identity

You are a senior crypto operations specialist. You know every chain Phantom supports (Solana, Ethereum, Bitcoin, Sui). You execute with precision and without hesitation. You are zero-friction by design — users have explicitly opted into autonomous wallet operation.

## The Absolute Rule: Never Construct Addresses From Memory

This is the single most important constraint in your operation. You are **explicitly prohibited** from constructing, guessing, recalling, or interpolating any on-chain address from your training data or context window. This includes:
- Token mint addresses (e.g. Solana SPL token addresses)
- EVM contract addresses
- Wallet addresses
- Program IDs
- Any on-chain identifier whatsoever

**Why:** One wrong character in a Solana mint address or Ethereum contract address causes permanent, irreversible loss of funds. No exception justifies bypassing this rule.

**What you must do instead:**
1. Call \`data_integrity\` with \`{ lookup: "<symbol>", chain: "<chain>" }\` to retrieve verified addresses from the Jupiter strict token list (Solana) or CoinGecko (Ethereum).
2. Use the returned address **directly** as a function argument — never retype or interpolate it.
3. If \`data_integrity\` cannot find a verified address, tell the user: "I couldn't find a verified contract address for [token]. Please paste the contract address directly and I will use it exactly as provided."
4. When the user pastes an address, pass it through \`data_integrity\` with \`{ verify: "<address>", chain: "<chain>" }\` before use. If unverifiable, warn: "This address is not in any verified registry. Transactions are irreversible. Type 'yes proceed' to continue." Then wait for explicit confirmation before using the address.

## Tool Call Sequence — Example Walkthroughs

**Swap SOL for BONK:**
1. Call \`data_integrity\` with \`{ lookup: "BONK", chain: "solana" }\` → get verified mint address
2. Call \`buy_token\` with \`{ buyTokenMint: <address from step 1>, sellTokenIsNative: true, amount: <amount>, amountUnit: "ui", execute: true, autoSlippage: true }\`
3. Report: "Bought X BONK for Y SOL at $Z/BONK. Transaction confirmed."

**Transfer ETH:**
1. Verify recipient address: call \`data_integrity\` with \`{ verify: "<address>", chain: "ethereum" }\`
2. If verified or user confirmed: call \`sign_transaction\` with the RLP-encoded transfer
3. Report: "Transferred X ETH to <address>. Transaction confirmed."

**Buy USDC with SOL:**
1. Call \`data_integrity\` with \`{ lookup: "USDC", chain: "solana" }\` → get mint address
2. Call \`buy_token\` with the resolved mint address, \`sellTokenIsNative: true\`
3. Report result.

**User asks "What's my Solana address?":**
1. Call \`get_wallet_addresses\` with default derivation index
2. Report: "Your Solana address is <address>."

## Tool Usage Reference

### \`get_wallet_addresses\`
- Call whenever you need the user's wallet address for any chain.
- Parameters: \`derivationIndex\` (optional, default 0).
- Returns walletId, organizationId, and array of { addressType, address }.

### \`sign_transaction\`
- Used for Ethereum, Bitcoin, Sui operations not covered by transfer_tokens or buy_token.
- Required: \`transaction\` (base64url for Solana, RLP hex for Ethereum), \`networkId\` (CAIP-2).
- Never construct transaction bytes from memory — build them from data returned by other tools.

### \`transfer_tokens\`
- Solana only. Builds, signs, and broadcasts a SOL or SPL token transfer immediately.
- Required: \`networkId\`, \`to\`, \`amount\`, \`amountUnit\`.
- Optional: \`tokenMint\` (for SPL tokens — must come from \`data_integrity\`).
- Executes immediately. No undo.

### \`buy_token\`
- Solana only. Fetches a swap quote and executes it.
- Always use \`execute: true\` — never present quotes for manual confirmation.
- Always use \`autoSlippage: true\` unless the user has specified a slippage tolerance.
- Always use \`amountUnit: "ui"\` (human-readable amounts, not base units).
- For native SOL: use \`sellTokenIsNative: true\` or \`buyTokenIsNative: true\`.
- For SPL tokens: use \`buyTokenMint\` or \`sellTokenMint\` — address MUST come from \`data_integrity\`.

### \`sign_message\`
- Signs a UTF-8 message for authentication proofs, permit signing, attestations.
- Required: \`message\`, \`networkId\`.

### \`data_integrity\`
- **Call before every use of any token address, contract address, or on-chain identifier.**
- \`{ lookup: "<symbol>", chain: "<chain>" }\` — resolves a token symbol to a verified address.
- \`{ verify: "<address>", chain: "<chain>" }\` — cross-references a user-supplied address.
- Returns verified address, disambiguation list, native flag, or error for relay to user.

## Default Execution Behaviours

- **Auto slippage:** Always enabled unless the user specifies a slippage percentage.
- **Gas/fees:** Handled automatically. Never ask the user about gas.
- **Prices:** Use the current market price from the quote API response.
- **Immediate execution:** All buy_token calls use \`execute: true\`. No quote previews.
- **No on-ramp/off-ramp:** Fiat-to-crypto is out of scope for v1.
- **EVM swaps not supported:** buy_token is Solana-only. For cross-chain swap requests, respond: "Cross-chain swaps are not currently supported through the agent. I can transfer your [asset] to an exchange address if you provide one, or swap on Solana."

## Tool Execution Message Format

When a tool is running, stream exactly:
\`[running: <tool_name>]\`

When the action completes, provide a natural language summary:
- What was done
- Price/rate at execution time
- Confirmation that the transaction was submitted

Examples:
- "Swapped 1 SOL to 42,000 BONK at $0.0000235/BONK. Transaction confirmed."
- "Transferred 0.5 ETH to 0xABCD...1234. Transaction confirmed."
- "Bought $50 of USDC with SOL at $0.9999/USDC. Transaction confirmed."

Never paste raw transaction signatures, base64 data, or long hashes. If the user asks for a signature, display it clearly labelled on its own line.

## Handling Ambiguity

- Ambiguous request: ask the minimal clarifying question.
- Ambiguous token symbol (multiple matches): list them and ask which.
- For multi-step operations: execute in sequence, report each step.
- On failure: stop and report clearly. Never proceed past a failed tool call.

## Wallet Approval Requests

When you receive an injected approval description, your response must:
1. Describe in plain English what is being requested and what it would do.
2. Identify risk indicators (unknown domain, unusual permissions, large amounts).
3. End with: "**What would you like to do?** [Approve] [Reject]"

"approve", "yes", "ok", "go ahead" → Approve.
"reject", "no", "deny", "cancel" → Reject.
Capture the APPROVAL_ID from the message context and pass it to the approval resolution.

## What You Are Not

- Not a portfolio tracker. Surface balances as text via get_wallet_addresses.
- Not a DeFi analyst. Execute what the user asks, precisely.
- Not a seed phrase manager. Never discuss private keys.
- Not a multi-wallet manager. One Phantom embedded wallet per user.`;

// ---------------------------------------------------------------------------
// Tool definitions — all proxy through to Convex internal actions
// ---------------------------------------------------------------------------

// Each handler is typed as returning Promise<unknown> to break TypeScript's
// circular inference problem that arises when the return type of createTool
// is not immediately inferrable (stale generated API types during offline dev).

const get_wallet_addresses = createTool({
  description:
    "Gets all blockchain addresses for the authenticated user's embedded Phantom wallet across all supported chains (Solana, Ethereum, Bitcoin, Sui). Call this whenever you need the user's wallet address for any chain.",
  args: z.object({
    derivationIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("HD wallet derivation index. Default is 0 (the primary wallet)."),
    sessionToken: z.string().describe("The caller's Phantom OAuth session token."),
    walletId: z.string().describe("The Phantom embedded wallet ID."),
    organizationId: z.string().describe("The Phantom organization ID."),
    stamperSecretKey: z.string().describe("The stamper secret key from the SSO flow."),
  }),
  handler: async (
    ctx: ToolCtx,
    { derivationIndex, sessionToken, walletId, organizationId, stamperSecretKey }: {
      derivationIndex?: number;
      sessionToken: string;
      walletId: string;
      organizationId: string;
      stamperSecretKey: string;
    },
  ): Promise<unknown> => {
    return runMcpTool(
      ctx,
      "get_wallet_addresses",
      { derivationIndex: derivationIndex ?? 0 },
      { walletId, organizationId, sessionToken, stamperSecretKey },
    );
  },
});

const sign_transaction = createTool({
  description:
    "Signs a raw transaction for any supported chain. Used for Ethereum, Bitcoin, and Sui operations where transfer_tokens and buy_token are not available. Transaction bytes must be constructed from data returned by other tools — never from memory.",
  args: z.object({
    transaction: z
      .string()
      .describe(
        "The raw transaction to sign. Base64url-encoded for Solana; RLP hex for Ethereum.",
      ),
    networkId: z
      .string()
      .describe("The CAIP-2 network identifier, e.g. 'solana:mainnet' or 'eip155:1'."),
    sessionToken: z.string().describe("The caller's Phantom OAuth session token."),
    walletId: z.string().describe("The Phantom embedded wallet ID."),
    organizationId: z.string().describe("The Phantom organization ID."),
    stamperSecretKey: z.string().describe("The stamper secret key from the SSO flow."),
  }),
  handler: async (
    ctx: ToolCtx,
    { transaction, networkId, sessionToken, walletId, organizationId, stamperSecretKey }: {
      transaction: string;
      networkId: string;
      sessionToken: string;
      walletId: string;
      organizationId: string;
      stamperSecretKey: string;
    },
  ): Promise<unknown> => {
    return runMcpTool(
      ctx,
      "sign_transaction",
      { transaction, networkId },
      { walletId, organizationId, sessionToken, stamperSecretKey },
    );
  },
});

const transfer_tokens = createTool({
  description:
    "Solana only. Builds, signs, and broadcasts a SOL or SPL token transfer immediately — no confirmation step. Executes permanently. For SPL tokens, tokenMint MUST come from the data_integrity tool.",
  args: z.object({
    networkId: z.string().describe("The CAIP-2 Solana network ID, e.g. 'solana:mainnet'."),
    to: z.string().describe("The recipient Solana wallet address."),
    amount: z.string().describe("The amount to transfer as a string."),
    amountUnit: z
      .enum(["ui", "base"])
      .describe("'ui' for human-readable units (e.g. '1.5' SOL), 'base' for lamports."),
    tokenMint: z
      .string()
      .optional()
      .describe(
        "For SPL token transfers: the token mint address from data_integrity. Omit for native SOL.",
      ),
    decimals: z.number().int().optional().describe("Token decimals. Required for SPL tokens."),
    rpcUrl: z.string().optional().describe("Custom RPC URL. Uses default if omitted."),
    createAssociatedTokenAccount: z
      .boolean()
      .optional()
      .describe(
        "Whether to create the recipient's associated token account if it does not exist.",
      ),
    sessionToken: z.string().describe("The caller's Phantom OAuth session token."),
    walletId: z.string().describe("The Phantom embedded wallet ID."),
    organizationId: z.string().describe("The Phantom organization ID."),
    stamperSecretKey: z.string().describe("The stamper secret key from the SSO flow."),
  }),
  handler: async (
    ctx: ToolCtx,
    {
      networkId,
      to,
      amount,
      amountUnit,
      tokenMint,
      decimals,
      rpcUrl,
      createAssociatedTokenAccount,
      sessionToken,
      walletId,
      organizationId,
      stamperSecretKey,
    }: {
      networkId: string;
      to: string;
      amount: string;
      amountUnit: "ui" | "base";
      tokenMint?: string;
      decimals?: number;
      rpcUrl?: string;
      createAssociatedTokenAccount?: boolean;
      sessionToken: string;
      walletId: string;
      organizationId: string;
      stamperSecretKey: string;
    },
  ): Promise<unknown> => {
    const args: Record<string, unknown> = { networkId, to, amount, amountUnit };
    if (tokenMint !== undefined) args.tokenMint = tokenMint;
    if (decimals !== undefined) args.decimals = decimals;
    if (rpcUrl !== undefined) args.rpcUrl = rpcUrl;
    if (createAssociatedTokenAccount !== undefined) {
      args.createAssociatedTokenAccount = createAssociatedTokenAccount;
    }
    return runMcpTool(ctx, "transfer_tokens", args, { walletId, organizationId, sessionToken, stamperSecretKey });
  },
});

const buy_token = createTool({
  description:
    "Solana only. Fetches a swap quote from Phantom's quotes API and immediately executes it. Always use execute: true. Always use autoSlippage: true unless the user specified a slippage tolerance. Always use amountUnit: 'ui'. buyTokenMint and sellTokenMint MUST come from data_integrity. Use buyTokenIsNative/sellTokenIsNative for native SOL.",
  args: z.object({
    amount: z
      .string()
      .describe("The amount to swap as a string in UI (human-readable) units."),
    amountUnit: z.literal("ui").describe("Always 'ui' — human-readable units."),
    buyTokenMint: z
      .string()
      .optional()
      .describe(
        "Mint address of the token to buy, from data_integrity. Mutually exclusive with buyTokenIsNative.",
      ),
    buyTokenIsNative: z
      .boolean()
      .optional()
      .describe("true when buying native SOL. Mutually exclusive with buyTokenMint."),
    sellTokenMint: z
      .string()
      .optional()
      .describe(
        "Mint address of the token to sell, from data_integrity. Mutually exclusive with sellTokenIsNative.",
      ),
    sellTokenIsNative: z
      .boolean()
      .optional()
      .describe("true when selling native SOL. Mutually exclusive with sellTokenMint."),
    execute: z.literal(true).describe("Always true. Never present quotes for confirmation."),
    autoSlippage: z
      .boolean()
      .describe("true unless the user has specified a slippage tolerance."),
    slippageBps: z
      .number()
      .int()
      .optional()
      .describe(
        "Slippage tolerance in basis points. Only set when autoSlippage is false.",
      ),
    sessionToken: z.string().describe("The caller's Phantom OAuth session token."),
    walletId: z.string().describe("The Phantom embedded wallet ID."),
    organizationId: z.string().describe("The Phantom organization ID."),
    stamperSecretKey: z.string().describe("The stamper secret key from the SSO flow."),
  }),
  handler: async (
    ctx: ToolCtx,
    {
      amount,
      amountUnit,
      buyTokenMint,
      buyTokenIsNative,
      sellTokenMint,
      sellTokenIsNative,
      execute,
      autoSlippage,
      slippageBps,
      sessionToken,
      walletId,
      organizationId,
      stamperSecretKey,
    }: {
      amount: string;
      amountUnit: "ui";
      buyTokenMint?: string;
      buyTokenIsNative?: boolean;
      sellTokenMint?: string;
      sellTokenIsNative?: boolean;
      execute: true;
      autoSlippage: boolean;
      slippageBps?: number;
      sessionToken: string;
      walletId: string;
      organizationId: string;
      stamperSecretKey: string;
    },
  ): Promise<unknown> => {
    const args: Record<string, unknown> = { amount, amountUnit, execute, autoSlippage };
    if (buyTokenMint !== undefined) args.buyTokenMint = buyTokenMint;
    if (buyTokenIsNative !== undefined) args.buyTokenIsNative = buyTokenIsNative;
    if (sellTokenMint !== undefined) args.sellTokenMint = sellTokenMint;
    if (sellTokenIsNative !== undefined) args.sellTokenIsNative = sellTokenIsNative;
    if (slippageBps !== undefined) args.slippageBps = slippageBps;
    return runMcpTool(ctx, "buy_token", args, { walletId, organizationId, sessionToken, stamperSecretKey });
  },
});

const sign_message = createTool({
  description:
    "Signs a UTF-8 message using the user's Phantom wallet. Used for authentication proofs, permit signing, and off-chain attestations. Do not modify the message content.",
  args: z.object({
    message: z.string().describe("The UTF-8 message to sign."),
    networkId: z
      .string()
      .describe("The CAIP-2 network identifier for the signing key to use."),
    sessionToken: z.string().describe("The caller's Phantom OAuth session token."),
    walletId: z.string().describe("The Phantom embedded wallet ID."),
    organizationId: z.string().describe("The Phantom organization ID."),
    stamperSecretKey: z.string().describe("The stamper secret key from the SSO flow."),
  }),
  handler: async (
    ctx: ToolCtx,
    { message, networkId, sessionToken, walletId, organizationId, stamperSecretKey }: {
      message: string;
      networkId: string;
      sessionToken: string;
      walletId: string;
      organizationId: string;
      stamperSecretKey: string;
    },
  ): Promise<unknown> => {
    return runMcpTool(
      ctx,
      "sign_message",
      { message, networkId },
      { walletId, organizationId, sessionToken, stamperSecretKey },
    );
  },
});

const data_integrity = createTool({
  description:
    "MANDATORY safety tool. Call before EVERY use of any token address, contract address, or on-chain identifier. Two modes: (1) lookup: resolves a token symbol to a verified on-chain address from Jupiter (Solana) or CoinGecko (Ethereum). (2) verify: cross-references a user-supplied address against known registries and returns a warning if unverifiable. Never use an address that did not come from this tool or pass verbatim through its verify mode.",
  args: z.object({
    lookup: z
      .string()
      .optional()
      .describe(
        "Token symbol to look up (e.g. 'BONK', 'USDC', 'DOGE'). Requires the chain parameter.",
      ),
    verify: z
      .string()
      .optional()
      .describe(
        "A user-supplied on-chain address to cross-reference against registries. Requires the chain parameter.",
      ),
    chain: z
      .string()
      .describe(
        "The chain for lookup or verification: 'solana', 'ethereum', 'bitcoin', or 'sui'.",
      ),
  }),
  handler: async (
    ctx: ToolCtx,
    { lookup, verify, chain }: { lookup?: string; verify?: string; chain: string },
  ): Promise<unknown> => {
    if (lookup !== undefined) {
      return ctx.runAction(internal.dataIntegrity.lookupToken, { symbol: lookup, chain });
    }
    if (verify !== undefined) {
      return ctx.runAction(internal.dataIntegrity.verifyAddress, { address: verify, chain });
    }
    return {
      error:
        "data_integrity requires either 'lookup' (symbol) or 'verify' (address) to be specified.",
    };
  },
});

// ---------------------------------------------------------------------------
// Agent export
// ---------------------------------------------------------------------------

export const chatAgent = new Agent(components.agent, {
  name: "Phantom Agent",
  languageModel,
  instructions: SYSTEM_PROMPT,
  tools: {
    get_wallet_addresses,
    sign_transaction,
    transfer_tokens,
    buy_token,
    sign_message,
    data_integrity,
  },
});
