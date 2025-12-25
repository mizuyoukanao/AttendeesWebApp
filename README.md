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
   ```
3. 開発サーバー起動
   ```bash
   npm run dev
   ```
4. `http://localhost:3000` でアクセスできます。

## 主要機能
- html5-qrcode を使った QR スキャンと participantId の抽出
- 支払判定（Total Transaction / Total Owed、学割 1000円、差額調整）
- CSV アップロード時のホワイトリスト取り込み（Id, GamerTag/Short GamerTag, Admin Notes, Checked In, Total Owed, Total Paid, Total Transaction）
- チェックイン時の editNotes 追記（JST タイムスタンプ + 理由 + 増減額）
- 簡易ダッシュボードでの検索・フィルタ表示
- start.gg OAuth2 Authorization Code Flow 実装（/api/auth/login → /api/auth/callback でアクセストークン交換、currentUser 取得、Cookie 保存）
