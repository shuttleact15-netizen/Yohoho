/* ============================================================
   オンライン対戦：assets/js/net.js
   Cloudflare Workers + Durable Objects の対戦サーバー
   （assets/server/worker.js）につないで、離れた友達と対戦する。

   仕組み：
     ・サーバー（Durable Object）が部屋・メンバー・進行を管理し、
       メッセージを中継する。
     ・バトルの計算はホストの端末が担当する（既存の game.js の
       シミュレーションをそのまま使う）。ホストは約20回/秒で
       スナップショットを全員に配り、ゲストはそれを補間して描く。
     ・ゲストの操作（移動・長押し）はサーバー経由でホストへ届き、
       ホスト側では netApplyRemoteInput() が実体を動かす。
     ・足りない人数はBOTが埋める（ホスト側で生成）。
     ・ゲストが抜けたら、そのキャラはBOTが引き継ぐ。
       ホストが抜けたら試合は終了する（進行役がいなくなるため）。

   game.js 側の共有フラグ（game.js で宣言）：
     netGuestMode / netHostSimMode / netOnlineMode / netMyPlace
   ============================================================ */
let netWs = null, netRole = null, netCode = '', netMySlot = -1;
let netMembers = [];
let netBattle = false, netFinalized = false, netPlaces = {}, netEndShown = false;
let netEntOrder = [], netSlotEnt = new Map(), netPrevAlive = new Set();
let netBulletSeq = 1;
let netSnapTimer = null, netInputTimer = null, netGuestRaf = 0;
let netSnapPrev = new Map(), netSnapCurr = new Map();
let netBulPrev = new Map(), netBulCurr = new Map();
let netSnapAlive = TOTAL_PLAYERS, netSnapElapsed = 0;
let netIntentionalClose = false;
let netBattleStartAt = 0; /* 今のバトルの startAt（開始合図の再送を重複扱いにするための目印） */
let netLastConnect = null; /* 最後の接続先 {action, code}（再接続ボタン用） */
let netDisconnected = false; /* 本当に切断を検知したときだけ true（誤表示防止） */

const NET_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }
function netEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function netCharDefById(id) { return CHARS.find((c) => c.id === id) || CHARS[0]; }

/* ---------- サーバーURL（この端末にだけ保存する設定） ---------- */
function netServerBase() { try { return (localStorage.getItem('yohohoServerUrl') || '').trim().replace(/\/+$/, ''); } catch (_) { return ''; } }
function netSaveServerUrl(u) { try { localStorage.setItem('yohohoServerUrl', u); } catch (_) { } }
function netWsUrl(code, action) { return netServerBase().replace(/^http/, 'ws') + '/room/' + code + '?action=' + action; }

/* ---------- 画面（オンライン部屋）の出し分け ---------- */
function netSetStatus(txt, kind) { const el = document.getElementById('netStatus'); if (el) { el.textContent = txt; el.className = 'net-status' + (kind ? ' ' + kind : ''); } netSyncReconnectBtn(); }
function netSyncReconnectBtn() { const b = document.getElementById('netReconnectBtn'); if (b) b.classList.toggle('hidden', !(netDisconnected && netLastConnect && !netWs)); }
function netIsConnected() { return !!(netWs && netWs.readyState === 1); }
function netShowView(v) { ['netSetupView', 'netWaitView'].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', id !== v); }); }

/* ---------- 自分の参加情報 ---------- */
function netMyCharId() { const sel = document.getElementById('netCharSel'); return (sel && sel.value) || CHARS[selected].id; }
function netMyVera() { const sel = document.getElementById('netVeraSel'); return (sel && sel.value) || veraMode; }
function netMyName() { const inp = document.getElementById('netNameInput'); const v = inp ? inp.value.trim() : ''; return v || 'プレイヤー'; }
function netMyHello(t) { const c = netCharDefById(netMyCharId()); return { t: t || 'hello', name: netMyName(), charId: c.id, vera: netMyVera(), outfit: c.outfit, outfitDark: c.outfitDark }; }
function netSendCharUpdate() { if (netWs && netWs.readyState === 1) netSend(netMyHello('char')); }

/* ---------- 接続 ---------- */
function netSend(obj) { if (netWs && netWs.readyState === 1) { try { netWs.send(JSON.stringify(obj)); } catch (_) { } } }
function netGenCode() { let s = ''; for (let i = 0; i < 6; i++) s += NET_CODE_CHARS[Math.floor(Math.random() * NET_CODE_CHARS.length)]; return s; }
function netConnect(action, code) {
  if (!netServerBase()) { netSetStatus('先にサーバーURLを保存してね。下の「サーバーの用意（初回だけ）」に手順があるよ', 'err'); return; }
  netCloseSocket();
  netLastConnect = { action, code };
  netDisconnected = false;
  netRole = action === 'create' ? 'host' : 'guest'; netCode = code; netMySlot = -1; netMembers = [];
  netSetStatus('サーバーに接続中…');
  let ws;
  try { ws = new WebSocket(netWsUrl(code, action)); } catch (e) { netSetStatus('接続できませんでした。サーバーURLを確認してね', 'err'); netRole = null; return; }
  netWs = ws;
  ws.onopen = () => { netSend(netMyHello('hello')); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } netOnMessage(m); };
  ws.onclose = () => { if (netWs === ws) { netWs = null; netOnSocketClosed(); } };
  ws.onerror = () => { netSetStatus('接続エラー。サーバーURLと、サーバーのデプロイを確認してね', 'err'); };
}
function netCloseSocket() { if (netWs) { netIntentionalClose = true; try { netWs.close(); } catch (_) { } netWs = null; } }
function netOnSocketClosed() {
  if (netIntentionalClose) { netIntentionalClose = false; return; }
  /* 誤検知防止：別ソケットが生きていて接続が続いているなら、切断表示は出さない */
  if (netIsConnected()) { netDisconnected = false; netSyncReconnectBtn(); return; }
  const wasBattle = netBattle;
  netDisconnected = true;
  netBattle = false; netGuestMode = false; netHostSimMode = false; netOnlineMode = false; netMyPlace = 0;
  netStopGuestLoops(); netStopSnapTimer(); netRestoreBattleButtons();
  netRole = null; netMembers = [];
  if (wasBattle || state === 'playing' || state === 'countdown' || state === 'ended') backToLobby();
  showRoom('online'); netShowView('netSetupView');
  netSetStatus('接続が切れました。下の「再接続する」ボタンでもう一度つなげます', 'err');
}
/* 切断からの再接続：前回と同じ部屋（同じコード・同じ役割）につなぎ直す */
function netReconnect() {
  if (!netLastConnect) { netSetStatus('つなぎ直す部屋がありません。「部屋を作る／部屋に入る」からつないでね', 'err'); return; }
  netConnect(netLastConnect.action, netLastConnect.code);
}
function netOnHostLeft() {
  const wasBattle = netBattle;
  netBattle = false; netGuestMode = false; netHostSimMode = false; netOnlineMode = false; netMyPlace = 0;
  netStopGuestLoops(); netStopSnapTimer(); netRestoreBattleButtons();
  netRole = null; netMembers = []; netWs = null;
  if (wasBattle || state === 'playing' || state === 'countdown' || state === 'ended') backToLobby();
  showRoom('online'); netShowView('netSetupView');
  netSetStatus('ホストが退出したので、部屋は解散しました', 'err');
}

