import type { Market, Rule, Snapshot } from "../src/types";
import { priceDirection } from "../src/prices";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const price = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 12 }).format(value);
const icons = { above: "↗", below: "↘", crosses: "⇅" };
const labels = { above: "above", below: "below", crosses: "crosses" };
let state: Snapshot;
let catalog: Market[] = [];
let filter = "all";
let editingId: string | undefined;
let connected = false;
let toastTimer: ReturnType<typeof setTimeout>;
let renderedRules = "";
let renderedActivity = "";

function toast(message: string, error = false) {
  $("toast").textContent = message;
  $("toast").className = `visible${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").className = ""), 4500);
}

async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Request failed. Please try again.");
  return data as T;
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

async function mutate(path: string, method: string, body?: unknown) {
  state = await api<Snapshot>(path, method, body);
  render();
}

function render() {
  if (!state) return;
  $("market-count").textContent = String(state.markets.length);
  $("rule-count").textContent = String(state.rules.length);
  $("watching-stat").textContent = String(state.markets.length);
  $("active-stat").textContent = String(
    state.rules.filter((r) => r.enabled).length,
  );
  $("sent-stat").textContent = String(
    state.deliveries.filter((d) => d.status === "delivered").length,
  );
  const marketKey = state.markets.map((m) => m.symbol).join(",");
  if ($("markets").dataset.key !== marketKey) {
    $("markets").dataset.key = marketKey;
    $("markets").innerHTML = state.markets.length
      ? state.markets
          .map(
            (m) =>
              `<div class="market-row" data-symbol="${escape(m.symbol)}"><div class="coin-icon ${escape(m.base.toLowerCase())}">${escape(m.base === "BTC" ? "₿" : m.base === "ETH" ? "Ξ" : m.base === "SOL" ? "≋" : m.base.slice(0, 1))}</div><div><div class="market-name">${escape(m.base)}<span class="muted">/${escape(m.quote)}</span></div></div><div class="market-price"><div data-price>—</div><div class="quote-time" data-time>Waiting</div></div><button class="market-remove icon-button" data-remove-market="${escape(m.symbol)}" aria-label="Remove ${escape(m.symbol)}" title="Remove market">×</button></div>`,
          )
          .join("")
      : '<div class="empty"><p>No markets</p></div>';
  }
  for (const row of document.querySelectorAll<HTMLElement>(".market-row")) {
    const quote = state.quotes[row.dataset.symbol!];
    const value = row.querySelector<HTMLElement>("[data-price]")!;
    const time = row.querySelector<HTMLElement>("[data-time]")!;
    if (quote) {
      const previousPrice =
        value.dataset.lastPrice === undefined
          ? undefined
          : Number(value.dataset.lastPrice);
      const previousDirection = value.classList.contains("up")
        ? "up"
        : value.classList.contains("down")
          ? "down"
          : quote.direction;
      value.className = priceDirection(
        quote.price,
        previousPrice,
        previousDirection,
      );
      value.dataset.lastPrice = String(quote.price);
      value.textContent = price(quote.price);
    } else {
      value.textContent = "—";
      value.className = "";
      delete value.dataset.lastPrice;
    }
    time.textContent =
      !connected || state.stream.status !== "live"
        ? "Disconnected"
        : !quote
          ? "Waiting"
          : Date.now() - quote.time > 30_000
            ? "Updated >30s ago"
            : "Live";
    time.title = quote ? new Date(quote.time).toLocaleString() : "";
  }
  const rulesKey = JSON.stringify([state.rules, filter]);
  if (renderedRules !== rulesKey) {
    renderedRules = rulesKey;
    const rules = state.rules.filter(
      (r) => filter === "all" || r.enabled === (filter === "active"),
    );
    $("rules").innerHTML = rules.length
      ? rules.map(renderRule).join("")
      : `<div class="empty"><h3>${state.rules.length ? `No ${escape(filter)} rules` : "No automations"}</h3>${state.rules.length ? "" : '<button class="secondary" data-create>+ New automation</button>'}</div>`;
  }
  const activityKey = JSON.stringify(state.deliveries);
  if (renderedActivity !== activityKey) {
    renderedActivity = activityKey;
    $("activity").innerHTML = state.deliveries.length
      ? state.deliveries
          .map(
            (d) =>
              `<div class="activity-row"><div>${escape(d.symbol)} <small>${icons[d.condition]} ${labels[d.condition]} ${price(d.threshold)}</small></div><div>${price(d.price)}</div><div><span class="delivery-status ${d.status}">${d.status === "delivered" ? "✓ " : ""}${escape(d.status[0]!.toUpperCase() + d.status.slice(1))}</span><small>${escape(d.detail)}</small></div><div title="${escape(new Date(d.triggeredAt).toLocaleString())}">${new Date(d.triggeredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}<small>${new Date(d.triggeredAt).toLocaleDateString([], { month: "short", day: "numeric" })}</small></div></div>`,
          )
          .join("")
      : '<div class="activity-empty">No activity</div>';
  }
}

function renderRule(rule: Rule) {
  const quote =
    state.markets.find((m) => m.symbol === rule.symbol)?.quote || "";
  // Hide query strings and paths, which often contain webhook secrets.
  const host = new URL(rule.webhookUrl).host;
  return `<article class="rule-card"><div class="rule-icon ${rule.condition}">${icons[rule.condition]}</div><div class="rule-info"><div class="rule-title">${escape(rule.symbol)}<span class="condition-text">${labels[rule.condition]}</span>${price(rule.threshold)}<span class="unit">${escape(quote)}</span></div><div class="rule-url"><span class="method">POST</span><span>${escape(host)}</span></div></div><div class="rule-actions"><span class="rule-status ${rule.enabled ? "" : "paused"}">${rule.enabled ? "Armed" : "Paused"}</span><button class="toggle" role="switch" aria-checked="${rule.enabled}" aria-label="${rule.enabled ? "Pause" : "Resume"} ${escape(rule.symbol)} automation" data-toggle="${rule.id}"></button><button class="icon-button" data-edit="${rule.id}" aria-label="Edit ${escape(rule.symbol)} automation" title="Edit automation">✎</button><button class="icon-button" data-remove-rule="${rule.id}" aria-label="Remove ${escape(rule.symbol)} automation" title="Remove automation">×</button></div></article>`;
}

async function openMarkets() {
  $("market-error").textContent = "";
  $<HTMLInputElement>("market-search").value = "";
  $<HTMLDialogElement>("market-dialog").showModal();
  $("market-results").innerHTML = '<div class="activity-empty">Loading…</div>';
  try {
    catalog = await api<Market[]>("/api/markets");
    renderMarketResults();
  } catch (error) {
    $("market-results").innerHTML = "";
    $("market-error").textContent = message(error);
  }
}

function renderMarketResults() {
  const term = $<HTMLInputElement>("market-search")
    .value.toUpperCase()
    .replace(/[\s/\-]/g, "");
  const tracked = new Set(state?.markets.map((m) => m.symbol));
  const matches = catalog
    .filter((m) => m.symbol.includes(term))
    .sort(
      (a, b) =>
        Number(b.quote === "USDT") - Number(a.quote === "USDT") ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, 40);
  $("market-results").innerHTML = matches.length
    ? matches
        .map(
          (m) =>
            `<button type="button" class="market-option" data-add="${escape(m.symbol)}" ${tracked.has(m.symbol) ? "disabled" : ""}><span>${escape(m.base)}<small>/ ${escape(m.quote)}</small></span><span>${tracked.has(m.symbol) ? "✓" : "+"}</span></button>`,
        )
        .join("")
    : '<div class="activity-empty">No markets found</div>';
}

function openRule(rule?: Rule) {
  if (!state) {
    toast("Connecting…", true);
    return;
  }
  if (!state.markets.length) {
    toast("Add a market first");
    void openMarkets();
    return;
  }
  editingId = rule?.id;
  $<HTMLFormElement>("rule-form").reset();
  $("rule-error").textContent = "";
  $("rule-dialog-title").textContent = rule
    ? "Edit automation"
    : "New automation";
  $("save-rule").textContent = rule ? "Save" : "Create";
  $<HTMLSelectElement>("rule-market").innerHTML = state.markets
    .map(
      (m) =>
        `<option value="${escape(m.symbol)}">${escape(m.base)} / ${escape(m.quote)}</option>`,
    )
    .join("");
  if (rule) {
    $<HTMLSelectElement>("rule-market").value = rule.symbol;
    $<HTMLInputElement>("rule-price").value = String(rule.threshold);
    $<HTMLInputElement>("rule-url").value = rule.webhookUrl;
    $<HTMLTextAreaElement>("rule-headers").value = Object.keys(
      rule.webhookHeaders ?? {},
    ).length
      ? JSON.stringify(rule.webhookHeaders, null, 2)
      : "";
    $<HTMLTextAreaElement>("rule-body").value = rule.webhookBody ?? "";
    document.querySelector<HTMLInputElement>(
      `input[name=condition][value=${rule.condition}]`,
    )!.checked = true;
  }
  updatePriceUnit();
  $<HTMLDialogElement>("rule-dialog").showModal();
}

function updatePriceUnit() {
  $("price-unit").textContent =
    state.markets.find(
      (m) => m.symbol === $<HTMLSelectElement>("rule-market").value,
    )?.quote || "";
}

async function confirmRemoval(title: string, detail: string) {
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = detail;
  const dialog = $<HTMLDialogElement>("confirm-dialog");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise<boolean>((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    ),
  );
}

$("add-market").onclick = () => {
  void openMarkets();
};
$("add-market-bottom").onclick = () => {
  void openMarkets();
};
$("market-search").oninput = renderMarketResults;
$("market-form").onsubmit = (event) => event.preventDefault();
$("new-rule").onclick = () => openRule();
$("rule-market").onchange = updatePriceUnit;

document.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button",
  );
  if (!button || button.disabled) return;
  if (button.hasAttribute("data-close")) {
    button.closest("dialog")?.close();
    return;
  }
  const {
    add,
    removeMarket,
    toggle,
    edit,
    removeRule,
    filter: nextFilter,
  } = button.dataset;
  try {
    if (button.hasAttribute("data-create")) openRule();
    if (nextFilter) {
      filter = nextFilter;
      document
        .querySelectorAll("[data-filter]")
        .forEach((b) =>
          b.classList.toggle(
            "selected",
            (b as HTMLElement).dataset.filter === filter,
          ),
        );
      render();
    }
    if (add) {
      button.disabled = true;
      $("market-error").textContent = "";
      await mutate("/api/markets", "POST", { symbol: add });
      renderMarketResults();
      toast(`${add} added`);
    }
    if (
      removeMarket &&
      (await confirmRemoval(
        `Remove ${removeMarket}?`,
        "Also removes this market’s rules.",
      ))
    ) {
      await mutate(
        `/api/markets/${encodeURIComponent(removeMarket)}`,
        "DELETE",
      );
      toast("Market removed");
    }
    if (toggle) {
      const rule = state.rules.find((r) => r.id === toggle)!;
      button.disabled = true;
      await mutate(`/api/rules/${toggle}`, "PATCH", { enabled: !rule.enabled });
      toast(rule.enabled ? "Automation paused" : "Automation resumed");
    }
    if (edit) openRule(state.rules.find((r) => r.id === edit));
    if (
      removeRule &&
      (await confirmRemoval("Remove automation?", "This rule will be deleted."))
    ) {
      await mutate(`/api/rules/${removeRule}`, "DELETE");
      toast("Automation removed");
    }
  } catch (error) {
    if (add) $("market-error").textContent = message(error);
    else toast(message(error), true);
  } finally {
    button.disabled = false;
  }
});

$("rule-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("save-rule");
  button.disabled = true;
  $("rule-error").textContent = "";
  try {
    const headerText = $<HTMLTextAreaElement>("rule-headers").value.trim();
    let webhookHeaders: unknown = {};
    try {
      if (headerText) webhookHeaders = JSON.parse(headerText);
    } catch {
      throw new Error("Headers must be valid JSON.");
    }
    await mutate(
      editingId ? `/api/rules/${editingId}` : "/api/rules",
      editingId ? "PATCH" : "POST",
      {
        symbol: $<HTMLSelectElement>("rule-market").value,
        condition: document.querySelector<HTMLInputElement>(
          "input[name=condition]:checked",
        )!.value,
        threshold: Number($<HTMLInputElement>("rule-price").value),
        webhookUrl: $<HTMLInputElement>("rule-url").value.trim(),
        webhookHeaders,
        webhookBody: $<HTMLTextAreaElement>("rule-body").value,
      },
    );
    $<HTMLDialogElement>("rule-dialog").close();
    toast(editingId ? "Automation updated" : "Automation created");
  } catch (error) {
    $("rule-error").textContent = message(error);
  } finally {
    button.disabled = false;
  }
};

function connect() {
  const socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  socket.onopen = () => {
    connected = true;
    render();
  };
  socket.onmessage = (event) => {
    try {
      state = JSON.parse(event.data);
      render();
    } catch {
      toast("Could not read the server update.", true);
    }
  };
  socket.onerror = () => socket.close();
  socket.onclose = () => {
    connected = false;
    render();
    setTimeout(connect, 2000);
  };
}

connect();
setInterval(render, 5000);
