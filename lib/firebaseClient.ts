import { FirebaseApp, getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

let app: FirebaseApp | null = null;

export function ensureFirebaseClient() {
  if (app) return app;

  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  };

  if (!config.apiKey || !config.projectId) {
    throw new Error("NEXT_PUBLIC_FIREBASE_* のクライアント設定が不足しています");
  }

  if (!getApps().length) {
    app = initializeApp(config);
  } else {
    app = getApps()[0];
  }

  return app;
}

export function ensureFirestoreClient() {
  const app = ensureFirebaseClient();
  return getFirestore(app);
}
