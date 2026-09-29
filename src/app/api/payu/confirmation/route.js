/**
 * POST /api/payu/confirmation — Webhook (notificación) de PayU Europa.
 *
 * Es la ÚNICA fuente de verdad del estado del pago. La página de resultado
 * solo lee la BD, nunca confía en el retorno del navegador.
 *
 * Docs: https://developers.payu.com/europe/docs/payment-flows/lifecycle/
 * - JSON por POST + cabecera `OpenPayU-Signature: sender=…;signature=…;algorithm=MD5`
 * - Firma: md5(cuerpoCrudo + secondKey) — hashear los bytes tal como llegan.
 * - Responder 200 ante notificaciones bien formadas (incluso orden
 *   inexistente) para no provocar reintentos eternos; 403 firma inválida,
 *   400 payload malformado. Sin HTML.
 * - Idempotente: "paid" (COMPLETED) es final; repetir no duplica efectos.
 */
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  PAYU_ORDERS_COLLECTION,
  TERMINAL_STATUSES,
  mapPayUStatus,
  verifyNotificationSignature,
  getPayUConfig,
} from "@/lib/payu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  let config;
  try {
    config = getPayUConfig();
  } catch {
    console.error("payu confirmation: sin configuración");
    return Response.json({ error: "Webhook no configurado" }, { status: 500 });
  }

  // 1. Cuerpo CRUDO primero (la firma se calcula sobre estos bytes exactos)
  const rawBody = await req.text().catch(() => "");
  if (!rawBody) {
    return Response.json({ error: "Cuerpo vacío" }, { status: 400 });
  }

  // 2. Firma de la cabecera
  const sigHeader =
    req.headers.get("openpayu-signature") ||
    req.headers.get("x-openpayu-signature") ||
    "";
  if (!verifyNotificationSignature(rawBody, sigHeader, config.md5SecondKey)) {
    console.warn("payu confirmation: firma inválida");
    return Response.json({ error: "Firma inválida" }, { status: 403 });
  }

  // 3. Parseo + campos mínimos
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  const o = body?.order || {};
  const extOrderId = String(o.extOrderId || "");
  const status = String(o.status || "");
  if (!extOrderId || !status) {
    return Response.json({ error: "Payload incompleto" }, { status: 400 });
  }

  // 4. POS correcto (anti spoofing entre comercios)
  if (String(o.merchantPosId || "") !== config.posId) {
    console.warn(`payu confirmation: merchantPosId distinto ref=${extOrderId}`);
    return Response.json({ error: "Comercio inválido" }, { status: 403 });
  }

  let db;
  try {
    db = getAdminDb();
  } catch {
    console.error("payu confirmation: Firebase Admin no configurado");
    return Response.json({ error: "Webhook no configurado" }, { status: 500 });
  }
  const ref = db.collection(PAYU_ORDERS_COLLECTION).doc(extOrderId);
  const snap = await ref.get();

  // 5. Orden inexistente: acuse sin efectos (evita reintentos eternos)
  if (!snap.exists) {
    console.warn(`payu confirmation: orden inexistente ref=${extOrderId}`);
    return Response.json({ status: "ignored", reason: "order-not-found" });
  }
  const order = snap.data();
  const incoming = mapPayUStatus(status);

  const logEntry = {
    at: FieldValue.serverTimestamp(),
    payuStatus: status,
    payuOrderId: String(o.orderId || ""),
    outcome: "",
  };

  // 6a. "paid" es final: posteriores se ignoran (la doc lo indica explícitamente)
  if (order.status === "paid") {
    logEntry.outcome = "ignored-already-paid";
    await ref.update({
      attempts: FieldValue.increment(1),
      lastWebhook: logEntry,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
    return Response.json({ status: "ok", orderStatus: "paid", deduped: true });
  }

  // 6b. Monto y moneda exactos (unidades mínimas, comparación exacta anti manipulación)
  const currencyOk = String(o.currencyCode || "") === order.chargeCurrency;
  const amountOk = String(o.totalAmount ?? "") === String(order.chargeMinor ?? "");
  if (!currencyOk || !amountOk) {
    logEntry.outcome = "amount-or-currency-mismatch";
    const update = {
      attempts: FieldValue.increment(1),
      responseMessage: "Monto o moneda no coincide con la orden",
      lastWebhook: logEntry,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!TERMINAL_STATUSES.includes(order.status)) update.status = "error";
    await ref.update(update);
    return Response.json({ status: "ok", orderStatus: update.status || order.status });
  }

  // 6c. Transición idempotente
  let next = order.status;
  if (incoming === "paid") {
    next = "paid"; // un reintento aprobado sí se honra
  } else if (incoming === "pending") {
    next = "pending"; // sin cambio efectivo
  } else if (!TERMINAL_STATUSES.includes(order.status)) {
    next = incoming; // primer desenlace final gana
  }
  const changed = next !== order.status;
  logEntry.outcome = changed ? `transition:${order.status}->${next}` : "duplicate-noop";

  await ref.update({
    status: next,
    payuOrderId: String(o.orderId || order.payuOrderId || ""),
    payuTransactionId: String(o.orderId || order.payuTransactionId || ""),
    responseMessage: order.responseMessage || "",
    attempts: FieldValue.increment(1),
    lastWebhook: logEntry,
    updatedAt: FieldValue.serverTimestamp(),
    ...(next === "paid" && !order.paidAt ? { paidAt: FieldValue.serverTimestamp() } : {}),
  });

  return Response.json({ status: "ok", orderStatus: next, changed });
}

export async function GET() {
  return Response.json(
    { error: "Este endpoint solo acepta POST de PayU" },
    { status: 405 }
  );
}
