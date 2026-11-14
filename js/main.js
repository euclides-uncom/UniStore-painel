import { FIREBASE_CONFIG, configReady, saveConfig, clearConfig } from "../config.js";
import { login, logout, watchAuth } from "./firebase.js";
import { el, toast } from "./ui.js";
import * as views from "./views.js";

const ROUTES = [
  { id: "overview", label: "Visão geral", icon: "◧", view: views.viewOverview },
  { id: "verifications", label: "Verificações", icon: "✓", view: views.viewVerifications },
  { id: "stores", label: "Lojas", icon: "⌂", view: views.viewStores },
  { id: "products", label: "Anúncios", icon: "▤", view: views.viewProducts },
  { id: "reports", label: "Denúncias", icon: "⚑", view: views.viewReports },
  { id: "reviews", label: "Avaliações", icon: "★", view: views.viewReviews },
  { id: "orders", label: "Pedidos", icon: "▦", view: views.viewOrders },
  { id: "messages", label: "Comunicados", icon: "✉", view: views.viewMessages },
  { id: "content", label: "Conteúdo", icon: "✎", view: views.viewContent },
  { id: "audit", label: "Auditoria", icon: "≡", view: views.viewAudit },
  { id: "settings", label: "Definições", icon: "⚙", view: views.viewSettings },
];

const root = document.getElementById("app");
let currentRoute = (location.hash || "#/overview").replace("#/", "");
let signedIn = false;

function loginScreen(message) {
  root.replaceChildren();
  const email = el("input", { class: "input", type: "email", autocomplete: "username", placeholder: "E-mail administrativo" });
  const password = el("input", { class: "input", type: "password", autocomplete: "current-password", placeholder: "Palavra-passe" });
  const button = el("button", { class: "btn primary wide", text: "Entrar" });
  const feedback = el("p", { class: "muted small", text: message || "" });

  const submit = async () => {
    if (!email.value.trim() || !password.value) return (feedback.textContent = "Preencha e-mail e palavra-passe.");
    button.disabled = true;
    button.textContent = "A entrar…";
    feedback.textContent = "";
    try {
      await login(email.value, password.value);
    } catch (e) {
      const map = {
        "auth/invalid-credential": "Credenciais inválidas.",
        "auth/user-not-found": "Conta inexistente.",
        "auth/wrong-password": "Palavra-passe incorrecta.",
        "auth/too-many-requests": "Demasiadas tentativas. Aguarde alguns minutos.",
        "auth/network-request-failed": "Sem ligação à internet.",
        "auth/operation-not-allowed": "Active o início de sessão por e-mail/palavra-passe no Firebase Authentication.",
      };
      feedback.textContent = map[e.code] || e.message;
    } finally {
      button.disabled = false;
      button.textContent = "Entrar";
    }
  };

  button.addEventListener("click", submit);
  password.addEventListener("keydown", (event) => event.key === "Enter" && submit());

  root.append(
    el("div", { class: "login" }, [
      el("div", { class: "login-card" }, [
        el("div", { class: "brand" }, [el("span", { class: "brand-mark", text: "U" }), el("div", {}, [el("strong", { text: "UniStore" }), el("span", { class: "muted small", text: "Painel administrativo" })])]),
        el("p", { class: "muted small", text: "Acesso exclusivo a contas com a claim admin:true. Não introduza credenciais de outras pessoas." }),
        el("div", { class: "form" }, [email, password, button, feedback]),
        el("p", { class: "muted tiny", text: "Sessão guardada apenas neste navegador. Termine sempre a sessão em dispositivos partilhados." }),
      ]),
    ])
  );
  email.focus();
}

