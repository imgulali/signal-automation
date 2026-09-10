export type Condition = "above" | "below" | "crosses";
export type Market = { symbol: string; base: string; quote: string };
export type Rule = {
  id: string;
  symbol: string;
  condition: Condition;
  threshold: number;
  webhookUrl: string;
  webhookHeaders?: Record<string, string>;
  webhookBody?: string;
  enabled: boolean;
  createdAt: string;
};
export type Delivery = {
  id: string;
  ruleId: string;
  symbol: string;
  condition: Condition;
  threshold: number;
  price: number;
  direction: "up" | "down";
  triggeredAt: string;
  status: "pending" | "delivered" | "failed" | "skipped";
  detail: string;
};
export type Quote = {
  price: number;
  time: number;
  direction: "up" | "down" | "flat";
};
export type Snapshot = {
  markets: Market[];
  rules: Rule[];
  deliveries: Delivery[];
  quotes: Record<string, Quote>;
  stream: {
    status: "idle" | "connecting" | "live" | "reconnecting";
    message: string;
  };
};
