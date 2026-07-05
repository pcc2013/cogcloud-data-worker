var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js — Pyth-only
var CONFIG = {
  CACHE_TTL: 120,
  PRICE_CACHE_TTL: 30,
  MAX_RETRIES: 3,
  TIMEOUT_DEFAULT: 8e3,
  TIMEOUT_PYTH: 2e3,
  RATE_LIMIT: 100,
  AUTH_TOKEN: null,
  CORS_ORIGINS: [
    "https://huggingface.co",
    "https://qisuanai.com",
    "https://chainsight.qisuanai.com"
  ]
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

var PYTH_NAME_TO_SYMBOL = {
  "bitcoin": "BTCUSDT", "ethereum": "ETHUSDT", "solana": "SOLUSDT",
  "binancecoin": "BNBUSDT", "ripple": "XRPUSDT", "cardano": "ADAUSDT",
  "dogecoin": "DOGEUSDT", "avalanche-2": "AVAXUSDT", "polkadot": "DOTUSDT",
  "matic-network": "MATICUSDT", "chainlink": "LINKUSDT", "uniswap": "UNIUSDT",
  "litecoin": "LTCUSDT", "shiba-inu": "SHIBUSDT", "tron": "TRXUSDT"
};

var STATIC_COINS = {
  "Bitcoin (BTC)": "bitcoin", "Ethereum (ETH)": "ethereum", "Solana (SOL)": "solana",
  "BNB (BNB)": "binancecoin", "XRP (XRP)": "ripple", "Cardano (ADA)": "cardano",
  "Dogecoin (DOGE)": "dogecoin", "Avalanche (AVAX)": "avalanche-2",
  "Polkadot (DOT)": "polkadot", "Polygon (MATIC)": "matic-network",
  "Chainlink (LINK)": "chainlink", "Uniswap (UNI)": "uniswap",
  "Litecoin (LTC)": "litecoin", "Shiba Inu (SHIB)": "shiba-inu", "TRON (TRX)": "tron"
};

var RateLimiter = class {
  static { __name(this, "RateLimiter"); }
  constructor(max, win) { this.max = max; this.window = win; this.store = new Map(); }
  check(ip) {
    var now = Date.now();
    var record = this.store.get(ip) || { count: 0, reset: now + this.window };
    if (now > record.reset) { record.count = 0; record.reset = now + this.window; }
    record.count++;
    this.store.set(ip, record);
    return record.count <= this.max;
  }
};
var limiter = new RateLimiter(CONFIG.RATE_LIMIT, 6e4);

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }));
}
__name(log, "log");

function errRes(code, detail) {
  return Response.json({ error: { code, detail, ts: new Date().toISOString() } }, { status: code });
}
__name(errRes, "errRes");

function corsHdrs(request) {
  var origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHdrs, "corsHdrs");

async function fetchTO(url, opts = {}, timeout = CONFIG.TIMEOUT_DEFAULT) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeout);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
__name(fetchTO, "fetchTO");

async function fetchRetry(url, opts = {}, retries = CONFIG.MAX_RETRIES, timeout = CONFIG.TIMEOUT_DEFAULT) {
  for (var i = 0; i < retries; i++) {
    try {
      var resp = await fetchTO(url, opts, timeout);
      if (resp.status === 429) { await new Promise(function(r) { setTimeout(r, 2000 * (i + 1)); }); continue; }
      if (resp.status === 451) { log("warn", "geo_blocked", { url }); return null; }
      if (!resp.ok) { log("warn", "fetch_failed", { url, status: resp.status, attempt: i + 1 }); continue; }
      return resp;
    } catch (e) { log("warn", "fetch_error", { url, error: e.message, attempt: i + 1 }); }
  }
  return null;
}
__name(fetchRetry, "fetchRetry");

async function fetchPythPrice(symbol) {
  var priceId = PYTH_PRICE_IDS[symbol];
  if (!priceId) return null;
  var resp = await fetchRetry("https://hermes.pyth.network/v2/updates/price/latest?ids[]=" + priceId, {}, 2, CONFIG.TIMEOUT_PYTH);
  if (!resp) return null;
  var data = await resp.json();
  var parsed = data && data.parsed && data.parsed[0] && data.parsed[0].price;
  if (!parsed) return null;
  return parseFloat(parsed.price) * Math.pow(10, parsed.expo);
}
__name(fetchPythPrice, "fetchPythPrice");

