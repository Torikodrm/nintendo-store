/**
 * POST /api/admin/latam/reconcile — Reconciliación manual de una orden PayU LATAM.
 * Body: { reference, idToken } (idToken debe ser de un usuario con rol admin).
 *
 * Consulta el estado AUTORITATIVO en PayU (Reports API,
 * ORDER_DETAIL_BY_REFERENCE_CODE) y lo aplica a la orden con la misma
 * lógica idempotente del webhook, dentro de una transacción.
 * Jamás aprueba por supuestos locales: sin respuesta de PayU no hay cambios.
 *
 * Docs: https://developers.payulatam.com/latam/es/docs/integrations/api-integration/queries-api.html
 */
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb, getAdminAuth } from "@/lib/firebase-admin";
import {
  getLatamConfig,
  queryLatamOrderByReference,
  decideLatamTransition,
  latamAmountsMatch,
  redactForLog,
} from "@/lib/payu-latam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_ATTEMPTS_LOG = 20;

export async function POST(req) {
  try {
    const { reference, idToken } = await req.json().catch(() => ({}));
    if (!reference || typeof reference !== "string") {
      return Response.json({ error: "Referencia inválida" }, { status: 400 });
    }
    if (!idToken) return Response.json({ error: "No autenticado" }, { status: 401 });

    const auth = getAdminAuth();
    let uid;
    try {
      uid = (await auth.verifyIdToken(idToken)).uid;
    } catch {
      return Response.json({ error: "Sesión inválida" }, { status: 401 });
    }

    const db = getAdminDb();
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists || userSnap.data()?.role !== "admin") {
      return Response.json({ error: "Sin acceso" }, { status: 403 });
    }

    const config = getLatamConfig();
    const docRef = db.collection("payu_orders").doc(reference);
    const snap = await docRef.get();
    if (!snap.exists) {
      return Response.json({ error: "Orden no encontrada" }, { status: 404 });
    }
    const order = snap.data();
    if (order.provider && order.provider !== "latam") {
      return Response.json({ error: "La orden no es de PayU LATAM" }, { status: 400 });
    }

    // Fuente autoritativa: PayU. Sin ella, no se toca nada.
    let q;
    try {
      q = await queryLatamOrderByReference(config, reference);
    } catch (e) {
      console.error("latam reconcile query:", e?.message || e);
      return Response.json({ error: "PayU no respondió a la consulta" }, { status: 502 });
    }
    if (!q.found) {
      return Response.json({ status: "not-found-in-payu", orderStatus: order.status });
    }

    const result = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(docRef);
      const cur = fresh.data();
      // Monto/moneda: solo se aplica paid si coincide con la orden
      if (q.mapped === "paid") {
        const expected = Number(cur.total ?? (cur.totalCents ?? 0) / 100);
        if (!latamAmountsMatch(q.txValue, expected)) {
          return { applied: false, reason: "amount-mismatch", orderStatus: cur.status };
        }
      }
      const d = decideLatamTransition(cur.status, q.mapped);
      const log = [
        ...(cur.attemptsLog || []),
        {
          payuTransactionId: String(q.transactionId || ""),
          referencePol: String(q.referencePol || ""),
          rawState: String(q.txState || q.orderStatus || ""),
          status: q.mapped,
          at: new Date().toISOString(),
          via: "reconcile",
        },
      ].slice(-MAX_ATTEMPTS_LOG);
      tx.update(docRef, {
        status: d.next,
        payuOrderId: q.payuOrderId ?? cur.payuOrderId ?? null,
        payuTransactionId: String(q.transactionId || cur.payuTransactionId || ""),
        attempts: FieldValue.increment(1),
        attemptsLog: log,
        lastWebhook: {
          at: FieldValue.serverTimestamp(),
          payuStatus: String(q.txState || q.orderStatus || ""),
          outcome: `reconcile:${d.reason}`,
        },
        updatedAt: FieldValue.serverTimestamp(),
        ...(d.next === "paid" && !cur.paidAt ? { paidAt: FieldValue.serverTimestamp() } : {}),
      });
      return { applied: d.changed, reason: d.reason, orderStatus: d.next };
    });

    console.info(
      "latam reconcile",
      redactForLog({ reference, orderStatus: result.orderStatus, env: config.env })
    );
    return Response.json({
      status: "ok",
      reference,
      payuState: q.txState || q.orderStatus,
      ...result,
    });
  } catch (e) {
    console.error("latam reconcile error:", e?.code || "", e?.message || e);
    const msg = /PayU LATAM|Firebase Admin|Reconciliación no configurada/.test(e?.message || "")
      ? e.message
      : "No se pudo reconciliar";
    return Response.json({ error: msg }, { status: 500 });
  }
}
