/* ============================================================
   操作まわり：assets/js/input.js
   キーやボタンを変えたいときはここだけ
   ★ PC：攻撃は Space キー。押して離す＝通常攻撃、長押しして離す＝溜め攻撃
        ロビー（試合前）と結果画面では Space で試合開始（PC表示のときだけ）
        狙う操作はなし：攻撃はオートエイム（射程内の一番近い敵を自動で狙う）
        キャラの向きは移動方向に連動する（game.js の update で処理）
   ★ スマホ：攻撃ボタンも同じ。タップ＝通常攻撃、長押し＝溜め攻撃（こちらもオートエイム）
   実際の攻撃・溜め判定は game.js の beginHold() / endHold()
   ============================================================ */
/* ============================================================
   表示分け：左下HUDパネル（HP／自動回復／リロード／溜め）とタッチ操作
   （スティック／攻撃ボタン）は、html の is-pc / is-touch クラスだけで出し分ける
   （game.css 側にメディアクエリの出し分けは無い）。デフォルトはPC表示。
   【スマホ（is-touch）になる条件】次の3つを「全部」満たすときだけ。
     1. 主入力がタッチ：(pointer:coarse) に当てはまる
     2. マウスが主入力でない：(pointer:fine) に当てはまらない
     3. ホバーできない：(hover:none) に当てはまる
   以前は 1 か 3 のどちらかで is-touch にしていたため、タッチ画面付きの
   ノートPCなど「マウスもあるPC」がスマホ扱いになり、PCなのにHUDが消えて
   スティックが出てしまうバグがあった。3条件そろった端末だけをスマホとみなす。
   【実際の操作での切り替え】
     ・マウスで押した／キーを押した → 無条件で is-pc（マウスとキーボードを
       使っている時点でPC操作。タッチ併用PCでも確実にPC表示に戻る）
     ・指／ペンで触った → マウス（fine）が使える端末では切り替えない
       （タッチ対応PCを指で触ってもPC表示のまま）。fine が無い純タッチ
       端末のときだけ is-touch に固定する
     ・一度「実際の操作」で決まったら、リサイズや向き変更では戻さない
   PCでは幅が狭くてもパネルを隠さない（幅だけの判定は一切しない）。
   ============================================================ */
let uiModeLocked=false;
function setUIMode(touch,lock){
  document.documentElement.classList.toggle('is-touch',touch);
  document.documentElement.classList.toggle('is-pc',!touch);
  if(lock) uiModeLocked=true;
}
function mediaMatches(q){ return !!(window.matchMedia&&window.matchMedia(q).matches); }
function isTouchPrimaryDevice(){
  return mediaMatches('(pointer:coarse)') && !mediaMatches('(pointer:fine)') && mediaMatches('(hover:none)');
}
function applyUIModeByMedia(){
  if(uiModeLocked) return;
  setUIMode(isTouchPrimaryDevice(),false);
}
applyUIModeByMedia();
addEventListener('resize',applyUIModeByMedia);
addEventListener('orientationchange',applyUIModeByMedia);
addEventListener('touchstart',()=>{ if(!mediaMatches('(pointer:fine)')) setUIMode(true,true); },{passive:true});
addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse') setUIMode(false,true);
  else if((e.pointerType==='touch'||e.pointerType==='pen')&&!mediaMatches('(pointer:fine)')) setUIMode(true,true);
},{passive:true});
addEventListener('keydown',()=>setUIMode(false,true));

addEventListener('keydown',e=>{
 keys[e.key.toLowerCase()]=true;
 if(e.key===' '){
   e.preventDefault();
   /* ★ PC版：ロビー（試合前）や結果画面で Space を押したら試合開始。
      スマホ（is-touch）では始めない。設定のスライダーなど入力部品に
      フォーカスがあるときも始めない（Spaceはそちらの操作に使う）。
      試合開始は startGame() がカウントダウンから始めてくれる */
   const isPC=document.documentElement.classList.contains('is-pc')||!document.documentElement.classList.contains('is-touch');
   const t=e.target;
   const onControl=t&&t.closest&&(t.closest('input,textarea,select')||t.closest('#heroFigure')); /* ロビー中央キャラにフォーカス中はキャラ部屋へ行く操作を優先 */
   if(isPC&&!onControl&&(state==='menu'||state==='ended')){
     if(!e.repeat) startGame();
     return;
   }
   /* バトル中だけ攻撃。カウントダウン中のSpaceは攻撃に使わない
      （押しっぱなしで「開戦」と同時に暴発しないように） */
   if(state==='playing'&&!e.repeat){ atkHeld=true; beginHold(); }
 }
 if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase())) e.preventDefault();
});
addEventListener('keyup',e=>{
 keys[e.key.toLowerCase()]=false;
 if(e.key===' '){ e.preventDefault(); atkHeld=false; endHold(); }
});
addEventListener('blur',()=>{ keys={}; if(atkHeld){ atkHeld=false; if(player) player.holding=false; } });
canvas.addEventListener('mousemove',e=>{ const r=canvas.getBoundingClientRect(); mouse.x=e.clientX-r.left; mouse.y=e.clientY-r.top; });
canvas.addEventListener('contextmenu',e=>e.preventDefault());

