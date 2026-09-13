// BTC 15m Quant Relay — V11.1
// DepthFeed + Kalshi + Robinhood public-web observer.
// Secret required in Cloudflare: DEPTHFEED_API_KEY
// Robinhood web parsing is read-only and intentionally fails closed if identity/quote parsing is uncertain.

const DF_BASE = "https://api.depthfeed.com/v3";
const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";
const RH_BTC = "https://robinhood.com/us/en/prediction-markets/crypto/btc/";
const RH_ORIGIN = "https://robinhood.com";

const mem = {
  dfLastGood: null,
  dfLastGoodMs: 0,
  dfBackoffUntil: 0,
  kalshiBackoffUntil: 0,
  kalshiLastGoodMarket: null,
  kalshiLastGoodOrderbook: new Map(),
  kalshiSettledCache: null,
  kalshiSettledCacheMs: 0,
  rhLastGood: null,
  rhLastGoodMs: 0,
  rhBusy: null,
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
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();

  try {
    const r = await fetch(url, {
      ...options,
      signal: ac.signal,
    });

    const latency = Date.now() - started;
    const text = await r.text();

    let body;

    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return {
      ok: r.ok,
      status: r.status,
      body,
      latency,
      headers: r.headers,
    };
  } finally {
    clearTimeout(to);
  }
}

async function fetchText(url, options = {}, timeoutMs = 6500) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();

  try {
    const r = await fetch(url, {
      ...options,
      signal: ac.signal,
    });

    const text = await r.text();

    return {
      ok: r.ok,
      status: r.status,
      text,
      latency: Date.now() - started,
      headers: r.headers,
      url: r.url,
    };
  } finally {
    clearTimeout(to);
  }
}

function retryMs(headers, fallback) {
  const n = Number(headers?.get?.("Retry-After"));

  return Number.isFinite(n) && n > 0
    ? Math.min(60000, n * 1000)
    : fallback;
}

function dfKey(env) {
  return env?.DEPTHFEED_API_KEY || null;
}

