import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export function ensureFirestore() {
  if (!getApps().length) {
    const projectId = process.env.PID_SECRET;
    const clientEmail = process.env.CLIENT_EMAIL_SECRET;
    const privateKey = process.env.PRI_KEY?.replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Firestore 用のサービスアカウント環境変数が不足しています");
    }

    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }

  return getFirestore();
}
