import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleEngine, validateRule } from "../src/rules";
import { Store } from "../src/store";
import { Webhooks } from "../src/webhooks";
import { priceDirection } from "../src/prices";
import type { Condition, Delivery, Rule } from "../src/types";

const rule = (
  condition: Condition = "above",
  webhookUrl = "http://localhost/webhook",
): Rule => ({
  id: "test-rule",
  symbol: "SOLUSDT",
  threshold: 100,
  condition,
  webhookUrl,
  enabled: true,
  createdAt: new Date().toISOString(),
});

test.each([
  [
    "above",
    [101, 102, 100, 101, 103, 99, 101],
    [false, false, false, true, false, false, true],
  ],
  [
    "below",
    [99, 98, 100, 99, 97, 101, 99],
    [false, false, false, true, false, false, true],
  ],
  [
    "crosses",
    [99, 100, 99, 100, 101, 100, 99],
    [false, false, false, false, true, false, true],
  ],
] as [Condition, number[], boolean[]][])(
  "%s triggers only on the intended transition",
  (condition, prices, expected) => {
    const engine = new RuleEngine();
    expect(prices.map((price) => engine.tick(rule(condition), price))).toEqual(
      expected,
    );
  },
);

test("a reconnect/resume establishes a new baseline; disabled rules don't trigger", () => {
  const engine = new RuleEngine();
  engine.tick(rule(), 99);
  engine.reset();
  expect(engine.tick(rule(), 101)).toBe(false);
  expect(engine.tick({ ...rule(), enabled: false }, 99)).toBe(false);
  engine.reset("test-rule");
  expect(engine.tick(rule(), 101)).toBe(false);
});

test("rejects invalid rule inputs", () => {
  for (const change of [
    { threshold: 0 },
    { threshold: Infinity },
    { symbol: "UNKNOWN" },
    { condition: "equals" },
    { webhookUrl: "file:///tmp/file" },
    { webhookHeaders: { Authorization: 123 } },
    { webhookHeaders: { "Bad Header": "value" } },
    { webhookHeaders: { "X-Token": "value\r\nInjected: true" } },
    { webhookHeaders: { "Content-Length": "0" } },
    { webhookBody: "{broken" },
    {
      webhookHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
      webhookBody: '{"nested":{"value":1}}',
    },
    {
      webhookHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
      webhookBody: '["value"]',
    },
  ]) {
    expect(() => validateRule({ ...rule(), ...change }, ["SOLUSDT"])).toThrow();
  }
});

