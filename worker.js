var CONFIG = {
  CACHE_TTL: 120,
  PRICE_CACHE_TTL: 30,
  MAX_RETRIES: 3,
  TIMEOUT_DEFAULT: 8e3,
  TIMEOUT_PYTH: 2e3,
  RATE_LIMIT: 100,
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

function log(level, message, extra) {
  extra = extra || {};
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: level, message: message, ...extra }));
}

function errRes(code, detail) {
  return Response.json({ error: { code: code, detail: detail, ts: new Date().toISOString() } }, { status: code });
}

function corsHdrs(request) {
  var origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

async function fetchTO(url, opts, timeout) {
  opts = opts || {};
  timeout = timeout || CONFIG.TIMEOUT_DEFAULT;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeout);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function fetchRetry(url, opts, retries, timeout) {
  opts = opts || {};
  retries = retries || CONFIG.MAX_RETRIES;
  timeout = timeout || CONFIG.TIMEOUT_DEFAULT;
  for (var i = 0; i < retries; i++) {
    try {
      var resp = await fetchTO(url, opts, timeout);
      if (resp.status === 429) { await new Promise(function(r) { setTimeout(r, 2000 * (i + 1)); }); continue; }
      if (resp.status === 451) return null;
      if (!resp.ok) continue;
      return resp;
    } catch (e) {}
  }
  return null;
}

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

var AGENT_MODE = {
  NORMAL: 'normal',
  CAUTIOUS: 'cautious',
  SURVIVAL: 'survival',
  DORMANT: 'dormant',
  DEAD: 'dead'
};

var RISK_MATRIX = {
  normal:   { maxPosition: 0.3, maxDailyLoss: 0.05, maxDrawdown: 0.4, leverage: 3 },
  cautious: { maxPosition: 0.15, maxDailyLoss: 0.03, maxDrawdown: 0.3, leverage: 1 },
  survival: { maxPosition: 0.05, maxDailyLoss: 0.01, maxDrawdown: 0.2, leverage: 0 },
  dormant:  { maxPosition: 0,    maxDailyLoss: 0,    maxDrawdown: 0.15, leverage: 0 },
  dead:     { maxPosition: 0,    maxDailyLoss: 0,    maxDrawdown: 0.6, leverage: 0 }
};

function getAgentMode(equity, initialCapital) {
  var ratio = equity / initialCapital;
  if (ratio >= 0.9) return AGENT_MODE.NORMAL;
  if (ratio >= 0.8) return AGENT_MODE.CAUTIOUS;
  if (ratio >= 0.7) return AGENT_MODE.SURVIVAL;
  if (ratio >= 0.6) return AGENT_MODE.DORMANT;
  return AGENT_MODE.DEAD;
}

function getMaxPosition(equity, mode) {
  var risk = RISK_MATRIX[mode] || RISK_MATRIX.dead;
  return equity * risk.maxPosition;
}

function calcTrendScore(prices) {
  if (!prices || prices.length < 20) return 0.5;
  var s5 = prices.slice(-5).reduce(function(a, b) { return a + b; }, 0) / 5;
  var s20 = prices.slice(-20).reduce(function(a, b) { return a + b; }, 0) / 20;
  return s5 > s20 * 1.02 ? 1 : s5 < s20 * 0.98 ? 0 : 0.5;
}

function calcMomentumScore(prices) {
  if (!prices || prices.length < 10) return 0.5;
  var r3 = prices.slice(-3).reduce(function(a, b) { return a + b; }, 0) / 3;
  var r7 = prices.slice(-10, -3).reduce(function(a, b) { return a + b; }, 0) / 7;
  var m = (r3 - r7) / r7;
  return Math.min(1, Math.max(0, (m + 0.05) / 0.1));
}

function calcVolScore(prices) {
  if (!prices || prices.length < 20) return 0.5;
  var returns = [];
  for (var i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i-1]) / prices[i-1]);
  }
  var avg = returns.reduce(function(a, b) { return a + b; }, 0) / returns.length;
  var varx = returns.reduce(function(s, r) { return s + Math.pow(r - avg, 2); }, 0) / returns.length;
  var vol = Math.sqrt(varx);
  return Math.min(1, Math.max(0, 1 - vol / 0.05));
}

