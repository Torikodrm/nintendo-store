import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";

export const USERS_COLLECTION = "users";
export const ROLES = ["admin", "user"];

/**
 * Doc users/{uid}:
 * {
 *   email, displayName, photoURL,
 *   role: "admin" | "user",
 *   provider: "google",
 *   createdAt, lastLoginAt
 * }
 */

export function getAdminEmails() {
  return (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email) {
  if (!email) return false;
  return getAdminEmails().includes(String(email).toLowerCase());
}

async function ensureUserDoc(firebaseUser) {
  const ref = doc(db, USERS_COLLECTION, firebaseUser.uid);
  const snap = await getDoc(ref);
  const base = {
    email: firebaseUser.email || "",
    displayName: firebaseUser.displayName || "",
    photoURL: firebaseUser.photoURL || "",
    provider: "google",
    lastLoginAt: serverTimestamp(),
  };
  if (!snap.exists()) {
    await setDoc(ref, {
      ...base,
      role: isAdminEmail(firebaseUser.email) ? "admin" : "user",
      createdAt: serverTimestamp(),
    });
  } else {
    const data = snap.data() || {};
    const shouldBeAdmin = isAdminEmail(firebaseUser.email);
    await updateDoc(ref, {
      ...base,
      ...(shouldBeAdmin && data.role !== "admin" ? { role: "admin" } : {}),
    });
  }
  const fresh = await getDoc(ref);
  return { id: fresh.id, ...fresh.data() };
}

export async function signInWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  const profile = await ensureUserDoc(cred.user);
  return { firebaseUser: cred.user, profile };
}

export async function logOut() {
  await signOut(auth);
}

/**
 * Suscribe sesión + perfil con rol en vivo.
 * cb({ firebaseUser, profile, role, loading })
 */
export function subscribeAuth(cb) {
  return onAuthStateChanged(auth, (fbUser) => {
    if (!fbUser) {
      cb({ firebaseUser: null, profile: null, role: null, loading: false });
      return () => {};
    }
    cb({ firebaseUser: fbUser, profile: null, role: null, loading: true });
    const ref = doc(db, USERS_COLLECTION, fbUser.uid);
    const unsubDoc = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const profile = { id: snap.id, ...snap.data() };
          cb({ firebaseUser: fbUser, profile, role: profile.role || "user", loading: false });
        } else {
          ensureUserDoc(fbUser).catch(() => {
            cb({ firebaseUser: fbUser, profile: null, role: "user", loading: false });
          });
        }
      },
      () => {
        cb({ firebaseUser: fbUser, profile: null, role: "user", loading: false });
      }
    );
    return unsubDoc;
  });
}