function netOnMessage(m) {
  /* メッセージが届いている＝接続は生きている。古い切断表示が残っていたら消す */
  if (netDisconnected && netIsConnected()) {
    netDisconnected = false; netSyncReconnectBtn();
    const st = document.getElementById('netStatus');
    if (st && st.classList.contains('err') && /接続が切れました/.test(st.textContent)) netSetStatus('接続中です', 'ok');
  }
  switch (m.t) {
    case 'welcome':
      netMySlot = m.slot; if (m.host) netRole = 'host';
      netDisconnected = false;
      netShowView('netWaitView'); netRenderWait();
      netSetStatus(netRole === 'host' ? '部屋を作りました！ルームコードを友達に伝えてね' : '部屋に入りました！ホストがバトルを開始するのを待ってね', 'ok');
      break;
    case 'error':
      netSetStatus(m.msg || 'エラーが起きました', 'err');
      netCloseSocket(); netRole = null; netShowView('netSetupView');
      break;
    case 'roster':
      netMembers = m.members || []; netRenderWait();
      /* サーバーはバトル中なのに自分は開始合図を取りこぼしていたら、合図をもらい直す */
      if (m.phase === 'playing' && netRole === 'guest' && !netBattle) netSend({ t: 'needStart' });
      break;
    case 'in': if (netRole === 'host') netOnRemoteInput(m); break;
    case 'left': if (netRole === 'host') netOnGuestLeft(m.slot); break;
    case 'start': if (netRole === 'guest') netGuestStart(m); break;
    case 'snap': if (netRole === 'guest') netGuestSnap(m); break;
    case 'feed': feed(m.text); break;
    case 'death': if (netRole === 'guest') netGuestDeath(m); break;
    case 'end': if (netRole === 'guest') netGuestEnd(m); break;
    case 'hostLeft': netOnHostLeft(); break;
  }
}

/* ---------- 待機室の表示 ---------- */
function netRenderWait() {
  const codeEl = document.getElementById('netRoomCode'); if (codeEl) codeEl.textContent = netCode || '------';
  const list = document.getElementById('netMemberList'); if (!list) return;
  list.innerHTML = '';
  netMembers.forEach((mb) => {
    const c = netCharDefById(mb.charId);
    const row = document.createElement('div');
    row.className = 'net-member' + (mb.slot === netMySlot ? ' me' : '');
    row.innerHTML = '<span class="net-member-emoji">' + c.emoji + '</span>' +
      '<span class="net-member-name">' + netEsc(mb.name) + (mb.slot === netMySlot ? '（あなた）' : '') + '</span>' +
      '<span class="net-member-char">' + netEsc(c.name) + (c.type === 'fire' ? (mb.vera === 'shot' ? ' 🔥ショット型' : ' 🌀螺旋型') : '') + '</span>' +
      (mb.host ? '<span class="net-host-badge">ホスト</span>' : '');
    list.appendChild(row);
  });
  const cnt = document.getElementById('netMemberCount');
  if (cnt) cnt.textContent = '参加 ' + netMembers.length + '人 ＋ BOT ' + Math.max(0, TOTAL_PLAYERS - netMembers.length) + '人 で ' + TOTAL_PLAYERS + '人バトル';
  const startBtn = document.getElementById('netStartBtn'); if (startBtn) startBtn.classList.toggle('hidden', netRole !== 'host');
  const note = document.getElementById('netGuestWaitNote'); if (note) note.classList.toggle('hidden', netRole === 'host');
}

