// cogcloud-data-worker.js — 
const CONFIG = {
  CACHE_TTL: 120, PRICE_CACHE_TTL: 30, MAX_RETRIES: 3, TIMEOUT: 8000, RATE_LIMIT: 100,
  AUTH_TOKEN: null,
  CORS_ORIGINS: ['https://huggingface.co','https://qisuanai.com','https://chainsight.qisuanai.com'],
};

const COIN_TO_BINANCE = {
  "bitcoin":"BTCUSDT","ethereum":"ETHUSDT","solana":"SOLUSDT","binancecoin":"BNBUSDT","ripple":"XRPUSDT","cardano":"ADAUSDT","dogecoin":"DOGEUSDT","avalanche-2":"AVAXUSDT","polkadot":"DOTUSDT","matic-network":"MATICUSDT","chainlink":"LINKUSDT","uniswap":"UNIUSDT","litecoin":"LTCUSDT","shiba-inu":"SHIBUSDT","tron":"TRXUSDT","stellar":"XLMUSDT","hedera-hashgraph":"HBARUSDT","ethereum-classic":"ETCUSDT","near":"NEARUSDT","cosmos":"ATOMUSDT","filecoin":"FILUSDT","aptos":"APTUSDT","sui":"SUIUSDT","optimism":"OPUSDT","arbitrum":"ARBUSDT","immutable-x":"IMXUSDT","render-token":"RENDERUSDT","the-graph":"GRTUSDT","algorand":"ALGOUSDT","theta-token":"THETAUSDT","tezos":"XTZUSDT","eos":"EOSUSDT","flow":"FLOWUSDT","maker":"MKRUSDT","aave":"AAVEUSDT","curve-dao-token":"CRVUSDT",
};

const COIN_TO_COINCAP = {
  "bitcoin":"bitcoin","ethereum":"ethereum","solana":"solana","binancecoin":"binance-coin","ripple":"xrp","cardano":"cardano","dogecoin":"dogecoin","avalanche-2":"avalanche","polkadot":"polkadot","matic-network":"polygon","chainlink":"chainlink","uniswap":"uniswap","litecoin":"litecoin","shiba-inu":"shiba-inu","tron":"tron","stellar":"stellar","hedera-hashgraph":"hedera-hashgraph","ethereum-classic":"ethereum-classic","near":"near-protocol","cosmos":"cosmos","filecoin":"filecoin",
};

const PYTH_PRICE_IDS = {
  "BTCUSDT":"0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETHUSDT":"0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "SOLUSDT":"0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BNBUSDT":"0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
  "XRPUSDT":"0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
  "ADAUSDT":"0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d",
  "DOGEUSDT":"0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c",
  "AVAXUSDT":"0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",
  "DOTUSDT":"0xca3eed9b267293f6595901c734c7525ce8ef49adafe8284606ceb307afa2ca5b",
  "MATICUSDT":"0x5de33a9112c2b700b8d30b8a3402c103578ccfa2765696471cc672bd5cf6ac52",
  "LINKUSDT":"0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
  "UNIUSDT":"0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501",
  "LTCUSDT":"0x6e3f3fa8253588df93265801802398ebcda6f23c4ce26e6c9641e6e298f7b2b9",
  "SHIBUSDT":"0xf0d57deca57b3da2fe63a493f4c25925fdfd8edf834b20f93e1f84dbd1504d4b",
  "TRXUSDT":"0x67aed5a24fdad045475e7195c98a98aea119c763f272d4523f5bac93a4f33c2b",
};

const INTERVAL_MAP = {"5min":"5m","30min":"30m","1h":"1h","6h":"6h","1d":"1d"};

class RateLimiter {
  constructor(max,win){this.max=max;this.window=win;this.store=new Map();}
  check(ip){const n=Date.now();const r=this.store.get(ip)||{count:0,reset:n+this.window};if(n>r.reset){r.count=0;r.reset=n+this.window;}r.count++;this.store.set(ip,r);return r.count<=this.max;}
}
const limiter=new RateLimiter(CONFIG.RATE_LIMIT,60000);

function log(l,m,x={}){console.log(JSON.stringify({ts:new Date().toISOString(),level:l,message:m,...x}));}
function errRes(c,d){return Response.json({error:{code:c,detail:d,ts:new Date().toISOString()}},{status:c});}
function corsHdrs(r){const o=r.headers.get('Origin')||'';const a=CONFIG.CORS_ORIGINS.includes(o)?o:CONFIG.CORS_ORIGINS[0];return{'Access-Control-Allow-Origin':a,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'86400'};}

async function fetchTO(url,opts={},to=CONFIG.TIMEOUT){const c=new AbortController();const t=setTimeout(()=>c.abort(),to);try{return await fetch(url,{...opts,signal:c.signal});}finally{clearTimeout(t);}}
async function fetchRetry(url,opts={},retries=CONFIG.MAX_RETRIES){for(let i=0;i<retries;i++){try{const r=await fetchTO(url,opts);if(r.status===429){await new Promise(r=>setTimeout(r,2000*(i+1)));continue;}if(r.status===451){log('warn','geo_blocked',{url});return null;}if(!r.ok){log('warn','fetch_fail',{url,status:r.status,attempt:i+1});continue;}return r;}catch(e){log('warn','fetch_err',{url,error:e.message,attempt:i+1});}}return null;}