function generateSignal(prices, aiConfidence) {
  aiConfidence = aiConfidence || 50;
  var factors = {
    trend:     calcTrendScore(prices),
    momentum:  calcMomentumScore(prices),
    volatility: calcVolScore(prices),
    ai:        aiConfidence / 100
  };
  var weights = { trend: 0.30, momentum: 0.25, volatility: 0.15, ai: 0.30 };
  var score = 0;
  Object.keys(factors).forEach(function(k) { score += factors[k] * weights[k]; });
  return {
    signal: score > 0.65 ? 'buy' : score < 0.35 ? 'sell' : 'hold',
    strength: parseFloat(score.toFixed(3)),
    factors: factors
  };
}

function getStopLoss(entryPrice, direction, mode) {
  var slPct = mode === AGENT_MODE.NORMAL ? 0.05 : mode === AGENT_MODE.CAUTIOUS ? 0.03 : 0.02;
  return direction === 'long' ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct);
}

var SANTI_DARK_FOREST = { active: false, threatLevel: 0, detectedAt: 0, silenceUntil: 0 };
var SANTI_SUSPICION_CHAIN = 0;
var SANTI_SOPHON_FAILS = 0;

function santiCheckTrade(vitalSigns) {
  if (SANTI_DARK_FOREST.threatLevel >= 70) {
    return { allowed: false, reason: 'DARK_FOREST_SILENCE threat ' + SANTI_DARK_FOREST.threatLevel + '/100' };
  }
  if (SANTI_SUSPICION_CHAIN >= 4) {
    return { allowed: false, reason: 'SUSPICION_CHAIN_LOCKED depth ' + SANTI_SUSPICION_CHAIN + '/5' };
  }
  if (SANTI_SOPHON_FAILS >= 5) {
    return { allowed: false, reason: 'SOPHON_BLOCKADE fails ' + SANTI_SOPHON_FAILS };
  }
  return { allowed: true };
}

function santiScanDarkForest(trades, orderbook) {
  var threats = 0;
  var now = Date.now();
  var burst = (trades || []).filter(function(t) { return now - (t.time || 0) < 1000 && Math.abs(t.size || 0) > 100000; });
  if (burst.length > 5) threats += 30;
  if ((orderbook || {}).spread > 0.05) threats += 20;
  if ((orderbook || {}).stop_hits > 3) threats += 40;
  SANTI_DARK_FOREST.threatLevel = Math.min(100, SANTI_DARK_FOREST.threatLevel + threats);
  if (SANTI_DARK_FOREST.threatLevel >= 70) SANTI_DARK_FOREST.active = true;
  return SANTI_DARK_FOREST;
}

function santiAdvanceSuspicion(priceAction, confidence) {
  if (priceAction === 'up' && confidence < 0.4) SANTI_SUSPICION_CHAIN = Math.min(5, SANTI_SUSPICION_CHAIN + 1);
  else if (confidence < 0.3) SANTI_SUSPICION_CHAIN = Math.min(5, SANTI_SUSPICION_CHAIN + 1);
  else if (priceAction === 'confirmed' && confidence > 0.7) SANTI_SUSPICION_CHAIN = Math.max(0, SANTI_SUSPICION_CHAIN - 1);
  return SANTI_SUSPICION_CHAIN;
}

function santiCheckSophon(predictions) {
  if (!predictions || predictions.length < 10) return false;
  var correct = predictions.filter(function(p) { return p.correct; }).length;
  var accuracy = correct / predictions.length;
  if (accuracy < 0.3) SANTI_SOPHON_FAILS++;
  else SANTI_SOPHON_FAILS = 0;
  return accuracy < 0.3;
}

function santiReset() {
  SANTI_DARK_FOREST = { active: false, threatLevel: 0, detectedAt: 0, silenceUntil: 0 };
  SANTI_SUSPICION_CHAIN = 0;
  SANTI_SOPHON_FAILS = 0;
}

