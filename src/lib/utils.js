import { clsx } from "clsx";

export function cn(...inputs) {
  return clsx(inputs).trim().replace(/\s+/g, " ");
}

export function formatPrice(value) {
  const n = Number(value) || 0;
  return n.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 2,
  });
}
