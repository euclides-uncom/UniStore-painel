/**
 * Configuração pública do painel UniStore.
 * NUNCA colocar aqui chaves privadas, service accounts ou chaves do Appwrite.
 * Estes valores são públicos por desenho (Firebase Web). A segurança vem das
 * Regras do Firestore e da custom claim `admin: true`.
 */
const DEFAULTS = {
  apiKey: "COLOQUE_A_CHAVE_WEB",
  authDomain: "unistore-6029a.firebaseapp.com",
  projectId: "unistore-6029a",
  appId: "COLOQUE_O_APP_ID_WEB",
};

/**
 * A configuração pode ser guardada neste navegador pelo ecrã inicial do painel
 * (chave pública do Firebase Web). Evita editar ficheiros no telemóvel.
 * Nada disto é secreto; a autorização depende da claim admin e das regras.
 */
const STORAGE_KEY = "unistore.panel.config";
export const storedConfig = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
})();

export const FIREBASE_CONFIG = { ...DEFAULTS, ...(storedConfig || {}) };

export function saveConfig(values) {
  const clean = {
    apiKey: String(values.apiKey || "").trim(),
    authDomain: String(values.authDomain || DEFAULTS.authDomain).trim(),
    projectId: String(values.projectId || DEFAULTS.projectId).trim(),
    appId: String(values.appId || "").trim(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Domínio público da Function privada (sem barra final). */
export const API_BASE = "https://perfumesmoz.fra.appwrite.run";

/** Versão de consentimento actual da plataforma. */
export const CONSENT_VERSION = "marketplace-preview-2026-11-v4";

/** Limites alinhados com o servidor. */
export const REVIEW_REASON_MIN = 5;
export const REVIEW_REASON_MAX = 300;

export function configReady() {
  return (
    FIREBASE_CONFIG.apiKey &&
    !FIREBASE_CONFIG.apiKey.startsWith("COLOQUE") &&
    FIREBASE_CONFIG.appId &&
    !FIREBASE_CONFIG.appId.startsWith("COLOQUE")
  );
}