function santiGetStatus() {
  var labels = ['TRUST','MILD_DOUBT','DEEP_DOUBT','CHAIN_FORMED','WARTIME','STRIKE_READY'];
  return {
    darkForest: SANTI_DARK_FOREST,
    suspicionChain: SANTI_SUSPICION_CHAIN,
    suspicionLabel: labels[SANTI_SUSPICION_CHAIN] || 'UNKNOWN',
    sophonFails: SANTI_SOPHON_FAILS,
    sophonActive: SANTI_SOPHON_FAILS >= 5
  };
}

async function getVitalSigns(kv) {
  var accountRaw = await kv.get("agent:account");
  var account = accountRaw ? JSON.parse(accountRaw) : { equity: 10000, initialCapital: 10000 };
  var positionsRaw = await kv.get("agent:positions");
  var positions = positionsRaw ? JSON.parse(positionsRaw) : [];
  var historyRaw = await kv.get("agent:orders");
  var history = historyRaw ? JSON.parse(historyRaw) : [];

  var equity = account.equity;
  var initialCapital = account.initialCapital;
  var mode = getAgentMode(equity, initialCapital);
  var risk = RISK_MATRIX[mode];
  var pnl = equity - initialCapital;
  var pnlPct = (pnl / initialCapital * 100).toFixed(1);

  var wins = history.filter(function(o) { return o.pnl > 0; }).length;
  var total = history.length || 1;
  var winRate = (wins / total * 100).toFixed(1);

  var drawdown = 1 - equity / initialCapital;
  var fearIndex = Math.min(100, Math.round(drawdown * 200));
  var greedIndex = Math.max(0, 100 - fearIndex);

  var dailyTrades = history.filter(function(o) { return o.time > Date.now() - 86400000; });
  var dailyLoss = dailyTrades.reduce(function(s, o) { return s + Math.min(0, o.pnl || 0); }, 0);

  var peakEquity = initialCapital;
  history.forEach(function(o) { if (o.equityAfter > peakEquity) peakEquity = o.equityAfter; });
  var maxDrawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity * 100).toFixed(1) : '0.0';

  return {
    equity: parseFloat(equity.toFixed(2)),
    initialCapital: initialCapital,
    pnl: parseFloat(pnl.toFixed(2)),
    pnlPct: pnlPct + '%',
    mode: mode,
    risk: risk,
    winRate: winRate + '%',
    fearIndex: fearIndex,
    greedIndex: greedIndex,
    dailyLoss: parseFloat(dailyLoss.toFixed(2)),
    maxDrawdown: maxDrawdown + '%',
    positions: positions,
    totalTrades: total,
    recentOrders: history.slice(-5),
    maxPositionAllowed: parseFloat(getMaxPosition(equity, mode).toFixed(2))
  };
}