test("persists state, removes dependent rules, and marks interrupted deliveries", () => {
  const directory = mkdtempSync(join(tmpdir(), "signal-test-"));
  const path = join(directory, "test.sqlite");
  let store = new Store(path);
  try {
    store.saveMarket({ symbol: "SOLUSDT", base: "SOL", quote: "USDT" });
    store.saveRule({
      ...rule(),
      webhookHeaders: { "X-Token": "test" },
      webhookBody: '{"action":"notify"}',
    });
    store.saveDelivery({
      id: "delivery",
      ruleId: "test-rule",
      symbol: "SOLUSDT",
      condition: "above",
      threshold: 100,
      price: 101,
      direction: "up",
      triggeredAt: new Date().toISOString(),
      status: "pending",
      detail: "Sending",
    });
    store.close();
    store = new Store(path);
    expect(store.markets()).toHaveLength(1);
    expect(store.rules()).toHaveLength(1);
    expect(store.rules()[0]).toMatchObject({
      webhookHeaders: { "X-Token": "test" },
      webhookBody: '{"action":"notify"}',
    });
    expect(store.deliveries()[0]?.status).toBe("failed");
    store.removeMarket("SOLUSDT");
    expect(store.rules()).toHaveLength(0);
    expect(store.deliveries()).toHaveLength(1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("price color follows the displayed move and persists across equal prices", () => {
  expect(priceDirection(101, 100, "down")).toBe("up");
  expect(priceDirection(101, 101, "up")).toBe("up");
  expect(priceDirection(99, 101, "up")).toBe("down");
  expect(priceDirection(99, 99, "down")).toBe("down");
  expect(priceDirection(100)).toBe("flat");
});

test("custom headers and JSON body are delivered as configured", async () => {
  let received: { headers: Headers; body: string } | undefined;
  const results: Delivery[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received = { headers: request.headers, body: await request.text() };
      return new Response(null, { status: 204 });
    },
  });
  try {
    const input = validateRule(
      {
        ...rule("above", `http://127.0.0.1:${receiver.port}/webhook`),
        webhookHeaders: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/vnd.api+json",
        },
        webhookBody: '{"action":"notify","enabled":true}',
      },
      ["SOLUSDT"],
    );
    const webhooks = new Webhooks((event) => results.push({ ...event }));
    webhooks.send({ ...rule(), ...input }, 101, Date.now());
    await webhooks.drain();
    expect(received?.headers.get("Authorization")).toBe("Bearer test-token");
    expect(received?.headers.get("Content-Type")).toBe(
      "application/vnd.api+json",
    );
    expect(received?.headers.get("X-Webhook-Id")).toBe(results[0]?.id);
    expect(received?.body).toBe(input.webhookBody);
    expect(results.at(-1)?.status).toBe("delivered");
  } finally {
    await receiver.stop(true);
  }
});

test.each([
  "application/x-www-form-urlencoded",
  "Application/X-WWW-Form-Urlencoded; charset=UTF-8",
])("encodes a JSON object as %s", async (contentType) => {
  let received: Record<string, string> | undefined;
  const results: Delivery[] = [];
  const fields = {
    token: "test-token",
    user: "test-user",
    title: "SOL Price Below 100",
    message: "SOL + ETH & price=100 / café",
    priority: "2",
    sound: "persistent",
    retry: "30",
    expire: "3600",
    enabled: true,
    count: 0,
  };
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const raw = await request.text();
      expect(raw).not.toStartWith("{");
      expect(raw).toContain("%26");
      received = Object.fromEntries(new URLSearchParams(raw));
      return Response.json({ status: 1 });
    },
  });
  try {
    const input = validateRule(
      {
        ...rule("above", `http://127.0.0.1:${receiver.port}/messages`),
        webhookHeaders: { "content-type": contentType },
        webhookBody: JSON.stringify(fields),
      },
      ["SOLUSDT"],
    );
    const webhooks = new Webhooks((event) => results.push({ ...event }));
    webhooks.send({ ...rule(), ...input }, 101, Date.now());
    await webhooks.drain();
    expect(received).toEqual(
      Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, String(value)]),
      ),
    );
    expect(results.at(-1)?.status).toBe("delivered");
  } finally {
    await receiver.stop(true);
  }
});

test("a price crossing sends JSON once and records HTTP failures", async () => {
  const received: Record<string, unknown>[] = [];
  const results: Delivery[] = [];
  let status = 200;
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.method).toBe("POST");
      const payload = await request.json();
      expect(request.headers.get("X-Webhook-Id")).toBe(payload.id);
      received.push(payload);
      return new Response("ok", { status });
    },
  });
  try {
    const automation = rule(
      "above",
      `http://127.0.0.1:${receiver.port}/webhook`,
    );
    const engine = new RuleEngine();
    const webhooks = new Webhooks((event) => results.push({ ...event }));
    for (const price of [99, 101, 102])
      if (engine.tick(automation, price))
        webhooks.send(automation, price, Date.now());
    await webhooks.drain();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event: "price.triggered",
      symbol: "SOLUSDT",
      price: 101,
      direction: "up",
    });
    expect(results.at(-1)?.status).toBe("delivered");
    status = 503;
    webhooks.send(automation, 101, Date.now());
    await webhooks.drain();
    expect(results.at(-1)).toMatchObject({
      status: "failed",
      detail: "HTTP 503",
    });
  } finally {
    await receiver.stop(true);
  }
});
