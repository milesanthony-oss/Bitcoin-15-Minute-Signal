// BTC 15m Kalshi relay — V9.8
// Public-read relay with short edge caching, stale fallback and 429 backoff.
// No API keys or private credentials are stored here.

const cooldownUntil = new Map();

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra
  };
}

function routeConfig(pathname) {
  if (pathname === "/kalshi/markets") return { fresh: 10, stale: 90 };
  if (pathname.startsWith("/kalshi/orderbook/")) return { fresh: 2, stale: 20 };
  if (pathname.startsWith("/kalshi/market/")) return { fresh: 5, stale: 60 };
  return { fresh: 5, stale: 30 };
}

function cacheKey(url, suffix = "") {
  const u = new URL(url);
  if (suffix) u.searchParams.set("__relay_cache", suffix);
  return new Request(u.toString(), { method: "GET" });
}

async function withRelayHeaders(resp, headers = {}) {
  const body = await resp.arrayBuffer();
  return new Response(body, {
    status: resp.status,
    headers: corsHeaders({
      "Content-Type": resp.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
      ...headers
    })
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "GET") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: corsHeaders() }
      );
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        {
          ok: true,
          service: "btc15m-kalshi-relay",
          version: "9.8",
          time: new Date().toISOString()
        },
        { headers: corsHeaders({ "Cache-Control": "no-store" }) }
      );
    }

    const base = "https://external-api.kalshi.com/trade-api/v2";
    let target;

    if (url.pathname === "/kalshi/markets") {
      const qs = new URLSearchParams(url.search);
      qs.delete("__relay_cache");
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
        { status: 404, headers: corsHeaders() }
      );
    }

    const cfg = routeConfig(url.pathname);
    const cache = caches.default;
    const freshKey = cacheKey(request.url, "fresh");
    const staleKey = cacheKey(request.url, "stale");

    // Fresh edge cache
    const freshHit = await cache.match(freshKey);
    if (freshHit) {
      return withRelayHeaders(freshHit, {
        "X-Relay-Cache": "HIT",
        "X-Relay-Stale": "0",
        "X-Upstream-Status": "200"
      });
    }

    const now = Date.now();
    const cd = cooldownUntil.get(target) || 0;

    // Avoid hammering Kalshi if this exact resource was just rate-limited
    if (cd > now) {
      const stale = await cache.match(staleKey);

      if (stale) {
        return withRelayHeaders(stale, {
          "X-Relay-Cache": "STALE",
          "X-Relay-Stale": "1",
          "X-Upstream-Status": "429",
          "X-Relay-Backoff-Ms": String(cd - now)
        });
      }

      return Response.json(
        {
          error: {
            code: "relay_backoff",
            message: "Kalshi rate-limit cooldown active"
          },
          retry_after_ms: cd - now
        },
        {
          status: 429,
          headers: corsHeaders({
            "Cache-Control": "no-store",
            "Retry-After": String(
              Math.max(1, Math.ceil((cd - now) / 1000))
            ),
            "X-Relay-Cache": "MISS",
            "X-Relay-Stale": "0",
            "X-Upstream-Status": "429"
          })
        }
      );
    }

    try {
      const started = Date.now();

      const upstream = await fetch(target, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        }
      });

      const latency = Date.now() - started;
      const body = await upstream.arrayBuffer();

      const contentType =
        upstream.headers.get("Content-Type") || "application/json";

      if (upstream.ok) {
        cooldownUntil.delete(target);

        const freshResp = new Response(body.slice(0), {
          status: upstream.status,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": `public, max-age=${cfg.fresh}`
          }
        });

        const staleResp = new Response(body.slice(0), {
          status: upstream.status,
          headers: {
            "Content-Type": contentType,
            "Cache-Control": `public, max-age=${cfg.stale}`
          }
        });

        await Promise.all([
          cache.put(freshKey, freshResp),
          cache.put(staleKey, staleResp)
        ]);

        return new Response(body, {
          status: upstream.status,
          headers: corsHeaders({
            "Content-Type": contentType,
            "Cache-Control": "no-store",
            "X-Relay-Cache": "MISS",
            "X-Relay-Stale": "0",
            "X-Upstream-Status": String(upstream.status),
            "X-Relay-Latency-Ms": String(latency)
          })
        });
      }

      if (upstream.status === 429) {
        const retryHeader = Number(
          upstream.headers.get("Retry-After")
        );

        const backoffMs =
          Number.isFinite(retryHeader) && retryHeader > 0
            ? Math.min(30000, retryHeader * 1000)
            : 5000;

        cooldownUntil.set(
          target,
          Date.now() + backoffMs
        );

        const stale = await cache.match(staleKey);

        if (stale) {
          return withRelayHeaders(stale, {
            "X-Relay-Cache": "STALE",
            "X-Relay-Stale": "1",
            "X-Upstream-Status": "429",
            "X-Relay-Latency-Ms": String(latency),
            "X-Relay-Backoff-Ms": String(backoffMs)
          });
        }
      }

      if (upstream.status >= 500 || upstream.status === 429) {
        const stale = await cache.match(staleKey);

        if (stale) {
          return withRelayHeaders(stale, {
            "X-Relay-Cache": "STALE",
            "X-Relay-Stale": "1",
            "X-Upstream-Status": String(upstream.status),
            "X-Relay-Latency-Ms": String(latency)
          });
        }
      }

      return new Response(body, {
        status: upstream.status,
        headers: corsHeaders({
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Relay-Cache": "MISS",
          "X-Relay-Stale": "0",
          "X-Upstream-Status": String(upstream.status),
          "X-Relay-Latency-Ms": String(latency)
        })
      });

    } catch (error) {
      const stale = await caches.default.match(staleKey);

      if (stale) {
        return withRelayHeaders(stale, {
          "X-Relay-Cache": "STALE",
          "X-Relay-Stale": "1",
          "X-Upstream-Status": "network_error"
        });
      }

      return Response.json(
        {
          error: "kalshi_fetch_failed",
          message: String(error)
        },
        {
          status: 502,
          headers: corsHeaders({
            "Cache-Control": "no-store",
            "X-Relay-Cache": "MISS",
            "X-Relay-Stale": "0",
            "X-Upstream-Status": "network_error"
          })
        }
      );
    }
  }
};
