/**
 * PayU LATAM WebCheckout — ¡SOLO SERVIDOR!
 *
 * Módulo independiente del proveedor europeo (`lib/payu.js`): no lo importa,
 * no comparte credenciales ni endpoints. Solo se usa desde `src/app/api/*`
 * (rutas `latam/*`, runtime nodejs).
 *
 * Referencia (docs oficiales vigentes):
 * - Formulario:      https://developers.payulatam.com/latam/es/docs/integrations/webcheckout-integration/payment-form.html
 * - URL Respuesta:   .../docs/integrations/response-url.html
 * - URL Confirmación:.../docs/integrations/confirmation-url.html
 * - API Consultas:   .../docs/integrations/api-integration/queries-api.html
 */
import { createHash, timingSafeEqual } from "node:crypto";

// Endpoints centralizados: el único lugar donde sandbox/producción diverge.
const LATAM_GATEWAYS = {
  sandbox: "https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/",
  production: "https://checkout.payulatam.com/ppp-web-gateway-payu/",
};
const LATAM_REPORTS_API = {
  sandbox: "https://sandbox.api.payulatam.com/reports-api/4.0/service.cgi",
  production: "https://api.payulatam.com/reports-api/4.0/service.cgi",
};

// Merchant público de pruebas de la documentación oficial (solo sandbox).
export const LATAM_SANDBOX_TEST_MERCHANT_ID = "508029";

export const LATAM_ORDER_STATUSES = ["pending", "paid", "rejected", "cancelled", "error"];
export const LATAM_TERMINAL_STATUSES = ["paid", "rejected", "cancelled", "error"];

/**
 * Configuración tipada por entorno. Falla rápido y NUNCA mezcla entornos:
 * - PAYU_LATAM_ENV ausente => sandbox.
 * - Valor distinto de sandbox|production => error.
 * - production sin credenciales completas => error nombrando producción.
 * - Credencial de pruebas (508029) con ENV=production => error.
 */
export function getLatamConfig(env = process.env) {
  const raw = String(env.PAYU_LATAM_ENV || "sandbox").trim().toLowerCase();
  if (raw !== "sandbox" && raw !== "production") {
    throw new Error(
      `PAYU_LATAM_ENV inválido ("${String(env.PAYU_LATAM_ENV || "").slice(0, 32)}"): usa sandbox o production`
    );
  }
  const isProd = raw === "production";
  const merchantId = String(env.PAYU_LATAM_MERCHANT_ID || "").trim();
  const accountId = String(env.PAYU_LATAM_ACCOUNT_ID || "").trim();
  const apiLogin = String(env.PAYU_LATAM_API_LOGIN || "").trim();
  const apiKey = env.PAYU_LATAM_API_KEY || "";
  const currency = String(env.PAYU_LATAM_CURRENCY || "MXN").trim() || "MXN";

  if (!merchantId || !accountId || !apiKey) {
    throw new Error(
      isProd
        ? "PayU LATAM producción sin configurar: define PAYU_LATAM_MERCHANT_ID, PAYU_LATAM_ACCOUNT_ID y PAYU_LATAM_API_KEY de producción"
        : "PayU LATAM sandbox sin configurar: define PAYU_LATAM_MERCHANT_ID, PAYU_LATAM_ACCOUNT_ID y PAYU_LATAM_API_KEY en .env.local"
    );
  }
  if (isProd && merchantId === LATAM_SANDBOX_TEST_MERCHANT_ID) {
    throw new Error(
      "Configuración inválida: merchant de pruebas (508029) con PAYU_LATAM_ENV=production. Usa credenciales reales de producción"
    );
  }
  return {
    env: raw,
    isProd,
    merchantId,
    accountId,
    apiLogin, // solo requerido para reconciliación (Queries API); puede ir vacío
    apiKey,
    currency,
    gatewayUrl: LATAM_GATEWAYS[raw],
    reportsUrl: LATAM_REPORTS_API[raw],
    testFlag: isProd ? "0" : "1",
  };
}

export function md5Latam(str) {
  return createHash("md5").update(str, "utf8").digest("hex");
}

function safeEqual(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (!x || x.length !== y.length) return false;
  return timingSafeEqual(Buffer.from(x, "utf8"), Buffer.from(y, "utf8"));
}

/** "1299.00" — 2 decimales exactos, igual que se envía a PayU y se firma. */
export function formatLatamAmount(totalCents) {
  return (Math.round(Number(totalCents)) / 100).toFixed(2);
}

/**
 * Firma del formulario WebCheckout:
 *   md5(apiKey~merchantId~referenceCode~amount~currency)
 * Vector oficial: 4Vj8eK4rloUd272L48hsrarnUA~508029~TestPayU~20000~COP
 *   => 7ee7cf808ce6a39b17481c54f2c57acc
 */
