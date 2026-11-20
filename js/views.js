import {
  addDoc,
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  deleteDoc,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { checkService, fetchMedia, reviewVerification, sendPush } from "./api.js";
import {
  badge,
  card,
  confirmModal,
  el,
  errorBox,
  fmtDate,
  fmtDay,
  fmtMZN,
  loading,
  openModal,
  statusBadge,
  table,
  toast,
} from "./ui.js";
import { CONSENT_VERSION, API_BASE, REVIEW_REASON_MAX, REVIEW_REASON_MIN } from "../config.js";

/* ------------------------------------------------------------------ helpers */

const safeCount = async (ref) => {
  try {
    return (await getCountFromServer(ref)).data().count;
  } catch {
    return null;
  }
};

const countOf = (name, filter) =>
  safeCount(filter ? query(collection(db, name), filter) : collection(db, name));

const sortByDate = (items, key) =>
  [...items].sort((a, b) => (b.get(key)?.toMillis?.() || 0) - (a.get(key)?.toMillis?.() || 0));

async function audit(action, payload) {
  // A auditoria é a única escrita "livre" do painel; as regras exigem admin.
  await addDoc(collection(db, "sellerAudit"), {
    action,
    actor: auth.currentUser?.uid || "painel",
    channel: "admin-panel",
    createdAt: serverTimestamp(),
    ...payload,
  });
}

/** Erro de permissão = regra por publicar; dizer o que fazer é mais útil que o código do Firebase. */
function permissionBox(e) {
  const msg = String(e?.message || e || "");
  if (e?.code === "permission-denied" || /insufficient permissions/i.test(msg)) {
    return el("div", { class: "errorbox" }, [
      el("strong", { text: "Faltam permissões no Firestore" }),
      el("p", {
        text:
          "A regra desta colecção ainda não está activa na base. Publique as regras do repositório " +
          "(firebase/firestore.rules) e volte a abrir esta página.",
      }),
    ]);
  }
  return errorBox(e);
}

function pageHeader(title, subtitle, actions = []) {
  return el("header", { class: "page-head" }, [
    el("div", {}, [el("h1", { text: title }), subtitle ? el("p", { class: "muted", text: subtitle }) : null]),
    el("div", { class: "head-actions" }, actions),
  ]);
}

function section(title, children) {
  return el("section", { class: "panel" }, [el("h2", { text: title }), ...[].concat(children)]);
}

/* ---------------------------------------------------------------- visão geral */

export async function viewOverview(root) {
  root.append(pageHeader("Visão geral", "Estado da plataforma em tempo real."));
  const holder = el("div", {});
  root.append(holder);
  holder.append(loading());

  const [users, sellersPending, storesApproved, productsTotal, productsActive, orders, verifPending, applications] =
    await Promise.all([
      countOf("users"),
      countOf("users", where("role", "==", "seller")),
      countOf("stores", where("status", "==", "approved")),
      countOf("products"),
      countOf("products", where("active", "==", true)),
      countOf("orders"),
      countOf("sellerVerifications", where("status", "==", "pending")),
      countOf("sellerApplications", where("status", "==", "pending")),
    ]);

  let verificationDocs = [];
  try {
    const snap = await getDocs(
      query(collection(db, "sellerVerifications"), where("status", "in", ["pending", "deleting"]), limit(50))
    );
    verificationDocs = sortByDate(snap.docs, "uploadedAt");
  } catch {
    verificationDocs = [];
  }
  const soon = verificationDocs.filter((d) => {
    const at = d.get("expiresAt")?.toMillis?.();
    return at && at - Date.now() < 48 * 3600 * 1000 && d.get("status") === "pending";
  });
  const stuck = verificationDocs.filter((d) => d.get("status") === "deleting");

  const value = (v) => (v === null ? "—" : v);
  holder.replaceChildren(
    el("div", { class: "grid stats" }, [
      card("Contas", value(users)),
      card("Vendedores", value(sellersPending)),
      card("Lojas verificadas", value(storesApproved)),
      card("Anúncios activos", `${value(productsActive)} / ${value(productsTotal)}`),
      card("Pedidos", value(orders)),
      card("Verificações pendentes", value(verifPending)),
    ])
  );

  const alerts = [];
  if (soon.length) alerts.push(`${soon.length} verificação(ões) expiram nas próximas 48 horas.`);
  if (stuck.length) alerts.push(`${stuck.length} verificação(ões) presas em eliminação — corra a limpeza privada.`);
  if (applications) alerts.push(`${applications} candidatura(s) de loja à espera de decisão.`);
  if (alerts.length) {
    holder.append(
      el("div", { class: "alerts" }, alerts.map((text) => el("div", { class: "alert", text })))
    );
  }

  holder.append(
    section("Próximas expirações", [
      verificationDocs.length
        ? table(
            ["Vendedor", "Recebido", "Expira", "Estado"],
            verificationDocs.slice(0, 8).map((d) =>
              el("tr", {}, [
                el("td", { text: d.get("snapshot")?.name || d.id }),
                el("td", { text: fmtDate(d.get("uploadedAt")) }),
                el("td", { text: fmtDate(d.get("expiresAt")) }),
                el("td", {}, [statusBadge(d.get("status"))]),
              ])
            ),
            "Nenhuma verificação em fila."
          )
        : el("p", { class: "empty", text: "Nenhuma verificação em fila." }),
    ])
  );
}

/* ------------------------------------------------------------- verificações */

export async function viewVerifications(root) {
  root.append(
    pageHeader("Verificações de vendedor", "Compare documento e selfie com os dados da conta antes de decidir.")
  );
  const holder = el("div", {});
  root.append(holder);
  await render();

  async function render() {
    holder.replaceChildren(loading());
    let docs = [];
    try {
      const snap = await getDocs(
        query(collection(db, "sellerVerifications"), where("status", "in", ["pending", "deleting"]), limit(50))
      );
      docs = sortByDate(snap.docs, "uploadedAt");
    } catch (e) {
      holder.replaceChildren(errorBox(e));
      return;
    }
    if (!docs.length) {
      holder.replaceChildren(el("p", { class: "empty", text: "Nenhuma verificação pendente." }));
      return;
    }
    holder.replaceChildren(
      table(
        ["Vendedor", "Conta", "Recebido", "Expira", "Estado", ""],
        docs.map((d) =>
          el("tr", {}, [
            el("td", { text: d.get("snapshot")?.name || "—" }),
            el("td", { class: "mono small", text: d.get("snapshot")?.platformId || d.id }),
            el("td", { text: fmtDate(d.get("uploadedAt")) }),
            el("td", { text: fmtDate(d.get("expiresAt")) }),
            el("td", {}, [statusBadge(d.get("status"))]),
            el("td", {}, [
              el("button", {
                class: "btn small primary",
                text: d.get("status") === "deleting" ? "Ver estado" : "Analisar",
                onclick: () => openVerification(d, render),
              }),
            ]),
          ])
        )
      )
    );
  }
}

function openVerification(snapshot, refresh) {
  const data = snapshot.data();
  const uid = snapshot.id;
  const status = data.status;
  const preview = el("div", { class: "previews" });
  const reason = el("textarea", {
    class: "input",
    rows: "3",
    maxlength: String(REVIEW_REASON_MAX),
    placeholder: "Motivo da decisão (obrigatório, sem dados sensíveis).",
  });
  const confirm = el("input", { type: "checkbox", id: "confirm-review" });
  const approveBtn = el("button", { class: "btn primary", text: "Aprovar", disabled: status !== "pending" });
  const rejectBtn = el("button", { class: "btn danger", text: "Rejeitar", disabled: status !== "pending" });

  const facts = el("dl", { class: "facts" }, [
    el("dt", { text: "Conta" }),
    el("dd", { class: "mono", text: uid }),
    el("dt", { text: "Nome declarado" }),
    el("dd", { text: data.snapshot?.name || "—" }),
    el("dt", { text: "ID UniStore" }),
    el("dd", { class: "mono", text: data.snapshot?.platformId || "—" }),
    el("dt", { text: "Data de nascimento declarada" }),
    el("dd", { text: data.snapshot?.birthDate || "—" }),
    el("dt", { text: "Consentimento" }),
    el("dd", { text: data.consentVersion === CONSENT_VERSION ? `${CONSENT_VERSION} (actual)` : `${data.consentVersion || "—"} (desactualizado)` }),
    el("dt", { text: "Recebido" }),
    el("dd", { text: fmtDate(data.uploadedAt) }),
    el("dt", { text: "Expira" }),
    el("dd", { text: fmtDate(data.expiresAt) }),
    el("dt", { text: "Estado" }),
    el("dd", {}, [statusBadge(status)]),
  ]);

  const mediaButtons = el("div", { class: "row" }, [
    el("button", {
      class: "btn ghost",
      text: "Ver documento",
      onclick: (event) => showMedia(uid, "document", event.currentTarget, preview),
    }),
    el("button", {
      class: "btn ghost",
      text: "Ver selfie",
      onclick: (event) => showMedia(uid, "selfie", event.currentTarget, preview),
    }),
  ]);

  const { close } = openModal({
    title: "Análise manual",
    wide: true,
    body: [
      facts,
      el("p", { class: "muted small", text: "As imagens são servidas pela API privada com a sua sessão, não ficam em cache e cada acesso é registado na auditoria." }),
      mediaButtons,
      preview,
      status === "pending"
        ? el("div", { class: "form" }, [
            el("label", { class: "field" }, [el("span", { text: "Motivo" }), reason]),
            el("label", { class: "check" }, [
              confirm,
              el("span", { text: "ComparEi manualmente as duas imagens com os dados da conta e confirmei a legibilidade." }),
            ]),
          ])
        : el("p", { class: "alert", text: "Esta verificação já foi decidida ou está em eliminação. Só é possível consultar o estado." }),
    ],
    actions: [el("button", { class: "btn ghost", text: "Fechar", onclick: () => close() }), approveBtn, rejectBtn],
  });

  const decide = async (decision) => {
    if (!confirm.checked) return toast("Confirme a análise manual das duas imagens.", "warn");
    if (status !== "pending") return;
    const value = reason.value.trim();
    if (value.length < REVIEW_REASON_MIN) return toast("Escreva um motivo com pelo menos 5 caracteres.", "warn");
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      await reviewVerification(uid, { decision, reason: value, verificationId: data.verificationId });
      toast(decision === "approved" ? "Aprovado. Anexos eliminados e loja activada." : "Rejeitado. Anexos eliminados.", "ok");
      close();
      await refresh();
    } catch (e) {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      toast(e.message, "bad");
    }
  };
  approveBtn.addEventListener("click", () => decide("approved"));
  rejectBtn.addEventListener("click", () => decide("rejected"));
}