/* ---------- バトル画面の共通セットアップ（startGame のオンライン版） ---------- */
function netSetupBattleScreen(pc, stage) {
  cam.x = Math.max(0, Math.min(WORLD - W, player.x - W / 2)); cam.y = Math.max(0, Math.min(WORLD - H, player.y - H / 2));
  if (W >= WORLD) cam.x = (WORLD - W) / 2; if (H >= WORLD) cam.y = (WORLD - H) / 2;
  document.getElementById('startScreen').classList.add('hidden');
  stopVictoryFx();
  document.getElementById('endScreen').classList.add('hidden');
  document.getElementById('topbar').classList.remove('hidden');
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('pname').textContent = pc.emoji + ' ' + pc.name;
  document.getElementById('aliveUI').textContent = TOTAL_PLAYERS;
  const ac0 = document.getElementById('aliveChip'); if (ac0) ac0.classList.remove('is-danger');
  document.getElementById('killUI').textContent = '0';
  const sp = document.getElementById('stagePill'); if (sp) sp.textContent = stage.icon + ' ' + stage.name;
  const tch = document.getElementById('touch'); if (tch) tch.classList.remove('no-attack');
  const cd = document.getElementById('countdown');
  if (cd) {
    document.getElementById('cdStage').textContent = stage.icon + ' ステージ：' + stage.name;
    document.getElementById('cdChar').textContent = pc.emoji + ' ' + pc.name + (pc.type === 'fire' ? '（' + veraModeInfo(veraModeOf(player)).name + '）' : '') + ' で出航！';
    document.getElementById('cdTip').textContent = stage.tip;
    cd.classList.remove('hidden');
  }
  /* 結果画面の「もう一度遊ぶ」は、オンライン中は「待機室に戻る」に差し替える */
  const ab = document.getElementById('againBtn'); if (ab) { ab.textContent = '🌐 待機室に戻る'; ab.onclick = netReturnToRoom; }
}
function netRestoreBattleButtons() {
  const ab = document.getElementById('againBtn'); if (ab) { ab.textContent = '🔁 もう一度遊ぶ'; ab.onclick = startGame; }
}
function netCleanupBattle() {
  netEntOrder = []; netSlotEnt = new Map(); netPrevAlive = new Set(); netPlaces = {};
  netSnapPrev.clear(); netSnapCurr.clear(); netBulPrev.clear(); netBulCurr.clear();
  netSnapAlive = TOTAL_PLAYERS; netSnapElapsed = 0;
}

/* 結果画面／上バーから待機室へ戻る。ホストで試合がまだ続いている場合は、
   ゲストのためにシミュレーションと配信だけ裏で続ける */
function netReturnToRoom() {
  const hostSimContinues = netRole === 'host' && netBattle && !netFinalized;
  if (netRole === 'guest') netSend({ t: 'in', mx: 0, my: 0, holding: false }); /* 抜けた後も長押しが残らないように */
  netGuestMode = false; netOnlineMode = false; netMyPlace = 0;
  netStopGuestLoops();
  if (!hostSimContinues) { netBattle = false; netHostSimMode = false; netStopSnapTimer(); }
  backToLobby();
  netRestoreBattleButtons();
  showRoom('online');
  netShowView(netWs ? 'netWaitView' : 'netSetupView');
  netRenderWait();
  /* バトル後に戻っただけでは切断していない：接続が生きているのに
     古い「接続が切れました」表示が残っていたら消して、正しい状態を示す */
  if (netIsConnected()) {
    netDisconnected = false; netSyncReconnectBtn();
    const st = document.getElementById('netStatus');
    if (!hostSimContinues && st && /接続が切れました/.test(st.textContent)) netSetStatus('待機室に戻りました（接続中）', 'ok');
  }
  if (hostSimContinues) netSetStatus('バトルは裏で続いています（ホストとして進行中）。終わると次のバトルを始められます', 'ok');
}
function netLeaveRoom() {
  if (netRole === 'guest') netSend({ t: 'in', mx: 0, my: 0, holding: false });
  netCloseSocket();
  netBattle = false; netGuestMode = false; netHostSimMode = false; netOnlineMode = false; netMyPlace = 0;
  netStopGuestLoops(); netStopSnapTimer(); netRestoreBattleButtons();
  netRole = null; netCode = ''; netMembers = [];
  netShowView('netSetupView');
  netSetStatus('部屋を出ました');
  showRoom('lobby');
}

/* ============================================================
   ホスト側：バトルの生成とスナップショット配信
   ============================================================ */
