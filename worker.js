// BTC 15m Quant Relay — V10.7
// Primary prediction-market transport: DepthFeed cross-venue screener
// Secret required in Cloudflare: DEPTHFEED_API_KEY

const DF_BASE = "https://api.depthfeed.com/v3";
const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";

const mem = {
  dfLastGood: null,
  dfLastGoodMs: 0,
  dfBackoffUntil: 0,
  kalshiBackoffUntil: 0,
  kalshiLastGoodMarket: null,
  kalshiLastGoodOrderbook: new Map(),
  kalshiSettledCache: null,
  kalshiSettledCacheMs: 0,
};

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra,
  };
}

function json(data, status = 200, extra = {}) {
  return Response.json(data, {
    status,
    headers: cors({ "Cache-Control": "no-store", ...extra }),
  });
}

async function fetchJson(url, options = {}, timeoutMs = 5500) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(url, { ...options, signal: ac.signal });
    const latency = Date.now() - started;
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: r.ok, status: r.status, body, latency, headers: r.headers };
  } finally {
    clearTimeout(to);
  }
}

function retryMs(headers, fallback) {
  const n = Number(headers?.get?.("Retry-After"));
  return Number.isFinite(n) && n > 0 ? Math.min(60000, n * 1000) : fallback;
}

function dfKey(env) {
  return env?.DEPTHFEED_API_KEY || null;
}

