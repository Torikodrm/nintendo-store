/**
 * Mercado Pago Checkout Pro — ¡SOLO SERVIDOR!
 *
 * NUNCA importar desde componentes cliente. Solo desde `src/app/api/*`.
 * Flujo redirect (sin tarjeta en nuestros servidores):
 *   servidor crea preferencia → navegador a init_point/sandbox_init_point
 *   → MP cobra → back_urls a /pago/resultado (display) + webhook (verdad).
 *
 * Referencia: https://www.mercadopago.com.co/developers/es/docs
 * - Checkout Pro: /checkout-pro-preferences
 * - Webhooks x-signature: /your-integrations/notifications/webhooks
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { decideTransition, TERMINAL_STATUSES } from "./payment-states.js";

export const MP_API_BASE = "https://api.mercadopago.com";
export const MP_ORDERS_COLLECTION = "payu_orders"; // mismo modelo de órdenes

export { decideTransition as decideMPTransition, TERMINAL_STATUSES as MP_TERMINAL_STATUSES };

/**
 * Config por entorno. TEST-... = sandbox, APP_USR-... = producción.
 * Falla rápido ante mezcla silenciosa de credenciales.
 */
export function getMPConfig(env = process.env) {
  const raw = String(env.MERCADOPAGO_ENV || "sandbox").trim().toLowerCase();
  if (raw !== "sandbox" && raw !== "production") {
    throw new Error(
      `MERCADOPAGO_ENV inválido ("${String(env.MERCADOPAGO_ENV || "").slice(0, 32)}"): usa sandbox o production`
    );
  }
  const isProd = raw === "production";
  const accessToken = env.MERCADOPAGO_ACCESS_TOKEN || "";
  const webhookSecret = env.MERCADOPAGO_WEBHOOK_SECRET || "";
  const currency = String(env.MERCADOPAGO_CURRENCY || "COP").trim() || "COP";
  if (!accessToken) {
    throw new Error(
      isProd
        ? "Mercado Pago producción sin configurar: define MERCADOPAGO_ACCESS_TOKEN de producción (APP_USR-...)"
        : "Mercado Pago sandbox sin configurar: define MERCADOPAGO_ACCESS_TOKEN de prueba (TEST-...) en .env.local"
    );
  }
  if (isProd && !accessToken.startsWith("APP_USR-")) {
    throw new Error("Configuración inválida: token de prueba (TEST-...) con MERCADOPAGO_ENV=production");
  }
  if (!isProd && accessToken.startsWith("APP_USR-")) {
    throw new Error("Configuración inválida: token de producción (APP_USR-...) con MERCADOPAGO_ENV=sandbox");
  }
  if (isProd && !webhookSecret) {
    throw new Error("En producción define MERCADOPAGO_WEBHOOK_SECRET (panel Developers → Webhooks)");
  }
  return { env: raw, isProd, accessToken, webhookSecret, currency };
}

