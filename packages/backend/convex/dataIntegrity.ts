/**
 * Data Integrity Tool — the most critical safety mechanism in the agent layer.
 *
 * PURPOSE
 * -------
 * One wrong character in a Solana mint address or Ethereum contract address
 * results in permanent, irreversible loss of user funds. This module provides
 * the ONLY sanctioned path through which the agent obtains on-chain addresses.
 *
 * The agent is explicitly prohibited from constructing, guessing, or recalling
 * any on-chain address from its training data or context window. Every address
 * used in a tool call must originate from this module.
 *
 * LOOKUP FLOW
 * -----------
 * 1. Check the `tokenAddressCache` table (24-hour TTL).
 * 2. On cache miss, query the appropriate registry:
 *    - Solana: Jupiter strict token list (https://token.jup.ag/strict)
 *    - EVM:    CoinGecko /coins/list + /coins/{id}/contract
 * 3. Write the result to the cache and return it.
 *
 * VERIFICATION FLOW
 * -----------------
 * When a user pastes a contract address directly, the agent passes it through
 * the `verify` path which cross-references known registries and returns a
 * warning if the address is not found.
 *
 * DISAMBIGUATION
 * --------------
 * If multiple tokens share the same symbol (e.g. several "DOGE" tokens on
 * Solana), the tool returns all matches and the agent surfaces them for the
 * user to choose from. The agent never picks one silently.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";

// ---------------------------------------------------------------------------
// Cache TTL
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Supported chain identifiers
// ---------------------------------------------------------------------------

export type SupportedChain = "solana" | "ethereum" | "bitcoin" | "sui";

// ---------------------------------------------------------------------------
// Registry response shapes
// ---------------------------------------------------------------------------

type JupiterToken = {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  tags?: string[];
};

type CoinGeckoListEntry = {
  id: string;
  symbol: string;
  name: string;
};

type CoinGeckoContractDetail = {
  id: string;
  name: string;
  symbol: string;
  contract_address: string;
  platforms: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export type TokenLookupResult =
  | { found: true; isNative: false; address: string; name: string; symbol: string; chain: SupportedChain }
  | { found: true; isNative: true; name: string; symbol: string; chain: SupportedChain }
  | { found: false; reason: string };

export type MultipleMatchesResult = {
  ambiguous: true;
  matches: Array<{ address: string; name: string; symbol: string }>;
};

export type LookupOutcome = TokenLookupResult | MultipleMatchesResult;

export type VerifyResult =
  | { verified: true; name: string; symbol: string; chain: SupportedChain }
  | { verified: false; warning: string };

// ---------------------------------------------------------------------------
// Native token registry
// ---------------------------------------------------------------------------

const NATIVE_TOKENS: Record<string, SupportedChain> = {
  SOL: "solana",
  ETH: "ethereum",
  BTC: "bitcoin",
  SUI: "sui",
};

// ---------------------------------------------------------------------------
// Internal cache helpers
// ---------------------------------------------------------------------------

/**
 * Reads a cache entry. Returns null on miss or stale entry.
 */
export const getCacheEntry = internalQuery({
  args: { cacheKey: v.string() },
  handler: async (ctx, { cacheKey }) => {
    const entry = await ctx.db
      .query("tokenAddressCache")
      .withIndex("by_cacheKey", (q) => q.eq("cacheKey", cacheKey))
      .unique();

    if (!entry) return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;

    return entry;
  },
});

/**
 * Writes (or overwrites) a cache entry.
 */
