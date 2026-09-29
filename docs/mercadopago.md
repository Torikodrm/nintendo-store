# Mercado Pago Checkout Pro — Pasarela activa

Redirect al checkout hospedado por Mercado Pago. Nuestro servidor nunca ve
ni almacena tarjetas. El código PayU (Europa/LATAM) se conserva en el repo
pero **inactivo en el checkout** (sin referencias desde la UI).

Docs: https://www.mercadopago.com.co/developers/es/docs (tienda en COP, Colombia)

## Flujo

```
Carrito → "Pagar con Mercado Pago"
  → POST /api/checkout/mercadopago { items, idToken }
      · verifica Firebase ID Token · precios/stock de Firestore (centavos)
      · crea payu_orders/{reference} pending (provider:"mercadopago")
      · crea preferencia (items, payer, back_urls, notification_url,
        auto_return approved, external_reference)
      · responde { redirectUrl } (sandbox_init_point o init_point)
  → navegador a Mercado Pago → pago
  → back_urls a /pago/resultado?reference=… (SOLO display)
  → webhook POST /api/mercadopago/webhook (fuente de verdad)
```

## Variables (solo servidor, sin NEXT_PUBLIC_)

| Variable | Valores | Dónde se consigue |
|---|---|---|
| `MERCADOPAGO_ENV` | `sandbox` (defecto) \| `production` | la eliges tú |
| `MERCADOPAGO_ACCESS_TOKEN` | `TEST-…` (sandbox) / `APP_USR-…` (prod) | Panel Developers → tu aplicación → Credenciales |
| `MERCADOPAGO_WEBHOOK_SECRET` | firma secreta | Panel Developers → tu app → Webhooks → Configurar (requerida en prod) |
| `MERCADOPAGO_CURRENCY` | `COP` (defecto) | debe coincidir con tu cuenta MP Colombia |

Reglas: token `TEST-` con `ENV=production` (y viceversa) = error explícito;
sin token = fail-fast; sin secreto en producción = fail-fast. Ver
`.env.example` (nombres, sin valores).

### Pasos para obtenerlas

1. Crea tu cuenta en [mercadopago.com.co](https://www.mercadopago.com.co) y entra a [Developers](https://www.mercadopago.com.co/developers/panel/app) (**Tus integraciones**).
2. Crea una aplicación.
3. En **Credenciales** copia el **Access Token de prueba** (`TEST-…`) → `MERCADOPAGO_ACCESS_TOKEN` + `MERCADOPAGO_ENV=sandbox`.
4. En **Webhooks → Configurar notificaciones**: URL de pruebas = `https://TU-DOMINIO/api/mercadopago/webhook` (en local usa ngrok), activa eventos de pagos, guarda y **revela el Secret signature** → `MERCADOPAGO_WEBHOOK_SECRET`.
5. Para probar: en el panel crea **cuentas de prueba** (un vendedor y un comprador colombianos; no pueden ser el mismo usuario), paga como comprador con tarjeta de prueba colombiana (ej. Visa `4097440000000004` o `4111111111111111`, Mastercard `5471300000000003`; titular `APRO` para aprobado, `OTHE` para rechazo; expiración futura, CVV `123`). Detalle: docs "Compras de prueba" de Checkout Pro.
6. A producción: `MERCADOPAGO_ENV=production` + Access Token productivo (`APP_USR-…`) + URL de producción en Webhooks. Nunca mezcles credenciales.

## URLs

- Preferencias: `https://api.mercadopago.com/checkout/preferences`
- Pagos: `https://api.mercadopago.com/v1/payments/{id}`
- Webhook: `https://TU-DOMINIO/api/mercadopago/webhook` (POST JSON e IPN `?topic=payment&id=`)
- Retorno: `https://TU-DOMINIO/pago/resultado?reference=…`

## Webhook: seguridad e idempotencia

1. `data.id` de query (`data.id`/`id`) o cuerpo; sin él → 400.
2. Si trae `x-signature`: verifica HMAC-SHA256 del manifiesto
   `id:{id};request-id:{req};ts:{ts};` (partes ausentes se omiten, id a
   minúsculas) contra el secreto; inválida → 403. Sin firma (IPN clásico) se
   continúa: la consulta a la API con nuestro token es autoritativa.
3. `GET /v1/payments/{id}` con access token; fallo → 502 (MP reintenta).
4. `live_mode` debe coincidir con el entorno (anti mezcla test/prod).
5. Orden por `external_reference`; inexistente o de otro proveedor → 200
   ignored (sin reintentos eternos).
6. Monto (`transaction_amount` vs `total`) y moneda exactos; si no → `error`.
7. Transición idempotente en transacción Firestore (`paid` final; reintento
   aprobado se honra). `attemptsLog` acotado a 20. Siempre 200 en lo
   bien formado. Mapeo: `approved→paid`, `rejected→rejected`,
   `cancelled/refunded/charged_back→cancelled`, `pending/in_process/
   in_mediation→pending`, otro→`error`.

## Estados en resultado

`/pago/resultado?reference=…` consulta `/api/orders/[reference]` (dueño o
admin) con polling hasta estado final o 90 s. Nunca marca pagado por
parámetros del navegador.

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| `TEST-… con ENV=production` | mezcla de credenciales |
| Webhook 403 firma | secreto desactualizado (Reset en panel) o `data.id` con mayúsculas mal normalizado |
| Webhook 403 entorno | notificación `live_mode` de otro entorno |
| Orden `pending` eterno | webhook no llega (URL no pública) o secret sin configurar |
| Checkout 502 | MP rechazó la preferencia (revisar items/moneda/cuenta) |
| Comprador = vendedor en test | MP lo prohíbe: usa dos cuentas de prueba distintas |

## Smoke-test producción

- [ ] `ENV=production` + token `APP_USR-…` + secret de URL productiva
- [ ] Redirect usa `init_point` (no `sandbox_…`)
- [ ] Compra real mínima → referencia + preferenceId persistidos
- [ ] Webhook actualiza a `paid` una vez; duplicado = noop
- [ ] Logs sin tokens ni tarjetas
