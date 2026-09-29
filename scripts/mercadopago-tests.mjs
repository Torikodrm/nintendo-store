/**
 * Suite Mercado Pago (Checkout Pro). Sin red, sin Firebase.
 * Ejecución: yarn test  (corre este archivo + scripts/payu-tests.mjs)
 */
import { createHmac } from "node:crypto";
import {
  getMPConfig,
  sanitizeReference,
  calcMPCents,
  generateMPReference,
  buildPreferenceBody,
  createMPPreference,
  getMPPayment,
  verifyMPWebhookSignature,
  mapMPStatus,
  handleUnknownMPOrder,
  buildMPOrderDoc,
  redactMPLog,
} from "../src/lib/mercadopago.js";
import { decideTransition, amountsClose } from "../src/lib/payment-states.js";

let pass = 0;
let fail = 0;
function check(id, name, cond) {
  if (cond) {
    pass++;
    console.log(`PASS [${id}] ${name}`);
  } else {
    fail++;
    console.log(`FAIL [${id}] ${name}`);
  }
}
function throws(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}
const SECRET = "test-secret-123";
function withEnv(vars, fn) {
  const keys = ["MERCADOPAGO_ENV", "MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "MERCADOPAGO_CURRENCY"];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const sbEnv = () => ({
  MERCADOPAGO_ENV: "sandbox",
  MERCADOPAGO_ACCESS_TOKEN: "TEST-123",
  MERCADOPAGO_WEBHOOK_SECRET: SECRET,
  MERCADOPAGO_CURRENCY: "COP",
});
function signManifest(dataId, reqId, ts) {
  let m = "";
  if (dataId) m += `id:${String(dataId).toLowerCase()};`;
  if (reqId) m += `request-id:${reqId};`;
  m += `ts:${ts};`;
  return createHmac("sha256", SECRET).update(m, "utf8").digest("hex");
}

// ---------- config ----------
withEnv(sbEnv(), () => {
  const c = getMPConfig();
  check("C1", "sandbox por defecto", !c.isProd && c.env === "sandbox" && c.currency === "COP");
});
withEnv({ ...sbEnv(), MERCADOPAGO_ENV: undefined, MERCADOPAGO_ACCESS_TOKEN: undefined }, () => {
  const m = throws(() => getMPConfig());
  check("C1", "sin token falla rápido", !!m && /sandbox sin configurar/.test(m));
});
withEnv({ ...sbEnv(), MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: "APP_USR-1" }, () => {
  const c = getMPConfig();
  check("C1", "producción con APP_USR- ok", c.isProd === true);
});
withEnv({ ...sbEnv(), MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: "TEST-1" }, () => {
  check("C1", "TEST- en producción se rechaza", !!throws(() => getMPConfig()));
});
withEnv({ ...sbEnv(), MERCADOPAGO_ACCESS_TOKEN: "APP_USR-1" }, () => {
  check("C1", "APP_USR- en sandbox se rechaza", !!throws(() => getMPConfig()));
});
withEnv({ ...sbEnv(), MERCADOPAGO_ENV: "production", MERCADOPAGO_ACCESS_TOKEN: "APP_USR-1", MERCADOPAGO_WEBHOOK_SECRET: undefined }, () => {
  check("C1", "prod sin webhook secret falla", !!throws(() => getMPConfig()));
});
withEnv({ ...sbEnv(), MERCADOPAGO_ENV: "staging" }, () => {
  check("C1", "ENV inválido sin fallback", !!throws(() => getMPConfig()));
});

// ---------- preferencia ----------
{
  const lines = [
    { nombre: "Zelda TOTK", precio: 1299, qty: 2 },
    { nombre: "Control", precio: 10.5, qty: 1 },
  ];
  const body = buildPreferenceBody({
    lines, email: "a@b.com", firstName: "Ana", lastName: "Luz",
    reference: "NSW-ABC-123", baseUrl: "https://tienda.test", currency: "COP",
  });
  check("P1", "montos del servidor (2dp)", body.items[0].unit_price === 1299 && body.items[1].unit_price === 10.5);
  check("P1", "cantidades enteras", body.items[0].quantity === 2);
  check("P1", "moneda COP en ítems", body.items.every((i) => i.currency_id === "COP"));
  check("P1", "external_reference preservada", body.external_reference === "NSW-ABC-123");
  check("P1", "back_urls con referencia", body.back_urls.success.includes("reference=NSW-ABC-123") && body.back_urls.failure === body.back_urls.success);
  check("P1", "notification_url https", body.notification_url === "https://tienda.test/api/mercadopago/webhook");
  check("P1", "auto_return approved + payer", body.auto_return === "approved" && body.payer.email === "a@b.com");
  const bad = buildPreferenceBody({ lines, email: "a@b.com", reference: "NSW áé/../@@", baseUrl: "https://t.test", currency: "COP" });
  check("P1", "referencia sanitizada (sin especiales)", /^[A-Za-z0-9_-]{1,64}$/.test(bad.external_reference));
  check("P1", "total servidor = suma líneas", calcMPCents(lines) === 260850);
  const refs = new Set(Array.from({ length: 300 }, generateMPReference));
  check("P1", "referencias únicas y válidas", refs.size === 300 && [...refs].every((r) => sanitizeReference(r) === r && r.length <= 64));
}

