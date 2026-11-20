export const $ = (selector, root = document) => root.querySelector(selector);

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const fmtDate = (value) => {
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" });
};

export const fmtDay = (value) => {
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("pt-PT");
};

export const fmtMZN = (value) =>
  typeof value === "number"
    ? value.toLocaleString("pt-PT", { style: "currency", currency: "MZN", maximumFractionDigits: 0 })
    : "—";

export function toast(message, kind = "info") {
  const box = $("#toasts");
  const item = el("div", { class: `toast toast-${kind}`, text: message, role: "status" });
  box.append(item);
  setTimeout(() => item.classList.add("toast-out"), 5200);
  setTimeout(() => item.remove(), 6000);
}

export function card(title, value, hint) {
  return el("div", { class: "card stat" }, [
    el("span", { class: "stat-label", text: title }),
    el("strong", { class: "stat-value", text: String(value) }),
    hint ? el("span", { class: "stat-hint", text: hint }) : null,
  ]);
}

export function badge(text, kind = "neutral") {
  return el("span", { class: `badge badge-${kind}`, text });
}

const STATUS_KIND = {
  pending: "warn",
  approved: "ok",
  rejected: "bad",
  suspended: "bad",
  deleting: "warn",
  paid: "ok",
  shipped: "warn",
  delivered: "ok",
  cancelled: "bad",
};

export const statusBadge = (status) => badge(status || "—", STATUS_KIND[status] || "neutral");

export function openModal({ title, body, actions = [], wide = false }) {
  const overlay = el("div", { class: "modal-overlay" });
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  const dialog = el("div", { class: `modal${wide ? " modal-wide" : ""}`, role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "modal-head" }, [
      el("h2", { text: title }),
      el("button", { class: "icon-btn", "aria-label": "Fechar", onclick: close, text: "✕" }),
    ]),
    el("div", { class: "modal-body" }, [].concat(body)),
    actions.length ? el("div", { class: "modal-actions" }, actions) : null,
  ]);
  overlay.append(dialog);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return { overlay, dialog, close };
}

export function confirmModal({ title, message, confirmLabel = "Confirmar", danger = false, onConfirm }) {
  const { close } = openModal({
    title,
    body: [el("p", { class: "muted", text: message })],
    actions: [
      el("button", { class: "btn ghost", text: "Cancelar", onclick: () => close() }),
      el("button", {
        class: `btn ${danger ? "danger" : "primary"}`,
        text: confirmLabel,
        onclick: async () => {
          close();
          await onConfirm();
        },
      }),
    ],
  });
}

export function table(headers, rows, emptyMessage = "Sem registos.") {
  if (!rows.length) return el("p", { class: "empty", text: emptyMessage });
  return el("div", { class: "table-wrap" }, [
    el("table", {}, [
      el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows),
    ]),
  ]);
}

export function loading(label = "A carregar…") {
  return el("p", { class: "empty loading", text: label });
}

export function errorBox(error) {
  return el("div", { class: "errorbox" }, [
    el("strong", { text: "Falhou" }),
    el("p", { text: error?.message || String(error) }),
  ]);
}