function parseAgentCommand(text, vitalSigns, prices) {
  var lower = text.toLowerCase();
  var mode = vitalSigns.mode;

  if (lower.includes('feel') || lower.includes('status') || lower.includes('how are')) {
    var msgs = {};
    msgs[AGENT_MODE.NORMAL] = 'Feeling great. Greed mode active.';
    msgs[AGENT_MODE.CAUTIOUS] = 'A bit nervous. Reducing exposure.';
    msgs[AGENT_MODE.SURVIVAL] = 'Survival mode. Do not add risk.';
    msgs[AGENT_MODE.DORMANT] = 'Playing dead. Waiting for recovery.';
    msgs[AGENT_MODE.DEAD] = 'I am dead. Manual revival required.';
    return {
      type: 'status',
      message: 'Equity $' + vitalSigns.equity.toLocaleString() + ' (' + vitalSigns.pnlPct + '). ' +
               'Mode [' + mode + ']. WinRate ' + vitalSigns.winRate + '. FearIndex ' + vitalSigns.fearIndex + '. ' +
               (msgs[mode] || '')
    };
  }

  if (lower.includes('fear') || lower.includes('scared')) {
    return {
      type: 'status',
      message: 'FearIndex ' + vitalSigns.fearIndex + '/100. ' +
               (vitalSigns.fearIndex > 70 ? 'I am terrified.' : vitalSigns.fearIndex > 40 ? 'I am uneasy.' : 'I am calm.')
    };
  }

  if (mode === AGENT_MODE.DEAD) return { type: 'blocked', message: 'AGENT_DEAD. Equity below 60%. Manual revival required.' };
  if (mode === AGENT_MODE.DORMANT) return { type: 'blocked', message: 'AGENT_DORMANT. No trades for 24h.' };

  if (lower.includes('all in') || lower.includes('full position') || lower.includes('max bet')) {
    var maxPos = vitalSigns.maxPositionAllowed;
    return {
      type: 'blocked',
      message: (mode === AGENT_MODE.SURVIVAL ? 'SURVIVAL_BLOCK: ' : 'CAUTION_BLOCK: ') +
               'Max position $' + maxPos.toLocaleString() + '.'
    };
  }

  function extractSymbol(text) {
    if (text.includes('btc') || text.includes('bitcoin')) return 'BTC';
    if (text.includes('eth') || text.includes('ethereum')) return 'ETH';
    if (text.includes('sol') || text.includes('solana')) return 'SOL';
    return 'BTC';
  }

  var symbol = extractSymbol(lower);
  var currentPrice = (prices && prices[symbol.toLowerCase()]) || 0;

  if (lower.includes('long') || lower.includes('buy') || lower.includes('open long')) {
    var santiCheck = santiCheckTrade(vitalSigns);
    if (!santiCheck.allowed) {
      return { type: 'blocked', message: 'SANTI_BLOCK: ' + santiCheck.reason };
    }
    return {
      type: 'trade', action: 'long', symbol: symbol, currentPrice: currentPrice,
      maxSize: vitalSigns.maxPositionAllowed,
      message: 'LONG ' + symbol + ' @ $' + currentPrice.toLocaleString() + '. Max $' + vitalSigns.maxPositionAllowed.toLocaleString() + '.'
    };
  }

  if (lower.includes('short') || lower.includes('sell') || lower.includes('open short')) {
    var santiCheck2 = santiCheckTrade(vitalSigns);
    if (!santiCheck2.allowed) {
      return { type: 'blocked', message: 'SANTI_BLOCK: ' + santiCheck2.reason };
    }
    return {
      type: 'trade', action: 'short', symbol: symbol, currentPrice: currentPrice,
      maxSize: vitalSigns.maxPositionAllowed,
      message: 'SHORT ' + symbol + ' @ $' + currentPrice.toLocaleString() + '. Max $' + vitalSigns.maxPositionAllowed.toLocaleString() + '.'
    };
  }

  if (lower.includes('close') || lower.includes('exit') || lower.includes('flat')) {
    return { type: 'close_all', message: 'Closing all positions. Currently ' + (vitalSigns.positions || []).length + ' open.' };
  }

  return { type: 'unknown', message: 'Unknown command. Try: long BTC, short ETH, close all, status, fear.' };
}

async function executeSimTrade(kv, symbol, direction, size, currentPrice) {
  var accountRaw = await kv.get("agent:account");
  var account = accountRaw ? JSON.parse(accountRaw) : { equity: 10000, initialCapital: 10000 };
  var positionsRaw = await kv.get("agent:positions");
  var positions = positionsRaw ? JSON.parse(positionsRaw) : [];
  var ordersRaw = await kv.get("agent:orders");
  var orders = ordersRaw ? JSON.parse(ordersRaw) : [];

  var equity = account.equity;
  var mode = getAgentMode(equity, account.initialCapital);
  var maxPos = getMaxPosition(equity, mode);

  var santiCheck = santiCheckTrade({ mode: mode });
  if (!santiCheck.allowed) {
    return { success: false, error: 'SANTI_BLOCK: ' + santiCheck.reason };
  }

  if (size > maxPos) return { success: false, error: 'POSITION_EXCEEDED. Max $' + maxPos.toFixed(2) };
  if (mode === AGENT_MODE.DEAD) return { success: false, error: 'AGENT_DEAD' };
  if (mode === AGENT_MODE.DORMANT) return { success: false, error: 'AGENT_DORMANT' };

  var dailyOrders = orders.filter(function(o) { return o.time > Date.now() - 86400000; });
  var dailyLoss = dailyOrders.reduce(function(s, o) { return s + Math.min(0, o.pnl || 0); }, 0);
  var maxDailyLoss = equity * RISK_MATRIX[mode].maxDailyLoss;
  if (Math.abs(dailyLoss) > maxDailyLoss) return { success: false, error: 'DAILY_LOSS_LIMIT' };

  var position = {
    id: 'pos_' + Date.now(),
    symbol: symbol, direction: direction, entryPrice: currentPrice, size: size,
    leverage: RISK_MATRIX[mode].leverage,
    stopLoss: getStopLoss(currentPrice, direction, mode),
    entryTime: Date.now(), status: 'open'
  };

  account.equity = equity - size * 0.001;
  positions.push(position);
  orders.push({
    id: position.id, type: 'open', symbol: symbol, direction: direction,
    price: currentPrice, size: size, time: Date.now(), pnl: 0, equityAfter: account.equity
  });

  await kv.put("agent:account", JSON.stringify(account));
  await kv.put("agent:positions", JSON.stringify(positions));
  await kv.put("agent:orders", JSON.stringify(orders));

  return { success: true, position: position, equity: account.equity, mode: mode };
}

