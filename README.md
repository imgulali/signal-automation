# Signal

A small local Binance spot → webhook automation desk. Bun, TypeScript, SQLite, and a vanilla frontend. No runtime dependencies, API keys, charts, or trading permissions.

```sh
bun install
bun dev
```

Open **http://localhost:3000**. Use `bun start` to run without file watching. Keep Bun running for automations to work; the browser can be closed.

## Docker

```sh
docker compose up -d --build
```

Open **http://localhost** (the container listens on `8080`, published as host port `80`). The image is tagged `signal:local` and runs as the non-root `bun` user on `oven/bun:1.3.13-alpine`. It contains only the app's runtime files; no dependency installation is needed. Local databases, `.env`, Git history, tests, and `node_modules` are excluded from the image.

Compose keeps SQLite in the `signal-data` named volume and publishes the app on host port `80` across all interfaces, so it is also reachable at the machine's IP (for example **http://192.168.1.33**) with no port number. Set `SIGNAL_PORT` in `.env` to use a different host port. Stop a locally running `bun start` first. The container starts with an empty database; existing local data is not imported automatically.

```sh
docker compose logs -f
docker compose down
```

`docker compose down` retains saved markets and rules in the volume. Webhooks targeting a service on your host machine should use `host.docker.internal` on Docker Desktop. Inside the container, `localhost` refers to the container itself.

To build the image without starting a container:

```sh
docker build -t signal:local .
```

## Use

1. Add a Binance spot pair to your watchlist, such as SOL/USDT.
2. Create an automation with a condition, target price, and HTTP(S) webhook URL.
3. Pause, resume, edit, or remove it from the automation list. Inspect results in Recent activity.

Prices are in the pair's quote currency: `100` for SOL/USDT means 100 USDT per SOL. Removing a market also removes its rules, while keeping delivery history.

## Trigger behavior

| Condition  | Example at a target of 100                       |
| ---------- | ------------------------------------------------ |
| Goes above | 99 → 101 or 100 → 101                            |
| Goes below | 101 → 99 or 100 → 99                             |
| Crosses    | 99 → 101 or 101 → 99; 99 → 100 → 101 also counts |

The first trade after creation, editing, resuming, restarting, or reconnecting establishes a baseline without firing. Above/below fires when price enters that side; remaining there does not fire again. Crosses remembers the last non-equal side, so touching 100 and returning to the same side does not count. Rules automatically re-arm; there is no one-shot mode.

Every received trade is evaluated. Browser updates are batched to four per second. Reconnects use exponential backoff; market changes briefly reconnect the combined stream and reset baselines. Trades missed during downtime are not replayed. With no messages for 90 seconds, the stream reconnects; this can also occur for very quiet pairs. Prices older than 30 seconds are labeled in the watchlist.

## Webhooks

A trigger sends one POST. With Headers and Body left empty, it uses `Content-Type: application/json` and `X-Webhook-Id` matching the payload ID:

```json
{
  "event": "price.triggered",
  "id": "unique-event-id",
  "ruleId": "rule-id",
  "symbol": "SOLUSDT",
  "condition": "above",
  "threshold": 100,
  "price": 100.12,
  "direction": "up",
  "triggeredAt": "2026-09-10T10:30:00.000Z"
}
```

Any 2xx response is success. Requests time out after 10 seconds; redirects are rejected. There are no automatic retries because an unsuccessful response or timeout can still mean the destination acted. A crossing while the same rule has a request in flight is logged as skipped, preventing overlapping calls. A pending delivery interrupted by a restart is marked failed with an unknown outcome. Pausing or removing a rule does not cancel a request already sent.

Headers accepts a JSON object of text values, such as `{"Authorization":"Bearer your-token"}`. Body accepts an optional JSON payload that replaces the default event body. With `Content-Type: application/x-www-form-urlencoded`, the app converts the JSON object's text, number, and boolean fields into URL-encoded form data. For other content types, the JSON text is sent directly. Clearing either field restores its default. Custom `Content-Type` is supported; transport headers and `X-Webhook-Id` are managed automatically. Headers are limited to 8 KB and the body to 32 KB. Both are saved locally with the rule.

## Files & configuration

```text
index.ts                 entry point
src/server.ts            HTTP API and browser WebSocket
src/binance.ts           spot market catalog and trade stream
src/rules.ts             validation and condition engine
src/prices.ts            shared price movement direction
src/webhooks.ts          bounded delivery and outcome recording
src/webhook-body.ts      JSON and URL-encoded form serialization
src/store.ts             SQLite persistence
src/types.ts             shared types
web/                     HTML, CSS, browser TypeScript
tests/automation.test.ts  focused rule, persistence, delivery checks
```

Optional `.env` settings (Bun loads it automatically):

```dotenv
PORT=3000
HOST=127.0.0.1
DATA_PATH=data/automation.sqlite
```

The app binds to `127.0.0.1` by default outside Docker. The Docker image sets `HOST=0.0.0.0` and listens on `8080`, and Compose publishes it on host port `80` for any interface, so anyone who can reach the host can open the control panel. It's a single-user tool with no authentication and it accepts requests from any origin. Webhook URLs, headers, and bodies are stored in the local database, which is gitignored. Do not expose the control panel to the public internet without adding authentication. HTTP endpoints on localhost are supported for development. IBM Plex Sans and the Space Grotesk wordmark are loaded from Google Fonts, with system-font fallbacks.

The latest 200 activity records are retained. “Webhooks sent” counts successful deliveries in that retained history. Up to 50 markets and 100 rules keep the app small.

```sh
bun run check
bun test
```

Uses Binance's public market-data endpoints: [spot stream documentation](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md) and [market-data-only REST documentation](https://github.com/binance/binance-spot-api-docs/blob/master/market-data-only.md), plus [Bun's native WebSocket server](https://bun.com/docs/runtime/http/websockets). Binance access depends on your network and region.
