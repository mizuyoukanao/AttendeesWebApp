# AttendeesWebApp

start.gg 連携のチェックインページと運営ダッシュボードの Next.js アプリです。

## セットアップ

1. 依存関係インストール
   ```bash
   npm install
   ```
2. 環境変数を `.env.local` に設定
   ```env
   SGGCID=your_client_id
   SGGCS=your_client_secret
   STARTGG_REDIRECT_URI=http://localhost:3000/api/auth/callback
   SGGOASCP=identity tournaments:read

   # 署名付きアプリセッション
   APP_SESSION_SECRET=your_strong_random_secret

   # Firestore（サービスアカウント / サーバー専用アクセス）
   PID_SECRET=your_project_id
   CLIENT_EMAIL_SECRET=service-account@your_project_id.iam.gserviceaccount.com
   PRI_KEY=-----BEGIN PRIVATE KEY-----\nXXXX\n-----END PRIVATE KEY-----\n
   # 任意: 共有URL QR生成
   NEXT_PUBLIC_BASE_URL=http://localhost:3000
   ```
3. 開発サーバー起動
   ```bash
   npm run dev
   ```
4. `http://localhost:3000` にアクセス

---

## 運用方針（Step7反映）

### 1) Firestore はクライアントから直接読まない
- クライアントは Firestore Web SDK を使いません。
- Firestore への read/write は **Next.js Route Handler + Firebase Admin SDK** のみで行います。

### 2) Firestore Rules は deny-all
- このアプリはサーバー専用アクセス前提です。
- Firestore Security Rules は次の deny-all を適用してください。

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### 3) リアルタイム一覧は SSE 経由
- 参加者一覧のリアルタイム更新は `onSnapshot` ではなく SSE を使います。
- エンドポイント: `GET /api/tournaments/{tournamentId}/participants/stream`
- クライアントは `EventSource` で購読し、切断時は再接続 + 通常GETへフォールバックします。

### 4) start.gg 管理者セッションと operator code セッションの違い
- start.gg ログイン後は、管理権限のある大会IDのみを `app_session` に保持してアクセスを許可します。
- operator code ログインは `POST /api/operator/session` で短命の operator セッションを発行します。
- API は共通の認可関数でモード（startgg / operator_code）ごとの許可を判定します。

### 5) access code はハッシュ保存
- Firestore には平文コードを保存しません。
- `operatorAccessCodeHash` / `operatorAccessCodes/{codeHash}` で管理し、照合は timing-safe 比較で行います。
- 平文は発行時レスポンスで一度だけ表示します（履歴表示は maskedCode）。

### 6) CSV import は即 delete しない
- CSV 取込で未掲載参加者を即削除しません。
- `importState.seenInLatestImport=false` で欠落候補としてマークします。
- 既存の `checkedIn` / `checkedInAt` / `checkedInBy` / `seatLabel` は preserve します。

### 7) seats コレクションが seat の真実源
- 座席状態は `tournaments/{tournamentId}/seats/{seatLabel}` を真実源として管理します。
- チェックイン自動割当・一括割当とも seats を更新し、participant 側 `seatLabel`/`adminNotes` は同期される従属データです。

---

## 主要API
- `GET /api/auth/session` : 署名付きアプリセッション状態を返却
- `POST /api/operator/session` : 大会コードで operator セッションを発行
- `GET /api/tournaments/{tournamentId}/participants` : 参加者一覧（フォールバック取得）
- `GET /api/tournaments/{tournamentId}/participants/stream` : 参加者 SSE ストリーム
- `POST /api/tournaments/{tournamentId}/participants` : CSV upsert（欠落はマークのみ）
- `POST /api/tournaments/{tournamentId}/participants/{participantId}/checkin` : チェックイン + 監査ログ追加
- `PATCH /api/tournaments/{tournamentId}/participants/{participantId}` : 参加者編集 + 監査ログ追加
- `POST /api/tournaments/{tournamentId}/seat-assignment/assign` : lock付き一括座席割当
