/* ============================================================
   バトル本体：assets/js/game.js
   キャラ性能と全体バランスの数値は assets/js/data.js
   （REGEN_DELAY / REGEN_RATE / キューブ倍率などもそちら）
   ここにあるのは毒ゾーンの段階ダメージとゾーンの縮み方だけ
   操作まわりは assets/js/input.js を見る

   【このファイルの中身（上から順に）】
     1. 毒ゾーンのダメージ計算・共通の小物関数
     2. バトル開始（startGame）・勝敗判定（checkWin / endGame）
     3. 戦闘（通常攻撃 attack／溜め攻撃 chargeAttack／オートエイム）
     4. BOTの動き（botAI）
     5. 毎フレームの更新（update：移動・リロード・自動回復・HUD）
     6. 描画（drawEntity などキャラ描画／drawWorld）
   ============================================================ */
/* 毒ゾーンの毎秒ダメージ：ゾーンが小さい（終盤）ほど強い。
   序盤は逃げ遅れても立て直せるが、終盤は回復（最大HPの6%/秒）より
   毒の方が速くなり、隠れ続けることはできない */
function poisonDps(){
 if(zone.targetR>=520) return 35;
 if(zone.targetR>=360) return 50;
 if(zone.targetR>=220) return 60;
 return 75;
}
function maxHpOf(e){ return e.maxHp + e.power*POWER_HP_PER_CUBE; }
const canvas=document.getElementById('game'), ctx=canvas.getContext('2d');
let W=960,H=640, DPR=1;
function resize(){ const r=canvas.parentElement.getBoundingClientRect(); DPR=Math.min(devicePixelRatio||1,2); W=r.width; H=r.height; canvas.width=W*DPR; canvas.height=H*DPR; ctx.setTransform(DPR,0,0,DPR,0,0); }
addEventListener('resize',resize);

let state='menu', entities=[], bullets=[], particles=[], cubes=[], crates=[], floaters=[];
/* オンライン対戦（net.js）用の共有フラグ：
   netGuestMode … ゲスト参加中（この端末ではシミュレーションを回さず、ホストの
                  スナップショットで描画する。update() は冒頭で return する）
   netHostSimMode … ホストが自分の結果画面を出したあとも、ゲストのために
                  シミュレーションを回し続けるためのフラグ（loop の判定に使う）
   netOnlineMode … オンライン対戦のバトル中かどうか（結果画面の文言などに使う）
   netMyPlace   … ホストが確定させた自分の順位（0=未確定） */
let netGuestMode=false, netHostSimMode=false, netOnlineMode=false, netMyPlace=0;
/* ステージ（data.js の STAGES からランダム）：障害物・仕掛け・飾りはバトルごとに生成する */
let obstacles=[], hazards=[], decors=[], currentStage=STAGES[0], lastStageId=null;
let zone={x:0,y:0,r:0,targetR:0}, cam={x:0,y:0}, keys={}, mouse={x:0,y:0,down:false}, startTime=0, elapsed=0, shake=0;
let player=null, joyVec={x:0,y:0}, atkHeld=false, touchMode=false, winScheduled=false;
const WORLD=1600;
const names=BOT_NAMES;

