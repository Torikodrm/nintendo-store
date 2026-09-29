/**
 * Firebase Admin — ¡SOLO SERVIDOR!
 * Solo se importa desde `src/app/api/*` (runtime nodejs).
 * Requiere en .env.local (cuenta de servicio de Firebase Console):
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function initAdmin() {
  const existing = getApps();
  if (existing.length) return existing[0];
  const projectId = (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    ""
  ).trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "")
    .trim()
    .replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin no configurado. Define FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY en .env.local"
    );
  }
  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    projectId,
  });
}

export function getAdminDb() {
  return getFirestore(initAdmin());
}

export function getAdminAuth() {
  return getAuth(initAdmin());
}

/** Verifica un Firebase ID Token y devuelve { uid, email }. Lanza si es inválido. */
export async function verifyIdToken(idToken) {
  if (!idToken) throw new Error("Falta token de autenticación");
  const decoded = await getAdminAuth().verifyIdToken(idToken);
  return { uid: decoded.uid, email: decoded.email || "" };
}