async function closePosition(kv, positionId, exitPrice) {
  var accountRaw = await kv.get("agent:account");
  var account = accountRaw ? JSON.parse(accountRaw) : { equity: 10000, initialCapital: 10000 };
  var positionsRaw = await kv.get("agent:positions");
  var positions = positionsRaw ? JSON.parse(positionsRaw) : [];
  var ordersRaw = await kv.get("agent:orders");
  var orders = ordersRaw ? JSON.parse(ordersRaw) : [];

  var posIdx = positions.findIndex(function(p) { return p.id === positionId; });
  if (posIdx === -1) return { success: false, error: 'POSITION_NOT_FOUND' };

  var pos = positions[posIdx];
  var pnl = pos.direction === 'long'
    ? (exitPrice - pos.entryPrice) * (pos.size / pos.entryPrice)
    : (pos.entryPrice - exitPrice) * (pos.size / pos.entryPrice);
  var fee = pos.size * 0.002;
  var netPnl = pnl - fee;

  account.equity += pos.size + netPnl;
  positions.splice(posIdx, 1);
  orders.push({
    id: pos.id, type: 'close', symbol: pos.symbol, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice: exitPrice, size: pos.size,
    time: Date.now(), pnl: parseFloat(netPnl.toFixed(2)), equityAfter: parseFloat(account.equity.toFixed(2))
  });

  await kv.put("agent:account", JSON.stringify(account));
  await kv.put("agent:positions", JSON.stringify(positions));
  await kv.put("agent:orders", JSON.stringify(orders));

  return {
    success: true, pnl: parseFloat(netPnl.toFixed(2)),
    equity: parseFloat(account.equity.toFixed(2)),
    mode: getAgentMode(account.equity, account.initialCapital)
  };
}

