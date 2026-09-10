import type { Delivery, Rule } from "./types";
import { encodeWebhookBody } from "./webhook-body";

export class Webhooks {
  private active = new Set<string>();
  private pending = new Set<Promise<void>>();
  constructor(private save: (delivery: Delivery) => void) {}

  send(rule: Rule, price: number, time: number) {
    const event: Delivery = {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      symbol: rule.symbol,
      condition: rule.condition,
      threshold: rule.threshold,
      price,
      direction: price > rule.threshold ? "up" : "down",
      triggeredAt: new Date(time).toISOString(),
      status: "pending",
      detail: "Sending webhook…",
    };
    if (this.active.has(rule.id)) {
      this.save({
        ...event,
        status: "skipped",
        detail: "Previous delivery is still in progress.",
      });
      return;
    }
    this.save(event);
    this.active.add(rule.id);
    const task = this.deliver(rule, event).finally(() => {
      this.active.delete(rule.id);
      this.pending.delete(task);
    });
    this.pending.add(task);
  }

  private async deliver(rule: Rule, event: Delivery) {
    try {
      const { status, detail, ...payload } = event;
      const headers = new Headers(rule.webhookHeaders);
      if (!headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      headers.set("X-Webhook-Id", event.id);
      const response = await fetch(rule.webhookUrl, {
        method: "POST",
        headers,
        body: encodeWebhookBody(
          rule.webhookBody?.trim() ||
            JSON.stringify({ event: "price.triggered", ...payload }),
          headers.get("Content-Type")!,
        ),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      await response.body?.cancel();
      event.status = response.ok ? "delivered" : "failed";
      event.detail = `HTTP ${response.status}`;
    } catch (error) {
      event.status = "failed";
      event.detail =
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
          ? "Timed out after 10s; outcome unknown."
          : "Request failed. Check the endpoint and network.";
    }
    try {
      this.save(event);
    } catch (error) {
      console.error("Could not save webhook result:", error);
    }
  }

  async drain() {
    await Promise.allSettled(this.pending);
  }
}
