/**
 * Suite de pruebas PayU (LATAM + Europa). Sin red, sin Firebase.
 * Ejecución: yarn test  (node scripts/payu-tests.mjs desde la raíz del proyecto)
 *
 * Cubre los 18 casos mínimos exigidos para producción:
 *  1-2 selección sandbox/producción · 3 Europa intacta · 4 credenciales
 *  5 request generada · 6 monto server-side · 7-8 confirmación válida/inválida
 *  9-12 idempotencia y reintentos · 13-14 monto/moneda · 15 orden desconocida
 *  16 URL respuesta no autoritativa · 17 sin PAN/CVV · 18 sin secretos en logs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLatamConfig,
  buildLatamRequestSignature,
  formatLatamAmount,
  formatLatamWebhookValue,
  verifyLatamConfirmation,
  verifyLatamResponse,
  roundHalfEven1,
  mapLatamStatePol,
  mapLatamQueryState,
  decideLatamTransition,
  handleUnknownLatamOrder,
  buildLatamOrderDoc,
  redactForLog,
  latamAmountsMatch,
  latamCurrencyOk,
  queryLatamOrderByReference,
} from "../src/lib/payu-latam.js";
import {
  PAYU_BASE_URL,
  getPayUConfig,
  mapPayUStatus,
  calcTotalCents,
} from "../src/lib/payu.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

const TEST_KEY = "4Vj8eK4rloUd272L48hsrarnUA"; // clave pública de pruebas (docs PayU)
const BASE_ENV = {
  PAYU_LATAM_ENV: "",
  PAYU_LATAM_MERCHANT_ID: "",
  PAYU_LATAM_ACCOUNT_ID: "",
  PAYU_LATAM_API_LOGIN: "",
  PAYU_LATAM_API_KEY: "",
  PAYU_LATAM_CURRENCY: "",
};
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys({ ...BASE_ENV, ...vars })) {
    prev[k] = process.env[k];
  }
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
function throws(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}
const sandboxEnv = () => ({
  PAYU_LATAM_ENV: "sandbox",
  PAYU_LATAM_MERCHANT_ID: "508029",
  PAYU_LATAM_ACCOUNT_ID: "512324",
  PAYU_LATAM_API_LOGIN: "pRRXKOl8ikMmt9u",
  PAYU_LATAM_API_KEY: TEST_KEY,
  PAYU_LATAM_CURRENCY: "MXN",
});

// ---------- 1-2: selección de entorno ----------
withEnv(sandboxEnv(), () => {
  const c = getLatamConfig();
  check(1, "sandbox selecciona gateway sandbox", c.gatewayUrl.includes("sandbox.checkout.payulatam.com") && c.testFlag === "1" && !c.isProd);
});
withEnv({ ...sandboxEnv(), PAYU_LATAM_ENV: "production", PAYU_LATAM_MERCHANT_ID: "123456", PAYU_LATAM_ACCOUNT_ID: "654321", PAYU_LATAM_API_KEY: "REALKEY123" }, () => {
  const c = getLatamConfig();
  check(2, "production selecciona gateway producción", c.gatewayUrl === "https://checkout.payulatam.com/ppp-web-gateway-payu/" && c.testFlag === "0" && c.isProd);
});

// ---------- 3: Europa intacta ----------
check(3, "Europa sigue en sandbox hardcodeado", PAYU_BASE_URL === "https://secure.snd.payu.com");
withEnv(
  { PAYU_POS_ID: "300746", PAYU_MD5_SECOND_KEY: "k", PAYU_OAUTH_CLIENT_ID: "300746", PAYU_OAUTH_CLIENT_SECRET: "s", PAYU_LATAM_MERCHANT_ID: "999", PAYU_LATAM_API_KEY: "ZZZ" },
  () => {
    const c = getPayUConfig();
    check(3, "config Europa ignora vars LATAM", c.posId === "300746" && c.oauthClientSecret === "s");
  }
);
check(3, "mapa Europa intacto", mapPayUStatus("COMPLETED") === "paid" && mapPayUStatus("CANCELED") === "cancelled");

// ---------- 4: validación de credenciales ----------
withEnv({ ...sandboxEnv(), PAYU_LATAM_MERCHANT_ID: "" }, () => {
  const m = throws(() => getLatamConfig());
  check(4, "faltante en sandbox falla rápido", !!m && /sandbox sin configurar/.test(m));
});
withEnv({ ...sandboxEnv(), PAYU_LATAM_ENV: "production", PAYU_LATAM_API_KEY: "" }, () => {
  const m = throws(() => getLatamConfig());
  check(4, "faltante en producción nombra producción", !!m && /producción sin configurar/.test(m));
});
withEnv({ ...sandboxEnv(), PAYU_LATAM_ENV: "staging" }, () => {
  const m = throws(() => getLatamConfig());
  check(4, "ENV inválido no cae a ningún entorno", !!m && /sandbox o production/.test(m));
});
withEnv({ ...sandboxEnv(), PAYU_LATAM_ENV: "production" }, () => {
  const m = throws(() => getLatamConfig());
  check(4, "merchant de pruebas en producción se rechaza", !!m && /pruebas.*production|production.*pruebas/i.test(m));
});
withEnv({ ...sandboxEnv(), PAYU_LATAM_API_KEY: "SUPERSECRETO123" }, () => {
  const m = throws(() => { getLatamConfig({ ...process.env, PAYU_LATAM_MERCHANT_ID: "" }); });
  check(18, "error de config no filtra el secreto", !!m && !m.includes("SUPERSECRETO123"));
});

// ---------- 5: request generada ----------
check(
  5,
  "vector oficial de firma MD5",
  buildLatamRequestSignature({
    apiKey: TEST_KEY, merchantId: "508029", referenceCode: "TestPayU",
    amount: "20000", currency: "COP",
  }) === "7ee7cf808ce6a39b17481c54f2c57acc"
);
check(5, "monto siempre 2 decimales", formatLatamAmount(260850) === "2608.50" && formatLatamAmount(100) === "1.00");

// ---------- 6: monto server-side ----------
check(6, "total en centavos enteros", calcTotalCents([{ precio: 1299, qty: 2 }, { precio: 10.5, qty: 1 }]) === 260850);
const doc = buildLatamOrderDoc({ reference: "R", totalCents: 260850, total: 2608.5, currency: "MXN" });
check(6, "orden conserva totales del servidor", doc.totalCents === 260850 && doc.total === 2608.5);

// ---------- 7-8: confirmación ----------
function signedNotification(over = {}) {
  return {
    merchant_id: "508029", reference_sale: "NSW-TEST-1", value: "2608.50",
    currency: "MXN", state_pol: "4", sign: "", ...over,
  };
}
import { createHash } from "node:crypto";
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
function signConfirm(p) {
  const parts = String(p.value).split(".");
  const nv = !parts[1] ? `${parts[0]}.0` : parts[1].length > 1 && parts[1][1] !== "0" ? `${parts[0]}.${parts[1].slice(0, 2)}` : `${parts[0]}.${parts[1][0]}`;
  return md5(`${TEST_KEY}~${p.merchant_id}~${p.reference_sale}~${nv}~${p.currency}~${p.state_pol}`);
}
{
  const p = signedNotification();
  p.sign = signConfirm(p);
  check(7, "confirmación válida aceptada", verifyLatamConfirmation(p, TEST_KEY) === true);
  check(8, "valor manipulado se rechaza", verifyLatamConfirmation({ ...p, value: "1.00" }, TEST_KEY) === false);
  check(8, "firma ajena se rechaza", verifyLatamConfirmation({ ...p, sign: "0".repeat(32) }, TEST_KEY) === false);
  check(8, "sin firma se rechaza", verifyLatamConfirmation({ ...p, sign: "" }, TEST_KEY) === false);
  check(8, "otra apiKey se rechaza", verifyLatamConfirmation(p, "OTRAKEY") === false);
}
check(8, "reglas new_value oficiales", formatLatamWebhookValue("150.00") === "150.0" && formatLatamWebhookValue("150.25") === "150.25" && formatLatamWebhookValue("100") === "100.0");

// ---------- 9-12: idempotencia ----------
{
  let d = decideLatamTransition("pending", "paid");
  check(9, "approved actualiza orden", d.next === "paid" && d.changed === true);
  d = decideLatamTransition("paid", "paid");
  check(10, "approved duplicado es noop", d.next === "paid" && d.changed === false);
  d = decideLatamTransition("rejected", "paid");
  check(11, "rejected->retry->approved honra el pago", d.next === "paid" && d.changed === true);
  d = decideLatamTransition("paid", "rejected");
  check(12, "approved->rejected tardío no revierte", d.next === "paid" && d.changed === false);
  d = decideLatamTransition("rejected", "cancelled");
  check(12, "terminal no-paid conserva el primero", d.next === "rejected" && d.changed === false);
}

// ---------- 13-14: monto/moneda ----------
check(13, "monto exacto ok", latamAmountsMatch("2608.50", 2608.5) === true);
check(13, "monto manipulado bloquea", latamAmountsMatch("1.00", 2608.5) === false);
check(13, "monto no numérico bloquea", latamAmountsMatch("abc", 2608.5) === false);
check(14, "moneda distinta bloquea", latamCurrencyOk("COP", "MXN") === false);
check(14, "moneda igual ok / ausente tolerada", latamCurrencyOk("MXN", "MXN") === true && latamCurrencyOk("", "MXN") === true);

// ---------- 15: orden desconocida ----------
{
  const r = handleUnknownLatamOrder();
  check(15, "desconocida: 200 ignored sin efectos", r.http === 200 && r.body.status === "ignored");
}

// ---------- 16: URL respuesta no autoritativa ----------
{
  const src = readFileSync(join(ROOT, "src/app/pago/resultado/page.js"), "utf8");
  check(16, "resultado lee estado de /api/orders", src.includes("/api/orders/"));
  check(16, "resultado no consume transactionState del navegador", !src.includes("transactionState") && !src.includes("lapTransactionState"));
}

// ---------- 17: sin PAN/CVV ----------
{
  const d = buildLatamOrderDoc({
    reference: "R", cardNumber: "4111111111111111", cvv: "123", apiKey: "X",
    expiry: "12/29", status: "pending",
  });
  const leaked = ["cardNumber", "cvv", "apiKey", "expiry"].some((k) => k in d);
  check(17, "PAN/CVV/secretos jamás en el doc", !leaked && d.status === "pending");
}

// ---------- 18: logs sin secretos ----------
{
  const out = redactForLog({
    reference_sale: "R", state_pol: "4", sign: "abcdef", apiKey: "SECRETO",
    client_secret: "OTRO", value: "100.00", cardNumber: "4111",
  });
  check(18, "redact solo deja claves seguras", out.reference_sale === "R" && out.state_pol === "4" && !("sign" in out) && !("apiKey" in out) && !("cardNumber" in out));
}

// ---------- estados Latam ----------
check("9b", "map 4/6/5/7", mapLatamStatePol("4") === "paid" && mapLatamStatePol("6") === "rejected" && mapLatamStatePol("5") === "cancelled" && mapLatamStatePol("7") === "pending");
check("9b", "map desconocido -> error", mapLatamStatePol("99") === "error");
check("9b", "half-even 150.25->150.2 y 150.35->150.4", roundHalfEven1("150.25") === 150.2 && roundHalfEven1("150.35") === 150.4);
{
  // round-trip de firma de respuesta (informativa)
  const p = { merchantId: "508029", referenceCode: "R1", TX_VALUE: "100.00", currency: "USD", transactionState: "6" };
  const sig = md5(`${TEST_KEY}~508029~R1~100.0~USD~6`);
  check("9b", "firma respuesta válida", verifyLatamResponse({ ...p, signature: sig }, TEST_KEY) === true);
  check("9b", "firma respuesta manipulada se rechaza", verifyLatamResponse({ ...p, TX_VALUE: "1.00", signature: sig }, TEST_KEY) === false);
}

// ---------- reconciliación (stub de red) ----------
{
  const okFetch = async () => ({
    ok: true,
    json: async () => ({
      code: "SUCCESS",
      result: {
        payload: [{
          id: 844427581, status: "CAPTURED", referenceCode: "NSW-X", currency: "MXN",
          transactions: [{ id: "t1", transactionResponse: { state: "APPROVED", trazabilityCode: "999" } }],
        }],
      },
    }),
  });
  const q = await queryLatamOrderByReference(
    { apiLogin: "x", apiKey: "y", reportsUrl: "https://x", isProd: false }, "NSW-X", okFetch
  );
  check(11, "reconcilia APPROVED de PayU", q.found === true && q.mapped === "paid" && q.transactionId === "t1");
  check(11, "mapea query DECLINED/PENDING/EXPIRED", mapLatamQueryState("DECLINED") === "rejected" && mapLatamQueryState("PENDING") === "pending" && mapLatamQueryState("EXPIRED") === "cancelled");

  let sentBody = "";
  const spyFetch = async (url, opts) => {
    sentBody = opts.body;
    return { ok: true, json: async () => ({ code: "SUCCESS", result: { payload: [] } }) };
  };
  await queryLatamOrderByReference({ apiLogin: "x", apiKey: "y", reportsUrl: "https://x", isProd: false }, "R", spyFetch);
  const sent = JSON.parse(sentBody);
  check(11, "reconciliación usa comando oficial + test flag sandbox", sent.command === "ORDER_DETAIL_BY_REFERENCE_CODE" && sent.test === true && sent.details.referenceCode === "R");

  const errFetch = async () => ({ ok: true, json: async () => ({ code: "ERROR", error: "x" }) });
  let threw = false;
  try {
    await queryLatamOrderByReference({ apiLogin: "x", apiKey: "y", reportsUrl: "https://x", isProd: true }, "R", errFetch);
  } catch { threw = true; }
  check(11, "fallo de PayU no aprueba nada (lanza)", threw === true);

  let noLogin = false;
  try {
    await queryLatamOrderByReference({ apiLogin: "", apiKey: "y", reportsUrl: "https://x", isProd: false }, "R", okFetch);
  } catch { noLogin = true; }
  check(11, "sin apiLogin no hay reconciliación", noLogin === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
