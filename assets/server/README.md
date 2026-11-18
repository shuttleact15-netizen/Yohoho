# オンライン対戦サーバー（Cloudflare Workers + Durable Objects）

友達とオンライン対戦するためのサーバーです。言語はゲーム本体と同じ **JavaScript** で、
**無料枠**（Workers Free プラン）で始められます。

## 仕組み

- **Worker** が入口で、URL の `/room/<ルームコード>` を部屋ごとの **Durable Object** に振り分けます。
- **Durable Object（Room）** が部屋を預かります：メンバーの入室・退室、キャラ選択、
  ホスト判定、そして状態同期メッセージの中継です。
- バトルの進行計算（当たり判定など）は **ホストの端末** が担当し、約20回/秒の
  スナップショットをサーバー経由で全員に配ります。ゲストの操作はサーバー経由で
  ホストへ届きます。サーバー側は中継だけなので軽く、無料枠に収まりやすい設計です。
- 注意：ホストが抜けると、その試合は終了します（進行役がいなくなるため）。
  待機室に戻れば、別の人が部屋を作り直して再戦できます。

## デプロイ手順（初回だけ・10分くらい）

### 方法A：Cloudflare の画面から（コマンド不要）

1. Cloudflare ダッシュボード → **Workers & Pages** → **Create** → **Worker** で
   ワーカーを新規作成（名前は `yohoho-online` など）。
2. 作成後 **Edit code** を開き、デフォルトのコードを全部消して、
   このフォルダの **worker.js** の中身を貼り付けて **Deploy**。
3. ワーカーの **Settings → Bindings** で Durable Object バインディングを追加：
   - Variable name: `ROOM`
   - Class name: `Room`
   - （SQLite-backed を選ぶ）
4. もう一度 **Deploy** すれば完了。ワーカーの URL
   （例：`https://yohoho-online.<あなた>.workers.dev`）を控えておく。

### 方法B：コマンド（Wrangler）

```bash
npm install -g wrangler
wrangler login
# worker.js と wrangler.toml を置いたフォルダで：
wrangler deploy
```

表示された `https://yohoho-online.<あなた>.workers.dev` がサーバーの URL です。

## ゲーム側の設定

1. ゲームを開いて、ロビーの **🌐 オンライン** 部屋へ。
2. 「サーバーURL」に上の URL を貼って **保存**。
3. **部屋を作る** → ルームコード（6文字）が表示されるので友達に伝える。
4. 友達は同じくオンライン部屋で URL を設定し、**部屋に入る** にコードを入れる。
5. ホストが **バトル開始** を押すと全員で対戦開始。人数が10人に満たない分は BOT が入ります。

## 無料枠について

- Workers Free：リクエスト 10万回/日。WebSocket の接続は1回として数えられ、
  接続中のメッセージ中継はリクエストに数えられません。
- Durable Objects（SQLite）は Free プランでも利用できます（保存容量などの上限あり）。
- 友達同士で遊ぶ規模なら無料枠で十分です。たくさんの人が長時間遊ぶようになると
  上限に達する可能性があります。

## ファイル

| ファイル | 役割 |
|---|---|
| `worker.js` | Worker 本体＋ Durable Object（Room クラス） |
| `wrangler.toml` | Wrangler 用の設定（バインディングとマイグレーション） |
