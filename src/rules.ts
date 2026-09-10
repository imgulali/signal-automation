import type { Condition, Rule } from "./types";
import { encodeWebhookBody } from "./webhook-body";

export class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function validateRule(
  input: Record<string, unknown>,
  symbols: string[],
): Pick<
  Rule,
  | "symbol"
  | "condition"
  | "threshold"
  | "webhookUrl"
  | "webhookHeaders"
  | "webhookBody"
> {
  const { symbol, condition, threshold, webhookUrl } = input;
  if (typeof symbol !== "string" || !symbols.includes(symbol))
    throw new InputError("Choose a market from your watchlist.");
  if (!["above", "below", "crosses"].includes(String(condition)))
    throw new InputError("Choose above, below, or crosses.");
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold <= 0
  )
    throw new InputError("Enter a price greater than zero.");
  if (typeof webhookUrl !== "string" || webhookUrl.length > 2048)
    throw new InputError("Enter a valid webhook URL.");
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new InputError("Enter a full http:// or https:// webhook URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new InputError("Use an HTTP(S) URL without embedded credentials.");
  const webhookHeaders = validateHeaders(input.webhookHeaders);
  const webhookBody = input.webhookBody ?? "";
  if (typeof webhookBody !== "string" || webhookBody.length > 32_768)
    throw new InputError("Body must be JSON under 32 KB.");
  if (webhookBody.trim()) {
    try {
      JSON.parse(webhookBody);
    } catch {
      throw new InputError("Body must be valid JSON.");
    }
    try {
      encodeWebhookBody(
        webhookBody,
        webhookHeaders["content-type"] ?? "application/json",
      );
    } catch (error) {
      throw new InputError(
        error instanceof Error ? error.message : "Invalid form body.",
      );
    }
  }
  return {
    symbol,
    condition: condition as Condition,
    threshold,
    webhookUrl: url.href,
    webhookHeaders,
    webhookBody: webhookBody.trim(),
  };
}

function validateHeaders(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("Headers must be a JSON object with text values.");
  if (JSON.stringify(input).length > 8192)
    throw new InputError("Headers must be under 8 KB.");
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string")
      throw new InputError("Header values must be text.");
    if (
      [
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "upgrade",
        "trailer",
        "te",
        "expect",
        "x-webhook-id",
      ].includes(name.toLowerCase())
    )
      throw new InputError(`Header ${name} is managed automatically.`);
    try {
      headers.set(name, value);
    } catch {
      throw new InputError(`Invalid header: ${name}`);
    }
  }
  return Object.fromEntries(headers);
}

// Keep the last non-equal side for a two-way crossing: 99 → 100 → 101 fires once.
export function evaluate(
  condition: Condition,
  threshold: number,
  price: number,
  previous?: number,
) {
  const side = Math.sign(price - threshold);
  const fire =
    previous !== undefined &&
    (condition === "above"
      ? side > 0 && previous <= 0
      : condition === "below"
        ? side < 0 && previous >= 0
        : side !== 0 && previous !== 0 && side !== previous);
  return {
    fire,
    side: condition === "crosses" && side === 0 ? previous : side,
  };
}

export class RuleEngine {
  private sides = new Map<string, number>();
  reset(id?: string) {
    if (id) this.sides.delete(id);
    else this.sides.clear();
  }

  tick(rule: Rule, price: number): boolean {
    if (!rule.enabled) return false;
    const result = evaluate(
      rule.condition,
      rule.threshold,
      price,
      this.sides.get(rule.id),
    );
    if (result.side !== undefined) this.sides.set(rule.id, result.side);
    return result.fire;
  }
}
