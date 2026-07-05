var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CONFIG = {
  CACHE_TTL: 120,
  PRICE_CACHE_TTL: 30,
  MAX_RETRIES: 3,
  TIMEOUT_DEFAULT: 8e3,
  TIMEOUT_PYTH: 2e3,
  TIMEOUT_COINGECKO: 5e3,
  TIMEOUT_COINCAP: 3e3,
  RATE_LIMIT: 100,
  AUTH_TOKEN: null,
  PRICE_DEVIATION_THRESHOLD: 5e-3,
  DEGRADATION_ALERT_THRESHOLD: 10,
  CORS_ORIGINS: [
    "https://huggingface.co",
    "https://qisuanai.com",
    "https://chainsight.qisuanai.com"
  ]
};
var COIN_TO_COINCAP = {
  "bitcoin": "bitcoin",
  "ethereum": "ethereum",
  "solana": "solana",
  "binancecoin": "binance-coin",
  "ripple": "xrp",
  "cardano": "cardano",
  "dogecoin": "dogecoin",
  "avalanche-2": "avalanche",
  "polkadot": "polkadot",
  "matic-network": "polygon",
  "chainlink": "chainlink",
  "uniswap": "uniswap",
  "litecoin": "litecoin",
  "shiba-inu": "shiba-inu",
  "tron": "tron",
  "stellar": "stellar",
  "hedera-hashgraph": "hedera-hashgraph",
  "ethereum-classic": "ethereum-classic",
  "near": "near-protocol",
  "cosmos": "cosmos",
  "filecoin": "filecoin"
};
var PYTH_PRICE_IDS = {
  "BTCUSDT": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETHUSDT": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "SOLUSDT": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BNBUSDT": "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
  "XRPUSDT": "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
  "ADAUSDT": "0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d",
  "DOGEUSDT": "0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c",
  "AVAXUSDT": "0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",
  "DOTUSDT": "0xca3eed9b267293f6595901c734c7525ce8ef49adafe8284606ceb307afa2ca5b",
  "MATICUSDT": "0x5de33a9112c2b700b8d30b8a3402c103578ccfa2765696471cc672bd5cf6ac52",
  "LINKUSDT": "0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
  "UNIUSDT": "0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501",
  "LTCUSDT": "0x6e3f3fa8253588df93265801802398ebcda6f23c4ce26e6c9641e6e298f7b2b9",
  "SHIBUSDT": "0xf0d57deca57b3da2fe63a493f4c25925fdfd8edf834b20f93e1f84dbd1504d4b",
  "TRXUSDT": "0x67aed5a24fdad045475e7195c98a98aea119c763f272d4523f5bac93a4f33c2b"
};
var PYTH_SUPPORTED = new Set(Object.keys(PYTH_PRICE_IDS));
var DegradationCounter = class {
  static {
    __name(this, "DegradationCounter");
  }
  constructor(windowMs = 6e5, threshold = 10) {
    this.window = windowMs;
    this.threshold = threshold;
    this.counters = /* @__PURE__ */ new Map();
  }
  increment(source, target) {
    const key = `${source}->${target}`;
    const now = Date.now();
    const record = this.counters.get(key) || { count: 0, reset: now + this.window };
    if (now > record.reset) {
      record.count = 0;
      record.reset = now + this.window;
    }
    record.count++;
    this.counters.set(key, record);
    if (record.count >= this.threshold) {
      log("alert", "degradation_threshold_exceeded", {
        from: source,
        to: target,
        count: record.count,
        window_ms: this.window
      });
    }
  }
  getStats() {
    const now = Date.now();
    const stats = {};
    this.counters.forEach((record, key) => {
      if (now <= record.reset) stats[key] = record.count;
    });
    return stats;
  }
};
var degradationCounter = new DegradationCounter(
  6e5,
  CONFIG.DEGRADATION_ALERT_THRESHOLD
);
var RateLimiter = class {
  static {
    __name(this, "RateLimiter");
  }
  constructor(max, win) {
    this.max = max;
    this.window = win;
    this.store = /* @__PURE__ */ new Map();
  }
  check(ip) {
    const now = Date.now();
    const record = this.store.get(ip) || { count: 0, reset: now + this.window };
    if (now > record.reset) {
      record.count = 0;
      record.reset = now + this.window;
    }
    record.count++;
    this.store.set(ip, record);
    return record.count <= this.max;
  }
};
var limiter = new RateLimiter(CONFIG.RATE_LIMIT, 6e4);
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), level, message, ...extra }));
}
__name(log, "log");
function errRes(code, detail) {
  return Response.json(
    { error: { code, detail, ts: (/* @__PURE__ */ new Date()).toISOString() } },
    { status: code }
  );
}
__name(errRes, "errRes");
function corsHdrs(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHdrs, "corsHdrs");
async function fetchTO(url, opts = {}, timeout = CONFIG.TIMEOUT_DEFAULT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchTO, "fetchTO");
async function fetchRetry(url, opts = {}, retries = CONFIG.MAX_RETRIES, timeout = CONFIG.TIMEOUT_DEFAULT) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetchTO(url, opts, timeout);
      if (resp.status === 429) {
        log("warn", "rate_limited_upstream", { url, attempt: i + 1 });
        await new Promise((r) => setTimeout(r, 2e3 * (i + 1)));
        continue;
      }
      if (resp.status === 451) {
        log("warn", "geo_blocked", { url });
        return null;
      }
      if (!resp.ok) {
        log("warn", "fetch_failed", { url, status: resp.status, attempt: i + 1 });
        continue;
      }
      return resp;
    } catch (e) {
      log("warn", "fetch_error", { url, error: e.message, attempt: i + 1 });
    }
  }
  return null;
}
__name(fetchRetry, "fetchRetry");
function validatePriceConsensus(prices) {
  if (prices.length === 0) return null;
  if (prices.length === 1) return { ...prices[0], consensus: "single_source" };
  const values = prices.map((p) => p.price);
  const median = values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const deviations = prices.map((p) => ({
    ...p,
    deviation: Math.abs(p.price - median) / median
  }));
  const maxDeviation = Math.max(...deviations.map((d) => d.deviation));
  if (maxDeviation > CONFIG.PRICE_DEVIATION_THRESHOLD) {
    log("warn", "price_deviation_detected", {
      prices: prices.map((p) => ({ source: p.source, price: p.price })),
      median,
      max_deviation: maxDeviation
    });
  }
  const best = deviations.reduce((a, b) => a.deviation <= b.deviation ? a : b);
  return {
    price: best.price,
    source: best.source,
    consensus: prices.length >= 2 ? "multi_source_verified" : "single_source",
    all_sources: prices.map((p) => p.source),
    deviation: maxDeviation
  };
}
__name(validatePriceConsensus, "validatePriceConsensus");
async function fetchCoinGeckoOHLC(coinId, days) {
  const start = Date.now();
  const resp = await fetchRetry(
    `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`,
    {},
    CONFIG.MAX_RETRIES,
    CONFIG.TIMEOUT_COINGECKO
  );
  if (!resp) return null;
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return {
    source: "coingecko",
    coin_id: coinId,
    days,
    latency_ms: Date.now() - start,
    data: data.map((d) => ({
      timestamp: d[0],
      open: d[1],
      high: d[2],
      low: d[3],
      close: d[4],
      volume: 0
    }))
  };
}
__name(fetchCoinGeckoOHLC, "fetchCoinGeckoOHLC");
async function fetchPythPrice(symbol) {
  const priceId = PYTH_PRICE_IDS[symbol];
  if (!priceId) return null;
  const start = Date.now();
  const resp = await fetchRetry(
    `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${priceId}`,
    {},
    2,
    CONFIG.TIMEOUT_PYTH
  );
  if (!resp) return null;
  const data = await resp.json();
  const parsed = data?.parsed?.[0]?.price;
  if (!parsed) return null;
  return {
    source: "pyth",
    symbol,
    price: parseFloat(parsed.price) * Math.pow(10, parsed.expo),
    latency_ms: Date.now() - start
  };
}
__name(fetchPythPrice, "fetchPythPrice");
async function fetchCoinGeckoPrice(coinId) {
  const start = Date.now();
  const resp = await fetchRetry(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
    {},
    2,
    CONFIG.TIMEOUT_COINGECKO
  );
  if (!resp) return null;
  const data = await resp.json();
  const price = data[coinId]?.usd;
  if (!price) return null;
  return {
    source: "coingecko",
    coin_id: coinId,
    price: parseFloat(price),
    latency_ms: Date.now() - start
  };
}
__name(fetchCoinGeckoPrice, "fetchCoinGeckoPrice");
async function fetchCoinCapPrice(coinId) {
  const capId = COIN_TO_COINCAP[coinId] || coinId;
  const start = Date.now();
  const resp = await fetchRetry(
    `https://api.coincap.io/v2/assets/${capId}`,
    {},
    2,
    CONFIG.TIMEOUT_COINCAP
  );
  if (!resp) return null;
  const data = await resp.json();
  const price = data?.data?.priceUsd;
  if (!price) return null;
  return {
    source: "coincap",
    coin_id: coinId,
    price: parseFloat(price),
    latency_ms: Date.now() - start
  };
}
__name(fetchCoinCapPrice, "fetchCoinCapPrice");
async function fetchPriceWithConsensus(coinId, symbol) {
  const results = [];
  if (PYTH_SUPPORTED.has(symbol)) {
    const pythResult = await fetchPythPrice(symbol);
    if (pythResult) {
      results.push(pythResult);
      log("info", "price_source_available", { source: "pyth", coin: coinId });
    } else {
      log("warn", "pyth_price_failed", { coin: coinId });
      degradationCounter.increment("pyth", "coingecko");
    }
  }
  const cgResult = await fetchCoinGeckoPrice(coinId);
  if (cgResult) {
    results.push(cgResult);
    log("info", "price_source_available", { source: "coingecko", coin: coinId });
  } else {
    log("warn", "coingecko_price_failed", { coin: coinId });
    degradationCounter.increment("coingecko", "coincap");
  }
  if (results.length === 0) {
    const ccResult = await fetchCoinCapPrice(coinId);
    if (ccResult) {
      results.push(ccResult);
      log("info", "price_source_available", { source: "coincap", coin: coinId });
    }
  }
  if (results.length === 0) {
    log("error", "all_price_sources_failed", { coin: coinId });
    return null;
  }
  return validatePriceConsensus(results);
}
__name(fetchPriceWithConsensus, "fetchPriceWithConsensus");
async function cachedResp(request, cacheKey, ttl, fetcher) {
  try {
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) {
      log("info", "cache_hit", { key: cacheKey });
      return hit;
    }
    const data = await fetcher();
    if (!data) return null;
    const resp = Response.json(data);
    resp.headers.set("Cache-Control", `public, max-age=${ttl}`);
    const cacheUrl = new URL(request.url);
    cacheUrl.search = `cache_key=${cacheKey}`;
    const cacheReq = new Request(cacheUrl.toString(), request);
    try {
      await cache.put(cacheReq, resp.clone());
    } catch (e) {
      log("warn", "cache_write_failed", { key: cacheKey, error: e.message });
    }
    log("info", "cache_miss", { key: cacheKey });
    return resp;
  } catch (e) {
    log("error", "cache_layer_crash", { key: cacheKey, error: e.message });
    const data = await fetcher();
    if (!data) return null;
    return Response.json(data);
  }
}
__name(cachedResp, "cachedResp");
async function checkUpstreamHealth() {
  const results = {};
  const pythStart = Date.now();
  try {
    const pythResp = await fetchPythPrice("BTCUSDT");
    results.pyth = {
      status: pythResp ? "healthy" : "unhealthy",
      latency_ms: Date.now() - pythStart
    };
  } catch (e) {
    results.pyth = { status: "error", latency_ms: Date.now() - pythStart, error: e.message };
  }
  const cgStart = Date.now();
  try {
    const cgResp = await fetchCoinGeckoPrice("bitcoin");
    results.coingecko = {
      status: cgResp ? "healthy" : "unhealthy",
      latency_ms: Date.now() - cgStart
    };
  } catch (e) {
    results.coingecko = { status: "error", latency_ms: Date.now() - cgStart, error: e.message };
  }
  const ccStart = Date.now();
  try {
    const ccResp = await fetchCoinCapPrice("bitcoin");
    results.coincap = {
      status: ccResp ? "healthy" : "unhealthy",
      latency_ms: Date.now() - ccStart
    };
  } catch (e) {
    results.coincap = { status: "error", latency_ms: Date.now() - ccStart, error: e.message };
  }
  return results;
}
__name(checkUpstreamHealth, "checkUpstreamHealth");
var STATIC_COINS = {
  "Bitcoin (BTC)": "bitcoin",
  "Ethereum (ETH)": "ethereum",
  "Solana (SOL)": "solana"
};