async function cachedResp(request, cacheKey, ttl, fetcher) {
  try {
    var cache = caches.default;
    var hit = await cache.match(request);
    if (hit) return hit;
    var data = await fetcher();
    if (!data) return null;
    var resp = Response.json(data);
    resp.headers.set("Cache-Control", "public, max-age=" + ttl);
    var cacheUrl = new URL(request.url);
    cacheUrl.search = "cache_key=" + cacheKey;
    try { await cache.put(new Request(cacheUrl.toString(), request), resp.clone()); } catch (e) {}
    return resp;
  } catch (e) {
    var data = await fetcher();
    if (!data) return null;
    return Response.json(data);
  }
}
__name(cachedResp, "cachedResp");

// ==================== 路由处理 ====================
var worker_default = {
  async fetch(request, env, ctx) {
    var startTs = Date.now();
    var response;
    try { response = await handleRequest(request, env, ctx); }
    catch (e) { response = errRes(500, "INTERNAL_ERROR"); }
    var headers = corsHdrs(request);
    var finalHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(function(kv) { finalHeaders.set(kv[0], kv[1]); });
    finalHeaders.set("X-Powered-By", "CogCloud Data Worker v9.0");
    finalHeaders.set("X-Response-Time-Ms", String(Date.now() - startTs));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: finalHeaders });
  }
};

