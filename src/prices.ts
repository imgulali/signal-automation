import type { Quote } from "./types";

// Repeated trades at the same price retain the last movement's color.
export function priceDirection(
  price: number,
  previousPrice?: number,
  previousDirection: Quote["direction"] = "flat",
): Quote["direction"] {
  if (previousPrice === undefined) return previousDirection;
  if (price === previousPrice) return previousDirection;
  return price > previousPrice ? "up" : "down";
}