function netHostStart() {
  if (netRole !== 'host' || netBattle || !netWs) return;
  const members = netMembers.slice();
  if (!members.length) { netSetStatus('メンバー情報の受信を待ってね', 'err'); return; }
  netCleanupBattle();
  netBattle = true; netFinalized = false; netEndShown = false; netMyPlace = 0;
  netOnlineMode = true; netGuestMode = false; netHostSimMode = true;
  entities = []; bullets = []; particles = []; cubes = []; crates = []; floaters = [];
  zone = { x: WORLD / 2, y: WORLD / 2, r: 720, targetR: 720 };
  currentStage = pickStage();
  const spawns = [{ x: WORLD / 2 + rand(-80, 80), y: WORLD / 2 + rand(-80, 80) }];
  for (let i = 0; i < BOT_COUNT; i++) { const a = i / BOT_COUNT * Math.PI * 2; spawns.push({ x: WORLD / 2 + Math.cos(a) * 480, y: WORLD / 2 + Math.sin(a) * 480 }); }
  generateStageLayout(currentStage, spawns);
  const pc = CHARS[selected];
  player = makeEntity(pc, spawns[0].x, spawns[0].y, true, 'あなた');
  player.netSlot = 0;
  entities.push(player);
  const entDescs = [{ slot: 0, charId: pc.id, name: netMyName(), vera: veraModeOf(player), skin: player.skin, outfit: pc.outfit, outfitDark: pc.outfitDark, x: r1(player.x), y: r1(player.y), bot: false }];
  const guests = members.filter((m) => !m.host);
  guests.forEach((m, gi) => {
    const def = netCharDefById(m.charId);
    const effDef = (m.outfit || m.outfitDark) ? Object.assign({}, def, { outfit: m.outfit || def.outfit, outfitDark: m.outfitDark || def.outfitDark }) : def;
    const e = makeEntity(effDef, spawns[gi + 1].x, spawns[gi + 1].y, false, m.name, m.vera);
    e.netRemote = true; e.netSlot = m.slot; e.netInput = { mx: 0, my: 0, holding: false }; e.skin = def.skin;
    entities.push(e);
    entDescs.push({ slot: m.slot, charId: def.id, name: m.name, vera: veraModeOf(e), skin: e.skin, outfit: effDef.outfit, outfitDark: effDef.outfitDark, x: r1(e.x), y: r1(e.y), bot: false });
  });
  const botCount = TOTAL_PLAYERS - 1 - guests.length;
  for (let i = 0; i < botCount; i++) {
    const c = CHARS[Math.floor(Math.random() * CHARS.length)];
    const e = makeEntity(c, spawns[guests.length + 1 + i].x, spawns[guests.length + 1 + i].y, false, BOT_NAMES[(guests.length + i) % BOT_NAMES.length]);
    e.netSlot = 100 + i;
    entities.push(e);
    entDescs.push({ slot: 100 + i, charId: c.id, name: e.name, vera: veraModeOf(e), skin: e.skin, outfit: c.outfit, outfitDark: c.outfitDark, x: r1(e.x), y: r1(e.y), bot: true });
  }
  winScheduled = false;
  for (let i = 0; i < 10; i++) { const s = stageSpot(spawns, 100, 600, 50); if (s) cubes.push({ x: s.x, y: s.y, r: 11 }); }
  netEntOrder = entities.slice();
  netSlotEnt = new Map(); entities.forEach((e) => netSlotEnt.set(e.netSlot, e));
  netPrevAlive = new Set(entities.filter((e) => e.alive).map((e) => e.netSlot));
  const layout = {
    obstacles: obstacles.map((o) => ({ x: r1(o.x), y: r1(o.y), r: o.r, type: o.type })),
    hazards: hazards.map((h) => ({ x: r1(h.x), y: r1(h.y), r: h.r, type: h.type })),
    decors: decors.map((d) => ({ x: r1(d.x), y: r1(d.y), r: d.r, type: d.type })),
    crates: crates.map((c) => ({ x: r1(c.x), y: r1(c.y) })),
    cubes: cubes.map((c) => ({ x: r1(c.x), y: r1(c.y) })),
  };
  const startMsg = { t: 'start', stage: currentStage.id, layout, ents: entDescs, startAt: Date.now() + COUNTDOWN_MS };
  netBattleStartAt = startMsg.startAt;
  netSend(startMsg);
  /* 開始合図の取りこぼし対策：同じ合図（同じ startAt）を少し間を空けて
     もう2回送る。受け取ったゲストは startAt で重複を見分けて無視するので、
     最初の1通が届かなかったゲストもここで必ず始められる */
  [800, 1800].forEach((ms) => setTimeout(() => { if (netBattle && netBattleStartAt === startMsg.startAt) netSend(startMsg); }, ms));
  netSetupBattleScreen(pc, currentStage);
  state = 'countdown'; elapsed = 0;
  countdownEndsAt = performance.now() + COUNTDOWN_MS; cdShown = '';
  armCountdownWatchdog();
  netStartSnapTimer();
  feed('🌐 オンライン対戦！ 友達 ' + members.length + '人 ＋ BOT ' + botCount + '人でバトル開始');
}

function netStartSnapTimer() { netStopSnapTimer(); netSnapTimer = setInterval(netHostSnapTick, 50); }
function netStopSnapTimer() { if (netSnapTimer) { clearInterval(netSnapTimer); netSnapTimer = null; } }

function netHostSnapTick() {
  if (!netBattle || netRole !== 'host') { netStopSnapTimer(); return; }
  /* 死亡の検出と順位の確定（倒れた順に、残り人数がその人の順位） */
  const aliveEnts = entities.filter((e) => e.alive);
  const aliveSet = new Set(aliveEnts.map((e) => e.netSlot));
  const newlyDead = [...netPrevAlive].filter((s) => !aliveSet.has(s));
  let placeBase = netPrevAlive.size;
  newlyDead.forEach((slot) => {
    const place = placeBase--;
    netPlaces[slot] = place;
    if (slot === 0) netMyPlace = place; else netSend({ t: 'death', slot, place });
  });
  netPrevAlive = aliveSet;
  /* 終了判定：残り1人になったら全員に結果を知らせて配信を止める */
  if (!netFinalized && aliveEnts.length <= 1) {
    netFinalized = true;
    if (aliveEnts.length === 1) netPlaces[aliveEnts[0].netSlot] = 1;
    netSend({ t: 'end', winner: aliveEnts.length ? aliveEnts[0].netSlot : -1, places: netPlaces });
    netBattle = false; netHostSimMode = false;
    netStopSnapTimer();
    if (state === 'playing') { if (netPlaces[0]) netMyPlace = netPlaces[0]; endGame(); }
    netRenderWait();
    return;
  }
  /* カウントダウン中は送らない。ただしホストが待機室に戻った後も裏で進行中
     （netHostSimMode）のときは、ゲストのために送り続ける */
  if (state !== 'playing' && state !== 'ended' && !netHostSimMode) return;
  const rows = netEntOrder.map((e) => [r1(e.x), r1(e.y), r2(e.angle), Math.round(e.hp), e.alive ? 1 : 0, e.power, e.ammo, e.holding ? 1 : 0, r2(e.chargeT), r2(e.swing || 0), r2(e.kickT || 0), r2(e.dashT || 0), r2(e.tpT || 0), e.tpPhase === 'sink' ? 1 : (e.tpPhase === 'emerge' ? 2 : 0), r1(e.tpX || 0), r1(e.tpY || 0), r2(e.flameAngle || 0), r2(e.breathFuel || 0), e.breathOver ? 1 : 0, r2(e.ghostFuel || 0), e.ghostOver ? 1 : 0, e.isRegen ? 1 : 0, e.kills, r1(e.vx || 0), r1(e.vy || 0), r2(e.reloadT || 0), r2(e.hitFlash || 0), r2(e.kickDir || 0), r2(e.dashDir || 0), r2(e.bob || 0), r2(e.lastCombat || 0)]);
  const bul = bullets.map((b) => { if (b.netId == null) b.netId = netBulletSeq++; return [b.netId, b.type, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.r, b.phase || 0, b.color]; });
  const cr = crates.map((c) => [c.alive ? 1 : 0, Math.round(c.hp)]);
  const cb = []; cubes.forEach((c) => { cb.push(r1(c.x), r1(c.y)); });
  netSend({ t: 'snap', e: r1(elapsed), a: aliveEnts.length, z: r1(zone.r), ents: rows, bul, cr, cb });
}