async function depthfeedGet(env, path) {
  const key = dfKey(env);
  if (!key) return { missingSecret: true };

  const now = Date.now();

  if (mem.dfBackoffUntil > now) {
    return {
      backoff: true,
      retry_after_ms: mem.dfBackoffUntil - now,
    };
  }

  const r = await fetchJson(`${DF_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
    },
  });

  if (r.status === 429) {
    mem.dfBackoffUntil = Date.now() + retryMs(r.headers, 3000);
  }

  return r;
}

function normalizeScreener(body) {
  const data = body?.data || {};

  return {
    source: "depthfeed",
    asset: "btc",
    window: "15m",
    received_at: new Date().toISOString(),
    price_to_beat: data.price_to_beat ?? null,
    spot: data.spot ?? data.underlying ?? null,
    books: data.books ?? {},
    meta: body?.meta ?? null,
    raw: body,
  };
}

async function serveWhoami(env) {
  const r = await depthfeedGet(env, "/whoami");

  if (r.missingSecret) {
    return json({
      error: { code: "missing_depthfeed_secret" }
    }, 500);
  }

  if (r.backoff) {
    return json({
      error: {
        code: "depthfeed_backoff",
        retry_after_ms: r.retry_after_ms
      }
    }, 503);
  }

  if (!r.ok) {
    return json(
      r.body || { error: `DepthFeed HTTP ${r.status}` },
      r.status || 502
    );
  }

  const d = r.body?.data || {};

  return json({
    data: {
      user_id: d.user_id ?? null,
      plan: d.plan ?? null,
      rps: d.rps ?? null,
      rpm: d.rpm ?? null,
      history_days: d.history_days ?? null,
      coins: d.coins ?? null,
      sports: d.sports ?? null,
      bars: d.bars ?? null,
    },
    meta: r.body?.meta ?? null,
  }, 200, {
    "X-Upstream": "depthfeed",
    "X-Relay-Latency-Ms": String(r.latency),
  });
}

async function serveBtc15m(env) {
  const now = Date.now();
  const r = await depthfeedGet(env, "/screener/btc/15m");

  if (r.missingSecret) {
    return json({
      error: { code: "missing_depthfeed_secret" }
    }, 500);
  }

  if (r.backoff) {
    if (mem.dfLastGood) {
      return json({
        ...mem.dfLastGood,
        relay: {
          cache: "STALE_MEMORY",
          stale: true,
          age_ms: now - mem.dfLastGoodMs,
          retry_after_ms: r.retry_after_ms
        }
      }, 200, {
        "X-Relay-Cache": "STALE",
        "X-Relay-Stale": "1",
        "X-Upstream": "depthfeed",
      });
    }

    return json({
      error: {
        code: "depthfeed_backoff",
        retry_after_ms: r.retry_after_ms
      }
    }, 503);
  }

  if (r.ok) {
    const normalized = normalizeScreener(r.body);

    mem.dfLastGood = normalized;
    mem.dfLastGoodMs = now;

    return json({
      ...normalized,
      relay: {
        cache: "MISS",
        stale: false,
        latency_ms: r.latency,
        upstream_status: r.status
      }
    }, 200, {
      "X-Relay-Cache": "MISS",
      "X-Relay-Stale": "0",
      "X-Upstream": "depthfeed",
      "X-Relay-Latency-Ms": String(r.latency),
    });
  }

  if (mem.dfLastGood) {
    return json({
      ...mem.dfLastGood,
      relay: {
        cache: "STALE_MEMORY",
        stale: true,
        age_ms: now - mem.dfLastGoodMs,
        latency_ms: r.latency,
        upstream_status: r.status
      }
    }, 200, {
      "X-Relay-Cache": "STALE",
      "X-Relay-Stale": "1",
      "X-Upstream": "depthfeed",
    });
  }

  return json(
    r.body || { error: `DepthFeed HTTP ${r.status}` },
    r.status || 502
  );
}

async function serveBtcSpot(env, url) {
  const now = Date.now();

  const from = Number(
    url.searchParams.get("from") || (now - 65000)
  );

  const to = Number(
    url.searchParams.get("to") || now
  );

  const a = Math.max(
    now - 180000,
    Math.min(from, to)
  );

  const b = Math.min(
    now,
    Math.max(from, to)
  );

  const path =
    `/btc/spot/snapshots` +
    `?start_time=${Math.floor(a)}` +
    `&end_time=${Math.floor(b)}` +
    `&interval=1s` +
    `&fill=ffill` +
    `&limit=180`;

  const r = await depthfeedGet(env, path);

  if (r.missingSecret) {
    return json({
      error: { code: "missing_depthfeed_secret" }
    }, 500);
  }

  if (r.backoff) {
    return json({
      error: {
        code: "depthfeed_backoff",
        retry_after_ms: r.retry_after_ms
      }
    }, 503);
  }

  if (!r.ok) {
    return json(
      r.body || { error: `DepthFeed HTTP ${r.status}` },
      r.status || 502
    );
  }

  return json(
    r.body || { data: [] },
    200,
    {
      "X-Upstream": "depthfeed-spot-1s",
      "X-Relay-Latency-Ms": String(r.latency),
    }
  );
}

async function kalshiGet(path) {
  const now = Date.now();

  if (mem.kalshiBackoffUntil > now) {
    return {
      backoff: true,
      retry_after_ms: mem.kalshiBackoffUntil - now
    };
  }

  const r = await fetchJson(
    `${KALSHI_BASE}${path}`,
    {
      headers: {
        Accept: "application/json"
      }
    },
    4500
  );

  if (r.status === 429) {
    mem.kalshiBackoffUntil =
      Date.now() + retryMs(r.headers, 10000);
  }

  return r;
}

async function serveKalshiMarkets(url) {
  const qs = new URLSearchParams();

  for (const [k, v] of url.searchParams.entries()) {
    if (
      ["series_ticker", "status", "limit", "tickers"].includes(k)
    ) {
      qs.set(k, v);
    }
  }

  if (!qs.has("series_ticker")) {
    qs.set("series_ticker", "KXBTC15M");
  }

  if (!qs.has("status")) {
    qs.set("status", "open");
  }

  if (!qs.has("limit")) {
    qs.set("limit", "20");
  }

  const r = await kalshiGet(`/markets?${qs}`);

  if (r.backoff) {
    if (mem.kalshiLastGoodMarket) {
      return json({
        markets: [mem.kalshiLastGoodMarket]
      }, 200, {
        "X-Relay-Cache": "STALE_MEMORY",
        "X-Relay-Stale": "1"
      });
    }

    return json({
      error: {
        code: "kalshi_backoff",
        retry_after_ms: r.retry_after_ms
      },
      markets: []
    }, 503);
  }

  if (r.ok) {
    const m =
      r.body?.market ||
      r.body?.markets?.[0] ||
      null;

    if (m) {
      mem.kalshiLastGoodMarket = m;
    }

    return json(
      r.body,
      200,
      {
        "X-Upstream": "kalshi",
        "X-Relay-Latency-Ms": String(r.latency)
      }
    );
  }

  return json(
    r.body || { error: `Kalshi HTTP ${r.status}` },
    r.status || 502
  );
}

async function serveKalshiSettlements(url) {
  const now = Date.now();

  const limit = Math.min(
    100,
    Math.max(
      1,
      Number(url.searchParams.get("limit") || 50)
    )
  );

  if (
    mem.kalshiSettledCache &&
    now - mem.kalshiSettledCacheMs < 20000
  ) {
    return json(
      mem.kalshiSettledCache,
      200,
      {
        "X-Relay-Cache": "HIT",
        "X-Upstream": "kalshi"
      }
    );
  }

  const r = await kalshiGet(
    `/markets?series_ticker=KXBTC15M&status=settled&limit=${limit}`
  );

  if (r.backoff) {
    if (mem.kalshiSettledCache) {
      return json(
        mem.kalshiSettledCache,
        200,
        {
          "X-Relay-Cache": "STALE_MEMORY",
          "X-Relay-Stale": "1",
          "X-Upstream": "kalshi"
        }
      );
    }

    return json({
      error: {
        code: "kalshi_backoff",
        retry_after_ms: r.retry_after_ms
      },
      markets: []
    }, 503);
  }

  if (r.ok) {
    const body =
      r.body || { markets: [] };

    mem.kalshiSettledCache = body;
    mem.kalshiSettledCacheMs = now;

    return json(
      body,
      200,
      {
        "X-Relay-Cache": "MISS",
        "X-Upstream": "kalshi",
        "X-Relay-Latency-Ms": String(r.latency)
      }
    );
  }

  if (mem.kalshiSettledCache) {
    return json(
      mem.kalshiSettledCache,
      200,
      {
        "X-Relay-Cache": "STALE_MEMORY",
        "X-Relay-Stale": "1",
        "X-Upstream": "kalshi"
      }
    );
  }

  return json(
    r.body || {
      error: `Kalshi HTTP ${r.status}`,
      markets: []
    },
    r.status || 502
  );
}

async function serveKalshiMarket(ticker) {
  const r = await kalshiGet(
    `/markets/${encodeURIComponent(ticker)}`
  );

  if (r.backoff) {
    return json({
      error: {
        code: "kalshi_backoff",
        retry_after_ms: r.retry_after_ms
      }
    }, 503);
  }

  if (r.ok) {
    const m = r.body?.market || null;

    if (m) {
      mem.kalshiLastGoodMarket = m;
    }

    return json(
      r.body,
      200,
      {
        "X-Upstream": "kalshi",
        "X-Relay-Latency-Ms": String(r.latency)
      }
    );
  }

  return json(
    r.body || { error: `Kalshi HTTP ${r.status}` },
    r.status || 502
  );
}

async function serveKalshiOrderbook(ticker, depth) {
  const key = `${ticker}|${depth}`;
  const now = Date.now();

  const r = await kalshiGet(
    `/markets/${encodeURIComponent(ticker)}` +
    `/orderbook?depth=${encodeURIComponent(depth)}`
  );

  if (r.backoff) {
    const cached =
      mem.kalshiLastGoodOrderbook.get(key);

    if (cached) {
      return json(
        cached.body,
        200,
        {
          "X-Relay-Cache": "STALE_MEMORY",
          "X-Relay-Stale": "1",
          "X-Relay-Age-Ms": String(now - cached.ts)
        }
      );
    }

    return json({
      error: {
        code: "kalshi_backoff",
        retry_after_ms: r.retry_after_ms
      }
    }, 503);
  }

  if (r.ok) {
    mem.kalshiLastGoodOrderbook.set(
      key,
      {
        body: r.body,
        ts: now
      }
    );

    return json(
      r.body,
      200,
      {
        "X-Upstream": "kalshi",
        "X-Relay-Latency-Ms": String(r.latency)
      }
    );
  }

  const cached =
    mem.kalshiLastGoodOrderbook.get(key);

  if (cached) {
    return json(
      cached.body,
      200,
      {
        "X-Relay-Cache": "STALE_MEMORY",
        "X-Relay-Stale": "1",
        "X-Relay-Age-Ms": String(now - cached.ts)
      }
    );
  }

  return json(
    r.body || { error: `Kalshi HTTP ${r.status}` },
    r.status || 502
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: cors()
      });
    }

    if (request.method !== "GET") {
      return json({
        error: "method_not_allowed"
      }, 405);
    }

    if (
      url.pathname === "/" ||
      url.pathname === "/health"
    ) {
      return json({
        ok: true,
        service: "btc15m-quant-relay",
        version: "10.7",
        primary_transport: "depthfeed",
        depthfeed_secret_configured:
          Boolean(env?.DEPTHFEED_API_KEY),
        depthfeed_last_good_age_ms:
          mem.dfLastGoodMs
            ? Date.now() - mem.dfLastGoodMs
            : null,
        depthfeed_backoff_ms:
          Math.max(
            0,
            mem.dfBackoffUntil - Date.now()
          ),
        kalshi_backoff_ms:
          Math.max(
            0,
            mem.kalshiBackoffUntil - Date.now()
          ),
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === "/depthfeed/whoami") {
      return serveWhoami(env);
    }

    if (url.pathname === "/depthfeed/btc15m") {
      return serveBtc15m(env);
    }

    if (url.pathname === "/depthfeed/btcspot") {
      return serveBtcSpot(env, url);
    }

    if (url.pathname === "/kalshi/markets") {
      return serveKalshiMarkets(url);
    }

    if (url.pathname === "/kalshi/settlements") {
      return serveKalshiSettlements(url);
    }

    if (
      url.pathname.startsWith("/kalshi/market/")
    ) {
      const ticker =
        url.pathname.split("/").pop();

      return serveKalshiMarket(ticker);
    }

    if (
      url.pathname.startsWith("/kalshi/orderbook/")
    ) {
      const ticker =
        url.pathname.split("/").pop();

      const depth =
        url.searchParams.get("depth") || "10";

      return serveKalshiOrderbook(
        ticker,
        depth
      );
    }

    return json({
      error: "unknown_route",
      routes: [
        "/health",
        "/depthfeed/whoami",
        "/depthfeed/btc15m",
        "/depthfeed/btcspot?from=<ms>&to=<ms>",
        "/kalshi/markets",
        "/kalshi/settlements",
        "/kalshi/market/<ticker>",
        "/kalshi/orderbook/<ticker>?depth=10",
      ],
    }, 404);
  },
};
