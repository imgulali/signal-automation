import { BinanceStream, getMarkets } from "./binance";
import { InputError, RuleEngine, validateRule } from "./rules";
import { Store } from "./store";
import { Webhooks } from "./webhooks";
import { priceDirection } from "./prices";
import type { Rule, Snapshot } from "./types";

export async function start() {
  const build = await Bun.build({
    entrypoints: ["./web/app.ts"],
    target: "browser",
    minify: true,
  });
  if (!build.success)
    throw new Error(`Frontend build failed: ${build.logs.join("\n")}`);
  const script = await build.outputs[0]!.text();
  const store = new Store(process.env.DATA_PATH || "data/automation.sqlite");
  const engine = new RuleEngine();
  const state: Snapshot = {
    markets: store.markets(),
    rules: store.rules(),
    deliveries: store.deliveries(),
    quotes: {},
    stream: { status: "idle", message: "Add a market to start listening" },
  };
  let dirty = true;
  const webhooks = new Webhooks((delivery) => {
    store.saveDelivery(delivery);
    state.deliveries = store.deliveries();
    dirty = true;
  });
  const stream = new BinanceStream(
    (symbol, price, time) => {
      const previous = state.quotes[symbol];
      if (previous && time < previous.time) return;
      state.quotes[symbol] = {
        price,
        time,
        direction: priceDirection(price, previous?.price, previous?.direction),
      };
      for (const rule of state.rules) {
        if (rule.symbol === symbol && engine.tick(rule, price))
          webhooks.send(rule, price, time);
      }
      dirty = true;
    },
    (status) => {
      state.stream = status;
      dirty = true;
    },
    () => {
      engine.reset();
      state.quotes = {};
      dirty = true;
    },
  );

  function refresh(marketsChanged = false) {
    state.markets = store.markets();
    state.rules = store.rules();
    if (marketsChanged) stream.setMarkets(state.markets.map((m) => m.symbol));
    dirty = true;
  }

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (!request.headers.get("content-type")?.includes("application/json"))
      throw new InputError(
        "Send JSON with Content-Type: application/json.",
        415,
      );
    try {
      const value = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value;
    } catch {
      throw new InputError("Invalid JSON request.");
    }
  }

  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  const server = Bun.serve({
    hostname: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3000),
    maxRequestBodySize: 65_536,
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/ws" && request.method === "GET") {
          if (server.upgrade(request)) return;
          throw new InputError("WebSocket upgrade required.", 426);
        }
        if (request.method === "GET") {
          if (url.pathname === "/")
            return new Response(Bun.file("web/index.html"), {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          if (url.pathname === "/app.js")
            return new Response(script, {
              headers: { "Content-Type": "text/javascript; charset=utf-8" },
            });
          if (url.pathname === "/styles.css")
            return new Response(Bun.file("web/styles.css"));
          if (url.pathname === "/api/state") return json(state);
          if (url.pathname === "/api/markets") return json(await getMarkets());
        }
        if (url.pathname === "/api/markets" && request.method === "POST") {
          const input = await body(request);
          const symbol = String(input.symbol || "").toUpperCase();
          const market = (await getMarkets()).find((m) => m.symbol === symbol);
          if (!market)
            throw new InputError("Choose a valid Binance spot market.");
          if (state.markets.some((m) => m.symbol === symbol))
            throw new InputError(
              "This market is already in your watchlist.",
              409,
            );
          if (state.markets.length >= 50)
            throw new InputError("The watchlist supports up to 50 markets.");
          store.saveMarket(market);
          refresh(true);
          return json(state, 201);
        }
        const marketMatch = url.pathname.match(/^\/api\/markets\/([^/]+)$/);
        if (marketMatch && request.method === "DELETE") {
          const symbol = decodeURIComponent(marketMatch[1]!);
          if (!state.markets.some((m) => m.symbol === symbol))
            throw new InputError("Market not found.", 404);
          store.removeMarket(symbol);
          refresh(true);
          return json(state);
        }
        if (url.pathname === "/api/rules" && request.method === "POST") {
          const input = validateRule(
            await body(request),
            state.markets.map((m) => m.symbol),
          );
          if (state.rules.length >= 100)
            throw new InputError("You can create up to 100 rules.");
          store.saveRule({
            ...input,
            id: crypto.randomUUID(),
            enabled: true,
            createdAt: new Date().toISOString(),
          });
          refresh();
          return json(state, 201);
        }
        const ruleMatch = url.pathname.match(/^\/api\/rules\/([^/]+)$/);
        if (ruleMatch) {
          const rule = state.rules.find((r) => r.id === ruleMatch[1]);
          if (!rule) throw new InputError("Rule not found.", 404);
          if (request.method === "PATCH") {
            const input = await body(request);
            let updated: Rule;
            if (
              Object.keys(input).length === 1 &&
              typeof input.enabled === "boolean"
            )
              updated = { ...rule, enabled: input.enabled };
            else
              updated = {
                ...rule,
                ...validateRule(
                  input,
                  state.markets.map((m) => m.symbol),
                ),
              };
            store.saveRule(updated);
            engine.reset(rule.id);
            refresh();
            return json(state);
          }
          if (request.method === "DELETE") {
            store.removeRule(rule.id);
            engine.reset(rule.id);
            refresh();
            return json(state);
          }
        }
        return json({ error: "Not found." }, 404);
      } catch (error) {
        if (error instanceof InputError)
          return json({ error: error.message }, error.status);
        console.error("Request failed:", error);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    },
    websocket: {
      open(ws) {
        ws.subscribe("state");
        ws.send(JSON.stringify(state));
      },
      message() {},
    },
  });
  const broadcast = setInterval(() => {
    if (dirty) {
      server.publish("state", JSON.stringify(state));
      dirty = false;
    }
  }, 250);
  refresh(true);
  console.log(
    `\n  SIGNAL / Binance webhook automation\n  http://localhost:${server.port}\n`,
  );
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearInterval(broadcast);
    stream.stop();
    await server.stop(true);
    await webhooks.drain();
    store.close();
  };
  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  return { server, stop };
}