/* ゲストの操作を受け取る／実体へ反映する（game.js の update から呼ばれる） */
function netOnRemoteInput(m) { const e = netSlotEnt.get(m.slot); if (e && e.netRemote) e.netInput = { mx: m.mx || 0, my: m.my || 0, holding: !!m.holding }; }
function netOnGuestLeft(slot) {
  const e = netSlotEnt.get(slot);
  if (e && e.netRemote) { e.netRemote = false; e.holding = false; feed('📴 ' + e.name + ' の接続が切れたので、BOTが引き継ぎます'); }
  const mb = netMembers.find((x) => x.slot === slot); if (mb) mb.connected = false;
}
function netApplyRemoteInput(e, dt) {
  const inp = e.netInput || { mx: 0, my: 0, holding: false };
  /* 長押しの開始／終了はプレイヤー操作（beginHold/endHold）と同じ意味 */
  if (inp.holding && !e.holding) {
    e.holding = true; e.chargeT = 0;
    if (e.char.type === 'breath') e.breathTickT = Math.max(e.breathTickT || 0, e.char.breathTick || 0.11);
  } else if (!inp.holding && e.holding) {
    e.holding = false; netReleaseCharge(e);
  }
  let mx = inp.mx || 0, my = inp.my || 0;
  const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
  const holdF = noChargeSlow(e) ? 1 : (e.char.id === 'captain' ? 0.65 : 0.45);
  const spdF = e.char.type === 'breath' ? (isBreathing(e) ? 0.7 : 1) : (e.holding ? holdF : 1);
  const spd = e.char.speed * spdF * (onIce(e) ? 1.3 : 1);
  e.vx = mx * spd; e.vy = my * spd;
  if (e.dashT <= 0) {
    if (Math.hypot(mx, my) > 0.1) e.angle = Math.atan2(my, mx);
    if (e.holding && e.char.type !== 'scythe') { const t = autoAimTarget(e, chargeSearchRange(e)); if (t) e.angle = angleTo(e, t); }
  }
}
/* endHold()（プレイヤー用）の実体版：離した瞬間の通常攻撃／溜め攻撃の振り分け */
function netReleaseCharge(e) {
  if (e.char.type === 'breath') { if (e.chargeT < (e.char.breathTick || 0.11)) attack(e, autoAimAngle(e)); e.chargeT = 0; return; }
  if (e.char.id === 'captain') { if (e.chargeT < e.char.chargeTime) attack(e, autoAimAngle(e)); e.chargeT = 0; return; }
  const full = e.chargeT >= e.char.chargeTime;
  if (e.char.type === 'fire') {
    if (veraModeOf(e) === 'spiral') { if (full) chargeAttack(e, autoAimAngle(e, chargeSearchRange(e))); }
    else if (!full) attack(e, autoAimAngle(e));
    e.chargeT = 0; return;
  }
  if (full) chargeAttack(e, autoAimAngle(e, chargeSearchRange(e))); else attack(e, autoAimAngle(e));
  e.chargeT = 0;
}
/* 撃破ログだけをゲストにも流す（ホスト本人の細かい通知は流さない） */
const netOrigFeed = feed;
feed = function (t) {
  netOrigFeed(t);
  if (netBattle && netRole === 'host' && /が倒れた|は毒ゾーンで倒れた|はマグマに焼かれた/.test(t)) netSend({ t: 'feed', text: t });
};

/* ============================================================
   ゲスト側：開始データで世界を作り、スナップショットで同期する
   ============================================================ */
function netGuestStart(m) {
  /* 開始合図の再送・再取得で同じ合図がもう一度来たら無視する（startAt が合図の目印） */
  if (netBattle && m.startAt && m.startAt === netBattleStartAt) return;
  netBattleStartAt = m.startAt || 0;
  netCleanupBattle();
  netBattle = true; netFinalized = false; netEndShown = false; netMyPlace = 0;
  netOnlineMode = true; netGuestMode = true; netHostSimMode = false;
  const stage = STAGES.find((s) => s.id === m.stage) || STAGES[0];
  currentStage = stage;
  obstacles = m.layout.obstacles || []; hazards = m.layout.hazards || []; decors = m.layout.decors || [];
  crates = (m.layout.crates || []).map((c) => ({ x: c.x, y: c.y, hp: 400, r: 24, alive: true, flameCd: 0 }));
  cubes = (m.layout.cubes || []).map((c) => ({ x: c.x, y: c.y, r: 11 }));
  bullets = []; particles = []; floaters = [];
  zone = { x: WORLD / 2, y: WORLD / 2, r: 720, targetR: 720 };
  entities = []; netEntOrder = []; netSlotEnt = new Map();
  player = null;
  (m.ents || []).forEach((d) => {
    const def0 = netCharDefById(d.charId);
    const def = (d.outfit || d.outfitDark) ? Object.assign({}, def0, { outfit: d.outfit || def0.outfit, outfitDark: d.outfitDark || def0.outfitDark }) : def0;
    const isMe = d.slot === netMySlot;
    const e = makeEntity(def, d.x, d.y, isMe, isMe ? 'あなた' : d.name, d.vera || undefined);
    e.skin = d.skin || def.skin; e.netSlot = d.slot;
    entities.push(e); netEntOrder.push(e); netSlotEnt.set(d.slot, e);
    if (isMe) player = e;
  });
  if (!player) { netBattle = false; netGuestMode = false; netOnlineMode = false; netSetStatus('開始データに自分が含まれていませんでした', 'err'); return; }
  winScheduled = false;
  netSetupBattleScreen(player.char, stage);
  state = 'countdown'; elapsed = 0;
  /* 端末同士の時計のずれや合図の遅延で変な長さにならないよう、
     カウントダウンは最短0.4秒・最長（通常+1.2秒）に丸める */
  countdownEndsAt = performance.now() + Math.min(COUNTDOWN_MS + 1200, Math.max(400, (m.startAt || Date.now()) - Date.now())); cdShown = '';
  armCountdownWatchdog();
  netStartGuestLoops();
  feed('🌐 オンライン対戦！ ステージは「' + stage.name + '」');
}

