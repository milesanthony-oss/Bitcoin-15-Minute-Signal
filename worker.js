const DF_BASE = "https://api.depthfeed.com/v3";

const mem = {
  lastGood: null,
  lastGoodMs: 0,
  backoffUntil: 0,
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
    headers: cors({
      "Cache-Control": "no-store",
      ...extra,
    }),
  });
}

async function fetchJson(url, options = {}, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const latency = Date.now() - started;
    const text = await response.text();

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
      latency,
      headers: response.headers,
    };
  } finally {
    clearTimeout(timer);
  }
}

function retryMs(headers, fallback = 3000) {
  const n = Number(headers?.get?.("Retry-After"));

  if (Number.isFinite(n) && n > 0) {
    return Math.min(60000, n * 1000);
  }

  return fallback;
}

async function depthfeedGet(env, path) {
  const key = env?.DEPTHFEED_API_KEY;

  if (!key) {
    return {
      missingSecret: true,
    };
  }

  const now = Date.now();

  if (mem.backoffUntil > now) {
    return {
      backoff: true,
      retry_after_ms: mem.backoffUntil - now,
    };
  }

  const result = await fetchJson(
    `${DF_BASE}${path}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
    }
  );

  if (result.status === 429) {
    mem.backoffUntil =
      Date.now() + retryMs(result.headers);
  }

  return result;
}

async function serveWhoami(env) {
  const result = await depthfeedGet(env, "/whoami");

  if (result.missingSecret) {
    return json(
      {
        error: {
          code: "missing_depthfeed_secret",
        },
      },
      500
    );
  }

  if (result.backoff) {
    return json(
      {
        error: {
          code: "depthfeed_backoff",
          retry_after_ms: result.retry_after_ms,
        },
      },
      503
    );
  }

  if (!result.ok) {
    return json(
      result.body || {
        error: `DepthFeed HTTP ${result.status}`,
      },
      result.status || 502
    );
  }

  const data = result.body?.data || {};

  return json(
    {
      data: {
        user_id: data.user_id ?? null,
        plan: data.plan ?? null,
        rps: data.rps ?? null,
        rpm: data.rpm ?? null,
      },
      meta: result.body?.meta ?? null,
    },
    200,
    {
      "X-Upstream": "depthfeed",
      "X-Relay-Latency-Ms": String(result.latency),
    }
  );
}

async function serveBtc15m(env) {
  const now = Date.now();
  const result = await depthfeedGet(env, "/screener/btc/15m");

  if (result.missingSecret) {
    return json(
      {
        error: {
          code: "missing_depthfeed_secret",
        },
      },
      500
    );
  }

  if (result.backoff) {
    if (mem.lastGood) {
      return json(
        {
          ...mem.lastGood,
          relay: {
            cache: "STALE_MEMORY",
            stale: true,
            age_ms: now - mem.lastGoodMs,
            retry_after_ms: result.retry_after_ms,
          },
        },
        200,
        {
          "X-Relay-Cache": "STALE",
          "X-Relay-Stale": "1",
          "X-Upstream": "depthfeed",
        }
      );
    }

    return json(
      {
        error: {
          code: "depthfeed_backoff",
          retry_after_ms: result.retry_after_ms,
        },
      },
      503
    );
  }

  if (!result.ok) {
    if (mem.lastGood) {
      return json(
        {
          ...mem.lastGood,
          relay: {
            cache: "STALE_MEMORY",
            stale: true,
            age_ms: now - mem.lastGoodMs,
            upstream_status: result.status,
          },
        },
        200,
        {
          "X-Relay-Cache": "STALE",
          "X-Relay-Stale": "1",
          "X-Upstream": "depthfeed",
        }
      );
    }

    return json(
      result.body || {
        error: `DepthFeed HTTP ${result.status}`,
      },
      result.status || 502
    );
  }

  const payload = {
    source: "depthfeed",
    asset: "btc",
    window: "15m",
    received_at: new Date().toISOString(),
    data: result.body?.data ?? result.body,
    meta: result.body?.meta ?? null,
  };

  mem.lastGood = payload;
  mem.lastGoodMs = now;

  return json(
    {
      ...payload,
      relay: {
        cache: "MISS",
        stale: false,
        latency_ms: result.latency,
        upstream_status: result.status,
      },
    },
    200,
    {
      "X-Relay-Cache": "MISS",
      "X-Relay-Stale": "0",
      "X-Upstream": "depthfeed",
      "X-Relay-Latency-Ms": String(result.latency),
    }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: cors(),
      });
    }

    if (request.method !== "GET") {
      return json(
        {
          error: "method_not_allowed",
        },
        405
      );
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "btc15m-quant-relay",
        version: "10.0",
        primary_transport: "depthfeed",
        depthfeed_secret_configured: Boolean(
          env?.DEPTHFEED_API_KEY
        ),
        depthfeed_last_good_age_ms: mem.lastGoodMs
          ? Date.now() - mem.lastGoodMs
          : null,
        depthfeed_backoff_ms: Math.max(
          0,
          mem.backoffUntil - Date.now()
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

    return json(
      {
        error: "unknown_route",
        routes: [
          "/health",
          "/depthfeed/whoami",
          "/depthfeed/btc15m",
        ],
      },
      404
    );
  },
};
