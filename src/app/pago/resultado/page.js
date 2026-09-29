"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Gamepad2,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  AlertTriangle,
  ShoppingCart,
  ArrowLeft,
} from "lucide-react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { formatPrice } from "@/lib/utils";

const TERMINAL = ["paid", "rejected", "cancelled", "error"];

const STATUS_UI = {
  paid: {
    icon: CheckCircle2,
    title: "¡Pago aprobado!",
    text: "Tu pago fue confirmado por PayU. Recibirás los detalles en tu correo. ¡A jugar!",
    card: "border-emerald-500 from-emerald-50 to-emerald-100",
    textColor: "text-emerald-900",
    iconColor: "text-emerald-600",
  },
  pending: {
    icon: Clock,
    title: "Pago pendiente",
    text: "PayU aún no confirma tu pago. Esta página se actualiza sola; no cierres ni pagues dos veces.",
    card: "border-amber-500 from-amber-50 to-amber-100",
    textColor: "text-amber-900",
    iconColor: "text-amber-600",
  },
  rejected: {
    icon: XCircle,
    title: "Pago rechazado",
    text: "Tu banco o PayU rechazó el pago. No se hizo ningún cargo. Puedes intentarlo con otro método.",
    card: "border-red-500 from-red-50 to-red-100",
    textColor: "text-red-900",
    iconColor: "text-red-600",
  },
  cancelled: {
    icon: Ban,
    title: "Pago cancelado",
    text: "Cancelaste el pago en el checkout o la transacción expiró. Tu carrito sigue intacto.",
    card: "border-slate-500 from-slate-50 to-slate-100",
    textColor: "text-slate-900",
    iconColor: "text-slate-500",
  },
  error: {
    icon: AlertTriangle,
    title: "Error en el pago",
    text: "Ocurrió un problema procesando tu pago. Si ves un cargo, contáctanos con tu referencia.",
    card: "border-red-500 from-red-50 to-red-100",
    textColor: "text-red-900",
    iconColor: "text-red-600",
  },
};