function netGuestSnap(m) {
  if (!netBattle || !player) return;
  netSnapElapsed = m.e || 0; netSnapAlive = m.a || netSnapAlive;
  zone.r = m.z || zone.r;
  const now = performance.now();
  (m.ents || []).forEach((row, i) => {
    const e = netEntOrder[i]; if (!e) return;
    const key = e.netSlot;
    const prev = netSnapCurr.get(key);
    if (prev) netSnapPrev.set(key, { x: prev.x, y: prev.y, a: prev.a, t0: prev.t0, t1: prev.t1 });
    netSnapCurr.set(key, { x: row[0], y: row[1], a: row[2], t0: prev ? prev.t1 : now - 50, t1: now });
    const wasAlive = e.alive;
    e.hp = row[3]; e.alive = !!row[4]; e.power = row[5]; e.ammo = row[6];
    if (e !== player) { e.holding = !!row[7]; e.chargeT = row[8]; }
    e.swing = row[9]; e.kickT = row[10]; e.dashT = row[11]; e.tpT = row[12];
    e.tpPhase = row[13] === 1 ? 'sink' : (row[13] === 2 ? 'emerge' : '');
    e.tpX = row[14]; e.tpY = row[15]; e.flameAngle = row[16];
    e.breathFuel = row[17]; e.breathOver = !!row[18]; e.ghostFuel = row[19]; e.ghostOver = !!row[20];
    e.isRegen = !!row[21]; e.kills = row[22]; e.vx = row[23]; e.vy = row[24]; e.reloadT = row[25];
    e.hitFlash = row[26]; e.kickDir = row[27]; e.dashDir = row[28]; e.bob = row[29]; e.lastCombat = row[30];
    if (wasAlive && !e.alive) burst(e.x, e.y, e.char.color, 16);
  });
  const seen = new Set();
  (m.bul || []).forEach((b) => {
    seen.add(b[0]);
    const prev = netBulCurr.get(b[0]);
    if (prev) netBulPrev.set(b[0], { x: prev.x, y: prev.y, t0: prev.t0, t1: prev.t1 });
    netBulCurr.set(b[0], { id: b[0], type: b[1], x: b[2], y: b[3], vx: b[4], vy: b[5], r: b[6], phase: b[7], color: b[8], t0: prev ? prev.t1 : now - 50, t1: now });
  });
  [...netBulCurr.keys()].forEach((id) => { if (!seen.has(id)) { netBulCurr.delete(id); netBulPrev.delete(id); } });
  (m.cr || []).forEach((c, i) => { if (crates[i]) { crates[i].alive = !!c[0]; crates[i].hp = c[1]; } });
  cubes = []; for (let i = 0; i + 1 < (m.cb || []).length; i += 2) cubes.push({ x: m.cb[i], y: m.cb[i + 1], r: 11 });
}

function netGuestDeath(m) {
  if (m.slot !== netMySlot) return;
  netMyPlace = m.place;
  setTimeout(() => { if (netBattle && state === 'countdown') finishCountdown(); if (netBattle && state === 'playing') endGame(); }, 900);
}
function netGuestEnd(m) {
  netFinalized = true;
  if (m.places && m.places[netMySlot]) netMyPlace = m.places[netMySlot];
  /* カウントダウン表示のまま結果が来ても、まず開始状態へ進めてから結果を出す */
  if (netBattle && state === 'countdown') finishCountdown();
  if (netBattle && state === 'playing') endGame();
  netStopGuestLoops();
}

