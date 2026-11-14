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
  root.append(holder);
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
    if (!docs.length) {
      holder.replaceChildren(el("p", { class: "empty", text: "Sem lojas registadas." }));
      return;
    }
    holder.replaceChildren(
      table(
        ["Loja", "Cidade", "Estado", "Documentos", "Selos", "Acções"],
        docs.map((d) => {
          const data = d.data();
          const approved = data.status === "approved";
          return el("tr", {}, [
            el("td", { text: data.name || d.id }),
            el("td", { text: data.city || "—" }),
            el("td", {}, [statusBadge(data.status)]),
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
  root.append(holder);
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
    if (!docs.length) {
      holder.replaceChildren(el("p", { class: "empty", text: "Sem anúncios." }));
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
