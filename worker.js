// BTC 15m Kalshi relay — V9.9
// Single-active-ticker architecture:
// - Avoids repeatedly calling Kalshi's broad /markets discovery endpoint.
// - Infers the current BTC 15m ticker from New York time.
// - Caches one active ticker/market for the contract window.
// - Falls back to broad discovery only rarely.
// - Keeps last-good market/orderbook data during 429/5xx windows.
// - No API keys or private credentials are stored here.

const mem = {
  activeTicker: null,
  activeMarket: null,
  activeExpiresMs: 0,
  activeCheckedMs: 0,
  lastDiscoveryMs: 0,
  globalBackoffUntil: 0,
  marketBackoffUntil: new Map(),
};

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra
  };
}

function jsonResponse(data, status = 200, extra = {}) {
  return Response.json(data, {
    status,
    headers: corsHeaders({
      "Cache-Control": "no-store",
      ...extra
    })
  });
}

function responseWithHeaders(resp, extra = {}) {
  return resp.arrayBuffer().then(body => new Response(body, {
    status: resp.status,
    headers: corsHeaders({
      "Content-Type": resp.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
      ...extra
    })
  }));
}

function edgeKey(url, kind, ticker = "") {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  u.searchParams.set("__relay_kind", kind);
  if (ticker) u.searchParams.set("__ticker", ticker);
  return new Request(u.toString(), { method: "GET" });
}

function nyParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "2-digit",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ms));

  const out = {};
  for (const p of parts) out[p.type] = p.value;

  return {
    yy: out.year,
    mon: String(out.month || "").toUpperCase(),
    dd: out.day,
    hh: out.hour === "24" ? "00" : out.hour,
    mm: out.minute
  };
}

function tickerForBoundary(ms) {
  const p = nyParts(ms);
  return `KXBTC15M-${p.yy}${p.mon}${p.dd}${p.hh}${p.mm}`;
}

function inferredTickers(now = Date.now()) {
  const q = 15 * 60 * 1000;
  const floor = Math.floor(now / q) * q;

  return [...new Set([
    tickerForBoundary(floor),
    tickerForBoundary(floor + q),
    tickerForBoundary(floor - q),
    tickerForBoundary(floor + 2 * q)
  ])];
}

function parseMarket(j) {
  if (j?.market) return j.market;
  if (Array.isArray(j?.markets) && j.markets.length) return j.markets[0];
  return null;
}

function marketEndMs(m) {
  const raw =
    m?.close_time ||
    m?.expiration_time ||
    m?.expected_expiration_time ||
    m?.end_time;

  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function marketLooksUsable(m) {
  if (!m?.ticker) return false;

  const s = String(m.status || "").toLowerCase();

  return ![
    "settled",
    "closed",
    "finalized"
  ].includes(s);
}

async function upstreamJson(url, timeoutMs = 4500) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      signal: ac.signal
    });

    const latency = Date.now() - started;
    const text = await r.text();

    let body = null;

    try {
      body = JSON.parse(text);
    } catch (_) {
      body = text;
    }

    if (!r.ok) {
      const e = new Error(
        body?.error?.message ||
        body?.message ||
        body?.error?.code ||
        `HTTP ${r.status}`
      );

      e.status = r.status;
      e.body = body;
      e.latency = latency;

      const retry = Number(
        r.headers.get("Retry-After")
      );

      e.retryAfterMs =
        Number.isFinite(retry) && retry > 0
          ? Math.min(60000, retry * 1000)
          : 0;

      throw e;
    }

    return {
      body,
      status: r.status,
      latency
    };

  } finally {
    clearTimeout(to);
  }
}

function setBackoff(key, error) {
  if (error?.status !== 429) return;

  const ms =
    error.retryAfterMs ||
    10000;

  mem.marketBackoffUntil.set(
    key,
    Date.now() + ms
  );

  mem.globalBackoffUntil = Math.max(
    mem.globalBackoffUntil,
    Date.now() + Math.min(ms, 15000)
  );
}

async function getExactMarket(base, ticker) {
  const now = Date.now();

  const until =
    mem.marketBackoffUntil.get(ticker) ||
    0;

  if (until > now) {
    const e =
      new Error("ticker backoff active");

    e.status = 429;
    e.backoffMs = until - now;

    throw e;
  }

  try {
    const r = await upstreamJson(
      `${base}/markets/${encodeURIComponent(ticker)}`,
      3500
    );

    return {
      market: parseMarket(r.body),
      latency: r.latency,
      source: "exact"
    };

  } catch (e) {
    setBackoff(ticker, e);
    throw e;
  }
}