/* ゲストの毎フレーム処理：補間・カメラ・自分の溜め予測・HUD */
function netStartGuestLoops() {
  netStopGuestLoops();
  netInputTimer = setInterval(netGuestSendInput, 33);
  const step = () => { if (!netBattle || netRole !== 'guest') return; netGuestFrame(); netGuestRaf = requestAnimationFrame(step); };
  netGuestRaf = requestAnimationFrame(step);
}
function netStopGuestLoops() {
  if (netInputTimer) { clearInterval(netInputTimer); netInputTimer = null; }
  if (netGuestRaf) cancelAnimationFrame(netGuestRaf); netGuestRaf = 0;
}
function netGuestSendInput() {
  if (!netWs || netWs.readyState !== 1) return;
  if (state !== 'playing' || !player || !player.alive) { netSend({ t: 'in', mx: 0, my: 0, holding: false }); return; }
  let mx = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0) + joyVec.x;
  let my = (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0) + joyVec.y;
  const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
  netSend({ t: 'in', mx: r2(mx), my: r2(my), holding: !!atkHeld });
}
function netGuestFrame() {
  const now = performance.now();
  netEntOrder.forEach((e) => {
    const cur = netSnapCurr.get(e.netSlot); if (!cur) return;
    const prev = netSnapPrev.get(e.netSlot);
    let x = cur.x, y = cur.y, a = cur.a;
    if (prev && cur.t1 > prev.t1) {
      const span = Math.max(1, cur.t1 - prev.t1);
      let k = (now - prev.t1) / span; k = Math.max(0, Math.min(1.2, k));
      x = prev.x + (cur.x - prev.x) * k; y = prev.y + (cur.y - prev.y) * k;
      let da = cur.a - prev.a; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
      a = prev.a + da * k;
    }
    e.x = x; e.y = y; e.angle = a;
  });
  const nb = [];
  netBulCurr.forEach((cur) => {
    const prev = netBulPrev.get(cur.id);
    let x = cur.x, y = cur.y;
    if (prev && cur.t1 > prev.t1) {
      const span = Math.max(1, cur.t1 - prev.t1);
      let k = (now - prev.t1) / span; k = Math.max(0, Math.min(1.25, k));
      x = prev.x + (cur.x - prev.x) * k; y = prev.y + (cur.y - prev.y) * k;
    }
    nb.push({ type: cur.type, x, y, vx: cur.vx, vy: cur.vy, r: cur.r, phase: cur.phase, color: cur.color, life: 1 });
  });
  bullets = nb;
  if (player) {
    /* 自分の溜めゲージだけは手元で予測して進める（ホストの値で毎回上書きしない） */
    if (player.holding) player.chargeT = Math.min(player.char.chargeTime + 0.3, player.chargeT + 1 / 60);
    cam.x = Math.max(0, Math.min(WORLD - W, player.x - W / 2)); cam.y = Math.max(0, Math.min(WORLD - H, player.y - H / 2));
    if (W >= WORLD) cam.x = (WORLD - W) / 2; if (H >= WORLD) cam.y = (WORLD - H) / 2;
    if (state === 'playing') netGuestHud();
  }
}
/* ゲスト用HUD更新（game.js の update() のHUD部分と同じ表示を、同期済みの値で） */
function netGuestHud() {
  const aliveEl = document.getElementById('aliveUI'); if (aliveEl) aliveEl.textContent = netSnapAlive;
  const ac = document.getElementById('aliveChip'); if (ac) ac.classList.toggle('is-danger', netSnapAlive <= 3);
  document.getElementById('killUI').textContent = player.kills;
  document.getElementById('timeUI').textContent = fmt(netSnapElapsed);
  document.getElementById('hpfill').style.width = Math.max(0, player.hp / maxHpOf(player) * 100) + '%';
  document.getElementById('hptext').textContent = Math.max(0, Math.round(player.hp)) + ' / ' + maxHpOf(player) + (player.power ? '　💚×' + player.power : '');
  const rl = document.getElementById('regenline');
  if (rl) {
    const pMax = maxHpOf(player);
    if (!player.alive || player.hp >= pMax) { rl.textContent = '💚 自動回復：満タン'; rl.className = 'regen-line full'; }
    else if (player.isRegen) { rl.textContent = '💚 回復中… +' + Math.round(pMax * REGEN_RATE) + '/秒'; rl.className = 'regen-line healing'; }
    else if (dist(player, zone) > zone.r) { rl.textContent = '☠️ 毒ゾーン内は回復しない'; rl.className = 'regen-line blocked'; }
    else { rl.textContent = '💚 回復まで あと ' + Math.max(0, REGEN_DELAY - player.lastCombat).toFixed(1) + '秒（攻撃すると数え直し）'; rl.className = 'regen-line waiting'; }
  }
  const hw = document.getElementById('hpwrap'); if (hw) hw.classList.toggle('healing', !!player.isRegen);
  const pips = document.getElementById('ammopips');
  if (player.char.ammo > 0) {
    pips.classList.remove('none'); pips.textContent = '';
    for (let i = 0; i < player.char.ammo; i++) { const p = document.createElement('i'); if (i >= player.ammo) p.className = 'empty'; pips.appendChild(p); }
    const reloading = player.ammo < player.char.ammo;
    document.getElementById('ammowrap').classList.toggle('reloading', reloading);
    document.getElementById('ammotext').textContent = reloading ? ('装填中… あと ' + Math.max(0, player.reloadT).toFixed(1) + '秒') : ('弾 ' + player.ammo + ' / ' + player.char.ammo);
    document.getElementById('ammofill').style.width = (reloading ? (1 - player.reloadT / player.char.reload) * 100 : 100) + '%';
  } else if (player.char.type === 'breath') {
    pips.classList.add('none'); pips.textContent = '🔥 息（燃料）：連続' + (player.char.breathMax || 3) + '秒まで';
    document.getElementById('ammowrap').classList.remove('reloading');
    document.getElementById('ammotext').textContent = player.breathOver ? '息切れ中… 回復まで待ってね' : ('あと ' + player.breathFuel.toFixed(1) + ' 秒吐ける');
    document.getElementById('ammofill').style.width = Math.max(0, player.breathFuel / (player.char.breathMax || 3) * 100) + '%';
  } else {
    pips.classList.add('none'); pips.textContent = '近接武器：リロードなし';
    document.getElementById('ammowrap').classList.remove('reloading');
    document.getElementById('ammotext').textContent = 'リロードなし';
    document.getElementById('ammofill').style.width = '100%';
  }
  const cpct = Math.min(100, player.chargeT / player.char.chargeTime * 100);
  document.getElementById('chargefill').style.width = cpct + '%';
  document.getElementById('chargewrap').classList.toggle('ready', chargeReady(player) && player.holding);
  let readyText = player.char.chargeName + ' 準備OK！離して発動';
  if (player.char.type === 'fire') readyText = veraModeOf(player) === 'spiral' ? '炎玉3個 出現中！離すと' + player.char.chargeName : '炎玉3個 出現中！（接触＆ガード／離しても飛ばない）';
  document.getElementById('chargetext').textContent = !player.holding ? '長押しで溜める' : (chargeReady(player) ? readyText : '溜め中… ' + Math.round(cpct) + '%' + (player.char.type === 'fire' ? '（満タンで炎玉出現）' : ''));
  if (player.char.type === 'breath') {
    document.getElementById('chargefill').style.width = Math.max(0, player.breathFuel / (player.char.breathMax || 3) * 100) + '%';
    document.getElementById('chargewrap').classList.toggle('ready', isBreathing(player));
    document.getElementById('chargetext').textContent = player.breathOver ? '🔥 息切れ中… 離して息継ぎしてね' : (isBreathing(player) ? '🔥 ファイアブレス中！ あと ' + player.breathFuel.toFixed(1) + '秒' : '長押しで火を噴く（連続' + (player.char.breathMax || 3) + '秒まで）');
  }
  if (player.char.id === 'captain') {
    document.getElementById('chargefill').style.width = Math.max(0, player.ghostFuel / (player.char.ghostMax || 3.5) * 100) + '%';
    document.getElementById('chargewrap').classList.toggle('ready', isGhost(player));
    document.getElementById('chargetext').textContent = player.ghostOver ? '👻 幽霊化は回復待ち…（1.2秒分まで回復すると使える）' : (isGhost(player) ? '👻 幽霊化中！ あと ' + player.ghostFuel.toFixed(1) + '秒（離すと解除）' : (player.holding ? '溜め中… 満タンで幽霊化' : '長押しで幽霊化（最大' + (player.char.ghostMax || 3.5) + '秒）'));
  }
}

