import { API_BASE, REVIEW_REASON_MAX, REVIEW_REASON_MIN } from "../config.js";
import { idToken } from "./firebase.js";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function parse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) || `HTTP ${response.status}` };
  }
}

async function call(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${await idToken()}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "Não foi possível contactar o serviço privado. Verifique a internet e o domínio configurado.",
      0
    );
  }
  if (response.status === 403) {
    const data = await parse(response);
    if (/origem/i.test(data.message || "")) {
      throw new ApiError(
        `Origem bloqueada pelo servidor (${location.origin}). Adicione esta origem à variável PANEL_ORIGIN das Functions.`,
        403
      );
    }
    throw new ApiError(data.message || "Sem autorização (403).", 403);
  }
  if (!response.ok) {
    const data = await parse(response);
    throw new ApiError(data.message || `Falha no serviço (HTTP ${response.status}).`, response.status);
  }
  return response;
}

/** Verificação de alcance do serviço (sem token). 401 é a resposta correcta. */
export async function checkService() {
  try {
    const response = await fetch(`${API_BASE}/`, { cache: "no-store" });
    const data = await parse(response);
    return {
      ok: response.status === 401,
      status: response.status,
      detail: response.status === 401 ? "Serviço responde e recusa pedidos sem sessão." : data.message || "Resposta inesperada.",
    };
  } catch {
    return { ok: false, status: 0, detail: "Domínio inacessível a partir deste navegador." };
  }
}

/** Documento/selfie: devolve URL temporária de objecto. Nunca é guardado em disco nem em cache. */
export async function fetchMedia(uid, type) {
  if (!["document", "selfie"].includes(type)) throw new ApiError("Tipo inválido.", 400);
  const response = await call(`/v1/sellers/${encodeURIComponent(uid)}/media/${type}`);
  const blob = await response.blob();
  if (!blob.size) throw new ApiError("Imagem vazia ou já eliminada.", 410);
  return URL.createObjectURL(blob);
}

export async function reviewVerification(uid, { decision, reason, verificationId }) {
  const cleanReason = String(reason || "").trim();
  if (!["approved", "rejected"].includes(decision)) throw new ApiError("Decisão inválida.", 400);
  if (cleanReason.length < REVIEW_REASON_MIN || cleanReason.length > REVIEW_REASON_MAX)
    throw new ApiError(`O motivo deve ter entre ${REVIEW_REASON_MIN} e ${REVIEW_REASON_MAX} caracteres.`, 400);
  const response = await call(`/v1/sellers/${encodeURIComponent(uid)}/review`, {
    method: "POST",
    body: { decision, reason: cleanReason, verificationId, reviewConfirmed: true },
  });
  return parse(response);
}

/** Notificação imediata no telemóvel (FCM). O comunicado no Firestore é independente disto. */
export async function sendPush({ title, body, audience = "all" }) {
  const response = await call("/v1/notify", { method: "POST", body: { title, body, audience } });
  return parse(response);
}

export { ApiError };