export const writeCacheEntry = internalMutation({
  args: {
    cacheKey: v.string(),
    address: v.string(),
    name: v.string(),
    chain: v.string(),
    isNative: v.boolean(),
  },
  handler: async (ctx, { cacheKey, address, name, chain, isNative }) => {
    const existing = await ctx.db
      .query("tokenAddressCache")
      .withIndex("by_cacheKey", (q) => q.eq("cacheKey", cacheKey))
      .unique();

    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }

    await ctx.db.insert("tokenAddressCache", {
      cacheKey,
      address,
      name,
      chain,
      isNative,
      cachedAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Core lookup action
// ---------------------------------------------------------------------------

/**
 * Looks up a token by symbol on the specified chain.
 *
 * Called by the agent tool before every address-dependent tool invocation.
 * Returns a `LookupOutcome` — the agent must handle all branches including
 * ambiguity and not-found before proceeding.
 */
export const lookupToken = internalAction({
  args: {
    symbol: v.string(),
    chain: v.string(),
  },
  handler: async (ctx, { symbol, chain }): Promise<LookupOutcome> => {
    const normalisedSymbol = symbol.replace(/^\$/, "").toUpperCase();
    const normalisedChain = chain.toLowerCase() as SupportedChain;

    // 1. Native token fast path — no contract address exists.
    const nativeChain = NATIVE_TOKENS[normalisedSymbol];
    if (nativeChain !== undefined && nativeChain === normalisedChain) {
      return {
        found: true,
        isNative: true,
        name: normalisedSymbol,
        symbol: normalisedSymbol,
        chain: normalisedChain,
      };
    }

    // 2. Cache check.
    const cacheKey = `${normalisedChain}:${normalisedSymbol}`;
    const cached = await ctx.runQuery(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "dataIntegrity:getCacheEntry" as any,
      { cacheKey },
    );
    if (cached !== null) {
      if (cached.isNative) {
        return {
          found: true,
          isNative: true,
          name: cached.name,
          symbol: normalisedSymbol,
          chain: cached.chain as SupportedChain,
        };
      }
      return {
        found: true,
        isNative: false,
        address: cached.address,
        name: cached.name,
        symbol: normalisedSymbol,
        chain: cached.chain as SupportedChain,
      };
    }

    // 3. Registry query.
    if (normalisedChain === "solana") {
      return await lookupSolanaToken(ctx, normalisedSymbol, cacheKey);
    }

    if (normalisedChain === "ethereum") {
      return await lookupEvmToken(ctx, normalisedSymbol, cacheKey, "ethereum");
    }

    return {
      found: false,
      reason: `Token lookup is not supported for chain "${chain}". Only "solana" and "ethereum" are supported via registry. For Bitcoin and Sui, use get_wallet_addresses to retrieve your wallet address and request transfers by address.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Solana lookup via Jupiter strict list
// ---------------------------------------------------------------------------

async function lookupSolanaToken(
  ctx: ActionCtx,
  symbol: string,
  cacheKey: string,
): Promise<LookupOutcome> {
  let tokens: JupiterToken[];
  try {
    const response = await fetch("https://token.jup.ag/strict", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        found: false,
        reason: `Jupiter token registry returned HTTP ${response.status}. Try again later.`,
      };
    }
    tokens = (await response.json()) as JupiterToken[];
  } catch (err) {
    return {
      found: false,
      reason: `Could not reach the Jupiter token registry: ${String(err)}`,
    };
  }

  const matches = tokens.filter(
    (t) => t.symbol.toUpperCase() === symbol,
  );

  if (matches.length === 0) {
    return {
      found: false,
      reason: `No token with symbol "${symbol}" found in the Jupiter strict token list. If you have the contract address, paste it directly.`,
    };
  }

  if (matches.length > 1) {
    // Ambiguous — surface all matches for the user to choose.
    return {
      ambiguous: true,
      matches: matches.map((t) => ({
        address: t.address,
        name: t.name,
        symbol: t.symbol,
      })),
    };
  }

  const token = matches[0];

  // Write to cache.
  await ctx.runMutation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "dataIntegrity:writeCacheEntry" as any,
    {
      cacheKey,
      address: token.address,
      name: token.name,
      chain: "solana",
      isNative: false,
    },
  );

  return {
    found: true,
    isNative: false,
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    chain: "solana",
  };
}

// ---------------------------------------------------------------------------
// EVM lookup via CoinGecko
// ---------------------------------------------------------------------------

async function lookupEvmToken(
  ctx: ActionCtx,
  symbol: string,
  cacheKey: string,
  chain: "ethereum",
): Promise<LookupOutcome> {
  // Step 1: find the CoinGecko ID for this symbol.
  let coinList: CoinGeckoListEntry[];
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/coins/list",
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return {
        found: false,
        reason: `CoinGecko API returned HTTP ${response.status}. Try again later.`,
      };
    }
    coinList = (await response.json()) as CoinGeckoListEntry[];
  } catch (err) {
    return {
      found: false,
      reason: `Could not reach the CoinGecko API: ${String(err)}`,
    };
  }

  const matches = coinList.filter(
    (c) => c.symbol.toUpperCase() === symbol,
  );

  if (matches.length === 0) {
    return {
      found: false,
      reason: `No token with symbol "${symbol}" found in CoinGecko. If you have the contract address, paste it directly.`,
    };
  }

  // For EVM we attempt to find the first match that has an Ethereum contract
  // address. This handles the common case; ambiguous tokens surface all.
  const resolvedMatches: Array<{ address: string; name: string; symbol: string }> = [];

  for (const coin of matches.slice(0, 5)) {
    // Limit to 5 to avoid excessive API calls.
    try {
      const detailResponse = await fetch(
        `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!detailResponse.ok) continue;

      const detail = (await detailResponse.json()) as CoinGeckoContractDetail;
      const ethAddress = detail.platforms?.["ethereum"];
      if (ethAddress && ethAddress.length > 0) {
        resolvedMatches.push({
          address: ethAddress,
          name: detail.name,
          symbol: detail.symbol.toUpperCase(),
        });
      }
    } catch {
      // Skip individual fetch failures — keep iterating.
    }
  }

  if (resolvedMatches.length === 0) {
    return {
      found: false,
      reason: `Found "${symbol}" on CoinGecko but could not resolve an Ethereum contract address. Paste the address directly if you have it.`,
    };
  }

  if (resolvedMatches.length > 1) {
    return {
      ambiguous: true,
      matches: resolvedMatches,
    };
  }

  const token = resolvedMatches[0];

  await ctx.runMutation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "dataIntegrity:writeCacheEntry" as any,
    {
      cacheKey,
      address: token.address,
      name: token.name,
      chain,
      isNative: false,
    },
  );

  return {
    found: true,
    isNative: false,
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    chain,
  };
}

// ---------------------------------------------------------------------------
// Address verification action
// ---------------------------------------------------------------------------

/**
 * Verifies a user-pasted address against known registries.
 *
 * If the address is found in a registry, returns verified=true with metadata.
 * If not found, returns verified=false with a warning the agent must relay
 * verbatim to the user before proceeding.
 *
 * The agent MUST call this before using any user-supplied address in a tool.
 */
export const verifyAddress = internalAction({
  args: {
    address: v.string(),
    chain: v.string(),
  },
  handler: async (_ctx, { address, chain }): Promise<VerifyResult> => {
    const normalisedChain = chain.toLowerCase() as SupportedChain;

    if (normalisedChain === "solana") {
      // Validate base58 length (Solana addresses are 32–44 chars).
      if (address.length < 32 || address.length > 44) {
        return {
          verified: false,
          warning:
            "This does not appear to be a valid Solana address (wrong length). Double-check before proceeding — transactions are irreversible.",
        };
      }

      try {
        const response = await fetch("https://token.jup.ag/strict", {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const tokens = (await response.json()) as JupiterToken[];
          const match = tokens.find(
            (t) => t.address.toLowerCase() === address.toLowerCase(),
          );
          if (match) {
            return {
              verified: true,
              name: match.name,
              symbol: match.symbol,
              chain: "solana",
            };
          }
        }
      } catch {
        // Registry unreachable — treat as unverifiable.
      }

      return {
        verified: false,
        warning:
          "This address is not in the Jupiter strict token list. This may be a valid but unverified token. Proceed with extreme caution — transactions are irreversible. Only continue if you are certain of this address.",
      };
    }

    if (normalisedChain === "ethereum") {
      // Basic EIP-55 checksum address format: 0x + 40 hex chars.
      const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
      if (!evmAddressPattern.test(address)) {
        return {
          verified: false,
          warning:
            "This does not appear to be a valid Ethereum address. Double-check before proceeding — transactions are irreversible.",
        };
      }

      // We don't batch lookup on CoinGecko by address in verification mode
      // to avoid excessive rate-limiting. Structural validity is sufficient
      // for the warning gate.
      return {
        verified: false,
        warning:
          "This Ethereum address has valid format but is not cross-referenced against CoinGecko. Verify it via a block explorer before proceeding — transactions are irreversible.",
      };
    }

    // Bitcoin and Sui: structural sanity only.
    return {
      verified: false,
      warning: `Address verification against a registry is not available for ${chain}. Verify this address via a block explorer before proceeding — transactions are irreversible.`,
    };
  },
});
