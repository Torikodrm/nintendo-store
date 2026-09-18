"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Gamepad2,
  Search,
  ShoppingCart,
  Plus,
  Minus,
  X,
  Trash2,
  Package,
  Loader2,
  Star,
  Truck,
  ShieldCheck,
  Zap,
  ChevronRight,
  Check,
} from "lucide-react";
import {
  subscribeVisibleProducts,
  CATEGORIAS,
  PLATAFORMAS,
} from "@/lib/store";
import { formatPrice, cn } from "@/lib/utils";

const CART_KEY = "nintendo-store-cart-v1";

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export default function StoreHome() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fbError, setFbError] = useState("");

  const [search, setSearch] = useState("");
  const [cat, setCat] = useState("Todas");
  const [plat, setPlat] = useState("Todas");
  const [sort, setSort] = useState("novedades");
  const [onlyStock, setOnlyStock] = useState(false);

  const [cart, setCart] = useState({}); // id -> qty
  const [cartOpen, setCartOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [ordered, setOrdered] = useState(false);

  // Cargar carrito persistido
  useEffect(() => {
    setCart(loadCart());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {}
  }, [cart]);

  // Suscripción a Firestore (misma BD que el admin: proyecto nintendo-66e56, colección products)
  // Query simple where(activo==true) sin orderBy para NO requerir índice compuesto.
  useEffect(() => {
    const unsub = subscribeVisibleProducts(
      (items) => {
        setProducts(items);
        setLoading(false);
        setFbError("");
      },
      (err) => {
        setFbError(
          "No se pudo conectar a la tienda. Revisa tu conexión. (" +
            (err?.message || err) +
            ")"
        );
        setLoading(false);
      }
    );
    return () => unsub && unsub();
  }, []);

  const byId = useMemo(() => {
    const m = {};
    for (const p of products) m[p.id] = p;
    return m;
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = products.filter((p) => {
      if (cat !== "Todas" && (p.categoria || "Otro") !== cat) return false;
      if (plat !== "Todas" && (p.plataforma || "Switch") !== plat) return false;
      if (onlyStock && (Number(p.stock) || 0) <= 0) return false;
      if (!q) return true;
      return (
        (p.nombre || "").toLowerCase().includes(q) ||
        (p.sku || "").toLowerCase().includes(q) ||
        (p.descripcion || "").toLowerCase().includes(q)
      );
    });
    switch (sort) {
      case "precio-asc":
        list = [...list].sort((a, b) => (Number(a.precio) || 0) - (Number(b.precio) || 0));
        break;
      case "precio-desc":
        list = [...list].sort((a, b) => (Number(b.precio) || 0) - (Number(a.precio) || 0));
        break;
      case "nombre":
        list = [...list].sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || "")));
        break;
      default:
        break; // novedades = orden Firestore (createdAt desc)
    }
    return list;
  }, [products, search, cat, plat, sort, onlyStock]);

  const cartItems = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => ({ ...byId[id], id, qty }))
        .filter((i) => i.nombre && i.qty > 0),
    [cart, byId]
  );
  const cartCount = cartItems.reduce((a, i) => a + i.qty, 0);
  const cartTotal = cartItems.reduce(
    (a, i) => a + (Number(i.precio) || 0) * i.qty,
    0
  );

  function addToCart(p, qty = 1) {
    const stock = Number(p.stock) || 0;
    if (stock <= 0) return;
    setCart((c) => {
      const cur = c[p.id] || 0;
      const next = Math.min(cur + qty, stock);
      return { ...c, [p.id]: next };
    });
  }

  function setQty(id, qty) {
    const stock = Number(byId[id]?.stock) || 99;
    const next = Math.max(0, Math.min(qty, stock));
    setCart((c) => {
      if (next <= 0) {
        const { [id]: _, ...rest } = c;
        return rest;
      }
      return { ...c, [id]: next };
    });
  }

  function checkout() {
    setOrdered(true);
    setCart({});
    setTimeout(() => setOrdered(false), 5000);
  }

  const destacados = useMemo(() => products.slice(0, 3), [products]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-slate-200 text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b-2 border-red-800 bg-gradient-to-b from-red-500 to-red-600 shadow-[0_3px_0_0_rgba(153,27,27,0.6),0_10px_24px_-8px_rgba(220,38,38,0.6)]">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-red-800 bg-gradient-to-b from-white to-slate-200 shadow-[0_2px_0_0_#7f1d1d,inset_0_1px_0_rgba(255,255,255,1)]">
            <Gamepad2 className="h-6 w-6 text-red-600" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black tracking-tight text-white [text-shadow:0_2px_0_rgba(127,29,29,0.8)]">
              Nintendo Store
            </h1>
            <p className="text-xs font-semibold text-red-100">
              Consolas · Juegos · Accesorios
            </p>
          </div>
          <div className="relative hidden flex-1 md:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-red-300" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar Zelda, Switch, Amiibo…"
              className="h-10 w-full rounded-xl border-2 border-red-800 bg-white/95 pl-9 pr-3 text-sm font-semibold text-slate-800 placeholder:text-slate-400 shadow-[inset_0_2px_4px_rgba(15,23,42,0.12)] focus:outline-none focus:ring-2 focus:ring-white"
            />
          </div>
          <button
            onClick={() => setCartOpen(true)}
            className="relative flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-red-800 bg-gradient-to-b from-white to-slate-200 px-4 font-black text-red-700 shadow-[0_2px_0_0_#7f1d1d] transition active:translate-y-[2px] active:shadow-none"
          >
            <ShoppingCart className="h-5 w-5" />
            <span className="hidden sm:inline">Carrito</span>
            {cartCount > 0 && (
              <span className="absolute -right-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-slate-900 px-1 text-xs font-black text-white">
                {cartCount}
              </span>
            )}
          </button>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-3 md:hidden">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-red-300" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar Zelda, Switch, Amiibo…"
              className="h-10 w-full rounded-xl border-2 border-red-800 bg-white/95 pl-9 pr-3 text-sm font-semibold text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-white"
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {fbError && (
          <div className="rounded-2xl border-2 border-amber-500 bg-gradient-to-b from-amber-50 to-amber-100 p-4 text-sm font-semibold text-amber-900 shadow-[0_3px_0_0_#b45309]">
            {fbError}
          </div>
        )}
        {ordered && (
          <div className="flex items-center gap-3 rounded-2xl border-2 border-emerald-500 bg-gradient-to-b from-emerald-50 to-emerald-100 p-4 text-sm font-bold text-emerald-900 shadow-[0_3px_0_0_#047857]">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-white">
              <Check className="h-5 w-5" />
            </span>
            ¡Pedido confirmado! Gracias por comprar en Nintendo Store. Te contactaremos por correo.
          </div>
        )}

        {/* Hero */}
        <section className="overflow-hidden rounded-3xl border-2 border-slate-900 bg-slate-900 text-white shadow-[0_4px_0_0_#020617]">
          <div className="grid md:grid-cols-2">
            <div className="space-y-4 p-6 md:p-10">
              <p className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1 text-xs font-black uppercase tracking-wider">
                <Zap className="h-3.5 w-3.5" /> Nuevo · Switch 2
              </p>
              <h2 className="text-3xl font-black leading-tight md:text-4xl">
                Juega más.
                <br />
                <span className="text-red-400">Vive Nintendo.</span>
              </h2>
              <p className="text-sm font-medium text-slate-300">
                Catálogo en vivo conectado a tu panel admin. Solo ves productos
                activos, con stock real de Firestore.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href="#catalogo"
                  className="inline-flex h-11 cursor-pointer items-center gap-1 rounded-xl border border-red-800 bg-gradient-to-b from-red-500 to-red-600 px-5 font-black text-white shadow-[0_3px_0_0_#7f1d1d] transition active:translate-y-[3px] active:shadow-none"
                >
                  Ver catálogo <ChevronRight className="h-4 w-4" />
                </a>
                <div className="inline-flex h-11 items-center gap-4 rounded-xl border border-slate-700 bg-slate-800 px-4 text-xs font-bold text-slate-300">
                  <span className="inline-flex items-center gap-1.5">
                    <Truck className="h-4 w-4 text-emerald-400" /> Envío 24/48h
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-sky-400" /> Original
                  </span>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 bg-gradient-to-br from-red-600 via-red-500 to-slate-900 p-4 md:p-6">
              {loading ? (
                <div className="col-span-3 flex items-center justify-center py-16 text-white/80">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              ) : destacados.length === 0 ? (
                <div className="col-span-3 flex flex-col items-center justify-center gap-2 py-16 text-white/80">
                  <Package className="h-10 w-10" />
                  <p className="text-sm font-bold">Sin destacados todavía</p>
                </div>
              ) : (
                destacados.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setDetail(p)}
                    className="group cursor-pointer overflow-hidden rounded-2xl border-2 border-white/30 bg-white text-left shadow-lg transition hover:-translate-y-1"
                  >
                    {p.imagen ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imagen}
                        alt={p.nombre}
                        className="h-24 w-full object-cover md:h-32"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="flex h-24 items-center justify-center bg-slate-200 md:h-32">
                        <Gamepad2 className="h-8 w-8 text-slate-400" />
                      </div>
                    )}
                    <div className="p-2">
                      <p className="truncate text-xs font-black text-slate-900">
                        {p.nombre}
                      </p>
                      <p className="text-xs font-black text-red-600">
                        {formatPrice(p.precio)}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Filtros */}
        <section id="catalogo" className="scroll-mt-24 space-y-3">
          <div className="flex flex-wrap gap-2">
            {["Todas", ...CATEGORIAS].map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={cn(
                  "h-9 cursor-pointer rounded-full border px-4 text-xs font-black transition",
                  cat === c
                    ? "border-red-800 bg-gradient-to-b from-red-500 to-red-600 text-white shadow-[0_2px_0_0_#7f1d1d]"
                    : "border-slate-300 bg-gradient-to-b from-white to-slate-200 text-slate-600 shadow-[0_2px_0_0_#cbd5e1] hover:to-slate-300"
                )}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-2xl border border-slate-300 bg-gradient-to-b from-white to-slate-100 p-3 shadow-[0_3px_0_0_#cbd5e1] sm:flex-row sm:items-center">
            <select
              value={plat}
              onChange={(e) => setPlat(e.target.value)}
              className="h-10 cursor-pointer rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700"
            >
              <option value="Todas">Todas las plataformas</option>
              {PLATAFORMAS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="h-10 cursor-pointer rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700"
            >
              <option value="novedades">Novedades</option>
              <option value="precio-asc">Menor precio</option>
              <option value="precio-desc">Mayor precio</option>
              <option value="nombre">Nombre A-Z</option>
            </select>
            <label className="flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700">
              <input
                type="checkbox"
                checked={onlyStock}
                onChange={(e) => setOnlyStock(e.target.checked)}
                className="h-4 w-4 accent-red-600"
              />
              Solo en stock
            </label>
            <p className="text-xs font-bold text-slate-500 sm:ml-auto">
              {filtered.length} producto{filtered.length === 1 ? "" : "s"}
            </p>
          </div>
        </section>

        {/* Grid */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin" /> Cargando tienda…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-slate-300 bg-white p-10 text-center shadow-[0_3px_0_0_#cbd5e1]">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-300 bg-gradient-to-b from-white to-slate-200">
              <Package className="h-7 w-7 text-slate-400" />
            </div>
            <p className="font-black text-slate-700">Nada por aquí… todavía</p>
            <p className="text-sm text-slate-500">
              Prueba otra búsqueda o categoría. Los productos ocultos en el
              admin no aparecen aquí.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => {
              const stock = Number(p.stock) || 0;
              const agotado = stock <= 0;
              return (
                <article
                  key={p.id}
                  className="group flex flex-col overflow-hidden rounded-3xl border border-slate-300 bg-white shadow-[0_4px_0_0_#cbd5e1] transition hover:-translate-y-1 hover:shadow-[0_8px_0_0_#cbd5e1]"
                >
                  <button
                    onClick={() => setDetail(p)}
                    className="relative block cursor-pointer text-left"
                  >
                    {p.imagen ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.imagen}
                        alt={p.nombre}
                        className="h-48 w-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="flex h-48 items-center justify-center bg-gradient-to-b from-slate-100 to-slate-200">
                        <Gamepad2 className="h-12 w-12 text-slate-300" />
                      </div>
                    )}
                    <div className="absolute left-2 top-2 flex gap-1.5">
                      <span className="rounded-full bg-slate-900/90 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-white">
                        {p.categoria || "Otro"}
                      </span>
                      <span className="rounded-full bg-red-600 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-white">
                        {p.plataforma || "Switch"}
                      </span>
                    </div>
                    {agotado && (
                      <span className="absolute right-2 top-2 rounded-full bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase text-white">
                        Agotado
                      </span>
                    )}
                    {!agotado && stock < 5 && (
                      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-amber-500 px-2.5 py-1 text-[10px] font-black uppercase text-white">
                        <Star className="h-3 w-3" /> ¡Solo {stock}!
                      </span>
                    )}
                  </button>
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <h3
                      onClick={() => setDetail(p)}
                      className="cursor-pointer truncate font-black text-slate-900 hover:text-red-600"
                      title={p.nombre}
                    >
                      {p.nombre}
                    </h3>
                    {p.descripcion && (
                      <p className="line-clamp-2 text-xs text-slate-500">
                        {p.descripcion}
                      </p>
                    )}
                    <div className="mt-auto flex items-end justify-between pt-2">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Precio
                        </p>
                        <p className="text-xl font-black text-slate-900">
                          {formatPrice(p.precio)}
                        </p>
                      </div>
                      <p
                        className={cn(
                          "text-xs font-black",
                          agotado
                            ? "text-red-600"
                            : stock < 5
                              ? "text-amber-600"
                              : "text-emerald-600"
                        )}
                      >
                        {agotado ? "Sin stock" : `${stock} disp.`}
                      </p>
                    </div>
                    <button
                      disabled={agotado}
                      onClick={() => addToCart(p)}
                      className="mt-1 flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-800 bg-gradient-to-b from-red-500 to-red-600 font-black text-white shadow-[0_3px_0_0_#7f1d1d] transition active:translate-y-[3px] active:shadow-none disabled:cursor-not-allowed disabled:border-slate-300 disabled:from-slate-200 disabled:to-slate-300 disabled:text-slate-400 disabled:shadow-none"
                    >
                      <ShoppingCart className="h-4 w-4" />
                      {agotado ? "Agotado" : "Agregar"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <footer className="rounded-3xl border border-slate-300 bg-white p-6 text-center shadow-[0_3px_0_0_#cbd5e1]">
          <p className="text-sm font-black text-slate-800">
            Nintendo Store · Misma base de datos que tu admin
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Proyecto Firebase <b>nintendo-66e56</b> · colección{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">
              products
            </code>{" "}
            · campo <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">activo=true</code> visible aquí
          </p>
        </footer>
      </main>

      {/* Modal detalle */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-4 sm:items-center"
          onClick={() => setDetail(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg overflow-hidden rounded-3xl border-2 border-slate-900 bg-white shadow-2xl"
          >
            {detail.imagen ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={detail.imagen}
                alt={detail.nombre}
                className="h-56 w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <div className="flex h-40 items-center justify-center bg-slate-100">
                <Gamepad2 className="h-12 w-12 text-slate-300" />
              </div>
            )}
            <div className="space-y-3 p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-xl font-black text-slate-900">
                  {detail.nombre}
                </h3>
                <button
                  onClick={() => setDetail(null)}
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px] font-black">
                <span className="rounded-full bg-slate-900 px-2.5 py-1 text-white">
                  {detail.categoria}
                </span>
                <span className="rounded-full bg-red-600 px-2.5 py-1 text-white">
                  {detail.plataforma}
                </span>
                {detail.sku && (
                  <span className="rounded-full bg-slate-200 px-2.5 py-1 text-slate-600">
                    {detail.sku}
                  </span>
                )}
              </div>
              {detail.descripcion && (
                <p className="text-sm text-slate-600">{detail.descripcion}</p>
              )}
              <div className="flex items-center justify-between rounded-2xl bg-slate-50 p-3">
                <p className="text-2xl font-black">{formatPrice(detail.precio)}</p>
                <p className="text-xs font-black text-slate-500">
                  {(Number(detail.stock) || 0) > 0
                    ? `${detail.stock} disponibles`
                    : "Agotado"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={(Number(detail.stock) || 0) <= 0}
                  onClick={() => {
                    addToCart(detail);
                    setDetail(null);
                    setCartOpen(true);
                  }}
                  className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-800 bg-gradient-to-b from-red-500 to-red-600 font-black text-white shadow-[0_3px_0_0_#7f1d1d] active:translate-y-[3px] active:shadow-none disabled:from-slate-200 disabled:to-slate-300 disabled:text-slate-400 disabled:shadow-none"
                >
                  <ShoppingCart className="h-4 w-4" /> Agregar al carrito
                </button>
                <button
                  onClick={() => setDetail(null)}
                  className="h-11 cursor-pointer rounded-xl border border-slate-300 bg-white px-4 font-black text-slate-600 shadow-[0_3px_0_0_#cbd5e1]"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Drawer carrito */}
      {cartOpen && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-slate-900/60"
            onClick={() => setCartOpen(false)}
          />
          <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l-2 border-slate-900 bg-white shadow-2xl">
            <div className="flex items-center gap-2 border-b-2 border-red-800 bg-gradient-to-b from-red-500 to-red-600 p-4 text-white">
              <ShoppingCart className="h-5 w-5" />
              <h3 className="flex-1 font-black">Tu carrito ({cartCount})</h3>
              <button
                onClick={() => setCartOpen(false)}
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-white/20 hover:bg-white/30"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {cartItems.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center">
                  <ShoppingCart className="h-10 w-10 text-slate-300" />
                  <p className="font-black text-slate-700">Carrito vacío</p>
                  <p className="text-sm text-slate-500">
                    Agrega juegos, consolas y accesorios.
                  </p>
                </div>
              ) : (
                cartItems.map((i) => (
                  <div
                    key={i.id}
                    className="flex gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3"
                  >
                    {i.imagen ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={i.imagen}
                        alt={i.nombre}
                        className="h-16 w-16 rounded-xl border object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-slate-200">
                        <Gamepad2 className="h-6 w-6 text-slate-400" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black">{i.nombre}</p>
                      <p className="text-sm font-black text-red-600">
                        {formatPrice(i.precio)}
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <button
                          onClick={() => setQty(i.id, i.qty - 1)}
                          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white shadow-[0_2px_0_0_#cbd5e1]"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-6 text-center text-sm font-black">
                          {i.qty}
                        </span>
                        <button
                          onClick={() => setQty(i.id, i.qty + 1)}
                          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white shadow-[0_2px_0_0_#cbd5e1]"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setQty(i.id, 0)}
                          className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-3 border-t p-4">
              <div className="flex justify-between font-black">
                <span>Total</span>
                <span>{formatPrice(cartTotal)}</span>
              </div>
              <button
                disabled={cartItems.length === 0}
                onClick={checkout}
                className="flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-red-800 bg-gradient-to-b from-red-500 to-red-600 font-black text-white shadow-[0_3px_0_0_#7f1d1d] active:translate-y-[3px] active:shadow-none disabled:from-slate-200 disabled:to-slate-300 disabled:text-slate-400 disabled:shadow-none"
              >
                Finalizar compra · {formatPrice(cartTotal)}
              </button>
              <p className="text-center text-[11px] font-semibold text-slate-400">
                Demo: no se descuenta stock automáticamente. El admin lo gestiona.
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