/** external_reference: máx 64, solo letras/números/guion/guion-bajo. */
export function sanitizeReference(ref) {
  return String(ref || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

/**
 * Totales en centavos enteros desde líneas del servidor.
 * lines: [{ precio (COP), qty }]
 */
export function calcMPCents(lines) {
  return lines.reduce((acc, i) => {
    const priceCents = Math.round(Number(i.precio) * 100) || 0;
    const qty = Math.trunc(Number(i.qty)) || 0;
    return acc + priceCents * qty;
  }, 0);
}

/** Referencia única de orden (= external_reference en MP). */
export function generateMPReference() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `NSW-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

/**
 * Cuerpo de la preferencia. Montos/Unit_price salen de `lines` del servidor.
 * back_urls/notifications apuntan a nuestra app; el servidor elige redirect.
 */
export function buildPreferenceBody({ lines, email, firstName, lastName, reference, baseUrl, currency }) {
  const items = lines.map((l) => ({
    title: String(l.nombre || "Producto").slice(0, 120),
    quantity: Math.trunc(Number(l.qty)) || 0,
    currency_id: currency,
    unit_price: Math.round(Number(l.precio) * 100) / 100,
  }));
  const back = `${baseUrl}/pago/resultado?reference=${encodeURIComponent(reference)}`;
  return {
    items,
    payer: {
      email,
      ...(firstName ? { first_name: firstName } : {}),
      ...(lastName ? { last_name: lastName } : {}),
    },
    back_urls: { success: back, pending: back, failure: back },
    notification_url: `${baseUrl}/api/mercadopago/webhook`,
    auto_return: "approved",
    external_reference: sanitizeReference(reference),
    statement_descriptor: "NINTENDO STORE",
  };
}

/** Crea la preferencia. Devuelve { preferenceId, redirectUrl }. */
export async function createMPPreference(config, body, fetchFn = fetch) {
  const res = await fetchFn(`${MP_API_BASE}/checkout/preferences`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const redirectUrl = config.isProd ? data.init_point : data.sandbox_init_point || data.init_point;
  if (!res.ok || !redirectUrl) {
    const cause = data?.message || data?.error || `HTTP_${res.status}`;
    throw new Error(`Mercado Pago rechazó la preferencia (${cause})`);
  }
  return { preferenceId: data.id || "", redirectUrl };
}

/** Pago autoritativo por ID. Lanza si MP no responde. */
export async function getMPPayment(config, paymentId, fetchFn = fetch) {
  const res = await fetchFn(
    `${MP_API_BASE}/v1/payments/${encodeURIComponent(String(paymentId))}`,
    { headers: { Authorization: `Bearer ${config.accessToken}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || data.id === undefined) {
    throw new Error(`Mercado Pago no devolvió el pago (${data?.message || `HTTP_${res.status}`})`);
  }
  return data;
}

/**
 * Verifica x-signature: HMAC-SHA256 hex de
 *   "id:[data.id];request-id:[x-request-id];ts:[ts];"
 * omitiendo partes ausentes; data.id alfanumérico en minúsculas.
 */
export function verifyMPWebhookSignature({ xSignature, xRequestId, dataId, secret }) {
  const parts = {};
  for (const part of String(xSignature || "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) parts[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const ts = parts.ts || "";
  const v1 = parts.v1 || "";
  if (!ts || !v1 || !secret) return false;
  let manifest = "";
  const id = dataId !== undefined && dataId !== null && String(dataId) !== "" ? String(dataId).toLowerCase() : "";
  if (id) manifest += `id:${id};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${ts};`;
  const expected = createHmac("sha256", secret).update(manifest, "utf8").digest("hex");
  if (expected.length !== v1.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(v1.toLowerCase(), "utf8"));
}

/**
 * Estados de pago MP → normalizados.
 * approved→paid · rejected→rejected · cancelled→cancelled
 * refunded/charged_back→cancelled (sin flujo de reembolso en tienda)
 * pending/in_process/in_mediation→pending · otro→error
 */
export function mapMPStatus(status) {
  switch (String(status || "").toLowerCase()) {
    case "approved":
      return "paid";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "refunded":
    case "charged_back":
      return "cancelled";
    case "pending":
    case "in_process":
    case "in_mediation":
      return "pending";
    default:
      return "error";
  }
}

/** Contrato orden inexistente: acuse sin efectos. */
export function handleUnknownMPOrder() {
  return { http: 200, body: { status: "ignored", reason: "order-not-found" } };
}

/** Allowlist estricta: jamás persiste tarjetas ni secretos. */
const MP_ORDER_FIELDS = [
  "reference", "provider", "region", "userId", "email", "displayName",
  "items", "totalCents", "total", "currency", "status",
  "mpPreferenceId", "mpPaymentId", "payuTransactionId",
  "responseMessage", "rawState", "attempts", "attemptsLog",
  "createdAt", "updatedAt", "paidAt", "lastWebhook",
];
export function buildMPOrderDoc(input) {
  const doc = {};
  for (const k of MP_ORDER_FIELDS) {
    if (input[k] !== undefined) doc[k] = input[k];
  }
  return doc;
}

/** Log seguro: solo identificadores y estados. */
const MP_LOG_SAFE = new Set([
  "reference", "external_reference", "preferenceId", "paymentId",
  "orderStatus", "status", "incoming", "changed", "reason",
  "currency", "env", "attempts", "live_mode",
]);
export function redactMPLog(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (MP_LOG_SAFE.has(k)) out[k] = v;
  }
  return out;
}