function rand(a,b){return a+Math.random()*(b-a)}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function angleTo(a,b){return Math.atan2(b.y-a.y,b.x-a.x)}
function fmt(s){return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0')}
/* ============================================================
   効果音の呼び出し口（実体は assets/js/sound.js の SFX）。
   プレイヤー本人の音はそのまま、BOTの音は「プレイヤーから近いときだけ
   小さく」鳴らす。遠くの戦闘まで全部鳴るとうるさいだけなので、
   580px より遠いBOTの音は鳴らさない。爆発は playSfxAt で位置から判定。
   ============================================================ */
function playSfx(name,src){
 if(typeof SFX==='undefined'||!SFX) return;
 try{
   if(src&&player&&src!==player){
     if(Math.hypot(src.x-player.x,src.y-player.y)>580) return;
     /* 音の出た左右位置でステレオ定位も付ける（広がりが出て安っぽく聞こえない） */
     const pan=Math.max(-0.75,Math.min(0.75,(src.x-player.x)/520));
     SFX.play(name,{vol:0.38,pan});
   } else SFX.play(name);
 }catch(_){}
}
function playSfxAt(name,x,y){
 if(typeof SFX==='undefined'||!SFX||!player) return;
 try{
   const d=Math.hypot(x-player.x,y-player.y);
   if(d>620) return;
   const pan=Math.max(-0.75,Math.min(0.75,(x-player.x)/520));
   SFX.play(name,{vol:d<260?1:0.45,pan});
 }catch(_){}
}

function makeEntity(charDef,x,y,isPlayer,name,veraOverride){
 /* ヴェラーはモードで弾倉・リロード・連射間隔が違うので、実体ごとに性能を複製して上書きする
    螺旋型＝弾倉1発／ショット型＝弾倉3発・リロード1.0秒・連射0.45秒（連射を抑えた調整）
    veraOverride（オンライン対戦で相手が選んだモード）を渡されたらそれを優先する */
 let effChar=charDef, vMode=null;
 if(charDef.type==='fire'){
   vMode=veraOverride || (isPlayer ? (typeof veraMode!=='undefined'?veraMode:'spiral') : (Math.random()<0.5?'spiral':'shot'));
   const mi=veraModeInfo(vMode);
   effChar=Object.assign({},charDef,{ammo:mi.ammo, reload:mi.reload, rate:mi.rate});
 }
 return {x,y,vx:0,vy:0,char:effChar,hp:effChar.hp,maxHp:effChar.hp,r:effChar.r||22,angle:rand(0,6.28),cool:0,power:0,alive:true,isPlayer,name,think:rand(0,.3),tx:x,ty:y,hitFlash:0,kills:0,regen:0,swing:0,bob:rand(0,6.28),skin:isPlayer?effChar.skin:BOT_SKINS[Math.floor(Math.random()*BOT_SKINS.length)],
  ammo:effChar.ammo||0, reloadT:0, holding:false, chargeT:0, dashT:0, dashDir:0, dashHit:null, botChargeCd:rand(2,5),
  /* 自動回復用：最後に「攻撃した／された」からの経過秒数。REGEN_DELAY を超えると回復が始まる */
  lastCombat:REGEN_DELAY+1, isRegen:false, regenFxT:0,
  /* 炎玉（ヴェラー専用）：flameAngle=今の回転角度／flameHitCd=炎玉ダメージを受けられるまでの残り秒数（全員が持つ） */
  flameAngle:rand(0,6.28), flameHitCd:0,
  /* ヴェラーのモード：プレイヤーはキャラ部屋で選んだ veraMode、BOTはランダム。
     botOrbT=BOTが炎玉を出し続ける残り時間（null=まだ決めていない） */
  veraMode:vMode,
  botOrbT:null,
  /* 格闘（ブルーノ専用）：punchSide=次に出る手（0=右／1=左。攻撃ごとに交互）、
     lastPunch=最後に出した手（描画でどちらの拳が伸びるか決める）、
     kickT/kickDir=キック演出の残り時間と方向、kickHit/kickCrateHit=このキックで
     すでに当てた相手（弧のスイープで多段ヒットさせないための記録） */
  punchSide:0, lastPunch:0, kickT:0, kickDir:0, kickDur:0.18, kickHit:null, kickCrateHit:null,
  /* 火吹き（バート専用）：breathFuel=息（燃料）の残り秒数（最大 breathMax=3秒分）。
     吐いている間だけ減り、離している間に回復する。breathOver=息切れ中
     （燃料が1.2秒分まで戻るまで吐けない）。breathTickT=次のブレス判定までの残り */
  breathFuel:effChar.breathMax||0, breathOver:false, breathTickT:0,
  /* 死神のテレポート専用：tpT=潜っている／現れている最中の残り時間、
     tpPhase='sink'（潜る）→'emerge'（現れる）。tpX/tpY=出現先。
     tpAge=テレポート開始からの経過秒数（復帰フェイルセーフ用） */
  tpT:0, tpPhase:'', tpX:0, tpY:0, tpAge:0,
  /* 幽霊・キャプテン専用：ghostFuel=幽霊化を続けられる残り秒数（最大 ghostMax）。
     使い切ると ghostOver になり、1.2秒分まで戻るまで幽霊化できない */
  ghostFuel:effChar.ghostMax||0, ghostOver:false};
}
/* ============================================================
   ブルーノの足技「爆裂旋風キック」：直線ではなく弧（スイープ）の軌道。
   足は kickDir を中心に左右 KICK_SWEEP/2（約43度ずつ・合計約86度）だけを
   KICK_DUR 秒で一気に振り抜ける（0.34秒→0.18秒に高速化。リーチも
   138→69に半分にした：data.js の kickRange。脚が長すぎて不自然だったため）。
   ★ 当たり判定は「足先の点」ではなく「脚全体（付け根→つま先の線分）」。
     以前は足先の円でしか判定していなかったため、脚が通過しているのに
     当たらない／返せないことがあった。線分との距離で判定するので、
     脚のどこに触れてもダメージ＆跳ね返しが起こる（kickHitsPoint）。
   ★ キック中だけの特別ルール：脚に触れた遠距離攻撃（矢・炎玉など）は
     跳ね返して相手に撃ち返せる。ただしドンの爆弾（通常／メガボム）だけは
     跳ね返せず、脚に触れた瞬間にその場で爆発する。
   ============================================================ */
const KICK_DUR=0.18, KICK_SWEEP=1.5;
/* キック中の「今の足先の位置」。キックしていないときは null。
   ダメージ判定・跳ね返し判定・描画で共通に使う */
function kickFoot(e){
 if(!e||!e.alive||e.char.type!=='fist'||!(e.kickT>0)) return null;
 const dur=e.kickDur||KICK_DUR;
 const p=Math.min(1,Math.max(0,1-e.kickT/dur)); /* 0→1 で振り抜ける */
 const a=e.kickDir-KICK_SWEEP/2+KICK_SWEEP*p;
 const d=e.char.kickRange||69;
 return {x:e.x+Math.cos(a)*d, y:e.y+Math.sin(a)*d, a, p};
}
/* 点(px,py)と線分(x1,y1)-(x2,y2)の最短距離 */
function segDist(px,py,x1,y1,x2,y2){
 const dx=x2-x1, dy=y2-y1, len2=dx*dx+dy*dy||1;
 let t=((px-x1)*dx+(py-y1)*dy)/len2; t=Math.max(0,Math.min(1,t));
 return Math.hypot(px-(x1+dx*t), py-(y1+dy*t));
}
/* キックの当たり判定：脚全体（体の中心→足先の線分）から pad 以内なら当たる。
   ダメージ・宝箱・跳ね返し・爆弾の起爆すべてこの判定で統一する。
   線分の始点（体の中心）まわりは全方向に丸く広がってしまうので、
   中心から少し離れた相手には「脚の向きとの角度」も合わせて見る
   （背後の相手を蹴ってしまうのを防ぐ） */
function kickHitsPoint(e,px,py,pad){
 const f=kickFoot(e); if(!f) return false;
 if(segDist(px,py,e.x,e.y,f.x,f.y)>=pad) return false;
 const d=Math.hypot(px-e.x,py-e.y);
 if(d>24 && Math.abs(angDiff(f.a,Math.atan2(py-e.y,px-e.x)))>1.05) return false;
 return true;
}
/* 飛び道具を跳ね返す：向きを反転し、撃った相手を新しい持ち主にする
   （跳ね返した弾は元の撃ち手にも当たる）。螺旋フレイムは中心の進行方向を反転 */
function reflectBullet(b,e){
 const prevOwner=b.owner;
 b.owner=e;
 if(b.type==='spiral'){ b.dx*=-1; b.dy*=-1; }
 else { b.vx*=-1.08; b.vy*=-1.08; b.x+=b.vx*0.03; b.y+=b.vy*0.03; }
 if(b.hitSet) b.hitSet=new Set(); /* 貫通弾も、跳ね返した後は元の撃ち手に当たる */
 b.life=Math.max(b.life,0.35);
 b.noReflectT=0.3; /* 跳ね返した直後にまた足へ触れて二重に跳ね返らないように */
 e.lastCombat=0; e.isRegen=false; /* 跳ね返しも戦闘行動：回復タイマーをリセット */
 burst(b.x,b.y,'#ffc93c',8); burst(b.x,b.y,'#fff',4);
 playSfx('reflect',e); /* キンッという金属音で跳ね返しが分かるように */
 if(e.isPlayer||(prevOwner&&prevOwner.isPlayer)) floaters.push({x:b.x,y:b.y-16,text:'跳ね返し!',life:0.8,color:'#ffc93c'});
 shake=Math.max(shake,3);
}
/* ヴェラーのモード（'spiral'=案1／'shot'=案2）。ヴェラー以外は null */
function veraModeOf(e){ return e&&e.char.type==='fire' ? (e.veraMode||'spiral') : null; }
/* 溜めている間も足が遅くならないキャラ：ヴェラー（両モード）とブルーノ（格闘）と
   ボニー（ショットガン：溜め＝高速ダッシュの構え）と死神（溜め＝テレポートの構え）。
   他のキャラは溜め中は少し遅くなる。幽霊・キャプテンは減速するが緩やか（0.65倍、
   update() の holdF で個別に扱う）。
   バート（火吹き）は「溜め」ではなく吐き続ける攻撃なので別扱い（isBreathing） */
function noChargeSlow(e){ return !!e && (e.char.type==='fire' || e.char.type==='fist' || e.char.type==='shotgun' || e.char.type==='scythe'); }
/* バートが今まさに火を吐いているか：ボタンを押していて、息切れでなく、燃料が残っている */
function isBreathing(e){ return !!e && e.char.type==='breath' && e.holding && !e.breathOver && e.breathFuel>0; }
/* 死神の溜め攻撃「冥府潜りテレポート」の時間と距離：
   地面に潜る TP_SINK 秒 → 向いている方向へ TP_DIST 先に出現 →
   地面から現れる TP_EMERGE 秒。潜っている間（tpT>0）は攻撃が当たらない */
const TP_SINK=0.22, TP_EMERGE=0.26, TP_DIST=260;
/* テレポート先の計算：今の位置から angle 方向へ TP_DIST 先（ワールドの円の
   外には出ないよう中心から700以内に丸める）。実際の出現先（chargeAttack）と、
   溜め中に表示するワープ先マーカー（drawTpMarker）で同じ計算を使い、
   マーカーの位置と実際の出現先がずれないようにする */
function tpDest(e,angle){ let nx=e.x+Math.cos(angle)*TP_DIST, ny=e.y+Math.sin(angle)*TP_DIST; const dc=Math.hypot(nx-WORLD/2,ny-WORLD/2); if(dc>700){ nx=WORLD/2+(nx-WORLD/2)/dc*700; ny=WORLD/2+(ny-WORLD/2)/dc*700; } return {x:nx,y:ny}; }
/* 幽霊・キャプテンが今まさに幽霊化しているか：長押しでゲージが満タンに
   なってから、離すか ghostFuel が尽きるまでの間だけ。
   幽霊化中はあらゆる攻撃がすり抜け（damage() と弾の判定で除外）、
   障害物も通り抜けられる（移動の押し出し判定で除外） */
function isGhost(e){ return !!e && e.char.id==='captain' && e.holding && e.chargeT>=e.char.chargeTime && !e.ghostOver && e.ghostFuel>0; }
/* バートのブレス1回分の判定：向いている方向の扇形（range／±breathAngle）に
   いる敵と宝箱へ tick ダメージ。障害物に隠れた相手は焼けない（遮蔽チェック付き）。
   attack() のタップ（短い一吹き）と、update() の継続ブレスの両方から使う */
function breathHit(e){
 const aim=e.angle, R=e.char.range, half=e.char.breathAngle||0.62;
 const dmg=(e.char.breathTickDmg||32)*(1+e.power*POWER_DMG_PER_CUBE);
 const blocked=(tx,ty)=>obstacles.some(o=>segDist(o.x,o.y,e.x,e.y,tx,ty)<o.r*0.72 && Math.hypot(o.x-e.x,o.y-e.y)<Math.hypot(tx-e.x,ty-e.y));
 entities.forEach(t=>{ if(t!==e&&t.alive&&dist(e,t)<R+t.r&&Math.abs(angDiff(aim,angleTo(e,t)))<half&&!blocked(t.x,t.y)) damage(t,dmg,e); });
 crates.forEach(c=>{ if(c.alive&&dist(e,c)<R+c.r&&Math.abs(angDiff(aim,angleTo(e,c)))<half+0.15&&!blocked(c.x,c.y)) hitCrate(c,dmg,e); });
 for(let i=0;i<3;i++){ const aa=aim+rand(-half,half)*0.8, dd=rand(R*0.35,R*0.95);
   particles.push({x:e.x+Math.cos(aa)*dd,y:e.y+Math.sin(aa)*dd,vx:Math.cos(aa)*rand(60,130),vy:Math.sin(aa)*rand(60,130)-14,life:rand(.16,.3),max:.3,color:Math.random()<0.4?'#ffc93c':'#ff7b1c',size:rand(4,8)}); }
}
/* 炎玉の今の位置一覧（ヴェラー以外は空）。ダメージ判定・弾ガード・描画で共通に使う
   ★ 普段は炎玉を出さない。しかも長押しした瞬間には出ず、
     長押しゲージが満タン（chargeTime 秒）になってから初めて3個が現れる */
function flameBalls(e){
 if(!e||!e.alive||e.char.type!=='fire'||!e.holding) return [];
 if(e.chargeT<e.char.chargeTime) return []; /* ゲージがたまるまでは出ない */
 const n=e.char.fireCount||3, R=e.char.fireOrbit||54, out=[];
 for(let i=0;i<n;i++){ const a=e.flameAngle+i*Math.PI*2/n; out.push({x:e.x+Math.cos(a)*R, y:e.y+Math.sin(a)*R, a}); }
 return out;
}
/* ============================================================
   ステージ生成：ステージごとに障害物・仕掛け（池）・飾りをランダム配置する。
   スポーン位置・他の障害物・池と重ならない場所だけに置く（最大40回試す）。
   障害物は全部「壊れない・通れない・弾を止める」地形として扱う。
   ============================================================ */
function stageSpot(spawns,minCenter,maxCenter,clear){
 for(let t=0;t<40;t++){
   const a=rand(0,6.28), d=rand(minCenter,maxCenter), x=WORLD/2+Math.cos(a)*d, y=WORLD/2+Math.sin(a)*d;
   if(spawns.some(s=>Math.hypot(s.x-x,s.y-y)<clear)) continue;
   if(obstacles.some(o=>Math.hypot(o.x-x,o.y-y)<o.r+clear)) continue;
   if(hazards.some(h=>Math.hypot(h.x-x,h.y-y)<h.r+clear*0.6)) continue;
   if(crates.some(c=>Math.hypot(c.x-x,c.y-y)<c.r+clear)) continue;
   return {x,y};
 }
 return null;
}
function generateStageLayout(stage,spawns){
 obstacles=[]; hazards=[]; decors=[]; crates=[];
 const addObs=(type,r,minC,maxC,clear)=>{ const s=stageSpot(spawns,minC,maxC,clear||70); if(s) obstacles.push({x:s.x,y:s.y,r,type}); };
 const addHaz=(type,r)=>{ const s=stageSpot(spawns,220,540,r+90); if(s) hazards.push({x:s.x,y:s.y,r,type}); };
 const addDec=(type,r)=>{ const s=stageSpot(spawns,60,640,44); if(s) decors.push({x:s.x,y:s.y,r,type}); };
 if(stage.id==='grass'){ /* 木が障害物、茂みは飾り（今まで通りすり抜けられる） */
   for(let i=0;i<6;i++) addObs('tree',22,120,620);
   for(let i=0;i<5;i++) addDec('bush',52);
 } else if(stage.id==='magma'){ /* マグマ池（ダメージ）＋黒岩と枯れ木 */
   for(let i=0;i<3;i++) addHaz('magma',rand(68,92));
   for(let i=0;i<7;i++) addObs('rock',rand(23,31),120,620);
   for(let i=0;i<3;i++) addObs('deadtree',19,140,600);
   for(let i=0;i<6;i++) addDec('ash',rand(16,30));
 } else if(stage.id==='ship'){ /* マスト（太い柱）＋タル。飾りはロープの巻き */
   addObs('mast',30,230,300,150); addObs('mast',30,230,300,150);
   for(let i=0;i<6;i++) addObs('barrel',19,110,620);
   for(let i=0;i<5;i++) addDec('rope',rand(18,26));
 } else if(stage.id==='ice'){ /* 氷の池（速くなる）＋氷ブロックと雪の松 */
   for(let i=0;i<2;i++) addHaz('ice',rand(78,96));
   for(let i=0;i<5;i++) addObs('iceblock',25,120,620);
   for(let i=0;i<5;i++) addObs('pinetree',21,120,620);
   for(let i=0;i<6;i++) addDec('snow',rand(18,34));
 }
 /* 宝箱は障害物・池を避けて置く */
 for(let i=0;i<14;i++){ const s=stageSpot(spawns,80,620,58); if(s) crates.push({x:s.x,y:s.y,hp:400,r:24,alive:true}); }
}
function pickStage(){ /* ランダム。ただし前回と同じステージは続けない */
 let pool=STAGES.filter(s=>s.id!==lastStageId); if(!pool.length) pool=STAGES;
 const s=pool[Math.floor(Math.random()*pool.length)]; lastStageId=s.id; return s;
}
function onIce(e){ return hazards.some(h=>h.type==='ice'&&Math.hypot(e.x-h.x,e.y-h.y)<h.r); }
function startGame(){
 const pc=CHARS[selected];
 entities=[]; bullets=[]; particles=[]; cubes=[]; crates=[]; floaters=[];
 zone={x:WORLD/2,y:WORLD/2,r:720,targetR:720};
 /* ★ ステージはバトルごとにランダム（全4種・連続で同じにはならない） */
 currentStage=pickStage();
 /* スポーン位置を先に決めてから地形を置く（地形がスポーンに重ならないように） */
 const spawns=[{x:WORLD/2+rand(-80,80),y:WORLD/2+rand(-80,80)}];
 for(let i=0;i<BOT_COUNT;i++){ const a=i/BOT_COUNT*Math.PI*2; spawns.push({x:WORLD/2+Math.cos(a)*480,y:WORLD/2+Math.sin(a)*480}); }
 generateStageLayout(currentStage,spawns);
 player=makeEntity(pc,spawns[0].x,spawns[0].y,true,'あなた');
 entities.push(player);
 /* ★ 参加者はここで作る全10人（あなた＋BOT9人）だけ。バトル中に追加・復活は一切しない */
 for(let i=0;i<BOT_COUNT;i++){ const c=CHARS[Math.floor(Math.random()*CHARS.length)]; entities.push(makeEntity(c,spawns[i+1].x,spawns[i+1].y,false,names[i])); }
 winScheduled=false;
 for(let i=0;i<10;i++){ const s=stageSpot(spawns,100,600,50); if(s) cubes.push({x:s.x,y:s.y,r:11}); }
 /* ★ いきなり始まって驚かないように、まずカウントダウン画面を出す。
      3・2・1・開戦 の間はキャラもステージも見えるが、戦闘は始まらない。
      開戦 の瞬間に state='playing' にしてタイマーもそこから数える */
 state='countdown'; elapsed=0;
 countdownEndsAt=performance.now()+COUNTDOWN_MS; cdShown='';
 armCountdownWatchdog();
 cam.x=Math.max(0,Math.min(WORLD-W, player.x-W/2)); cam.y=Math.max(0,Math.min(WORLD-H, player.y-H/2));
 if(W>=WORLD) cam.x=(WORLD-W)/2; if(H>=WORLD) cam.y=(WORLD-H)/2;
 document.getElementById('startScreen').classList.add('hidden');
 stopVictoryFx(); /* 前回の優勝演出（紙吹雪・花火）が残っていたら片付ける */
 document.getElementById('endScreen').classList.add('hidden');
 document.getElementById('topbar').classList.remove('hidden');
 document.getElementById('hud').classList.remove('hidden');
 document.getElementById('pname').textContent=pc.emoji+' '+pc.name;
 document.getElementById('aliveUI').textContent=TOTAL_PLAYERS;
 const ac0=document.getElementById('aliveChip'); if(ac0) ac0.classList.remove('is-danger');
 document.getElementById('killUI').textContent='0';
 const sp=document.getElementById('stagePill'); if(sp) sp.textContent=currentStage.icon+' '+currentStage.name;
 /* ヴェラーも攻撃ボタンを使うキャラなので、攻撃ボタンは全キャラで出す */
 const tch=document.getElementById('touch'); if(tch) tch.classList.remove('no-attack');
 const cd=document.getElementById('countdown');
 if(cd){
   document.getElementById('cdStage').textContent=currentStage.icon+' ステージ：'+currentStage.name;
   document.getElementById('cdChar').textContent=pc.emoji+' '+pc.name+(pc.type==='fire'?'（'+veraModeInfo(veraModeOf(player)).name+'）':'')+' で出航！';
   document.getElementById('cdTip').textContent=currentStage.tip;
   cd.classList.remove('hidden');
 }
 feed(`${currentStage.icon} ステージは「${currentStage.name}」！ ${currentStage.tip}`);
 if(pc.type==='fist'){
   feed('🥊 ブルーノ：右・左の交互連打パンチ！長押しで離すと弧を描く爆裂旋風キック。キック中だけ飛び道具を跳ね返せる（ドンの爆弾は跳ね返せず爆発するよ）。溜め中も足は遅くならないよ');
 }
 if(pc.type==='cannon'){
   feed('💥 グスタフ：右腕の大砲で重い砲弾（215）！当たると小さく炸裂するよ。長押しで離すと破片弾5発のブロードサイド散弾。弾は2発／リロード1発1.15秒と重め');
 }
 if(pc.type==='shotgun'){
   feed('🔫 ボニー：散弾は近いほど全部当たって大火力、ゼロ距離が最高火力（390）！離れると威力が落ちるよ。長押しで離すと高速ダッシュ「ブリンクステップ」（ジャックの約1/3・ダメージなし）。溜め中も足は遅くならないよ');
 }
 if(pc.type==='breath'){
   feed('🍾 バート：攻撃ボタンを押している間ずっと火を噴くよ（毎秒約290）。連続で吐けるのは3秒まで！タップの一吹きでも息を0.35秒分使うから、連打しても息が続かないよ。息が切れたら一度離して息継ぎしてね');
 }
 if(pc.type==='scythe'){
   feed('👻 死神：幽霊の体で障害物をすり抜けられる！大鎌の弧斬りは射程150・210ダメージで近接最強クラス。ただし弾倉3発（リロードあり）。長押しで離すと地面に潜って「向いている方向」へ瞬間移動！溜めている間はワープ先にゴーストの影が出るよ。溜め中も足は遅くならないよ');
 }
 if(pc.id==='captain'){
   feed('👻 幽霊・キャプテン：サーベルで斬る（弾4発）。長押しで幽霊化！最大3.5秒、透明になって攻撃が全部すり抜け、障害物も通り抜けられる。長押し中は少しだけ足が遅くなるよ');
 }
 if(pc.type==='fire'){
   const pm=veraModeOf(player);
   feed(pm==='spiral' ? '🌀 ヴェラー（螺旋型）：長押しでゲージ満タン→炎玉3個出現、そのまま離すと回転したまま飛ぶ螺旋フレイム！弾倉は1発だけ' : '🔥 ヴェラー（ショット型）：タップで炎玉1発、ゲージ満タンで炎玉3個が出現（離しても飛ばない）');
   const botSpiral=entities.filter(e=>!e.isPlayer&&e.char.type==='fire'&&veraModeOf(e)==='spiral').length;
   const botShot=entities.filter(e=>!e.isPlayer&&e.char.type==='fire'&&veraModeOf(e)==='shot').length;
   if(botSpiral+botShot>0) feed(`🤖 BOTヴェラーは 🌀螺旋型${botSpiral}人／🔥ショット型${botShot}人（ランダム）`);
 }
}
/* カウントダウン：3・2・1・開戦 を表示し、終わったらバトル開始 */
const COUNTDOWN_MS=2500;
let countdownEndsAt=0, cdShown='';
let cdWatchdog1=0, cdWatchdog2=0;
/* カウントダウンを確実に終わらせる（冪等：countdown 中のときだけ効く）。
   通常は updateCountdown から呼ばれるが、スマホでは画面が暗転・
   バックグラウンド・省電力などで requestAnimationFrame が止まると
   updateCountdown 自体が呼ばれなくなり、「開戦」のまま固まることがある。
   そのため下のウォッチドッグ（setTimeout は rAF が止まっても発火する）からも
   ここを呼んで、必ずバトルへ進めるようにする */
function finishCountdown(){
 if(state!=='countdown') return;
 if(cdWatchdog1){ clearTimeout(cdWatchdog1); cdWatchdog1=0; }
 if(cdWatchdog2){ clearTimeout(cdWatchdog2); cdWatchdog2=0; }
 const cd=document.getElementById('countdown'); if(cd) cd.classList.add('hidden');
 state='playing'; startTime=performance.now(); elapsed=0;
 feed(netOnlineMode?`🏁 バトル開始！全${TOTAL_PLAYERS}人、最後の1人まで生き残れ！`:`🏁 バトル開始！全${TOTAL_PLAYERS}人（あなた＋BOT${BOT_COUNT}人）、最後の1人まで生き残れ！`);
}
/* カウントダウン開始時に呼ぶ見張りタイマー。rAF が止まって
   updateCountdown が進まなくても、期限を過ぎたら強制的に開始する。
   2段構え（+0.9秒／さらに+1.8秒）で、1回目が何かに阻まれても必ず進める */
function armCountdownWatchdog(){
 if(cdWatchdog1) clearTimeout(cdWatchdog1);
 if(cdWatchdog2) clearTimeout(cdWatchdog2);
 const delay=Math.max(0,(countdownEndsAt-performance.now()))+900;
 cdWatchdog1=setTimeout(()=>{ if(state==='countdown') finishCountdown(); },delay);
 cdWatchdog2=setTimeout(()=>{ if(state==='countdown') finishCountdown(); },delay+1800);
}
function updateCountdown(){
 const remain=countdownEndsAt-performance.now();
 const label=remain>1660?'3':remain>830?'2':remain>120?'1':'開戦';
 if(label!==cdShown){
   cdShown=label;
   /* 効果音で例外が出てもカウントダウンの進行を止めない */
   try{ if(typeof SFX!=='undefined'&&SFX) SFX.play(label==='開戦'?'go':'beep'); }catch(_){ } /* 3・2・1はピッ、開戦はファンファーレ気味 */
   const el=document.getElementById('cdNum');
   if(el){ el.textContent=label; el.classList.toggle('go',label==='開戦'); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
 }
 if(remain<=-450) finishCountdown(); /* 開戦 を少し見せてから開始 */
}
function feed(t){ const el=document.getElementById('killfeed'); const d=document.createElement('div'); d.textContent=t; el.prepend(d); setTimeout(()=>d.remove(),3800); while(el.children.length>4) el.lastChild.remove(); }

function damage(target,amt,attacker){
 if(!target.alive) return;
 /* 攻撃がすり抜ける状態：死神が地面に潜っている間（テレポート中）と、
    幽霊・キャプテンの幽霊化中は、あらゆる攻撃が透過して当たらない */
 if(target.tpT>0||isGhost(target)) return;
 target.hp-=amt; target.hitFlash=0.12;
 /* ダメージを受けたら回復タイマーはリセット。与えた側も「戦闘中」なので同じくリセット */
 target.lastCombat=0; target.isRegen=false;
 if(attacker&&attacker!==target){ attacker.lastCombat=0; attacker.isRegen=false; }
 floaters.push({x:target.x+rand(-10,10),y:target.y-28,text:Math.round(amt),life:0.7,color:target.isPlayer?'#ff6b81':'#fff'});
 /* 効果音：自分が食らったら「被弾」、自分が当てたら「ヒット」。BOT同士は鳴らさない */
 if(target.isPlayer) playSfx('hurt'); else if(attacker&&attacker.isPlayer) playSfx('hit');
 if(target.hp<=0){ target.alive=false; target.hp=0; if(target.isPlayer||(attacker&&attacker.isPlayer)) playSfx('die',target); if(attacker){attacker.kills++; if(attacker.isPlayer) feed('💀 敵を倒した！ +パワーキューブ'); }
   for(let i=0;i<2;i++) cubes.push({x:target.x+rand(-25,25),y:target.y+rand(-25,25),r:11});
   burst(target.x,target.y,target.char.color,18);
   if(target.isPlayer) feed('💀 あなたは倒れた…'); else feed(`💀 ${target.name} が倒れた`);
   if(target.isPlayer) setTimeout(endGame,900);
   checkWin();
 }
}
function burst(x,y,color,n){ for(let i=0;i<n;i++) particles.push({x,y,vx:rand(-160,160),vy:rand(-160,160),life:rand(.3,.7),max:.7,color,size:rand(2,6)}); }
/* ★ クリア判定：残りがプレイヤーだけ（＝他の9人全員がいなくなった）ら優勝で終了。
   damage／毒死のたびに加えて update() からも毎フレーム呼ばれるので、
   どんな倒れ方でも見落とさず必ずクリアになる。二重予約は winScheduled で防ぐ */
function checkWin(){ if(winScheduled) return; const alive=entities.filter(e=>e.alive); if(alive.length===1 && alive[0].isPlayer){ winScheduled=true; setTimeout(endGame,600); } }
/* ============================================================
   優勝演出（1位のときだけ派手に）：紙吹雪が画面いっぱいに舞い、花火が上がり、
   トロフィーが弾んでパネルが金色に光る（アニメーション本体は game.css）。
   2位以下では一切出さない。紙吹雪・花火の粒はここで生成し、
   次のバトル開始（startGame）で必ず片付ける。
   ============================================================ */
function launchVictoryFx(){
 const fx=document.getElementById('victoryFx'); if(!fx) return;
 fx.innerHTML='';
 const colors=['#ffc93c','#ff4757','#2ed573','#25a6e8','#ff7b1c','#fff7e6'];
 for(let i=0;i<90;i++){ /* 紙吹雪：色・大きさ・位置・落下速度・横流れ・回転を1枚ずつ変える */
   const s=document.createElement('i'); s.className='confetti-piece';
   const size=6+Math.random()*7;
   s.style.left=(Math.random()*100)+'%';
   s.style.width=size+'px';
   s.style.height=(Math.random()<0.4?size:size*0.45)+'px';
   s.style.background=colors[i%colors.length];
   if(Math.random()<0.3) s.style.borderRadius='50%';
   s.style.setProperty('--drift',Math.round(Math.random()*120-60)+'px');
   s.style.setProperty('--spin',Math.round(360+Math.random()*540)+'deg');
   s.style.animationDuration=(2.6+Math.random()*2.2)+'s';
   s.style.animationDelay=(Math.random()*1.4)+'s';
   fx.appendChild(s);
 }
 for(let f=0;f<5;f++){ /* 花火：画面の上の方で順番に打ち上がる */
   const fw=document.createElement('div'); fw.className='firework';
   fw.style.left=(12+Math.random()*76)+'%';
   fw.style.top=(8+Math.random()*32)+'%';
   const delay=(0.3*f+Math.random()*0.35).toFixed(2)+'s';
   for(let k=0;k<10;k++){
     const sp=document.createElement('i');
     sp.style.background=colors[(f+k)%colors.length];
     sp.style.setProperty('--rot',(k*36)+'deg');
     sp.style.setProperty('--fw-dist',Math.round(34+Math.random()*28)+'px');
     sp.style.animationDelay=delay;
     fw.appendChild(sp);
   }
   fx.appendChild(fw);
 }
}
function stopVictoryFx(){
 const fx=document.getElementById('victoryFx'); if(fx) fx.innerHTML='';
 const es=document.getElementById('endScreen'); if(es) es.classList.remove('is-victory');
 const vb=document.getElementById('victoryBanner'); if(vb) vb.classList.add('hidden');
}
function endGame(){
 if(state!=='playing') return; state='ended';
 const aliveCount=entities.filter(e=>e.alive).length;
 /* オンライン対戦では、ホストが確定させた順位（netMyPlace）があればそれを使う
    （自分が倒れたあとも試合が続くため、その場の残り人数では数えられない） */
 const p=netMyPlace>0?netMyPlace:(player.alive?1:Math.min(TOTAL_PLAYERS,aliveCount+1));
 document.getElementById('endEmoji').textContent=p===1?'🏆':'💀';
 document.getElementById('endTitle').textContent=p===1?'優勝！海賊王だ！': p+'位でフィニッシュ';
 document.getElementById('endSub').textContent=p===1?(netOnlineMode?'やったね！友達とBOTの中で最後まで生き残った！':`やったね！${BOT_COUNT}人のBOTの中で最後まで生き残った！`):'あと少しだったね。キャラや立ち回りを変えて再挑戦しよう！';
 /* ガチャ用コインの報酬：順位が上なほど多く、キルでも少し増える */
 const coinReward=(TOTAL_PLAYERS-p)*25 + player.kills*20 + (p===1?100:0);
 if(typeof earnCoins==='function') earnCoins(coinReward);
 document.getElementById('rPlace').textContent=p+'位'; document.getElementById('rKills').textContent=player.kills; document.getElementById('rTime').textContent=fmt(elapsed);
 const rc=document.getElementById('rCoins'); if(rc) rc.textContent='+'+coinReward;
 /* ★ 優勝演出は1位のときだけ：紙吹雪＋花火＋トロフィーの弾み＋「10人中1位」バナー。
      2位以下は今まで通りの静かな結果画面 */
 const es=document.getElementById('endScreen');
 if(typeof SFX!=='undefined'&&SFX) SFX.play(p===1?'victory':'defeat'); /* 優勝はファンファーレ、敗北はしぼむ音 */
 if(p===1){
   es.classList.add('is-victory');
   document.getElementById('victoryBanner').classList.remove('hidden');
   es.classList.remove('hidden');
   launchVictoryFx();
 } else {
   stopVictoryFx();
   es.classList.remove('hidden');
 }
}

/* 通常攻撃。遠距離キャラは弾（ammo）を消費し、撃ったら1発ずつリロードする。
   ジャックは近接なので弾もリロードもなし（ammo=0 のキャラは無制限）。 */
function attack(e,targetAngle){
 /* ヴェラの通常攻撃は下の type:'fire' 分岐で炎玉1個を撃つ */
 if(e.cool>0||!e.alive||e.dashT>0||e.tpT>0||isGhost(e)) return false; /* 潜っている間・幽霊化中は攻撃できない */
 /* ★バートの連打対策：タップの一吹きでも息（燃料）が必要。息切れ中か、
    息が一吹き分（breathPuff）未満なら火は出ない。息が全ての発火の上限に
    なるので、ボタンを連打しても息継ぎの回復速度以上には打てない */
 if(e.char.type==='breath'&&(e.breathOver||e.breathFuel<(e.char.breathPuff||0.35))) return false;
 if(targetAngle==null) targetAngle=autoAimAngle(e); /* オートエイム */
 if(e.char.ammo>0){ if(e.ammo<=0) return false; e.ammo--; if(e.reloadT<=0) e.reloadT=e.char.reload; }
 e.cool=e.char.rate; e.angle=targetAngle; e.swing=0.22;
 /* 攻撃したら回復タイマーはリセット（空振り・宝箱狙いでも同じ。当て続けている間は回復しない） */
 e.lastCombat=0; e.isRegen=false;
 const dmg=e.char.dmg*(1+e.power*POWER_DMG_PER_CUBE);
 /* 効果音：攻撃の種類ごとに音を変える（剣の風切り／パンチ／矢／炎玉／大砲／爆弾） */
 if(e.char.type==='fist') playSfx('punch',e);
 else if(e.char.type==='melee') playSfx('swing',e);
 else if(e.char.type==='scythe') playSfx('swing',e);
 else if(e.char.type==='gun') playSfx('shoot',e);
 else if(e.char.type==='fire') playSfx('fire',e);
 else if(e.char.type==='cannon') playSfx('cannon',e);
 else if(e.char.type==='shotgun') playSfx('scatter',e);
 else if(e.char.type==='breath') playSfx('fire',e);
 else playSfx('bomb',e);
 if(e.char.type==='fist'){ /* ブルーノ：素手の連打。右手・左手を交互に出す（オラオラ！）。
      出した手は e.lastPunch に残し、描画でその側の拳が前に伸びる。
      当たり判定はジャックの剣と同じ前方扇形だが、射程は少しだけ長い */
   const side=e.punchSide||0; e.lastPunch=side; e.punchSide=side?0:1;
   const off=(side?1:-1)*0.55; /* 右手は進行方向の右寄り、左手は左寄りから出る */
   entities.forEach(t=>{ if(t!==e&&t.alive&&dist(e,t)<e.char.range+t.r&&Math.abs(angDiff(targetAngle,angleTo(e,t)))<1.15) damage(t,dmg,e); });
   crates.forEach(c=>{ if(c.alive&&dist(e,c)<e.char.range+c.r) hitCrate(c,dmg,e); });
   const px=e.x+Math.cos(targetAngle)*58-Math.sin(targetAngle)*off*16, py=e.y+Math.sin(targetAngle)*58+Math.cos(targetAngle)*off*16;
   particles.push({x:px,y:py,vx:Math.cos(targetAngle)*50,vy:Math.sin(targetAngle)*50,life:.14,max:.14,color:side?'#ffd9a0':'#fff',size:13,slash:true,angle:targetAngle});
   burst(px,py,side?'#ffc93c':'#ffe9a8',2);
 } else if(e.char.type==='melee'||e.char.type==='scythe'){ /* ジャックの剣／死神の大鎌：前方の扇形斬り。
      死神の鎌は刃が大きい分、弧が少し広い（1.35）。射程はキャラ性能（range）通り */
   const arc=e.char.type==='scythe'?1.35:1.1;
   entities.forEach(t=>{ if(t!==e&&t.alive&&dist(e,t)<e.char.range+t.r&&Math.abs(angDiff(targetAngle,angleTo(e,t)))<arc) damage(t,dmg,e); });
   crates.forEach(c=>{ if(c.alive&&dist(e,c)<e.char.range+c.r) hitCrate(c,dmg,e); });
   particles.push({x:e.x+Math.cos(targetAngle)*55,y:e.y+Math.sin(targetAngle)*55,vx:Math.cos(targetAngle)*40,vy:Math.sin(targetAngle)*40,life:.18,max:.18,color:e.char.type==='scythe'?'#bfefff':'#fff',size:18,slash:true,angle:targetAngle});
 } else if(e.char.type==='gun'){
   bullets.push({x:e.x,y:e.y,vx:Math.cos(targetAngle)*620,vy:Math.sin(targetAngle)*620,r:6,dmg,owner:e,life:0.6,color:'#ffeaa7',type:'bullet'});
 } else if(e.char.type==='fire'){ /* ヴェラ通常攻撃：炎玉を1個撃つ（射程320／速さ560） */
   bullets.push({x:e.x,y:e.y,vx:Math.cos(targetAngle)*560,vy:Math.sin(targetAngle)*560,r:11,dmg,owner:e,life:0.58,color:'#ff7b1c',type:'fireball'});
 } else if(e.char.type==='cannon'){ /* グスタフ通常攻撃：右腕の大砲から重い砲弾（射程305／速さ540）。
      当たると小さく炸裂する（判定は update() の cannonball 分岐） */
   bullets.push({x:e.x,y:e.y,vx:Math.cos(targetAngle)*540,vy:Math.sin(targetAngle)*540,r:12,dmg,owner:e,life:0.57,color:'#2d3436',type:'cannonball'});
   burst(e.x+Math.cos(targetAngle)*34,e.y+Math.sin(targetAngle)*34,'#cfd6dd',5); shake=Math.max(shake,2.5);
 } else if(e.char.type==='shotgun'){ /* ボニー通常攻撃：散弾 pellets 発を扇形に同時発射。
      1発の威力は pelletDmg（上の dmg は表示用の最大合計なので使わない）。
      ★ 距離減衰は update() の sgpellet 判定で「飛んだ距離」から計算する：
        ゼロ距離＝係数1.0（最高火力）、射程端＝0.38。近いほど多く当たる
        散らばり方と合わせて、二重に「近いほど強い」になる */
   const n=e.char.pellets||6, pd=(e.char.pelletDmg||55)*(1+e.power*POWER_DMG_PER_CUBE);
   for(let i=0;i<n;i++){ const aa=targetAngle+(i-(n-1)/2)*0.11;
     bullets.push({x:e.x,y:e.y,vx:Math.cos(aa)*640,vy:Math.sin(aa)*640,r:5,dmg:pd,owner:e,life:0.34,color:'#ffd9a0',type:'sgpellet',sx:e.x,sy:e.y,maxR:e.char.range}); }
   burst(e.x+Math.cos(targetAngle)*30,e.y+Math.sin(targetAngle)*30,'#ffc93c',6); shake=Math.max(shake,3);
 } else if(e.char.type==='breath'){ /* バートのタップ（短い一吹き）：ブレス1回分だけ扇形に焼く。
      ★ 一吹きでも息を breathPuff（0.35秒分）消費する。以前はタップでは息が
        ほとんど減らず、連打すれば無限に火を出し続けられた。使い切れば
        息切れになり、回復するまで吐けない。
      押し続けた場合の継続ブレスは update() 側（isBreathing 中の breathHit 連続判定） */
   e.breathFuel=Math.max(0,e.breathFuel-(e.char.breathPuff||0.35));
   e.breathTickT=Math.max(e.breathTickT||0,e.char.breathTick||0.11); /* 押し続けに移行しても直後に二重で当たらないように */
   if(e.breathFuel<=0) e.breathOver=true;
   breathHit(e);
 } else {
   bullets.push({x:e.x,y:e.y,vx:Math.cos(targetAngle)*380,vy:Math.sin(targetAngle)*380,r:13,dmg,owner:e,life:0.75,color:'#2d3436',type:'bomb'});
 }
 return true;
}
/* 溜め攻撃：長押しが chargeTime 秒に達してから離すと発動。短押しは通常攻撃。
   input.js から呼ばれる（プレイヤー専用の入り口）。 */
function beginHold(){ if(player&&state==='playing'&&player.alive){ player.holding=true; player.chargeT=0;
 /* バート：押し始めの瞬間に継続ブレスの最初の判定が来ないようにする。
    これで「短いタップ＝一吹き（息を消費）」「長押し＝継続ブレス」がきれいに分かれる */
 if(player.char.type==='breath') player.breathTickT=Math.max(player.breathTickT||0,player.char.breathTick||0.11); } }
function endHold(){
 if(!player||state!=='playing'||!player.alive||!player.holding) return;
 /* オンラインのゲスト：離した操作はホストへ送るだけ。ここで攻撃を
    実行してしまうと二重に攻撃したことになるので、見た目の状態だけ戻す */
 if(netGuestMode){ player.holding=false; player.chargeT=0; return; }
 player.holding=false;
 if(player.char.type==='breath'){
   /* バート：長押し＝吐き続けること自体が攻撃（update の継続ブレス）。
      離したら止まるだけ。ただし継続ブレスの最初の判定（breathTick 秒）が
      来る前に離した短いタップでは、火が1回も出ていないので一吹き分だけ
      attack() する（息の消費と息切れチェックは attack() 側でやる） */
   if(player.chargeT<(player.char.breathTick||0.11)) attack(player,autoAimAngle(player));
   player.chargeT=0;
   return;
 }
 if(player.char.id==='captain'){
   /* 幽霊・キャプテン：長押し＝幽霊化そのもの（update の幽霊化処理）。
      満タンまで溜めた（＝幽霊化していた）場合は離しても攻撃しない。
      短いタップのときだけサーベルで斬る */
   if(player.chargeT<player.char.chargeTime) attack(player,autoAimAngle(player));
   player.chargeT=0;
   return;
 }
 const full=player.chargeT>=player.char.chargeTime;
 if(player.char.type==='fire'){
   /* ヴェラーはモードで離したときの挙動が変わる：
      案1（螺旋型）：満タンで離す→螺旋フレイム。タップ（短押し）では何も撃たない
      案2（ショット型）：離しても螺旋は飛ばない。タップ（満タン未満）→炎玉1発。
        満タンまで溜めたら炎玉3個が出ていた状態なので、離すと消えるだけ */
   if(veraModeOf(player)==='spiral'){ if(full) chargeAttack(player,autoAimAngle(player,chargeSearchRange(player))); }
   else if(!full) attack(player,autoAimAngle(player));
   player.chargeT=0;
   return;
 }
 /* 攻撃は全デバイス共通でオートエイム：射程内の一番近い敵を自動で狙う */
 if(full) chargeAttack(player,autoAimAngle(player,chargeSearchRange(player))); else attack(player,autoAimAngle(player));
 player.chargeT=0;
}
function nearestEnemy(e){ let t=null,b=1e9; entities.forEach(en=>{ if(en!==e&&en.alive){ const d=dist(e,en); if(d<b){b=d;t=en;} } }); return t; }
/* オートエイム：射程内にいる一番近い敵を返す。敵がいなければ射程内の一番近い宝箱。
   どちらもいなければ null（その場合は今向いている方向＝進行方向に攻撃する）。 */
function autoAimTarget(e,searchRange){
 const R=searchRange||e.char.range, margin=e.char.type==='melee'?0:20;
 let best=null,bd=1e9;
 entities.forEach(t=>{ if(t!==e&&t.alive){ const d=dist(e,t); if(d<R+t.r+margin&&d<bd){bd=d;best=t;} } });
 if(best) return best;
 let bc=null,cd=1e9;
 crates.forEach(c=>{ if(c.alive){ const d=dist(e,c); if(d<R+c.r&&d<cd){cd=d;bc=c;} } });
 return bc;
}
function autoAimAngle(e,searchRange){ const t=autoAimTarget(e,searchRange); return t?angleTo(e,t):e.angle; }
/* 溜め攻撃の索敵範囲：ジャックのダッシュ到達距離／ルビーの貫通矢の届く距離に合わせる */
function chargeSearchRange(e){ return e.char.id==='ruby'?540:(e.char.id==='vera'?400:(e.char.id==='bruno'?((e.char.kickRange||69)+54):(e.char.id==='bart'?(e.char.range+40):330))); }
function chargeReady(e){ return e.chargeT>=e.char.chargeTime; }
function chargeAttack(e,aim){
 /* ヴェラの溜めは下の id:'vera' 分岐（螺旋フレイム） */
 if(e.char.type==='breath') return false; /* バートに溜め攻撃はない（長押し＝継続ブレス） */
 if(e.char.id==='captain') return false; /* 幽霊・キャプテンに溜め攻撃はない（長押し＝幽霊化） */
 if(e.tpT>0) return false; /* 死神が地面に潜っている間は発動しない */
 if(aim==null) aim=autoAimAngle(e,chargeSearchRange(e)); /* オートエイム */
 if(e.char.id==='reaper') aim=e.angle; /* ★死神のテレポートは「向いている方向」へ。オートエイムで行き先を曲げない */
 /* ★ 溜め攻撃も通常攻撃と同じく弾を1発消費する（リロードのあるキャラだけ）。
      弾がなければ発動しない。ジャックは近接で ammo=0 なので消費なし。
      ★例外：ボニーのブリンクステップと死神のテレポートは「撃つ」技では
        ない（純粋な移動技）ので弾を消費しない */
 if(e.char.ammo>0&&e.char.id!=='bonnie'&&e.char.id!=='reaper'){ if(e.ammo<=0) return false; e.ammo--; if(e.reloadT<=0) e.reloadT=e.char.reload; }
 e.angle=aim; e.swing=0.22;
 e.lastCombat=0; e.isRegen=false; /* 溜め攻撃も戦闘行動：回復タイマーをリセット */
 const pw=1+e.power*POWER_DMG_PER_CUBE;
 if(e.char.id==='jack'){ /* 疾風ダッシュ斬り：数メートルを高速で駆け抜け、通り道の敵にダメージ */
   e.dashT=0.30; e.dashDir=aim; e.dashHit=new Set(); e.cool=Math.max(e.cool,0.3);
   burst(e.x,e.y,'#ffc93c',10);
 } else if(e.char.id==='reaper'){ /* 冥府潜りテレポート：ダッシュではなく瞬間移動。
      まず地面に潜り（tpPhase='sink'）、向いている方向（aim は上で e.angle に
      固定済み）へ TP_DIST 先の地面から現れる（tpPhase='emerge'）。
      潜っている間の移動と出現は update() のテレポート処理が担当する。
      ダメージはなく、弾も消費しない（純粋な移動技） */
   e.tpPhase='sink'; e.tpT=TP_SINK; e.tpAge=0;
   const dest=tpDest(e,aim); /* 溜め中のマーカーと同じ計算（ずれない） */
   e.tpX=dest.x; e.tpY=dest.y; e.cool=Math.max(e.cool,0.3);
   burst(e.x,e.y,'#8ef6ff',10); burst(e.x,e.y,'#4a3566',8);
 } else if(e.char.id==='ruby'){ /* 貫通パワーボルト：敵を貫く太い矢（弾は上で1発消費済み） */
   bullets.push({x:e.x,y:e.y,vx:Math.cos(aim)*780,vy:Math.sin(aim)*780,r:10,dmg:e.char.chargeDmg*pw,owner:e,life:0.85,color:'#ff6b81',type:'powerbolt',hitSet:new Set()});
   shake=Math.max(shake,4);
 } else if(e.char.id==='don'){ /* 特大メガボム */
   bullets.push({x:e.x,y:e.y,vx:Math.cos(aim)*330,vy:Math.sin(aim)*330,r:22,dmg:e.char.chargeDmg*pw,owner:e,life:0.8,color:'#111',type:'megabomb'});
   shake=Math.max(shake,5);
 } else if(e.char.id==='bruno'){ /* 爆裂旋風キック：足技。直線ではなく弧の軌道で、
      足が kickDir の左右約43度ずつ（合計約86度）を振り抜ける。ダメージは
      ここでは与えず、update() のスイープ判定で「足が通過した相手」に
      1回だけ 360 ダメージ。少し踏み込んで蹴るので体もわずかに前へ出る。
      ★ キック中（kickT の間）だけ、足に触れた遠距離攻撃を跳ね返せる
        （ドンの爆弾だけは跳ね返せず爆発する。判定は update() の弾処理） */
   e.kickT=KICK_DUR; e.kickDur=KICK_DUR; e.kickDir=aim; e.kickHit=new Set(); e.kickCrateHit=new Set(); e.cool=Math.max(e.cool,0.25);
   e.x+=Math.cos(aim)*24; e.y+=Math.sin(aim)*24;
   burst(e.x+Math.cos(aim-KICK_SWEEP/2)*70,e.y+Math.sin(aim-KICK_SWEEP/2)*70,'#ffc93c',5);
 } else if(e.char.id==='gustav'){ /* ブロードサイド散弾：破片弾5発を扇形（左右に少しずつ散らして）
      同時発射。1発115ダメージ。近いほど多く当たって大ダメージ、遠いほど当たる数が減る。
      破片弾は通常の弾と同じ判定（貫通なし・障害物で止まる・ブルーノのキックで跳ね返せる） */
   for(let i=-2;i<=2;i++){ const aa=aim+i*0.16; bullets.push({x:e.x,y:e.y,vx:Math.cos(aa)*560,vy:Math.sin(aa)*560,r:8,dmg:e.char.chargeDmg*pw,owner:e,life:0.55,color:'#2d3436',type:'pellet'}); }
   burst(e.x+Math.cos(aim)*36,e.y+Math.sin(aim)*36,'#cfd6dd',10); burst(e.x+Math.cos(aim)*36,e.y+Math.sin(aim)*36,'#ffc93c',6);
   shake=Math.max(shake,5);
 } else if(e.char.id==='vera'){ /* トリプル螺旋フレイム：3個がバラバラにうねるのではなく、
      「回転する隊形のまま」飛んでいく。中心(cx,cy)は狙った方向へまっすぐ進み、
      3個はその中心の周りを同じ半径・同じ速さで回り続ける（貫通） */
   const n=e.char.fireCount||3, R=e.char.fireOrbit||54;
   for(let i=0;i<n;i++){
     const phase=i*Math.PI*2/n, a=e.flameAngle+phase;
     bullets.push({x:e.x+Math.cos(a)*R,y:e.y+Math.sin(a)*R,vx:Math.cos(aim)*470,vy:Math.sin(aim)*470,r:e.char.fireBallR||15,dmg:e.char.chargeDmg*pw,owner:e,life:0.78,color:'#ff7b1c',type:'spiral',hitSet:new Set(),t:0,phase,dx:Math.cos(aim),dy:Math.sin(aim),cx:e.x,cy:e.y,orbitR:R,rot:e.flameAngle,rotSpeed:9.5});
   }
   shake=Math.max(shake,4);
 } else if(e.char.id==='bonnie'){ /* ブリンクステップ：以前は瞬間移動だったが、
      「ジャックと同じように高速で移動してほしい」という要望で高速ダッシュに変更。
      ジャックのダッシュ斬りと同じ仕組み（dashT 中は速度980で駆け抜ける）だが、
      時間は 0.30秒→0.10秒 で距離は約1/3＝約100px。
      ★ ダッシュ斬りと違い、通り道で敵とぶつかってもダメージは一切与えない
        （純粋な移動技。update() のダッシュ処理で shotgun はダメージ判定をしない） */
   e.dashT=0.10; e.dashDir=aim; e.dashHit=new Set(); e.cool=Math.max(e.cool,0.25);
   burst(e.x,e.y,'#c39bd3',8); burst(e.x,e.y,'#ffe9a8',4);
 }
 /* 効果音：溜め攻撃もキャラごとに音を変える */
 if(e.char.id==='jack') playSfx('dash',e);
 else if(e.char.id==='reaper') playSfx('sink',e);
 else if(e.char.id==='bonnie') playSfx('dash',e);
 else if(e.char.id==='ruby') playSfx('powerbolt',e);
 else if(e.char.id==='don') playSfx('bomb',e);
 else if(e.char.id==='bruno') playSfx('kick',e);
 else if(e.char.id==='gustav') playSfx('scatter',e);
 else if(e.char.id==='vera') playSfx('spiral',e);
 if(e.isPlayer) feed('💥 溜め攻撃！ '+e.char.chargeName);
}
function hitCrate(c,amt,e){ c.hp-=amt; if(c.hp<=0&&c.alive){c.alive=false; cubes.push({x:c.x,y:c.y,r:11}); burst(c.x,c.y,'#d29b4a',12);} }
/* 爆発：範囲内の全員（投げた本人も含む）にダメージ。敵のすぐそばで爆発させると
   自分も爆風を食らうので、ドンは距離を取って投げるのが大事（仕様として意図的に自爆あり） */
function explode(b){ const R=b.type==='megabomb'?125:85; playSfxAt('explode',b.x,b.y); entities.forEach(t=>{if(t.alive&&dist(b,t)<R+t.r) damage(t,b.dmg,b.owner)}); crates.forEach(c=>{if(c.alive&&dist(b,c)<R) hitCrate(c,b.dmg,b.owner)}); burst(b.x,b.y,'#ff7675',22); burst(b.x,b.y,'#ffc93c',14); shake=Math.max(shake,6); }
/* グスタフの砲弾の炸裂：ドンの爆弾（半径85）より小さい半径58の爆風。
   直撃した相手も周りも同じダメージ（投げた本人も近すぎれば食らう） */
function explodeCannon(b){ const R=58; playSfxAt('explodeSmall',b.x,b.y); entities.forEach(t=>{if(t.alive&&dist(b,t)<R+t.r) damage(t,b.dmg,b.owner)}); crates.forEach(c=>{if(c.alive&&dist(b,c)<R) hitCrate(c,b.dmg,b.owner)}); burst(b.x,b.y,'#ff9f43',14); burst(b.x,b.y,'#57606e',8); shake=Math.max(shake,4); }
function angDiff(a,b){ let d=a-b; while(d>Math.PI)d-=Math.PI*2; while(d<-Math.PI)d+=Math.PI*2; return d; }

function botAI(e,dt){
 e.think-=dt; e.botChargeCd-=dt;
 const dz=dist(e,zone); let moveX=0,moveY=0; let target=null; let best=1e9;
 entities.forEach(t=>{if(t!==e&&t.alive){const d=dist(e,t); if(d<best){best=d;target=t}}});
 if(e.think<=0){ e.think=rand(.2,.5); const a=rand(0,6.28); e.tx=e.x+Math.cos(a)*120; e.ty=e.y+Math.sin(a)*120; }
 /* ヴェラー（BOT）はモードがランダム（makeEntity で決定）：
    ショット型はタップ相当の炎玉1発を撃ち、螺旋型は撃たずに近づく。
    どちらのモードも長押しでゲージが満タンになって初めて炎玉3個が出現し、
    しばらく炎玉をまとって近づいて戦ってから、螺旋型だけが離して螺旋を放つ */
 /* 溜め中は足を止めて狙い、たまったら溜め攻撃を放つ（ヴェラーは下の専用分岐） */
 if(e.holding){
   if(target){ e.angle=angleTo(e,target); }
   if(e.char.type==='fire'){
     /* ★ヴェラーは溜めている間も足が遅くならない：ゲージがたまる前も満タン後も通常の速さで動く */
     if(chargeReady(e)){ /* ゲージ満タン＝炎玉3個が出現中。まとったまま敵へ近づく */
       if(e.botOrbT==null) e.botOrbT=rand(0.7,1.7);
       e.botOrbT-=dt;
       if(target&&best>e.r+target.r+6){ const a=angleTo(e,target); e.vx=Math.cos(a)*e.char.speed; e.vy=Math.sin(a)*e.char.speed; }
       else { e.vx*=0.2; e.vy*=0.2; }
       if(e.botOrbT<=0){
         const mode=veraModeOf(e);
         e.holding=false; e.chargeT=0; e.botOrbT=null;
         if(mode==='spiral') chargeAttack(e); /* 案1だけ：離して螺旋フレイム（オートエイム） */
         /* 案2は離しても何も飛ばない：炎玉が消えるだけ */
       }
     } else if(target){ /* 溜め途中も通常の速さで敵へ近づく（毒ゾーン内なら中心へ） */
       const dz2=dist(e,zone);
       const gx=dz2>zone.r-40?zone.x:target.x, gy=dz2>zone.r-40?zone.y:target.y;
       const a=Math.atan2(gy-e.y,gx-e.x); e.vx=Math.cos(a)*e.char.speed; e.vy=Math.sin(a)*e.char.speed;
     } else { e.vx*=0.2; e.vy*=0.2; }
     return;
   }
   if(e.char.type==='fist'){
     /* ★ブルーノも溜めている間は足が遅くならない：通常の速さで間合いを詰め、
        キックのリーチに入ったままゲージが満タンになったら蹴りを放つ */
     if(chargeReady(e)){ e.holding=false; e.chargeT=0; chargeAttack(e); /* オートエイム */ return; }
     if(target){
       const dz2=dist(e,zone);
       const gx=dz2>zone.r-40?zone.x:target.x, gy=dz2>zone.r-40?zone.y:target.y;
       const a=Math.atan2(gy-e.y,gx-e.x); e.vx=Math.cos(a)*e.char.speed; e.vy=Math.sin(a)*e.char.speed;
     } else { e.vx*=0.2; e.vy*=0.2; }
     return;
   }
   if(e.char.type==='breath'){
     /* バート（BOT）：holding＝火を吐いている状態。継続ブレスの判定と燃料の
        増減は update() 側。ここでは「吐きながら間合いを保つ」動きだけする。
        息切れ（breathOver）か燃料切れになったら離して息継ぎモードへ */
     if(!isBreathing(e)){ e.holding=false; e.chargeT=0; e.vx*=0.2; e.vy*=0.2; return; }
     if(target&&best>e.char.range*0.55){ const a=angleTo(e,target); e.vx=Math.cos(a)*e.char.speed*0.7; e.vy=Math.sin(a)*e.char.speed*0.7; }
     else { e.vx*=0.2; e.vy*=0.2; }
     return;
   }
   if(e.char.type==='shotgun'){
     /* ボニー（BOT）：溜めている間も足は遅くならない。通常の速さで敵へ
        詰め、ゲージが満タンになったらブリンクステップで一気に近づく */
     if(chargeReady(e)){ e.holding=false; e.chargeT=0; chargeAttack(e); /* オートエイム（敵の方向へ高速ダッシュ） */ return; }
     if(target){
       const dz2=dist(e,zone);
       const gx=dz2>zone.r-40?zone.x:target.x, gy=dz2>zone.r-40?zone.y:target.y;
       const a=Math.atan2(gy-e.y,gx-e.x); e.vx=Math.cos(a)*e.char.speed; e.vy=Math.sin(a)*e.char.speed;
     } else { e.vx*=0.2; e.vy*=0.2; }
     return;
   }
   if(e.char.type==='scythe'){
     /* 死神（BOT）：溜めている間も足は遅くならない。通常の速さで敵へ詰め、
        ゲージが満タンになったらテレポートで一気に間合いを詰める
        （行き先は「向いている方向」＝この分岐の先頭で敵に向けた角度） */
     if(chargeReady(e)){ e.holding=false; e.chargeT=0; chargeAttack(e); return; }
     if(target){
       const dz2=dist(e,zone);
       const gx=dz2>zone.r-40?zone.x:target.x, gy=dz2>zone.r-40?zone.y:target.y;
       const a=Math.atan2(gy-e.y,gx-e.x); e.vx=Math.cos(a)*e.char.speed; e.vy=Math.sin(a)*e.char.speed;
     } else { e.vx*=0.2; e.vy*=0.2; }
     return;
   }
   if(e.char.id==='captain'){
     /* 幽霊・キャプテン（BOT）：ゲージ満タンで幽霊化。幽霊のまま敵へ近づき
        （移動は長押し中の速さ＝0.65倍と緩やかな減速）、サーベルの間合いに
        入ったら解除して斬る。幽霊化を使い切ったら update() 側で強制解除
        される。ピンチのときは幽霊のまま敵から離れて逃げる */
     if(e.ghostOver){ e.holding=false; e.chargeT=0; return; }
     if(isGhost(e)&&target&&best<e.char.range+8){ e.holding=false; e.chargeT=0; attack(e); return; }
     let gx2=target?target.x:zone.x, gy2=target?target.y:zone.y;
     if(dz>zone.r-40){ gx2=zone.x; gy2=zone.y; }
     else if(e.hp<maxHpOf(e)*0.3&&target&&best<220){ gx2=e.x-(target.x-e.x); gy2=e.y-(target.y-e.y); }
     const a2=Math.atan2(gy2-e.y,gx2-e.x), sp2=e.char.speed*0.65;
     e.vx=Math.cos(a2)*sp2; e.vy=Math.sin(a2)*sp2;
     return;
   }
   if(chargeReady(e)){ e.holding=false; e.chargeT=0; chargeAttack(e); /* オートエイム */ }
   e.vx*=0.2; e.vy*=0.2; return;
 }
 if(dz>zone.r-40){ moveX=zone.x-e.x; moveY=zone.y-e.y; }
 else if(target&&best<380){ const lowHp=e.hp<maxHpOf(e)*0.35; /* HPが残り35%を切ったら逃げ腰になる（キャラごとに違う絶対値ではなく割合で判定） */
   if(best>e.char.range*0.75){moveX=target.x-e.x;moveY=target.y-e.y;} else if(lowHp){moveX=e.x-target.x;moveY=e.y-target.y;} else {moveX=-(target.y-e.y)*.4; moveY=(target.x-e.x)*.4;}
   /* ブルーノのキック：脚を半分に短くしたので、キックの実効圏内（脚69＋当たり判定の余裕）なら溜め始める */
   if(e.char.type==='fist'&&e.botChargeCd<=0&&!lowHp&&best<(e.char.kickRange||69)+64&&best>40){ e.holding=true; e.chargeT=0; e.botOrbT=null; e.botChargeCd=rand(4,7); }
   /* 死神のテレポート：鎌の間合いの外から溜め始めて、潜って一気に詰める */
   if(e.char.type==='scythe'&&e.botChargeCd<=0&&!lowHp&&best>e.char.range&&best<430){ e.holding=true; e.chargeT=0; e.botChargeCd=rand(4,7); }
   /* 幽霊・キャプテン：サーベルの間合いの外から幽霊化して近づく */
   if(e.char.id==='captain'&&e.botChargeCd<=0&&best>e.char.range+10&&best<430){ e.holding=true; e.chargeT=0; e.botChargeCd=rand(5,8); }
   if(best<e.char.range+20){
     /* 瀕死のときは無理に攻めない：距離を取り、3秒逃げ切れば自動回復で立て直す。
        ただし至近距離まで詰められたら反撃する */
     if(lowHp&&best>e.char.range*0.55){ /* 逃げを優先して攻撃しない */ }
     else if(e.char.type==='breath'){ /* バートは attack() の連打ではなく「押し続けて吐く」が本体：
          燃料が十分あれば holding（＝継続ブレス）を始める。息切れ中・燃料不足の
          ときは吐かずに間合いだけ保ち、息継ぎ（燃料回復）を待つ */
       if(!e.breathOver&&e.breathFuel>0.9&&!lowHp){ e.holding=true; e.chargeT=0; } }
     else if(e.char.type!=='scythe'&&e.botChargeCd<=0&&best>60&&!lowHp){ e.holding=true; e.chargeT=0; e.botOrbT=null; e.botChargeCd=rand(4,7); } /* 死神は至近距離で溜めない（テレポートは間合いを詰める技） */
     else if(e.char.type==='fire'&&veraModeOf(e)==='spiral'){ /* 螺旋型ヴェラーはタップ攻撃がない：撃たずに近づく（移動はこの後の処理） */ }
     else attack(e); /* オートエイムで一番近い敵を狙う */
   }
 }
 else { let nc=null,nd=1e9; cubes.forEach(c=>{const d=dist(e,c); if(d<nd){nd=d;nc=c}}); if(nc&&nd<260){moveX=nc.x-e.x;moveY=nc.y-e.y;} else {moveX=e.tx-e.x;moveY=e.ty-e.y;} }
 /* マグマ池が近いときは最優先で離れる（BOTが焼け死に続けないように） */
 const mg=hazards.find(h=>h.type==='magma'&&dist(e,h)<h.r+34); if(mg){ moveX=e.x-mg.x; moveY=e.y-mg.y; }
 const l=Math.hypot(moveX,moveY)||1; e.vx=moveX/l*e.char.speed; e.vy=moveY/l*e.char.speed;
 /* キャラは進んでいる方向を向く（攻撃した瞬間だけオートエイム先を向く） */
 if(Math.hypot(e.vx,e.vy)>10) e.angle=Math.atan2(e.vy,e.vx);
}

let last=0;
function loop(ts){
 requestAnimationFrame(loop); const dt=Math.min(.033,(ts-last)/1000||0.016); last=ts;
 drawBG();
 /* ★ 1フレームの処理で例外が出ても、画面が壊れたまま固まらないように
    ガードする。描画側で失敗したときは座標変換を初期状態に戻してから
    次のフレームを迎える（変換が残ると毒ゾーンの輪などが何重にも
    残像のように描かれてしまう） */
 try{
   /* オンラインのホストは、自分が倒れて結果画面（state='ended'）を出した
      あともゲストのためにシミュレーションを続ける（netHostSimMode） */
   if(state==='playing'||netHostSimMode){ update(dt); }
   else if(state==='countdown'){ updateCountdown(); }
 }catch(_){ }
 try{ drawWorld(); }
 catch(_){ try{ ctx.setTransform(DPR,0,0,DPR,0,0); }catch(__){ } }
}
requestAnimationFrame(loop);

function update(dt){
 /* オンラインのゲストはシミュレーションを持たない：ホストからの
    スナップショットで entities 等が書き換わり、描画だけが進む */
 if(netGuestMode) return;
 elapsed=(performance.now()-startTime)/1000;
 if(elapsed>12) zone.targetR=520; if(elapsed>30) zone.targetR=360; if(elapsed>50) zone.targetR=220; if(elapsed>75) zone.targetR=110; if(elapsed>100) zone.targetR=55;
 zone.r+=(zone.targetR-zone.r)*dt*0.25;
 if(player.alive){
   let mx=(keys['d']||keys['arrowright']?1:0)-(keys['a']||keys['arrowleft']?1:0)+joyVec.x;
   let my=(keys['s']||keys['arrowdown']?1:0)-(keys['w']||keys['arrowup']?1:0)+joyVec.y;
   const l=Math.hypot(mx,my); if(l>1){mx/=l;my/=l;}
   /* 溜めている間は少し遅い（他のキャラ）。★例外はヴェラーとブルーノとボニーと死神：溜め中も通常の速さのまま。
      幽霊・キャプテンは減速するが緩やか（0.65倍。他のキャラの0.45倍ほど遅くならない）。
      バートは火を吐いている間だけ少しゆっくり（0.7倍）歩ける */
   const holdF=noChargeSlow(player)?1:(player.char.id==='captain'?0.65:0.45);
   const spdF=player.char.type==='breath' ? (isBreathing(player)?0.7:1) : (player.holding?holdF:1);
   const spd=player.char.speed*spdF*(onIce(player)?1.3:1); /* 氷の池の上はツルツル速い */
   player.vx=mx*spd; player.vy=my*spd;
   /* キャラは進んでいる方向を向く。マウスでは狙わない（攻撃はオートエイム） */
   if(player.dashT<=0){
     if(Math.hypot(mx,my)>0.1) player.angle=Math.atan2(my,mx);
     /* 溜め中はオートエイム先を向いて、離したときの攻撃方向が分かるようにする。
        ★例外：死神のテレポートは「向いている方向」へ出す技なので、溜め中も
          オートエイムで向きを変えない（移動方向＝テレポートの行き先になる） */
     if(player.holding&&player.char.type!=='scythe'){ const t=autoAimTarget(player,chargeSearchRange(player)); if(t) player.angle=angleTo(player,t); }
   }
 }
 entities.forEach(e=>{
   if(!e.alive) return; e.cool-=dt; e.flameHitCd=Math.max(0,(e.flameHitCd||0)-dt); e.hitFlash=Math.max(0,e.hitFlash-dt); e.swing=Math.max(0,(e.swing||0)-dt); e.kickT=Math.max(0,(e.kickT||0)-dt); if(Math.hypot(e.vx,e.vy)>10) e.bob+=dt*11;
   /* 炎玉の回転（ヴェラだけ。長押し中だけ現れて回る。離した瞬間の角度が螺旋発射の出発位置になる） */
   if(e.char.type==='fire'&&e.holding) e.flameAngle+=(e.char.fireRot||3.4)*dt;
   /* 溜め：長押し中はタイマーが進む（上限は満タンの少し先で止める） */
   if(e.holding) e.chargeT=Math.min(e.char.chargeTime+0.3, e.chargeT+dt);
   /* リロード：弾が満タンでなければ1発ずつ装填していく */
   if(e.char.ammo>0&&e.ammo<e.char.ammo){ e.reloadT-=dt; if(e.reloadT<=0){ e.ammo++; e.reloadT=e.ammo<e.char.ammo?e.char.reload:0; if(e.isPlayer&&e.ammo>=e.char.ammo) playSfx('reload'); /* 装填が全部終わったらカチャッと鳴らす */ } }
   /* ★ バートの息（燃料）：吐いている間は breathTick ごとに breathHit で焼き続け、
      燃料が毎秒1ずつ減る。連続で吐けるのは breathMax=3秒まで。吐き切ると
      息切れ（breathOver）になって holding が強制解除され、燃料が1.2秒分まで
      戻るまでは吐けない。吐いていない間は毎秒0.9秒分ずつ回復する（息継ぎ）。
      吐いている間は戦闘中扱い（自動回復は始まらない） */
   if(e.char.type==='breath'){
     if(isBreathing(e)){
       e.breathFuel=Math.max(0,e.breathFuel-dt);
       e.lastCombat=0; e.isRegen=false;
       e.breathTickT-=dt;
       if(e.breathTickT<=0){ e.breathTickT=e.char.breathTick||0.11; breathHit(e); playSfx('fire',e); }
       if(e.breathFuel<=0){ e.breathOver=true; e.holding=false; e.chargeT=0; if(e.isPlayer) feed('🔥 息が切れた！一度離して息継ぎしてね'); }
     } else {
       e.breathFuel=Math.min(e.char.breathMax||3, e.breathFuel+dt*0.9);
       if(e.breathOver&&e.breathFuel>=1.2) e.breathOver=false;
     }
   }
   /* ★ 幽霊・キャプテンの幽霊化：幽霊化中は ghostFuel が毎秒1ずつ減る
      （続けられるのは ghostMax=3.5秒まで）。使い切ると ghostOver になって
      holding が強制解除され、燃料が1.2秒分まで戻るまでは幽霊化できない。
      幽霊化していない間は毎秒0.8秒分ずつ回復する（息継ぎと同じ考え方）。
      幽霊化した瞬間はプレイヤーだけ専用の音を鳴らす */
   if(e.char.id==='captain'){
     if(isGhost(e)){
       e.ghostFuel=Math.max(0,e.ghostFuel-dt);
       if(Math.random()<dt*7) particles.push({x:e.x+rand(-12,12),y:e.y+rand(-6,14),vx:rand(-14,14),vy:rand(-34,-16),life:.4,max:.4,color:'#8ef6ff',size:rand(2.5,4.5)});
       if(e.ghostFuel<=0){ e.ghostOver=true; e.holding=false; e.chargeT=0; if(e.isPlayer) feed('👻 幽霊化の限界… しばらく回復待ち'); }
     } else {
       e.ghostFuel=Math.min(e.char.ghostMax||3.5, e.ghostFuel+dt*0.8);
       if(e.ghostOver&&e.ghostFuel>=1.2) e.ghostOver=false;
     }
     if(e.isPlayer){ const g=isGhost(e); if(g&&!e._wasGhost) playSfx('ghost'); e._wasGhost=g; }
   }
   /* ★ 死神のテレポート：潜り終わったら出現先へ移動して「現れる」演出へ。
      現れ終わったら通常状態に戻る。潜っている間は攻撃が当たらない
      （damage() 側の除外）し、動けない（下の速度ゼロ）。
      ★フェイルセーフ：tpAge（開始からの経過）が想定の合計時間＋余裕を
        超えたら、状態がどうなっていても強制的に出現させて通常状態へ
        戻す。「潜ったまま戻ってこない」状態には絶対にしない */
   if(e.tpT>0||e.tpPhase!==''){
     e.tpAge=(e.tpAge||0)+dt;
     if(e.tpT>0){
       e.tpT-=dt;
       if(Math.random()<dt*18) particles.push({x:e.x+rand(-10,10),y:e.y+rand(0,12),vx:rand(-16,16),vy:rand(-40,-18),life:.35,max:.35,color:Math.random()<0.5?'#8ef6ff':'#7d5ba6',size:rand(2.5,4.5)});
       if(e.tpT<=0){
         if(e.tpPhase==='sink'){ e.x=e.tpX; e.y=e.tpY; e.tpPhase='emerge'; e.tpT=TP_EMERGE; burst(e.x,e.y,'#8ef6ff',10); burst(e.x,e.y,'#4a3566',6); playSfx('emerge',e); }
         else { e.tpPhase=''; e.tpT=0; }
       }
     }
     if(e.tpPhase!==''&&e.tpAge>TP_SINK+TP_EMERGE+0.45){
       if(e.tpPhase==='sink'){ e.x=e.tpX; e.y=e.tpY; burst(e.x,e.y,'#8ef6ff',10); burst(e.x,e.y,'#4a3566',6); playSfx('emerge',e); }
       e.tpPhase=''; e.tpT=0;
     }
     if(e.tpPhase==='') e.tpAge=0;
   }
   if(!e.isPlayer&&!e.netRemote){ botAI(e,dt); if(onIce(e)){ e.vx*=1.3; e.vy*=1.3; } /* BOTも氷の上では速くなる */ }
   /* オンライン対戦：リモートプレイヤーはBOTではなく、届いた入力で動かす（net.js） */
   if(e.netRemote&&e.alive&&typeof netApplyRemoteInput==='function') netApplyRemoteInput(e,dt);
   if(e.tpT>0){ e.vx=0; e.vy=0; } /* 死神が地面に潜っている間は動けない */
   /* ジャックのダッシュ斬り：高速で駆け抜け、触れた敵に一度だけダメージ。
      ★ボニーのブリンクステップも同じ dashT の仕組みだが、shotgun は
        ダメージも宝箱破壊もしない（純粋な移動技） */
   if(e.dashT>0){
     e.dashT-=dt; e.angle=e.dashDir;
     e.vx=Math.cos(e.dashDir)*980; e.vy=Math.sin(e.dashDir)*980;
     particles.push({x:e.x+rand(-8,8),y:e.y+rand(-4,10),vx:-Math.cos(e.dashDir)*60,vy:-Math.sin(e.dashDir)*60,life:.25,max:.25,color:'#ffe9a8',size:5});
     if(e.char.type!=='shotgun'){
       entities.forEach(t=>{ if(t!==e&&t.alive&&!e.dashHit.has(t)&&dist(e,t)<e.r+t.r+8){ e.dashHit.add(t); damage(t,e.char.chargeDmg*(1+e.power*POWER_DMG_PER_CUBE),e); } });
       crates.forEach(c=>{ if(c.alive&&dist(e,c)<e.r+c.r) hitCrate(c,e.char.chargeDmg,e); });
     }
   }
   /* ブルーノのキック（弧のスイープ）：脚全体（付け根→足先の線分）に
      触れた相手へ1回だけ溜めダメージ。以前は足先の円でしか判定して
      いなかったので「脚が当たっているのにダメージがない」ことがあった。
      今は脚の付け根近くでもすねでも当たる。ただし脚がまだ通過して
      いない場所には当たらない（扇形全体への同時ヒットはしない） */
   if(e.char.type==='fist'&&e.kickT>0){
     const f=kickFoot(e);
     if(f){
       if(!e.kickHit) e.kickHit=new Set();
       if(!e.kickCrateHit) e.kickCrateHit=new Set();
       const kdmg=e.char.chargeDmg*(1+e.power*POWER_DMG_PER_CUBE);
       entities.forEach(t=>{ if(t!==e&&t.alive&&!e.kickHit.has(t)&&kickHitsPoint(e,t.x,t.y,30+t.r)){ e.kickHit.add(t); playSfx('kickHit',e); damage(t,kdmg,e); burst(t.x,t.y,'#ffc93c',6); shake=Math.max(shake,3); } });
       crates.forEach(c=>{ if(c.alive&&!e.kickCrateHit.has(c)&&kickHitsPoint(e,c.x,c.y,30+c.r)){ e.kickCrateHit.add(c); hitCrate(c,kdmg,e); } });
       particles.push({x:f.x,y:f.y,vx:rand(-16,16),vy:rand(-16,16),life:.16,max:.16,color:'#ffe9a8',size:6});
     }
   }
   e.x+=e.vx*dt; e.y+=e.vy*dt;
   const dc=Math.hypot(e.x-WORLD/2,e.y-WORLD/2); if(dc>700){ e.x=WORLD/2+(e.x-WORLD/2)/dc*700; e.y=WORLD/2+(e.y-WORLD/2)/dc*700; }
   crates.forEach(c=>{ if(c.alive){ const d=dist(e,c); if(d<e.r+c.r){ const a=angleTo(c,e); e.x=c.x+Math.cos(a)*(e.r+c.r); e.y=c.y+Math.sin(a)*(e.r+c.r);} }});
   /* 障害物（木・岩・マスト・タル・氷ブロックなど）：宝箱と同じく通れない。
      ★例外：幽霊・死神（scythe）は幽霊の体なので常に障害物をすり抜ける。
        幽霊・キャプテンも幽霊化中（isGhost）だけすり抜けられる。
        宝箱は誰もすり抜けない */
   if(e.char.type!=='scythe'&&!isGhost(e)) obstacles.forEach(o=>{ const d=dist(e,o); if(d<e.r+o.r){ const a=angleTo(o,e); e.x=o.x+Math.cos(a)*(e.r+o.r); e.y=o.y+Math.sin(a)*(e.r+o.r); } });
   /* ★ 自動回復：攻撃もせず・されずに REGEN_DELAY 秒たったら、最大HPの REGEN_RATE/秒 で回復。
      溜め中・ダッシュ中・毒ゾーン内では回復しない。回復量は全キャラ共通の割合なので、
      硬いドンは1秒あたりの回復量も多く、柔らかいルビーは少なめ（割合は同じで公平）。 */
   e.lastCombat+=dt;
   const inZone=dist(e,zone)<=zone.r;
   const inMagma=hazards.some(h=>h.type==='magma'&&Math.hypot(e.x-h.x,e.y-h.y)<h.r);
   const effMax=maxHpOf(e);
   e.isRegen = inZone && !inMagma && !e.holding && e.dashT<=0 && e.lastCombat>=REGEN_DELAY && e.hp>0 && e.hp<effMax;
   /* 効果音（プレイヤーだけ）：回復が始まった瞬間に柔らかく鳴らし、溜めが満タンになった瞬間に合図を鳴らす */
   if(e.isPlayer){
     if(e.isRegen&&!e._wasRegen) playSfx('heal');
     e._wasRegen=e.isRegen;
     if(e.holding&&e.char.type!=='breath'&&chargeReady(e)&&!e._chargeReadySfx){ e._chargeReadySfx=true; playSfx('ready'); }
     if(!e.holding) e._chargeReadySfx=false;
     /* 溜めループ音：長押し中はゲージの進みに合わせて音程が上がっていく
        （実体は sound.js の SFX.charge）。離したら止める。倒れたときなど
        ここを通らなくなっても sound.js 側の見張りで自動で止まる。
        ★バートは「溜め」ではない（吐き続けている音は breathHit の fire 音）ので鳴らさない */
     if(typeof SFX!=='undefined'&&SFX&&SFX.charge){
       if(e.holding&&e.char.type!=='breath') SFX.charge(Math.min(1,e.chargeT/e.char.chargeTime));
       else SFX.chargeStop();
     }
   }
   if(e.isRegen){
     e.hp=Math.min(effMax, e.hp + effMax*REGEN_RATE*dt);
     e.regenFxT-=dt;
     if(e.regenFxT<=0){ e.regenFxT=0.45; particles.push({x:e.x+rand(-10,10),y:e.y-e.r-4,vx:0,vy:-26,life:.55,max:.55,color:'#2ed573',size:4,heal:true}); }
   }
   if(!inZone){ /* 毒ゾーン：段階ダメージ。回復タイマーもリセットされ、回復も止まる */
     e.hp-=poisonDps()*dt; e.hitFlash=0.05; e.lastCombat=0; e.isRegen=false;
     if(e.hp<=0&&e.alive){ e.alive=false; burst(e.x,e.y,'#a55eea',16); feed(`☠️ ${e.isPlayer?'あなた':e.name} は毒ゾーンで倒れた`); if(e.isPlayer) setTimeout(endGame,800); checkWin(); }
   }
   if(inMagma&&e.alive){ /* マグマ池：毎秒55ダメージ。回復タイマーもリセットされ、回復も止まる */
     e.hp-=55*dt; e.hitFlash=0.05; e.lastCombat=0; e.isRegen=false;
     if(Math.random()<dt*6) particles.push({x:e.x+rand(-10,10),y:e.y-8,vx:rand(-20,20),vy:rand(-70,-40),life:.4,max:.4,color:'#ff7b1c',size:4});
     if(e.hp<=0&&e.alive){ e.alive=false; burst(e.x,e.y,'#ff7b1c',16); feed(`🌋 ${e.isPlayer?'あなた':e.name} はマグマに焼かれた`); if(e.isPlayer) setTimeout(endGame,800); checkWin(); }
   }
   cubes=cubes.filter(c=>{ if(dist(e,c)<e.r+c.r){ e.power++; e.hp=Math.min(maxHpOf(e), e.hp+CUBE_HEAL); if(e.isPlayer){ playSfx('cube'); feed('💚 パワーキューブ！ 攻撃力UP'); } return false;} return true;});
 });
 /* ★ 炎玉ダメージ（ヴェラ・長押し中だけ）：回る炎玉に触れた敵へ fireDmg。同じ敵は fireTick 秒に1回まで
      （3個全部に触れても連打にはならない）。複数人には同時に入る。宝箱も同じ間隔で焼ける。
      damage() が与えた側・受けた側の回復タイマーをリセットするので、当て続けている間は
      ヴェラも敵も自動回復しない（他の攻撃と同じ扱い） */
 crates.forEach(c=>{ if(c.flameCd>0) c.flameCd-=dt; });
 entities.forEach(e=>{
   if(!e.alive||e.char.type!=='fire') return;
   const balls=flameBalls(e); if(!balls.length) return;
   const br=e.char.fireBallR||15, fdmg=(e.char.fireDmg||e.char.dmg)*(1+e.power*POWER_DMG_PER_CUBE);
   entities.forEach(t=>{
     if(t===e||!t.alive||t.flameHitCd>0) return;
     if(balls.some(b=>Math.hypot(b.x-t.x,b.y-t.y)<br+t.r)){
       t.flameHitCd=e.char.fireTick||0.45;
       damage(t,fdmg,e);
       burst(t.x,t.y,'#ff7b1c',6);
     }
   });
   crates.forEach(c=>{
     if(!c.alive||(c.flameCd||0)>0) return;
     if(balls.some(b=>Math.hypot(b.x-c.x,b.y-c.y)<br+c.r)){ c.flameCd=e.char.fireTick||0.45; hitCrate(c,fdmg,e); burst(c.x,c.y,'#ff7b1c',5); }
   });
 });
 bullets=bullets.filter(b=>{
   if(b.noReflectT>0) b.noReflectT-=dt; /* 跳ね返し直後の二重跳ね返し防止タイマー */
   if(b.type==='spiral'){ /* 螺旋フレイム：中心はまっすぐ進み、3個は隊形を保ったまま中心の周りを回転し続ける */
     b.t=(b.t||0)+dt;
     if(b.cx==null){ b.cx=b.x; b.cy=b.y; b.rot=b.phase||0; b.orbitR=54; b.rotSpeed=9.5; }
     b.cx+=b.dx*470*dt; b.cy+=b.dy*470*dt;
     b.rot+=b.rotSpeed*dt;
     const aa=b.rot+b.phase;
     b.x=b.cx+Math.cos(aa)*b.orbitR; b.y=b.cy+Math.sin(aa)*b.orbitR;
     b.vx=b.dx*470; b.vy=b.dy*470;
     b.life-=dt;
     if(Math.random()<0.55) particles.push({x:b.x+rand(-5,5),y:b.y+rand(-5,5),vx:rand(-16,16),vy:rand(-30,-8),life:.28,max:.28,color:'#ff9f43',size:3});
   } else { b.x+=b.vx*dt; b.y+=b.vy*dt; b.life-=dt; if(b.type==='fireball'&&Math.random()<0.4) particles.push({x:b.x,y:b.y,vx:rand(-12,12),vy:rand(-24,-6),life:.22,max:.22,color:'#ff9f43',size:3}); if(b.type==='cannonball'&&Math.random()<0.5) particles.push({x:b.x+rand(-4,4),y:b.y+rand(-4,4),vx:rand(-10,10),vy:rand(-16,-4),life:.3,max:.3,color:'#9aa5b1',size:4}); }
   /* ★ 炎玉ガード：敵の飛び道具が、長押し中のヴェラの炎玉に触れたらダメージも爆発もなく消える。
      投げた本人の炎玉では消えない。螺旋フレイム自身は炎玉同士なのでガード対象にしない */
   let guarded=false, guardOwner=null;
   if(b.type!=='spiral') entities.forEach(f=>{
     if(guarded||f===b.owner||!f.alive||f.char.type!=='fire') return;
     const br=f.char.fireBallR||15;
     if(flameBalls(f).some(fb=>Math.hypot(fb.x-b.x,fb.y-b.y)<br+b.r)){ guarded=true; guardOwner=f; }
   });
   if(guarded){
     playSfx('guard',guardOwner); /* 炎玉ガード：鈍い金属音 */
     burst(b.x,b.y,'#ffc93c',8); burst(b.x,b.y,'#ff7b1c',6);
     if(guardOwner&&(guardOwner.isPlayer||(b.owner&&b.owner.isPlayer))) floaters.push({x:b.x,y:b.y-14,text:'ガード!',life:0.7,color:'#ffc93c'});
     return false;
   }
   /* ★ ブルーノのキック跳ね返し：キック中（kickT の間）だけ、振り抜ける足に
      触れた遠距離攻撃を跳ね返して撃ち返せる（持ち主がブルーノに変わる）。
      ただしドンの爆弾（通常／メガボム）だけは跳ね返せない：足に触れた
      瞬間にその場で爆発する（爆風でブルーノ自身もダメージを受ける） */
   if(b.type==='bomb'||b.type==='megabomb'){
     let footBoom=false;
     entities.forEach(e=>{ if(footBoom||e===b.owner||!e.alive||e.char.type!=='fist'||e.kickT<=0) return; if(kickHitsPoint(e,b.x,b.y,40+b.r)) footBoom=true; });
     if(footBoom){ explode(b); return false; }
   } else if(!(b.noReflectT>0)){
     let refBy=null;
     entities.forEach(e=>{ if(refBy||e===b.owner||!e.alive||e.char.type!=='fist'||e.kickT<=0) return; if(kickHitsPoint(e,b.x,b.y,40+b.r)) refBy=e; });
     if(refBy){ reflectBullet(b,refBy); return b.life>0; }
   }
   if(b.type==='bomb'||b.type==='megabomb'){ /* ドンの爆弾（通常／メガボム共通）：時間経過ではなく「敵か宝箱に触れたら即爆発」。外したら飛び切った先（寿命切れ）で爆発する。投げた本人には触れても起爆しない（爆風の自爆は explode 側で当たる）。幽霊化中のキャプテンには触れても起爆しない（すり抜ける） */
     let contact=false;
     entities.forEach(t=>{if(t!==b.owner&&t.alive&&!isGhost(t)&&dist(b,t)<b.r+t.r) contact=true;});
     crates.forEach(c=>{if(c.alive&&dist(b,c)<b.r+c.r) contact=true;});
     obstacles.forEach(o=>{if(dist(b,o)<b.r+o.r) contact=true;}); /* 障害物に当たっても爆発する */
     if(contact||b.life<=0){explode(b); return false;} }
   else if(b.type==='spiral'){ /* 螺旋フレイム：貫通。1個につき同じ敵は1回だけ。障害物で止まる。幽霊化中のキャプテンはすり抜ける */
     entities.forEach(t=>{if(t!==b.owner&&t.alive&&!isGhost(t)&&!b.hitSet.has(t)&&dist(b,t)<b.r+t.r){b.hitSet.add(t); damage(t,b.dmg,b.owner); burst(t.x,t.y,'#ff7b1c',5);}});
     crates.forEach(c=>{if(c.alive&&dist(b,c)<b.r+c.r) hitCrate(c,b.dmg,b.owner);});
     if(obstacles.some(o=>dist(b,o)<b.r+o.r)) return false;
   }
   else if(b.type==='cannonball'){ /* グスタフの砲弾：敵・宝箱・障害物に当たった瞬間（または飛び切ったとき）に小さく炸裂する。ドンの爆弾より範囲は小さいが速く真っすぐ飛ぶ。幽霊化中のキャプテンはすり抜ける */
     let contact=false;
     entities.forEach(t=>{if(t!==b.owner&&t.alive&&!isGhost(t)&&dist(b,t)<b.r+t.r) contact=true;});
     crates.forEach(c=>{if(c.alive&&dist(b,c)<b.r+c.r) contact=true;});
     obstacles.forEach(o=>{if(dist(b,o)<b.r+o.r) contact=true;});
     if(contact||b.life<=0){ explodeCannon(b); return false; } }
   else if(b.type==='powerbolt'){ /* 貫通：当たった敵を記録してすり抜ける。ただし障害物には止められる。幽霊化中のキャプテンもすり抜ける */
     entities.forEach(t=>{if(t!==b.owner&&t.alive&&!isGhost(t)&&!b.hitSet.has(t)&&dist(b,t)<b.r+t.r){b.hitSet.add(t); damage(t,b.dmg,b.owner);}});
     crates.forEach(c=>{if(c.alive&&dist(b,c)<b.r+c.r) hitCrate(c,b.dmg,b.owner);});
     if(obstacles.some(o=>dist(b,o)<b.r+o.r)) return false;
   }
   else { /* 通常の弾（矢・炎玉・破片弾・散弾）。★ボニーの散弾（sgpellet）だけ
        距離減衰：発射位置から飛んだ距離で威力が落ちる（ゼロ距離＝係数1.0で
        最高火力、射程端＝0.38）。近距離の火力を上げた分、減衰を強くして
        射程端の1発あたりの威力は以前（55×0.45≒24.8）とほぼ同じに保った。
        近いほど散弾が多く当たることと合わせて
        「離れるほど弱く、ゼロ距離が一番強い」を作る */
     let fdmg=b.dmg;
     if(b.type==='sgpellet'){ const trav=Math.hypot(b.x-(b.sx||b.x),b.y-(b.sy||b.y)); fdmg=b.dmg*(1-0.62*Math.min(1,trav/(b.maxR||215))); }
     let hit=false; entities.forEach(t=>{if(t!==b.owner&&t.alive&&!isGhost(t)&&dist(b,t)<b.r+t.r){damage(t,fdmg,b.owner); hit=true;}}); crates.forEach(c=>{if(c.alive&&dist(b,c)<b.r+c.r){hitCrate(c,fdmg,b.owner); hit=true;}}); if(obstacles.some(o=>dist(b,o)<b.r+o.r)) hit=true; if(hit) return false; }
   return b.life>0;
 });
 particles=particles.filter(p=>{p.x+=p.vx*dt;p.y+=p.vy*dt;p.life-=dt;return p.life>0});
 floaters=floaters.filter(f=>{f.y-=30*dt;f.life-=dt;return f.life>0});
 cam.x=Math.max(0,Math.min(WORLD-W, player.x-W/2)); cam.y=Math.max(0,Math.min(WORLD-H, player.y-H/2));
 if(W>=WORLD) cam.x=(WORLD-W)/2; if(H>=WORLD) cam.y=(WORLD-H)/2;
 shake=Math.max(0,shake-dt*20);
 checkWin(); /* 毎フレーム確認：残りがプレイヤーだけになったら必ずクリア（優勝）にする */
 const aliveNow=entities.filter(e=>e.alive).length;
 document.getElementById('aliveUI').textContent=aliveNow;
 /* 残り3人以下になったら上バーの「残り」チップを赤く光らせて終盤を伝える */
 const ac=document.getElementById('aliveChip'); if(ac) ac.classList.toggle('is-danger',aliveNow<=3);
 document.getElementById('killUI').textContent=player.kills;
 document.getElementById('timeUI').textContent=fmt(elapsed);
 document.getElementById('hpfill').style.width=Math.max(0,player.hp/maxHpOf(player)*100)+'%';
 document.getElementById('hptext').textContent=Math.max(0,Math.round(player.hp))+' / '+maxHpOf(player)+(player.power?`　💚×${player.power}`:'');
 /* HUD：自動回復の状態（回復中か、あと何秒で回復が始まるか） */
 const rl=document.getElementById('regenline');
 if(rl){
   const pMax=maxHpOf(player);
   if(!player.alive||player.hp>=pMax){ rl.textContent='💚 自動回復：満タン'; rl.className='regen-line full'; }
   else if(player.isRegen){ rl.textContent='💚 回復中… +'+Math.round(pMax*REGEN_RATE)+'/秒'; rl.className='regen-line healing'; }
   else if(dist(player,zone)>zone.r){ rl.textContent='☠️ 毒ゾーン内は回復しない'; rl.className='regen-line blocked'; }
   else { rl.textContent='💚 回復まで あと '+Math.max(0,REGEN_DELAY-player.lastCombat).toFixed(1)+'秒（攻撃すると数え直し）'; rl.className='regen-line waiting'; }
 }
 const hw=document.getElementById('hpwrap'); if(hw) hw.classList.toggle('healing',!!player.isRegen);
 /* HUD：HP／リロード（弾）／溜めゲージ */
 const pips=document.getElementById('ammopips');
 if(player.char.ammo>0){
   pips.classList.remove('none'); pips.textContent='';
   for(let i=0;i<player.char.ammo;i++){ const p=document.createElement('i'); if(i>=player.ammo) p.className='empty'; pips.appendChild(p); }
   const reloading=player.ammo<player.char.ammo;
   document.getElementById('ammowrap').classList.toggle('reloading',reloading);
   document.getElementById('ammotext').textContent=reloading?('装填中… あと '+Math.max(0,player.reloadT).toFixed(1)+'秒'):('弾 '+player.ammo+' / '+player.char.ammo);
   document.getElementById('ammofill').style.width=(reloading? (1-player.reloadT/player.char.reload)*100 : 100)+'%';
 } else if(player.char.type==='breath'){
   /* バートはリロードではなく「息（燃料）」が制限：この欄で残り秒数を出す */
   pips.classList.add('none'); pips.textContent='🔥 息（燃料）：連続'+(player.char.breathMax||3)+'秒まで';
   document.getElementById('ammowrap').classList.remove('reloading');
   document.getElementById('ammotext').textContent=player.breathOver?'息切れ中… 回復まで待ってね':('あと '+player.breathFuel.toFixed(1)+' 秒吐ける');
   document.getElementById('ammofill').style.width=Math.max(0,player.breathFuel/(player.char.breathMax||3)*100)+'%';
 } else {
   pips.classList.add('none'); pips.textContent='近接武器：リロードなし';
   document.getElementById('ammowrap').classList.remove('reloading');
   document.getElementById('ammotext').textContent='リロードなし';
   document.getElementById('ammofill').style.width='100%';
 }
 { /* 溜めゲージ：全キャラ共通（ヴェラーも chargeTime があるので同じ表示） */
   const cpct=Math.min(100,player.chargeT/player.char.chargeTime*100);
   document.getElementById('chargefill').style.width=cpct+'%';
   document.getElementById('chargewrap').classList.toggle('ready',chargeReady(player)&&player.holding);
   let readyText=player.char.chargeName+' 準備OK！離して発動';
   if(player.char.type==='fire'){
     readyText=veraModeOf(player)==='spiral'
       ? '炎玉3個 出現中！離すと'+player.char.chargeName
       : '炎玉3個 出現中！（接触＆ガード／離しても飛ばない）';
   }
   document.getElementById('chargetext').textContent=!player.holding?'長押しで溜める':(chargeReady(player)?readyText:'溜め中… '+Math.round(cpct)+'%'+(player.char.type==='fire'?'（満タンで炎玉出現）':''));
   if(player.char.type==='breath'){ /* バートのこの欄は「息ゲージ」として使う */
     document.getElementById('chargefill').style.width=Math.max(0,player.breathFuel/(player.char.breathMax||3)*100)+'%';
     document.getElementById('chargewrap').classList.toggle('ready',isBreathing(player));
     document.getElementById('chargetext').textContent=player.breathOver?'🔥 息切れ中… 離して息継ぎしてね':(isBreathing(player)?'🔥 ファイアブレス中！ あと '+player.breathFuel.toFixed(1)+'秒':'長押しで火を噴く（連続'+(player.char.breathMax||3)+'秒まで）');
   }
   if(player.char.id==='captain'){ /* 幽霊・キャプテンのこの欄は「幽霊化ゲージ」として使う */
     document.getElementById('chargefill').style.width=Math.max(0,player.ghostFuel/(player.char.ghostMax||3.5)*100)+'%';
     document.getElementById('chargewrap').classList.toggle('ready',isGhost(player));
     document.getElementById('chargetext').textContent=player.ghostOver?'👻 幽霊化は回復待ち…（1.2秒分まで回復すると使える）':(isGhost(player)?'👻 幽霊化中！ あと '+player.ghostFuel.toFixed(1)+'秒（離すと解除）':(player.holding?'溜め中… 満タンで幽霊化':'長押しで幽霊化（最大'+(player.char.ghostMax||3.5)+'秒）'));
   }
 }
}

function drawBG(){ const st=currentStage||STAGES[0]; ctx.fillStyle=st.outside; ctx.fillRect(0,0,W,H);
 ctx.fillStyle=st.outside2; for(let i=0;i<20;i++){ ctx.globalAlpha=.12; ctx.beginPath(); ctx.ellipse((i*173)%W, (i*97)%H, 40,10,0,0,6.28); ctx.fill(); } ctx.globalAlpha=1;
 if(st.id==='magma'){ /* 外側はマグマの海：オレンジの glow がゆらめく */
   const t=performance.now()/900; ctx.fillStyle='#ff7b1c';
   for(let i=0;i<14;i++){ ctx.globalAlpha=.10+.08*Math.sin(t+i*1.7); ctx.beginPath(); ctx.ellipse((i*211)%W,(i*131)%H,54,16,0,0,6.28); ctx.fill(); } ctx.globalAlpha=1;
 }
}
/* ============================================================
   キャラ描画：Yohoho風の丸っこい見下ろしキャラ（描き込み強化版）
   大きな丸い体＋頭＋帽子/ヒゲ＋手に持った武器、頭上に名前とHPバー
   幼く見えないよう、陰影・服の仕立て・眉と傷などで「海賊らしさ」を足す
   デザインの色は data.js の skin / outfit / hat で変えられる
   ジャックの剣を振る動作（swing）はそのまま活かしてある
   ============================================================ */
function drawWeapon(e,hx,hy,wa,R){
 if(e.char.type==='fire') return; /* ヴェラは武器を持たない：炎玉は長押し中だけ周りを回る */
 if(e.char.type==='breath') return; /* バートは武器を持たない：酒瓶は反対の手に、火は口から（drawEntity 側） */
 if(e.char.type==='fist'){ /* ブルーノ：武器の代わりに赤いグローブの拳そのもの */
   ctx.save(); ctx.translate(hx,hy); ctx.rotate(wa);
   ctx.fillStyle='#f5f0dc'; ctx.fillRect(-R*0.34,-R*0.17,R*0.30,R*0.34); /* 手首の白いバンテージ */
   ctx.beginPath(); ctx.arc(R*0.10,0,R*0.40,0,6.28); ctx.fillStyle='#c0271f'; ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.35)'; ctx.stroke();
   ctx.strokeStyle='rgba(0,0,0,0.30)'; ctx.lineWidth=1.8; [-0.18,0,0.18].forEach(o=>{ ctx.beginPath(); ctx.moveTo(R*0.02,o*R); ctx.lineTo(R*0.34,o*R); ctx.stroke(); }); /* 指の境目 */
   ctx.fillStyle='rgba(255,255,255,0.30)'; ctx.beginPath(); ctx.arc(-R*0.02,-R*0.14,R*0.13,0,6.28); ctx.fill();
   ctx.restore(); return;
 }
 ctx.save(); ctx.translate(hx,hy); ctx.rotate(wa); ctx.lineCap='round';
 if(e.char.type==='melee'){ /* カットラス：柄・鍔・刀身の峰と刃 */
   ctx.strokeStyle='#5d3a12'; ctx.lineWidth=6.5; ctx.beginPath(); ctx.moveTo(-9,0); ctx.lineTo(1,0); ctx.stroke();
   ctx.fillStyle='#8a5a24'; ctx.beginPath(); ctx.arc(-9,0,3.4,0,6.28); ctx.fill();
   ctx.strokeStyle='#ffc93c'; ctx.lineWidth=4; ctx.beginPath(); ctx.arc(4,0,6.5,-1.2,1.2); ctx.stroke();
   ctx.strokeStyle='#dfe7ef'; ctx.lineWidth=7.5; ctx.beginPath(); ctx.moveTo(7,0); ctx.quadraticCurveTo(R*0.85,-R*0.34,R*1.34,-R*0.06); ctx.stroke();
   ctx.strokeStyle='#93a5b8'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(9,-1.5); ctx.quadraticCurveTo(R*0.85,-R*0.30,R*1.26,-R*0.05); ctx.stroke();
 } else if(e.char.type==='gun'){ /* クロスボウ：木の台＋鉄の弓＋矢 */
   ctx.fillStyle='#6e4517'; ctx.fillRect(-7,-4,R*1.1,8);
   ctx.fillStyle='#8a5a24'; ctx.fillRect(-7,-4,R*1.1,3);
   ctx.strokeStyle='#3d4450'; ctx.lineWidth=5; ctx.beginPath(); ctx.arc(R*0.80,0,R*0.55,-1.18,1.18); ctx.stroke();
   const ey=Math.sin(1.18)*R*0.55, ex=R*0.80+Math.cos(1.18)*R*0.55;
   ctx.strokeStyle='#f5f0dc'; ctx.lineWidth=1.6; ctx.beginPath(); ctx.moveTo(ex,-ey); ctx.lineTo(R*0.32,0); ctx.lineTo(ex,ey); ctx.stroke();
   ctx.strokeStyle='#e8eef5'; ctx.lineWidth=3.2; ctx.beginPath(); ctx.moveTo(-3,0); ctx.lineTo(R*1.02,0); ctx.stroke();
   ctx.fillStyle='#c0271f'; ctx.beginPath(); ctx.moveTo(R*1.02,0); ctx.lineTo(R*0.86,-3.4); ctx.lineTo(R*0.86,3.4); ctx.closePath(); ctx.fill();
 } else if(e.char.type==='cannon'){ /* グスタフの大砲腕（ロビー立ち絵と同じ見せ方）：肩当て→先太りの砲身→太い真鍮の帯2本→大きく開いた砲口。
      バトル中の小さな画面でも「腕が大砲だ」と一目で分かるよう、砲身は太く・長く・帯と砲口は大げさに描く */
   ctx.fillStyle='#23262c'; ctx.beginPath(); ctx.arc(-R*0.36,0,R*0.30,0,6.28); ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.stroke(); /* 根元のフランジ */
   ctx.beginPath(); ctx.arc(-R*0.16,0,R*0.47,0,6.28); ctx.fillStyle='#46525f'; ctx.fill(); ctx.lineWidth=3; ctx.strokeStyle='#c98f00'; ctx.stroke(); /* 肩当て（金の縁取り） */
   ctx.beginPath(); ctx.arc(-R*0.16,0,R*0.30,0,6.28); ctx.fillStyle='#2b3038'; ctx.fill(); /* 肩当ての内側 */
   ctx.beginPath(); ctx.moveTo(-R*0.28,-R*0.34); ctx.lineTo(R*1.06,-R*0.48); ctx.lineTo(R*1.06,R*0.48); ctx.lineTo(-R*0.28,R*0.34); ctx.closePath(); ctx.fillStyle='#39404d'; ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.stroke(); /* 砲身（砲口側が太い） */
   ctx.beginPath(); ctx.moveTo(-R*0.28,-R*0.34); ctx.lineTo(R*1.06,-R*0.48); ctx.lineTo(R*1.06,-R*0.27); ctx.lineTo(-R*0.28,-R*0.15); ctx.closePath(); ctx.fillStyle='#5b6673'; ctx.fill(); /* 砲身の上の光 */
   ctx.fillStyle='#c98f00'; ctx.fillRect(R*0.14,-R*0.50,R*0.17,R*1.00); ctx.fillRect(R*0.62,-R*0.52,R*0.17,R*1.04); /* 真鍮の帯（砲身より少し出っ張る輪） */
   ctx.fillStyle='rgba(0,0,0,0.28)'; ctx.fillRect(R*0.14,R*0.22,R*0.17,R*0.28); ctx.fillRect(R*0.62,R*0.24,R*0.17,R*0.28); /* 帯の下側の影 */
   ctx.fillStyle='#c98f00'; ctx.beginPath(); ctx.arc(-R*0.02,-R*0.44,R*0.10,0,6.28); ctx.fill(); ctx.lineWidth=1.6; ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.stroke(); /* 点火口のつまみ */
   ctx.beginPath(); ctx.ellipse(R*1.10,0,R*0.17,R*0.50,0,0,6.28); ctx.fillStyle='#23262c'; ctx.fill(); ctx.lineWidth=3.5; ctx.strokeStyle='#6b7684'; ctx.stroke(); /* 砲口の輪（鉄の縁） */
   ctx.beginPath(); ctx.ellipse(R*1.10,0,R*0.10,R*0.31,0,0,6.28); ctx.fillStyle='#050607'; ctx.fill(); /* 砲口の穴 */
 } else if(e.char.type==='shotgun'){ /* ブランダーバス：短い木の銃身＋先がラッパ状に広がった銃口。
      近距離専用の散弾銃だと一目で分かるよう、銃口は大げさに広げて真鍮の縁を付ける */
   ctx.fillStyle='#5d3a12'; ctx.beginPath(); ctx.moveTo(-R*0.55,-R*0.16); ctx.lineTo(-R*0.05,-R*0.13); ctx.lineTo(-R*0.05,R*0.20); ctx.lineTo(-R*0.55,R*0.26); ctx.closePath(); ctx.fill(); /* 木の台（ストック） */
   ctx.beginPath(); ctx.moveTo(-R*0.10,-R*0.20); ctx.lineTo(R*0.78,-R*0.30); ctx.lineTo(R*0.78,R*0.30); ctx.lineTo(-R*0.10,R*0.20); ctx.closePath(); ctx.fillStyle='#39404d'; ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.stroke(); /* 銃身（銃口へ向けて太くなる） */
   ctx.beginPath(); ctx.moveTo(-R*0.10,-R*0.20); ctx.lineTo(R*0.78,-R*0.30); ctx.lineTo(R*0.78,-R*0.12); ctx.lineTo(-R*0.10,-R*0.04); ctx.closePath(); ctx.fillStyle='#5b6673'; ctx.fill(); /* 銃身の上の光 */
   ctx.fillStyle='#c98f00'; ctx.fillRect(R*0.30,-R*0.27,R*0.13,R*0.54); /* 真鍮の帯 */
   ctx.beginPath(); ctx.ellipse(R*0.84,0,R*0.16,R*0.42,0,0,6.28); ctx.fillStyle='#23262c'; ctx.fill(); ctx.lineWidth=3.5; ctx.strokeStyle='#c98f00'; ctx.stroke(); /* ラッパ状の銃口（金の縁） */
   ctx.beginPath(); ctx.ellipse(R*0.84,0,R*0.09,R*0.25,0,0,6.28); ctx.fillStyle='#050607'; ctx.fill(); /* 銃口の穴 */
 } else if(e.char.type==='scythe'){ /* 死神の大鎌：長い柄＋大きく弧を描く刃＋継ぎ目の魂石 */
   ctx.strokeStyle='#3a2c14'; ctx.lineWidth=5.5; ctx.beginPath(); ctx.moveTo(-R*0.75,0); ctx.lineTo(R*0.78,0); ctx.stroke();
   ctx.strokeStyle='#dfe7ef'; ctx.lineWidth=7; ctx.beginPath(); ctx.moveTo(R*0.74,-R*0.02); ctx.quadraticCurveTo(R*1.30,-R*0.72,R*0.60,-R*1.18); ctx.stroke();
   ctx.strokeStyle='#93a5b8'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(R*0.76,-R*0.10); ctx.quadraticCurveTo(R*1.22,-R*0.70,R*0.64,-R*1.08); ctx.stroke();
   ctx.fillStyle='#8ef6ff'; ctx.beginPath(); ctx.arc(R*0.74,0,R*0.09,0,6.28); ctx.fill();
 } else { /* 爆弾：鉄の玉＋口金＋導火線と火花 */
   ctx.beginPath(); ctx.arc(R*0.42,0,R*0.46,0,6.28); ctx.fillStyle='#1d1f26'; ctx.fill(); ctx.lineWidth=3; ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.stroke();
   ctx.fillStyle='#39404d'; ctx.fillRect(R*0.30,-R*0.56,R*0.24,R*0.14);
   ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.beginPath(); ctx.arc(R*0.28,-R*0.16,R*0.13,0,6.28); ctx.fill();
   ctx.strokeStyle='#8a5a24'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(R*0.42,-R*0.52); ctx.quadraticCurveTo(R*0.52,-R*0.70,R*0.66,-R*0.66); ctx.stroke();
   ctx.fillStyle='#ffcf3f'; ctx.beginPath(); ctx.arc(R*0.70,-R*0.66,R*0.12,0,6.28); ctx.fill();
   ctx.fillStyle='#ff7b1c'; ctx.beginPath(); ctx.arc(R*0.70,-R*0.66,R*0.06,0,6.28); ctx.fill();
 }
 ctx.restore();
}
function drawHeadGear(e,hx,hy,hr){
 const c=e.char;
 if(c.hat==='bandana'){ /* ジャック：赤バンダナ＋結び目と垂れ布＋ドクロ印 */
   ctx.beginPath(); ctx.arc(hx,hy,hr,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle=c.hatColor; ctx.fill();
   ctx.beginPath(); ctx.arc(hx,hy,hr,Math.PI*1.02,Math.PI*1.98); ctx.lineTo(hx,hy); ctx.closePath(); ctx.fillStyle='rgba(0,0,0,0.13)'; ctx.fill();
   ctx.strokeStyle='rgba(0,0,0,0.28)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(hx-hr*0.98,hy-hr*0.06); ctx.lineTo(hx+hr*0.98,hy-hr*0.06); ctx.stroke();
   ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(hx,hy-hr*0.52,hr*0.15,0,6.28); ctx.fill();
   ctx.fillRect(hx-hr*0.13,hy-hr*0.40,hr*0.26,hr*0.07);
   ctx.fillStyle=c.hatColor; ctx.beginPath(); ctx.arc(hx+hr*0.97,hy-hr*0.30,hr*0.20,0,6.28); ctx.fill();
   ctx.beginPath(); ctx.moveTo(hx+hr*1.06,hy-hr*0.16); ctx.lineTo(hx+hr*1.34,hy+hr*0.30); ctx.lineTo(hx+hr*0.97,hy+hr*0.34); ctx.closePath(); ctx.fill();
   ctx.beginPath(); ctx.moveTo(hx+hr*0.88,hy-hr*0.12); ctx.lineTo(hx+hr*1.02,hy+hr*0.38); ctx.lineTo(hx+hr*0.78,hy+hr*0.30); ctx.closePath(); ctx.fillStyle='rgba(0,0,0,0.15)'; ctx.fill();
 } else if(c.hat==='feather'){ /* ルビー：横分けの髪＋羽付き帽子（鍔とバンド） */
   ctx.beginPath(); ctx.arc(hx,hy,hr,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle=c.hair; ctx.fill();
   ctx.strokeStyle='rgba(0,0,0,0.25)'; ctx.lineWidth=1.8; [-0.5,-0.1,0.3].forEach(o=>{ ctx.beginPath(); ctx.moveTo(hx+o*hr,hy-hr*0.95); ctx.quadraticCurveTo(hx+(o+0.25)*hr,hy-hr*0.55,hx+(o+0.1)*hr,hy-hr*0.08); ctx.stroke(); });
   ctx.save(); ctx.translate(hx+hr*0.55,hy-hr*1.04); ctx.rotate(0.5);
   ctx.beginPath(); ctx.ellipse(0,0,hr*0.17,hr*0.46,0,0,6.28); ctx.fillStyle='#27ae60'; ctx.fill();
   ctx.strokeStyle='rgba(0,60,30,0.5)'; ctx.lineWidth=1.6; ctx.beginPath(); ctx.moveTo(0,hr*0.42); ctx.lineTo(0,-hr*0.42); ctx.stroke(); ctx.restore();
   ctx.save(); ctx.translate(hx,hy-hr*0.80); ctx.rotate(-0.14); ctx.beginPath(); ctx.ellipse(0,0,hr*0.88,hr*0.31,0,0,6.28); ctx.fillStyle=c.hatColor; ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.25)'; ctx.stroke();
   ctx.beginPath(); ctx.ellipse(0,hr*0.10,hr*0.88,hr*0.20,0,0,Math.PI); ctx.fillStyle='rgba(0,0,0,0.16)'; ctx.fill(); ctx.restore();
   ctx.fillStyle='#ffc93c'; ctx.beginPath(); ctx.arc(hx-hr*0.52,hy-hr*0.82,hr*0.09,0,6.28); ctx.fill();
 } else if(c.hat==='flame'){ /* ヴェラ：炎色ポニーテール＋黒バンド＋炎の形の前髪 */
   ctx.beginPath(); ctx.arc(hx,hy,hr,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle=c.hair; ctx.fill();
   ctx.beginPath(); ctx.arc(hx+hr*0.92,hy+hr*0.28,hr*0.34,0,6.28); ctx.fillStyle=c.hair; ctx.fill();
   ctx.strokeStyle='#26221f'; ctx.lineWidth=hr*0.20; ctx.beginPath(); ctx.moveTo(hx-hr*0.98,hy-hr*0.10); ctx.lineTo(hx+hr*0.98,hy-hr*0.10); ctx.stroke();
   ctx.fillStyle=c.hatColor;
   ctx.beginPath(); ctx.moveTo(hx-hr*0.55,hy-hr*0.72); ctx.quadraticCurveTo(hx-hr*0.42,hy-hr*1.28,hx-hr*0.12,hy-hr*1.02); ctx.quadraticCurveTo(hx+hr*0.05,hy-hr*1.42,hx+hr*0.30,hy-hr*1.04); ctx.quadraticCurveTo(hx+hr*0.55,hy-hr*1.24,hx+hr*0.58,hy-hr*0.72); ctx.closePath(); ctx.fill();
   ctx.fillStyle='#ffc93c';
   ctx.beginPath(); ctx.moveTo(hx-hr*0.28,hy-hr*0.74); ctx.quadraticCurveTo(hx-hr*0.16,hy-hr*1.08,hx+hr*0.02,hy-hr*0.90); ctx.quadraticCurveTo(hx+hr*0.18,hy-hr*1.12,hx+hr*0.32,hy-hr*0.74); ctx.closePath(); ctx.fill();
   ctx.fillStyle='#ffc93c'; ctx.beginPath(); ctx.arc(hx,hy-hr*0.10,hr*0.11,0,6.28); ctx.fill(); ctx.strokeStyle='#8a5a24'; ctx.lineWidth=1.4; ctx.stroke();
 } else if(c.hat==='hachimaki'){ /* ブルーノ：黒髪＋黄色いハチマキ（結び目と垂れ布） */
   ctx.beginPath(); ctx.arc(hx,hy,hr,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle=c.hair; ctx.fill();
   ctx.strokeStyle=c.hatColor; ctx.lineWidth=hr*0.34; ctx.beginPath(); ctx.moveTo(hx-hr*0.99,hy-hr*0.28); ctx.lineTo(hx+hr*0.99,hy-hr*0.28); ctx.stroke();
   ctx.strokeStyle='rgba(0,0,0,0.22)'; ctx.lineWidth=1.8; ctx.beginPath(); ctx.moveTo(hx-hr*0.99,hy-hr*0.12); ctx.lineTo(hx+hr*0.99,hy-hr*0.12); ctx.stroke();
   ctx.fillStyle=c.hatColor; ctx.beginPath(); ctx.arc(hx+hr*0.97,hy-hr*0.28,hr*0.17,0,6.28); ctx.fill();
   ctx.beginPath(); ctx.moveTo(hx+hr*1.05,hy-hr*0.16); ctx.lineTo(hx+hr*1.30,hy+hr*0.22); ctx.lineTo(hx+hr*0.96,hy+hr*0.26); ctx.closePath(); ctx.fill();
   ctx.beginPath(); ctx.moveTo(hx+hr*0.86,hy-hr*0.14); ctx.lineTo(hx+hr*0.98,hy+hr*0.28); ctx.lineTo(hx+hr*0.74,hy+hr*0.20); ctx.closePath(); ctx.fillStyle='rgba(0,0,0,0.14)'; ctx.fill();
   ctx.fillStyle='#c0271f'; ctx.beginPath(); ctx.arc(hx,hy-hr*0.30,hr*0.10,0,6.28); ctx.fill(); /* ハチマキ中央の赤い丸印 */
 } else if(c.hat==='tricorn'){ /* グスタフ：黒い三角帽子（ロビー立ち絵と同じ見せ方）。
      以前は頭と同じ幅の平たい楕円＋小さな山で「黒いベレー帽」に見えてしまっていたので、
      頭より大きく広がる三角のつば＋金の縁取り＋大きめのドクロ印ではっきり三角帽子と分かる形にした */
   ctx.fillStyle=c.hair; ctx.beginPath(); ctx.arc(hx-hr*0.88,hy+hr*0.10,hr*0.24,0,6.28); ctx.fill(); ctx.beginPath(); ctx.arc(hx+hr*0.88,hy+hr*0.10,hr*0.24,0,6.28); ctx.fill(); /* 帽子の横から出る髪（もみあげ） */
   /* つば：両端が跳ね上がった三角帽子のシルエット。頭の幅（2hr）より大きく広げる */
   ctx.beginPath();
   ctx.moveTo(hx-hr*1.34,hy-hr*0.26);
   ctx.quadraticCurveTo(hx-hr*1.02,hy-hr*0.86,hx-hr*0.34,hy-hr*0.66);
   ctx.quadraticCurveTo(hx,hy-hr*0.56,hx+hr*0.34,hy-hr*0.66);
   ctx.quadraticCurveTo(hx+hr*1.02,hy-hr*0.86,hx+hr*1.34,hy-hr*0.26);
   ctx.quadraticCurveTo(hx,hy-hr*0.16,hx-hr*1.34,hy-hr*0.26);
   ctx.closePath(); ctx.fillStyle=c.hatColor; ctx.fill(); ctx.lineWidth=2.8; ctx.strokeStyle='#c98f00'; ctx.stroke(); /* 金の縁取り */
   ctx.beginPath(); ctx.arc(hx,hy-hr*0.50,hr*0.58,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle='#2e3642'; ctx.fill(); ctx.lineWidth=2.2; ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.stroke(); /* 山（クラウン） */
   ctx.beginPath(); ctx.arc(hx,hy-hr*0.50,hr*0.58,Math.PI*1.15,Math.PI*1.55); ctx.lineWidth=hr*0.16; ctx.strokeStyle='rgba(255,255,255,0.14)'; ctx.stroke(); /* 山の光 */
   /* ドクロ印：小さな点ではなく、頭蓋＋アゴ＋目の穴まで描いて小さくてもドクロと分かるように */
   ctx.strokeStyle='#fff'; ctx.lineWidth=1.7; ctx.lineCap='round';
   ctx.beginPath(); ctx.moveTo(hx-hr*0.17,hy-hr*0.30); ctx.lineTo(hx+hr*0.17,hy-hr*0.44); ctx.moveTo(hx+hr*0.17,hy-hr*0.30); ctx.lineTo(hx-hr*0.17,hy-hr*0.44); ctx.stroke(); /* 交差した骨 */
   ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(hx,hy-hr*0.66,hr*0.21,0,6.28); ctx.fill();
   ctx.fillRect(hx-hr*0.115,hy-hr*0.52,hr*0.23,hr*0.15); /* アゴ */
   ctx.fillStyle='#1d1f26'; ctx.beginPath(); ctx.arc(hx-hr*0.085,hy-hr*0.68,hr*0.052,0,6.28); ctx.fill(); ctx.beginPath(); ctx.arc(hx+hr*0.085,hy-hr*0.68,hr*0.052,0,6.28); ctx.fill(); /* 目の穴 */
   ctx.fillStyle='#c98f00'; ctx.beginPath(); ctx.arc(hx-hr*1.02,hy-hr*0.42,hr*0.10,0,6.28); ctx.fill(); ctx.lineWidth=1.4; ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.stroke(); /* 左の金の飾りボタン */
   /* 眼帯の紐：顔を横切る太い帯にしない。額の高い位置を通して眼帯（drawFace 側）へつなぐ細い紐だけ描く */
   ctx.strokeStyle='#1d1f26'; ctx.lineWidth=hr*0.10; ctx.beginPath(); ctx.moveTo(hx-hr*0.82,hy-hr*0.50); ctx.lineTo(hx+hr*0.28,hy-hr*0.13); ctx.stroke();
 } else if(c.hat==='hood'){ /* 死神：深い闇色のフード。頭をすっぽり覆い、内側は影 */
   ctx.beginPath(); ctx.arc(hx,hy-hr*0.04,hr*1.14,Math.PI*0.92,Math.PI*2.08); ctx.closePath(); ctx.fillStyle=c.hatColor; ctx.fill();
   ctx.beginPath(); ctx.arc(hx,hy-hr*0.04,hr*0.88,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle='rgba(0,0,0,0.38)'; ctx.fill();
   ctx.fillStyle=c.hatColor;
   ctx.beginPath(); ctx.moveTo(hx-hr*1.10,hy-hr*0.10); ctx.lineTo(hx-hr*0.80,hy+hr*0.55); ctx.lineTo(hx-hr*1.16,hy+hr*0.62); ctx.closePath(); ctx.fill();
   ctx.beginPath(); ctx.moveTo(hx+hr*1.10,hy-hr*0.10); ctx.lineTo(hx+hr*0.80,hy+hr*0.55); ctx.lineTo(hx+hr*1.16,hy+hr*0.62); ctx.closePath(); ctx.fill();
   ctx.strokeStyle='rgba(142,246,255,0.5)'; ctx.lineWidth=1.8; ctx.beginPath(); ctx.arc(hx,hy-hr*0.04,hr*1.14,Math.PI*1.15,Math.PI*1.45); ctx.stroke(); /* フードの縁の幽かな光 */
 } else if(c.hat==='captainhat'){ /* 幽霊・キャプテン：紺の船長帽（両端が跳ね上がった二角帽）＋金の縁取り＋ドクロ印＋白い横髪 */
   ctx.fillStyle=c.hair; ctx.beginPath(); ctx.arc(hx-hr*0.86,hy+hr*0.14,hr*0.22,0,6.28); ctx.fill(); ctx.beginPath(); ctx.arc(hx+hr*0.86,hy+hr*0.14,hr*0.22,0,6.28); ctx.fill(); /* 帽子の横から出る白髪 */
   ctx.beginPath();
   ctx.moveTo(hx-hr*1.30,hy-hr*0.22);
   ctx.quadraticCurveTo(hx-hr*0.95,hy-hr*0.80,hx-hr*0.30,hy-hr*0.60);
   ctx.quadraticCurveTo(hx,hy-hr*0.50,hx+hr*0.30,hy-hr*0.60);
   ctx.quadraticCurveTo(hx+hr*0.95,hy-hr*0.80,hx+hr*1.30,hy-hr*0.22);
   ctx.quadraticCurveTo(hx,hy-hr*0.10,hx-hr*1.30,hy-hr*0.22);
   ctx.closePath(); ctx.fillStyle=c.hatColor; ctx.fill(); ctx.lineWidth=2.6; ctx.strokeStyle='#ffc93c'; ctx.stroke(); /* 金の縁取り */
   ctx.beginPath(); ctx.arc(hx,hy-hr*0.44,hr*0.54,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle='#27354f'; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.stroke(); /* 山（クラウン） */
   ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(hx,hy-hr*0.60,hr*0.19,0,6.28); ctx.fill();
   ctx.fillRect(hx-hr*0.10,hy-hr*0.46,hr*0.20,hr*0.13); /* ドクロ印 */
   ctx.fillStyle='#1d2b45'; ctx.beginPath(); ctx.arc(hx-hr*0.075,hy-hr*0.62,hr*0.045,0,6.28); ctx.fill(); ctx.beginPath(); ctx.arc(hx+hr*0.075,hy-hr*0.62,hr*0.045,0,6.28); ctx.fill(); /* 目の穴 */
 } else if(c.hat==='beard'){ /* ドン：黒髪＋毛流れのある大きな黒ヒゲ＋口ヒゲ */
   ctx.beginPath(); ctx.arc(hx,hy,hr,Math.PI,2*Math.PI); ctx.closePath(); ctx.fillStyle=c.hair; ctx.fill();
   ctx.strokeStyle=c.hair; ctx.lineWidth=hr*0.52; ctx.lineCap='round'; ctx.beginPath(); ctx.arc(hx,hy+hr*0.06,hr*0.74,Math.PI*0.05,Math.PI*0.95); ctx.stroke();
   ctx.strokeStyle='rgba(255,255,255,0.13)'; ctx.lineWidth=2;
   [-0.45,-0.15,0.15,0.45].forEach(o=>{ ctx.beginPath(); ctx.moveTo(hx+o*hr,hy+hr*0.52); ctx.quadraticCurveTo(hx+o*hr*1.25,hy+hr*0.85,hx+o*hr*0.9,hy+hr*1.08); ctx.stroke(); });
   ctx.strokeStyle=c.hair; ctx.lineWidth=hr*0.16; ctx.beginPath(); ctx.moveTo(hx-hr*0.34,hy+hr*0.30); ctx.quadraticCurveTo(hx,hy+hr*0.44,hx+hr*0.34,hy+hr*0.30); ctx.stroke();
 }
}
/* 服の仕立て：キャラごとにベスト／斜めベルト／コートの前立てなどを描く */
function drawOutfit(e,x,y,R){
 const c=e.char, cy=y+R*0.20;
 if(c.id==='jack'){ /* 青ベスト＋白シャツ＋襟 */
   ctx.beginPath(); ctx.moveTo(x-R*0.34,cy-R*0.72); ctx.lineTo(x+R*0.34,cy-R*0.72); ctx.lineTo(x+R*0.16,cy+R*0.55); ctx.lineTo(x-R*0.16,cy+R*0.55); ctx.closePath(); ctx.fillStyle='#e9e2d0'; ctx.fill();
   ctx.strokeStyle=c.outfitDark; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(x-R*0.34,cy-R*0.72); ctx.lineTo(x-R*0.16,cy+R*0.55); ctx.moveTo(x+R*0.34,cy-R*0.72); ctx.lineTo(x+R*0.16,cy+R*0.55); ctx.stroke();
   ctx.fillStyle='#ffc93c'; [-0.28,0.02,0.32].forEach(o=>{ ctx.beginPath(); ctx.arc(x+o*R*0.30,cy+o*R,2.4,0,6.28); ctx.fill(); });
 } else if(c.id==='vera'){ /* ヴェラ：炎の斜めサッシュ＋金の留め具＋襟 */
   ctx.strokeStyle='#7a1503'; ctx.lineWidth=R*0.30; ctx.beginPath(); ctx.moveTo(x-R*0.74,cy-R*0.50); ctx.lineTo(x+R*0.74,cy+R*0.60); ctx.stroke();
   ctx.strokeStyle='#ffc93c'; ctx.lineWidth=2.4; ctx.beginPath(); ctx.moveTo(x-R*0.74,cy-R*0.50); ctx.lineTo(x+R*0.74,cy+R*0.60); ctx.stroke();
   ctx.beginPath(); ctx.arc(x+2,cy+2,R*0.17,0,6.28); ctx.fillStyle='#ffc93c'; ctx.fill(); ctx.strokeStyle='#8a5a24'; ctx.lineWidth=1.6; ctx.stroke();
   ctx.strokeStyle=c.outfitDark; ctx.lineWidth=R*0.28; ctx.beginPath(); ctx.arc(x,cy-R*0.55,R*0.50,Math.PI*0.18,Math.PI*0.82); ctx.stroke();
 } else if(c.id==='bruno'){ /* ブルーノ：道着の白い前合わせ（V字）＋黒帯 */
   ctx.beginPath(); ctx.moveTo(x-R*0.36,cy-R*0.74); ctx.lineTo(x+R*0.36,cy-R*0.74); ctx.lineTo(x,cy+R*0.30); ctx.closePath(); ctx.fillStyle='#e9e2d0'; ctx.fill();
   ctx.strokeStyle=c.outfitDark; ctx.lineWidth=2.6; ctx.beginPath(); ctx.moveTo(x-R*0.36,cy-R*0.74); ctx.lineTo(x,cy+R*0.30); ctx.lineTo(x+R*0.36,cy-R*0.74); ctx.stroke();
   ctx.strokeStyle='#1d1f26'; ctx.lineWidth=R*0.30; ctx.beginPath(); ctx.arc(x,cy+R*0.06,R*0.86,Math.PI*0.28,Math.PI*0.72); ctx.stroke(); /* 黒帯 */
   ctx.fillStyle='#ffc93c'; ctx.beginPath(); ctx.arc(x,cy+R*0.72,R*0.10,0,6.28); ctx.fill(); /* 帯の留め具 */
 } else if(c.id==='gustav'){ /* グスタフ：紺コート（ロビー立ち絵と同じ見せ方）。
      深い紺のラペル（襟）＋白シャツ＋真鍮ボタンで「コート」と分かるようにし、
      砲弾ベルトは太い帯＋大きめの砲弾4個ではっきり見せる（以前は砲弾が小さくて点にしか見えなかった） */
   ctx.fillStyle=c.outfitDark; /* ラペル（コートの襟）：左右からV字に開く濃紺 */
   ctx.beginPath(); ctx.moveTo(x-R*0.10,cy-R*0.30); ctx.lineTo(x-R*0.62,cy-R*0.68); ctx.lineTo(x-R*0.20,cy+R*0.28); ctx.closePath(); ctx.fill();
   ctx.beginPath(); ctx.moveTo(x+R*0.10,cy-R*0.30); ctx.lineTo(x+R*0.62,cy-R*0.68); ctx.lineTo(x+R*0.20,cy+R*0.28); ctx.closePath(); ctx.fill();
   ctx.beginPath(); ctx.moveTo(x-R*0.17,cy-R*0.80); ctx.lineTo(x+R*0.17,cy-R*0.80); ctx.lineTo(x+R*0.08,cy+R*0.34); ctx.lineTo(x-R*0.08,cy+R*0.34); ctx.closePath(); ctx.fillStyle='#e9e2d0'; ctx.fill(); /* 白シャツの前立て */
   ctx.strokeStyle='#c98f00'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x-R*0.60,cy-R*0.66); ctx.lineTo(x-R*0.19,cy+R*0.24); ctx.moveTo(x+R*0.60,cy-R*0.66); ctx.lineTo(x+R*0.19,cy+R*0.24); ctx.stroke(); /* ラペルの金の縁取り */
   ctx.fillStyle='#c98f00'; [-0.52,-0.18,0.16].forEach(o=>{ ctx.beginPath(); ctx.arc(x,cy+o*R,3.1,0,6.28); ctx.fill(); ctx.lineWidth=1.3; ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.stroke(); }); /* 真鍮ボタン */
   ctx.strokeStyle='#1d1a17'; ctx.lineWidth=R*0.36; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(x-R*0.80,cy+R*0.34); ctx.lineTo(x+R*0.80,cy-R*0.32); ctx.stroke(); /* 砲弾ベルト（太い斜め帯） */
   ctx.strokeStyle='rgba(255,201,60,0.30)'; ctx.lineWidth=1.8; ctx.beginPath(); ctx.moveTo(x-R*0.80,cy+R*0.34-R*0.17); ctx.lineTo(x+R*0.80,cy-R*0.32-R*0.17); ctx.stroke(); /* ベルト上端の細い金のライン */
   [0.16,0.38,0.62,0.84].forEach(t=>{ const bx=x-R*0.80+(R*1.60)*t, by=cy+R*0.34-(R*0.66)*t; /* ベルトの砲弾：鉄の玉＋光 */
     ctx.beginPath(); ctx.arc(bx,by,R*0.17,0,6.28); ctx.fillStyle='#23262c'; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle='rgba(0,0,0,0.55)'; ctx.stroke();
     ctx.beginPath(); ctx.arc(bx-R*0.06,by-R*0.06,R*0.055,0,6.28); ctx.fillStyle='#9aa5b1'; ctx.fill(); });
 } else if(c.id==='bonnie'){ /* ボニー：紫コート＋散弾ベルト（赤いシェルが並ぶ斜め帯）＋白シャツ */
   ctx.beginPath(); ctx.moveTo(x-R*0.30,cy-R*0.74); ctx.lineTo(x+R*0.30,cy-R*0.74); ctx.lineTo(x+R*0.13,cy+R*0.40); ctx.lineTo(x-R*0.13,cy+R*0.40); ctx.closePath(); ctx.fillStyle='#e9e2d0'; ctx.fill();
   ctx.strokeStyle='#1d1a17'; ctx.lineWidth=R*0.34; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(x-R*0.78,cy-R*0.30); ctx.lineTo(x+R*0.78,cy+R*0.42); ctx.stroke();
   [0.18,0.38,0.58,0.78].forEach(t=>{ const bx=x-R*0.78+(R*1.56)*t, by=cy-R*0.30+(R*0.72)*t;
     ctx.save(); ctx.translate(bx,by); ctx.rotate(0.42); ctx.fillStyle='#c0271f'; ctx.fillRect(-R*0.07,-R*0.13,R*0.14,R*0.26); ctx.fillStyle='#c98f00'; ctx.fillRect(-R*0.07,R*0.05,R*0.14,R*0.08); ctx.restore(); }); /* ベルトの散弾シェル */
   ctx.fillStyle='#ffc93c'; [-0.30,0.05].forEach(o=>{ ctx.beginPath(); ctx.arc(x,cy+o*R,2.6,0,6.28); ctx.fill(); });
 } else if(c.id==='bart'){ /* バート：開けた白シャツ（胸元）＋オレンジの腰巻きサッシュ＋瓶の紐 */
   ctx.beginPath(); ctx.moveTo(x-R*0.34,cy-R*0.74); ctx.lineTo(x+R*0.34,cy-R*0.74); ctx.lineTo(x,cy+R*0.22); ctx.closePath(); ctx.fillStyle='#e9e2d0'; ctx.fill();
   ctx.strokeStyle=c.outfitDark; ctx.lineWidth=2.6; ctx.beginPath(); ctx.moveTo(x-R*0.34,cy-R*0.74); ctx.lineTo(x,cy+R*0.22); ctx.lineTo(x+R*0.34,cy-R*0.74); ctx.stroke();
   ctx.strokeStyle='#d35400'; ctx.lineWidth=R*0.26; ctx.beginPath(); ctx.arc(x,cy+R*0.10,R*0.84,Math.PI*0.30,Math.PI*0.70); ctx.stroke(); /* 腰のサッシュ */
   ctx.strokeStyle='#5d3a12'; ctx.lineWidth=2.2; ctx.beginPath(); ctx.moveTo(x-R*0.55,cy-R*0.55); ctx.lineTo(x+R*0.40,cy+R*0.45); ctx.stroke(); /* 瓶を提げる紐 */
 } else if(c.id==='captain'){ /* 幽霊・キャプテン：紺コートのラペル（金の縁取り）＋白いクラバット＋金ボタン */
   ctx.fillStyle=c.outfitDark;
   ctx.beginPath(); ctx.moveTo(x-R*0.10,cy-R*0.30); ctx.lineTo(x-R*0.60,cy-R*0.66); ctx.lineTo(x-R*0.18,cy+R*0.26); ctx.closePath(); ctx.fill();
   ctx.beginPath(); ctx.moveTo(x+R*0.10,cy-R*0.30); ctx.lineTo(x+R*0.60,cy-R*0.66); ctx.lineTo(x+R*0.18,cy+R*0.26); ctx.closePath(); ctx.fill();
   ctx.beginPath(); ctx.moveTo(x-R*0.20,cy-R*0.78); ctx.lineTo(x+R*0.20,cy-R*0.78); ctx.lineTo(x,cy-R*0.28); ctx.closePath(); ctx.fillStyle='#e9e2d0'; ctx.fill(); /* クラバット（白い首布） */
   ctx.strokeStyle='#ffc93c'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x-R*0.58,cy-R*0.64); ctx.lineTo(x-R*0.17,cy+R*0.22); ctx.moveTo(x+R*0.58,cy-R*0.64); ctx.lineTo(x+R*0.17,cy+R*0.22); ctx.stroke(); /* ラペルの金の縁取り */
   ctx.fillStyle='#ffc93c'; [-0.30,0.02,0.34].forEach(o=>{ ctx.beginPath(); ctx.arc(x,cy+o*R,2.8,0,6.28); ctx.fill(); }); /* 金ボタン */
 } else if(c.id==='reaper'){ /* 死神：闇色ローブの襟＋胸元で水色に光る魂の玉 */
   ctx.strokeStyle=c.outfitDark; ctx.lineWidth=R*0.30; ctx.beginPath(); ctx.arc(x,cy-R*0.52,R*0.52,Math.PI*0.15,Math.PI*0.85); ctx.stroke();
   ctx.save(); ctx.shadowColor='#37c8d9'; ctx.shadowBlur=9;
   ctx.beginPath(); ctx.arc(x,cy+R*0.05,R*0.16,0,6.28); ctx.fillStyle='#8ef6ff'; ctx.fill(); ctx.restore();
   ctx.beginPath(); ctx.arc(x,cy+R*0.05,R*0.16,0,6.28); ctx.lineWidth=2; ctx.strokeStyle='#1d4e5e'; ctx.stroke();
   ctx.fillStyle='rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.arc(x-R*0.05,cy-R*0.01,R*0.05,0,6.28); ctx.fill();
 } else if(c.id==='ruby'){ /* 矢筒の斜めベルト＋襟巻き */
   ctx.strokeStyle='#5d3a12'; ctx.lineWidth=R*0.26; ctx.beginPath(); ctx.moveTo(x-R*0.72,cy-R*0.55); ctx.lineTo(x+R*0.72,cy+R*0.62); ctx.stroke();
   ctx.strokeStyle='#ffc93c'; ctx.lineWidth=2.4; ctx.beginPath(); ctx.moveTo(x-R*0.72,cy-R*0.55); ctx.lineTo(x+R*0.72,cy+R*0.62); ctx.stroke();
   ctx.strokeStyle=c.outfitDark; ctx.lineWidth=R*0.30; ctx.beginPath(); ctx.arc(x,cy-R*0.52,R*0.52,Math.PI*0.15,Math.PI*0.85); ctx.stroke();
 } else { /* ドン：黄色コートの前立て＋ボタン＋太ベルト */
   ctx.fillStyle='rgba(255,255,255,0.30)'; ctx.fillRect(x-R*0.13,cy-R*0.85,R*0.26,R*1.15);
   ctx.fillStyle='#3a2c14'; [-0.5,-0.08,0.34].forEach(o=>{ ctx.beginPath(); ctx.arc(x,cy+o*R,2.8,0,6.28); ctx.fill(); });
   ctx.strokeStyle='#26221f'; ctx.lineWidth=R*0.30; ctx.beginPath(); ctx.arc(x,cy,R*0.90,Math.PI*0.30,Math.PI*0.70); ctx.stroke();
 }
}
/* 顔：決意の眉＋目＋口（ほっぺの赤みは廃止）。ジャックは頬の傷、ドンは太眉 */
function drawFace(e,cxp,cyp,hr){
 const a=e.angle, ex=Math.cos(a)*hr*0.18, ey=Math.sin(a)*hr*0.10;
 if(e.char.id==='reaper'){ /* 死神：眉はなく、水色に光る目と小さな口だけがフードの闇に浮かぶ */
   ctx.save(); ctx.shadowColor='#37c8d9'; ctx.shadowBlur=8;
   ctx.fillStyle='#8ef6ff'; [-1,1].forEach(s=>{ ctx.beginPath(); ctx.arc(cxp+ex+s*hr*0.34,cyp+ey,Math.max(2.6,hr*0.12),0,6.28); ctx.fill(); });
   ctx.restore();
   ctx.strokeStyle='#5b4a7a'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(cxp+ex,cyp+ey+hr*0.30,hr*0.10,0,6.28); ctx.stroke();
   return;
 }
 ctx.strokeStyle='#2a1c10'; ctx.lineCap='round';
 ctx.lineWidth=e.char.id==='don'?4:2.6;
 [-1,1].forEach(s=>{ ctx.beginPath(); ctx.moveTo(cxp+ex+s*hr*0.52,cyp+ey-hr*0.34); ctx.lineTo(cxp+ex+s*hr*0.16,cyp+ey-hr*0.20); ctx.stroke(); });
 ctx.fillStyle='#1d1f26'; [-1,1].forEach(s=>{ ctx.beginPath(); ctx.arc(cxp+ex+s*hr*0.34,cyp+ey,Math.max(2.4,hr*0.11),0,6.28); ctx.fill(); });
 ctx.fillStyle='rgba(255,255,255,0.85)'; [-1,1].forEach(s=>{ ctx.beginPath(); ctx.arc(cxp+ex+s*hr*0.34+1,cyp+ey-1,1.1,0,6.28); ctx.fill(); });
 if(e.char.id==='jack'){ ctx.strokeStyle='rgba(160,60,40,0.75)'; ctx.lineWidth=1.8; ctx.beginPath(); ctx.moveTo(cxp-hr*0.62,cyp+hr*0.10); ctx.lineTo(cxp-hr*0.44,cyp+hr*0.30); ctx.stroke(); }
 if(e.char.id==='gustav'){ /* 眼帯（ロビー立ち絵と同じ見せ方）：右目だけを覆う大きめの黒い眼帯。
      紐は額の高い位置（drawHeadGear 側）と頬の横だけに描き、顔を横切る帯にしない。
      反対側の目と眉はそのまま見えるので「仮面」ではなく「眼帯」と分かる */
   ctx.strokeStyle='#1d1f26'; ctx.lineWidth=hr*0.10; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(cxp+ex+hr*0.50,cyp+ey+hr*0.14); ctx.lineTo(cxp+hr*0.94,cyp+hr*0.44); ctx.stroke(); /* 頬側の紐 */
   ctx.beginPath(); ctx.arc(cxp+ex+hr*0.34,cyp+ey,hr*0.28,0,6.28); ctx.fillStyle='#101216'; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle='rgba(0,0,0,0.6)'; ctx.stroke();
   ctx.beginPath(); ctx.arc(cxp+ex+hr*0.34,cyp+ey,hr*0.28,0,6.28); ctx.lineWidth=1.3; ctx.strokeStyle='rgba(233,226,208,0.35)'; ctx.stroke(); /* 眼帯の縁のわずかな光 */
   ctx.fillStyle='rgba(255,255,255,0.20)'; ctx.beginPath(); ctx.arc(cxp+ex+hr*0.25,cyp+ey-hr*0.10,hr*0.07,0,6.28); ctx.fill(); /* 眼帯のハイライト */ }
 if(e.char.id==='captain'){ /* 白い口ひげ：死んだ元キャプテンらしい威厳 */
   ctx.strokeStyle='#dfe9ec'; ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(cxp+ex-hr*0.32,cyp+ey+hr*0.28); ctx.quadraticCurveTo(cxp+ex,cyp+ey+hr*0.44,cxp+ex+hr*0.32,cyp+ey+hr*0.28); ctx.stroke();
 } else if(e.char.id!=='don'){ ctx.strokeStyle='#7a4a2a'; ctx.lineWidth=2.2; ctx.beginPath(); ctx.moveTo(cxp+ex-hr*0.13,cyp+ey+hr*0.34); ctx.lineTo(cxp+ex+hr*0.13,cyp+ey+hr*0.34); ctx.stroke(); }
}
/* 炎玉1個の描画：外側の炎（ゆらめき）＋オレンジ＋黄色い芯。少しだけ火の粉も出す */
function drawFlameBall(bx,by,br,t,seed){
 const fl=1+0.13*Math.sin(t/90+seed*2.1);
 ctx.beginPath(); ctx.arc(bx,by,br*1.55*fl,0,6.28); ctx.fillStyle='rgba(255,110,20,0.20)'; ctx.fill();
 ctx.beginPath(); ctx.arc(bx,by,br*fl,0,6.28); ctx.fillStyle='#ff7b1c'; ctx.fill();
 ctx.beginPath(); ctx.moveTo(bx-br*0.55,by+br*0.45); ctx.quadraticCurveTo(bx-br*0.30,by-br*1.05*fl,bx+br*0.08,by-br*0.52); ctx.quadraticCurveTo(bx+br*0.34,by-br*1.0*fl,bx+br*0.55,by+br*0.45); ctx.closePath(); ctx.fillStyle='#ff7b1c'; ctx.fill();
 ctx.beginPath(); ctx.arc(bx,by+br*0.12,br*0.58,0,6.28); ctx.fillStyle='#ffc93c'; ctx.fill();
 ctx.beginPath(); ctx.arc(bx,by+br*0.18,br*0.26,0,6.28); ctx.fillStyle='#fff3b0'; ctx.fill();
 if(state==='playing'&&Math.random()<0.10) particles.push({x:bx+rand(-6,6),y:by-6,vx:rand(-14,14),vy:rand(-52,-30),life:.35,max:.35,color:'#ff9f43',size:3});
}
function drawEntity(e){
 const R=e.r, c=e.char;
 const moving=Math.hypot(e.vx,e.vy)>10;
 const bobY=Math.sin(e.bob)*(moving?1.8:0.7);
 const x=e.x, y=e.y+bobY, a=e.angle;
 const skin=e.skin||c.skin;
 /* 幽霊・キャプテンの幽霊化中：体全体が半透明になる（攻撃も障害物も
    すり抜ける状態だと一目で分かるように）。restore は関数の最後 */
 const ghosting=isGhost(e);
 if(ghosting){ ctx.save(); ctx.globalAlpha=0.45; }
 /* 影 */
 ctx.fillStyle='#00000030'; ctx.beginPath(); ctx.ellipse(e.x,e.y+R*0.95,R*0.95,R*0.32,0,0,6.28); ctx.fill();
 /* プレイヤーの目印：以前は体を囲む金色の丸（フラフープみたいでダサい）を
    描いていたが、やめて「足元の楕円マーカー」にした。地面に沿った薄い
    金色の楕円リング＋頭上の小さな▼（名前の上で上下に揺れる）で、
    自分だと分かるのにキャラの絵を邪魔しない */
 if(e.isPlayer){
   const pulse=0.72+0.28*Math.sin(performance.now()/300);
   ctx.beginPath(); ctx.ellipse(e.x,e.y+R*0.98,R*1.06,R*0.38,0,0,6.28); ctx.fillStyle='rgba(255,201,60,0.13)'; ctx.fill();
   ctx.beginPath(); ctx.ellipse(e.x,e.y+R*0.98,R*1.06,R*0.38,0,0,6.28); ctx.strokeStyle=`rgba(255,201,60,${pulse})`; ctx.lineWidth=3; ctx.stroke();
   ctx.beginPath(); ctx.ellipse(e.x,e.y+R*0.98,R*1.06,R*0.38,0,Math.PI*0.15,Math.PI*0.85); ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=1.6; ctx.stroke();
 }
 /* 死神のテレポート：地面に潜る／現れる演出。潜るほど体が沈んで縮み、
    足元には闇色の穴が広がる。名前とHPバーは沈ませないので、
    restore は頭上の表示の直前で戻す */
 /* ★ tpSink は必ず 0〜1 に丸める：範囲外の値が描画に入ると、体の拡縮が
    おかしくなったり穴の楕円の半径が負になって描画全体が止まったりする */
 const tpSink=e.tpT>0 ? Math.max(0,Math.min(1, e.tpPhase==='sink' ? 1-e.tpT/TP_SINK : e.tpT/TP_EMERGE)) : 0;
 if(tpSink>0){
   ctx.beginPath(); ctx.ellipse(e.x,e.y+R*0.98,R*(0.5+0.6*tpSink),R*0.20*(0.5+0.6*tpSink),0,0,6.28); ctx.fillStyle='rgba(8,4,18,0.62)'; ctx.fill();
   ctx.beginPath(); ctx.ellipse(e.x,e.y+R*0.98,R*(0.5+0.6*tpSink),R*0.20*(0.5+0.6*tpSink),0,0,6.28); ctx.strokeStyle='rgba(142,246,255,0.55)'; ctx.lineWidth=2; ctx.stroke();
   ctx.save(); ctx.globalAlpha=1-0.45*tpSink;
   ctx.translate(e.x,e.y+R*0.95); ctx.scale(1-0.22*tpSink,1-0.62*tpSink); ctx.translate(-e.x,-(e.y+R*0.95));
 }
 /* バートのファイアブレス：吐いている間だけ、口の先から扇形の炎を描く。
    外側は揺らめくオレンジ、内側は黄色。判定（breathHit）と同じ range／角度 */
 if(isBreathing(e)){
   const bR=c.range, bHalf=(c.breathAngle||0.62)+0.10, flick=1+0.05*Math.sin(performance.now()/47+e.x);
   ctx.beginPath(); ctx.moveTo(x,y+R*0.05); ctx.arc(x,y+R*0.05,bR*flick,a-bHalf,a+bHalf); ctx.closePath();
   ctx.fillStyle='rgba(255,110,20,0.30)'; ctx.fill();
   ctx.beginPath(); ctx.moveTo(x,y+R*0.05); ctx.arc(x,y+R*0.05,bR*0.62*flick,a-bHalf*0.7,a+bHalf*0.7); ctx.closePath();
   ctx.fillStyle='rgba(255,180,40,0.38)'; ctx.fill();
   ctx.beginPath(); ctx.moveTo(x,y+R*0.05); ctx.arc(x,y+R*0.05,bR*0.30,a-bHalf*0.45,a+bHalf*0.45); ctx.closePath();
   ctx.fillStyle='rgba(255,240,170,0.45)'; ctx.fill();
 }
 /* 炎玉（ヴェラ）：軌道の薄い円＋奥側の玉は体の後ろに描く（手前側は体の後に描く） */
 const fballs=c.type==='fire'?flameBalls(e):[], fbr=c.fireBallR||15, ftNow=performance.now();
 if(fballs.length){
   ctx.beginPath(); ctx.arc(e.x,e.y+R*0.2,c.fireOrbit||54,0,6.28); ctx.strokeStyle='rgba(255,123,28,0.28)'; ctx.lineWidth=2; ctx.setLineDash([7,9]); ctx.stroke(); ctx.setLineDash([]);
   fballs.forEach((b,i)=>{ if(Math.sin(b.a)<0) drawFlameBall(b.x,b.y+R*0.2,fbr,ftNow,i); });
 }
 /* 溜め中：キャラの周りをぐるっとたまるゲージリング。
    土台リング＋グローで光る太い弧＋先端の光点＋逆回転する内側の破線＋
    吸い込まれる火花に加えて、今回さらに：
    ・足元に広がる熱のオーラ（たまるほど濃く・大きく）
    ・向き合った方向への扇形の予告ゾーン＋矢印（溜め攻撃の飛ぶ先が見える）
    ・20分割のエネルギーマス（最新マスが白く弾ける）
    ・弧の先端に流れる彗星のような残光（コメットトレイル）
    ・リングの上を回る2つのエネルギーの玉（たまるほど速く回る）
    ・25%ごとの節目で外へ広がる衝撃波リング
    満タンでは金色に強く光り、脈打つ輪と回るキラキラ・外周の破線で一目で分かる */
 if(e.holding&&c.type!=='breath'){ /* バートは「溜めゲージ」ではなく息ゲージ（頭上のバーを参照） */
   const p=Math.min(1,e.chargeT/c.chargeTime), full=p>=1, now=performance.now();
   const gx=x, gy=y+R*0.2, gr=R+10;
   const hue=26+p*20, gli=56+p*10+(full?6*Math.sin(now/90):0);
   /* 熱のオーラ：足元から熱気が広がる。たまるほど濃く・大きくなる */
   const auraR=gr+12+p*10+(full?2.5*Math.sin(now/110):0);
   const ag=ctx.createRadialGradient(gx,gy,gr*0.3,gx,gy,auraR);
   ag.addColorStop(0,`hsla(${hue},100%,58%,${0.05+p*0.13})`);
   ag.addColorStop(0.75,`hsla(${hue},100%,55%,${0.04+p*0.08})`);
   ag.addColorStop(1,`hsla(${hue},100%,55%,0)`);
   ctx.beginPath(); ctx.arc(gx,gy,auraR,0,6.28); ctx.fillStyle=ag; ctx.fill();
   /* 予告ゾーン：向いている方向（＝溜め攻撃の飛ぶ先）へ薄い扇形＋先端の矢印。
      溜まるほど濃くなり、満タンでは矢印が脈打つ */
   ctx.beginPath(); ctx.moveTo(gx,gy); ctx.arc(gx,gy,gr+24,a-0.30,a+0.30); ctx.closePath();
   ctx.fillStyle=`hsla(${hue},100%,60%,${0.045+p*0.075})`; ctx.fill();
   const chR=gr+17+(full?2*Math.sin(now/110):0), chx=gx+Math.cos(a)*chR, chy=gy+Math.sin(a)*chR;
   ctx.save(); ctx.translate(chx,chy); ctx.rotate(a);
   ctx.beginPath(); ctx.moveTo(6,0); ctx.lineTo(-4,-5); ctx.lineTo(-4,5); ctx.closePath();
   ctx.fillStyle=`hsla(${hue},100%,${full?78:64}%,${0.35+p*0.5})`; ctx.fill(); ctx.restore();
   /* 土台リング：たまっていない部分も薄く見せて「円ゲージ」だと分かるように */
   ctx.beginPath(); ctx.arc(gx,gy,gr,0,6.28); ctx.strokeStyle='rgba(8,8,18,0.40)'; ctx.lineWidth=8; ctx.stroke();
   ctx.beginPath(); ctx.arc(gx,gy,gr,0,6.28); ctx.strokeStyle='rgba(255,255,255,0.13)'; ctx.lineWidth=8; ctx.stroke();
   /* 節目の衝撃波：25%・50%・75%・100% を跨ぐたび、外へ広がる輪が弾ける */
   if(p<=0.001){ e._cgStage=0; }
   const stage=Math.min(4,Math.floor(p*4.001));
   if(e._cgStage===undefined) e._cgStage=0;
   if(stage>e._cgStage){ e._cgStage=stage; e._cgPulse=now; }
   if(e._cgPulse&&now-e._cgPulse<380){ const pt=(now-e._cgPulse)/380;
     ctx.beginPath(); ctx.arc(gx,gy,gr+3+pt*18,0,6.28); ctx.strokeStyle=`hsla(${hue},100%,68%,${0.55*(1-pt)})`; ctx.lineWidth=3; ctx.stroke(); }
   /* エネルギーマス：20分割のマスが1つずつ点灯。いま点いたマスだけ白く太く弾ける */
   const segN=20, segA=6.283/segN, newest=Math.ceil(p*segN)-1;
   for(let i=0;i<segN;i++){ const a0=-Math.PI/2+i*segA, lit=i/segN<p;
     ctx.beginPath(); ctx.arc(gx,gy,gr+8,a0+0.035,a0+segA-0.035);
     if(lit&&i===newest){ ctx.strokeStyle='#ffffff'; ctx.lineWidth=4.4; }
     else if(lit){ ctx.strokeStyle=`hsl(${hue},100%,${full?72:60}%)`; ctx.lineWidth=3.2; }
     else { ctx.strokeStyle='rgba(255,255,255,0.20)'; ctx.lineWidth=2.2; }
     ctx.stroke(); }
   /* 内側の細い破線リング：逆回転して「渦巻く力」を表現 */
   ctx.save(); ctx.translate(gx,gy); ctx.rotate(-now/650);
   ctx.beginPath(); ctx.arc(0,0,gr-8,0,6.28); ctx.strokeStyle=full?'rgba(255,233,168,0.8)':'rgba(255,159,67,0.5)'; ctx.lineWidth=2; ctx.setLineDash([5,7]); ctx.stroke();
   ctx.restore(); ctx.setLineDash([]);
   /* コメットトレイル：弧の先端の後ろに残光が流れる（幅と濃さが尾へ向けて落ちる） */
   const headA=-Math.PI/2+p*6.283;
   if(p>0.03){ ctx.lineCap='round';
     for(let k=3;k>=1;k--){ ctx.beginPath(); ctx.arc(gx,gy,gr,Math.max(-Math.PI/2,headA-k*0.21),headA);
       ctx.strokeStyle=`hsla(${hue},100%,62%,${0.16*(4-k)})`; ctx.lineWidth=5.5-k*1.05; ctx.stroke(); } }
   /* メインの弧：たまるほど色が橙→金→白金へ熱くなり、グローで光る */
   ctx.save(); ctx.shadowColor=`hsla(${hue},100%,60%,0.9)`; ctx.shadowBlur=full?18:11;
   ctx.beginPath(); ctx.arc(gx,gy,gr,-Math.PI/2,headA); ctx.strokeStyle=`hsl(${hue},100%,${gli}%)`; ctx.lineWidth=5.5; ctx.lineCap='round'; ctx.stroke();
   ctx.restore();
   /* 先端の光点：たまっている最前線が燃えるように光る */
   if(p>0.02){ const hxp=gx+Math.cos(headA)*gr, hyp=gy+Math.sin(headA)*gr, hpr=full?5.4+1.1*Math.sin(now/90):4.6;
     ctx.save(); ctx.shadowColor='#ffd76a'; ctx.shadowBlur=14;
     ctx.beginPath(); ctx.arc(hxp,hyp,hpr,0,6.28); ctx.fillStyle='#fff3b0'; ctx.fill();
     ctx.beginPath(); ctx.arc(hxp,hyp,hpr*0.45,0,6.28); ctx.fillStyle='#ffffff'; ctx.fill(); ctx.restore(); }
   /* 回るエネルギーの玉：2つが逆向きにリングを周回。たまるほど速く・大きくなる */
   const orbSpd=0.0016+p*0.0038;
   for(let j=0;j<2;j++){ const dir=j?-1:1, oa=dir*now*orbSpd+j*Math.PI;
     ctx.beginPath(); ctx.arc(gx,gy,gr,dir>0?oa-0.55:oa,dir>0?oa:oa+0.55);
     ctx.strokeStyle=`hsla(${hue},100%,65%,0.30)`; ctx.lineWidth=3; ctx.lineCap='round'; ctx.stroke();
     ctx.save(); ctx.shadowColor='#ffd76a'; ctx.shadowBlur=10;
     ctx.beginPath(); ctx.arc(gx+Math.cos(oa)*gr,gy+Math.sin(oa)*gr,2.4+p*1.2,0,6.28); ctx.fillStyle='#fff3b0'; ctx.fill(); ctx.restore(); }
   /* 満タン：外へ広がる脈動リング＋回るキラキラ（十字の瞬き）＋ゆっくり回る外周の破線 */
   if(full){
     const ph=(now%520)/520;
     ctx.beginPath(); ctx.arc(gx,gy,gr+4+ph*13,0,6.28); ctx.strokeStyle=`rgba(255,201,60,${0.5*(1-ph)})`; ctx.lineWidth=3; ctx.stroke();
     ctx.save(); ctx.translate(gx,gy); ctx.rotate(now/1100);
     ctx.beginPath(); ctx.arc(0,0,gr+15,0,6.28); ctx.strokeStyle='rgba(255,217,106,0.65)'; ctx.lineWidth=2.5; ctx.setLineDash([12,16]); ctx.stroke();
     ctx.restore(); ctx.setLineDash([]);
     for(let i=0;i<4;i++){ const sa=now/260+i*1.571, sx=gx+Math.cos(sa)*(gr+3), sy=gy+Math.sin(sa)*(gr+3), ss=3.4+1.4*Math.sin(now/120+i*1.7);
       ctx.strokeStyle='rgba(255,243,176,0.95)'; ctx.lineWidth=1.8; ctx.beginPath();
       ctx.moveTo(sx-ss,sy); ctx.lineTo(sx+ss,sy); ctx.moveTo(sx,sy-ss); ctx.lineTo(sx,sy+ss); ctx.stroke(); }
   }
   /* 火花：リングの外からキャラへ吸い込まれる小さな粒（たまるほど速く・多く） */
   if(state==='playing'&&Math.random()<0.25+p*0.45){
     const sa=rand(0,6.283), sr=gr+rand(10,22);
     particles.push({x:gx+Math.cos(sa)*sr,y:gy+Math.sin(sa)*sr,vx:-Math.cos(sa)*rand(55,95),vy:-Math.sin(sa)*rand(55,95),life:.3,max:.3,color:full?'#ffe9a8':'#ffb35c',size:rand(2,3.6)});
   }
 }
 /* ダッシュ中：残像 */
 if(e.dashT>0){ ctx.globalAlpha=0.35; ctx.beginPath(); ctx.arc(x-Math.cos(e.dashDir)*R*0.9,y+R*0.2-Math.sin(e.dashDir)*R*0.5,R*0.9,0,6.28); ctx.fillStyle=c.outfit; ctx.fill(); ctx.globalAlpha=1; }
 /* 武器を持つ手の位置（近接は振り回す） */
 let wa, hd;
 if(c.type==='melee'||c.type==='scythe'){ if(e.swing>0){ const p=1-e.swing/0.22; wa=a-1.15+p*1.9; } else wa=a+0.6; hd=R*1.02; }
 else if(c.type==='fist'){ /* ブルーノ：出した側の拳が前に突き出る。右手は右寄り、左手は左寄り。
      攻撃していないときは両拳を構えたガード姿勢 */
   const sideOff=(e.lastPunch?1:-1)*0.42;
   if(e.swing>0){ wa=a+sideOff; hd=R*1.52; } else { wa=a+0.62; hd=R*0.98; }
 }
 else if(c.type==='cannon'){ wa=a; hd=R*1.04; } /* グスタフ：大砲腕を体からしっかり突き出して砲身を見せる */
 else { wa=a; hd=R*0.92; }
 const hx=x+Math.cos(wa)*hd, hy=y+R*0.20+Math.sin(wa)*hd*0.78;
 drawWeapon(e,hx,hy,wa,R);
 /* 丸い体：下側に影、上側に光を入れて立体感を出す */
 ctx.beginPath(); ctx.arc(x,y+R*0.20,R,0,6.28); ctx.fillStyle=c.outfit; ctx.fill(); ctx.lineWidth=3.5; ctx.strokeStyle='rgba(0,0,0,0.38)'; ctx.stroke();
 ctx.beginPath(); ctx.arc(x,y+R*0.20,R,Math.PI*0.15,Math.PI*0.85); ctx.lineWidth=R*0.34; ctx.strokeStyle='rgba(0,0,0,0.13)'; ctx.stroke();
 ctx.beginPath(); ctx.ellipse(x-R*0.30,y-R*0.12,R*0.42,R*0.26,-0.5,0,6.28); ctx.fillStyle='rgba(255,255,255,0.20)'; ctx.fill();
 drawOutfit(e,x,y,R);
 /* 腰ベルト＋金バックル */
 ctx.strokeStyle='#5d3a12'; ctx.lineWidth=4.5; ctx.beginPath(); ctx.arc(x,y+R*0.20,R*0.93,Math.PI*0.30,Math.PI*0.70); ctx.stroke();
 ctx.fillStyle='#ffc93c'; ctx.beginPath(); ctx.roundRect(x-5,y+R*0.20+R*0.80,10,8,2); ctx.fill(); ctx.strokeStyle='#8a5a24'; ctx.lineWidth=1.6; ctx.stroke();
 /* 反対側の手。ブルーノは反対側もグローブの拳（構えた側）で描く：
    攻撃中は出した手と反対側、待機中は進行方向の左寄りに構える */
 let fhx,fhy;
 if(c.type==='fist'){
   const guardA=e.swing>0 ? a-(e.lastPunch?1:-1)*0.42 : a-0.62;
   const ghd=e.swing>0?R*0.98:R*0.98;
   fhx=x+Math.cos(guardA)*ghd; fhy=y+R*0.24+Math.sin(guardA)*ghd*0.78;
   drawWeapon(e,fhx,fhy,guardA,R);
 } else if(c.type==='breath'){ /* バート：反対の手には片手で持ったラム酒の瓶（緑の瓶＋細い首＋コルク）。
      火吹きの相棒なので、体の横でしっかり握っているのが見えるように描く */
   fhx=x+Math.cos(a-1.9)*R*0.95; fhy=y+R*0.30+Math.sin(a-1.9)*R*0.45;
   ctx.save(); ctx.translate(fhx,fhy); ctx.rotate(a-1.9+0.5);
   ctx.fillStyle='#1e7a4f'; ctx.beginPath(); ctx.roundRect(-R*0.17,-R*0.30,R*0.34,R*0.52,4); ctx.fill(); ctx.lineWidth=2.2; ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.stroke();
   ctx.fillStyle='#27ae60'; ctx.fillRect(-R*0.07,-R*0.46,R*0.14,R*0.18); /* 瓶の首 */
   ctx.fillStyle='#c9a35f'; ctx.fillRect(-R*0.075,-R*0.55,R*0.15,R*0.10); /* コルク */
   ctx.fillStyle='rgba(255,255,255,0.35)'; ctx.fillRect(-R*0.12,-R*0.24,R*0.08,R*0.36); /* 瓶の光 */
   ctx.fillStyle='#f5e9c9'; ctx.fillRect(-R*0.13,-R*0.05,R*0.26,R*0.18); /* ラベル */
   ctx.restore();
   ctx.beginPath(); ctx.arc(fhx,fhy+R*0.10,R*0.20,0,6.28); ctx.fillStyle=skin; ctx.fill(); ctx.lineWidth=2.2; ctx.strokeStyle='rgba(0,0,0,0.3)'; ctx.stroke(); /* 瓶を握る手 */
 } else {
   fhx=x+Math.cos(a-1.9)*R*0.92; fhy=y+R*0.30+Math.sin(a-1.9)*R*0.45;
   ctx.beginPath(); ctx.arc(fhx,fhy,R*0.24,0,6.28); ctx.fillStyle=skin; ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.3)'; ctx.stroke();
 }
 /* ブルーノのキック演出：kickT の間、脚が kickDir の左右約43度ずつを
    弧を描いて振り抜ける。弧の軌跡（金のスイープ）と今の足の位置を描く */
 if(c.type==='fist'&&(e.kickT||0)>0){
   const dur=e.kickDur||KICK_DUR, kp=Math.min(1,Math.max(0,1-e.kickT/dur));
   const fa=e.kickDir-KICK_SWEEP/2+KICK_SWEEP*kp; /* 今の足の角度（スイープ中） */
   const arcR=c.kickRange||69, acx=x, acy=y+R*0.24;
   /* 振り抜けた範囲：脚全体が通過した扇形を薄く金色に塗る（この範囲は
      脚の付け根からつま先まで全部に当たり判定があることを見せる）。
      あわせて足先の軌跡のラインも描く */
   if(kp>0.02){
     ctx.beginPath(); ctx.arc(acx,acy,arcR,e.kickDir-KICK_SWEEP/2,fa); ctx.arc(acx,acy,R*0.35,fa,e.kickDir-KICK_SWEEP/2,true); ctx.closePath(); ctx.fillStyle='rgba(255,201,60,0.16)'; ctx.fill();
     ctx.beginPath(); ctx.arc(acx,acy,arcR,e.kickDir-KICK_SWEEP/2,fa); ctx.strokeStyle='rgba(255,233,168,0.75)'; ctx.lineWidth=4; ctx.lineCap='round'; ctx.stroke();
   }
   /* 脚：体の中心から足先（当たり判定の先端と同位置）までまっすぐ伸ばす。
      以前は脚の絵が判定よりずっと短く、見た目と当たり判定がズレていた */
   const kx=acx+Math.cos(fa)*arcR, ky=acy+Math.sin(fa)*arcR;
   ctx.strokeStyle=c.outfitDark; ctx.lineCap='round'; ctx.lineWidth=R*0.34;
   ctx.beginPath(); ctx.moveTo(x+Math.cos(fa)*R*0.30,y+R*0.34+Math.sin(fa)*R*0.22); ctx.lineTo(kx,ky); ctx.stroke();
   ctx.save(); ctx.translate(kx,ky); ctx.rotate(fa);
   ctx.beginPath(); ctx.ellipse(R*0.16,0,R*0.42,R*0.24,0,0,6.28); ctx.fillStyle='#5d3a12'; ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.stroke(); /* 靴 */
   ctx.fillStyle='#e9e2d0'; ctx.fillRect(-R*0.10,-R*0.24,R*0.16,R*0.48); /* 足首のバンテージ */
   ctx.restore();
   /* 今の足先の位置に衝撃の輪 */
   const fx2=acx+Math.cos(fa)*arcR, fy2=acy+Math.sin(fa)*arcR;
   ctx.beginPath(); ctx.arc(fx2,fy2,20+6*Math.sin(kp*Math.PI),0,6.28); ctx.strokeStyle='rgba(255,255,255,0.65)'; ctx.lineWidth=3; ctx.stroke();
 }
 /* 頭と顔 */
 const cxp=x+Math.cos(a)*2.5, cyp=y-R*0.36+Math.sin(a)*1.5, hr=c.id==='gustav'?R*0.66:R*0.60; /* グスタフは三角帽子と眼帯の見せ場が多いので頭を少しだけ大きく */
 ctx.beginPath(); ctx.arc(cxp,cyp,hr,0,6.28); ctx.fillStyle=skin; ctx.fill(); ctx.lineWidth=3; ctx.strokeStyle='rgba(0,0,0,0.32)'; ctx.stroke();
 ctx.beginPath(); ctx.arc(cxp,cyp,hr,Math.PI*0.25,Math.PI*0.75); ctx.lineWidth=hr*0.30; ctx.strokeStyle='rgba(0,0,0,0.08)'; ctx.stroke();
 drawHeadGear(e,cxp,cyp,hr);
 drawFace(e,cxp,cyp,hr);
 /* 武器の手（武器の上に重ねる）。ヴェラは武器がないので手は体の横に小さく出すだけ。
    ブルーノの拳は drawWeapon のグローブが手そのものなので、肌色の丸は重ねない */
 if(c.type!=='fire'&&c.type!=='fist'&&c.type!=='cannon'&&c.type!=='breath'){ ctx.beginPath(); ctx.arc(hx,hy,R*0.24,0,6.28); ctx.fillStyle=skin; ctx.fill(); ctx.lineWidth=2.5; ctx.strokeStyle='rgba(0,0,0,0.3)'; ctx.stroke(); }
 /* 炎玉の手前側（体の前に重ねる） */
 if(fballs.length) fballs.forEach((b,i)=>{ if(Math.sin(b.a)>=0) drawFlameBall(b.x,b.y+R*0.2,fbr,ftNow,i); });
 /* 被弾フラッシュ */
 if(e.hitFlash>0){ ctx.globalAlpha=Math.min(0.65,e.hitFlash*5); ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(x,y+R*0.2,R,0,6.28); ctx.fill(); ctx.beginPath(); ctx.arc(cxp,cyp,hr,0,6.28); ctx.fill(); ctx.globalAlpha=1; }
 /* （プレイヤーの目印は足元の楕円マーカー＋頭上の▼。体を囲む丸は廃止） */
 /* 自動回復中：足元に緑の楕円リング＋十字マークで「回復している」ことを見せる */
 if(e.isRegen){ const pulse=0.55+0.35*Math.sin(performance.now()/180); ctx.beginPath(); ctx.ellipse(e.x,e.y+R*0.98,R*1.22,R*0.46,0,0,6.28); ctx.strokeStyle=`rgba(46,213,115,${pulse})`; ctx.lineWidth=3; ctx.stroke();
   ctx.fillStyle='#2ed573'; ctx.font='900 13px "M PLUS Rounded 1c"'; ctx.textAlign='center'; ctx.fillText('✚',x+R+13,y-R-2); }
 if(tpSink>0) ctx.restore(); /* テレポートの沈み演出はここまで（頭上の表示は沈ませない） */
 /* 頭上：名前＋HPバー（Yohoho風）。ヴェラーはモードも出す（BOTはランダムなので見分けがつく） */
 const label=(e.isPlayer?'あなた':e.name)+(c.type==='fire'?' '+veraModeInfo(veraModeOf(e)).short:'')+(e.power?' 💚'+e.power:'');
 ctx.font='800 12px "M PLUS Rounded 1c"'; ctx.textAlign='center'; ctx.lineWidth=3.5; ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.fillStyle='#fff';
 const ny=y-R-26; ctx.strokeText(label,x,ny); ctx.fillText(label,x,ny);
 /* プレイヤーは名前の上に小さな金色の▼が揺れる（足元マーカーとセットの目印） */
 if(e.isPlayer){ const ty=ny-12+Math.sin(performance.now()/280)*2.5;
   ctx.beginPath(); ctx.moveTo(x-6.5,ty-5); ctx.lineTo(x+6.5,ty-5); ctx.lineTo(x,ty+3.5); ctx.closePath();
   ctx.fillStyle='#ffc93c'; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle='rgba(0,0,0,0.45)'; ctx.stroke(); }
 const bw=54, bx=x-bw/2, by=ny+5, ratio=Math.max(0,e.hp/maxHpOf(e));
 ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(bx-1.5,by-1.5,bw+3,9,4.5); ctx.fill();
 ctx.fillStyle=e.isPlayer?'#2ed573':'#ff4757'; if(ratio>0){ ctx.beginPath(); ctx.roundRect(bx,by,bw*ratio,6,3); ctx.fill(); }
 if(e.holding&&chargeReady(e)){ ctx.font='14px serif'; ctx.fillText('💥',x+bw/2+11,by+7); }
 /* ★ HPバーの真下：リロード（弾）表示。スマホでは左下HUDが非表示になるので、
    弾の残りはここで確認する（PCでもそのまま見える）。
    青いマス＝撃てる弾／薄いマス＝リロード中（次の1発はたまった分だけ青が伸びる）。
    ジャックは近接でリロードなしなので何も出さない */
 if(e.char.ammo>0){
   const ry=by+10, rh=6, gap=3, segW=(bw-gap*(e.char.ammo-1))/e.char.ammo;
   ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(bx-1.5,ry-1.5,bw+3,rh+3,4); ctx.fill();
   for(let i=0;i<e.char.ammo;i++){
     const sx=bx+i*(segW+gap);
     if(i<e.ammo){ ctx.fillStyle='#25a6e8'; ctx.beginPath(); ctx.roundRect(sx,ry,segW,rh,2.5); ctx.fill(); }
     else if(i===e.ammo&&e.reloadT>0&&e.char.reload>0){ /* リロード中の次の1発：進み具合だけ青く */
       ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.beginPath(); ctx.roundRect(sx,ry,segW,rh,2.5); ctx.fill();
       const p=Math.max(0,Math.min(1,1-e.reloadT/e.char.reload));
       if(p>0){ ctx.fillStyle='#7fd4ff'; ctx.beginPath(); ctx.roundRect(sx,ry,segW*p,rh,2.5); ctx.fill(); }
     } else { ctx.fillStyle='rgba(255,255,255,0.28)'; ctx.beginPath(); ctx.roundRect(sx,ry,segW,rh,2.5); ctx.fill(); }
   }
   if(e.ammo===0){ ctx.font='900 9px "M PLUS Rounded 1c"'; ctx.textAlign='left'; ctx.fillStyle='#ffd9d9'; ctx.fillText('リロード中',bx+bw+5,ry+6); }
 }
 /* ★ バートの息ゲージ：HPバーの真下にオレンジのバーで残りの息（燃料）を出す。
    息切れ中は赤く点滅して「吐けない」ことが分かる。スマホでもここで確認できる */
 if(e.char.type==='breath'){
   const ry=by+10, rh=6, fMax=e.char.breathMax||3, fr=Math.max(0,e.breathFuel/fMax);
   ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(bx-1.5,ry-1.5,bw+3,rh+3,4); ctx.fill();
   const over=e.breathOver, blink=over&&(Math.floor(performance.now()/220)%2===0);
   ctx.fillStyle=over?(blink?'#ff4757':'#8f1f0e'):'#ff7b1c';
   if(fr>0){ ctx.beginPath(); ctx.roundRect(bx,ry,bw*fr,rh,2.5); ctx.fill(); }
   ctx.font='900 9px "M PLUS Rounded 1c"'; ctx.textAlign='left';
   ctx.fillStyle=over?'#ffd9d9':'#ffe1b0';
   ctx.fillText(over?'息切れ中':'息 '+e.breathFuel.toFixed(1)+'秒',bx+bw+5,ry+6);
 }
 /* ★ 幽霊・キャプテンの幽霊化ゲージ：弾マスの下に水色のバーで残り時間を出す。
    幽霊化中は明るく、使い切った回復待ちは赤く点滅する。スマホでもここで確認できる */
 if(e.char.id==='captain'){
   const ry=by+20, rh=6, gMax=e.char.ghostMax||3.5, fr=Math.max(0,e.ghostFuel/gMax);
   ctx.fillStyle='rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.roundRect(bx-1.5,ry-1.5,bw+3,rh+3,4); ctx.fill();
   const over=e.ghostOver, blink=over&&(Math.floor(performance.now()/220)%2===0);
   ctx.fillStyle=over?(blink?'#ff4757':'#7a2030'):(isGhost(e)?'#37c8d9':'#8ef6ff');
   if(fr>0){ ctx.beginPath(); ctx.roundRect(bx,ry,bw*fr,rh,2.5); ctx.fill(); }
   ctx.font='900 9px "M PLUS Rounded 1c"'; ctx.textAlign='left';
   ctx.fillStyle=over?'#ffd9d9':'#d8f7ff';
   ctx.fillText(over?'回復中':(isGhost(e)?'幽霊化中':'幽霊 '+e.ghostFuel.toFixed(1)+'秒'),bx+bw+5,ry+6);
 }
 if(ghosting) ctx.restore(); /* 幽霊化中の半透明はここまで */
}

/* 障害物の描画（ステージごとに形が違う）。当たり判定の半径 o.r は幹・本体の大きさ */
function drawObstacle(o){
 const x=o.x, y=o.y, r=o.r;
 ctx.fillStyle='#00000030'; ctx.beginPath(); ctx.ellipse(x,y+r*0.85,r*0.95,r*0.30,0,0,6.28); ctx.fill();
 if(o.type==='tree'){ /* 木：幹＋丸い樹冠 */
   ctx.fillStyle='#7a4a1e'; ctx.beginPath(); ctx.arc(x,y,r*0.45,0,6.28); ctx.fill();
   ctx.fillStyle='#2f8f2a'; ctx.beginPath(); ctx.arc(x,y-r*0.55,r*1.25,0,6.28); ctx.arc(x-r*0.75,y-r*0.15,r*0.85,0,6.28); ctx.arc(x+r*0.75,y-r*0.15,r*0.85,0,6.28); ctx.fill();
   ctx.fillStyle='rgba(255,255,255,0.16)'; ctx.beginPath(); ctx.arc(x-r*0.4,y-r*0.85,r*0.5,0,6.28); ctx.fill();
 } else if(o.type==='deadtree'){ /* 枯れ木：黒い幹と枝だけ */
   ctx.strokeStyle='#241a14'; ctx.lineCap='round'; ctx.lineWidth=r*0.42; ctx.beginPath(); ctx.moveTo(x,y+r*0.5); ctx.lineTo(x,y-r*0.7); ctx.stroke();
   ctx.lineWidth=r*0.18; ctx.beginPath(); ctx.moveTo(x,y-r*0.3); ctx.lineTo(x-r*0.95,y-r*1.05); ctx.moveTo(x,y-r*0.45); ctx.lineTo(x+r*0.85,y-r*1.2); ctx.stroke();
 } else if(o.type==='rock'){ /* 黒岩：ゴツゴツした多角形＋マグマ色の割れ目 */
   ctx.fillStyle='#2e2a28'; ctx.beginPath();
   for(let i=0;i<7;i++){ const a=i/7*6.28, rr=r*(0.85+((i*37)%20)/100); const px=x+Math.cos(a)*rr, py=y+Math.sin(a)*rr*0.88; i?ctx.lineTo(px,py):ctx.moveTo(px,py); }
   ctx.closePath(); ctx.fill(); ctx.lineWidth=3; ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.stroke();
   ctx.fillStyle='rgba(255,255,255,0.13)'; ctx.beginPath(); ctx.arc(x-r*0.3,y-r*0.35,r*0.34,0,6.28); ctx.fill();
   ctx.strokeStyle='#ff7b1c'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x-r*0.1,y+r*0.5); ctx.lineTo(x+r*0.15,y); ctx.lineTo(x+r*0.05,y-r*0.45); ctx.stroke();
 } else if(o.type==='barrel'){ /* タル：丸い木の樽＋鉄の帯 */
   ctx.beginPath(); ctx.arc(x,y,r,0,6.28); ctx.fillStyle='#8a5a24'; ctx.fill(); ctx.lineWidth=3; ctx.strokeStyle='#5d3a12'; ctx.stroke();
   ctx.beginPath(); ctx.arc(x,y,r*0.66,0,6.28); ctx.strokeStyle='#39404d'; ctx.lineWidth=4; ctx.stroke();
   ctx.beginPath(); ctx.arc(x,y,r*0.30,0,6.28); ctx.fillStyle='#a9743a'; ctx.fill();
 } else if(o.type==='mast'){ /* マスト：太い柱＋土台の輪。船のシンボル */
   ctx.beginPath(); ctx.arc(x,y,r*1.18,0,6.28); ctx.fillStyle='#6e4517'; ctx.fill(); ctx.lineWidth=3; ctx.strokeStyle='#4a2c0d'; ctx.stroke();
   ctx.beginPath(); ctx.arc(x,y,r,0,6.28); ctx.fillStyle='#8a5a24'; ctx.fill();
   ctx.beginPath(); ctx.arc(x,y,r*0.55,0,6.28); ctx.fillStyle='#a9743a'; ctx.fill(); ctx.strokeStyle='#5d3a12'; ctx.lineWidth=3; ctx.stroke();
   ctx.beginPath(); ctx.arc(x,y,r*0.20,0,6.28); ctx.fillStyle='#ffc93c'; ctx.fill();
 } else if(o.type==='iceblock'){ /* 氷ブロック：水色の四角＋ひび */
   ctx.beginPath(); ctx.roundRect(x-r,y-r,r*2,r*2,9); ctx.fillStyle='#a5dcf5'; ctx.fill(); ctx.lineWidth=3.5; ctx.strokeStyle='#e8f7ff'; ctx.stroke();
   ctx.strokeStyle='rgba(255,255,255,0.75)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x-r*0.5,y-r*0.55); ctx.lineTo(x-r*0.05,y+r*0.05); ctx.lineTo(x-r*0.35,y+r*0.55); ctx.moveTo(x+r*0.15,y-r*0.6); ctx.lineTo(x+r*0.45,y-r*0.05); ctx.stroke();
   ctx.fillStyle='rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.roundRect(x-r*0.8,y-r*0.8,r*0.7,r*0.45,6); ctx.fill();
 } else if(o.type==='pinetree'){ /* 雪の松：白をかぶった三角の樹冠 */
   ctx.fillStyle='#5d3a12'; ctx.beginPath(); ctx.arc(x,y,r*0.38,0,6.28); ctx.fill();
   ctx.fillStyle='#1e7a4f'; ctx.beginPath(); ctx.arc(x,y-r*0.5,r*1.15,0,6.28); ctx.arc(x-r*0.65,y-r*0.05,r*0.75,0,6.28); ctx.arc(x+r*0.65,y-r*0.05,r*0.75,0,6.28); ctx.fill();
   ctx.fillStyle='rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(x,y-r*0.95,r*0.48,0,6.28); ctx.arc(x-r*0.55,y-r*0.35,r*0.34,0,6.28); ctx.fill();
 }
}
/* ============================================================
   死神の「冥府潜りテレポート」ワープ先マーカー：溜めている間だけ、
   向いている方向の着地点（tpDest と同じ計算）に、地面の穴（ポータル）と
   半透明のゴーストの影を表示する。溜まるほど濃くなり、満タンでは
   リングが脈打つので、「今離せばどの辺に現れるか」が一目で分かる。
   地面に描くものなので、キャラ本体より先（下）に描く（drawWorld から呼ぶ）
   ============================================================ */
function drawTpMarker(e){
 const p=Math.min(1,e.chargeT/e.char.chargeTime), full=p>=1, now=performance.now();
 const d=tpDest(e,e.angle), R=e.r;
 const pulse=0.5+0.5*Math.sin(now/180);
 ctx.save();
 /* 経路：自分から着地点への薄い破線 */
 ctx.strokeStyle=`rgba(142,246,255,${0.18+0.30*p})`; ctx.lineWidth=2; ctx.setLineDash([5,9]);
 ctx.beginPath(); ctx.moveTo(e.x,e.y); ctx.lineTo(d.x,d.y); ctx.stroke(); ctx.setLineDash([]);
 /* 着地点の穴（ポータル）：潜る演出の穴と同じ見た目 */
 const pr=R*(1.05+0.12*pulse*(full?1:0.4));
 ctx.beginPath(); ctx.ellipse(d.x,d.y+R*0.95,pr,pr*0.36,0,0,6.28); ctx.fillStyle=`rgba(8,4,18,${0.35+0.30*p})`; ctx.fill();
 ctx.lineWidth=2; ctx.strokeStyle=`rgba(142,246,255,${0.35+0.45*p})`; ctx.stroke();
 /* ゴーストの影：半透明の体とフード、光る目（着地点に立つ自分の幻） */
 ctx.globalAlpha=0.22+0.40*p;
 ctx.beginPath(); ctx.arc(d.x,d.y,R,0,6.28); ctx.fillStyle=e.char.outfit; ctx.fill();
 ctx.beginPath(); ctx.arc(d.x,d.y-R*0.18,R*0.66,0,6.28); ctx.fillStyle=e.char.hatColor; ctx.fill();
 ctx.globalAlpha=0.35+0.55*p;
 ctx.fillStyle='#8ef6ff';
 ctx.beginPath(); ctx.arc(d.x-R*0.24,d.y-R*0.22,R*0.09,0,6.28); ctx.fill();
 ctx.beginPath(); ctx.arc(d.x+R*0.24,d.y-R*0.22,R*0.09,0,6.28); ctx.fill();
 ctx.restore();
 /* 満タン：着地点を囲む脈打つリングで「今だ！離せばワープ」を強調 */
 if(full){ ctx.beginPath(); ctx.arc(d.x,d.y,R+6+3*pulse); ctx.strokeStyle=`rgba(142,246,255,${0.35+0.35*pulse})`; ctx.lineWidth=2.5; ctx.stroke(); }
}
function drawWorld(){
 ctx.save();
 const sx=(Math.random()-.5)*shake, sy=(Math.random()-.5)*shake;
 ctx.translate(-cam.x+sx,-cam.y+sy);
 const st=currentStage||STAGES[0];
 /* 床：ステージごとに市松／板張りを描き分ける（円の外は drawBG の海やマグマ） */
 ctx.save();
 ctx.beginPath(); ctx.arc(WORLD/2,WORLD/2,730,0,6.28); ctx.clip();
 if(st.floorKind==='planks'){ /* 海賊船デッキ：横向きの板張り＋板の境目と釘 */
   const ph=64;
   for(let gy=0;gy<WORLD/ph;gy++){ ctx.fillStyle=gy%2?st.floorA:st.floorB; ctx.fillRect(0,gy*ph,WORLD,ph); ctx.fillStyle='rgba(0,0,0,0.22)'; ctx.fillRect(0,gy*ph,WORLD,3); }
   ctx.fillStyle='rgba(0,0,0,0.16)';
   for(let i=0;i<40;i++){ const x=(i*263)%WORLD, y=Math.floor((i*389)%WORLD/64)*64; ctx.fillRect(x,y,3,64); }
   ctx.fillStyle='rgba(0,0,0,0.35)'; for(let i=0;i<60;i++){ const x=(i*197)%WORLD, y=(i*151)%WORLD; ctx.beginPath(); ctx.arc(x,y,2.4,0,6.28); ctx.fill(); }
 } else {
   const sq=92;
   for(let gx=0;gx<WORLD/sq;gx++){ for(let gy=0;gy<WORLD/sq;gy++){ ctx.fillStyle=(gx+gy)%2?st.floorA:st.floorB; ctx.fillRect(gx*sq,gy*sq,sq,sq); } }
 }
 ctx.fillStyle='rgba(0,0,0,0.05)'; for(let i=0;i<90;i++){ const x=(i*211)%WORLD, y=(i*149)%WORLD; if(Math.hypot(x-WORLD/2,y-WORLD/2)<700){ ctx.fillRect(x,y,22,5); ctx.fillRect(x+6,y-7,5,5); } }
 if(st.id==='magma'){ /* 床のひび割れからマグマがのぞく */
   ctx.strokeStyle='rgba(255,110,20,0.5)'; ctx.lineWidth=2.5;
   for(let i=0;i<16;i++){ const x=(i*281)%WORLD, y=(i*173)%WORLD; if(Math.hypot(x-WORLD/2,y-WORLD/2)<680){ ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+26,y+12); ctx.lineTo(x+44,y+4); ctx.stroke(); } }
 }
 ctx.restore();
 ctx.beginPath(); ctx.arc(WORLD/2,WORLD/2,730,0,6.28); ctx.lineWidth=20; ctx.strokeStyle=st.edge; ctx.stroke(); ctx.lineWidth=6; ctx.strokeStyle=st.edgeDark; ctx.stroke();
 /* 仕掛け（池）：マグマはダメージ、氷は速くなる */
 hazards.forEach(h=>{
   if(h.type==='magma'){
     const pulse=0.75+0.25*Math.sin(performance.now()/320+h.x);
     ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,6.28); ctx.fillStyle='#571f0d'; ctx.fill();
     ctx.beginPath(); ctx.arc(h.x,h.y,h.r*0.88,0,6.28); ctx.fillStyle='#d63c0a'; ctx.fill();
     ctx.beginPath(); ctx.arc(h.x,h.y,h.r*0.66*pulse+6,0,6.28); ctx.fillStyle='#ff7b1c'; ctx.fill();
     ctx.fillStyle='#ffc93c'; [[-0.3,-0.2],[0.25,0.3],[0.05,-0.45]].forEach(([ox,oy])=>{ ctx.beginPath(); ctx.arc(h.x+ox*h.r,h.y+oy*h.r,h.r*0.13,0,6.28); ctx.fill(); });
     ctx.font='900 13px "M PLUS Rounded 1c"'; ctx.textAlign='center'; ctx.fillStyle='#fff'; ctx.fillText('🌋 マグマ',h.x,h.y-h.r-8);
   } else if(h.type==='ice'){
     ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,6.28); ctx.fillStyle='rgba(220,245,255,0.75)'; ctx.fill(); ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.9)'; ctx.stroke();
     ctx.strokeStyle='rgba(120,190,235,0.7)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(h.x-h.r*0.5,h.y-h.r*0.2); ctx.lineTo(h.x-h.r*0.1,h.y+h.r*0.25); ctx.lineTo(h.x+h.r*0.35,h.y+h.r*0.05); ctx.stroke();
     ctx.font='900 13px "M PLUS Rounded 1c"'; ctx.textAlign='center'; ctx.fillStyle='#14507c'; ctx.fillText('❄️ ツルツル氷',h.x,h.y-h.r-8);
   }
 });
 /* 飾り（すり抜けられる）：茂み／灰／ロープ／雪 */
 decors.forEach(d=>{
   if(d.type==='bush'){ ctx.fillStyle='#3e9c35'; ctx.beginPath(); ctx.arc(d.x,d.y,d.r,0,6.28); ctx.arc(d.x+d.r*0.7,d.y+d.r*0.15,d.r*0.8,0,6.28); ctx.fill(); }
   else if(d.type==='ash'){ ctx.fillStyle='rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(d.x,d.y,d.r,d.r*0.55,0.4,0,6.28); ctx.fill(); }
   else if(d.type==='rope'){ ctx.beginPath(); ctx.arc(d.x,d.y,d.r,0,6.28); ctx.strokeStyle='#c9a35f'; ctx.lineWidth=5; ctx.stroke(); ctx.beginPath(); ctx.arc(d.x,d.y,d.r*0.55,0,6.28); ctx.strokeStyle='#a97f3d'; ctx.stroke(); }
   else if(d.type==='snow'){ ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.ellipse(d.x,d.y,d.r,d.r*0.6,-0.3,0,6.28); ctx.fill(); }
 });
 obstacles.forEach(drawObstacle);
 if(zone.r<760){ ctx.beginPath(); ctx.arc(zone.x,zone.y,(zone.r+760)/2,0,6.28); ctx.strokeStyle='rgba(165,94,234,0.55)'; ctx.lineWidth=Math.max(0,760-zone.r); ctx.stroke(); }
 ctx.beginPath(); ctx.arc(zone.x,zone.y,zone.r,0,6.28); ctx.strokeStyle='#a55eea'; ctx.lineWidth=5; ctx.stroke();
 cubes.forEach(c=>{ ctx.fillStyle='#2ed573'; ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath(); ctx.roundRect(c.x-11,c.y-11,22,22,5); ctx.fill(); ctx.stroke(); ctx.fillStyle='#fff'; ctx.font='900 13px sans-serif'; ctx.textAlign='center'; ctx.fillText('◆',c.x,c.y+5); });
 crates.forEach(c=>{ if(!c.alive) return; ctx.fillStyle='#b7792b'; ctx.strokeStyle='#7a4a12'; ctx.lineWidth=3; ctx.beginPath(); ctx.roundRect(c.x-24,c.y-24,48,48,6); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(c.x-24,c.y-24); ctx.lineTo(c.x+24,c.y+24); ctx.moveTo(c.x+24,c.y-24); ctx.lineTo(c.x-24,c.y+24); ctx.stroke(); ctx.fillStyle='#00000055'; ctx.fillRect(c.x-20,c.y-32,40,6); ctx.fillStyle='#2ed573'; ctx.fillRect(c.x-20,c.y-32,40*Math.max(0,c.hp/400),6); });
 bullets.forEach(b=>{ if(b.type==='fireball'||b.type==='spiral'){ drawFlameBall(b.x,b.y,b.r,performance.now(),(b.phase||0)*3+1); return; } if(b.type==='bullet'||b.type==='powerbolt'){ const ba=Math.atan2(b.vy,b.vx); const big=b.type==='powerbolt'; ctx.strokeStyle=big?'#ff6b81':'#f5f0dc'; ctx.lineWidth=big?7:3.5; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(b.x-Math.cos(ba)*(big?16:8),b.y-Math.sin(ba)*(big?16:8)); ctx.lineTo(b.x+Math.cos(ba)*(big?16:8),b.y+Math.sin(ba)*(big?16:8)); ctx.stroke(); ctx.fillStyle='#ffc93c'; ctx.beginPath(); ctx.arc(b.x+Math.cos(ba)*(big?16:8),b.y+Math.sin(ba)*(big?16:8),big?4.5:2.6,0,6.28); ctx.fill(); return; } ctx.beginPath(); ctx.arc(b.x,b.y,b.r,0,6.28); ctx.fillStyle=b.color; ctx.fill(); ctx.strokeStyle='#00000066'; ctx.stroke(); if(b.type.includes('bomb')){ctx.fillStyle='#ffc93c'; ctx.fillRect(b.x-2,b.y-b.r-6,4,6);} });
 /* 死神のワープ先マーカーは地面に描くので、キャラ本体の前に（下に）描く。
    ★ マーカーもキャラ本体も「1体ごとに save/restore で隔離」して描く：
      万一どれか1体の描画で問題が起きても、座標変換が漏れて画面全体の
      描画（毒ゾーンの輪など）が壊れ続けることがないようにする */
 entities.forEach(e=>{ if(e.alive&&e.char.type==='scythe'&&e.holding&&e.tpT<=0){ ctx.save(); try{ drawTpMarker(e); }catch(_){ } ctx.restore(); } });
 [...entities].sort((a,b)=>a.y-b.y).forEach(e=>{ if(e.alive){ ctx.save(); try{ drawEntity(e); }catch(_){ } ctx.restore(); } });
 particles.forEach(p=>{ ctx.globalAlpha=Math.max(0,p.life/p.max); if(p.slash){ ctx.strokeStyle=p.color; ctx.lineWidth=5; ctx.lineCap='round'; ctx.beginPath(); ctx.arc(p.x,p.y,p.size*2.1,p.angle-1,p.angle+1); ctx.stroke(); } else if(p.heal){ ctx.fillStyle=p.color; ctx.font='900 12px "M PLUS Rounded 1c"'; ctx.textAlign='center'; ctx.fillText('✚',p.x,p.y); } else { ctx.fillStyle=p.color; ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,6.28); ctx.fill(); } }); ctx.globalAlpha=1;
 floaters.forEach(f=>{ ctx.font='900 16px "M PLUS Rounded 1c"'; ctx.textAlign='center'; ctx.fillStyle=f.color; ctx.strokeStyle='#000'; ctx.lineWidth=3; ctx.strokeText(f.text,f.x,f.y); ctx.fillText(f.text,f.x,f.y); });
 ctx.restore();
 if(player&&state==='playing'&&dist(player,zone)>zone.r){ ctx.fillStyle='rgba(165,94,234,0.18)'; ctx.fillRect(0,0,W,H); ctx.font='900 22px "M PLUS Rounded 1c"'; ctx.textAlign='center'; ctx.fillStyle='#fff'; ctx.fillText('☠️ 毒ゾーンの外だ！早く戻れ！',W/2,42); }
}
resize();
cam={x:320,y:480}; zone={x:WORLD/2,y:WORLD/2,r:720}; player=null;
/* ロビーの後ろにうっすら見えるバトル画面用に、初期ステージ（グリーン島）の地形だけ先に置いておく */
generateStageLayout(currentStage,[{x:WORLD/2,y:WORLD/2}]);