// ==================== Etherscan 代理路由 ====================
async function handleEtherscanProxy(request, env) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'gasoracle';
  const apiKey = env.ETHERSCAN_API_KEY;

  if (!apiKey) {
    log("error", "etherscan_no_api_key");
    return errRes(500, "ETHERSCAN_NOT_CONFIGURED");
  }

  let upstreamUrl;
  switch (action) {
    case 'gasoracle':
      upstreamUrl = `https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${apiKey}`;
      break;
    default:
      return errRes(400, `UNKNOWN_ETHERSCAN_ACTION: ${action}`);
  }

  const start = Date.now();
  const resp = await fetchRetry(upstreamUrl, {}, 2, CONFIG.TIMEOUT_DEFAULT);
  if (!resp) {
    log("error", "etherscan_upstream_failed", { action });
    return errRes(502, "ETHERSCAN_UPSTREAM_FAILED");
  }

  const data = await resp.json();
  log("info", "etherscan_proxy_success", { action, latency_ms: Date.now() - start });

  return Response.json(data, {
    headers: {
      "Cache-Control": "public, max-age=15",
      "CDN-Cache-Control": "public, max-age=15"
    }
  });
}
__name(handleEtherscanProxy, "handleEtherscanProxy");
// ==================== Etherscan 代理路由结束 ====================

