/**
 * POST /api/checkout/mercadopago — Orden interna + preferencia Checkout Pro.
 * Body: { items: { productId: qty }, idToken }
 *
 * Servidor-autoritativo: precios/stock de Firestore, total en centavos,
 * referencia única, orden `pending` con provider:"mercadopago" ANTES de
 * responder. Devuelve { redirectUrl } (init_point o sandbox_init_point).
 * El access token NUNCA sale al navegador.
 *
 * Docs: https://www.mercadopago.com.co/developers/es/docs/checkout-pro-preferences
 */
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb, getAdminAuth } from "@/lib/firebase-admin";
import {
  getMPConfig,
  buildPreferenceBody,
  buildMPOrderDoc,
  createMPPreference,
  generateMPReference,
  calcMPCents,
  redactMPLog,
} from "@/lib/mercadopago";

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

function splitName(displayName) {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
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

    const config = getMPConfig();

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

    const totalCents = calcMPCents(lines);
    if (totalCents <= 0) {
      return Response.json({ error: "Total inválido" }, { status: 400 });
    }
    const reference = generateMPReference();

    await db
      .collection("payu_orders")
      .doc(reference)
      .set(
        buildMPOrderDoc({
          reference,
          provider: "mercadopago",
          region: "CO",
          userId: uid,
          email,
          displayName,
          items: lines,
          totalCents,
          total: totalCents / 100,
          currency: config.currency,
          status: "pending",
          mpPreferenceId: "",
          mpPaymentId: "",
          payuTransactionId: "",
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

    const base = baseUrlFrom(req);
    const { firstName, lastName } = splitName(displayName);
    const { preferenceId, redirectUrl } = await createMPPreference(
      config,
      buildPreferenceBody({
        lines,
        email,
        firstName,
        lastName,
        reference,
        baseUrl: base,
        currency: config.currency,
      })
    );

    await db.collection("payu_orders").doc(reference).update({
      mpPreferenceId: preferenceId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.info("mp checkout", redactMPLog({ reference, env: config.env, currency: config.currency, preferenceId }));
    return Response.json({
      redirectUrl,
      reference,
      total: totalCents / 100,
      currency: config.currency,
      env: config.env,
    });
  } catch (e) {
    console.error("mp checkout error:", e?.code || "", e?.message || e);
    const msg = /Mercado Pago|Firebase Admin/.test(e?.message || "")
      ? e.message
      : "No se pudo iniciar el pago";
    const status = /Mercado Pago rechazó/.test(e?.message || "") ? 502 : 500;
    return Response.json({ error: msg }, { status });
  }
}
