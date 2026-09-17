export default {
  async fetch(request) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const base = "https://external-api.kalshi.com/trade-api/v2";
    let target;

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "btc15m-kalshi-relay",
          time: new Date().toISOString()
        },
        { headers: cors }
      );
    }

    if (url.pathname === "/kalshi/markets") {
      const qs = new URLSearchParams(url.search);
      target = `${base}/markets?${qs.toString()}`;
    } else if (url.pathname.startsWith("/kalshi/market/")) {
      const ticker = url.pathname.split("/").pop();
      target = `${base}/markets/${encodeURIComponent(ticker)}`;
    } else if (url.pathname.startsWith("/kalshi/orderbook/")) {
      const ticker = url.pathname.split("/").pop();
      const depth = url.searchParams.get("depth") || "10";
      target =
        `${base}/markets/${encodeURIComponent(ticker)}` +
        `/orderbook?depth=${encodeURIComponent(depth)}`;
    } else if (url.pathname.startsWith("/pricing/kalshi/")) {
      const ticker = url.pathname.split("/").pop();
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(ticker)) return Response.json({error:"invalid_ticker"},{status:400,headers:cors});
      try {
        const started=Date.now();
        const response=await fetch(`${base}/markets/${encodeURIComponent(ticker)}`,{headers:{Accept:"application/json"},cache:"no-store"});
        if (!response.ok) return Response.json({error:"upstream_http",status:response.status},{status:502,headers:cors});
        const raw=await response.json(); const m=raw.market||raw;
        const num=v=>v===null||v===undefined||v===""?null:(Number.isFinite(Number(v))?Number(v):null);
        const yesBid=num(m.yes_bid_dollars),yesAsk=num(m.yes_ask_dollars);
        const noBid=num(m.no_bid_dollars),noAsk=num(m.no_ask_dollars);
        const valid=v=>v!==null&&v>=0&&v<=1?v:null;
        const yb=valid(yesBid),ya=valid(yesAsk),nb=valid(noBid),na=valid(noAsk);
        const upAsk=ya??(nb===null?null:1-nb),downAsk=na??(yb===null?null:1-yb);
        const upBid=yb??(na===null?null:1-na),downBid=nb??(ya===null?null:1-ya);
        return Response.json({source:"KALSHI_EXTERNAL_NOT_ROBINHOOD",ticker:m.ticker||ticker,status:m.status||null,title:m.title||null,
          target:num(m.floor_strike)??num(m.functional_strike)??num(m.cap_strike),closeTime:m.close_time||null,
          up:{bid:upBid,ask:upAsk},down:{bid:downBid,ask:downAsk},observedAt:new Date().toISOString(),
          latencyMs:Date.now()-started,executableOnRobinhood:false,
          warning:"External market only. Verify exact settlement rules, target, expiry and Robinhood executable price."},
          {headers:{...cors,"Cache-Control":"no-store"}});
      } catch(e) {return Response.json({error:"pricing_fetch_failed",message:String(e)},{status:502,headers:cors});}
    } else {
      return Response.json(
        { error: "unknown_route", path: url.pathname },
        { status: 404, headers: cors }
      );
    }

    try {
      const start = Date.now();

      const response = await fetch(target, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        }
      });

      const body = await response.text();

      return new Response(body, {
        status: response.status,
        headers: {
          ...cors,
          "Content-Type":
            response.headers.get("Content-Type") ||
            "application/json",
          "Cache-Control": "no-store",
          "X-Relay-Latency-Ms": String(Date.now() - start)
        }
      });

    } catch (error) {
      return Response.json(
        {
          error: "kalshi_fetch_failed",
          message: String(error)
        },
        {
          status: 502,
          headers: cors
        }
      );
    }
  }
};
