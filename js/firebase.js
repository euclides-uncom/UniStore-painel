import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { FIREBASE_CONFIG } from "../config.js";

export const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);
export const db = getFirestore(app);

setPersistence(auth, browserLocalPersistence).catch(() => {});

export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) return callback({ user: null, admin: false });
    let admin = false;
    let reason = "";
    try {
      const result = await user.getIdTokenResult(true);
      admin = result.claims.admin === true;
      if (!admin) reason = "Esta conta não tem a claim admin:true.";
    } catch (e) {
      reason = "Não foi possível validar a sessão. Entre novamente.";
    }
    callback({ user, admin, reason });
  });
}

export async function login(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  return credential.user;
}

export async function logout() {
  await signOut(auth);
}

export async function idToken(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sessão terminada. Entre novamente.");
  return user.getIdToken(forceRefresh);
}
