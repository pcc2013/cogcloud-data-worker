// cogcloud-data-worker.js —
const CONFIG = {
  CACHE_TTL: 120,
  PRICE_CACHE_TTL: 30,
  MAX_RETRIES: 3,
  TIMEOUT: 8000,
  RATE_LIMIT: 100,
  AUTH_TOKEN: null,
  CORS_ORIGINS: ['https://huggingface.co', 'https://qisuanai.com', 'https://chainsight.qisuanai.com'],
};

// ============================================================================
// 完整币种映射
// ============================================================================
const COIN_TO_BINANCE = {
  "bitcoin": "BTCUSDT", "ethereum": "ETHUSDT", "solana": "SOLUSDT",
  "binancecoin": "BNBUSDT", "ripple": "XRPUSDT", "cardano": "ADAUSDT",
  "dogecoin": "DOGEUSDT", "avalanche-2": "AVAXUSDT", "polkadot": "DOTUSDT",
  "matic-network": "MATICUSDT", "chainlink": "LINKUSDT", "uniswap": "UNIUSDT",
  "litecoin": "LTCUSDT", "shiba-inu": "SHIBUSDT", "tron": "TRXUSDT",
  "stellar": "XLMUSDT", "hedera-hashgraph": "HBARUSDT", "ethereum-classic": "ETCUSDT",
  "near": "NEARUSDT", "cosmos": "ATOMUSDT", "filecoin": "FILUSDT",
  "aptos": "APTUSDT", "sui": "SUIUSDT", "optimism": "OPUSDT",
  "arbitrum": "ARBUSDT", "immutable-x": "IMXUSDT", "render-token": "RENDERUSDT",
  "the-graph": "GRTUSDT", "algorand": "ALGOUSDT", "theta-token": "THETAUSDT",
  "tezos": "XTZUSDT", "eos": "EOSUSDT", "flow": "FLOWUSDT",
  "maker": "MKRUSDT", "aave": "AAVEUSDT", "curve-dao-token": "CRVUSDT",
};

const COIN_TO_COINCAP = {
  "bitcoin": "bitcoin", "ethereum": "ethereum", "solana": "solana",
  "binancecoin": "binance-coin", "ripple": "xrp", "cardano": "cardano",
  "dogecoin": "dogecoin", "avalanche-2": "avalanche", "polkadot": "polkadot",
  "matic-network": "polygon", "chainlink": "chainlink", "uniswap": "uniswap",
  "litecoin": "litecoin", "shiba-inu": "shiba-inu", "tron": "tron",
  "stellar": "stellar", "hedera-hashgraph": "hedera-hashgraph", "ethereum-classic": "ethereum-classic",
  "near": "near-protocol", "cosmos": "cosmos", "filecoin": "filecoin",
};

// Pyth 价格 ID（按需扩展）
const PYTH_PRICE_IDS = {
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
  "TRXUSDT": "0x67aed5a24fdad045475e7195c98a98aea119c763f272d4523f5bac93a4f33c2b",
};

const INTERVAL_MAP = {"5min":"5m","30min":"30m","1h":"1h","6h":"6h","1d":"1d"};

// ============================================================================
// 限流器
// ============================================================================
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.max = maxRequests;
    this.window = windowMs;
    this.store = new Map();
  }
  check(ip) {
    const now = Date.now();
    const record = this.store.get(ip) || { count: 0, reset: now + this.window };
    if (now > record.reset) { record.count = 0; record.reset = now + this.window; }
    record.count++;
    this.store.set(ip, record);
    return record.count <= this.max;
  }
}
const limiter = new RateLimiter(CONFIG.RATE_LIMIT, 60000);

// ============================================================================
// 结构化日志
// ============================================================================
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }));
}

// ============================================================================
// 错误响应
// ============================================================================
function errorResponse(code, detail) {
  return Response.json({ error: { code, detail, ts: new Date().toISOString() } }, { status: code });
}