function shell(user) {
  root.replaceChildren();
  const nav = el("nav", { class: "nav" });
  const main = el("main", { class: "main" });
  const routeMap = new Map(ROUTES.map((r) => [r.id, r]));

  const setActive = (id) => {
    for (const link of nav.querySelectorAll("button")) link.classList.toggle("active", link.dataset.route === id);
  };

  const open = async (id, push = true) => {
    const route = routeMap.get(id) || routeMap.get("overview");
    currentRoute = route.id;
    setActive(route.id);
    if (push && location.hash !== `#/${route.id}`) history.replaceState(null, "", `#/${route.id}`);
    main.replaceChildren();
    try {
      await route.view(main);
    } catch (e) {
      main.append(el("div", { class: "errorbox" }, [el("strong", { text: "Falhou a carregar" }), el("p", { text: e.message || String(e) })]));
    }
  };

  for (const route of ROUTES) {
    nav.append(
      el("button", {
        class: "nav-link",
        "data-route": route.id,
        onclick: () => open(route.id),
      }, [el("span", { class: "nav-icon", text: route.icon }), el("span", { text: route.label })])
    );
  }

  const signOut = async () => {
    await logout();
    toast("Sessão terminada.", "ok");
  };

  root.append(
    el("div", { class: "layout" }, [
      el("aside", { class: "sidebar" }, [
        el("div", { class: "brand" }, [el("span", { class: "brand-mark", text: "U" }), el("div", {}, [el("strong", { text: "UniStore" }), el("span", { class: "muted small", text: "Administração" })])]),
        nav,
        el("div", { class: "sidebar-foot" }, [
          el("span", { class: "muted tiny", text: user.email || "" }),
          el("button", { class: "btn ghost small", text: "Terminar sessão", onclick: signOut }),
        ]),
      ]),
      main,
    ])
  );

  open(currentRoute, false);
}

function blocked(message) {
  root.replaceChildren();
  root.append(
    el("div", { class: "login" }, [
      el("div", { class: "login-card" }, [
        el("h1", { text: "Acesso negado" }),
        el("p", { class: "muted", text: message || "Esta conta não tem permissões de administração." }),
        el("p", { class: "muted small", text: "Peça a atribuição da claim admin:true ao operador do projecto." }),
        el("button", { class: "btn ghost", text: "Terminar sessão", onclick: () => logout() }),
      ]),
    ])
  );
}

function setupScreen() {
  root.replaceChildren();
  const apiKey = el("input", { class: "input", placeholder: "apiKey", value: FIREBASE_CONFIG.apiKey?.startsWith("COLOQUE") ? "" : FIREBASE_CONFIG.apiKey || "" });
  const appId = el("input", { class: "input", placeholder: "appId", value: FIREBASE_CONFIG.appId?.startsWith("COLOQUE") ? "" : FIREBASE_CONFIG.appId || "" });
  const authDomain = el("input", { class: "input", value: FIREBASE_CONFIG.authDomain || "" });
  const projectId = el("input", { class: "input", value: FIREBASE_CONFIG.projectId || "" });
  const feedback = el("p", { class: "muted small", text: "Estes valores são públicos. Não cole chaves privadas, service accounts nem chaves do Appwrite." });

  root.append(
    el("div", { class: "login" }, [
      el("div", { class: "login-card" }, [
        el("div", { class: "brand" }, [el("span", { class: "brand-mark", text: "U" }), el("div", {}, [el("strong", { text: "UniStore" }), el("span", { class: "muted small", text: "Configuração inicial" })])]),
        el("p", { class: "muted small", text: "Cole os valores da app Web do Firebase (Project settings → Your apps → Web). Ficam guardados apenas neste navegador." }),
        el("div", { class: "form" }, [
          el("label", { class: "field" }, [el("span", { text: "apiKey" }), apiKey]),
          el("label", { class: "field" }, [el("span", { text: "appId" }), appId]),
          el("label", { class: "field" }, [el("span", { text: "authDomain" }), authDomain]),
          el("label", { class: "field" }, [el("span", { text: "projectId" }), projectId]),
          el("button", {
            class: "btn primary wide",
            text: "Guardar e continuar",
            onclick: () => {
              if (!apiKey.value.trim().startsWith("AIza") || !appId.value.includes(":")) {
                feedback.textContent = "A apiKey começa por AIza e o appId tem o formato 1:...:web:...";
                return;
              }
              saveConfig({ apiKey: apiKey.value, appId: appId.value, authDomain: authDomain.value, projectId: projectId.value });
              location.reload();
            },
          }),
          feedback,
        ]),
        el("button", { class: "btn ghost small", text: "Apagar configuração deste navegador", onclick: () => { clearConfig(); location.reload(); } }),
      ]),
    ])
  );
}

function boot() {
  if (!configReady()) {
    setupScreen();
    return;
  }

  watchAuth(({ user, admin, reason }) => {
    if (!user) {
      signedIn = false;
      loginScreen();
      return;
    }
    if (!admin) {
      signedIn = false;
      blocked(reason);
      return;
    }
    if (!signedIn) {
      signedIn = true;
      shell(user);
    }
  });
}

window.addEventListener("hashchange", () => {
  if (!signedIn) return;
  const id = (location.hash || "#/overview").replace("#/", "");
  if (id !== currentRoute) {
    currentRoute = id;
    const link = document.querySelector(`[data-route="${id}"]`);
    if (link) link.click();
  }
});

boot();
