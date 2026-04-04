# AttendeesWebApp

start.gg 連携のチェックインページと運営ダッシュボードの Next.js アプリです。

## セットアップ（ローカル）

1. 依存関係インストール
   ```bash
   npm install
   ```

2. 環境変数を `.env.local` に設定
   ```env
   APP_SESSION_SECRET=your_strong_random_secret
   SGGCID=your_startgg_client_id
   SGGCS=your_startgg_client_secret
   SGGOASCP=identity tournaments:read
   STARTGG_REDIRECT_URI=http://localhost:3000/api/auth/callback
   NEXT_PUBLIC_BASE_URL=http://localhost:3000
   ```

3. Firestore 用の Application Default Credentials を設定（どちらか）
   - `gcloud auth application-default login`
   - または `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`

4. 開発サーバー起動
   ```bash
   npm run dev
   ```

---

## 本番（Firebase App Hosting + Secret Manager）

必須環境変数（Secret Manager 含む）:
- `APP_SESSION_SECRET`（Secret）
- `SGGCS`（Secret）
- `SGGCID`
- `SGGOASCP`
- `STARTGG_REDIRECT_URI`
- `NEXT_PUBLIC_BASE_URL`

`apphosting.yaml` サンプルはリポジトリの `apphosting.yaml` を参照してください。

---

## 運用方針

- Firestore はクライアントから直接読まず、サーバー（Admin SDK）経由のみでアクセスします。
- リアルタイム参加者一覧は SSE (`/api/tournaments/{tournamentId}/participants/stream`) で配信します。
- 認証状態の真実源は署名付き `app_session` Cookie です。
- access code は平文保存せず、`codeHash` のみを保存・照合します。
- CSV import は未掲載参加者を即時削除せず、欠落候補としてマークします。
- 座席の真実源は `tournaments/{tournamentId}/seats/{seatLabel}` です。
- Firestore Rules は **Firebase / GCP コンソールから手動設定**してください（このリポジトリでは rules ファイル配布・deploy 手順は扱いません）。

---

## 主要API

- `GET /api/auth/session`
- `POST /api/operator/session`
- `GET /api/tournaments/{tournamentId}/participants`
- `GET /api/tournaments/{tournamentId}/participants/stream`
- `POST /api/tournaments/{tournamentId}/participants`
- `POST /api/tournaments/{tournamentId}/participants/{participantId}/checkin`
- `PATCH /api/tournaments/{tournamentId}/participants/{participantId}`
- `POST /api/tournaments/{tournamentId}/seat-assignment/assign`