const joy=document.getElementById('joy'), knob=document.getElementById('joyKnob'); let joyId=null;
function knobBase(){ return (joy.clientWidth-knob.offsetWidth)/2; }
joy.addEventListener('pointerdown',e=>{joyId=e.pointerId; joy.setPointerCapture(e.pointerId); moveJoy(e);});
joy.addEventListener('pointermove',e=>{if(e.pointerId===joyId) moveJoy(e);});
joy.addEventListener('pointerup',()=>{joyId=null; joyVec={x:0,y:0}; const b=knobBase(); knob.style.left=b+'px'; knob.style.top=b+'px';});
/* スティックの大きさは transform の scale で変える（設定部屋）ので、
   画面上の座標をレイアウト上の座標に戻してからノブを動かす */
function moveJoy(e){ const r=joy.getBoundingClientRect(); const sc=(joy.clientWidth? r.width/joy.clientWidth:1)||1; let dx=(e.clientX-(r.left+r.width/2))/sc, dy=(e.clientY-(r.top+r.height/2))/sc; const l=Math.hypot(dx,dy), max=36; if(l>max){dx=dx/l*max; dy=dy/l*max;} joyVec={x:dx/max,y:dy/max}; const b=knobBase(); knob.style.left=(b+dx)+'px'; knob.style.top=(b+dy)+'px'; if(player) player.angle=Math.atan2(dy,dx); }
const atkBtn=document.getElementById('atkBtn');
/* ★ 長押し（溜め攻撃／幽霊・キャプテンの幽霊化）が途中で切れないように：
   押した指をボタンに捕捉（setPointerCapture）して、指がボタンの外へ
   ずれても pointerleave で離したことにならないようにする。以前は
   pointerleave でも endHold していたため、幽霊化して壁を抜けようと
   している最中に指が少しずれるだけで幽霊化が解除され、壁に引っかかる
   ことがあった。離す判定は pointerup／pointercancel（捕捉した指の分だけ） */
let atkPointerId=null;
atkBtn.addEventListener('pointerdown',e=>{e.preventDefault(); touchMode=true; atkHeld=true; atkPointerId=e.pointerId; try{ atkBtn.setPointerCapture(e.pointerId); }catch(_){} atkBtn.classList.add('holding'); beginHold();});
['pointerup','pointercancel'].forEach(ev=>atkBtn.addEventListener(ev,e=>{ if(atkHeld&&touchMode&&(atkPointerId===null||e.pointerId===atkPointerId)){ atkHeld=false; atkPointerId=null; atkBtn.classList.remove('holding'); endHold(); } }));

document.getElementById('startBtn').onclick=startGame;
document.getElementById('toBattleBtn').onclick=startGame;
document.getElementById('againBtn').onclick=startGame;
/* バトルを終了してロビーに戻る（結果画面の「ロビーに戻る」と上バーの「🏠 ロビー」共通）。
   バトル中・カウントダウン中でも安全に戻れるよう、溜め状態と溜め音を止め、
   結果画面／カウントダウン／上バー／HUDを片付けてから state='menu' にする。
   state を menu にしておけば、遅れて届く endGame() 予約（敗北・優勝時）も
   endGame 側のガード（state!=='playing'）で無効になる */
function backToLobby(){
  atkHeld=false; joyVec={x:0,y:0}; keys={};
  if(player) player.holding=false;
  if(typeof SFX!=='undefined'&&SFX&&SFX.chargeStop) SFX.chargeStop();
  const ab=document.getElementById('atkBtn'); if(ab) ab.classList.remove('holding');
  if(typeof stopVictoryFx==='function') stopVictoryFx();
  document.getElementById('endScreen').classList.add('hidden');
  const cd=document.getElementById('countdown'); if(cd) cd.classList.add('hidden');
  const hud=document.getElementById('hud'); if(hud) hud.classList.add('hidden');
  document.getElementById('startScreen').classList.remove('hidden');
  document.getElementById('topbar').classList.add('hidden');
  state='menu'; showRoom('lobby');
}
document.getElementById('changeBtn').onclick=backToLobby;
document.getElementById('restartTop').onclick=backToLobby;

