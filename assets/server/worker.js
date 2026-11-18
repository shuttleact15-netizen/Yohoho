import { DurableObject } from 'cloudflare:workers';

/* ============================================================
   ヨーホーホー オンライン対戦サーバー
   Cloudflare Workers + Durable Objects（JavaScript）

   役割：
     ・Worker …… 入口。URL /room/<ルームコード> を、コードごとの
                  Durable Object に振り分けるだけ。
     ・Room(DO) … 部屋1つにつき1つのオブジェクトが、
                  メンバー管理（入室・退室・キャラ選択・ホスト判定）と
                  状態同期メッセージの中継を担当する。
                  バトルの進行計算はホストの端末が行い、このサーバーは
                  入力（ゲスト→ホスト）とスナップショット（ホスト→全員）を
                  中継する。だからサーバーは軽く、無料枠で十分まかなえる。

   通信プロトコル（全部 JSON、WebSocket）：
     接続: wss://<worker>/room/<CODE>?action=create|join
     C→S : hello {name,charId,vera,outfit,outfitDark} … 自己紹介（キャラ情報）
           char  {charId,vera,outfit,outfitDark}      … 待機中にキャラ変更
           in    {mx,my,holding}                        … ゲストの操作（ホストへ中継）
           needStart {}                                  … ゲスト→開始合図の再送要求（サーバーが保存済みの start を本人だけに送り返す）
           start {…バトル初期データ}                    … ホスト→開始合図（全員へ。サーバーが保存し、取りこぼしたゲストへ再送できる）
           snap  {…状態スナップショット}                … ホスト→全員（約20回/秒）
           death {slot,place} / end {winner,places}     … ホスト→全員
           feed  {text}                                 … ホスト→全員（撃破ログ）
     S→C : welcome {slot,code,host}                      … 接続受理
           roster  {members:[{slot,name,charId,vera,outfit,outfitDark,host,connected}]}
           left    {slot}                                 … ゲスト退室（ホストがBOT引き継ぎに使う）
           hostLeft {}                                    … ホスト退室（部屋は解散）
           error   {msg}                                  … 入室不可など
   ============================================================ */

