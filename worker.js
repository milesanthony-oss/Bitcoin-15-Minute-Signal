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
  
      );
    }
  }
};