/* ============================================================
   オンライン部屋のUI配線
   ============================================================ */
(function netInit() {
  const urlInput = document.getElementById('netServerUrl');
  if (urlInput) urlInput.value = netServerBase();
  const saveBtn = document.getElementById('netSaveUrlBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    const v = (urlInput ? urlInput.value : '').trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) { netSetStatus('サーバーURLは https:// から始まる形で入れてね', 'err'); return; }
    netSaveServerUrl(v);
    netSetStatus(v ? 'サーバーURLを保存しました' : 'サーバーURLを消しました', v ? 'ok' : '');
  });
  const nameInput = document.getElementById('netNameInput');
  if (nameInput) nameInput.addEventListener('change', netSendCharUpdate);
  const charSel = document.getElementById('netCharSel');
  if (charSel) {
    charSel.innerHTML = '';
    CHARS.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.emoji + ' ' + c.name; charSel.appendChild(o); });
    charSel.value = CHARS[selected].id;
    charSel.addEventListener('change', () => { netSyncVeraRow(); netSendCharUpdate(); });
  }
  const veraSel = document.getElementById('netVeraSel');
  if (veraSel) { veraSel.value = veraMode; veraSel.addEventListener('change', netSendCharUpdate); }
  netSyncVeraRow();
  const createBtn = document.getElementById('netCreateBtn');
  if (createBtn) createBtn.addEventListener('click', () => netConnect('create', netGenCode()));
  const joinBtn = document.getElementById('netJoinBtn');
  if (joinBtn) joinBtn.addEventListener('click', () => {
    const inp = document.getElementById('netCodeInput');
    const code = (inp ? inp.value : '').trim().toUpperCase();
    if (code.length < 4) { netSetStatus('ルームコードを入れてね（6文字）', 'err'); return; }
    netConnect('join', code);
  });
  const startBtn = document.getElementById('netStartBtn');
  if (startBtn) startBtn.addEventListener('click', netHostStart);
  const reconnectBtn = document.getElementById('netReconnectBtn');
  if (reconnectBtn) reconnectBtn.addEventListener('click', netReconnect);
  /* オンライン部屋を開いたとき：接続が生きているのに古い切断表示が
     残っていたら消す（バトル後に戻ってきただけでは切断していないため） */
  document.querySelectorAll('[data-go="online"]').forEach((b) => b.addEventListener('click', () => {
    setTimeout(() => {
      if (!netIsConnected()) { netSyncReconnectBtn(); return; }
      netDisconnected = false; netSyncReconnectBtn();
      const st = document.getElementById('netStatus');
      if (st && /接続が切れました/.test(st.textContent)) netSetStatus(netRole ? '接続中です（ルームコード：' + netCode + '）' : '接続中です', 'ok');
    }, 60);
  }));
  /* ゲストの開始合図もらい直し：待機室で待っている間、サーバーが
     バトル中なら保存済みの開始合図を送り返してくれる（needStart）。
     合図が届いてバトルが始まれば netBattle が true になり送信は止まる */
  setInterval(() => {
    if (netRole !== 'guest' || netBattle || !netIsConnected()) return;
    const wait = document.getElementById('netWaitView');
    if (wait && !wait.classList.contains('hidden')) netSend({ t: 'needStart' });
  }, 2500);
  const leaveBtn = document.getElementById('netLeaveBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', netLeaveRoom);
  const copyBtn = document.getElementById('netCopyBtn');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    if (!netCode) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(netCode).then(() => netSetStatus('ルームコードをコピーしました', 'ok'), () => netSetStatus('コピーできませんでした。コードを見て伝えてね', 'err'));
    else netSetStatus('この環境ではコピーできないので、コードを見て伝えてね', 'err');
  });
  /* 結果画面／上バーの「ロビーに戻る」は、オンライン中は待機室へ戻す */
  ['changeBtn', 'restartTop'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => { if (netOnlineMode || netBattle) netReturnToRoom(); });
  });
  /* 部屋にいる間・オンライン結果画面では、Space でソロバトルが始まらないようにする */
  addEventListener('keydown', (e) => {
    if (e.key !== ' ') return;
    if (!(netRole || netOnlineMode)) return;
    if (state !== 'menu' && state !== 'ended') return;
    const t = e.target;
    if (t && t.closest && t.closest('input,textarea,select')) return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  /* ゲスト：攻撃の押下／解放は間隔送信を待たず即時にも送る（溜めの誤差を減らす） */
  addEventListener('keydown', (e) => { if (e.key === ' ' && netGuestMode && state === 'playing' && !e.repeat) netGuestSendInput(); });
  addEventListener('keyup', (e) => { if (e.key === ' ' && netGuestMode && state === 'playing') netGuestSendInput(); });
  const ab = document.getElementById('atkBtn');
  if (ab) {
    ab.addEventListener('pointerdown', () => { if (netGuestMode && state === 'playing') netGuestSendInput(); });
    ab.addEventListener('pointerup', () => { if (netGuestMode && state === 'playing') netGuestSendInput(); });
  }
  netShowView('netSetupView');
})();
function netSyncVeraRow() {
  const row = document.getElementById('netVeraRow');
  const sel = document.getElementById('netCharSel');
  if (row && sel) row.classList.toggle('hidden', netCharDefById(sel.value).type !== 'fire');
}