const MAX_MEMBERS = 8; /* ホスト＋ゲスト7人まで（バトルはBOT込みで10人） */

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.members = new Map(); /* slot -> {ws, name, charId, vera, outfit, outfitDark, host} */
    this.hostSlot = -1;
    this.nextSlot = 1;
    this.phase = 'waiting'; /* 'waiting' | 'playing' */
    this.lastStart = null; /* 直近の開始合図（start メッセージ丸ごと）。取りこぼしたゲストへの再送用 */
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket で接続してください', { status: 426 });
    }
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (action === 'create') {
      if (this.hostSlot >= 0) {
        server.send(JSON.stringify({ t: 'error', msg: 'そのルームコードは使用中です。別のコードで作り直してください' }));
        server.close(1008, 'room taken');
        return new Response(null, { status: 101, webSocket: client });
      }
      const slot = 0;
      this.hostSlot = 0;
      this.nextSlot = 1;
      this.addMember(server, slot, true);
      server.send(JSON.stringify({ t: 'welcome', slot, host: true }));
    } else if (action === 'join') {
      if (this.hostSlot < 0) {
        server.send(JSON.stringify({ t: 'error', msg: '部屋が見つかりません。ルームコードを確認してください' }));
        server.close(1008, 'no room');
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.phase === 'playing') {
        server.send(JSON.stringify({ t: 'error', msg: 'その部屋はバトル中です。終わるまで待ってね' }));
        server.close(1008, 'playing');
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.members.size >= MAX_MEMBERS) {
        server.send(JSON.stringify({ t: 'error', msg: '部屋が満員です（8人まで）' }));
        server.close(1008, 'full');
        return new Response(null, { status: 101, webSocket: client });
      }
      const slot = this.nextSlot++;
      this.addMember(server, slot, false);
      server.send(JSON.stringify({ t: 'welcome', slot, host: false }));
    } else {
      server.send(JSON.stringify({ t: 'error', msg: 'action が不正です' }));
      server.close(1008, 'bad action');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.broadcastRoster();
    return new Response(null, { status: 101, webSocket: client });
  }

  addMember(ws, slot, host) {
    const m = { ws, slot, host, name: host ? 'ホスト' : 'ゲスト', charId: 'jack', vera: 'spiral', outfit: null, outfitDark: null };
    this.members.set(slot, m);
    ws.addEventListener('message', (ev) => this.onMessage(m, ev));
    ws.addEventListener('close', () => this.onClose(m));
    ws.addEventListener('error', () => this.onClose(m));
  }

  memberList() {
    return [...this.members.values()].map((m) => ({
      slot: m.slot, name: m.name, charId: m.charId, vera: m.vera,
      outfit: m.outfit, outfitDark: m.outfitDark, host: m.host, connected: true,
    }));
  }

  broadcast(obj, exceptSlot) {
    const s = JSON.stringify(obj);
    for (const m of this.members.values()) {
      if (m.slot === exceptSlot) continue;
      try { m.ws.send(s); } catch (_) { /* 切断済みは無視 */ }
    }
  }

  broadcastRoster() {
    /* phase も一緒に送る：ゲストは「サーバーはバトル中なのに自分は待機室」
       という取りこぼし状態に気づいて、開始合図をもらい直せる */
    this.broadcast({ t: 'roster', members: this.memberList(), phase: this.phase });
  }

  sendTo(slot, obj) {
    const m = this.members.get(slot);
    if (m) { try { m.ws.send(JSON.stringify(obj)); } catch (_) { } }
  }

  onMessage(m, ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'hello':
      case 'char': {
        if (typeof msg.name === 'string' && msg.name) m.name = msg.name.slice(0, 12);
        if (typeof msg.charId === 'string') m.charId = msg.charId.slice(0, 24);
        if (msg.vera === 'spiral' || msg.vera === 'shot') m.vera = msg.vera;
        if (typeof msg.outfit === 'string') m.outfit = msg.outfit;
        if (typeof msg.outfitDark === 'string') m.outfitDark = msg.outfitDark;
        this.broadcastRoster();
        /* バトル中に（再）接続してきたゲストには、保存済みの開始合図を送って合流させる */
        if (!m.host && this.phase === 'playing' && this.lastStart) this.sendTo(m.slot, this.lastStart);
        break;
      }
      case 'needStart': {
        /* 開始合図を取りこぼしたゲストへ、保存済みの合図を本人だけに送り返す */
        if (!m.host && this.phase === 'playing' && this.lastStart) this.sendTo(m.slot, this.lastStart);
        break;
      }
      case 'in': {
        /* ゲストの操作はホストへだけ中継する（スロット番号を付けて） */
        if (!m.host) this.sendTo(this.hostSlot, { t: 'in', slot: m.slot, mx: msg.mx || 0, my: msg.my || 0, holding: !!msg.holding });
        break;
      }
      case 'start': {
        if (m.host) { this.phase = 'playing'; this.lastStart = msg; this.broadcast(msg, m.slot); }
        break;
      }
      case 'snap': case 'death': case 'feed': {
        if (m.host) this.broadcast(msg, m.slot);
        break;
      }
      case 'end': {
        if (m.host) { this.phase = 'waiting'; this.lastStart = null; this.broadcast(msg, m.slot); }
        break;
      }
    }
  }

  onClose(m) {
    if (!this.members.has(m.slot)) return;
    this.members.delete(m.slot);
    if (m.host) {
      /* ホストが抜けたら部屋は解散（バトルの進行役がいなくなるため）。
         残っているゲストへ知らせてから接続を閉じる */
      this.hostSlot = -1;
      this.phase = 'waiting';
      this.lastStart = null;
      this.nextSlot = 1;
      const rest = [...this.members.values()];
      this.members.clear();
      for (const g of rest) {
        try { g.ws.send(JSON.stringify({ t: 'hostLeft' })); } catch (_) { }
        try { g.ws.close(1000, 'host left'); } catch (_) { }
      }
    } else {
      /* ゲスト退室：ホストへ知らせる（そのキャラはBOTが引き継ぐ）と、
         待機中なら名簿を更新する */
      this.sendTo(this.hostSlot, { t: 'left', slot: m.slot });
      this.broadcastRoster();
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('yohoho-online: OK（対戦サーバーは動いています）', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{4,10})$/);
    if (!m) return new Response('not found', { status: 404 });
    const id = env.ROOM.idFromName(m[1].toUpperCase());
    return env.ROOM.get(id).fetch(req);
  },
};