async function fetchCoinGeckoOHLC(coinId,days){const r=await fetchRetry(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`);if(!r)return null;const d=await r.json();if(!Array.isArray(d)||!d.length)return null;return{source:'coingecko',coin_id:coinId,days,data:d.map(x=>({timestamp:x[0],open:x[1],high:x[2],low:x[3],close:x[4],volume:0}))};}

async function fetchPythPrice(symbol){const id=PYTH_PRICE_IDS[symbol];if(!id)return null;const r=await fetchRetry(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${id}`);if(!r)return null;const d=await r.json();const p=d?.parsed?.[0]?.price;if(!p)return null;return{source:'pyth',symbol,price:parseFloat(p.price)*Math.pow(10,p.expo)};}
async function fetchCGPrice(coinId){const r=await fetchRetry(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,{},2);if(!r)return null;const d=await r.json();const p=d[coinId]?.usd;if(!p)return null;return{source:'coingecko',coin_id:coinId,price:parseFloat(p)};}
async function fetchCCPrice(coinId){const cid=COIN_TO_COINCAP[coinId]||coinId;const r=await fetchRetry(`https://api.coincap.io/v2/assets/${cid}`,{},2);if(!r)return null;const d=await r.json();const p=d?.data?.priceUsd;if(!p)return null;return{source:'coincap',coin_id:coinId,price:parseFloat(p)};}

async function cachedResp(req,key,ttl,fetcher,ctx){const c=caches.default;const hit=await c.match(req);if(hit){log('info','cache_hit',{key});return hit;}const data=await fetcher();if(!data)return null;const resp=Response.json(data);resp.headers.set('Cache-Control',`public, max-age=${ttl}`);const cu=new URL(req.url);cu.search=`cache_key=${key}`;ctx.waitUntil(c.put(new Request(cu.toString(),req),resp.clone()));log('info','cache_miss',{key});return resp;}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);const path=url.pathname;const hdrs=corsHdrs(request);const ip=request.headers.get('CF-Connecting-IP')||'unknown';
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:hdrs});
    const auth=url.searchParams.get('token')||request.headers.get('Authorization')?.replace('Bearer ','');
    if(env.AUTH_TOKEN&&auth!==env.AUTH_TOKEN){log('warn','auth_fail',{ip});return errRes(401,'UNAUTHORIZED');}
    if(!limiter.check(ip)){log('warn','rate_limited',{ip});return errRes(429,'RATE_LIMITED');}
    let r;
    if(path==='/health'){r=Response.json({status:'ok',ts:new Date().toISOString()});}
    else if(path==='/api/ohlc'){
      const cid=url.searchParams.get('coin_id')||'bitcoin';const days=parseInt(url.searchParams.get('days')||'30');const lim=parseInt(url.searchParams.get('limit')||'500');const per=url.searchParams.get('period')||'1d';
      r=await cachedResp(request,`ohlc:${cid}:${per}:${lim}`,CONFIG.CACHE_TTL,async()=>{const d=await fetchCoinGeckoOHLC(cid,days);if(d)return d;log('error','ohlc_fail',{coin:cid});return null;},ctx);
      if(!r)r=errRes(502,'ALL_SOURCES_FAILED');
    }
    else if(path==='/api/price'){
      const cid=url.searchParams.get('coin_id')||'bitcoin';const sym=COIN_TO_BINANCE[cid]||`${cid.split('-')[0].toUpperCase()}USDT`;
      r=await cachedResp(request,`price:${cid}`,CONFIG.PRICE_CACHE_TTL,async()=>{
        const a=await fetchPythPrice(sym);if(a){log('info','price_src',{source:'pyth',coin:cid});return a;}
        const b=await fetchCGPrice(cid);if(b){log('info','price_src',{source:'coingecko',coin:cid});return b;}
        const c=await fetchCCPrice(cid);if(c){log('info','price_src',{source:'coincap',coin:cid});return c;}
        log('error','all_price_fail',{coin:cid});return null;
      },ctx);
      if(!r)r=errRes(502,'PRICE_FETCH_FAILED');
    }
    else if(path==='/api/prices'){
      const coins=(url.searchParams.get('coins')||'bitcoin,ethereum').split(',').slice(0,20);
      r=await cachedResp(request,`prices:${coins.sort().join(',')}`,CONFIG.PRICE_CACHE_TTL,async()=>{
        const res=await Promise.all(coins.map(async c=>{
          const s=COIN_TO_BINANCE[c]||`${c.split('-')[0].toUpperCase()}USDT`;
          const a=await fetchPythPrice(s);if(a)return[c,a.price];
          const b=await fetchCGPrice(c);if(b)return[c,b.price];
          const d=await fetchCCPrice(c);if(d)return[c,d.price];
          return[c,null];
        }));
        const prices={};res.forEach(([c,p])=>{if(p!==null)prices[c]=p;});
        if(Object.keys(prices).length)return{source:'pyth_primary',prices};
        return null;
      },ctx);
      if(!r)r=errRes(502,'PRICES_FETCH_FAILED');
    }
    else if(path==='/api/coins'){
      r=await cachedResp(request,'top_coins',3600,async()=>{
        const resp=await fetchRetry('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false');
        if(resp){const d=await resp.json();const coins={};d.forEach(c=>{coins[`${c.name} (${c.symbol.toUpperCase()})`]=c.id;});return{source:'coingecko',count:Object.keys(coins).length,coins};}
        return null;
      },ctx);
      if(!r)r=Response.json({coins:{"Bitcoin (BTC)":"bitcoin","Ethereum (ETH)":"ethereum","Solana (SOL)":"solana"}});
    }
    else{r=errRes(404,'NOT_FOUND');}
    const fh=new Headers(r.headers);Object.entries(hdrs).forEach(([k,v])=>fh.set(k,v));fh.set('X-Powered-By','CogCloud Data Worker');
    return new Response(r.body,{status:r.status,statusText:r.statusText,headers:fh});
  }
};
