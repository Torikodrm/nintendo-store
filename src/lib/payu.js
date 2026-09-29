/**
 * Utilidades PayU Europa (GPO) — ¡SOLO SERVIDOR!
 *
 * Este módulo lee secretos (client_secret, second key) y NUNCA debe
 * importarse desde componentes cliente. Solo desde `src/app/api/*`.
 *
 * Referencia: https://developers.payu.com/europe/docs/
 * - OAuth + crear orden: /europe/docs/payment-flows/auth-and-order/
 * - Notificaciones:      /europe/docs/payment-flows/lifecycle/
 * - Sandbox y tarjetas:  /europe/docs/testing/sandbox/
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Sandbox fijo por diseño: este proyecto NO soporta producción.
// Así es estructuralmente imposible un cobro real.
export const PAYU_BASE_URL = "https://secure.snd.payu.com";
export const PAYU_OAUTH_PATH = "/pl/standard/user/oauth/authorize";
export const PAYU_ORDERS_PATH = "/api/v2_1/orders";

export const PAYU_ORDERS_COLLECTION = "payu_orders";

export const ORDER_STATUSES = ["pending", "paid", "rejected", "cancelled", "error"];
export const TERMINAL_STATUSES = ["paid", "rejected", "cancelled", "error"];

export function getPayUConfig() {
  const posId = (process.env.PAYU_POS_ID || "").trim();
  const md5SecondKey = (process.env.PAYU_MD5_SECOND_KEY || "").trim();
  const oauthClientId = (process.env.PAYU_OAUTH_CLIENT_ID || "").trim();
  const oauthClientSecret = (process.env.PAYU_OAUTH_CLIENT_SECRET || "").trim();
  const currency = (process.env.PAYU_CURRENCY || "PLN").trim() || "PLN";
  const mxnToPlnRate = Number(process.env.PAYU_MXN_TO_PLN_RATE) || 0.21;
  if (!posId || !md5SecondKey || !oauthClientId || !oauthClientSecret) {
    throw new Error(
      "PayU no configurado. Define PAYU_POS_ID, PAYU_MD5_SECOND_KEY, PAYU_OAUTH_CLIENT_ID y PAYU_OAUTH_CLIENT_SECRET en .env.local"
    );
  }
  return { posId, md5SecondKey, oauthClientId, oauthClientSecret, currency, mxnToPlnRate };
}

export function md5(str) {
  return createHash("md5").update(str, "utf8").digest("hex");
}

/** Comparación en tiempo constante (insensible a mayúsculas). */
export function signaturesEqual(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"));
}

/**
 * Total del carrito en centavos MXN (entero, sin errores float).
 * lines: [{ precio (MXN), qty }]
 */
export function calcTotalCents(lines) {
  return lines.reduce((acc, i) => {
    const priceCents = Math.round(Number(i.precio) * 100) || 0;
    const qty = Math.trunc(Number(i.qty)) || 0;
    return acc + priceCents * qty;
  }, 0);
}

/**
 * Convierte centavos MXN a unidades mínimas de la moneda del POS (grosze).
 * Tasa de PRUEBA configurable (PAYU_MXN_TO_PLN_RATE). Mínimo 1.
 */
export function mxnCentsToMinor(mxnCents, rate) {
  const minor = Math.round((Number(mxnCents) / 100) * Number(rate) * 100);
  return Math.max(1, minor || 0);
}

/** Referencia única de orden (= extOrderId en PayU, único por POS). */
export function generateReference() {
  const rand = randomBytes(4).toString("hex").toUpperCase();
  return `NSW-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

// --- OAuth (token cacheado en memoria hasta ~60 s antes de expirar) ---
let tokenCache = { token: "", expiresAt: 0 };

export function clearPayUTokenCache() {
  tokenCache = { token: "", expiresAt: 0 };
}

export async function getPayUAccessToken(config) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 10000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
  });
  const res = await fetch(`${PAYU_BASE_URL}${PAYU_OAUTH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `PayU OAuth falló (HTTP ${res.status}). Revisa POS/client_id/client_secret`
    );
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 43200) * 1000 - 60000,
  };
  return tokenCache.token;
}

/**
 * Crea la orden en PayU. Devuelve { redirectUri, payuOrderId }.
 * No sigue redirects automáticamente: lee el 302 (Location) o el JSON.
 */
export async function createPayUOrder(config, token, payload) {
  const res = await fetch(`${PAYU_BASE_URL}${PAYU_ORDERS_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    redirect: "manual",
    body: JSON.stringify(payload),
  });

  if (res.status === 302) {
    const location = res.headers.get("location") || "";
    const orderId = new URL(location).searchParams.get("orderId") || "";
    if (!location) throw new Error("PayU no devolvió redirectUri (302 sin Location)");
    return { redirectUri: location, payuOrderId: orderId };
  }

  const data = await res.json().catch(() => ({}));
  if (res.ok && data.redirectUri) {
    return {
      redirectUri: data.redirectUri,
      payuOrderId: data.orderId || data.extOrderId || "",
    };
  }
  const code =
    data?.status?.statusCode ||
    data?.status?.codeLiteral ||
    `HTTP_${res.status}`;
  throw new Error(`PayU rechazó la orden (${code})`);
}

/**
 * Parsea la cabecera OpenPayU-Signature:
 *   sender=<pos>;signature=<hash>;algorithm=MD5
 */
export function parseSignatureHeader(value) {
  const out = {};
  for (const part of String(value || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Verifica la notificación: md5(cuerpoCrudo + secondKey) vs signature.
 * IMPORTANTE: hashear los bytes crudos tal como llegaron, sin re-serializar.
 */
export function verifyNotificationSignature(rawBody, headerValue, secondKey) {
  const h = parseSignatureHeader(headerValue);
  if (!h.signature) return false;
  if ((h.algorithm || "MD5").toUpperCase() !== "MD5") return false;
  const expected = md5(`${rawBody}${secondKey}`);
  return signaturesEqual(expected, h.signature);
}

/**
 * Mapea status de PayU Europa a estados internos.
 * NEW, PENDING, WAITING_FOR_CONFIRMATION → pending
 * COMPLETED → paid · CANCELED → cancelled · REJECTED → rejected
 */
export function mapPayUStatus(status) {
  switch (String(status || "").toUpperCase()) {
    case "COMPLETED":
      return "paid";
    case "CANCELED":
      return "cancelled";
    case "REJECTED":
      return "rejected";
    case "NEW":
    case "PENDING":
    case "WAITING_FOR_CONFIRMATION":
      return "pending";
    default:
      return "error";
  }
}

/** IP del comprador para customerIp (primer valor válido o fallback). */
export function extractClientIp(headers) {
  const fwd = (headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const ip = fwd || (headers.get("x-real-ip") || "").trim() || "127.0.0.1";
  if (/^[0-9a-fA-F:.]+$/.test(ip) && ip.length <= 45) return ip;
  return "127.0.0.1";
}
