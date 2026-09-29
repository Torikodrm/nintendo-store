import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { db } from "./firebase";

export const PRODUCTS_COLLECTION = "products";

// Mismos valores que el admin para que filtros y tienda estén en sync
export const CATEGORIAS = [
  "Consolas",
  "Juegos",
  "Accesorios",
  "Amiibo",
  "Merch",
  "Otro",
];

export const PLATAFORMAS = [
  "Switch",
  "Switch 2",
  "Switch OLED",
  "Multiplataforma",
  "Otro",
];

/**
 * Estructura del documento en Firestore (colección `products`):
 * {
 *   nombre: string (requerido),
 *   sku: string,
 *   precio: number (COP),
 *   stock: number (int),
 *   categoria: "Consolas" | "Juegos" | "Accesorios" | "Amiibo" | "Merch" | "Otro",
 *   plataforma: "Switch" | "Switch 2" | "Switch OLED" | "Multiplataforma" | "Otro",
 *   descripcion: string,
 *   imagen: string (URL),
 *   activo: boolean (solo true visibles en tienda),
 *   createdAt: timestamp,
 *   updatedAt: timestamp
 * }
 */

// Suscripción solo a productos visibles en tienda.
// NOTA: sin orderBy() a propósito — where + orderBy exige índice compuesto
// en Firestore y rompía la página. Ordenamos en cliente por createdAt.
export function subscribeVisibleProducts(callback, onError) {
  const q = query(
    collection(db, PRODUCTS_COLLECTION),
    where("activo", "==", true)
  );
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const ta = a?.createdAt?.toMillis?.() ?? 0;
          const tb = b?.createdAt?.toMillis?.() ?? 0;
          return tb - ta;
        });
      callback(items);
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

// Alias mantenido por compatibilidad (misma query sin índice)
export function subscribeVisibleProductsSimple(callback, onError) {
  return subscribeVisibleProducts(callback, onError);
}
