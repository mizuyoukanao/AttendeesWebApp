# AttendeesWebApp

start.gg 連携のチェックインキオスクと運営ダッシュボードの Next.js デモです。

## セットアップ

1. 依存関係インストール
   ```bash
   npm install
   ```
2. 環境変数を `.env.local` に設定
   ```env
   STARTGG_CLIENT_ID=your_client_id
   STARTGG_CLIENT_SECRET=your_client_secret
   # start.gg に登録した Redirect URI（例: http://localhost:3000/api/auth/callback）
   STARTGG_REDIRECT_URI=http://localhost:3000/api/auth/callback
   # 必要に応じて scope を上書き（デフォルト: "identity tournaments:read"）
   STARTGG_OAUTH_SCOPE=identity tournaments:read

   # Firestore（サービスアカウント）
   FIREBASE_PROJECT_ID=your_project_id
   FIREBASE_CLIENT_EMAIL=service-account@your_project_id.iam.gserviceaccount.com
   # JSON の private_key をそのまま貼る。改行は \n に置換
   FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nXXXX\n-----END PRIVATE KEY-----\n
   # Firestore クライアント（リアルタイム購読用 / NEXT_PUBLIC_ 前提）
   NEXT_PUBLIC_FIREBASE_API_KEY=your_web_api_key
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
   NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
  ```
3. 開発サーバー起動
   ```bash
   npm run dev
   ```
4. `http://localhost:3000` でアクセスできます。

## 主要機能
- html5-qrcode を使った QR スキャンと participantId の抽出
- 支払判定（Total Transaction / Total Owed、学割 1000円、差額調整）
- Firestore 上の大会単位 pricingConfig（general/bring/student/差額オプション）保存・取得
- CSV アップロード時のホワイトリスト取り込み（Id, GamerTag/Short GamerTag, Admin Notes, Checked In, Total Owed, Total Paid, Total Transaction）
- 参加者コレクションを Firestore に保存し、他端末でもリアルタイム購読できるようにしたダッシュボード＆キオスク
- チェックイン時の editNotes 追記（JST タイムスタンプ + 理由 + 増減額）
- 簡易ダッシュボードでの検索・フィルタ表示
- start.gg OAuth2 Authorization Code Flow 実装（/api/auth/login → /api/auth/callback でアクセストークン交換、currentUser 取得、Cookie 保存）

## Firestore 設定手順
1. Firebase コンソールで Firestore を「ネイティブモード」で有効化し、プロジェクトIDを控える。
2. IAMと管理 > サービスアカウントで新規キー（JSON）を発行し、以下の値を `.env.local` に設定する。
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY`（改行を `\n` に置換）
3. セキュリティルールで適切な read/write 権限を設定し、Cloud Functions/Next.js のホストと同じサービスアカウントでアクセスできるようにする。
4. 料金設定保存 API は `tournaments/{tournamentId}` ドキュメントに `pricingConfig` フィールドを `merge` で書き込みます（`updatedAt` は serverTimestamp）。
5. 参加者データは `tournaments/{tournamentId}/participants/{participantId}` に保存します。クライアントは Web SDK（NEXT_PUBLIC_FIREBASE_* の設定）で onSnapshot によるリアルタイム購読を行い、サーバー経由の POST/チェックイン更新が他端末にも同期されます。

## Firestore API エンドポイント
- `GET /api/tournaments/{tournamentId}/pricing` : Firestore から pricingConfig を取得（存在しない場合はデフォルト値を返却）。
- `POST /api/tournaments/{tournamentId}/pricing` : pricingConfig を Firestore に保存（`name` も任意で保存）。
- `GET /api/tournaments/{tournamentId}/participants` : Firestore の参加者コレクションを一覧取得。
- `POST /api/tournaments/{tournamentId}/participants` : CSV などから抽出した参加者配列をホワイトリスト項目で upsert（checkedIn=true は維持）。
- `POST /api/tournaments/{tournamentId}/participants/{participantId}/checkin` : チェックイン確定と editNotes 追記（サーバー時刻で JST 文字列を付与）。
