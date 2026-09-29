/**
 * GET /api/orders/[reference] — Estado de una orden PayU.
 * Auth: ?token=<Firebase ID Token> o header Authorization: Bearer <token>.
 * Solo el dueño de la orden o un admin puede consultarla.
 * Devuelve únicamente campos públicos (sin secretos ni datos de tarjeta).
 */
import { getAdminDb, getAdminAuth } from "@/lib/firebase-admin";
import { PAYU_ORDERS_COLLECTION, ORDER_STATUSES } from "@/lib/payu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const { reference } = await params;
    if (!reference || typeof reference !== "string" || reference.length > 128) {
      return Response.json({ error: "Referencia inválida" }, { status: 400 });
    }

    const url = new URL(req.url);
    const token =
      url.searchParams.get("token") ||
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) {
      return Response.json({ error: "No autenticado" }, { status: 401 });
    }

    let uid;
    try {
      const decoded = await getAdminAuth().verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      return Response.json({ error: "Sesión inválida" }, { status: 401 });
    }

    const db = getAdminDb();
    const snap = await db.collection(PAYU_ORDERS_COLLECTION).doc(reference).get();
    if (!snap.exists) {
      return Response.json({ error: "Orden no encontrada" }, { status: 404 });
    }
    const order = snap.data();

    // Dueño o admin
    let isOwner = order.userId === uid;
    let isAdmin = false;
    if (!isOwner) {
      try {
        const u = await db.collection("users").doc(uid).get();
        isAdmin = u.exists && u.data()?.role === "admin";
      } catch {}
      if (!isAdmin) {
        return Response.json({ error: "Sin acceso" }, { status: 403 });
      }
    }

    return Response.json({
      reference: order.reference || reference,
      provider: order.provider || "europe",
      status: ORDER_STATUSES.includes(order.status) ? order.status : "pending",
      total: Number(order.total) || 0,
      currency: order.currency || "COP",
      items: (order.items || []).map((i) => ({
        nombre: i.nombre || "",
        qty: i.qty || 0,
        precio: Number(i.precio) || 0,
      })),
      payuTransactionId: order.payuTransactionId || "",
      createdAt: order.createdAt?.toDate?.()?.toISOString?.() || null,
      updatedAt: order.updatedAt?.toDate?.()?.toISOString?.() || null,
    });
  } catch (e) {
    console.error("order status error:", e?.code || "", e?.message || e);
    return Response.json({ error: "No se pudo consultar la orden" }, { status: 500 });
  }
}
