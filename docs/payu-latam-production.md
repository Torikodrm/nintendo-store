# PayU LATAM — Producción

Integración **WebCheckout** (redirección al checkout hospedado por PayU).
Nuestro servidor nunca ve ni almacena tarjetas (fuera de alcance PCI de
manejo de PAN/CVV por diseño). La integración europea (`src/lib/payu.js`,
POS PLN) es independiente y no se toca.

Docs oficiales: https://developers.payulatam.com/latam/es/docs/

## Arquitectura

```
Carrito (cliente, solo ids+cantidades)
  → POST /api/checkout/latam { items, idToken }
      · verifica Firebase ID Token (firebase-admin)
      · lee precios/stock de Firestore, total en centavos enteros
      · crea payu_orders/{reference} en "pending" (provider:"latam")
      · firma md5(apiKey~merchantId~referenceCode~amount~currency)
      · responde { gatewayUrl, fields }
  → navegador auto-POSTea el formulario a PayU
  → PayU cobra y redirige a /pago/resultado?referenceCode=… (SOLO display)
  → PayU notifica a /api/payu/latam/confirmation (fuente de verdad)
```

El cliente jamás decide montos: solo envía `{ productoId: cantidad }`.

## Variables de entorno (solo servidor, sin prefijo NEXT_PUBLIC_)

| Variable | Obligatoria | Notas |
|---|---|---|
| `PAYU_LATAM_ENV` | no (`sandbox` por defecto) | `sandbox` \| `production`. Valor inválido = error, sin fallback |
| `PAYU_LATAM_MERCHANT_ID` | sí | Del correo/panel PayU |
| `PAYU_LATAM_ACCOUNT_ID` | sí | Por país (MX, CO, …). Define métodos de pago |
| `PAYU_LATAM_API_KEY` | sí | Solo servidor. Nunca al navegador ni a logs |
| `PAYU_LATAM_API_LOGIN` | para reconciliar | Necesaria para Queries API (`/api/admin/latam/reconcile`) |
| `PAYU_LATAM_CURRENCY` | no (`MXN`) | Debe coincidir con la cuenta PayU |
| `APP_URL` | no | Override de URL pública; si se omite se deriva del request |

Reglas: producción sin credenciales = error al arrancar el flujo (fail-fast);
merchant de pruebas `508029` con `ENV=production` = error explícito; jamás hay
fallback silencioso entre entornos. Ver `.env.example` (nombres, sin valores).

## URLs

- Gateway sandbox: `https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/`
- Gateway producción: `https://checkout.payulatam.com/ppp-web-gateway-payu/`
- Reports API: `https://{api,sandbox.api}.payulatam.com/reports-api/4.0/service.cgi`
- Webhook a registrar en PayU: `https://TU-DOMINIO/api/payu/latam/confirmation`
- Retorno usuario: `https://TU-DOMINIO/pago/resultado`
- Centralizadas en `src/lib/payu-latam.js` (`LATAM_GATEWAYS`, `LATAM_REPORTS_API`).

## Modelo (`payu_orders/{reference}`, Firestore sin esquema — sin migración)

Campos Latam: `provider:"latam"`, `region:"LATAM"`, `totalCents`, `total`,
`currency`, `status` (`pending|paid|rejected|cancelled|error`), `rawState`
(`state_pol` crudo), `payuReferencePol`, `payuTransactionId`, `attempts`
(contador) + `attemptsLog` (últimos 20 intentos con transactionId/estado/fecha),
`paidAt`, `lastWebhook`. Sin PAN/CVV/secretos (allowlist en
`buildLatamOrderDoc`). El webhook europeo no toca órdenes `provider:"latam"`
y viceversa (chequeo de aislamiento en ambos webhooks).

## Idempotencia y estados

`paid` es final: notificaciones posteriores = noop. Un `paid` entrante se honra
desde cualquier estado no-paid (reintento aprobado). Primer desenlace final
gana; `pending` no cambia nada. Transición en **transacción Firestore**
(`runTransaction`) + `decideLatamTransition()` puro (testeado). Mapeo:
`4→paid`, `6→rejected`, `5→cancelled`, `7→pending`, otro→`error`.
Fulfillment = transición a `paid` una sola vez (este proyecto no descuenta
stock automáticamente; lo gestiona el admin — no se inventaron efectos).

## Reconciliación (Fase 11)

`POST /api/admin/latam/reconcile { reference, idToken }` (solo rol admin):
consulta `ORDER_DETAIL_BY_REFERENCE_CODE` en PayU y aplica el resultado con la
misma lógica idempotente + verificación de monto. Úsalo cuando: webhook
perdido/timeout, crash durante el procesamiento, resultado atascado en
`pending`. Nunca aprueba por supuestos locales.

## Despliegue a producción

1. Obtener del operador PayU: merchantId, accountId (país), apiKey, apiLogin.
2. Inyectar secretos por el mecanismo del hosting (nunca en git; `.env.local`
   está ignorado). `PAYU_LATAM_ENV=production`.
3. HTTPS público + publicar `firestore.rules` (ya niega escrituras cliente).
4. Registrar webhook y response URL en el Módulo PayU (Configuración técnica).
5. Smoke test (abajo) con **1 transacción real mínima** antes de abrir tráfico.

## Rollback

Volver a `PAYU_LATAM_ENV=sandbox` con credenciales de prueba revierte a
sandbox al instante (gateway + `test=1` centralizados). Las órdenes ya creadas
conservan su `provider`/estado y no se re-procesan.

## Testing

- `yarn test` — 45 pruebas sin red (firmas con vectores oficiales, estados,
  idempotencia, monto/moneda, redacción de logs, separación Europa).
- Sandbox manual: `test=1`, tarjetas de prueba PayU; aprobado/rechazado según
  docs "Probar tu solución"; webhook local vía ngrok (PayU no alcanza localhost).

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| `PAYU_LATAM_ENV inválido` | valor distinto de sandbox/production |
| `merchant de pruebas con ENV=production` | mezclaste credenciales test en prod |
| Webhook 403 | firma/comercio inválido (revisar apiKey, merchantId) |
| Orden `pending` eterno | webhook no llega (URL no pública) → reconciliar |
| `error` tras webhook | monto/moneda no coincide con la orden |
| Reconcile 502 | PayU no respondió / falta `PAYU_LATAM_API_LOGIN` |

## Checklist de smoke-test en producción

- [ ] `PAYU_LATAM_ENV=production` efectivo (log `latam checkout` muestra `env`)
- [ ] merchantId/accountId de producción correctos (comparar con panel PayU)
- [ ] URLs HTTPS registradas y accesibles (webhook responde 405 a GET = vivo)
- [ ] Gateway usado: `checkout.payulatam.com` (sin `sandbox.`)
- [ ] Transacción real mínima creada → `referenceCode` persistido en orden
- [ ] Confirmación recibida (`attempts` ≥ 1, `lastWebhook` presente)
- [ ] Orden en `paid` una sola vez (`paidAt` único, sin duplicados en `attemptsLog`)
- [ ] Reintento/duplicate webhook = noop (`changed:false`)
- [ ] Reconciliación responde para la referencia
- [ ] Logs sin apiKey/tarjetas/CVV