function ResultadoInner() {
  const params = useSearchParams();
  const reference =
    params.get("reference") ||
    params.get("referenceCode") ||
    params.get("reference_sale") ||
    params.get("extOrderId") ||
    "";

  const [idToken, setIdToken] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  const [polling, setPolling] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setIdToken(u ? await u.getIdToken().catch(() => null) : null);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  const fetchOrder = useCallback(async () => {
    if (!reference || !idToken) return null;
    const res = await fetch(
      `/api/orders/${encodeURIComponent(reference)}?token=${encodeURIComponent(idToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo consultar la orden");
    return data;
  }, [reference, idToken]);

  useEffect(() => {
    if (!reference || !authReady) return;
    if (!idToken) return; // espera login
    let alive = true;
    let timer = null;
    const started = Date.now();

    async function poll() {
      try {
        const data = await fetchOrder();
        if (!alive || !data) return;
        setOrder(data);
        setError("");
        // Sigue consultando hasta estado final o 90 s (el webhook puede tardar)
        if (!TERMINAL.includes(data.status) && Date.now() - started < 90000) {
          timer = setTimeout(poll, 3000);
        } else {
          setPolling(false);
        }
      } catch (e) {
        if (!alive) return;
        setError(e.message || "Error al consultar");
        setPolling(false);
      }
    }
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [reference, authReady, idToken, fetchOrder]);

  const ui = order ? STATUS_UI[order.status] || STATUS_UI.pending : null;
  const Icon = ui?.icon || Loader2;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-slate-200 text-slate-900">
      <header className="border-b-2 border-red-800 bg-gradient-to-b from-red-500 to-red-600">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-red-800 bg-gradient-to-b from-white to-slate-200">
            <Gamepad2 className="h-6 w-6 text-red-600" />
          </div>
          <h1 className="flex-1 text-lg font-black text-white [text-shadow:0_2px_0_rgba(127,29,29,0.8)]">
            Resultado del pago
          </h1>
          <Link
            href="/"
            className="flex h-10 items-center gap-1 rounded-xl border border-red-800 bg-white px-3 text-sm font-black text-red-700"
          >
            <ArrowLeft className="h-4 w-4" /> Tienda
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
        {!reference ? (
          <Card className="border-red-500">
            <AlertTriangle className="mx-auto h-10 w-10 text-red-500" />
            <p className="font-black">Falta la referencia de compra</p>
            <p className="text-sm text-slate-500">Regresa a la tienda e intenta de nuevo.</p>
          </Card>
        ) : !authReady ? (
          <Card>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-slate-400" />
            <p className="text-sm text-slate-500">Verificando sesión…</p>
          </Card>
        ) : !idToken ? (
          <Card>
            <ShoppingCart className="mx-auto h-10 w-10 text-slate-300" />
            <p className="font-black">Inicia sesión para ver tu compra</p>
            <p className="text-sm text-slate-500">
              La referencia <Mono>{reference}</Mono> está asociada a tu cuenta.
            </p>
            <Link href="/" className="mt-2 inline-block rounded-xl bg-red-600 px-5 py-2.5 font-black text-white">
              Ir a la tienda
            </Link>
          </Card>
        ) : error ? (
          <Card className="border-red-500">
            <XCircle className="mx-auto h-10 w-10 text-red-500" />
            <p className="font-black">{error}</p>
            <p className="text-sm text-slate-500">
              Referencia: <Mono>{reference}</Mono>
            </p>
          </Card>
        ) : !order ? (
          <Card>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-slate-400" />
            <p className="text-sm text-slate-500">Consultando tu pago…</p>
          </Card>
        ) : (
          <>
            <div className={`rounded-3xl border-2 bg-gradient-to-b p-6 text-center shadow ${ui.card}`}>
              <Icon className={`mx-auto h-12 w-12 ${ui.iconColor} ${order.status === "pending" ? "animate-pulse" : ""}`} />
              <h2 className={`mt-2 text-2xl font-black ${ui.textColor}`}>{ui.title}</h2>
              <p className={`mt-1 text-sm font-semibold ${ui.textColor}`}>{ui.text}</p>
              {polling && order.status === "pending" && (
                <p className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-amber-700">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Actualizando estado…
                </p>
              )}
            </div>
            <div className="rounded-3xl border border-slate-300 bg-white p-6 shadow">
              <dl className="space-y-2 text-sm">
                <Row label="Referencia" value={<Mono>{order.reference}</Mono>} />
                {order.provider && (
                  <Row
                    label="Pasarela"
                    value={<span className="text-xs font-black uppercase text-slate-600">{order.provider || "mercadopago"}</span>}
                  />
                )}
                <Row
                  label="Estado"
                  value={<span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-black uppercase text-white">{order.status}</span>}
                />
                <Row label="Total" value={<span className="text-lg font-black">{formatPrice(order.total)} {order.currency}</span>} />
                {order.payuTransactionId && (
                  <Row label="Transacción" value={<Mono>{order.payuTransactionId}</Mono>} />
                )}
                {order.items?.length > 0 && (
                  <div className="pt-2">
                    <dt className="font-bold text-slate-500">Productos</dt>
                    <dd className="mt-1 space-y-1">
                      {order.items.map((i, idx) => (
                        <p key={idx} className="flex justify-between gap-2 text-slate-700">
                          <span className="truncate">{i.qty} × {i.nombre}</span>
                          <span className="font-bold">{formatPrice(i.precio * i.qty)}</span>
                        </p>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
              {order.status === "rejected" || order.status === "cancelled" ? (
                <Link
                  href="/"
                  className="mt-4 flex h-12 items-center justify-center gap-2 rounded-xl border border-red-800 bg-gradient-to-b from-red-500 to-red-600 font-black text-white"
                >
                  <ShoppingCart className="h-5 w-5" /> Intentar de nuevo
                </Link>
              ) : null}
            </div>
            <p className="text-center text-[11px] text-slate-400">
              El estado se confirma por notificación directa de PayU a nuestros servidores.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`flex flex-col items-center gap-2 rounded-3xl border border-slate-300 bg-white p-10 text-center shadow ${className}`}>
      {children}
    </div>
  );
}

function Mono({ children }) {
  return (
    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] break-all">
      {children}
    </code>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="font-bold text-slate-500">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

export default function ResultadoPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center gap-2 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" /> Cargando…
        </div>
      }
    >
      <ResultadoInner />
    </Suspense>
  );
}