var worker_default = {
  async fetch(request, env, ctx) {
    const startTs = Date.now();
    let response;
    try {
      response = await handleRequest(request, env, ctx);
    } catch (e) {
      log("error", "worker_panic", {
        error: e.message,
        stack: e.stack,
        total_latency_ms: Date.now() - startTs
      });
      response = errRes(500, "INTERNAL_ERROR");
    }
    const headers = corsHdrs(request);
    const finalHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(([k, v]) => finalHeaders.set(k, v));
    finalHeaders.set("X-Powered-By", "CogCloud Data Worker v6.2");
    finalHeaders.set("X-Response-Time-Ms", String(Date.now() - startTs));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: finalHeaders
    });
  }
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // ===== 调试：返回 path 信息，排查路由问题 =====
  if (path.includes("etherscan") || path === "/debug") {
    return Response.json({
      debug: true,
      path: path,
      full_url: request.url,
      has_etherscan_key: !!env.ETHERSCAN_API_KEY,
      etherscan_key_prefix: env.ETHERSCAN_API_KEY ? env.ETHERSCAN_API_KEY.substring(0, 8) + "..." : "MISSING",
      timestamp: new Date().toISOString()
    }, {
      headers: corsHdrs(request)
    });
  }
  // ===== 调试结束 =====

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHdrs(request) });
  }

  if (!limiter.check(ip)) {
    log("warn", "rate_limited", { ip });
    return errRes(429, "RATE_LIMITED");
  }

  if (path === "/health") {
    const upstream = await checkUpstreamHealth();
    const degradationStats = degradationCounter.getStats();
    const overallStatus = Object.values(upstream).some((s) => s.status === "healthy") ? "ok" : "degraded";
    return Response.json({
      status: overallStatus,
      ts: new Date().toISOString(),
      uptime_seconds: Math.floor(performance.now() / 1e3),
      upstream,
      degradation_stats: degradationStats
    });
  }

  if (path === "/api/ohlc") {
    const coinId = url.searchParams.get("coin_id") || "bitcoin";
    const days = parseInt(url.searchParams.get("days") || "30");
    const period = url.searchParams.get("period") || "1d";
    const limit = parseInt(url.searchParams.get("limit") || "500");
    const cacheKey = `ohlc:${coinId}:${period}:${limit}`;
    let r = await cachedResp(request, cacheKey, CONFIG.CACHE_TTL, async () => {
      const cgResult = await fetchCoinGeckoOHLC(coinId, days);
      if (cgResult) {
        log("info", "ohlc_source", { source: "coingecko", coin: coinId });
        return cgResult;
      }
      log("warn", "coingecko_ohlc_failed", { coin: coinId });
      degradationCounter.increment("coingecko_ohlc", "fallback");
      log("error", "all_ohlc_sources_failed", { coin: coinId });
      return null;
    });
    if (!r) r = errRes(502, "OHLC_FETCH_FAILED");
    return r;
  }

  if (path === "/api/price") {
    const coinId = url.searchParams.get("coin_id") || "bitcoin";
    const symbol = `${coinId.split("-")[0].toUpperCase()}USDT`;
    const cacheKey = `price:${coinId}`;
    let r = await cachedResp(request, cacheKey, CONFIG.PRICE_CACHE_TTL, async () => {
      const result = await fetchPriceWithConsensus(coinId, symbol);
      if (result) {
        return {
          coin_id: coinId,
          symbol,
          price: result.price,
          source: result.source,
          consensus: result.consensus,
          all_sources: result.all_sources,
          deviation: result.deviation || 0
        };
      }
      return null;
    });
    if (!r) r = errRes(502, "PRICE_FETCH_FAILED");
    return r;
  }

  if (path === "/api/prices") {
    const coins = (url.searchParams.get("coins") || "bitcoin,ethereum").split(",").slice(0, 20);
    const cacheKey = `prices:${coins.sort().join(",")}`;
    let r = await cachedResp(request, cacheKey, CONFIG.PRICE_CACHE_TTL, async () => {
      const results = await Promise.all(
        coins.map(async (c) => {
          const sym = `${c.split("-")[0].toUpperCase()}USDT`;
          if (PYTH_SUPPORTED.has(sym)) {
            const pythResult = await fetchPythPrice(sym);
            if (pythResult) return [c, pythResult.price];
          }
          const cgResult = await fetchCoinGeckoPrice(c);
          if (cgResult) return [c, cgResult.price];
          const ccResult = await fetchCoinCapPrice(c);
          if (ccResult) return [c, ccResult.price];
          return [c, null];
        })
      );
      const prices = {};
      results.forEach(([coin, price]) => {
        if (price !== null) prices[coin] = price;
      });
      if (Object.keys(prices).length > 0) {
        return {
          source: "multi",
          prices,
          fetched_count: Object.keys(prices).length,
          total_requested: coins.length
        };
      }
      log("error", "all_batch_prices_failed", { coins: coins.join(",") });
      return null;
    });
    if (!r) r = errRes(502, "PRICES_FETCH_FAILED");
    return r;
  }

  if (path === "/api/coins") {
    const cacheKey = "top_coins";
    let r = await cachedResp(request, cacheKey, 3600, async () => {
      const resp = await fetchRetry(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false",
        {},
        2,
        CONFIG.TIMEOUT_COINGECKO
      );
      if (resp) {
        const data = await resp.json();
        if (Array.isArray(data)) {
          const coins = {};
          data.forEach((c) => {
            coins[`${c.name} (${c.symbol.toUpperCase()})`] = c.id;
          });
          return { source: "coingecko", count: Object.keys(coins).length, coins };
        }
      }
      log("warn", "coins_list_failed", {});
      return null;
    });
    if (!r) {
      r = Response.json({ source: "static_fallback", count: 3, coins: STATIC_COINS });
    }
    return r;
  }

  log("warn", "route_not_found", { path, ip });
  return errRes(404, "NOT_FOUND");
}
__name(handleRequest, "handleRequest");
export {
  worker_default as default
};