async function handleRequest(request, env, ctx) {
  var url = new URL(request.url);
  var path = url.pathname;
  var ip = request.headers.get("CF-Connecting-IP") || "unknown";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHdrs(request) });
  if (!limiter.check(ip)) return errRes(429, "RATE_LIMITED");

  // ===== 健康检查 =====
  if (path === "/health") {
    var pythOk = false;
    try { var p = await fetchPythPrice("BTCUSDT"); pythOk = !!p; } catch(e) {}
    return Response.json({ status: pythOk ? "ok" : "degraded", ts: new Date().toISOString(), pyth: pythOk ? "healthy" : "unhealthy" });
  }

  // ===== Pyth 批量价格 =====
  if (path === "/api/prices") {
    var coins = (url.searchParams.get("coins") || "bitcoin,ethereum").split(",").slice(0, 20);
    var cacheKey = "prices:" + coins.slice().sort().join(",");
    var r = await cachedResp(request, cacheKey, CONFIG.PRICE_CACHE_TTL, async function() {
      var results = await Promise.all(coins.map(async function(c) {
        var sym = PYTH_NAME_TO_SYMBOL[c] || (c.split("-")[0].toUpperCase() + "USDT");
        if (PYTH_PRICE_IDS[sym]) {
          try { var price = await fetchPythPrice(sym); if (price) return [c, price]; } catch(e) {}
        }
        return [c, null];
      }));
      var prices = {};
      var count = 0;
      results.forEach(function(rr) { if (rr[1] !== null) { prices[rr[0]] = rr[1]; count++; } });
      if (count > 0) return { source: "pyth", prices: prices, fetched_count: count, total_requested: coins.length };
      return null;
    });
    if (!r) r = errRes(502, "PRICES_FETCH_FAILED");
    return r;
  }

  // ===== 代币列表（静态）=====
  if (path === "/api/coins") {
    return Response.json({ source: "static", count: Object.keys(STATIC_COINS).length, coins: STATIC_COINS });
  }

  // ===== Etherscan Gas =====
  if (path === "/api/gas") {
    var apiKey = env.ETHERSCAN_API_KEY || "";
    var r = await cachedResp(request, "gas", 15, async function() {
      var resp = await fetchRetry("https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=" + apiKey, {}, 2, 8000);
      if (!resp) return null;
      return await resp.json();
    });
    if (!r) r = errRes(502, "GAS_FAILED");
    return r;
  }

  // ===== Fear & Greed =====
  if (path === "/api/fng") {
    var r = await cachedResp(request, "fng", 3600, async function() {
      var resp = await fetchRetry("https://api.alternative.me/fng/?limit=1", {}, 2, 5000);
      if (!resp) return null;
      var data = await resp.json();
      return data.data ? data.data[0] : null;
    });
    if (!r) r = errRes(502, "FNG_FAILED");
    return r;
  }

  // ===== Hyperliquid 资金费率 =====
  if (path === "/api/funding-rate") {
    var r = await cachedResp(request, "funding", 30, async function() {
      var resp = await fetchRetry("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" })
      }, 2, 5000);
      if (!resp) return null;
      var data = await resp.json();
      var result = {};
      for (var i = 0; i < data[0].universe.length; i++) {
        var coin = data[0].universe[i].name;
        if (coin === "BTC" || coin === "ETH") {
          result[coin] = {
            funding_rate: (parseFloat(data[1][i].funding) * 100).toFixed(4) + "%",
            premium: data[1][i].premium,
            oracle_price: data[1][i].oraclePx,
            mark_price: data[1][i].markPx
          };
        }
      }
      return { funding: result, source: "hyperliquid" };
    });
    if (!r) r = errRes(502, "FUNDING_FAILED");
    return r;
  }

  // ===== DeFi TVL =====
  if (path === "/api/defi/tvl") {
    var r = await cachedResp(request, "defi:tvl", 120, async function() {
      var resp = await fetchRetry("https://api.llama.fi/v2/chains", {}, 2, 8000);
      if (!resp) return null;
      var chains = await resp.json();
      var total = 0;
      chains.forEach(function(c) { total += c.tvl || 0; });
      return { total_tvl: total, chain_count: chains.length, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_TVL_FAILED");
    return r;
  }

  // ===== DeFi DEX =====
  if (path === "/api/defi/dex") {
    var r = await cachedResp(request, "defi:dex", 300, async function() {
      var resp = await fetchRetry("https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true", {}, 2, 8000);
      if (!resp) return null;
      var data = await resp.json();
      return { total_24h: data.total24h || 0, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_DEX_FAILED");
    return r;
  }

  // ===== DeFi Protocols =====
  if (path === "/api/defi/protocols") {
    var r = await cachedResp(request, "defi:protocols", 300, async function() {
      var resp = await fetchRetry("https://api.llama.fi/protocols", {}, 2, 8000);
      if (!resp) return null;
      var data = await resp.json();
      return { top_protocol: data.length > 0 ? data[0].name : null, count: data.length, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_PROTOCOLS_FAILED");
    return r;
  }

  // ===== DeFi Stablecoins =====
  if (path === "/api/defi/stablecoins") {
    var r = await cachedResp(request, "defi:stablecoins", 300, async function() {
      var resp = await fetchRetry("https://stablecoins.llama.fi/stablecoins?includePrices=false", {}, 2, 8000);
      if (!resp) return null;
      var data = await resp.json();
      var total = 0;
      (data.peggedAssets || []).forEach(function(a) { total += (a.circulating && a.circulating.peggedUSD) || 0; });
      return { total_mcap: total, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_STABLECOINS_FAILED");
    return r;
  }

  // ===== GoPlus 安全 =====
  if (path === "/api/security") {
    var contract = url.searchParams.get("contract") || "0xdac17f958d2ee523a2206206994597c13d831ec7";
    var chain = url.searchParams.get("chain") || "1";
    var r = await cachedResp(request, "security:" + chain + ":" + contract, 300, async function() {
      var apiKey = env.GOPLUS_API_KEY || "";
      var headers = {};
      if (apiKey) headers["Authorization"] = apiKey;
      var resp = await fetchRetry("https://api.gopluslabs.io/api/v1/token_security/" + chain + "?contract_addresses=" + contract, { headers: headers }, 1, 8000);
      if (!resp) return null;
      return await resp.json();
    });
    if (!r) r = errRes(502, "SECURITY_FAILED");
    return r;
  }

  log("warn", "route_not_found", { path: path, ip: ip });
  return errRes(404, "NOT_FOUND");
}
__name(handleRequest, "handleRequest");

export { worker_default as default };
