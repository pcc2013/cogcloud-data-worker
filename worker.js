// cogcloud-data-worker.js
const CONFIG = {
  CACHE_TTL: 120,           // 2分钟
  PRICE_CACHE_TTL: 30,      // 30秒
  MAX_RETRIES: 3,
  TIMEOUT: 8000,
  RATE_LIMIT: 100,          // 每分钟/ip
  AUTH_TOKEN: null,    // 从环境变量注入
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

// CoinGecko id -> CoinCap id 映射（大部分一致，少数需要单独映射）
const COIN_TO_COINCAP = {
  "bitcoin": "bitcoin", "ethereum": "ethereum", "solana": "solana",
  "binancecoin": "binance-coin", "ripple": "xrp", "cardano": "cardano",
  "dogecoin": "dogecoin", "avalanche-2": "avalanche", "polkadot": "polkadot",
  "matic-network": "polygon", "chainlink": "chainlink", "uniswap": "uniswap",
  "litecoin": "litecoin", "shiba-inu": "shiba-inu", "tron": "tron",
  "stellar": "stellar", "hedera-hashgraph": "hedera-hashgraph", "ethereum-classic": "ethereum-classic",
  "near": "near-protocol", "cosmos": "cosmos", "filecoin": "filecoin",
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
// 带重试 + 日志的 fetch
// 返回 null 时，调用方可以从日志里看到具体失败原因（状态码/异常信息）
// ============================================================================
async function fetchWithRetry(url, opts = {}, retries = CONFIG.MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetchWithTimeout(url, opts);
      if (resp.status === 429) {
        log('warn', 'rate_limited_upstream', { url, attempt: i + 1 });
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      if (resp.status === 451) {
        log('warn', 'geo_blocked', { url });
        return null;
      }
      if (!resp.ok) {
        log('warn', 'fetch_failed', { url, status: resp.status, attempt: i + 1 });
        continue;
      }
      return resp;
    } catch (e) {
      log('warn', 'fetch_error', { url, error: e.message, attempt: i + 1 });
    }
  }
  return null;
}

// ============================================================================
// 数据获取（OHLC）
// ============================================================================
async function fetchBinance(symbol, interval, limit) {
  const resp = await fetchWithRetry(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  if (!resp) return null;
  const data = await resp.json();
  return {
    source: 'binance',
    symbol,
    interval,
    data: data.map(d => ({
      timestamp: d[0],
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    }))
  };
}

async function fetchCoinGecko(coinId, days) {
  const resp = await fetchWithRetry(
    `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`
  );
  if (!resp) return null;
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return {
    source: 'coingecko',
    coin_id: coinId,
    days,
    data: data.map(d => ({
      timestamp: d[0],
      open: d[1],
      high: d[2],
      low: d[3],
      close: d[4],
      volume: 0,
    }))
  };
}

// ============================================================================
// 实时价格获取（三级降级：Binance -> CoinGecko -> CoinCap）
// ============================================================================
async function fetchBinancePrice(symbol) {
  const resp = await fetchWithRetry(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {}, 2);
  if (!resp) return null;
  const data = await resp.json();
  if (!data || !data.price) return null;
  return { source: 'binance', symbol, price: parseFloat(data.price) };
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
  if (cached) {
    log('info', 'cache_hit', { key: cacheKey });
    return cached;
  }

  const data = await fetcher();
  if (!data) return null;

  const response = Response.json(data);
  response.headers.set('Cache-Control', `public, max-age=${ttl}`);
  // 用专用 cache key 存储，避免 URL 参数差异导致缓存未命中
  const cacheUrl = new URL(request.url);
  cacheUrl.search = `cache_key=${cacheKey}`;
  const cacheReq = new Request(cacheUrl.toString(), request);
  const ctx = { waitUntil: (p) => p };
  ctx.waitUntil(cache.put(cacheReq, response.clone()));
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

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // 认证
    const auth = url.searchParams.get('token') || request.headers.get('Authorization')?.replace('Bearer ', '');
    if (env.AUTH_TOKEN && auth !== env.AUTH_TOKEN) {
      log('warn', 'auth_failed', { ip });
      return errorResponse(401, 'UNAUTHORIZED');
    }

    // 限流
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
      const interval = INTERVAL_MAP[period] || '1h';
      const symbol = COIN_TO_BINANCE[coinId] || `${coinId.split('-')[0].toUpperCase()}USDT`;

      const cacheKey = `ohlc:${coinId}:${period}:${limit}`;

      response = await cachedResponse(request, cacheKey, CONFIG.CACHE_TTL, async () => {
        // Binance 优先
        const binanceResult = await fetchBinance(symbol, interval, limit);
        if (binanceResult) return binanceResult;
        log('warn', 'binance_ohlc_failed', { coin: coinId });
        // CoinGecko 降级
        const cgResult = await fetchCoinGecko(coinId, days);
        if (cgResult) return cgResult;
        log('error', 'all_ohlc_sources_failed', { coin: coinId });
        return null;
      });

      if (!response) {
        response = errorResponse(502, 'ALL_SOURCES_FAILED');
      }
    }

    // ─── 实时价格（三级降级） ───
    else if (path === '/api/price') {
      const coinId = url.searchParams.get('coin_id') || 'bitcoin';
      const symbol = COIN_TO_BINANCE[coinId] || `${coinId.split('-')[0].toUpperCase()}USDT`;
      const cacheKey = `price:${coinId}`;

      response = await cachedResponse(request, cacheKey, CONFIG.PRICE_CACHE_TTL, async () => {
        // 1. Binance
        const b = await fetchBinancePrice(symbol);
        if (b) { log('info', 'price_source_used', { source: 'binance', coin: coinId }); return b; }
        log('warn', 'binance_price_failed', { coin: coinId });

        // 2. CoinGecko 降级
        const cg = await fetchCoinGeckoPrice(coinId);
        if (cg) { log('info', 'price_source_used', { source: 'coingecko', coin: coinId }); return cg; }
        log('warn', 'coingecko_price_failed', { coin: coinId });

        // 3. CoinCap 兜底
        const cc = await fetchCoinCapPrice(coinId);
        if (cc) { log('info', 'price_source_used', { source: 'coincap', coin: coinId }); return cc; }
        log('error', 'all_price_sources_failed', { coin: coinId });

        return null;
      });

      if (!response) {
        response = errorResponse(502, 'PRICE_FETCH_FAILED');
      }
    }

    // ─── 批量价格 ───
    else if (path === '/api/prices') {
      const coins = (url.searchParams.get('coins') || 'bitcoin,ethereum').split(',').slice(0, 20);
      const symbols = coins.map(c => COIN_TO_BINANCE[c] || `${c.split('-')[0].toUpperCase()}USDT`);
      const cacheKey = `prices:${coins.sort().join(',')}`;

      response = await cachedResponse(request, cacheKey, CONFIG.PRICE_CACHE_TTL, async () => {
        const resp = await fetchWithRetry(
          `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`
        );
        if (resp) {
          const data = await resp.json();
          const result = {};
          coins.forEach(c => {
            const sym = COIN_TO_BINANCE[c];
            const item = data.find(d => d.symbol === sym);
            if (item) result[c] = parseFloat(item.price);
          });
          if (Object.keys(result).length > 0) {
            return { source: 'binance', prices: result };
          }
        }
        log('warn', 'binance_prices_failed', { coins });

        // 降级：逐个走 CoinGecko/CoinCap（并发）
        const fallbackResults = await Promise.all(
          coins.map(async c => {
            const cg = await fetchCoinGeckoPrice(c);
            if (cg) return [c, cg.price];
            const cc = await fetchCoinCapPrice(c);
            if (cc) return [c, cc.price];
            return [c, null];
          })
        );
        const result = {};
        fallbackResults.forEach(([c, p]) => { if (p !== null) result[c] = p; });
        if (Object.keys(result).length > 0) {
          return { source: 'mixed_fallback', prices: result };
        }
        log('error', 'all_prices_sources_failed', { coins });
        return null;
      });

      if (!response) {
        response = errorResponse(502, 'PRICES_FETCH_FAILED');
      }
    }

    // ─── 币种列表 ───
    else if (path === '/api/coins') {
      const cacheKey = 'top_coins';
      response = await cachedResponse(request, cacheKey, 3600, async () => {
        const resp = await fetchWithRetry(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false`
        );
        if (resp) {
          const data = await resp.json();
          const coins = {};
          data.forEach(c => { coins[`${c.name} (${c.symbol.toUpperCase()})`] = c.id; });
          return { source: 'coingecko', count: Object.keys(coins).length, coins };
        }
        log('error', 'coins_list_failed', {});
        return null;
      });

      if (!response) {
        response = Response.json({ coins: { "Bitcoin (BTC)": "bitcoin", "Ethereum (ETH)": "ethereum", "Solana (SOL)": "solana" } });
      }
    }

    // ─── 404 ───
    else {
      response = errorResponse(404, 'NOT_FOUND');
    }

    // 注入 CORS 头
    const finalHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(([k, v]) => finalHeaders.set(k, v));
    finalHeaders.set('X-Powered-By', 'CogCloud Data Worker');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: finalHeaders,
    });
  }
};
