import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "./firebase";

export const CARTS_COLLECTION = "carts";
export const ORDERS_COLLECTION = "orders";

/**
 * Doc carts/{uid}: { items: { productId: qty }, updatedAt }
 * Doc orders/{auto}: { userId, email, displayName, items: [{id,nombre,precio,qty}], total, status, createdAt }
 */

export function subscribeUserCart(uid, callback) {
  if (!uid) return () => {};
  return onSnapshot(doc(db, CARTS_COLLECTION, uid), (snap) => {
    callback(snap.exists() ? snap.data()?.items || {} : {});
  });
}

export async function saveUserCart(uid, items) {
  if (!uid) return;
  await setDoc(
    doc(db, CARTS_COLLECTION, uid),
    { items, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

export async function loadUserCart(uid) {
  if (!uid) return {};
  const snap = await getDoc(doc(db, CARTS_COLLECTION, uid));
  return snap.exists() ? snap.data()?.items || {} : {};
}

export async function clearUserCart(uid) {
  if (!uid) return;
  await setDoc(
    doc(db, CARTS_COLLECTION, uid),
    { items: {}, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

export async function createOrder({ uid, email, displayName, items, total }) {
  const ref = await addDoc(collection(db, ORDERS_COLLECTION), {
    userId: uid,
    email: email || "",
    displayName: displayName || "",
    items,
    total: Number(total) || 0,
    status: "pendiente",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}