async function rareBroadDiscovery(base) {
  const now = Date.now();

  if (
    now - mem.lastDiscoveryMs <
    5 * 60 * 1000
  ) {
    return null;
  }

  mem.lastDiscoveryMs = now;

  if (
    mem.globalBackoffUntil >
    now
  ) {
    return null;
  }

  try {
    const r = await upstreamJson(
      `${base}/markets?series_ticker=KXBTC15M&status=open&limit=20`,
      4500
    );

    const arr =
      Array.isArray(r.body?.markets)
        ? r.body.markets
        : [];

    const m =
      arr.find(marketLooksUsable) ||
      arr[0] ||
      null;

    return m
      ? {
          market: m,
          latency: r.latency,
          source: "rare_discovery"
        }
      : null;

  } catch (e) {
    setBackoff("broad", e);
    return null;
  }
}

async function resolveActive(base, force = false) {
  const now = Date.now();

  if (
    !force &&
    mem.activeMarket &&
    marketLooksUsable(mem.activeMarket) &&
    now - mem.activeCheckedMs <
      45 * 1000 &&
    (
      !mem.activeExpiresMs ||
      now <
        mem.activeExpiresMs +
        15 * 1000
    )
  ) {
    return {
      market: mem.activeMarket,
      source: "memory",
      latency: 0,
      cache: "MEMORY"
    };
  }

  if (
    mem.activeTicker &&
    mem.globalBackoffUntil <= now
  ) {
    try {
      const got =
        await getExactMarket(
          base,
          mem.activeTicker
        );

      if (
        marketLooksUsable(
          got.market
        )
      ) {
        mem.activeMarket =
          got.market;

        mem.activeCheckedMs =
          now;

        mem.activeExpiresMs =
          marketEndMs(
            got.market
          );

        return {
          ...got,
          cache: "REFRESH"
        };
      }

    } catch (_) {}
  }

  if (
    mem.globalBackoffUntil <= now
  ) {
    for (
      const ticker of
      inferredTickers(now)
    ) {
      try {
        const got =
          await getExactMarket(
            base,
            ticker
          );

        if (
          marketLooksUsable(
            got.market
          )
        ) {
          mem.activeTicker =
            got.market.ticker;

          mem.activeMarket =
            got.market;

          mem.activeCheckedMs =
            now;

          mem.activeExpiresMs =
            marketEndMs(
              got.market
            );

          return {
            ...got,
            cache: "MISS"
          };
        }

      } catch (e) {
        if (
          e?.status === 429
        ) {
          break;
        }
      }
    }
  }

  const broad =
    await rareBroadDiscovery(
      base
    );

  if (broad?.market) {
    mem.activeTicker =
      broad.market.ticker;

    mem.activeMarket =
      broad.market;

    mem.activeCheckedMs =
      now;

    mem.activeExpiresMs =
      marketEndMs(
        broad.market
      );

    return {
      ...broad,
      cache: "MISS"
    };
  }

  if (mem.activeMarket) {
    return {
      market: mem.activeMarket,
      source: "stale_memory",
      latency: 0,
      cache: "STALE"
    };
  }

  return null;
}