/* ============================================================
   設定部屋：スマホのスティック／攻撃ボタンの位置（assets/js/input.js）
   左右・下からの高さ・端からの距離・大きさを変えられる。
   記録はこのページを開いている間だけ（ガチャのコインと同じ扱い）。
   変えた瞬間に applyTouchLayout() でバトル画面の実物にも反映する。
   プレビューの高さは実画面より小さいので、縦だけ 0.42 倍で表示する。
   ============================================================ */
const TOUCH_DEFAULTS={joySide:'left',atkSide:'right',joyBottom:96,joyInset:14,atkBottom:96,atkInset:14,joyScale:100,atkScale:100};
let touchSettings={...TOUCH_DEFAULTS};
const PREVIEW_Y=0.42;
function clampNum(v,a,b){ return Math.max(a,Math.min(b,v)); }
function placeControl(el,side,inset,bottom,scale){
  if(!el) return;
  if(side==='left'){ el.style.left=inset+'px'; el.style.right='auto'; } else { el.style.right=inset+'px'; el.style.left='auto'; }
  el.style.bottom=bottom+'px';
  el.style.transform='scale('+(scale/100)+')';
}
function applyTouchLayout(){
  const tbtns=document.querySelector('.tbtns');
  placeControl(joy,touchSettings.joySide,touchSettings.joyInset,touchSettings.joyBottom,touchSettings.joyScale);
  placeControl(tbtns,touchSettings.atkSide,touchSettings.atkInset,touchSettings.atkBottom,touchSettings.atkScale);
  /* 設定部屋のプレビューも同じ位置に置く（縦だけ縮小） */
  placeControl(document.getElementById('previewJoy'),touchSettings.joySide,touchSettings.joyInset,Math.round(touchSettings.joyBottom*PREVIEW_Y),touchSettings.joyScale);
  placeControl(document.getElementById('previewAtk'),touchSettings.atkSide,touchSettings.atkInset,Math.round(touchSettings.atkBottom*PREVIEW_Y),touchSettings.atkScale);
}
function syncTouchSettingsUI(){
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v; };
  const txt=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  set('joyBottomRange',touchSettings.joyBottom); txt('joyBottomVal',touchSettings.joyBottom);
  set('joyInsetRange',touchSettings.joyInset); txt('joyInsetVal',touchSettings.joyInset);
  set('joyScaleRange',touchSettings.joyScale); txt('joyScaleVal',touchSettings.joyScale+'%');
  set('atkBottomRange',touchSettings.atkBottom); txt('atkBottomVal',touchSettings.atkBottom);
  set('atkInsetRange',touchSettings.atkInset); txt('atkInsetVal',touchSettings.atkInset);
  set('atkScaleRange',touchSettings.atkScale); txt('atkScaleVal',touchSettings.atkScale+'%');
  const jl=document.getElementById('joySideLeft'), jr=document.getElementById('joySideRight');
  if(jl) jl.classList.toggle('active',touchSettings.joySide==='left');
  if(jr) jr.classList.toggle('active',touchSettings.joySide==='right');
  const al=document.getElementById('atkSideLeft'), ar=document.getElementById('atkSideRight');
  if(al) al.classList.toggle('active',touchSettings.atkSide==='left');
  if(ar) ar.classList.toggle('active',touchSettings.atkSide==='right');
  applyTouchLayout();
}
function bindRange(id,key){ const el=document.getElementById(id); if(el) el.addEventListener('input',()=>{ touchSettings[key]=+el.value; syncTouchSettingsUI(); }); }
bindRange('joyBottomRange','joyBottom'); bindRange('joyInsetRange','joyInset'); bindRange('joyScaleRange','joyScale');
bindRange('atkBottomRange','atkBottom'); bindRange('atkInsetRange','atkInset'); bindRange('atkScaleRange','atkScale');
function bindSeg(id,sideKey,side){ const el=document.getElementById(id); if(el) el.addEventListener('click',()=>{ touchSettings[sideKey]=side; syncTouchSettingsUI(); }); }
bindSeg('joySideLeft','joySide','left'); bindSeg('joySideRight','joySide','right');
bindSeg('atkSideLeft','atkSide','left'); bindSeg('atkSideRight','atkSide','right');
function bindPreset(id,fn){ const el=document.getElementById(id); if(el) el.addEventListener('click',()=>{ fn(); syncTouchSettingsUI(); }); }
bindPreset('presetDefault',()=>{ touchSettings={...TOUCH_DEFAULTS}; });
bindPreset('presetSwap',()=>{ touchSettings.joySide='right'; touchSettings.atkSide='left'; });
bindPreset('presetHigh',()=>{ touchSettings.joyBottom=168; touchSettings.atkBottom=168; });
bindPreset('presetLow',()=>{ touchSettings.joyBottom=40; touchSettings.atkBottom=40; });
const resetBtn=document.getElementById('touchResetBtn');
if(resetBtn) resetBtn.addEventListener('click',()=>{ touchSettings={...TOUCH_DEFAULTS}; syncTouchSettingsUI(); });
/* プレビュー上のドラッグでも位置を変えられる */
function bindPreviewDrag(elId,isJoy){
  const el=document.getElementById(elId), box=document.getElementById('settingsPreview');
  if(!el||!box) return;
  let dragId=null;
  el.addEventListener('pointerdown',e=>{ dragId=e.pointerId; el.setPointerCapture(e.pointerId); dragMove(e); });
  el.addEventListener('pointermove',e=>{ if(e.pointerId===dragId) dragMove(e); });
  ['pointerup','pointercancel'].forEach(ev=>el.addEventListener(ev,()=>{ dragId=null; }));
  function dragMove(e){
    const r=box.getBoundingClientRect(), w=el.offsetWidth, h=el.offsetHeight;
    const cx=e.clientX-r.left, cyFromBottom=r.height-(e.clientY-r.top);
    const sideKey=isJoy?'joySide':'atkSide', insetKey=isJoy?'joyInset':'atkInset', bottomKey=isJoy?'joyBottom':'atkBottom';
    const inset = touchSettings[sideKey]==='left' ? cx-w/2 : r.width-cx-w/2;
    touchSettings[insetKey]=Math.round(clampNum(inset,4,72));
    touchSettings[bottomKey]=Math.round(clampNum((cyFromBottom-h/2)/PREVIEW_Y,24,190));
    syncTouchSettingsUI();
  }
}
bindPreviewDrag('previewJoy',true);
bindPreviewDrag('previewAtk',false);
syncTouchSettingsUI();

