/**
 * Webhook Mercado Pago — notificaciones de pagos (topic `payment`).
 * Acepta POST JSON (webhooks) y GET estilo IPN (?topic=payment&id=...).
 *
 * ÚNICA fuente de verdad: el pago se consulta a la API de MP con nuestro
 * access token y solo se aplica si su external_reference coincide con una
 * orden nuestra, con monto y moneda exactos. La página de resultado solo
 * lee la BD. Sin sesión de usuario, sin HTML.
 *
 * Docs: https://www.mercadopago.com.co/developers/es/docs/your-integrations/notifications/webhooks
 */
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase-admin";
import {
  getMPConfig,
  getMPPayment,
  verifyMPWebhookSignature,
  mapMPStatus,
  handleUnknownMPOrder,
  redactMPLog,
} from "@/lib/mercadopago";
import { decideTransition, TERMINAL_STATUSES, amountsClose } from "@/lib/payment-states";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_ATTEMPTS_LOG = 20;

async function processNotification(req, url) {
  let config;
  try {
    config = getMPConfig();
  } catch {
    console.error("mp webhook: sin configuración");
    return Response.json({ error: "Webhook no configurado" }, { status: 500 });
  }

  // 1. ID del pago: query (?data.id= / ?id=) o cuerpo JSON
  let body = null;
  if (req.method === "POST") {
    body = await req.json().catch(() => null);
  }
  const dataId =
    url.searchParams.get("data.id") ||
    url.searchParams.get("id") ||
    body?.data?.id ||
    "";
  if (!dataId) {
    return Response.json({ error: "Sin data.id" }, { status: 400 });
  }

  // 2. Firma x-signature cuando viene (obligatoria si hay secreto configurado)
  const xSig = req.headers.get("x-signature") || "";
  const xReqId = req.headers.get("x-request-id") || "";
  if (xSig) {
    if (!config.webhookSecret) {
      console.error("mp webhook: llegó firma sin secreto configurado");
      return Response.json({ error: "Webhook no configurado" }, { status: 500 });
    }
    const ok = verifyMPWebhookSignature({
      xSignature: xSig,
      xRequestId: xReqId,
      dataId,
      secret: config.webhookSecret,
    });
    if (!ok) {
      console.warn("mp webhook: firma inválida", redactMPLog({ paymentId: String(dataId) }));
      return Response.json({ error: "Firma inválida" }, { status: 403 });
    }
  }

  // 3. Pago autoritativo desde la API de MP
  let payment;
  try {
    payment = await getMPPayment(config, dataId);
  } catch (e) {
    console.error("mp webhook: MP no devolvió el pago:", e?.message || e);
    return Response.json({ error: "No se pudo verificar el pago" }, { status: 502 });
  }

  // 4. Coherencia de entorno (test vs producción)
  if (payment.live_mode !== undefined && payment.live_mode !== config.isProd) {
    console.warn("mp webhook: live_mode no coincide con el entorno", redactMPLog({ paymentId: String(payment.id), live_mode: payment.live_mode, env: config.env }));
    return Response.json({ error: "Entorno no coincide" }, { status: 403 });
  }

  const externalRef = String(payment.external_reference || "");
  if (!externalRef) {
    return Response.json(handleUnknownMPOrder().body, { status: 200 });
  }

  let db;
  try {
    db = getAdminDb();
  } catch {
    console.error("mp webhook: Firebase Admin no configurado");
    return Response.json({ error: "Webhook no configurado" }, { status: 500 });
  }

  const incoming = mapMPStatus(payment.status);
  const docRef = db.collection("payu_orders").doc(externalRef);

  try {
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return { unknown: true };
      const order = snap.data();
      if (order.provider && order.provider !== "mercadopago") {
        return { unknown: true, reason: "provider-mismatch" };
      }

      const attempt = {
        transactionId: String(payment.id ?? ""),
        rawState: String(payment.status || ""),
        status: incoming,
        at: new Date().toISOString(),
      };

      // Monto/moneda exactos (anti manipulación)
      const amountOk = amountsClose(payment.transaction_amount, Number(order.total ?? 0));
      const currencyOk =
        !payment.currency_id || String(payment.currency_id) === String(order.currency);
      if (!amountOk || !currencyOk) {
        const log = [...(order.attemptsLog || []), { ...attempt, status: "error" }].slice(-MAX_ATTEMPTS_LOG);
        const update = {
          attempts: FieldValue.increment(1),
          attemptsLog: log,
          responseMessage: "Monto o moneda no coincide con la orden",
          lastWebhook: { at: FieldValue.serverTimestamp(), payuStatus: String(payment.status || ""), outcome: "amount-or-currency-mismatch" },
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (!TERMINAL_STATUSES.includes(order.status)) update.status = "error";
        tx.update(docRef, update);
        return { orderStatus: update.status || order.status, amountMismatch: true };
      }

      const d = decideTransition(order.status, incoming);
      const log = [...(order.attemptsLog || []), attempt].slice(-MAX_ATTEMPTS_LOG);
      tx.update(docRef, {
        status: d.next,
        mpPaymentId: String(payment.id ?? order.mpPaymentId ?? ""),
        payuTransactionId: String(payment.id ?? order.payuTransactionId ?? ""),
        rawState: String(payment.status || ""),
        responseMessage: String(payment.status_detail || order.responseMessage || "").slice(0, 255),
        attempts: FieldValue.increment(1),
        attemptsLog: log,
        lastWebhook: {
          at: FieldValue.serverTimestamp(),
          payuStatus: String(payment.status || ""),
          outcome: d.changed ? `transition:${order.status}->${d.next}` : d.reason,
        },
        updatedAt: FieldValue.serverTimestamp(),
        ...(d.next === "paid" && !order.paidAt ? { paidAt: FieldValue.serverTimestamp() } : {}),
      });
      return { orderStatus: d.next, changed: d.changed, reason: d.reason };
    });

    if (outcome.unknown) {
      if (outcome.reason !== "provider-mismatch") {
        console.warn("mp webhook: orden inexistente", redactMPLog({ reference: externalRef }));
      }
      const r = handleUnknownMPOrder();
      return Response.json(r.body, { status: r.http });
    }
    console.info(
      "mp webhook",
      redactMPLog({ reference: externalRef, paymentId: String(payment.id ?? ""), orderStatus: outcome.orderStatus, changed: outcome.changed, reason: outcome.reason, env: config.env })
    );
    return Response.json({ status: "ok", ...outcome });
  } catch (e) {
    console.error("mp webhook error:", e?.code || "", e?.message || e);
    return Response.json({ error: "Error interno" }, { status: 500 });
  }
}

export async function POST(req) {
  return processNotification(req, new URL(req.url));
}

export async function GET(req) {
  return processNotification(req, new URL(req.url));
}
