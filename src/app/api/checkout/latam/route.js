/**
 * POST /api/checkout/latam — Orden interna + formulario WebCheckout PayU LATAM.
 * Body: { items: { productId: qty }, idToken }
 *
 * Servidor-autoritativo: precios/stock de Firestore, total en centavos,
 * referencia única, orden `pending` con provider:"latam" ANTES de responder.
 * Devuelve { gatewayUrl, fields } para auto-POST del navegador a PayU.
 * La ApiKey NUNCA sale al navegador (solo viaja la firma MD5).
 */
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb, getAdminAuth } from "@/lib/firebase-admin";
import { calcTotalCents, generateReference } from "@/lib/payu";
import {
  getLatamConfig,
  formatLatamAmount,
  buildLatamRequestSignature,
  buildLatamOrderDoc,
  redactForLog,
} from "@/lib/payu-latam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function baseUrlFrom(req) {
  const override = (process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (override) return override;
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function POST(req) {
  try {
    const { items, idToken } = await req.json().catch(() => ({}));

    if (!idToken) return Response.json({ error: "No autenticado" }, { status: 401 });
    let uid, email, displayName = "";
    try {
      const auth = getAdminAuth();
      const decoded = await auth.verifyIdToken(idToken);
      uid = decoded.uid;
      email = decoded.email || "";
      try {
        displayName = (await auth.getUser(uid)).displayName || "";
      } catch {}
    } catch {
      return Response.json({ error: "Sesión inválida" }, { status: 401 });
    }

    if (!items || typeof items !== "object" || Array.isArray(items)) {
      return Response.json({ error: "Carrito inválido" }, { status: 400 });
    }
    const entries = Object.entries(items)
      .map(([id, qty]) => [String(id).slice(0, 128), Math.trunc(Number(qty)) || 0])
      .filter(([, qty]) => qty > 0 && qty <= 99);
    if (entries.length === 0 || entries.length > 50) {
      return Response.json({ error: "Carrito vacío o inválido" }, { status: 400 });
    }

    const config = getLatamConfig();

    const db = getAdminDb();
    const snaps = await db.getAll(
      ...entries.map(([id]) => db.collection("products").doc(id))
    );
    const byId = {};
    for (const s of snaps) if (s.exists) byId[s.id] = s.data();

    const lines = [];
    for (const [id, qty] of entries) {
      const p = byId[id];
      if (!p || p.activo === false) continue;
      const stock = Math.trunc(Number(p.stock)) || 0;
      if (stock <= 0) continue;
      const precio = Number(p.precio);
      if (!Number.isFinite(precio) || precio < 0) continue;
      lines.push({
        id,
        nombre: String(p.nombre || "Producto").slice(0, 120),
        precio,
        qty: Math.min(qty, stock),
      });
    }
    if (lines.length === 0) {
      return Response.json(
        { error: "Ningún producto disponible (sin stock o inactivo)" },
        { status: 400 }
      );
    }

    const totalCents = calcTotalCents(lines);
    if (totalCents <= 0) {
      return Response.json({ error: "Total inválido" }, { status: 400 });
    }
    const amount = formatLatamAmount(totalCents);
    const reference = generateReference();

    await db
      .collection("payu_orders")
      .doc(reference)
      .set(
        buildLatamOrderDoc({
          reference,
          provider: "latam",
          region: "LATAM",
          userId: uid,
          email,
          displayName,
          items: lines,
          totalCents,
          total: totalCents / 100,
          currency: config.currency,
          status: "pending",
          payuReferencePol: "",
          payuTransactionId: "",
          payuOrderId: null,
          responseMessage: "",
          rawState: "",
          attempts: 0,
          attemptsLog: [],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          paidAt: null,
          lastWebhook: null,
        })
      );

    const signature = buildLatamRequestSignature({
      apiKey: config.apiKey,
      merchantId: config.merchantId,
      referenceCode: reference,
      amount,
      currency: config.currency,
    });
    const base = baseUrlFrom(req);
    const fields = {
      merchantId: config.merchantId,
      accountId: config.accountId,
      description: `Nintendo Store ${reference}`.slice(0, 255),
      referenceCode: reference,
      amount,
      tax: "0",
      taxReturnBase: "0",
      currency: config.currency,
      signature,
      test: config.testFlag,
      lng: "es",
      buyerEmail: email,
      payerEmail: email,
      ...(displayName
        ? { buyerFullName: displayName.slice(0, 150), payerFullName: displayName.slice(0, 50) }
        : {}),
      responseUrl: `${base}/pago/resultado`,
      confirmationUrl: `${base}/api/payu/latam/confirmation`,
    };

    console.info("latam checkout", redactForLog({ reference, env: config.env, currency: config.currency, value: amount }));
    return Response.json({
      gatewayUrl: config.gatewayUrl,
      fields,
      reference,
      total: totalCents / 100,
      currency: config.currency,
      env: config.env,
    });
  } catch (e) {
    console.error("latam checkout error:", e?.code || "", e?.message || e);
    const msg = /PayU LATAM|Firebase Admin/.test(e?.message || "")
      ? e.message
      : "No se pudo iniciar el pago";
    return Response.json({ error: msg }, { status: 500 });
  }
}