// ---------- crear preferencia (stub red) ----------
{
  const stub = (resp) => async () => ({ ok: resp.ok, json: async () => resp.body });
  const r1 = await createMPPreference(
    { isProd: false, accessToken: "TEST-x" },
    { items: [] },
    stub({ ok: true, body: { id: "p1", init_point: "https://mp/init", sandbox_init_point: "https://sandbox.mp/pay" } })
  );
  check("P2", "sandbox usa sandbox_init_point", r1.redirectUrl === "https://sandbox.mp/pay" && r1.preferenceId === "p1");
  const r2 = await createMPPreference(
    { isProd: true, accessToken: "APP_USR-x" },
    { items: [] },
    stub({ ok: true, body: { id: "p2", init_point: "https://mp/init" } })
  );
  check("P2", "producción usa init_point", r2.redirectUrl === "https://mp/init");
  let threw = false;
  try {
    await createMPPreference({ isProd: false, accessToken: "TEST-x" }, {}, stub({ ok: false, body: { message: "invalid" } }));
  } catch (e) {
    threw = /rechazó/.test(e.message) && !e.message.includes("TEST-x");
  }
  check("P2", "error de MP sin filtrar token", threw === true);
  const pay = await getMPPayment({ accessToken: "TEST-x" }, "999", stub({ ok: true, body: { id: 999, status: "approved" } }));
  check("P2", "getPayment devuelve el pago", pay.status === "approved");
  let threw2 = false;
  try {
    await getMPPayment({ accessToken: "TEST-x" }, "999", stub({ ok: false, body: {} }));
  } catch { threw2 = true; }
  check("P2", "getPayment falla si MP falla", threw2 === true);
}

// ---------- firma webhook ----------
{
  const ts = "1704908010";
  const v1 = signManifest("999999999", "req-abc", ts);
  const hdr = `ts=${ts},v1=${v1}`;
  check("W1", "firma válida verifica", verifyMPWebhookSignature({ xSignature: hdr, xRequestId: "req-abc", dataId: "999999999", secret: SECRET }) === true);
  check("W1", "data.id manipulado se rechaza", verifyMPWebhookSignature({ xSignature: hdr, xRequestId: "req-abc", dataId: "111", secret: SECRET }) === false);
  check("W1", "secreto distinto se rechaza", verifyMPWebhookSignature({ xSignature: hdr, xRequestId: "req-abc", dataId: "999999999", secret: "otro" }) === false);
  check("W1", "sin firma se rechaza", verifyMPWebhookSignature({ xSignature: "", xRequestId: "req-abc", dataId: "999", secret: SECRET }) === false);
  const v2 = signManifest("", "req-abc", ts); // parte id ausente se omite
  check("W1", "manifiesto omite partes ausentes", verifyMPWebhookSignature({ xSignature: `ts=${ts},v1=${v2}`, xRequestId: "req-abc", dataId: "", secret: SECRET }) === true);
  const v3 = signManifest("ORD01JQ4", "req-abc", ts); // mayúsculas -> minúsculas
  check("W1", "data.id alfanumérico a minúsculas", verifyMPWebhookSignature({ xSignature: `ts=${ts},v1=${v3}`, xRequestId: "req-abc", dataId: "ORD01JQ4", secret: SECRET }) === true);
}

// ---------- estados ----------
check("S1", "map completo", mapMPStatus("approved") === "paid" && mapMPStatus("rejected") === "rejected" && mapMPStatus("cancelled") === "cancelled" && mapMPStatus("refunded") === "cancelled" && mapMPStatus("charged_back") === "cancelled" && mapMPStatus("pending") === "pending" && mapMPStatus("in_process") === "pending" && mapMPStatus("in_mediation") === "pending");
check("S1", "desconocido -> error", mapMPStatus("weird") === "error");

// ---------- idempotencia (módulo compartido) ----------
{
  let d = decideTransition("pending", "paid");
  check("I1", "approved actualiza", d.next === "paid" && d.changed === true);
  d = decideTransition("paid", "paid");
  check("I1", "duplicado noop", d.changed === false);
  d = decideTransition("rejected", "paid");
  check("I1", "retry aprobado se honra", d.next === "paid" && d.changed === true);
  d = decideTransition("paid", "rejected");
  check("I1", "tardío no revierte", d.next === "paid" && d.changed === false);
}

// ---------- montos / orden desconocida / docs ----------
check("M1", "monto exacto y manipulado", amountsClose(2608.5, 2608.5) === true && amountsClose(1, 2608.5) === false);
{
  const r = handleUnknownMPOrder();
  check("M1", "desconocida 200 ignored", r.http === 200 && r.body.status === "ignored");
}
{
  const d = buildMPOrderDoc({ reference: "R", cardNumber: "4111", cvv: "1", accessToken: "T", status: "pending", total: 5 });
  check("M1", "sin tarjetas ni secretos", !("cardNumber" in d) && !("cvv" in d) && !("accessToken" in d) && d.total === 5);
}
{
  const out = redactMPLog({ reference: "R", status: "paid", accessToken: "T", webhookSecret: "S", paymentId: "1" });
  check("M1", "log redactado", out.reference === "R" && !("accessToken" in out) && !("webhookSecret" in out));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