export function buildLatamRequestSignature({ apiKey, merchantId, referenceCode, amount, currency }) {
  return md5Latam(`${apiKey}~${merchantId}~${referenceCode}~${amount}~${currency}`);
}

/**
 * Regla OFICIAL de `new_value` para firma del webhook (docs Confirmación):
 * - sin decimales o 2º decimal 0 → 1 decimal ("100"/"150.00" => "100.0"/"150.0")
 * - 2º decimal distinto de 0   → 2 decimales ("150.25" => "150.25")
 */
export function formatLatamWebhookValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parts = raw.split(".");
  if (!parts[1]) return `${parts[0]}.0`;
  const dec = parts[1];
  if (dec.length > 1 && dec[1] !== "0") return `${parts[0]}.${dec.slice(0, 2)}`;
  return `${parts[0]}.${dec[0]}`;
}

/**
 * Valida `sign` del webhook (POST snake_case):
 *   md5(apiKey~merchant_id~reference_sale~new_value~currency~state_pol)
 * Usa valores DEL webhook (nunca de la BD) + variantes tolerantes.
 */
export function verifyLatamConfirmation(params, apiKey) {
  const received = String(params.sign || "");
  if (!received) return false;
  const merchantId = String(params.merchant_id || "");
  const referenceSale = String(params.reference_sale || "");
  const currency = String(params.currency || "");
  const statePol = String(params.state_pol || "");
  const rawValue = String(params.value ?? "");
  const candidates = new Set([formatLatamWebhookValue(rawValue), rawValue.trim()]);
  const num = Number(rawValue);
  if (Number.isFinite(num)) candidates.add(num.toFixed(2));
  for (const v of candidates) {
    if (!v) continue;
    if (safeEqual(md5Latam(`${apiKey}~${merchantId}~${referenceSale}~${v}~${currency}~${statePol}`), received)) {
      return true;
    }
  }
  return false;
}

/** Redondeo half-even a 1 decimal (equivale a PHP_ROUND_HALF_EVEN de los docs). */
export function roundHalfEven1(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return NaN;
  const scaled = n * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded;
  if (diff < 0.5) rounded = floor;
  else if (diff > 0.5) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / 10;
}

/**
 * Valida `signature` de la URL de respuesta (GET, retorno del navegador).
 * SOLO informativa: el estado real siempre sale de la BD (webhook).
 *   md5(apiKey~merchantId~referenceCode~new_value~currency~transactionState)
 */
export function verifyLatamResponse(params, apiKey) {
  const received = String(params.signature || "");
  if (!received) return false;
  const r = roundHalfEven1(params.TX_VALUE);
  if (!Number.isFinite(r)) return false;
  const calc = md5Latam(
    `${apiKey}~${params.merchantId || ""}~${params.referenceCode || ""}~${r.toFixed(1)}~${params.currency || ""}~${params.transactionState || ""}`
  );
  return safeEqual(calc, received);
}

/**
 * state_pol oficial: 4 aprobada · 6 rechazada/declinada · 5 expirada.
 * El webhook solo se dispara en estados finales (no hay 7/pending).
 */
export function mapLatamStatePol(statePol) {
  switch (String(statePol)) {
    case "4":
      return "paid";
    case "6":
      return "rejected";
    case "5":
      return "cancelled";
    case "7":
      return "pending";
    default:
      return "error";
  }
}

/**
 * Mapea estados de la API de Consultas (transactions[].transactionResponse.state):
 * APPROVED/DECLINED/PENDING/ERROR/EXPIRED (+ status de orden CAPTURED).
 */
export function mapLatamQueryState(state, orderStatus) {
  const s = String(state || "").toUpperCase();
  if (s === "APPROVED") return "paid";
  if (s === "DECLINED") return "rejected";
  if (s === "EXPIRED") return "cancelled";
  if (s === "PENDING") return "pending";
  if (String(orderStatus || "").toUpperCase() === "CAPTURED") return "paid";
  return "error";
}

/** Comparación de montos con tolerancia de centavo (anti manipulación). */
export function latamAmountsMatch(receivedValue, expectedTotal) {
  const v = Number(receivedValue);
  const e = Number(expectedTotal);
  return Number.isFinite(v) && Number.isFinite(e) && Math.abs(v - e) < 0.011;
}

/** Moneda: ausente se tolera, presente debe coincidir exacto. */
export function latamCurrencyOk(receivedCurrency, expectedCurrency) {
  if (!receivedCurrency) return true;
  return String(receivedCurrency) === String(expectedCurrency);
}