async function depthfeedGet(env, path) {
  const key = dfKey(env);

  if (!key) {
    return {
      missingSecret: true,
    };
  }

  const now = Date.now();

  if (mem.dfBackoffUntil > now) {
    return {
      backoff: true,
      retry_after_ms: mem.dfBackoffUntil - now,
    };
  }

  const r = await fetchJson(
    `${DF_BASE}${path}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
    }
  );

  if (r.status === 429) {
    mem.dfBackoffUntil =
      Date.now() +
      retryMs(r.headers, 3000);
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
    price_to_beat:
      data.price_to_beat ?? null,
    spot:
      data.spot ??
      data.underlying ??
      null,
    books:
      data.books ?? {},
    meta:
      body?.meta ?? null,
    raw: body,
  };
}

async function serveWhoami(env) {
  const r = await depthfeedGet(
    env,
    "/whoami"
  );

  if (r.missingSecret) {
    return json({
      error: {
        code:
          "missing_depthfeed_secret",
      },
    }, 500);
  }

  if (r.backoff) {
    return json({
      error: {
        code: "depthfeed_backoff",
        retry_after_ms:
          r.retry_after_ms,
      },
    }, 503);
  }

  if (!r.ok) {
    return json(
      r.body || {
        error:
          `DepthFeed HTTP ${r.status}`,
      },
      r.status || 502
    );
  }

  const d =
    r.body?.data || {};

  return json({
    data: {
      user_id:
        d.user_id ?? null,
      plan:
        d.plan ?? null,
      rps:
        d.rps ?? null,
      rpm:
        d.rpm ?? null,
      history_days:
        d.history_days ?? null,
      coins:
        d.coins ?? null,
      sports:
        d.sports ?? null,
      bars:
        d.bars ?? null,
    },
    meta:
      r.body?.meta ?? null,
  }, 200, {
    "X-Upstream":
      "depthfeed",
    "X-Relay-Latency-Ms":
      String(r.latency),
  });
}

async function serveBtc15m(env) {
  const now = Date.now();

  const r =
    await depthfeedGet(
      env,
      "/screener/btc/15m"
    );

  if (r.missingSecret) {
    return json({
      error: {
        code:
          "missing_depthfeed_secret",
      },
    }, 500);
  }

  if (r.backoff) {
    if (mem.dfLastGood) {
      return json({
        ...mem.dfLastGood,
        relay: {
          cache:
            "STALE_MEMORY",
          stale: true,
          age_ms:
            now -
            mem.dfLastGoodMs,
          retry_after_ms:
            r.retry_after_ms,
        },
      }, 200, {
        "X-Relay-Cache":
          "STALE",
        "X-Relay-Stale":
          "1",
        "X-Upstream":
          "depthfeed",
      });
    }

    return json({
      error: {
        code:
          "depthfeed_backoff",
        retry_after_ms:
          r.retry_after_ms,
      },
    }, 503);
  }

  if (r.ok) {
    const normalized =
      normalizeScreener(
        r.body
      );

    mem.dfLastGood =
      normalized;
    mem.dfLastGoodMs =
      now;

    return json({
      ...normalized,
      relay: {
        cache: "MISS",
        stale: false,
        latency_ms:
          r.latency,
        upstream_status:
          r.status,
      },
    }, 200, {
      "X-Relay-Cache":
        "MISS",
      "X-Relay-Stale":
        "0",
      "X-Upstream":
        "depthfeed",
      "X-Relay-Latency-Ms":
        String(r.latency),
    });
  }

  if (mem.dfLastGood) {
    return json({
      ...mem.dfLastGood,
      relay: {
        cache:
          "STALE_MEMORY",
        stale: true,
        age_ms:
          now -
          mem.dfLastGoodMs,
        latency_ms:
          r.latency,
        upstream_status:
          r.status,
      },
    }, 200, {
      "X-Relay-Cache":
        "STALE",
      "X-Relay-Stale":
        "1",
      "X-Upstream":
        "depthfeed",
    });
  }

  return json(
    r.body || {
      error:
        `DepthFeed HTTP ${r.status}`,
    },
    r.status || 502
  );
}

async function serveBtcSpot(
  env,
  url
) {
  const now = Date.now();

  const from =
    Number(
      url.searchParams.get(
        "from"
      ) ||
      (now - 65000)
    );

  const to =
    Number(
      url.searchParams.get(
        "to"
      ) ||
      now
    );

  const a =
    Math.max(
      now - 180000,
      Math.min(from, to)
    );

  const b =
    Math.min(
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

  const r =
    await depthfeedGet(
      env,
      path
    );

  if (r.missingSecret) {
    return json({
      error: {
        code:
          "missing_depthfeed_secret",
      },
    }, 500);
  }

  if (r.backoff) {
    return json({
      error: {
        code:
          "depthfeed_backoff",
        retry_after_ms:
          r.retry_after_ms,
      },
    }, 503);
  }

  if (!r.ok) {
    return json(
      r.body || {
        error:
          `DepthFeed HTTP ${r.status}`,
      },
      r.status || 502
    );
  }

  return json(
    r.body || {
      data: [],
    },
    200,
    {
      "X-Upstream":
        "depthfeed-spot-1s",
      "X-Relay-Latency-Ms":
        String(r.latency),
    }
  );
}

async function kalshiGet(path) {
  const now = Date.now();

  if (
    mem.kalshiBackoffUntil >
    now
  ) {
    return {
      backoff: true,
      retry_after_ms:
        mem.kalshiBackoffUntil -
        now,
    };
  }

  const r =
    await fetchJson(
      `${KALSHI_BASE}${path}`,
      {
        headers: {
          Accept:
            "application/json",
        },
      },
      4500
    );

  if (r.status === 429) {
    mem.kalshiBackoffUntil =
      Date.now() +
      retryMs(
        r.headers,
        10000
      );
  }

  return r;
}

async function serveKalshiMarkets(
  url
) {
  const qs =
    new URLSearchParams();

  for (
    const [k, v]
    of url.searchParams.entries()
  ) {
    if (
      [
        "series_ticker",
        "status",
        "limit",
        "tickers",
      ].includes(k)
    ) {
      qs.set(k, v);
    }
  }

  if (
    !qs.has("series_ticker")
  ) {
    qs.set(
      "series_ticker",
      "KXBTC15M"
    );
  }

  if (!qs.has("status")) {
    qs.set(
      "status",
      "open"
    );
  }

  if (!qs.has("limit")) {
    qs.set(
      "limit",
      "20"
    );
  }

  const r =
    await kalshiGet(
      `/markets?${qs}`
    );

  if (r.backoff) {
    if (
      mem.kalshiLastGoodMarket
    ) {
      return json({
        markets: [
          mem.kalshiLastGoodMarket,
        ],
      }, 200, {
        "X-Relay-Cache":
          "STALE_MEMORY",
        "X-Relay-Stale":
          "1",
      });
    }

    return json({
      error: {
        code:
          "kalshi_backoff",
        retry_after_ms:
          r.retry_after_ms,
      },
      markets: [],
    }, 503);
  }

  if (r.ok) {
    const m =
      r.body?.market ||
      r.body?.markets?.[0] ||
      null;

    if (m) {
      mem.kalshiLastGoodMarket =
        m;
    }

    return json(
      r.body,
      200,
      {
        "X-Upstream":
          "kalshi",
        "X-Relay-Latency-Ms":
          String(r.latency),
      }
    );
  }

  return json(
    r.body || {
      error:
        `Kalshi HTTP ${r.status}`,
    },
    r.status || 502
  );
}

async function serveKalshiSettlements(
  url
) {
  const now = Date.now();

  const limit =
    Math.min(
      100,
      Math.max(
        1,
        Number(
          url.searchParams.get(
            "limit"
          ) ||
          50
        )
      )
    );

  if (
    mem.kalshiSettledCache &&
    now -
      mem.kalshiSettledCacheMs <
      20000
  ) {
    return json(
      mem.kalshiSettledCache,
      200,
      {
        "X-Relay-Cache":
          "HIT",
        "X-Upstream":
          "kalshi",
      }
    );
  }

  const r =
    await kalshiGet(
      `/markets?series_ticker=KXBTC15M&status=settled&limit=${limit}`
    );

  if (r.backoff) {
    if (
      mem.kalshiSettledCache
    ) {
      return json(
        mem.kalshiSettledCache,
        200,
        {
          "X-Relay-Cache":
            "STALE_MEMORY",
          "X-Relay-Stale":
            "1",
          "X-Upstream":
            "kalshi",
        }
      );
    }

    return json({
      error: {
        code:
          "kalshi_backoff",
        retry_after_ms:
          r.retry_after_ms,
      },
      markets: [],
    }, 503);
  }

  if (r.ok) {
    const body =
      r.body || {
        markets: [],
      };

    mem.kalshiSettledCache =
      body;

    mem.kalshiSettledCacheMs =
      now;

    return json(
      body,
      200,
      {
        "X-Relay-Cache":
          "MISS",
        "X-Upstream":
          "kalshi",
        "X-Relay-Latency-Ms":
          String(r.latency),
      }
    );
  }

  if (
    mem.kalshiSettledCache
  ) {
    return json(
      mem.kalshiSettledCache,
      200,
      {
        "X-Relay-Cache":
          "STALE_MEMORY",
        "X-Relay-Stale":
          "1",
        "X-Upstream":
          "kalshi",
      }
    );
  }

  return json(
    r.body || {
      error:
        `Kalshi HTTP ${r.status}`,
      markets: [],
    },
    r.status || 502
  );
}

async function serveKalshiMarket(
  ticker
) {
  const r =
    await kalshiGet(
      `/markets/${encodeURIComponent(
        ticker
      )}`
    );

  if (r.backoff) {
    return json({
      error: {
        code:
          "kalshi_backoff",
        retry_after_ms:
          r.retry_after_ms,
      },
    }, 503);
  }

  if (r.ok) {
    const m =
      r.body?.market ||
      null;

    if (m) {
      mem.kalshiLastGoodMarket =
        m;
    }

    return json(
      r.body,
      200,
      {
        "X-Upstream":
          "kalshi",
        "X-Relay-Latency-Ms":
          String(r.latency),
      }
    );
  }

  return json(
    r.body || {
      error:
        `Kalshi HTTP ${r.status}`,
    },
    r.status || 502
  );
}

async function serveKalshiOrderbook(
  ticker,
  depth
) {
  const key =
    `${ticker}|${depth}`;

  const now =
    Date.now();

  const r =
    await kalshiGet(
      `/markets/${encodeURIComponent(
        ticker
      )}/orderbook?depth=${encodeURIComponent(
        depth
      )}`
    );

  if (r.backoff) {
    const c =
      mem.kalshiLastGoodOrderbook.get(
        key
      );

    if (c) {
      return json(
        c.body,
        200,
        {
          "X-Relay-Cache":
            "STALE_MEMORY",
          "X-Relay-Stale":
            "1",
          "X-Relay-Age-Ms":
            String(
              now -
              c.ts
            ),
        }
      );
    }

    return json({
      error: {
        code:
          "kalshi_backoff",
        retry_after_ms:
          r.retry_after_ms,
      },
    }, 503);
  }

  if (r.ok) {
    mem.kalshiLastGoodOrderbook.set(
      key,
      {
        body:
          r.body,
        ts:
          now,
      }
    );

    return json(
      r.body,
      200,
      {
        "X-Upstream":
          "kalshi",
        "X-Relay-Latency-Ms":
          String(r.latency),
      }
    );
  }

  const c =
    mem.kalshiLastGoodOrderbook.get(
      key
    );

  if (c) {
    return json(
      c.body,
      200,
      {
        "X-Relay-Cache":
          "STALE_MEMORY",
        "X-Relay-Stale":
          "1",
        "X-Relay-Age-Ms":
          String(
            now -
            c.ts
        ),
      }
    );
  }

  return json(
    r.body || {
      error:
        `Kalshi HTTP ${r.status}`,
    },
    r.status || 502
  );
}

// ---- Robinhood public web observer ----

function decodeHtml(s = "") {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&cent;/gi, "¢")
    .replace(
      /&middot;|&#183;|&#xB7;/gi,
      "·"
    )
    .replace(
      /&#8211;|&#x2013;/gi,
      "–"
    )
    .replace(
      /&#8212;|&#x2014;/gi,
      "—"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;|&apos;/gi,
      "'"
    )
    .replace(
      /\u0026/g,
      "&"
    )
    .replace(
      /\\u002F/g,
      "/"
    )
    .replace(
      /\\\//g,
      "/"
    );
}

function htmlText(html = "") {
  return decodeHtml(html)
    .replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function num(s) {
  const n =
    Number(
      String(
        s ?? ""
      ).replace(
        /,/g,
        ""
      )
    );

  return Number.isFinite(n)
    ? n
    : null;
}

function parseEasternDate(
  dateStr,
  timeStr,
  ampm,
  tz
) {
  const stamp =
    `${dateStr} ${timeStr} ${ampm} ${tz}`;

  const ms =
    Date.parse(stamp);

  return Number.isFinite(ms)
    ? ms
    : null;
}

function extractRhLinks(html) {
  const d =
    decodeHtml(html);

  const out = [];
  const seen =
    new Set();

  const re =
    /(?:https:\/\/robinhood\.com)?(\/us\/en\/prediction-markets\/crypto\/events\/btc-15-min-[a-z0-9-]+\/?)/gi;

  let m;

  while (
    (m = re.exec(d))
  ) {
    const p =
      m[1];

    if (
      !seen.has(p)
    ) {
      seen.add(p);

      out.push(
        RH_ORIGIN + p
      );
    }
  }

  return out.slice(
    0,
    10
  );
}

function parseRobinhoodEvent(
  html,
  url,
  headers
) {
  const text =
    htmlText(html);

  const targetM =
    text.match(
      /\$([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)\s+or above/i
    );

  const target =
    targetM
      ? num(targetM[1])
      : null;

  let endMs =
    null;

  let endLabel =
    null;

  const about =
    [
      ...text.matchAll(
        /before\s+([0-9]{1,2}:[0-9]{2})\s*(AM|PM)\s*(EDT|EST)\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/gi
      ),
    ];

  if (about.length) {
    const a =
      about[0];

    endMs =
      parseEasternDate(
        a[4],
        a[1],
        a[2],
        a[3]
      );

    endLabel =
      `${a[1]} ${a[2]} ${a[3]} • ${a[4]}`;
  }

  if (
    endMs == null
  ) {
    const title =
      text.match(
        /BTC 15 min\s*[·•]\s*([0-9]{1,2}:[0-9]{2})\s*[–-]\s*([0-9]{1,2}:[0-9]{2})\s*(AM|PM)\s*(EDT|EST)/i
      );

    const day =
      text.match(
        /(?:Event day\s*)?([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i
      );

    if (
      title &&
      day
    ) {
      endMs =
        parseEasternDate(
          day[1],
          title[2],
          title[3],
          title[4]
        );

      endLabel =
        `${title[2]} ${title[3]} ${title[4]} • ${day[1]}`;
    }
  }

  const ba =
    text.match(
      /Bid\s*([0-9]+(?:\.[0-9]+)?)\s*¢\s*[·•]\s*Ask\s*([0-9]+(?:\.[0-9]+)?)\s*¢/i
    );

  const yesBid =
    ba
      ? num(
          ba[1]
        ) / 100
      : null;

  const yesAsk =
    ba
      ? num(
          ba[2]
        ) / 100
      : null;

  const noAsk =
    yesBid == null
      ? null
      : 1 -
        yesBid;

  const noBid =
    yesAsk == null
      ? null
      : 1 -
        yesAsk;

  const ageSec =
    num(
      headers?.get?.(
        "Age"
      )
    ) ?? 0;

  const titleM =
    text.match(
      /BTC 15 min\s*[·•]\s*[^$]{1,80}/i
    );

  return {
    source:
      "robinhood-public-web",

    event_url:
      url,

    title:
      titleM?.[0]?.trim() ||
      null,

    target,

    end_ms:
      endMs,

    end_iso:
      endMs
        ? new Date(
            endMs
          ).toISOString()
        : null,

    end_label:
      endLabel,

    yes_bid:
      yesBid,

    yes_ask:
      yesAsk,

    no_bid:
      noBid,

    no_ask:
      noAsk,

    quote_ok:
      yesBid != null &&
      yesAsk != null &&
      yesAsk >= yesBid &&
      yesAsk > 0 &&
      yesAsk < 1,

    identity_ok:
      target != null &&
      endMs != null,

    upstream_age_s:
      ageSec,

    parsed_at:
      new Date().toISOString(),
  };
}

async function scrapeRobinhood() {
  const headers = {
    Accept:
      "text/html,application/xhtml+xml",

    "User-Agent":
      "Mozilla/5.0 (compatible; BTC15mDashboard/11.1; +https://pages.github.com)",

    "Cache-Control":
      "no-cache",
  };

  const listing =
    await fetchText(
      RH_BTC,
      {
        headers,
        redirect:
          "follow",
      },
      7000
    );

  if (
    !listing.ok
  ) {
    throw Error(
      `Robinhood listing HTTP ${listing.status}`
    );
  }

  const links =
    extractRhLinks(
      listing.text
    );

  if (
    !links.length
  ) {
    throw Error(
      "No BTC 15m event links found on Robinhood BTC page"
    );
  }

  const pages =
    await Promise.all(
      links
        .slice(0, 6)
        .map(
          async u => {
            try {
              const r =
                await fetchText(
                  u,
                  {
                    headers,
                    redirect:
                      "follow",
                  },
                  6500
                );

              return r.ok
                ? parseRobinhoodEvent(
                    r.text,
                    u,
                    r.headers
                  )
                : null;
            } catch {
              return null;
            }
          }
        )
    );

  const now =
    Date.now();

  const valid =
    pages.filter(Boolean);

  const current =
    valid
      .filter(
        x =>
          x.end_ms &&
          x.end_ms >
            now -
              15000 &&
          x.end_ms <
            now +
              20 *
                60 *
                1000
      )
      .sort(
        (a, b) =>
          a.end_ms -
          b.end_ms
      )[0] ||

    valid
      .filter(
        x =>
          x.identity_ok
      )
      .sort(
        (a, b) =>
          Math.abs(
            (a.end_ms ||
              0) -
              now
          ) -
          Math.abs(
            (b.end_ms ||
              0) -
              now
          )
      )[0] ||

    valid[0];

  if (
    !current
  ) {
    throw Error(
      "Robinhood event pages could not be parsed"
    );
  }

  return {
    ...current,

    listing_url:
      RH_BTC,

    candidates_checked:
      valid.length,

    live_window:
      current.end_ms
        ? current.end_ms >
            now -
              15000 &&
          current.end_ms <
            now +
              20 *
                60 *
                1000
        : false,

    stale:
      current.upstream_age_s >
      12,
  };
}

async function serveRobinhoodBtc15m() {
  const now =
    Date.now();

  if (
    mem.rhLastGood &&
    now -
      mem.rhLastGoodMs <
      1800
  ) {
    return json({
      ...mem.rhLastGood,

      relay: {
        cache:
          "HIT",

        age_ms:
          now -
          mem.rhLastGoodMs,
      },
    }, 200, {
      "X-Relay-Cache":
        "HIT",

      "X-Upstream":
        "robinhood-public-web",
    });
  }

  if (
    mem.rhBusy
  ) {
    try {
      const d =
        await mem.rhBusy;

      return json({
        ...d,

        relay: {
          cache:
            "COALESCED",

          age_ms:
            Date.now() -
            mem.rhLastGoodMs,
        },
      }, 200, {
        "X-Relay-Cache":
          "COALESCED",

        "X-Upstream":
          "robinhood-public-web",
      });
    } catch {}
  }

  mem.rhBusy =
    (async () => {
      const d =
        await scrapeRobinhood();

      mem.rhLastGood =
        d;

      mem.rhLastGoodMs =
        Date.now();

      return d;
    })();

  try {
    const d =
      await mem.rhBusy;

    return json({
      ...d,

      relay: {
        cache:
          "MISS",

        age_ms:
          0,
      },
    }, 200, {
      "X-Relay-Cache":
        "MISS",

      "X-Relay-Stale":
        d.stale
          ? "1"
          : "0",

      "X-Upstream":
        "robinhood-public-web",
    });
  } catch (e) {
    if (
      mem.rhLastGood &&
      now -
        mem.rhLastGoodMs <
        20000
    ) {
      return json({
        ...mem.rhLastGood,

        stale:
          true,

        relay: {
          cache:
            "STALE_MEMORY",

          age_ms:
            now -
            mem.rhLastGoodMs,

          error:
            String(
              e?.message ||
              e
            ),
        },
      }, 200, {
        "X-Relay-Cache":
          "STALE",

        "X-Relay-Stale":
          "1",

        "X-Upstream":
          "robinhood-public-web",
      });
    }

    return json({
      error: {
        code:
          "robinhood_parse_unavailable",

        message:
          String(
            e?.message ||
            e
          ),
      },
    }, 502);
  } finally {
    mem.rhBusy =
      null;
  }
}

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          headers:
            cors(),
        }
      );
    }

    if (
      request.method !==
      "GET"
    ) {
      return json({
        error:
          "method_not_allowed",
      }, 405);
    }

    if (
      url.pathname ===
        "/" ||
      url.pathname ===
        "/health"
    ) {
      return json({
        ok:
          true,

        service:
          "btc15m-quant-relay",

        version:
          "11.1",

        primary_transport:
          "depthfeed",

        robinhood_observer:
          "public-web-read-only",

        depthfeed_secret_configured:
          Boolean(
            env?.DEPTHFEED_API_KEY
          ),

        depthfeed_last_good_age_ms:
          mem.dfLastGoodMs
            ? Date.now() -
              mem.dfLastGoodMs
            : null,

        robinhood_last_good_age_ms:
          mem.rhLastGoodMs
            ? Date.now() -
              mem.rhLastGoodMs
            : null,

        depthfeed_backoff_ms:
          Math.max(
            0,
            mem.dfBackoffUntil -
              Date.now()
          ),

        kalshi_backoff_ms:
          Math.max(
            0,
            mem.kalshiBackoffUntil -
              Date.now()
          ),

        time:
          new Date().toISOString(),
      });
    }

    if (
      url.pathname ===
      "/depthfeed/whoami"
    ) {
      return serveWhoami(
        env
      );
    }

    if (
      url.pathname ===
      "/depthfeed/btc15m"
    ) {
      return serveBtc15m(
        env
      );
    }

    if (
      url.pathname ===
      "/depthfeed/btcspot"
    ) {
      return serveBtcSpot(
        env,
        url
      );
    }

    if (
      url.pathname ===
      "/robinhood/btc15m"
    ) {
      return serveRobinhoodBtc15m();
    }

    if (
      url.pathname ===
      "/kalshi/markets"
    ) {
      return serveKalshiMarkets(
        url
      );
    }

    if (
      url.pathname ===
      "/kalshi/settlements"
    ) {
      return serveKalshiSettlements(
        url
      );
    }

    if (
      url.pathname.startsWith(
        "/kalshi/market/"
      )
    ) {
      return serveKalshiMarket(
        url.pathname
          .split("/")
          .pop()
      );
    }

    if (
      url.pathname.startsWith(
        "/kalshi/orderbook/"
      )
    ) {
      return serveKalshiOrderbook(
        url.pathname
          .split("/")
          .pop(),

        url.searchParams.get(
          "depth"
        ) ||
        "10"
      );
    }

    return json({
      error:
        "unknown_route",

      routes: [
        "/health",
        "/robinhood/btc15m",
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
