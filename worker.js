// V13.2: cache discovery, coalesce duplicate requests, and back off on upstream 429s.
const BASE='https://external-api.kalshi.com/trade-api/v2';
const pending=new Map(), cooldown=new Map(), strikes=new Map();
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'*'};
const json=(data,status=200,extra={})=>Response.json(data,{status,headers:{...cors,'Cache-Control':'no-store',...extra}});
const num=v=>v==null||v===''?null:(Number.isFinite(Number(v))?Number(v):null);
const valid=v=>v!=null&&v>=0&&v<=1?v:null;

function pricing(raw,ticker){
 const m=raw.market||raw,yb=valid(num(m.yes_bid_dollars)),ya=valid(num(m.yes_ask_dollars)),nb=valid(num(m.no_bid_dollars)),na=valid(num(m.no_ask_dollars));
 return {source:'KALSHI_EXTERNAL_NOT_ROBINHOOD',ticker:m.ticker||ticker,status:m.status||null,title:m.title||null,target:num(m.floor_strike)??num(m.functional_strike)??num(m.cap_strike),closeTime:m.close_time||null,up:{bid:yb??(na==null?null:1-na),ask:ya??(nb==null?null:1-nb)},down:{bid:nb??(ya==null?null:1-ya),ask:na??(yb==null?null:1-yb)},observedAt:new Date().toISOString(),executableOnRobinhood:false,warning:'Kalshi external quote only; verify matching rules, target, expiry and Robinhood ask.'};
}

export default {async fetch(request){
 const u=new URL(request.url),p=u.pathname;
 if(request.method==='OPTIONS')return new Response(null,{headers:cors});
 if(request.method!=='GET')return json({error:'method_not_allowed'},405);
 if(p==='/'||p==='/health')return json({ok:true,service:'btc15m-kalshi-relay-v13.2',time:new Date().toISOString()});

 let upstream,ttl=5,transform=null;
 if(p==='/kalshi/markets'){upstream=BASE+'/markets?'+u.searchParams.toString();ttl=60;}
 else if(p.startsWith('/pricing/kalshi/')){const t=p.slice('/pricing/kalshi/'.length);if(!/^[A-Za-z0-9_-]{1,120}$/.test(t))return json({error:'invalid_ticker'},400);upstream=BASE+'/markets/'+encodeURIComponent(t);ttl=4;transform=raw=>pricing(raw,t);}
 else if(p.startsWith('/kalshi/market/')){const t=p.slice('/kalshi/market/'.length);if(!/^[A-Za-z0-9_-]{1,120}$/.test(t))return json({error:'invalid_ticker'},400);upstream=BASE+'/markets/'+encodeURIComponent(t);ttl=5;}
 else if(p.startsWith('/kalshi/orderbook/')){const t=p.slice('/kalshi/orderbook/'.length);if(!/^[A-Za-z0-9_-]{1,120}$/.test(t))return json({error:'invalid_ticker'},400);const depth=Math.min(20,Math.max(1,Number(u.searchParams.get('depth'))||10));upstream=BASE+'/markets/'+encodeURIComponent(t)+'/orderbook?depth='+depth;ttl=3;}
 else return json({error:'unknown_route',path:p},404);

 const key=new Request('https://cache.btc15m.internal/'+encodeURIComponent(upstream)+(transform?'?pricing=1':''));
 const cache=caches.default,hit=await cache.match(key);
 if(hit){const h=new Headers(hit.headers);Object.entries(cors).forEach(([k,v])=>h.set(k,v));h.set('X-Relay-Cache','HIT');return new Response(hit.body,{status:hit.status,headers:h});}

 const host=new URL(upstream).host,until=cooldown.get(host)||0;
 if(Date.now()<until)return json({error:'upstream_rate_limited',retryAfterSeconds:Math.ceil((until-Date.now())/1000)},503,{'Retry-After':String(Math.ceil((until-Date.now())/1000)),'X-Relay-Stale':'1'});

 if(!pending.has(upstream+(transform?'|pricing':''))){
  const job=(async()=>{const r=await fetch(upstream,{headers:{Accept:'application/json'}});
   if(r.status===429){const n=Math.min(5,(strikes.get(host)||0)+1);strikes.set(host,n);const retry=Math.min(300,Math.max(30,Number(r.headers.get('Retry-After'))||30*Math.pow(2,n-1)));cooldown.set(host,Date.now()+retry*1000);return json({error:'upstream_rate_limited',retryAfterSeconds:retry},503,{'Retry-After':String(retry),'X-Upstream-Status':'429'});}
   if(!r.ok)return json({error:'upstream_http',status:r.status},502,{'X-Upstream-Status':String(r.status)});
   strikes.set(host,0);let body;try{const raw=await r.json();body=JSON.stringify(transform?transform(raw):raw);}catch(e){return json({error:'invalid_upstream_json'},502);}
   const response=new Response(body,{headers:{...cors,'Content-Type':'application/json','Cache-Control':'public, max-age='+ttl+', s-maxage='+ttl,'X-Relay-Cache':'MISS','X-Upstream-Status':'200'}});
   await cache.put(key,response.clone());return response;
  })().catch(e=>json({error:'upstream_fetch_failed',message:String(e)},502));
  pending.set(upstream+(transform?'|pricing':''),job);job.finally(()=>pending.delete(upstream+(transform?'|pricing':'')));
 }
 const response=await pending.get(upstream+(transform?'|pricing':''));return response.clone();
}};
