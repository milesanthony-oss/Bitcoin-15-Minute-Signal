# BTC 15m Kalshi Relay

Small Cloudflare Worker relay for the BTC 15-minute dashboard.

Routes:
- `/health`
- `/kalshi/markets?...`
- `/kalshi/market/<ticker>`
- `/kalshi/orderbook/<ticker>?depth=10`
