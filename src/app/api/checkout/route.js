/**
 * POST /api/checkout — Crea la orden interna y la orden en PayU Europa.
 * Body: { items: { productId: qty }, idToken }
 *
 * - Verifica el Firebase ID Token (firebase-admin).
 * - Lee precios y stock REALES de Firestore (nunca confía en el cliente).
 * - Crea payu_orders/{reference} en estado "pending".
 * - Crea la orden en PayU (OAuth + REST) y devuelve redirectUri.
 * Los secretos (client_secret, second key) NUNCA salen al navegador.
 *
 * Docs: https://developers.payu.com/europe/docs/payment-flows/auth-and-order/
 */
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb, getAdminAuth } from "@/lib/firebase-admin";
import {
  PAYU_ORDERS_COLLECTION,
  calcTotalCents,
  generateReference,
  getPayUConfig,
  getPayUAccessToken,
  createPayUOrder,
  extractClientIp,
} from "@/lib/payu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function baseUrlFrom(req) {
  const override = (process.env.APP_URL || "").trim().replace(/\/$/, "");
  if (override) return override;
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function splitName(displayName) {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "" };
}

export async function POST(req) {
  try {
    const { items, idToken } = await req.json().catch(() => ({}));

    // 1. Auth obligatoria
    if (!idToken) {
      return Response.json({ error: "No autenticado" }, { status: 401 });
    }
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

    // 2. Carrito: solo ids + cantidades
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      return Response.json({ error: "Carrito inválido" }, { status: 400 });
    }
    const entries = Object.entries(items)
      .map(([id, qty]) => [String(id).slice(0, 128), Math.trunc(Number(qty)) || 0])
      .filter(([, qty]) => qty > 0 && qty <= 99);
    if (entries.length === 0 || entries.length > 50) {
      return Response.json({ error: "Carrito vacío o inválido" }, { status: 400 });
    }

    const config = getPayUConfig();

    // 3. Datos confiables desde Firestore
    const db = getAdminDb();
    const ids = entries.map(([id]) => id);
    const snaps = await db.getAll(
      ...ids.map((id) => db.collection("products").doc(id))
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

    // 4. Total MXN (display) + cargo en moneda del POS (suma de líneas: consistente)
    const rate = config.mxnToPlnRate;
    const payuProducts = lines.map((l) => ({
      name: l.nombre,
      unitPrice: String(Math.max(1, Math.round(l.precio * rate * 100))),
      quantity: String(l.qty),
    }));
    const chargeMinor = payuProducts.reduce(
      (a, p) => a + Number(p.unitPrice) * Number(p.quantity),
      0
    );
    if (chargeMinor <= 0) {
      return Response.json({ error: "Total inválido" }, { status: 400 });
    }
    const totalMxnCents = calcTotalCents(lines);
    const reference = generateReference();

    // 5. Orden interna en "pending" (el webhook la actualizará)
    const orderRef = db.collection(PAYU_ORDERS_COLLECTION).doc(reference);
    await orderRef.set({
      reference,
      provider: "europe",
      region: "EU",
      userId: uid,
      email,
      displayName,
      items: lines,
      totalMxnCents,
      total: totalMxnCents / 100,
      currency: "MXN",
      chargeMinor,
      chargeCurrency: config.currency,
      rate,
      status: "pending",
      payuOrderId: "",
      payuTransactionId: "",
      responseMessage: "",
      attempts: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      paidAt: null,
      lastWebhook: null,
    });

    // 6. Orden en PayU (servidor a servidor)
    const base = baseUrlFrom(req);
    const { firstName, lastName } = splitName(displayName);
    const token = await getPayUAccessToken(config);
    const { redirectUri, payuOrderId } = await createPayUOrder(config, token, {
      notifyUrl: `${base}/api/payu/confirmation`,
      continueUrl: `${base}/pago/resultado?reference=${encodeURIComponent(reference)}`,
      customerIp: extractClientIp(req.headers),
      merchantPosId: config.posId,
      description: `Nintendo Store ${reference}`.slice(0, 255),
      currencyCode: config.currency,
      totalAmount: String(chargeMinor),
      extOrderId: reference,
      buyer: {
        email,
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
        language: "es",
      },
      products: payuProducts,
    });

    await orderRef.update({
      payuOrderId,
      payuTransactionId: payuOrderId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return Response.json({
      redirectUri,
      reference,
      total: totalMxnCents / 100,
      currency: "MXN",
      charge: chargeMinor / 100,
      chargeCurrency: config.currency,
    });
  } catch (e) {
    console.error("checkout error:", e?.code || "", e?.message || e);
    const msg = /PayU no configurado|Firebase Admin no configurado|PayU (OAuth|rechazó)/.test(
      e?.message || ""
    )
      ? e.message
      : "No se pudo iniciar el pago";
    const status = /PayU (OAuth|rechazó)/.test(e?.message || "") ? 502 : 500;
    return Response.json({ error: msg }, { status });
  }
}
