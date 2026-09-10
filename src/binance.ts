import type { Market, Snapshot } from "./types";
import { InputError } from "./rules";

let catalog: Market[] = [];
let catalogAt = 0;
let catalogRequest: Promise<Market[]> | undefined;

export async function getMarkets(): Promise<Market[]> {
  if (catalog.length && Date.now() - catalogAt < 3_600_000) return catalog;
  if (catalogRequest) return catalogRequest;
  catalogRequest = (async () => {
    try {
      const response = await fetch(
        "https://data-api.binance.vision/api/v3/exchangeInfo",
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        symbols: {
          symbol: string;
          baseAsset: string;
          quoteAsset: string;
          status: string;
          isSpotTradingAllowed: boolean;
        }[];
      };
      catalog = data.symbols
        .filter((s) => s.status === "TRADING" && s.isSpotTradingAllowed)
        .map((s) => ({
          symbol: s.symbol,
          base: s.baseAsset,
          quote: s.quoteAsset,
        }));
      catalogAt = Date.now();
      return catalog;
    } catch {
      if (catalog.length) return catalog;
      throw new InputError(
        "Binance market list is unavailable. Please try again shortly.",
        502,
      );
    } finally {
      catalogRequest = undefined;
    }
  })();
  return catalogRequest;
}

export class BinanceStream {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private symbols: string[] = [];
  private failures = 0;

  constructor(
    private onPrice: (symbol: string, price: number, time: number) => void,
    private onStatus: (state: Snapshot["stream"]) => void,
    private onReset: () => void,
  ) {}

  setMarkets(symbols: string[]) {
    this.stop();
    this.symbols = symbols;
    this.failures = 0;
    this.onReset();
    if (!symbols.length) {
      this.onStatus({
        status: "idle",
        message: "Add a market to start listening",
      });
      return;
    }
    this.onStatus({ status: "connecting", message: "Connecting to Binance" });
    this.timer = setTimeout(() => this.connect(), 500);
  }

  private connect() {
    let lastSeen = Date.now();
    const streams = this.symbols
      .map((s) => `${s.toLowerCase()}@trade`)
      .join("/");
    const socket = (this.socket = new WebSocket(
      `wss://data-stream.binance.vision/stream?streams=${streams}`,
    ));
    const reconnect = () => {
      if (this.socket !== socket) return;
      this.stop();
      this.onReset();
      const delay =
        Math.min(30_000, 1000 * 2 ** this.failures++) + Math.random() * 500;
      this.onStatus({
        status: "reconnecting",
        message: `Stream interrupted. Retrying in ${Math.ceil(delay / 1000)}s`,
      });
      this.timer = setTimeout(() => this.connect(), delay);
    };
    socket.onopen = () => {
      if (this.socket !== socket) return;
      lastSeen = Date.now();
      this.onStatus({ status: "live", message: "Binance spot · live trades" });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      lastSeen = Date.now();
      this.failures = 0;
      try {
        const { data } = JSON.parse(String(event.data));
        if (data?.e === "serverShutdown") {
          reconnect();
          return;
        }
        const price = Number(data?.p);
        if (
          data?.e !== "trade" ||
          !this.symbols.includes(data.s) ||
          !Number.isFinite(price) ||
          price <= 0 ||
          !Number.isFinite(data.T)
        )
          return;
        this.onPrice(data.s, price, data.T);
      } catch (error) {
        console.error("Could not process Binance event:", error);
      }
    };
    socket.onclose = reconnect;
    socket.onerror = reconnect;
    this.watchdog = setInterval(() => {
      if (Date.now() - lastSeen > 90_000) reconnect();
    }, 15_000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }
}