/* ============================================================
   横画面専用ガード（スマホのみ）：assets/js/input.js の末尾
   スマホ（タッチ端末）では横向きでしか遊べないようにする。
     ・縦向きの間は #rotateOverlay（base.css）を全画面で出し、
       ロビー・各部屋・バトルなど裏の画面を全部隠す
     ・横向きに戻すと自動で消えて、そのまま続きが遊べる
       （状態は一切リセットしない。出す／消すだけ）
     ・PC（マウス／キーボード）では絶対に出さない
   【スマホ判定】既存の is-touch と同じ3条件（isTouchPrimaryDevice()）：
   タッチが主入力・マウスが主入力でない・ホバー不可、が全部そろった
   端末だけ。幅や向きだけでは判定しないので、PCで縦長の狭い
   ウィンドウにしても出ない。タッチ対応PCもマウスが主入力なら出ない。
   【向き判定】matchMedia('(orientation: portrait)') を主にして、
   取れない環境では画面の縦横サイズで補う。
   【画面ロック】screen.orientation.lock('landscape') も試みる。
   インストール済みPWAやフルスクリーン時だけ許可されるAPIなので、
   失敗してもエラーにせず静かにあきらめる（オーバーレイが本命）。
   ============================================================ */
function isPortraitNow(){
  if(window.matchMedia){
    const mq=window.matchMedia('(orientation: portrait)');
    if(mq&&typeof mq.matches==='boolean') return mq.matches;
  }
  return window.innerHeight>window.innerWidth;
}
function updateRotateOverlay(){
  const show=isTouchPrimaryDevice()&&isPortraitNow();
  document.documentElement.classList.toggle('show-rotate',show);
}
updateRotateOverlay();
addEventListener('resize',updateRotateOverlay);
addEventListener('orientationchange',updateRotateOverlay);
if(window.matchMedia){
  const omq=window.matchMedia('(orientation: portrait)');
  if(omq&&omq.addEventListener) omq.addEventListener('change',updateRotateOverlay);
  else if(omq&&omq.addListener) omq.addListener(updateRotateOverlay);
}
function tryLockLandscape(){
  try{
    if(!isTouchPrimaryDevice()) return;
    if(screen.orientation&&typeof screen.orientation.lock==='function'){
      const p=screen.orientation.lock('landscape');
      if(p&&typeof p.catch==='function') p.catch(()=>{});
    }
  }catch(_){ /* ロックできない環境では何もしない（オーバーレイで案内する） */ }
}
addEventListener('pointerdown',tryLockLandscape,{passive:true});
document.addEventListener('fullscreenchange',tryLockLandscape);