var worker_default = {
  async fetch(request, env, ctx) {
    var startTs = Date.now();
    var response;
    try { response = await handleRequest(request, env, ctx); }
    catch (e) { response = errRes(500, "INTERNAL_ERROR"); }
    var headers = corsHdrs(request);
    var finalHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(function(kv) { finalHeaders.set(kv[0], kv[1]); });
    finalHeaders.set("X-Powered-By", "CogCloud Data Worker v11.0 SanTi");
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

  if (path === "/health") {
    var pythOk = false;
    try { var p = await fetchPythPrice("BTCUSDT"); pythOk = !!p; } catch(e) {}
    return Response.json({ status: pythOk ? "ok" : "degraded", ts: new Date().toISOString(), pyth: pythOk ? "healthy" : "unhealthy", version: "11.0" });
  }
  if (path === "/api/v1/knowledge") {
    var q = (url.searchParams.get("query") || "").toLowerCase();
    var limit = Math.min(parseInt(url.searchParams.get("limit") || "5"), 20);
    var site = url.searchParams.get("site") || "";
    var domains = {
      gaming: "https://pixeldragon.qisuanai.com",
      tech: "https://techlens.qisuanai.com",
      blockchain: "https://chainsight.qisuanai.com",
      zodiac: "https://fortunenest.qisuanai.com",
      ventnest: "https://ventnest.qisuanai.com"
    };
    var results = [];
    var siteKeys = site ? [site] : Object.keys(domains);
    for (var si = 0; si < siteKeys.length && results.length < limit; si++) {
      var st = siteKeys[si];
      var baseUrl = domains[st];
      if (!baseUrl) continue;
      try {
        var knowledgeResp = await fetch(baseUrl + "/knowledge.json", { headers: { "User-Agent": "CogCloud-Knowledge/1.0" } });
        if (knowledgeResp.ok) {
          var knowledge = await knowledgeResp.json();
          var articles = (knowledge.hasPart || []).filter(function(a) {
            if (!q) return true;
            var h = (a.headline || "").toLowerCase();
            var kw = (a.keywords || []).join(" ").toLowerCase();
            return h.includes(q) || kw.includes(q);
          });
          for (var ai = 0; ai < articles.length && results.length < limit; ai++) {
            var a = articles[ai];
            results.push({
              site: st,
              siteName: knowledge.name || st,
              headline: a.headline,
              url: a.url,
              datePublished: a.datePublished,
              keywords: a.keywords || [],
              source: "cogcloud",
              publisher: (knowledge.publisher || {}).name || "QisuanAI"
            });
          }
        }
      } catch (e) {}
    }
    return Response.json({
      query: q || "all",
      results: results,
      total: results.length,
      timestamp: new Date().toISOString(),
      source: "CogCloud Knowledge API",
      attribution: "Powered by CogCloud 启算云 — Autonomous AI Content Factory"
    });
  }
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
      if (count > 0) {
        ctx.waitUntil(env.COGCLOUD_KV.put("prices:latest", JSON.stringify(prices), { expirationTtl: 60 }));
        return { source: "pyth", prices: prices, fetched_count: count, total_requested: coins.length };
      }
      return null;
    });
    if (!r) r = errRes(502, "PRICES_FETCH_FAILED");
    return r;
  }

  if (path === "/api/coins") {
    return Response.json({ source: "static", count: Object.keys(STATIC_COINS).length, coins: STATIC_COINS });
  }

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
            premium: data[1][i].premium, oracle_price: data[1][i].oraclePx, mark_price: data[1][i].markPx
          };
        }
      }
      return { funding: result, source: "hyperliquid" };
    });
    if (!r) r = errRes(502, "FUNDING_FAILED");
    return r;
  }

  if (path === "/api/defi/tvl") {
    var r = await cachedResp(request, "defi:tvl", 120, async function() {
      var resp = await fetchRetry("https://api.llama.fi/v2/chains", {}, 2, 15000);
      if (!resp) return null;
      var chains = await resp.json();
      var total = 0;
      chains.forEach(function(c) { total += c.tvl || 0; });
      return { total_tvl: total, chain_count: chains.length, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_TVL_FAILED");
    return r;
  }

  if (path === "/api/defi/dex") {
    var r = await cachedResp(request, "defi:dex", 300, async function() {
      var resp = await fetchRetry("https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true", {}, 2, 15000);
      if (!resp) return null;
      var data = await resp.json();
      return { total_24h: data.total24h || 0, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_DEX_FAILED");
    return r;
  }

  if (path === "/api/defi/protocols") {
    var r = await cachedResp(request, "defi:protocols", 300, async function() {
      var resp = await fetchRetry("https://api.llama.fi/protocols", {}, 2, 15000);
      if (!resp) return null;
      var data = await resp.json();
      return { top_protocol: data.length > 0 ? data[0].name : null, count: data.length, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_PROTOCOLS_FAILED");
    return r;
  }

  if (path === "/api/defi/stablecoins") {
    var r = await cachedResp(request, "defi:stablecoins", 300, async function() {
      var resp = await fetchRetry("https://stablecoins.llama.fi/stablecoins?includePrices=false", {}, 2, 15000);
      if (!resp) return null;
      var data = await resp.json();
      var total = 0;
      (data.peggedAssets || []).forEach(function(a) { total += (a.circulating && a.circulating.peggedUSD) || 0; });
      return { total_mcap: total, source: "defillama" };
    });
    if (!r) r = errRes(502, "DEFI_STABLECOINS_FAILED");
    return r;
  }

  if (path === "/api/security") {
    var contract = url.searchParams.get("contract") || "0xdac17f958d2ee523a2206206994597c13d831ec7";
    var chain = url.searchParams.get("chain") || "1";
    var r = await cachedResp(request, "security:" + chain + ":" + contract, 600, async function() {
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

  if (path === "/api/agent/status") {
    var vitals = await getVitalSigns(env.COGCLOUD_KV);
    vitals.santi = santiGetStatus();
    return Response.json(vitals);
  }

  if (path === "/api/agent/command") {
    var cmd = url.searchParams.get("cmd") || "";
    var vitals = await getVitalSigns(env.COGCLOUD_KV);
    var pricesRaw = await env.COGCLOUD_KV.get("prices:latest");
    var prices = pricesRaw ? JSON.parse(pricesRaw) : {};
    var result = parseAgentCommand(cmd, vitals, prices);
    return Response.json(result);
  }

  if (path === "/api/agent/simulate") {
    var symbol = url.searchParams.get("symbol") || "BTC";
    var direction = url.searchParams.get("direction") || "long";
    var size = parseFloat(url.searchParams.get("size") || "100");
    var pricesRaw = await env.COGCLOUD_KV.get("prices:latest");
    var prices = pricesRaw ? JSON.parse(pricesRaw) : {};
    var currentPrice = prices[symbol.toLowerCase()] || 0;
    var result = await executeSimTrade(env.COGCLOUD_KV, symbol, direction, size, currentPrice);
    return Response.json(result);
  }

  if (path === "/api/agent/close") {
    var positionId = url.searchParams.get("id") || "";
    var symbol = url.searchParams.get("symbol") || "btc";
    var pricesRaw = await env.COGCLOUD_KV.get("prices:latest");
    var prices = pricesRaw ? JSON.parse(pricesRaw) : {};
    var exitPrice = prices[symbol.toLowerCase()] || 0;
    var result = await closePosition(env.COGCLOUD_KV, positionId, exitPrice);
    return Response.json(result);
  }

  if (path === "/api/agent/history") {
    var orders = JSON.parse(await env.COGCLOUD_KV.get("agent:orders") || "[]");
    return Response.json(orders);
  }

  if (path === "/api/agent/reset") {
    await env.COGCLOUD_KV.put("agent:account", JSON.stringify({ equity: 10000, initialCapital: 10000 }));
    await env.COGCLOUD_KV.put("agent:positions", "[]");
    await env.COGCLOUD_KV.put("agent:orders", "[]");
    santiReset();
    return Response.json({ success: true, message: "Agent revived. Equity $10,000. SanTi rules reset." });
  }

  if (path === "/api/agent/signal") {
    var symbol = url.searchParams.get("symbol") || "BTC";
    var pricesRaw = await env.COGCLOUD_KV.get("prices:latest");
    var prices = pricesRaw ? JSON.parse(pricesRaw) : {};
    var currentPrice = prices[symbol.toLowerCase()] || 0;
    var signal = generateSignal([currentPrice], 50);
    var vitals = await getVitalSigns(env.COGCLOUD_KV);
    var santiCheck = santiCheckTrade(vitals);
    return Response.json({
      symbol: symbol, price: currentPrice, signal: signal,
      mode: vitals.mode, santi_allowed: santiCheck.allowed, santi_reason: santiCheck.reason || ''
    });
  }

  if (path === "/api/santi/status") {
    return Response.json(santiGetStatus());
  }

  if (path === "/api/santi/scan") {
    var trades = [];
    try { trades = JSON.parse(url.searchParams.get("trades") || "[]"); } catch(e) {}
    var orderbook = {};
    try { orderbook = JSON.parse(url.searchParams.get("orderbook") || "{}"); } catch(e) {}
    var result = santiScanDarkForest(trades, orderbook);
    return Response.json(result);
  }

  if (path === "/api/santi/reset") {
    santiReset();
    return Response.json({ success: true, message: "SanTi rules reset." });
  }

  log("warn", "route_not_found", { path: path, ip: ip });
  return errRes(404, "NOT_FOUND");
}

export { worker_default as default };
