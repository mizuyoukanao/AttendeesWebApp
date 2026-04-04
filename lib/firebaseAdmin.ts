import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function ensureFirestore() {
  if (!getApps().length) {
    initializeApp();
  }
  return getFirestore();
}