export default {
  async fetch(request) {
    const url =
      new URL(request.url);

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          headers:
            corsHeaders()
        }
      );
    }

    if (
      request.method !==
      "GET"
    ) {
      return jsonResponse(
        {
          error:
            "method_not_allowed"
        },
        405
      );
    }

    if (
      url.pathname === "/" ||
      url.pathname ===
        "/health"
    ) {
      return jsonResponse({
        ok: true,
        service:
          "btc15m-kalshi-relay",
        version: "9.9",
        architecture:
          "single-active-ticker",

        active_ticker:
          mem.activeTicker,

        active_age_ms:
          mem.activeCheckedMs
            ? Date.now() -
              mem.activeCheckedMs
            : null,

        global_backoff_ms:
          Math.max(
            0,
            mem.globalBackoffUntil -
              Date.now()
          ),

        time:
          new Date()
            .toISOString()
      });
    }

    const base =
      "https://external-api.kalshi.com/trade-api/v2";

    const cache =
      caches.default;

    if (
      url.pathname ===
      "/kalshi/active"
    ) {
      const got =
        await resolveActive(
          base,
          url.searchParams.get(
            "force"
          ) === "1"
        );

      if (!got?.market) {
        return jsonResponse(
          {
            error: {
              code:
                "active_market_unavailable",

              message:
                "No active BTC 15m market could be resolved yet"
            },

            inferred_tickers:
              inferredTickers(),

            backoff_ms:
              Math.max(
                0,
                mem.globalBackoffUntil -
                  Date.now()
              )
          },

          503,

          {
            "X-Relay-Cache":
              "MISS",

            "X-Relay-Stale":
              "0"
          }
        );
      }

      return jsonResponse(
        {
          market:
            got.market
        },

        200,

        {
          "X-Relay-Cache":
            got.cache ||
            "MISS",

          "X-Relay-Stale":
            got.source ===
            "stale_memory"
              ? "1"
              : "0",

          "X-Relay-Source":
            got.source,

          "X-Relay-Latency-Ms":
            String(
              got.latency ||
              0
            ),

          "X-Upstream-Status":
            "200"
        }
      );
    }

    if (
      url.pathname ===
        "/kalshi/markets" &&
      String(
        url.searchParams.get(
          "series_ticker"
        ) || ""
      ).toUpperCase() ===
        "KXBTC15M"
    ) {
      const got =
        await resolveActive(
          base,
          false
        );

      if (!got?.market) {
        return jsonResponse(
          {
            error: {
              code:
                "active_market_unavailable",

              message:
                "No active BTC 15m market could be resolved yet"
            },

            markets: [],

            inferred_tickers:
              inferredTickers(),

            backoff_ms:
              Math.max(
                0,
                mem.globalBackoffUntil -
                  Date.now()
              )
          },

          503,

          {
            "X-Relay-Cache":
              "MISS",

            "X-Relay-Stale":
              "0"
          }
        );
      }

      return jsonResponse(
        {
          markets:
            [got.market]
        },

        200,

        {
          "X-Relay-Cache":
            got.cache ||
            "MISS",

          "X-Relay-Stale":
            got.source ===
            "stale_memory"
              ? "1"
              : "0",

          "X-Relay-Source":
            got.source,

          "X-Relay-Latency-Ms":
            String(
              got.latency ||
              0
            ),

          "X-Upstream-Status":
            "200"
        }
      );
    }

    if (
      url.pathname.startsWith(
        "/kalshi/market/"
      )
    ) {
      const ticker =
        url.pathname
          .split("/")
          .pop();

      if (
        ticker &&
        mem.activeTicker ===
          ticker &&
        mem.activeMarket
      ) {
        return jsonResponse(
          {
            market:
              mem.activeMarket
          },

          200,

          {
            "X-Relay-Cache":
              "MEMORY",

            "X-Relay-Stale":
              "0",

            "X-Relay-Source":
              "active_memory",

            "X-Relay-Latency-Ms":
              "0",

            "X-Upstream-Status":
              "200"
          }
        );
      }

      try {
        const got =
          await getExactMarket(
            base,
            ticker
          );

        if (got.market) {
          if (
            marketLooksUsable(
              got.market
            )
          ) {
            mem.activeTicker =
              got.market.ticker;

            mem.activeMarket =
              got.market;

            mem.activeCheckedMs =
              Date.now();

            mem.activeExpiresMs =
              marketEndMs(
                got.market
              );
          }

          return jsonResponse(
            {
              market:
                got.market
            },

            200,

            {
              "X-Relay-Cache":
                "MISS",

              "X-Relay-Stale":
                "0",

              "X-Relay-Source":
                "exact",

              "X-Relay-Latency-Ms":
                String(
                  got.latency ||
                  0
                ),

              "X-Upstream-Status":
                "200"
            }
          );
        }

      } catch (e) {
        return jsonResponse(
          e.body ||
          {
            error:
              e.message
          },

          e.status ||
          502,

          {
            "X-Relay-Cache":
              "MISS",

            "X-Relay-Stale":
              "0",

            "X-Upstream-Status":
              String(
                e.status ||
                502
              )
          }
        );
      }
    }

    if (
      url.pathname.startsWith(
        "/kalshi/orderbook/"
      )
    ) {
      const ticker =
        url.pathname
          .split("/")
          .pop();

      const depth =
        url.searchParams.get(
          "depth"
        ) || "10";

      const freshKey =
        edgeKey(
          request.url,
          "book-fresh",
          ticker
        );

      const staleKey =
        edgeKey(
          request.url,
          "book-stale",
          ticker
        );

      const fresh =
        await cache.match(
          freshKey
        );

      if (fresh) {
        return responseWithHeaders(
          fresh,
          {
            "X-Relay-Cache":
              "HIT",

            "X-Relay-Stale":
              "0",

            "X-Relay-Source":
              "edge",

            "X-Upstream-Status":
              "200"
          }
        );
      }

      if (
        mem.globalBackoffUntil >
        Date.now()
      ) {
        const stale =
          await cache.match(
            staleKey
          );

        if (stale) {
          return responseWithHeaders(
            stale,
            {
              "X-Relay-Cache":
                "STALE",

              "X-Relay-Stale":
                "1",

              "X-Relay-Source":
                "edge_stale",

              "X-Upstream-Status":
                "429"
            }
          );
        }
      }

      try {
        const started =
          Date.now();

        const upstream =
          await fetch(
            `${base}/markets/${encodeURIComponent(ticker)}` +
            `/orderbook?depth=${encodeURIComponent(depth)}`,

            {
              headers: {
                "Accept":
                  "application/json"
              }
            }
          );

        const latency =
          Date.now() -
          started;

        const body =
          await upstream.arrayBuffer();

        const ct =
          upstream.headers.get(
            "Content-Type"
          ) ||
          "application/json";

        if (upstream.ok) {
          const freshResp =
            new Response(
              body.slice(0),
              {
                status: 200,

                headers: {
                  "Content-Type":
                    ct,

                  "Cache-Control":
                    "public, max-age=3"
                }
              }
            );

          const staleResp =
            new Response(
              body.slice(0),
              {
                status: 200,

                headers: {
                  "Content-Type":
                    ct,

                  "Cache-Control":
                    "public, max-age=30"
                }
              }
            );

          await Promise.all([
            cache.put(
              freshKey,
              freshResp
            ),

            cache.put(
              staleKey,
              staleResp
            )
          ]);

          return new Response(
            body,
            {
              status: 200,

              headers:
                corsHeaders({
                  "Content-Type":
                    ct,

                  "Cache-Control":
                    "no-store",

                  "X-Relay-Cache":
                    "MISS",

                  "X-Relay-Stale":
                    "0",

                  "X-Relay-Source":
                    "upstream",

                  "X-Relay-Latency-Ms":
                    String(
                      latency
                    ),

                  "X-Upstream-Status":
                    "200"
                })
            }
          );
        }

        if (
          upstream.status ===
          429
        ) {
          const retry =
            Number(
              upstream.headers.get(
                "Retry-After"
              )
            );

          const backoff =
            Number.isFinite(
              retry
            ) &&
            retry > 0

              ? Math.min(
                  30000,
                  retry * 1000
                )

              : 7500;

          mem.globalBackoffUntil =
            Math.max(
              mem.globalBackoffUntil,
              Date.now() +
                backoff
            );

          const stale =
            await cache.match(
              staleKey
            );

          if (stale) {
            return responseWithHeaders(
              stale,
              {
                "X-Relay-Cache":
                  "STALE",

                "X-Relay-Stale":
                  "1",

                "X-Relay-Source":
                  "edge_stale",

                "X-Relay-Latency-Ms":
                  String(
                    latency
                  ),

                "X-Upstream-Status":
                  "429"
              }
            );
          }
        }

        return new Response(
          body,
          {
            status:
              upstream.status,

            headers:
              corsHeaders({
                "Content-Type":
                  ct,

                "Cache-Control":
                  "no-store",

                "X-Relay-Cache":
                  "MISS",

                "X-Relay-Stale":
                  "0",

                "X-Relay-Latency-Ms":
                  String(
                    latency
                  ),

                "X-Upstream-Status":
                  String(
                    upstream.status
                  )
              })
          }
        );

      } catch (error) {
        const stale =
          await cache.match(
            staleKey
          );

        if (stale) {
          return responseWithHeaders(
            stale,
            {
              "X-Relay-Cache":
                "STALE",

              "X-Relay-Stale":
                "1",

              "X-Relay-Source":
                "edge_stale",

              "X-Upstream-Status":
                "network_error"
            }
          );
        }

        return jsonResponse(
          {
            error:
              "kalshi_fetch_failed",

            message:
              String(
                error
              )
          },

          502,

          {
            "X-Relay-Cache":
              "MISS",

            "X-Relay-Stale":
              "0",

            "X-Upstream-Status":
              "network_error"
          }
        );
      }
    }

    return jsonResponse(
      {
        error:
          "unknown_route",

        path:
          url.pathname
      },

      404
    );
  }
};
