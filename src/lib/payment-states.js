/**
 * Estado normalizado de pagos — compartido por todos los proveedores.
 * Los webhooks deciden transiciones con `decideTransition` (puro, testeable):
 * - "paid" es final: todo lo posterior es noop.
 * - un "paid" entrante se honra desde cualquier estado no-paid (reintento).
 * - "pending" entrante no cambia nada.
 * - finales no-paid: el primero gana.
 */
export const ORDER_STATUSES = ["pending", "paid", "rejected", "cancelled", "error"];
export const TERMINAL_STATUSES = ["paid", "rejected", "cancelled", "error"];

export function decideTransition(current, incoming) {
  if (current === "paid") return { next: "paid", changed: false, reason: "already-paid" };
  if (incoming === "paid") {
    return current === "paid"
      ? { next: "paid", changed: false, reason: "duplicate-noop" }
      : { next: "paid", changed: true, reason: "approve" };
  }
  if (incoming === "pending") return { next: current, changed: false, reason: "still-pending" };
  if (TERMINAL_STATUSES.includes(current)) {
    return { next: current, changed: false, reason: "terminal-kept" };
  }
  return { next: incoming, changed: true, reason: "first-terminal" };
}

/** Comparación de montos con tolerancia de centavo (anti manipulación). */
export function amountsClose(received, expected) {
  const v = Number(received);
  const e = Number(expected);
  return Number.isFinite(v) && Number.isFinite(e) && Math.abs(v - e) < 0.011;
}
