import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Delivery, Market, Rule } from "./types";

export class Store {
  private db: Database;

  constructor(path = "data/automation.sqlite") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS markets (symbol TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
    // An interrupted request has an unknown outcome; never silently retry it.
    for (const delivery of this.deliveries()) {
      if (delivery.status === "pending")
        this.saveDelivery({
          ...delivery,
          status: "failed",
          detail: "Server restarted; delivery outcome unknown.",
        });
    }
  }

  markets(): Market[] {
    return this.read<Market>("markets");
  }
  rules(): Rule[] {
    return this.read<Rule>("rules");
  }
  deliveries(): Delivery[] {
    return this.read<Delivery>("deliveries").reverse();
  }

  private read<T>(table: "markets" | "rules" | "deliveries"): T[] {
    return (
      this.db.query(`SELECT json FROM ${table} ORDER BY rowid`).all() as {
        json: string;
      }[]
    ).map((row) => JSON.parse(row.json));
  }

  saveMarket(market: Market) {
    this.db
      .query("INSERT OR REPLACE INTO markets VALUES (?, ?)")
      .run(market.symbol, JSON.stringify(market));
  }

  removeMarket(symbol: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM markets WHERE symbol = ?").run(symbol);
      for (const rule of this.rules())
        if (rule.symbol === symbol) this.removeRule(rule.id);
    })();
  }

  saveRule(rule: Rule) {
    this.db
      .query("INSERT OR REPLACE INTO rules VALUES (?, ?)")
      .run(rule.id, JSON.stringify(rule));
  }

  removeRule(id: string) {
    this.db.query("DELETE FROM rules WHERE id = ?").run(id);
  }

  saveDelivery(delivery: Delivery) {
    this.db
      .query(
        "INSERT INTO deliveries VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      )
      .run(delivery.id, JSON.stringify(delivery));
    this.db.exec(
      "DELETE FROM deliveries WHERE rowid NOT IN (SELECT rowid FROM deliveries ORDER BY rowid DESC LIMIT 200)",
    );
  }

  close() {
    this.db.close();
  }
}