// ============================================================================
// CORS 处理
// ============================================================================
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = CONFIG.CORS_ORIGINS.includes(origin) ? origin : CONFIG.CORS_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ============================================================================
// 带超时的 fetch
// ============================================================================
async function fetchWithTimeout(url, opts = {}, timeout = CONFIG.TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 带重试的 fetch
// ============================================================================
async function fetchWithRetry(url, opts = {}, retries = CONFIG.MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetchWithTimeout(url, opts);
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
      if (resp.status === 451) { log('warn', 'geo_blocked', { url }); return null; }
      if (!resp.ok) { log('warn', 'fetch_failed', { url, status: resp.status, attempt: i + 1 }); continue; }
      return resp;
    } catch (e) {
      log('warn', 'fetch_error', { url, error: e.message, attempt: i + 1 });
    }
  }
  return null;
}

// ============================================================================
// 数据获取 — OHLC
// ============================================================================
async function fetchCoinGecko(coinId, days) {
  const resp = await fetchWithRetry(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`);
  if (!resp) return null;
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return {
    source: 'coingecko',
    coin_id: coinId,
    days,
    data: data.map(d => ({ timestamp: d[0], open: d[1], high: d[2], low: d[3], close: d[4], volume: 0 }))
  };
}

// ============================================================================
// 实时价格 — 三级降级：Pyth → CoinGecko → CoinCap
// ============================================================================
async function fetchPythPrice(symbol) {
  const priceId = PYTH_PRICE_IDS[symbol];
  if (!priceId) return null;
  const resp = await fetchWithRetry(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${priceId}`);
  if (!resp) return null;
  const data = await resp.json();
  const parsed = data?.parsed?.[0]?.price;
  if (!parsed) return null;
  return {
    source: 'pyth',
    symbol,
    price: parseFloat(parsed.price) * Math.pow(10, parsed.expo),
  };
}

async function fetchCoinGeckoPrice(coinId) {
  const resp = await fetchWithRetry(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, {}, 2);
  if (!resp) return null;
  const data = await resp.json();
  const price = data[coinId]?.usd;
  if (!price) return null;
  return { source: 'coingecko', coin_id: coinId, price: parseFloat(price) };
}

async function fetchCoinCapPrice(coinId) {
  const capId = COIN_TO_COINCAP[coinId] || coinId;
  const resp = await fetchWithRetry(`https://api.coincap.io/v2/assets/${capId}`, {}, 2);
  if (!resp) return null;
  const data = await resp.json();
  const price = data?.data?.priceUsd;
  if (!price) return null;
  return { source: 'coincap', coin_id: coinId, price: parseFloat(price) };
}

// ============================================================================
// 缓存辅助
// ============================================================================
async function cachedResponse(request, cacheKey, ttl, fetcher) {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) { log('info', 'cache_hit', { key: cacheKey }); return cached; }
  const data = await fetcher();
  if (!data) return null;
  const response = Response.json(data);
  response.headers.set('Cache-Control', `public, max-age=${ttl}`);
  const cacheUrl = new URL(request.url);
  cacheUrl.search = `cache_key=${cacheKey}`;
  ctx.waitUntil(cache.put(new Request(cacheUrl.toString(), request), response.clone()));
  log('info', 'cache_miss', { key: cacheKey });
  return response;
}