async function showMedia(uid, type, button, container) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "A carregar…";
  try {
    const url = await fetchMedia(uid, type);
    container.replaceChildren(
      el("figure", { class: "preview" }, [
        el("img", { src: url, alt: type === "document" ? "Documento do vendedor" : "Selfie do vendedor" }),
        el("figcaption", { text: type === "document" ? "Documento" : "Selfie" }),
      ])
    );
    setTimeout(() => URL.revokeObjectURL(url), 180000);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* --------------------------------------------------------------------- lojas */

export async function viewStores(root) {
  root.append(pageHeader("Lojas", "Selos e suspensão. A verificação documental é feita no separador anterior."));
  const holder = el("div", {});
  const procura = el("input", { class: "input", type: "search", placeholder: "Procurar loja por nome ou cidade…" });
  const filtroEstado = el("select", { class: "input" }, [
    el("option", { value: "", text: "Todos os estados" }),
    el("option", { value: "approved", text: "Aprovadas" }),
    el("option", { value: "suspended", text: "Suspensas" }),
    el("option", { value: "pending", text: "Pendentes" }),
  ]);
  root.append(el("div", { class: "form-grid" }, [procura, filtroEstado]), holder);
  procura.addEventListener("input", render);
  filtroEstado.addEventListener("change", render);
  await render();

  async function render() {
    holder.replaceChildren(loading());
    let docs = [];
    try {
      docs = (await getDocs(query(collection(db, "stores"), limit(200)))).docs;
    } catch (e) {
      holder.replaceChildren(errorBox(e));
      return;
    }
    const termo = procura.value.trim().toLowerCase();
    const estado = filtroEstado.value;
    docs = docs.filter((d) => {
      const loja = d.data();
      if (estado && loja.status !== estado) return false;
      if (!termo) return true;
      return [loja.name, loja.city].some((v) => String(v || "").toLowerCase().includes(termo));
    });
    if (!docs.length) {
      holder.replaceChildren(el("p", { class: "empty", text: "Nenhuma loja corresponde ao filtro." }));
      return;
    }
    holder.replaceChildren(
      table(
        ["Loja", "Cidade", "Estado", "Comissão", "Documentos", "Selos", "Acções"],
        docs.map((d) => {
          const data = d.data();
          const approved = data.status === "approved";
          return el("tr", {}, [
            el("td", { text: data.name || d.id }),
            el("td", { text: data.city || "—" }),
            el("td", {}, [statusBadge(data.status)]),
            el("td", {}, [
              badge(data.commissionExempt === true ? "Mensalidade" : "5%", data.commissionExempt === true ? "ok" : "neutral"),
            ]),
            el("td", { text: data.documentsVerified === true ? "Verificados" : "Não verificados" }),
            el("td", {}, [
              data.vip ? badge("VIP", "ok") : null,
              data.exclusive ? badge("Exclusiva", "ok") : null,
              !data.vip && !data.exclusive ? el("span", { class: "muted", text: "—" }) : null,
            ]),
            el("td", { class: "actions" }, [
              el("button", {
                class: "btn small ghost",
                text: data.vip ? "Retirar VIP" : "Dar VIP",
                disabled: !approved,
                onclick: () => toggleBadge(d, "vip", render),
              }),
              el("button", {
                class: "btn small ghost",
                text: data.exclusive ? "Retirar Exclusiva" : "Dar Exclusiva",
                disabled: !approved,
                onclick: () => toggleBadge(d, "exclusive", render),
              }),
              approved
                ? el("button", { class: "btn small danger", text: "Suspender", onclick: () => suspend(d, render) })
                : data.status === "suspended"
                ? el("button", { class: "btn small primary", text: "Reactivar", disabled: data.documentsVerified !== true, onclick: () => reactivate(d, render) })
                : null,
            ]),
          ]);
        })
      )
    );
  }
}

async function toggleBadge(snapshot, field, refresh) {
  const next = !(snapshot.data()[field] === true);
  try {
    await updateDoc(doc(db, "stores", snapshot.id), { [field]: next, updatedAt: serverTimestamp() });
    await audit(next ? `${field}-on` : `${field}-off`, { sellerId: snapshot.id, before: { [field]: !next } });
    toast(next ? "Selo atribuído." : "Selo removido.", "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "bad");
  }
}

function suspend(snapshot, refresh) {
  const textarea = el("textarea", { class: "input", rows: "3", maxlength: "300", placeholder: "Motivo da suspensão (mínimo 5 caracteres)." });
  const { close } = openModal({
    title: `Suspender ${snapshot.data().name || snapshot.id}`,
    body: [el("p", { class: "muted", text: "A loja fica oculta e sem permissão de publicar. Os anúncios existentes devem ser desactivados em separado." }), textarea],
    actions: [
      el("button", { class: "btn ghost", text: "Cancelar", onclick: () => close() }),
      el("button", {
        class: "btn danger",
        text: "Suspender",
        onclick: async () => {
          const reason = textarea.value.trim();
          if (reason.length < 5) return toast("Motivo demasiado curto.", "warn");
          try {
            await updateDoc(doc(db, "stores", snapshot.id), { status: "suspended", vip: false, exclusive: false, updatedAt: serverTimestamp() });
            await audit("suspend", { sellerId: snapshot.id, reason });
            close();
            toast("Loja suspensa.", "ok");
            await refresh();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      }),
    ],
  });
}

function reactivate(snapshot, refresh) {
  confirmModal({
    title: "Reactivar loja",
    message: "A loja volta a publicar apenas com documentos já verificados. Confirme que a situação foi resolvida.",
    confirmLabel: "Reactivar",
    onConfirm: async () => {
      try {
        await updateDoc(doc(db, "stores", snapshot.id), { status: "approved", updatedAt: serverTimestamp() });
        await audit("reactivate", { sellerId: snapshot.id });
        toast("Loja reactivada.", "ok");
        await refresh();
      } catch (e) {
        toast(e.message, "bad");
      }
    },
  });
}

/* ------------------------------------------------------------------ produtos */

export async function viewProducts(root) {
  root.append(pageHeader("Anúncios", "Moderação do catálogo. Ocultar não apaga o anúncio."));
  const holder = el("div", {});
  const procura = el("input", { class: "input", type: "search", placeholder: "Procurar por nome, marca ou vendedor…" });
  root.append(el("div", { class: "form-grid" }, [procura]), holder);
  procura.addEventListener("input", render);
  await render();

  async function render() {
    holder.replaceChildren(loading());
    let docs = [];
    try {
      docs = (await getDocs(query(collection(db, "products"), orderBy("createdAt", "desc"), limit(100)))).docs;
    } catch (e) {
      holder.replaceChildren(errorBox(e));
      return;
    }
    const termo = procura.value.trim().toLowerCase();
    docs = docs.filter((d) => {
      const p = d.data();
      if (!termo) return true;
      return [p.name, p.brand, p.sellerName, p.category].some((v) => String(v || "").toLowerCase().includes(termo));
    });
    if (!docs.length) {
      holder.replaceChildren(el("p", { class: "empty", text: "Nenhum anúncio corresponde à pesquisa." }));
      return;
    }
    holder.replaceChildren(
      table(
        ["Anúncio", "Vendedor", "Categoria", "Preço", "Stock", "Estado", ""],
        docs.map((d) => {
          const data = d.data();
          const active = data.active === true;
          return el("tr", {}, [
            el("td", {}, [el("strong", { text: data.name || "—" }), el("div", { class: "muted small", text: data.brand || "" })]),
            el("td", { text: data.sellerName || data.sellerId || "—" }),
            el("td", { text: data.category || "—" }),
            el("td", { text: fmtMZN(data.priceMZN) }),
            el("td", { text: data.stock ?? "—" }),
            el("td", {}, [active ? badge("Activo", "ok") : badge("Oculto", "neutral")]),
            el("td", {}, [
              el("button", {
                class: `btn small ${active ? "danger" : "primary"}`,
                text: active ? "Ocultar" : "Publicar",
                onclick: async () => {
                  try {
                    await updateDoc(doc(db, "products", d.id), { active: !active, updatedAt: serverTimestamp() });
                    await audit(!active ? "product-published" : "product-hidden", { productId: d.id, sellerId: data.sellerId });
                    toast(!active ? "Anúncio publicado." : "Anúncio ocultado.", "ok");
                    await render();
                  } catch (e) {
                    toast(e.message, "bad");
                  }
                },
              }),
              el("button", {
                class: "btn small danger",
                text: "Eliminar",
                onclick: async () => {
                  if (!confirm(`Eliminar definitivamente "${data.name}"? Não há forma de recuperar. Prefira Ocultar se for temporário.`)) return;
                  try {
                    await deleteDoc(doc(db, "products", d.id));
                    await audit("product-deleted", { productId: d.id, sellerId: data.sellerId, name: data.name });
                    toast("Anúncio eliminado.", "ok");
                    await render();
                  } catch (e) {
                    toast(e.message, "bad");
                  }
                },
              }),
            ]),
          ]);
        })
      )
    );
  }
}

/* --------------------------------------------------------------- avaliações */

export async function viewReviews(root) {
  root.append(
    pageHeader("Avaliações", "Notas e comentários publicados na app. Uma por pessoa e por anúncio; remover é definitivo.", [
      badge("Público", "neutral"),
    ])
  );
  const holder = el("div", {});
  root.append(holder);
  await render();

  async function render() {
    holder.replaceChildren(loading());
    let docs = [];
    try {
      docs = (await getDocs(query(collection(db, "reviews"), orderBy("createdAt", "desc"), limit(100)))).docs;
    } catch (e) {
      holder.replaceChildren(errorBox(e));
      return;
    }
    if (!docs.length) {
      holder.replaceChildren(el("p", { class: "empty", text: "Ainda não há avaliações." }));
      return;
    }
    const rows = docs.map((d) => {
      const data = d.data();
      const stars = "★".repeat(Math.max(0, Math.min(5, Number(data.rating) || 0)));
      return el("tr", {}, [
        el("td", {}, [
          el("strong", { text: stars || "—" }),
          el("div", { class: "muted small", text: `Nota ${data.rating ?? "—"}/5` }),
        ]),
        el("td", { class: "small", text: (data.text || "—").slice(0, 240) }),
        el("td", { class: "mono tiny", text: `${data.productId || "—"}
${data.buyerId || "—"}` }),
        el("td", { text: fmtDate(data.createdAt) }),
        el("td", {}, [
          el("button", {
            class: "btn small danger",
            text: "Remover",
            onclick: async () => {
              if (!confirm("Remover esta avaliação? Não é possível recuperar.")) return;
              try {
                await deleteDoc(doc(db, "reviews", d.id));
                await audit("review-deleted", { productId: data.productId, rating: data.rating });
                toast("Avaliação removida.", "ok");
                await render();
              } catch (e) {
                toast(e.message, "bad");
              }
            },
          }),
        ]),
      ]);
    });
    holder.replaceChildren(table(["Nota", "Comentário", "Anúncio / autor", "Data", ""], rows, "Ainda não há avaliações."));
  }
}

/* ----------------------------------------------------------------- denúncias */

export async function viewReports(root) {
  root.append(
    pageHeader("Denúncias", "Fila enviada pelos utilizadores da app. Resolver aqui não acusa ninguém: só retira do ar ou arquiva.", [
      badge("Só a app cria", "neutral"),
    ])
  );
  const holder = el("div", {});
  root.append(holder);
  await render();

  async function resolve(reportId, status, action, payload) {
    await updateDoc(doc(db, "reports", reportId), {
      status,
      resolvedBy: auth.currentUser?.uid || "painel",
      resolvedAt: serverTimestamp(),
    });
    if (action) await audit(action, payload);
  }

  async function render() {
    holder.replaceChildren(loading());
    let docs = [];
    try {
      docs = (
        await getDocs(
          query(collection(db, "reports"), where("status", "==", "open"), orderBy("createdAt", "desc"), limit(100))
        )
      ).docs;
    } catch (e) {
      holder.replaceChildren(errorBox(e));
      return;
    }
    if (!docs.length) {
      holder.replaceChildren(el("p", { class: "empty", text: "Sem denúncias abertas." }));
      return;
    }

    const targets = new Map();
    await Promise.all(
      docs.map(async (d) => {
        const data = d.data();
        const name = data.type === "store" ? "stores" : data.type === "product" ? "products" : "users";
        try {
          const snap = await getDoc(doc(db, name, String(data.targetId)));
          if (snap.exists()) targets.set(d.id, snap.data());
        } catch {
          /* alvo apagado: a denúncia continua visível para arquivar */
        }
      })
    );

    holder.replaceChildren(
      table(
        ["Alvo", "Motivo", "Detalhe", "Recebida", "Decisão"],
        docs.map((d) => {
          const data = d.data();
          const target = targets.get(d.id);
          const label =
            data.type === "product"
              ? target?.name || `Anúncio ${data.targetId}`
              : data.type === "store"
              ? target?.name || `Loja ${data.targetId}`
              : `Conta ${data.targetId}`;
          const actions = [];
          if (data.type === "product" && target) {
            actions.push(
              el("button", {
                class: "btn small danger",
                text: "Ocultar anúncio",
                onclick: async () => {
                  try {
                    await updateDoc(doc(db, "products", String(data.targetId)), {
                      active: false,
                      updatedAt: serverTimestamp(),
                    });
                    await resolve(d.id, "actioned", "report-product-hidden", {
                      reportId: d.id,
                      productId: data.targetId,
                      reason: data.reason,
                    });
                    toast("Anúncio ocultado e denúncia resolvida.", "ok");
                    await render();
                  } catch (e) {
                    toast(e.message, "bad");
                  }
                },
              })
            );
          }
          if (data.type === "store" && target) {
            actions.push(
              el("button", {
                class: "btn small danger",
                text: "Suspender loja",
                onclick: async () => {
                  try {
                    await updateDoc(doc(db, "stores", String(data.targetId)), {
                      status: "suspended",
                      documentsVerified: false,
                      updatedAt: serverTimestamp(),
                    });
                    await resolve(d.id, "actioned", "report-store-suspended", {
                      reportId: d.id,
                      sellerId: data.targetId,
                      reason: data.reason,
                    });
                    toast("Loja suspensa e denúncia resolvida.", "ok");
                    await render();
                  } catch (e) {
                    toast(e.message, "bad");
                  }
                },
              })
            );
          }
          actions.push(
            el("button", {
              class: "btn small ghost",
              text: "Arquivar",
              onclick: async () => {
                try {
                  await resolve(d.id, "dismissed", "report-dismissed", { reportId: d.id, reason: data.reason });
                  toast("Denúncia arquivada.", "ok");
                  await render();
                } catch (e) {
                  toast(e.message, "bad");
                }
              },
            })
          );
          return el("tr", {}, [
            el("td", {}, [
              el("strong", { text: label }),
              el("div", { class: "muted small", text: data.type === "store" ? "Loja" : data.type === "product" ? "Anúncio" : "Conta" }),
            ]),
            el("td", { text: data.reason || "—" }),
            el("td", { class: "small", text: (data.note || "—").slice(0, 200) }),
            el("td", { text: fmtDate(data.createdAt) }),
            el("td", {}, [el("div", { class: "row" }, actions)]),
          ]);
        })
      )
    );
  }
}

/* -------------------------------------------------------------------- pedidos */

export async function viewOrders(root) {
  root.append(
    pageHeader("Pedidos", "Leitura. Compras e entregas continuam desactivadas nesta fase.", [
      badge("Entregas desactivadas", "warn"),
    ])
  );
  const holder = el("div", {});
  root.append(holder);
  holder.append(loading());
  try {
    const docs = (await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(100)))).docs;
    holder.replaceChildren(
      table(
        ["Pedido", "Criado", "Estado", "Total", "Comprador"],
        docs.map((d) => {
          const data = d.data();
          return el("tr", {}, [
            el("td", { class: "mono small", text: data.orderNumber || d.id }),
            el("td", { text: fmtDate(data.createdAt) }),
            el("td", {}, [statusBadge(data.status)]),
            el("td", { text: fmtMZN(data.totalMZN) }),
            el("td", { class: "mono small", text: data.buyerId || "—" }),
          ]);
        }),
        "Sem pedidos registados."
      )
    );
  } catch (e) {
    holder.replaceChildren(errorBox(e));
  }
}

/* ------------------------------------------------------------------ mensagens */

export async function viewMessages(root) {
  root.append(pageHeader("Comunicados", "Mensagens mostradas na app e páginas de conteúdo."));
  const listHolder = el("div", {});
  const title = el("input", { class: "input", placeholder: "Título do comunicado", maxlength: "120" });
  const body = el("textarea", { class: "input", rows: "4", placeholder: "Mensagem", maxlength: "2000" });
  const audience = el("select", { class: "input" }, [
    el("option", { value: "all", text: "Todos" }),
    el("option", { value: "buyer", text: "Compradores" }),
    el("option", { value: "seller", text: "Vendedores" }),
  ]);
  const notify = el("input", { type: "checkbox" });
  notify.checked = true;

  root.append(
    section("Novo comunicado", [
      el("div", { class: "form" }, [
        el("label", { class: "field" }, [el("span", { text: "Título" }), title]),
        el("label", { class: "field" }, [el("span", { text: "Mensagem" }), body]),
        el("label", { class: "field" }, [el("span", { text: "Audiência" }), audience]),
        el("label", { class: "check" }, [
          notify,
          el("span", { text: "Enviar também como notificação no telemóvel" }),
        ]),
        el("button", {
          class: "btn primary",
          text: "Publicar comunicado",
          onclick: async (event) => {
            const t = title.value.trim();
            const b = body.value.trim();
            if (t.length < 2 || b.length < 2) return toast("Preencha título e mensagem.", "warn");
            event.currentTarget.disabled = true;
            try {
              await addDoc(collection(db, "broadcasts"), {
                title: t,
                body: b,
                audience: [audience.value],
                createdAt: serverTimestamp(),
                createdBy: auth.currentUser?.uid || null,
              });
              const wantPush = notify.checked;
              title.value = "";
              body.value = "";
              toast("Comunicado publicado.", "ok");
              await loadList();
              if (wantPush) {
                // The Firestore message is already saved; a failed push must not hide that.
                try {
                  const result = await sendPush({ title: t, body: b, audience: audience.value });
                  toast(
                    result.sent
                      ? `Notificação enviada a ${result.sent} aparelho(s).`
                      : "Sem aparelhos registados para esta audiência.",
                    result.sent ? "ok" : "warn"
                  );
                } catch (pushError) {
                  toast(`Comunicado guardado, mas a notificação falhou: ${pushError.message}`, "warn");
                }
              }
            } catch (e) {
              toast(e.message, "bad");
            } finally {
              event.currentTarget.disabled = false;
            }
          },
        }),
      ]),
    ])
  );

  root.append(section("Publicados", [listHolder]));
  await loadList();

  async function loadList() {
    listHolder.replaceChildren(loading());
    try {
      const docs = (await getDocs(query(collection(db, "broadcasts"), orderBy("createdAt", "desc"), limit(50)))).docs;
      listHolder.replaceChildren(
        table(
          ["Título", "Audiência", "Publicado", "Mensagem"],
          docs.map((d) => {
            const data = d.data();
            const target = Array.isArray(data.audience) ? data.audience.join(", ") : data.audience || "—";
            return el("tr", {}, [
              el("td", { text: data.title || "—" }),
              el("td", { text: target }),
              el("td", { text: fmtDate(data.createdAt) }),
              el("td", { class: "small", text: (data.body || "").slice(0, 160) }),
            ]);
          }),
          "Ainda não há comunicados."
        )
      );
    } catch (e) {
      listHolder.replaceChildren(errorBox(e));
    }
  }
}

/* ------------------------------------------------------------------ conteúdo */

export async function viewContent(root) {
  root.append(pageHeader("Páginas de conteúdo", "Sobre, Privacidade e Termos apresentados na app."));
  const page = el("select", { class: "input" }, [
    el("option", { value: "about", text: "Sobre" }),
    el("option", { value: "privacy", text: "Privacidade" }),
    el("option", { value: "terms", text: "Termos" }),
  ]);
  const title = el("input", { class: "input", placeholder: "Título" });
  const body = el("textarea", { class: "input", rows: "12" });
  const status = el("p", { class: "muted small", text: "" });

  root.append(
    section("Editor", [
      el("div", { class: "form" }, [
        el("label", { class: "field" }, [el("span", { text: "Página" }), page]),
        el("label", { class: "field" }, [el("span", { text: "Título" }), title]),
        el("label", { class: "field" }, [el("span", { text: "Texto" }), body]),
        el("div", { class: "row" }, [
          el("button", {
            class: "btn ghost",
            text: "Guardar página",
            onclick: async () => {
              const id = page.value;
              if (!title.value.trim() || title.value.trim().length < 2) return toast("Título demasiado curto.", "warn");
              try {
                const { setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
                await setDoc(
                  doc(db, "content", id),
                  { title: title.value.trim(), body: body.value.trim(), updatedAt: serverTimestamp() },
                  { merge: true }
                );
                await audit("content-updated", { page: id });
                toast("Página guardada.", "ok");
                await load();
              } catch (e) {
                toast(e.message, "bad");
              }
            },
          }),
        ]),
        status,
      ]),
    ])
  );

  page.addEventListener("change", load);
  await load();

  async function load() {
    status.textContent = "A carregar…";
    try {
      const snap = await getDoc(doc(db, "content", page.value));
      const data = snap.exists() ? snap.data() : {};
      title.value = data.title || "";
      body.value = data.body || "";
      status.textContent = snap.exists()
        ? `Última actualização: ${fmtDate(data.updatedAt)}. O app usa texto local quando a página não existe.`
        : "Esta página ainda não existe. O app usa o texto local até ser criada.";
    } catch (e) {
      status.textContent = e.message;
    }
  }
}

/* ------------------------------------------------------------------ auditoria */

export async function viewAudit(root) {
  root.append(pageHeader("Auditoria", "Registo de decisões e acções administrativas."));
  const holder = el("div", {});
  root.append(holder);
  holder.append(loading());
  try {
    const docs = (await getDocs(query(collection(db, "sellerAudit"), orderBy("createdAt", "desc"), limit(100)))).docs;
    holder.replaceChildren(
      table(
        ["Data", "Acção", "Alvo", "Responsável", "Detalhe"],
        docs.map((d) => {
          const data = d.data();
          const target = data.sellerId || data.productId || data.page || "—";
          const detail = data.reason || data.reasonShort || data.reason || (data.type ? `anexo: ${data.type}` : "");
          return el("tr", {}, [
            el("td", { text: fmtDate(data.createdAt) }),
            el("td", {}, [badge(data.action || "—", "neutral")]),
            el("td", { class: "mono small", text: String(target).slice(0, 28) }),
            el("td", { class: "mono small", text: String(data.actor || "—").slice(0, 28) }),
            el("td", { class: "small", text: detail }),
          ]);
        }),
        "Sem registos."
      )
    );
  } catch (e) {
    holder.replaceChildren(errorBox(e));
  }
}

/* ------------------------------------------------------------------ definições */

export async function viewSettings(root) {
  root.append(pageHeader("Definições e estado", "Ligação ao serviço privado e parâmetros em vigor."));
  const holder = el("div", {});
  root.append(holder);
  holder.append(loading());

  const health = await checkService();
  let config = {};
  try {
    const snap = await getDoc(doc(db, "config", "platform"));
    config = snap.exists() ? snap.data() : {};
  } catch {}

  let feeInput = null;
  holder.replaceChildren(
    section("Serviço privado", [
      el("dl", { class: "facts" }, [
        el("dt", { text: "Domínio da API" }),
        el("dd", { class: "mono", text: API_BASE }),
        el("dt", { text: "Alcance" }),
        el("dd", {}, [health.ok ? badge("Responde", "ok") : badge("Falhou", "bad"), el("span", { class: "muted small", text: ` ${health.detail}` })]),
        el("dt", { text: "Origem deste painel" }),
        el("dd", { class: "mono small", text: location.origin }),
        el("dt", { text: "Consentimento actual" }),
        el("dd", { class: "mono small", text: CONSENT_VERSION }),
      ]),
      el("p", { class: "muted small", text: "Se as imagens não abrirem com 'Origem bloqueada', adicione a origem acima à variável PANEL_ORIGIN das duas Functions." }),
    ]),
    section("Parâmetros da plataforma", [
      el("dl", { class: "facts" }, [
        el("dt", { text: "Modo catálogo" }),
        el("dd", { text: config.catalogOnly === true ? "Activo (sem compras)" : "—" }),
        el("dt", { text: "Checkout" }),
        el("dd", { text: config.checkoutEnabled === true ? "Ligado" : "Desligado" }),
        el("dt", { text: "Entrega gerida por" }),
        el("dd", { text: config.deliveryManagedBy || "—" }),
        el("dt", { text: "Taxa de entrega" }),
        el("dd", { text: fmtMZN(config.deliveryFeeMZN) }),
        el("dt", { text: "Versão legal registada" }),
        el("dd", { class: "mono small", text: config.legalVersion || "—" }),
        el("dt", { text: "Idade mínima registada" }),
        el("dd", { text: config.minimumAgePolicy ?? "—" }),
      ]),
    ]),
    section("Taxa de envio da UniStore", [
      el("p", {
        class: "muted small",
        text:
          "Valor cobrado quando o vendedor escolhe \"Pela UniStore\". Muda para todos os anúncios novos e para os pedidos criados a seguir.",
      }),
      el("div", { class: "form-grid" }, [
        el("label", {}, [
          el("span", { class: "muted small", text: "Valor em MT" }),
          (feeInput = el("input", {
            class: "input",
            type: "number",
            min: "0",
            max: "100000",
            step: "50",
            value: String(config.deliveryFeeMZN ?? 250),
          })),
        ]),
        el("div", { class: "head-actions" }, [
          el("button", {
            class: "btn primary",
            text: "Guardar taxa",
            onclick: async () => {
              const valor = Number(feeInput.value);
              if (!Number.isFinite(valor) || valor < 0 || valor > 100000) {
                return toast("Valor entre 0 e 100 000 MT.", "warn");
              }
              try {
                await setDoc(
                  doc(db, "config", "platform"),
                  { deliveryFeeMZN: valor, updatedAt: serverTimestamp() },
                  { merge: true }
                );
                await audit("delivery-fee-set", { deliveryFeeMZN: valor });
                toast("Taxa de envio guardada.", "ok");
              } catch (e) {
                toast(e.message, "bad");
              }
            },
          }),
        ]),
      ]),
    ]),
    section("Limites a recordar", [
      el("ul", { class: "list" }, [
        el("li", { text: "O painel não guarda documentos: as imagens vêm da API privada e não ficam em cache." }),
        el("li", { text: "Aprovar só é possível com eliminação confirmada dos dois anexos." }),
        el("li", { text: "Sem pagamentos nem entregas activas; nada aqui deve simular vendas." }),
        el("li", { text: "A chave antiga das fotos públicas continua no APK e deve ser revogada antes de produção." }),
      ]),
    ])
  );

  /* --------------------------------------------------------- notificações */
  let devices = null;
  try {
    const counted = await getCountFromServer(query(collection(db, "users"), where("fcmToken", ">", "")));
    devices = counted.data().count;
  } catch {
    devices = null;
  }
  const testId = el("input", { class: "input", placeholder: "ID da conta de destino" });
  const testBtn = el("button", {
    class: "btn",
    text: "Enviar notificação de teste",
    onclick: async (event) => {
      const id = testId.value.trim();
      if (!id) return toast("Indique o ID da conta de destino.", "warn");
      event.currentTarget.disabled = true;
      try {
        const result = await sendPush({
          title: "Teste UniStore",
          body: "Se vir isto na barra de notificações, o envio está a funcionar.",
          audience: id,
        });
        toast(
          result.sent ? `Enviado a ${result.sent} aparelho(s).` : "Essa conta não tem aparelho registado.",
          result.sent ? "ok" : "warn"
        );
      } catch (e) {
        toast(e.message, "bad");
      } finally {
        event.currentTarget.disabled = false;
      }
    },
  });
  const minVersion = el("input", {
    class: "input",
    type: "number",
    min: "1",
    placeholder: "ex.: 2",
    value: config.minimumVersionCode == null ? "" : String(config.minimumVersionCode),
  });
  holder.append(
    section("Versão mínima da app", [
      el("div", { class: "form" }, [
        el("label", { class: "field" }, [el("span", { text: "versionCode mínimo aceite" }), minVersion]),
        el("button", {
          class: "btn",
          text: "Guardar versão mínima",
          onclick: async (event) => {
            const raw = minVersion.value.trim();
            const value = raw === "" ? null : Number(raw);
            if (value !== null && (!Number.isInteger(value) || value < 1)) {
              return toast("Indique um número inteiro (1 ou mais) ou deixe vazio para desligar.", "warn");
            }
            event.currentTarget.disabled = true;
            try {
              await setDoc(doc(db, "config", "platform"), { minimumVersionCode: value }, { merge: true });
              await audit("minimum-version", { minimumVersionCode: value });
              toast(value === null ? "Bloqueio de versões desligado." : `Versões abaixo de ${value} ficam bloqueadas.`, "ok");
            } catch (e) {
              toast(e.message, "bad");
            } finally {
              event.currentTarget.disabled = false;
            }
          },
        }),
      ]),
      el("p", {
        class: "muted small",
        text: "A app compara este número com o versionCode instalado e, se for menor, mostra o ecrã de actualização. Deixe vazio enquanto não houver um APK mais recente publicado — caso contrário bloqueia os telemóveis actuais.",
      }),
    ])
  );

  const shareBase = el("input", {
    class: "input",
    type: "url",
    placeholder: "https://euclides-uncom.github.io/UniStore-painel/p/",
    value: config.shareBaseUrl || "",
  });
  holder.append(
    section("Links partilhados", [
      el("div", { class: "form" }, [
        el("label", { class: "field" }, [
          el("span", { text: "Endereço base do link do anúncio" }),
          shareBase,
        ]),
        el("button", {
          class: "btn",
          text: "Guardar endereço",
          onclick: async (event) => {
            const value = shareBase.value.trim();
            if (!value.startsWith("https://")) {
              return toast("O endereço tem de começar por https://", "warn");
            }
            event.currentTarget.disabled = true;
            try {
              await setDoc(doc(db, "config", "platform"), { shareBaseUrl: value }, { merge: true });
              await audit("share-base", { value });
              toast("Guardado. As apps passam a partilhar este endereço no próximo arranque.", "ok");
            } catch (e) {
              toast(e.message, "bad");
            } finally {
              event.currentTarget.disabled = false;
            }
          },
        }),
      ]),
      el("p", {
        class: "muted small",
        text: "É o endereço da página que recebe quem toca num anúncio partilhado. Deixe vazio para usar o GitHub Pages. Quando tiver domínio próprio, escreva-o aqui (ex.: https://unistore.co.mz/p/) — não é preciso publicar aplicação nova.",
      }),
    ])
  );

  holder.append(
    section("Notificações (FCM)", [
      el("dl", { class: "facts" }, [
        el("dt", { text: "Aparelhos com notificações" }),
        el("dd", { text: devices === null ? "—" : String(devices) }),
      ]),
      el("div", { class: "form" }, [
        el("label", { class: "field" }, [el("span", { text: "Teste para uma conta" }), testId]),
        testBtn,
      ]),
      el("p", {
        class: "muted small",
        text: "O contador só aumenta depois de a pessoa abrir a app autenticada e aceitar a permissão de notificações. Se o envio falhar com “Comunicado guardado, mas a notificação não foi enviada”, verifique a API Cloud Messaging (V1) no projecto Firebase.",
      }),
    ])
  );
}

export { fmtDay };

/* ------------------------------------------------------ comissões e mensalidades */

const MES = 30 * 24 * 3600 * 1000;

const comissaoTexto = (data) =>
  data.commissionExempt === true ? "Mensalidade" : "5% por venda";

const mensalidadeVencida = (data) => {
  const ate = data.planPaidUntil?.toMillis?.();
  return data.commissionExempt === true && ate && ate < Date.now();
};

export async function viewCommissions(root) {
  root.append(
    pageHeader(
      "Comissões e mensalidades",
      "Quem paga 5% por venda e quem está isento com mensalidade. Esta decisão é só do administrador."
    )
  );
  const holder = el("div", {});
  root.append(holder);
  await render();

  async function render() {
    holder.replaceChildren(loading());
    let docs = [];
    try {
      const snap = await getDocs(query(collection(db, "stores"), limit(300)));
      docs = snap.docs.filter((d) => d.data().status === "approved");
    } catch (e) {
      holder.replaceChildren(errorBox(e));
      return;
    }

    const isentas = docs.filter((d) => d.data().commissionExempt === true);
    const vencidas = isentas.filter((d) => mensalidadeVencida(d.data()));
    const cobradas = docs.length - isentas.length;

    holder.replaceChildren(
      el("div", { class: "grid stats" }, [
        card("Lojas aprovadas", docs.length),
        card("Com mensalidade", isentas.length),
        card("A pagar 5%", cobradas),
        card("Mensalidades vencidas", vencidas.length),
      ]),
      el("p", {
        class: "muted small",
        text:
          "A taxa é sempre 5% do valor do produto. A mensalidade substitui a taxa enquanto estiver activa — " +
          "o painel não recebe pagamentos: registe aqui o que foi acordado com o vendedor.",
      }),
      table(
        ["Loja", "Cidade", "A pagar", "Mensalidade", "Pago até", "Acções"],
        docs.map((d) => {
          const data = d.data();
          const isenta = data.commissionExempt === true;
          const ate = data.planPaidUntil;
          return el("tr", {}, [
            el("td", { text: data.name || d.id }),
            el("td", { text: data.city || "—" }),
            el("td", {}, [
              badge(comissaoTexto(data), isenta ? "ok" : "neutral"),
              mensalidadeVencida(data) ? badge("Vencida", "warn") : null,
            ]),
            el("td", { text: data.monthlyFeeMZN ? fmtMZN(data.monthlyFeeMZN) : "—" }),
            el("td", { text: ate ? fmtDay(ate) : "—" }),
            el("td", { class: "actions" }, [
              isenta
                ? el("button", {
                    class: "btn small danger",
                    text: "Voltar a cobrar 5%",
                    onclick: () => voltarACobrar(d, render),
                  })
                : el("button", {
                    class: "btn small primary",
                    text: "Dar mensalidade",
                    onclick: () => darMensalidade(d, render),
                  }),
              el("button", {
                class: "btn small ghost",
                text: "Definir valor",
                onclick: () => definirValor(d, render),
              }),
              isenta
                ? el("button", {
                    class: "btn small ghost",
                    text: "Registar pagamento (+30 dias)",
                    onclick: () => registarPagamento(d, render),
                  })
                : null,
            ]),
          ]);
        }),
        "Sem lojas aprovadas."
      )
    );
  }
}

function darMensalidade(snapshot, refresh) {
  const valor = el("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "50",
    placeholder: "Mensalidade em MT (ex.: 500)",
    value: String(snapshot.data().monthlyFeeMZN || ""),
  });
  const { close } = openModal({
    title: `Mensalidade — ${snapshot.data().name || snapshot.id}`,
    body: [
      el("p", {
        class: "muted",
        text: "Enquanto a mensalidade estiver activa, a loja deixa de pagar os 5% por venda. O valor é apenas registado; não há cobrança automática.",
      }),
      valor,
    ],
    actions: [
      el("button", { class: "btn ghost", text: "Cancelar", onclick: () => close() }),
      el("button", {
        class: "btn primary",
        text: "Activar mensalidade",
        onclick: async () => {
          const fee = Number(valor.value);
          if (!Number.isFinite(fee) || fee < 0) return toast("Valor inválido.", "warn");
          try {
            await updateDoc(doc(db, "stores", snapshot.id), {
              commissionExempt: true,
              monthlyFeeMZN: fee,
              planPaidUntil: new Date(Date.now() + MES),
              planStartedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            await audit("commission-exempt-on", { sellerId: snapshot.id, monthlyFeeMZN: fee });
            close();
            toast("Mensalidade activada.", "ok");
            await refresh();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      }),
    ],
  });
}

function voltarACobrar(snapshot, refresh) {
  confirmModal({
    title: "Voltar a cobrar 5%",
    message: `A loja ${snapshot.data().name || snapshot.id} volta a pagar 5% do valor de cada venda. A mensalidade fica cancelada.`,
    confirmLabel: "Cobrar 5%",
    danger: true,
    onConfirm: async () => {
      try {
        await updateDoc(doc(db, "stores", snapshot.id), {
          commissionExempt: false,
          monthlyFeeMZN: 0,
          planPaidUntil: null,
          updatedAt: serverTimestamp(),
        });
        await audit("commission-exempt-off", { sellerId: snapshot.id });
        toast("A loja volta a pagar 5%.", "ok");
        await refresh();
      } catch (e) {
        toast(e.message, "bad");
      }
    },
  });
}

function definirValor(snapshot, refresh) {
  const valor = el("input", {
    class: "input",
    type: "number",
    min: "0",
    step: "50",
    placeholder: "Mensalidade em MT",
    value: String(snapshot.data().monthlyFeeMZN || ""),
  });
  const { close } = openModal({
    title: `Valor da mensalidade — ${snapshot.data().name || snapshot.id}`,
    body: [el("p", { class: "muted", text: "Só o valor registado. Não altera a isenção." }), valor],
    actions: [
      el("button", { class: "btn ghost", text: "Cancelar", onclick: () => close() }),
      el("button", {
        class: "btn primary",
        text: "Guardar",
        onclick: async () => {
          const fee = Number(valor.value);
          if (!Number.isFinite(fee) || fee < 0) return toast("Valor inválido.", "warn");
          try {
            await updateDoc(doc(db, "stores", snapshot.id), { monthlyFeeMZN: fee, updatedAt: serverTimestamp() });
            await audit("commission-fee-set", { sellerId: snapshot.id, monthlyFeeMZN: fee });
            close();
            toast("Valor registado.", "ok");
            await refresh();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      }),
    ],
  });
}

function registarPagamento(snapshot, refresh) {
  const data = snapshot.data();
  const ate = data.planPaidUntil?.toMillis?.() || 0;
  const base = Math.max(Date.now(), ate);
  const nova = new Date(base + MES);
  confirmModal({
    title: "Registar pagamento",
    message: `A mensalidade de ${data.name || snapshot.id} fica paga até ${nova.toLocaleDateString("pt-PT")}. Confirme que recebeu o valor fora do painel.`,
    confirmLabel: "Registar",
    onConfirm: async () => {
      try {
        await updateDoc(doc(db, "stores", snapshot.id), { planPaidUntil: nova, updatedAt: serverTimestamp() });
        await audit("commission-paid", { sellerId: snapshot.id, planPaidUntil: nova.toISOString() });
        toast("Pagamento registado.", "ok");
        await refresh();
      } catch (e) {
        toast(e.message, "bad");
      }
    },
  });
}

/* ---------------------------------------------------------------- promoções */

export async function viewPromotions(root) {
  root.append(
    pageHeader(
      "Promoções",
      "Descontos de loja ou de anúncio. Ao terminar, o rótulo desaparece da app no mesmo instante."
    )
  );
  const holder = el("div", {});
  root.append(holder);
  await render();

  async function render() {
    holder.replaceChildren(loading());
    let stores = [];
    let products = [];
    let promos = [];
    try {
      const [s, p, pr] = await Promise.all([
        getDocs(query(collection(db, "stores"), limit(300))),
        getDocs(query(collection(db, "products"), limit(500))),
        getDocs(query(collection(db, "promotions"), limit(200))),
      ]);
      stores = s.docs;
      products = p.docs;
      promos = sortByDate(pr.docs, "createdAt");
    } catch (e) {
      holder.replaceChildren(permissionBox(e));
      return;
    }

    const activas = promos.filter((d) => d.data().active === true).length;

    holder.replaceChildren(
      el("div", { class: "grid stats" }, [
        card("Promoções activas", activas),
        card("Histórico", promos.length),
      ]),
      section("Criar promoção", [formPromocao(stores, products, render)]),
      section("Promoções", [
        table(
          ["Alvo", "Tipo", "Desconto", "Rótulo", "Início", "Fim", "Estado", "Acções"],
          promos.map((d) => {
            const data = d.data();
            return el("tr", {}, [
              el("td", { text: data.targetName || data.targetId }),
              el("td", { text: data.kind === "store" ? "Loja" : "Anúncio" }),
              el("td", { text: `${data.percent || 0}%` }),
              el("td", { text: data.label || "—" }),
              el("td", { text: fmtDay(data.startsAt) }),
              el("td", { text: fmtDay(data.endsAt) }),
              el("td", {}, [badge(data.active === true ? "Activa" : "Terminada", data.active === true ? "ok" : "neutral")]),
              el("td", { class: "actions" }, [
                data.active === true
                  ? el("button", { class: "btn small danger", text: "Terminar", onclick: () => terminar(d, render) })
                  : null,
              ]),
            ]);
          }),
          "Sem promoções registadas."
        ),
      ])
    );
  }
}

function formPromocao(stores, products, refresh) {
  const tipo = el("select", { class: "input" }, [
    el("option", { value: "product", text: "Anúncio" }),
    el("option", { value: "store", text: "Loja" }),
  ]);
  const alvo = el("select", { class: "input" });
  const percent = el("input", { class: "input", type: "number", min: "1", max: "90", step: "1", placeholder: "Desconto em % (1–90)" });
  const rotulo = el("input", { class: "input", maxlength: "40", placeholder: "Rótulo (ex.: Semana do bebé)" });
  const dias = el("input", { class: "input", type: "number", min: "1", max: "90", step: "1", placeholder: "Duração em dias (1–90)", value: "7" });

  const encherAlvos = () => {
    alvo.replaceChildren();
    const lista = tipo.value === "store" ? stores : products;
    if (!lista.length) {
      alvo.append(el("option", { value: "", text: "Nada disponível" }));
      return;
    }
    for (const d of lista) {
      const data = d.data();
      alvo.append(el("option", { value: d.id, text: data.name || d.id }));
    }
  };
  encherAlvos();
  tipo.addEventListener("change", encherAlvos);

  return el("div", { class: "form-grid" }, [
    el("label", {}, [el("span", { class: "muted small", text: "Tipo" }), tipo]),
    el("label", {}, [el("span", { class: "muted small", text: "Alvo" }), alvo]),
    el("label", {}, [el("span", { class: "muted small", text: "Desconto" }), percent]),
    el("label", {}, [el("span", { class: "muted small", text: "Rótulo" }), rotulo]),
    el("label", {}, [el("span", { class: "muted small", text: "Dias" }), dias]),
    el("div", { class: "head-actions" }, [
      el("button", {
        class: "btn primary",
        text: "Criar promoção",
        onclick: async () => {
          const p = Number(percent.value);
          const n = Number(dias.value);
          if (!alvo.value) return toast("Escolha o alvo.", "warn");
          if (!Number.isFinite(p) || p < 1 || p > 90) return toast("Desconto entre 1% e 90%.", "warn");
          if (!Number.isFinite(n) || n < 1 || n > 90) return toast("Duração entre 1 e 90 dias.", "warn");
          const nome = alvo.options[alvo.selectedIndex]?.text || alvo.value;
          const ate = new Date(Date.now() + n * 24 * 3600 * 1000);
          try {
            await addDoc(collection(db, "promotions"), {
              kind: tipo.value,
              targetId: alvo.value,
              targetName: nome,
              percent: p,
              label: rotulo.value.trim(),
              startsAt: new Date(),
              endsAt: ate,
              active: true,
              createdAt: serverTimestamp(),
              createdBy: auth.currentUser?.uid || "painel",
            });
            // O que a app lê vive no próprio documento do alvo (sem leituras extra).
            await updateDoc(doc(db, tipo.value === "store" ? "stores" : "products", alvo.value), {
              promoPercent: p,
              promoLabel: rotulo.value.trim(),
              promoUntil: ate,
              updatedAt: serverTimestamp(),
            });
            await audit("promotion-start", { kind: tipo.value, targetId: alvo.value, percent: p });
            toast("Promoção criada.", "ok");
            await refresh();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      }),
    ]),
  ]);
}

function terminar(snapshot, refresh) {
  const data = snapshot.data();
  confirmModal({
    title: "Terminar promoção",
    message: `O desconto de ${data.percent}% em ${data.targetName || data.targetId} desaparece da app imediatamente.`,
    confirmLabel: "Terminar",
    danger: true,
    onConfirm: async () => {
      try {
        await updateDoc(doc(db, "promotions", snapshot.id), { active: false, endedAt: serverTimestamp() });
        await updateDoc(doc(db, data.kind === "store" ? "stores" : "products", data.targetId), {
          promoPercent: 0,
          promoLabel: "",
          promoUntil: null,
          updatedAt: serverTimestamp(),
        });
        await audit("promotion-end", { kind: data.kind, targetId: data.targetId });
        toast("Promoção terminada.", "ok");
        await refresh();
      } catch (e) {
        toast(e.message, "bad");
      }
    },
  });
}

/* --------------------------------------------------------------- utilizadores */

export async function viewUsers(root) {
  root.append(
    pageHeader(
      "Utilizadores",
      "Contas registadas. Bloquear corta o acesso à app imediatamente; os dados ficam guardados."
    )
  );
  const holder = el("div", {});
  const procura = el("input", { class: "input", placeholder: "Procurar por nome, e-mail ou telefone…" });
  const filtro = el("select", { class: "input" }, [
    el("option", { value: "", text: "Todos" }),
    el("option", { value: "buyer", text: "Compradores" }),
    el("option", { value: "seller", text: "Vendedores" }),
    el("option", { value: "blocked", text: "Bloqueados" }),
  ]);
  let docs = [];

  root.append(el("div", { class: "form-grid" }, [procura, filtro]), holder);
  await render();

  procura.addEventListener("input", render);
  filtro.addEventListener("change", render);

  async function render() {
    holder.replaceChildren(loading());
    if (!docs.length) {
      try {
        docs = sortByDate((await getDocs(query(collection(db, "users"), limit(1000)))).docs, "createdAt");
      } catch (e) {
        holder.replaceChildren(errorBox(e));
        return;
      }
    }
    const termo = procura.value.trim().toLowerCase();
    const papel = filtro.value;
    const lista = docs.filter((d) => {
      const u = d.data();
      if (papel === "blocked" && u.blocked !== true) return false;
      if (papel && papel !== "blocked" && u.role !== papel) return false;
      if (!termo) return true;
      return [u.name, u.email, u.phone].some((v) => String(v || "").toLowerCase().includes(termo));
    });

    holder.replaceChildren(
      el("p", { class: "muted small", text: `${lista.length} de ${docs.length} conta(s).` }),
      table(
        ["Nome", "E-mail", "Telefone", "Conta", "Estado", "Registo", "Acções"],
        lista.slice(0, 300).map((d) => {
          const u = d.data();
          const bloqueada = u.blocked === true;
          return el("tr", {}, [
            el("td", { text: u.name || "—" }),
            el("td", { text: u.email || "—" }),
            el("td", { text: u.phone || "—" }),
            el("td", {}, [badge(u.role === "seller" ? "Vendedor" : "Comprador", u.role === "seller" ? "ok" : "neutral")]),
            el("td", {}, [
              bloqueada ? badge("Bloqueada", "bad") : badge("Activa", "neutral"),
              bloqueada && u.blockedReason ? el("div", { class: "muted tiny", text: u.blockedReason }) : null,
            ]),
            el("td", { text: fmtDay(u.createdAt) }),
            el("td", { class: "actions" }, [
              bloqueada
                ? el("button", { class: "btn small primary", text: "Desbloquear", onclick: () => desbloquear(d, render) })
                : el("button", { class: "btn small danger", text: "Bloquear", onclick: () => bloquear(d, render) }),
            ]),
          ]);
        }),
        "Sem contas."
      )
    );
  }
}

function bloquear(snapshot, refresh) {
  const motivo = el("textarea", {
    class: "input",
    rows: "3",
    maxlength: "300",
    placeholder: "Motivo do bloqueio (mínimo 5 caracteres).",
  });
  const { close } = openModal({
    title: `Bloquear ${snapshot.data().name || snapshot.id}`,
    body: [
      el("p", {
        class: "muted",
        text: "A conta deixa de conseguir usar a app no próximo arranque. A loja, se existir, deve ser suspensa em separado.",
      }),
      motivo,
    ],
    actions: [
      el("button", { class: "btn ghost", text: "Cancelar", onclick: () => close() }),
      el("button", {
        class: "btn danger",
        text: "Bloquear",
        onclick: async () => {
          const razao = motivo.value.trim();
          if (razao.length < 5) return toast("Motivo demasiado curto.", "warn");
          try {
            await updateDoc(doc(db, "users", snapshot.id), {
              blocked: true,
              blockedReason: razao,
              blockedAt: serverTimestamp(),
              unblockedAt: null,
            });
            await audit("user-block", { uid: snapshot.id, reason: razao });
            close();
            toast("Conta bloqueada.", "ok");
            docs = [];
            await refresh();
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      }),
    ],
  });
}

function desbloquear(snapshot, refresh) {
  confirmModal({
    title: "Desbloquear conta",
    message: `A conta ${snapshot.data().name || snapshot.id} volta a poder entrar na app.`,
    confirmLabel: "Desbloquear",
    onConfirm: async () => {
      try {
        await updateDoc(doc(db, "users", snapshot.id), {
          blocked: false,
          blockedReason: "",
          unblockedAt: serverTimestamp(),
        });
        await audit("user-unblock", { uid: snapshot.id });
        toast("Conta desbloqueada.", "ok");
        docs = [];
        await refresh();
      } catch (e) {
        toast(e.message, "bad");
      }
    },
  });
}

/* ------------------------------------------------------------------ financeiro */

const PAGOS = ["paid", "shipped", "delivered"];

export async function viewFinance(root) {
  root.append(
    pageHeader(
      "Financeiro",
      "Faturação, comissão de 5% e mensalidades. Só o que já está pago entra nas contas."
    )
  );
  const holder = el("div", {});
  root.append(holder);
  holder.append(loading());

  let ordens = [];
  let lojas = [];
  try {
    const [o, s] = await Promise.all([
      getDocs(query(collection(db, "orders"), limit(1000))),
      getDocs(query(collection(db, "stores"), limit(300))),
    ]);
    ordens = o.docs;
    lojas = s.docs.filter((d) => d.data().status === "approved");
  } catch (e) {
    holder.replaceChildren(errorBox(e));
    return;
  }

  const pago = ordens.filter((d) => PAGOS.includes(d.data().status));
  const porLoja = new Map();
  let faturacao = 0;

  for (const d of pago) {
    const o = d.data();
    const itens = Array.isArray(o.items) ? o.items : [];
    for (const it of itens) {
      if (!it.sellerId) continue;
      const valor = Number(it.priceMZN || 0) * Number(it.qty || 0);
      faturacao += valor;
      const atual = porLoja.get(it.sellerId) || { vendas: 0, valor: 0 };
      atual.vendas += 1;
      atual.valor += valor;
      porLoja.set(it.sellerId, atual);
    }
  }

  let comissao = 0;
  let mensalidades = 0;
  let vencidas = 0;

  const linhas = lojas
    .map((d) => {
      const loja = d.data();
      const agg = porLoja.get(d.id) || { vendas: 0, valor: 0 };
      const isenta = loja.commissionExempt === true;
      const valorComissao = isenta ? 0 : agg.valor * 0.05;
      comissao += valorComissao;
      if (isenta) mensalidades += Number(loja.monthlyFeeMZN || 0);
      const ate = loja.planPaidUntil?.toMillis?.();
      const atrasada = isenta && ate && ate < Date.now();
      if (atrasada) vencidas += 1;
      return { d, loja, agg, isenta, valorComissao, ate, atrasada };
    })
    .sort((a, b) => b.agg.valor - a.agg.valor);

  holder.replaceChildren(
    el("div", { class: "grid stats" }, [
      card("Faturação paga", fmtMZN(faturacao)),
      card("Comissão a receber (5%)", fmtMZN(comissao)),
      card("Mensalidades / mês", fmtMZN(mensalidades)),
      card("Mensalidades em atraso", vencidas),
    ]),
    el("p", {
      class: "muted small",
      text:
        "A comissão é calculada sobre os artigos de pedidos pagos, enviados ou entregues. " +
        "As lojas com mensalidade activa não entram nos 5%. O painel não cobra nada: os valores servem para conferir o que foi recebido.",
    }),
    section("Por loja", [
      table(
        ["Loja", "Vendas pagas", "Faturação", "Comissão 5%", "Mensalidade", "Pago até", "Situação"],
        linhas.map(({ d, loja, agg, isenta, valorComissao, ate, atrasada }) =>
          el("tr", {}, [
            el("td", { text: loja.name || d.id }),
            el("td", { text: String(agg.vendas) }),
            el("td", { text: fmtMZN(agg.valor) }),
            el("td", { text: isenta ? "—" : fmtMZN(valorComissao) }),
            el("td", { text: isenta && loja.monthlyFeeMZN ? fmtMZN(loja.monthlyFeeMZN) : "5% por venda" }),
            el("td", { text: ate ? fmtDay(loja.planPaidUntil) : "—" }),
            el("td", {}, [
              isenta ? badge("Mensalidade", "ok") : badge("5%", "neutral"),
              atrasada ? badge("Vencida", "warn") : null,
            ]),
          ])
        ),
        "Sem lojas aprovadas."
      ),
    ]),
    section("Pedidos recentes", [
      table(
        ["Pedido", "Estado", "Total", "Comprador"],
        sortByDate(pago, "createdAt")
          .slice(0, 15)
          .map((d) => {
            const o = d.data();
            return el("tr", {}, [
              el("td", { text: o.orderNumber || d.id }),
              el("td", {}, [statusBadge(o.status)]),
              el("td", { text: fmtMZN(Number(o.totalMZN || 0)) }),
              el("td", { text: o.buyerName || o.buyerId || "—" }),
            ]);
          }),
        "Sem pedidos pagos."
      ),
    ])
  );
}

/* --------------------------------------------------------------- pesquisa global */

let navigateTo = () => {};

/** O shell diz à pesquisa como mudar de separador (sem acoplar a vista ao router). */
export function setNavigator(fn) {
  navigateTo = typeof fn === "function" ? fn : () => {};
}

export async function viewSearch(root) {
  root.append(pageHeader("Pesquisar", "Contas, lojas, anúncios e pedidos num só sítio."));
  const entrada = el("input", {
    class: "input",
    type: "search",
    placeholder: "Nome, e-mail, telefone, produto, marca, nº de pedido…",
  });
  const saida = el("div", {});
  root.append(el("div", { class: "form-grid" }, [entrada]), saida);
  saida.append(loading());

  let dados = null;
  let erro = null;
  const carregar = async () => {
    if (dados || erro) return;
    try {
      const [u, s, p, o] = await Promise.all([
        getDocs(query(collection(db, "users"), limit(500))),
        getDocs(query(collection(db, "stores"), limit(300))),
        getDocs(query(collection(db, "products"), limit(500))),
        getDocs(query(collection(db, "orders"), limit(300))),
      ]);
      dados = { users: u.docs, stores: s.docs, products: p.docs, orders: o.docs };
    } catch (e) {
      erro = e;
    }
  };

  const procurar = async () => {
    await carregar();
    if (erro) {
      saida.replaceChildren(errorBox(erro));
      return;
    }
    const termo = entrada.value.trim().toLowerCase();
    if (termo.length < 2) {
      saida.replaceChildren(
        el("p", { class: "muted", text: "Escreva pelo menos duas letras. A pesquisa cobre toda a base." })
      );
      return;
    }
    const contem = (...valores) => valores.some((v) => String(v || "").toLowerCase().includes(termo));

    const contas = dados.users.filter((d) => {
      const u = d.data();
      return contem(u.name, u.email, u.phone);
    });
    const lojas = dados.stores.filter((d) => {
      const s = d.data();
      return contem(s.name, s.city, s.description);
    });
    const anuncios = dados.products.filter((d) => {
      const p = d.data();
      return contem(p.name, p.brand, p.category, p.subcategory, p.sellerName);
    });
    const pedidos = dados.orders.filter((d) => {
      const o = d.data();
      return contem(o.orderNumber, o.buyerName, o.buyerPhone, o.id);
    });

    const total = contas.length + lojas.length + anuncios.length + pedidos.length;
    saida.replaceChildren(
      el("p", { class: "muted small", text: `${total} resultado(s) para “${entrada.value.trim()}”.` }),
      secao("Contas", contas.length, () =>
        table(
          ["Nome", "E-mail", "Telefone", "Conta"],
          contas.slice(0, 20).map((d) => {
            const u = d.data();
            return el("tr", {}, [
              el("td", { text: u.name || "—" }),
              el("td", { text: u.email || "—" }),
              el("td", { text: u.phone || "—" }),
              el("td", {}, [badge(u.role === "seller" ? "Vendedor" : "Comprador", u.role === "seller" ? "ok" : "neutral")]),
            ]);
          })
        )
      ),
      secao("Lojas", lojas.length, () =>
        table(
          ["Loja", "Cidade", "Estado", "Comissão"],
          lojas.slice(0, 20).map((d) => {
            const s = d.data();
            return el("tr", {}, [
              el("td", { text: s.name || d.id }),
              el("td", { text: s.city || "—" }),
              el("td", {}, [statusBadge(s.status)]),
              el("td", {}, [badge(s.commissionExempt === true ? "Mensalidade" : "5%", s.commissionExempt === true ? "ok" : "neutral")]),
            ]);
          })
        )
      ),
      secao("Anúncios", anuncios.length, () =>
        table(
          ["Anúncio", "Marca", "Preço", "Loja", "Estado"],
          anuncios.slice(0, 20).map((d) => {
            const p = d.data();
            return el("tr", {}, [
              el("td", { text: p.name || d.id }),
              el("td", { text: p.brand || "—" }),
              el("td", { text: fmtMZN(Number(p.priceMZN || 0)) }),
              el("td", { text: p.sellerName || "—" }),
              el("td", {}, [badge(p.active === true ? "Activo" : "Inactivo", p.active === true ? "ok" : "neutral")]),
            ]);
          })
        )
      ),
      secao("Pedidos", pedidos.length, () =>
        table(
          ["Pedido", "Estado", "Total", "Comprador"],
          pedidos.slice(0, 20).map((d) => {
            const o = d.data();
            return el("tr", {}, [
              el("td", { text: o.orderNumber || d.id }),
              el("td", {}, [statusBadge(o.status)]),
              el("td", { text: fmtMZN(Number(o.totalMZN || 0)) }),
              el("td", { text: o.buyerName || o.buyerId || "—" }),
            ]);
          })
        )
      )
    );
  };

  function secao(titulo, quantidade, corpo) {
    if (!quantidade) return el("div", {});
    const destino =
      titulo === "Lojas" ? "stores" : titulo === "Anúncios" ? "products" : titulo === "Pedidos" ? "orders" : "users";
    return section(`${titulo} (${quantidade})`, [
      corpo(),
      el("div", { class: "head-actions" }, [
        el("button", {
          class: "btn ghost small",
          text: "Abrir separador",
          onclick: () => navigateTo(destino),
        }),
      ]),
    ]);
  }

  let temporizador = null;
  entrada.addEventListener("input", () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(procurar, 250);
  });
  entrada.focus();

  await procurar();
}
