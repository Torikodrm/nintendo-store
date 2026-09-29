/**
 * POST /api/payu/latam/confirmation — Webhook PayU LATAM (Confirmation URL).
 *
 * ÚNICA fuente de verdad del pago. Sin sesión de usuario, sin HTML.
 * Docs: https://developers.payulatam.com/latam/es/docs/integrations/confirmation-url.html
 *
 * - Content-Type: application/x-www-form-urlencoded (JSON como fallback).
 * - Firma: md5(apiKey~merchant_id~reference_sale~new_value~currency~state_pol).
 * - Transición dentro de transacción Firestore (anti carreras entre duplicados).
 * - 200 ante lo bien formado (incluso orden inexistente), 400 incompleto,
 *   403 firma/comercio inválido. Log seguro (sin secretos ni tarjetas).
 */
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  getLatamConfig,
  verifyLatamConfirmation,
  mapLatamStatePol,
  decideLatamTransition,
  handleUnknownLatamOrder,
  latamAmountsMatch,
  latamCurrencyOk,
  redactForLog,
  LATAM_TERMINAL_STATUSES,
} from "@/lib/payu-latam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_ATTEMPTS_LOG = 20;

async function readPayload(req) {
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    return normalize(await req.json().catch(() => ({})));
  }
  const text = await req.text().catch(() => "");
  const obj = {};
  if (text) {
    for (const [k, v] of new URLSearchParams(text).entries()) obj[k] = v;
  }
  if (Object.keys(obj).length === 0) {
    try {
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) obj[k] = String(v);
    } catch {}
  }
  return normalize(obj);
}

function normalize(o) {
  const s = (v) => (v === undefined || v === null ? "" : String(v));
  return {
    merchant_id: s(o.merchant_id),
    reference_sale: s(o.reference_sale),
    reference_pol: s(o.reference_pol),
    value: s(o.value),
    currency: s(o.currency),
    state_pol: s(o.state_pol),
    sign: s(o.sign),
    transaction_id: s(o.transaction_id),
    response_message_pol: s(o.response_message_pol),
    response_code_pol: s(o.response_code_pol),
    payment_method_name: s(o.payment_method_name),
    email_buyer: s(o.email_buyer),
    test: s(o.test),
  };
}

export async function POST(req) {
  let config;
  try {
    config = getLatamConfig();
  } catch {
    console.error("latam confirmation: sin configuración");
    return Response.json({ error: "Webhook no configurado" }, { status: 500 });
  }

  const p = await readPayload(req);
  if (!p.reference_sale || !p.sign || !p.state_pol || !p.merchant_id) {
    return Response.json({ error: "Payload incompleto" }, { status: 400 });
  }
  if (!verifyLatamConfirmation(p, config.apiKey)) {
    console.warn("latam confirmation: firma inválida", redactForLog({ reference_sale: p.reference_sale }));
    return Response.json({ error: "Firma inválida" }, { status: 403 });
  }
  if (p.merchant_id !== config.merchantId) {
    console.warn("latam confirmation: merchant_id distinto", redactForLog({ reference_sale: p.reference_sale }));
    return Response.json({ error: "Comercio inválido" }, { status: 403 });
  }

  let db;
  try {
    db = getAdminDb();
  } catch {
    console.error("latam confirmation: Firebase Admin no configurado");
    return Response.json({ error: "Webhook no configurado" }, { status: 500 });
  }

  const incoming = mapLatamStatePol(p.state_pol);
  const docRef = db.collection("payu_orders").doc(p.reference_sale);

  try {
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return { unknown: true };
      const order = snap.data();

      // Aislamiento entre proveedores: este webhook solo toca órdenes latam.
      // (Órdenes europeas usan otro endpoint y otro formato de firma.)
      if (order.provider && order.provider !== "latam") {
        return { unknown: true, reason: "provider-mismatch" };
      }

      const attempt = {
        payuTransactionId: p.transaction_id || "",
        referencePol: p.reference_pol || "",
        rawState: p.state_pol || "",
        status: incoming,
        at: new Date().toISOString(),
      };

      // Monto/moneda exactos contra la orden (anti manipulación)
      const expected = Number(order.total ?? (order.totalCents ?? 0) / 100);
      const amountOk = latamAmountsMatch(p.value, expected);
      const currencyOk = latamCurrencyOk(p.currency, order.currency);
      if (!amountOk || !currencyOk) {
        const log = [...(order.attemptsLog || []), { ...attempt, status: "error" }].slice(-MAX_ATTEMPTS_LOG);
        const update = {
          attempts: FieldValue.increment(1),
          attemptsLog: log,
          responseMessage: "Monto o moneda no coincide con la orden",
          lastWebhook: { at: FieldValue.serverTimestamp(), payuStatus: p.state_pol, outcome: "amount-or-currency-mismatch" },
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (!LATAM_TERMINAL_STATUSES.includes(order.status)) update.status = "error";
        tx.update(docRef, update);
        return { orderStatus: update.status || order.status, amountMismatch: true };
      }

      const d = decideLatamTransition(order.status, incoming);
      const log = [...(order.attemptsLog || []), attempt].slice(-MAX_ATTEMPTS_LOG);
      tx.update(docRef, {
        status: d.next,
        payuTransactionId: p.transaction_id || order.payuTransactionId || "",
        payuReferencePol: p.reference_pol || order.payuReferencePol || "",
        payuOrderId: order.payuOrderId ?? null,
        rawState: p.state_pol || "",
        responseMessage: p.response_message_pol || order.responseMessage || "",
        attempts: FieldValue.increment(1),
        attemptsLog: log,
        lastWebhook: {
          at: FieldValue.serverTimestamp(),
          payuStatus: p.state_pol,
          outcome: d.changed ? `transition:${order.status}->${d.next}` : d.reason,
        },
        updatedAt: FieldValue.serverTimestamp(),
        ...(d.next === "paid" && !order.paidAt ? { paidAt: FieldValue.serverTimestamp() } : {}),
      });
      return { orderStatus: d.next, changed: d.changed, reason: d.reason };
    });

    if (outcome.unknown) {
      if (outcome.reason !== "provider-mismatch") {
        console.warn("latam confirmation: orden inexistente", redactForLog({ reference_sale: p.reference_sale }));
      }
      const r = handleUnknownLatamOrder();
      return Response.json(r.body, { status: r.http });
    }
    console.info(
      "latam confirmation",
      redactForLog({
        reference_sale: p.reference_sale,
        state_pol: p.state_pol,
        orderStatus: outcome.orderStatus,
        changed: outcome.changed,
        reason: outcome.reason,
        env: config.env,
      })
    );
    return Response.json({ status: "ok", ...outcome });
  } catch (e) {
    console.error("latam confirmation error:", e?.code || "", e?.message || e);
    return Response.json({ error: "Error interno" }, { status: 500 });
  }
}

export async function GET() {
  return Response.json(
    { error: "Este endpoint solo acepta POST de PayU" },
    { status: 405 }
  );
}