// ============================================================================
// 主路由
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = corsHeaders(request);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const auth = url.searchParams.get('token') || request.headers.get('Authorization')?.replace('Bearer ', '');
    if (env.AUTH_TOKEN && auth !== env.AUTH_TOKEN) {
      log('warn', 'auth_failed', { ip });
      return errorResponse(401, 'UNAUTHORIZED');
    }

    if (!limiter.check(ip)) {
      log('warn', 'rate_limited', { ip });
      return errorResponse(429, 'RATE_LIMITED');
    }

    let response;

    // ─── 健康检查 ───
    if (path === '/health') {
      response = Response.json({ status: 'ok', ts: new Date().toISOString() });
    }

    // ─── OHLC 数据 ───
    else if (path === '/api/ohlc') {
      const coinId = url.searchParams.get('coin_id') || 'bitcoin';
      const period = url.searchParams.get('period') || '1d';
      const days = parseInt(url.searchParams.get('days') || '30');
      const limit = parseInt(url.searchParams.get('limit') || '500');
      const cacheKey = `ohlc:${coinId}:${period}:${limit}`;

      response = await cachedResponse(request, cacheKey, CONFIG.CACHE_TTL, async () => {
        const cgResult = await fetchCoinGecko(coinId, days);
        if (cgResult) return cgResult;
        log('error', 'ohlc_failed', { coin: coinId });
        return null;
      });

      if (!response) response = errorResponse(502, 'ALL_SOURCES_FAILED');
    }

    // ─── 实时价格（Pyth → CoinGecko → CoinCap） ───
    else if (path === '/api/price') {
      const coinId = url.searchParams.get('coin_id') || 'bitcoin';
      const symbol = COIN_TO_BINANCE[coinId] || `${coinId.split('-')[0].toUpperCase()}USDT`;
      const cacheKey = `price:${coinId}`;

      response = await cachedResponse(request, cacheKey, CONFIG.PRICE_CACHE_TTL, async () => {
        const pyth = await fetchPythPrice(symbol);
        if (pyth) { log('info', 'price_source', { source: 'pyth', coin: coinId }); return pyth; }
        const cg = await fetchCoinGeckoPrice(coinId);
        if (cg) { log('info', 'price_source', { source: 'coingecko', coin: coinId }); return cg; }
        const cc = await fetchCoinCapPrice(coinId);
        if (cc) { log('info', 'price_source', { source: 'coincap', coin: coinId }); return cc; }
        log('error', 'all_price_sources_failed', { coin: coinId });
        return null;
      });

      if (!response) response = errorResponse(502, 'PRICE_FETCH_FAILED');
    }

    // ─── 批量价格 ───
    else if (path === '/api/prices') {
      const coins = (url.searchParams.get('coins') || 'bitcoin,ethereum').split(',').slice(0, 20);
      const cacheKey = `prices:${coins.sort().join(',')}`;

      response = await cachedResponse(request, cacheKey, CONFIG.PRICE_CACHE_TTL, async () => {
        const results = await Promise.all(coins.map(async c => {
          const sym = COIN_TO_BINANCE[c] || `${c.split('-')[0].toUpperCase()}USDT`;
          const pyth = await fetchPythPrice(sym);
          if (pyth) return [c, pyth.price];
          const cg = await fetchCoinGeckoPrice(c);
          if (cg) return [c, cg.price];
          const cc = await fetchCoinCapPrice(c);
          if (cc) return [c, cc.price];
          return [c, null];
        }));
        const prices = {};
        results.forEach(([c, p]) => { if (p !== null) prices[c] = p; });
        if (Object.keys(prices).length > 0) return { source: 'pyth_primary', prices };
        log('error', 'all_prices_failed', { coins });
        return null;
      });

      if (!response) response = errorResponse(502, 'PRICES_FETCH_FAILED');
    }

    // ─── 币种列表 ───
    else if (path === '/api/coins') {
      response = await cachedResponse(request, 'top_coins', 3600, async () => {
        const resp = await fetchWithRetry(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false`);
        if (resp) {
          const data = await resp.json();
          const coins = {};
          data.forEach(c => { coins[`${c.name} (${c.symbol.toUpperCase()})`] = c.id; });
          return { source: 'coingecko', count: Object.keys(coins).length, coins };
        }
        return null;
      });
      if (!response) response = Response.json({ coins: { "Bitcoin (BTC)": "bitcoin", "Ethereum (ETH)": "ethereum", "Solana (SOL)": "solana" } });
    }

    // ─── 404 ───
    else {
      response = errorResponse(404, 'NOT_FOUND');
    }

    const finalHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(([k, v]) => finalHeaders.set(k, v));
    finalHeaders.set('X-Powered-By', 'CogCloud Data Worker');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: finalHeaders });
  }
};