/**
 * Decisor puro de transición (idempotencia testeable sin Firestore):
 * - paid es final: todo lo posterior es noop.
 * - un paid entrante se honra desde cualquier estado no-paid (reintento aprobado).
 * - pending entrante no cambia nada.
 * - estados finales no-paid solo aplican si el actual no es final (el primero gana).
 */
export function decideLatamTransition(current, incoming) {
  if (current === "paid") return { next: "paid", changed: false, reason: "already-paid" };
  if (incoming === "paid") {
    return current === "paid"
      ? { next: "paid", changed: false, reason: "duplicate-noop" }
      : { next: "paid", changed: true, reason: "approve" };
  }
  if (incoming === "pending") return { next: current, changed: false, reason: "still-pending" };
  if (LATAM_TERMINAL_STATUSES.includes(current)) {
    return { next: current, changed: false, reason: "terminal-kept" };
  }
  return { next: incoming, changed: true, reason: "first-terminal" };
}

/** Contrato para orden inexistente: acuse sin efectos (evita reintentos eternos). */
export function handleUnknownLatamOrder() {
  return { http: 200, body: { status: "ignored", reason: "order-not-found" } };
}

/**
 * Construye el documento de orden con ALLOWLIST estricta: aunque el llamante
 * pase campos extra (tarjeta, CVV, secretos), jamás se persisten.
 */
const LATAM_ORDER_FIELDS = [
  "reference", "provider", "region", "userId", "email", "displayName",
  "items", "totalCents", "total", "currency", "status",
  "payuReferencePol", "payuTransactionId", "payuOrderId",
  "responseMessage", "rawState", "attempts", "attemptsLog",
  "createdAt", "updatedAt", "paidAt", "lastWebhook",
];
export function buildLatamOrderDoc(input) {
  const doc = {};
  for (const k of LATAM_ORDER_FIELDS) {
    if (input[k] !== undefined) doc[k] = input[k];
  }
  return doc;
}

/** Log seguro: solo identificadores y estados, jamás secretos ni tarjetas. */
const LOG_SAFE_KEYS = new Set([
  "reference", "reference_sale", "reference_pol", "referenceCode",
  "merchant_id", "merchantId", "state_pol", "transactionState",
  "orderStatus", "status", "incoming", "changed", "reason",
  "payuOrderId", "payuTransactionId", "currency", "value", "TX_VALUE",
  "env", "attempts",
]);
export function redactForLog(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (LOG_SAFE_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Reconciliación: consulta autoritativa a PayU (Reports API) por referenceCode.
 * `fetchFn` inyectable para tests (en producción es fetch global).
 * Requiere apiLogin (PAYU_LATAM_API_LOGIN). Nunca aprueba por supuestos locales:
 * solo mapea la respuesta real de PayU.
 */
export async function queryLatamOrderByReference(config, referenceCode, fetchFn = fetch) {
  if (!config.apiLogin) {
    throw new Error(
      "Reconciliación no configurada: define PAYU_LATAM_API_LOGIN (credencial del panel PayU)"
    );
  }
  const res = await fetchFn(config.reportsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      test: !config.isProd,
      language: "es",
      command: "ORDER_DETAIL_BY_REFERENCE_CODE",
      merchant: { apiLogin: config.apiLogin, apiKey: config.apiKey },
      details: { referenceCode },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== "SUCCESS") {
    throw new Error(
      `PayU Consultas falló (${data.code || `HTTP_${res.status}`})`
    );
  }
  const orders = data?.result?.payload || [];
  const order = Array.isArray(orders) ? orders[0] : orders;
  if (!order) return { found: false };
  const txs = Array.isArray(order.transactions) ? order.transactions : [];
  // La transacción autoritativa: última con estado final conocido, priorizando APPROVED
  let best = null;
  for (const t of txs) {
    const st = String(t?.transactionResponse?.state || "").toUpperCase();
    if (st === "APPROVED") {
      best = t;
      break;
    }
    if (!best && (st === "PENDING" || st === "EXPIRED" || st === "DECLINED" || st === "ERROR")) {
      best = t;
    }
  }
  const txState = best?.transactionResponse?.state || null;
  return {
    found: true,
    payuOrderId: order.id ?? null,
    orderStatus: order.status || null,
    txState,
    txValue: best?.transactionResponse?.additionalValues?.TX_VALUE?.value ?? null,
    txCurrency: order.currency || null,
    transactionId: best?.id ?? null,
    referencePol: best?.trazabilityCode ?? order.referenceCode ?? null,
    mapped: mapLatamQueryState(txState, order.status),
  };
}
