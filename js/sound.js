/* ============================================================
   効果音：assets/js/sound.js
   ★ 音声ファイルは使わず、Web Audio API でその場で合成する
     （外部ファイルなし・オフラインでも鳴る・キャラごとに音を変えられる）。
   ★ 「安っぽさ」対策として3つ入れてある：
     1) リバーブ（残響）：短い残響を人工的に作って全ての音に薄く混ぜる。
        裸の電子音が「空間で鳴っている音」に変わる一番効く工夫。
     2) ステレオ定位：音の出た位置（左右）でパンする。戦場に広がりが出る。
     3) 倍音の重ね：金属音は金属らしい非整数倍音、コインやキューブは
        鐘らしい倍音で鳴らす。単音のピコピコ感を消す。
   ★ ブラウザの決まりで、音は「最初のタップ／キー操作」のあとでないと
     鳴らせない。最初の操作で AudioContext を起こす（ensure）仕組み。
   ★ 鳴らしたい場所からは SFX.play('名前',{vol,pan}) と呼ぶだけ。
     ゲーム本体からは game.js の playSfx() 経由で呼ぶ（遠くのBOTの音は
     小さく／カットして、うるさくなりすぎないようにしてある）。
   ★ ON/OFF と音量は設定部屋（⚙️ 設定）で変えられる。記録はこのページを
     開いている間だけ（ガチャやボタン位置の設定と同じ扱い）。
   ★ 同じ音が短時間に重なりすぎないよう、音ごとに最小間隔（スロットル）を
     設けてある。連打・多段ヒットでも破綻しない。
   ============================================================ */
(function(){
'use strict';
let actx=null, master=null, noiseBuf=null, verbIn=null;
let enabled=true;
let volume=0.8; /* 0〜1（設定部屋のスライダー） */
const lastPlay={}; /* 音の名前 -> 最後に鳴らした時刻(ms) */

/* 音ごとの最小間隔(ms)：この間隔より速くは同じ音を重ねない */
const THROTTLE={
  click:40, select:60, swing:70, punch:55, kickHit:70,
  shoot:50, fire:60, hit:75, hurt:110, guard:90, reflect:90,
  heal:400, cube:80, beep:100, reload:150
};
/* 音ごとのリバーブ量（0〜1）：爆発や大砲は広く、クリックは控えめに */
const WET={
  click:0.06, select:0.12, start:0.18, swing:0.10, punch:0.10, kick:0.10,
  kickHit:0.14, dash:0.12, shoot:0.12, powerbolt:0.22, bomb:0.10, fire:0.14,
  spiral:0.22, cannon:0.34, scatter:0.30, explode:0.42, explodeSmall:0.34,
  hit:0.10, hurt:0.10, die:0.20, reflect:0.30, guard:0.22, cube:0.26,
  heal:0.30, ready:0.24, reload:0.08, coin:0.20, beep:0.14, go:0.22,
  victory:0.26, defeat:0.18, gacha:0.18, gachaRare:0.28
};

/* リバーブ用のインパルス応答（残響の型）をその場で作る：
   ノイズを指数減衰させ、ローパスで少しずつ暗くした「小さな部屋」の残響 */
function makeImpulse(dur,decay){
  const rate=actx.sampleRate, len=Math.max(1,Math.floor(rate*dur));
  const buf=actx.createBuffer(2,len,rate);
  for(let ch=0;ch<2;ch++){
    const d=buf.getChannelData(ch); let lp=0;
    for(let i=0;i<len;i++){
      const w=(Math.random()*2-1)*Math.pow(1-i/len,decay);
      lp+=0.30*(w-lp); /* 1ポールローパスで尾を暗く＝自然な残響 */
      d[i]=lp*1.7;
    }
  }
  return buf;
}

function ensure(){
  if(actx){
    if(actx.state==='suspended') actx.resume();
    return actx;
  }
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC) return null;
    actx=new AC();
    master=actx.createGain();
    master.gain.value=0.5*volume;
    /* コンプレッサー：爆発や大砲など大きな音が重なっても割れないよう、
       全体の音をぎゅっと締めて「ゲームらしい」まとまりを出す */
    const comp=actx.createDynamicsCompressor();
    comp.threshold.value=-16; comp.knee.value=18; comp.ratio.value=5;
    comp.attack.value=0.004; comp.release.value=0.18;
    master.connect(comp); comp.connect(actx.destination);
    /* リバーブ：コンボルバに残響の型を入れて、送信バス（verbIn）を作る。
       各音はドライ（直接）とウェット（残響経由）を混ぜて鳴らす */
    const verb=actx.createConvolver();
    verb.buffer=makeImpulse(0.75,2.4);
    const verbOut=actx.createGain(); verbOut.gain.value=0.9;
    verb.connect(verbOut); verbOut.connect(master);
    verbIn=actx.createGain(); verbIn.connect(verb);
    /* ノイズ用バッファ（打撃・爆発・風切りで使い回す） */
    const len=actx.sampleRate*1;
    noiseBuf=actx.createBuffer(1,len,actx.sampleRate);
    const d=noiseBuf.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
  }catch(e){ actx=null; }
  return actx;
}
/* 最初のユーザー操作でオーディオを起こす（スマホの自動再生制限対策） */
['pointerdown','touchstart','keydown'].forEach(ev=>{
  addEventListener(ev,()=>{ ensure(); },{passive:true});
});

function canPlay(name){
  if(!enabled) return false;
  const now=performance.now();
  const gap=THROTTLE[name]||30;
  if(lastPlay[name]&&now-lastPlay[name]<gap) return false;
  lastPlay[name]=now;
  return true;
}
/* play() の間だけ有効な出力バス（パン＋リバーブ送信つき）。
   tone()/noise() はここへつなぐので、1つの効果音を構成する全部の
   パーツが同じ位置・同じ残響で鳴る */
let curBus=null;
/* 単音：f→f2 へ周波数を滑らせながら鳴らす。
   ★ 毎回ほんの少しだけ音程をずらす（デチューン）：同じ剣の音でも
     微妙に違う音になるので、連打しても機械っぽくならない */
function tone(o){
  if(!ensure()) return;
  const t0=actx.currentTime+(o.delay||0);
  const det=o.det||(1+(Math.random()*0.05-0.025));
  const osc=actx.createOscillator(), g=actx.createGain();
  osc.type=o.type||'sine';
  osc.frequency.setValueAtTime((o.f||440)*det,t0);
  if(o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20,o.f2*det),t0+(o.t||0.15));
  const v=(o.v||0.25)*(o.volMul||1);
  g.gain.setValueAtTime(0.0001,t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002,v),t0+0.010);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+(o.t||0.15));
  osc.connect(g); g.connect(curBus||master);
  osc.start(t0); osc.stop(t0+(o.t||0.15)+0.05);
}
/* ノイズ：フィルタを通して「シュッ」「ドン」の質感を作る */
function noise(o){
  if(!ensure()||!noiseBuf) return;
  const t0=actx.currentTime+(o.delay||0);
  const src=actx.createBufferSource(); src.buffer=noiseBuf; src.loop=true;
  src.playbackRate.value=(o.rate||1)*(1+(Math.random()*0.1-0.05)); /* ノイズも毎回少し質感を変える */
  const flt=actx.createBiquadFilter();
  flt.type=o.ftype||'bandpass';
  flt.frequency.setValueAtTime(o.f||1000,t0);
  if(o.f2) flt.frequency.exponentialRampToValueAtTime(Math.max(30,o.f2),t0+(o.t||0.2));
  flt.Q.value=o.q||0.9;
  const g=actx.createGain();
  const v=(o.v||0.25)*(o.volMul||1);
  g.gain.setValueAtTime(0.0001,t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002,v),t0+0.008);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+(o.t||0.2));
  src.connect(flt); flt.connect(g); g.connect(curBus||master);
  src.start(t0); src.stop(t0+(o.t||0.2)+0.05);
}
/* 金属の響き：金属は倍音が整数倍にならない（1, 2.76, 5.40…）のが特徴。
   その比率でサイン波を重ねると「キィン」が本物らしくなる */
function metal(f,v,t,volMul,delay){
  const parts=[[1,1,1],[2.76,0.55,0.7],[5.40,0.28,0.45],[8.93,0.13,0.28]];
  parts.forEach(pt=>{
    tone({f:f*pt[0],t:t*pt[2],type:'sine',v:v*pt[1],volMul,delay:delay||0});
  });
}
/* 鐘・コインの響き：基本音＋少し外れた倍音で「チーン」と伸びる音 */
function bell(f,v,t,volMul,delay){
  tone({f,t,type:'sine',v,volMul,delay:delay||0});
  tone({f:f*2.02,t:t*0.55,type:'sine',v:v*0.38,volMul,delay:delay||0});
  tone({f:f*2.94,t:t*0.32,type:'sine',v:v*0.16,volMul,delay:delay||0});
}

/* ============================================================
   音のカタログ：名前 -> 鳴らし方
   volMul は呼び出し側の音量倍率（遠くのBOTは小さく鳴らす用）
   ============================================================ */
const SOUNDS={
  /* ---- UI ---- */
  click(m){ /* カチッ：短いノイズの粒＋小さな三角波。矩形波のピコ音は卒業 */
    noise({f:2600,t:0.03,v:0.07,q:1.2,volMul:m});
    tone({f:700,f2:540,t:0.05,type:'triangle',v:0.07,volMul:m}); },
  select(m){ bell(660,0.13,0.09,m); bell(990,0.12,0.13,m,0.06); },
  start(m){ [523,659,784].forEach((f,i)=>{ tone({f,t:0.12,type:'triangle',v:0.15,delay:i*0.07,volMul:m}); tone({f:f*2,t:0.08,type:'sine',v:0.05,delay:i*0.07,volMul:m}); }); },
  /* ---- 近接 ---- */
  swing(m){ /* 剣の風切り：速い帯域スイープ＋下半身のある太い風＋刃の残響 */
    noise({f:2300,f2:380,t:0.13,v:0.20,q:1.6,volMul:m});
    noise({f:800,f2:240,t:0.11,v:0.09,ftype:'lowpass',volMul:m});
    tone({f:2650,f2:1900,t:0.06,type:'sine',v:0.03,delay:0.02,volMul:m});
    metal(3400,0.016,0.10,m,0.03); },
  punch(m){ /* パンチ：空気を裂く音＋当たる「バシッ」の2段構え */
    noise({f:1100,f2:300,t:0.07,v:0.15,ftype:'lowpass',volMul:m});
    noise({f:1900,t:0.045,v:0.13,delay:0.015,volMul:m});
    tone({f:175,f2:65,t:0.10,type:'sine',v:0.23,volMul:m});
    tone({f:340,f2:150,t:0.05,type:'sine',v:0.08,delay:0.01,volMul:m}); },
  kick(m){ /* キック：大きく速い風切り＋道着のはためき */
    noise({f:1600,f2:260,t:0.15,v:0.24,q:1.3,volMul:m});
    noise({f:700,f2:1800,t:0.10,v:0.07,q:1,volMul:m}); },
  kickHit(m){ tone({f:135,f2:50,t:0.16,type:'sine',v:0.33,volMul:m}); noise({f:750,f2:180,t:0.11,v:0.21,ftype:'lowpass',volMul:m}); noise({f:2400,t:0.05,v:0.10,volMul:m}); tone({f:270,f2:110,t:0.07,type:'sine',v:0.10,delay:0.01,volMul:m}); },
  dash(m){ noise({f:480,f2:2800,t:0.24,v:0.19,q:1.7,volMul:m}); noise({f:900,f2:3400,t:0.18,v:0.07,q:2,delay:0.03,volMul:m}); },
  /* ---- 遠距離 ---- */
  shoot(m){ /* クロスボウ：弦の「バチン」＋木部のコツン＋矢の風切り */
    noise({f:1400,t:0.04,v:0.16,volMul:m});
    tone({f:210,f2:95,t:0.07,type:'sine',v:0.13,volMul:m});
    tone({f:980,f2:300,t:0.10,type:'triangle',v:0.09,delay:0.01,volMul:m});
    noise({f:2800,f2:1200,t:0.09,v:0.07,q:2,delay:0.02,volMul:m}); },
  powerbolt(m){ /* 貫通ボルト：電気っぽい上昇ザップ＋太い風切り＋低いうなり */
    tone({f:480,f2:1650,t:0.20,type:'sawtooth',v:0.10,volMul:m});
    tone({f:190,f2:760,t:0.18,type:'sine',v:0.10,delay:0.01,volMul:m});
    noise({f:900,f2:3000,t:0.18,v:0.14,q:1.5,volMul:m}); },
  bomb(m){ /* 爆弾を投げる：放物線のヒューッという笛音 */
    tone({f:880,f2:360,t:0.30,type:'sine',v:0.06,volMul:m});
    noise({f:600,f2:1500,t:0.12,v:0.08,q:1.2,volMul:m}); },
  fire(m){ /* 炎玉：燃え上がるゴオッ＋パチパチという火の粉 */
    noise({f:750,f2:1900,t:0.17,v:0.16,q:0.8,volMul:m});
    tone({f:330,f2:660,t:0.14,type:'triangle',v:0.06,volMul:m});
    noise({f:3200,t:0.03,v:0.07,delay:0.05,volMul:m}); noise({f:2600,t:0.03,v:0.05,delay:0.11,volMul:m}); noise({f:3600,t:0.025,v:0.05,delay:0.16,volMul:m}); },
  spiral(m){ [392,523,659,784].forEach((f,i)=>{ tone({f,t:0.15,type:'triangle',v:0.11,delay:i*0.05,volMul:m}); tone({f:f*2,t:0.09,type:'sine',v:0.04,delay:i*0.05,volMul:m}); }); noise({f:1000,f2:2400,t:0.30,v:0.10,q:2,volMul:m}); noise({f:1800,f2:3600,t:0.22,v:0.05,q:2.5,delay:0.06,volMul:m}); },
  cannon(m){ /* 大砲：地響きする轟音＋砲身の金属の余韻＋砲口の衝撃 */
    tone({f:105,f2:34,t:0.34,type:'sine',v:0.44,volMul:m});
    noise({f:480,f2:90,t:0.28,v:0.32,ftype:'lowpass',volMul:m});
    noise({f:2100,t:0.06,v:0.15,volMul:m});
    tone({f:64,f2:40,t:0.4,type:'triangle',v:0.18,delay:0.02,volMul:m});
    metal(620,0.05,0.22,m,0.01); },
  scatter(m){ /* 散弾：轟音＋破片が散る「バラバラッ」という粒の音 */
    tone({f:125,f2:42,t:0.26,type:'sine',v:0.36,volMul:m});
    noise({f:700,f2:140,t:0.20,v:0.28,ftype:'lowpass',volMul:m});
    metal(840,0.035,0.16,m,0.01);
    [0.02,0.05,0.08,0.12].forEach((d,i)=>noise({f:1700+i*260,t:0.05,v:0.08,delay:d,volMul:m})); },
  /* ---- 爆発 ---- */
  explode(m){ /* 爆発：破裂のクラック→腹に響く低音→長く残る轟き＋瓦礫の粒 */
    noise({f:3400,t:0.06,v:0.20,ftype:'highpass',volMul:m});
    tone({f:95,f2:28,t:0.55,type:'sine',v:0.48,volMul:m});
    noise({f:900,f2:70,t:0.55,v:0.40,ftype:'lowpass',volMul:m});
    noise({f:300,f2:60,t:0.85,v:0.16,ftype:'lowpass',delay:0.08,volMul:m});
    [0.14,0.23,0.34].forEach((d,i)=>noise({f:1200+i*500,t:0.04,v:0.045,delay:d,volMul:m})); },
  explodeSmall(m){ noise({f:2800,t:0.05,v:0.13,ftype:'highpass',volMul:m}); tone({f:118,f2:38,t:0.34,type:'sine',v:0.35,volMul:m}); noise({f:800,f2:100,t:0.32,v:0.29,ftype:'lowpass',volMul:m}); noise({f:260,f2:70,t:0.5,v:0.10,ftype:'lowpass',delay:0.05,volMul:m}); },
  /* ---- ヒット・被弾・死亡 ---- */
  hit(m){ /* 木を叩いたようなコツン＋肉に当たる低音 */
    tone({f:290,f2:135,t:0.06,type:'sine',v:0.16,volMul:m});
    tone({f:880,t:0.035,type:'sine',v:0.05,volMul:m});
    noise({f:1500,t:0.05,v:0.11,volMul:m}); },
  hurt(m){ tone({f:210,f2:85,t:0.15,type:'triangle',v:0.16,volMul:m}); tone({f:420,f2:170,t:0.10,type:'triangle',v:0.05,delay:0.01,volMul:m}); noise({f:600,f2:200,t:0.10,v:0.11,ftype:'lowpass',volMul:m}); },
  die(m){ [440,330,220,150].forEach((f,i)=>tone({f,f2:f*0.85,t:0.13,type:'triangle',v:0.15,delay:i*0.09,volMul:m})); noise({f:1200,f2:150,t:0.4,v:0.08,delay:0.05,volMul:m}); },
  /* ---- 特殊判定 ---- */
  reflect(m){ /* 跳ね返し：金属の「キィン！」を金属倍音で */
    metal(1560,0.13,0.30,m);
    noise({f:3600,t:0.03,v:0.06,volMul:m}); },
  guard(m){ /* 炎玉ガード：鈍い金属の「ガンッ」＋消える炎のジュッ */
    metal(430,0.11,0.16,m);
    tone({f:180,f2:90,t:0.09,type:'sine',v:0.10,volMul:m});
    noise({f:2100,t:0.07,v:0.11,volMul:m});
    noise({f:900,f2:300,t:0.12,v:0.07,delay:0.03,volMul:m}); },
  sink(m){ /* 死神が地面に潜る：沈み込む低い唸り＋土が崩れるようなノイズ */
    tone({f:640,f2:110,t:0.24,type:'sine',v:0.17,volMul:m});
    tone({f:320,f2:70,t:0.22,type:'triangle',v:0.10,delay:0.02,volMul:m});
    noise({f:800,f2:180,t:0.22,v:0.11,ftype:'lowpass',volMul:m}); },
  emerge(m){ /* 死神が地面から現れる：せり上がる風＋水色のキラキラ */
    tone({f:130,f2:720,t:0.26,type:'sine',v:0.14,volMul:m});
    noise({f:300,f2:2100,t:0.22,v:0.08,q:1.6,volMul:m});
    bell(1318,0.10,0.10,m,0.10); bell(1760,0.09,0.14,m,0.16); },
  ghost(m){ /* 幽霊・キャプテンの幽霊化：ふわりと透ける、幽かな上昇音 */
    tone({f:520,f2:990,t:0.32,type:'sine',v:0.07,volMul:m});
    tone({f:780,f2:1320,t:0.28,type:'sine',v:0.04,delay:0.06,volMul:m});
    noise({f:2300,f2:3800,t:0.28,v:0.03,q:2,volMul:m}); },
  /* ---- 取得・回復・準備完了 ---- */
  cube(m){ /* キューブ取得：鐘のようなキラキラ3音 */
    bell(880,0.15,0.12,m); bell(1318,0.14,0.15,m,0.06); bell(1760,0.11,0.20,m,0.12);
    noise({f:4200,f2:6000,t:0.18,v:0.035,q:2,delay:0.05,volMul:m}); },
  heal(m){ [523,659,784].forEach((f,i)=>{ tone({f,t:0.15,type:'sine',v:0.06,delay:i*0.08,volMul:m}); tone({f:f*2,t:0.10,type:'sine',v:0.02,delay:i*0.08,volMul:m}); }); noise({f:3000,f2:4600,t:0.3,v:0.02,q:1.5,delay:0.05,volMul:m}); },
  ready(m){ /* 溜め完了：柔らかい上昇音＋「ピキーン！」の合図（鋸波は外して耳に優しく） */
    tone({f:620,f2:1240,t:0.13,type:'triangle',v:0.05,volMul:m});
    bell(1560,0.13,0.16,m,0.10);
    bell(2090,0.10,0.24,m,0.17);
    noise({f:3600,f2:5600,t:0.25,v:0.04,q:2,delay:0.12,volMul:m}); },
  reload(m){ /* リロード完了：カチャッ・カチャッ・シャキンの3段（金属の粒で） */
    noise({f:2100,t:0.03,v:0.10,q:1.4,volMul:m});
    tone({f:330,f2:210,t:0.04,type:'sine',v:0.08,volMul:m});
    noise({f:2600,t:0.03,v:0.10,q:1.4,delay:0.07,volMul:m});
    tone({f:390,f2:250,t:0.04,type:'sine',v:0.08,delay:0.07,volMul:m});
    noise({f:3200,t:0.05,v:0.09,ftype:'highpass',delay:0.14,volMul:m});
    metal(1500,0.03,0.08,m,0.14); },
  coin(m){ bell(988,0.11,0.10,m); bell(1319,0.11,0.20,m,0.07); },
  /* ---- カウントダウン・結果 ---- */
  beep(m){ bell(660,0.16,0.13,m); },
  go(m){ [523,659,784,1046].forEach((f,i)=>{ tone({f,t:0.16,type:'triangle',v:0.18,delay:i*0.06,volMul:m}); tone({f:f*2,t:0.10,type:'sine',v:0.05,delay:i*0.06,volMul:m}); }); noise({f:1200,f2:3400,t:0.3,v:0.08,q:1.5,volMul:m}); bell(1318,0.10,0.30,m,0.24); },
  victory(m){ [523,659,784,1046,784,1046,1318].forEach((f,i)=>{ tone({f,t:0.17,type:'triangle',v:0.18,delay:i*0.11,volMul:m}); tone({f:f*2,t:0.10,type:'sine',v:0.05,delay:i*0.11,volMul:m}); }); noise({f:3800,f2:6200,t:0.7,v:0.04,q:1.6,delay:0.3,volMul:m}); bell(1568,0.09,0.34,m,0.78); bell(1975,0.09,0.4,m,0.91); },
  defeat(m){ [392,370,349,311].forEach((f,i)=>tone({f,t:0.22,type:'triangle',v:0.15,delay:i*0.16,volMul:m})); },
  /* ---- ガチャ ---- */
  gacha(m){ [660,880,1100,880,1100,1320].forEach((f,i)=>{ tone({f,t:0.10,type:'triangle',v:0.11,delay:i*0.08,volMul:m}); tone({f:f*2,t:0.06,type:'sine',v:0.035,delay:i*0.08,volMul:m}); }); },
  gachaRare(m){ [784,988,1175,1568].forEach((f,i)=>bell(f,0.13,0.22,m,i*0.10)); noise({f:3000,f2:5000,t:0.4,v:0.05,q:2,volMul:m}); }
};

function play(name,opts){
  const fn=SOUNDS[name];
  if(!fn||!canPlay(name)) return;
  if(!ensure()) return;
  /* この音専用の出力バス：音量→ステレオパン→マスター。
     あわせてリバーブへも少し送って「空間」を付ける */
  const bus=actx.createGain();
  let head=bus;
  try{
    if(actx.createStereoPanner){
      const pn=actx.createStereoPanner();
      pn.pan.value=opts&&opts.pan?Math.max(-0.85,Math.min(0.85,opts.pan)):0;
      bus.connect(pn); head=pn;
    }
  }catch(e){}
  head.connect(master);
  const send=actx.createGain();
  send.gain.value=WET[name]!=null?WET[name]:0.15;
  bus.connect(send); send.connect(verbIn);
  curBus=bus;
  try{ fn(opts&&opts.vol!=null?opts.vol:1); }catch(e){}
  curBus=null;
}

/* ============================================================
   溜め専用ループ音：長押し中ずっと鳴り続ける「力を溜める音」。
   以前は鋸波が 150→750Hz まで駆け上がる甲高い音で、うるさいと
   言われたので作り替えた：
   ・波形は柔らかい三角波＋オクターブ上のサイン波だけ（鋸波なし）
   ・音程の上昇は控えめ（約128→303Hz）
   ・音量は以前の約1/4。代わりに「呼吸するような脈動」（遅い
     うねりが溜まるほど速くなる）で溜まり具合を伝える
   ・エネルギーが渦巻く気配として、帯域ノイズをほんの少しだけ
   game.js が毎フレーム SFX.charge(p) を呼び、離したら
   SFX.chargeStop() を呼ぶ。呼び忘れ対策として、charge() が
   一定時間呼ばれなくなったら自動で止まる（倒れた・試合終了時）。
   ============================================================ */
let chargeNodes=null, chargeLast=0;
function charge(p){
  if(!enabled){ chargeStop(); return; }
  if(!ensure()) return;
  chargeLast=performance.now();
  p=Math.max(0,Math.min(1,p));
  if(!chargeNodes){
    const o1=actx.createOscillator(), o2=actx.createOscillator();
    const g2=actx.createGain();
    const flt=actx.createBiquadFilter(), g=actx.createGain();
    const lfo=actx.createOscillator(), lfoG=actx.createGain();
    const nsrc=actx.createBufferSource(); nsrc.buffer=noiseBuf; nsrc.loop=true;
    const nf=actx.createBiquadFilter(), ng=actx.createGain();
    o1.type='triangle'; o2.type='sine';
    g2.gain.value=0.26;
    flt.type='lowpass'; flt.frequency.value=560; flt.Q.value=0.4; /* 角を取って柔らかく */
    g.gain.value=0.0001;
    o1.connect(flt); o2.connect(g2); g2.connect(flt); flt.connect(g); g.connect(master);
    /* 脈動：LFOで音量をゆっくりうねらせる（溜まるほど速く・深く） */
    lfo.type='sine'; lfo.frequency.value=2.2;
    lfo.connect(lfoG); lfoG.gain.value=0; lfoG.connect(g.gain);
    /* 渦巻くエネルギーの気配：帯域ノイズをごく小さく */
    nf.type='bandpass'; nf.frequency.value=760; nf.Q.value=0.7;
    ng.gain.value=0.0001;
    nsrc.connect(nf); nf.connect(ng); ng.connect(master);
    o1.start(); o2.start(); lfo.start(); nsrc.start();
    chargeNodes={o1,o2,flt,g,g2,lfo,lfoG,nsrc,ng,nf};
  }
  const t=actx.currentTime, n=chargeNodes;
  const base=128+Math.pow(p,1.15)*175; /* 128Hz → 303Hz：控えめな上昇 */
  n.o1.frequency.setTargetAtTime(base,t,0.06);
  n.o2.frequency.setTargetAtTime(base*2.01,t,0.06);
  n.flt.frequency.setTargetAtTime(520+p*880,t,0.08);
  n.g2.gain.setTargetAtTime(p>=1?0.42:0.26,t,0.1); /* 満タンで倍音が少し増えて「満ちた」感じに */
  const gBase=0.014+p*0.020; /* 最大でも約0.034（以前のピーク約0.13の1/4） */
  n.g.gain.setTargetAtTime(gBase,t,0.07);
  n.lfo.frequency.setTargetAtTime(2.2+p*4.6,t,0.1); /* 脈動 2.2Hz → 6.8Hz */
  n.lfoG.gain.setTargetAtTime(gBase*0.45,t,0.1);
  n.ng.gain.setTargetAtTime(0.003+p*0.007,t,0.1);
  n.nf.frequency.setTargetAtTime(700+p*1500,t,0.1);
}
function chargeStop(){
  if(!chargeNodes) return;
  const n=chargeNodes; chargeNodes=null;
  try{
    n.g.gain.setTargetAtTime(0.0001,actx.currentTime,0.03);
    n.ng.gain.setTargetAtTime(0.0001,actx.currentTime,0.03);
    setTimeout(()=>{ try{ n.o1.stop(); n.o2.stop(); n.lfo.stop(); n.nsrc.stop(); }catch(e){} },180);
  }catch(e){}
}
setInterval(()=>{ if(chargeNodes&&performance.now()-chargeLast>170) chargeStop(); },90);

/* ============================================================
   設定UI：ON/OFF・音量・試し聞き・バトル中の上バーのボタン
   ============================================================ */
function syncSfxUI(){
  const on=document.getElementById('sfxOnBtn'), off=document.getElementById('sfxOffBtn');
  if(on) on.classList.toggle('active',enabled);
  if(off) off.classList.toggle('active',!enabled);
  const top=document.getElementById('sfxTopBtn');
  if(top) top.textContent=enabled?'🔊 音ON':'🔇 音OFF';
  const val=document.getElementById('sfxVolVal');
  if(val) val.textContent=Math.round(volume*100)+'%';
  const range=document.getElementById('sfxVolRange');
  if(range&&+range.value!==Math.round(volume*100)) range.value=Math.round(volume*100);
}
function setEnabled(v){
  enabled=!!v;
  if(!enabled) chargeStop(); /* OFFにしたら溜めループも即止める */
  syncSfxUI();
  if(enabled) play('click'); /* ONにしたのが分かるよう小さく鳴らす */
}
const onBtn=document.getElementById('sfxOnBtn');
if(onBtn) onBtn.addEventListener('click',()=>setEnabled(true));
const offBtn=document.getElementById('sfxOffBtn');
if(offBtn) offBtn.addEventListener('click',()=>setEnabled(false));
const topBtn=document.getElementById('sfxTopBtn');
if(topBtn) topBtn.addEventListener('click',()=>setEnabled(!enabled));
const volRange=document.getElementById('sfxVolRange');
if(volRange) volRange.addEventListener('input',()=>{
  volume=Math.max(0,Math.min(1,+volRange.value/100));
  if(master) master.gain.value=0.5*volume;
  syncSfxUI();
});
const testBtn=document.getElementById('sfxTestBtn');
if(testBtn) testBtn.addEventListener('click',()=>{
  if(!enabled){ setEnabled(true); }
  /* 代表的な音を順番に少しずつ鳴らして聞き比べられるようにする。
     最後は「溜め」の上昇音→溜め完了の合図も聞けるようにした */
  play('swing'); setTimeout(()=>play('shoot'),180); setTimeout(()=>play('cannon'),380); setTimeout(()=>play('explode'),620); setTimeout(()=>play('cube'),1050);
  const t0=performance.now();
  const demo=setInterval(()=>{
    const p=(performance.now()-t0)/750;
    if(p>=1){ clearInterval(demo); chargeStop(); play('ready'); return; }
    charge(p);
  },40);
});
syncSfxUI();

/* ============================================================
   UIのクリック音：ボタン全般に小さなクリック音を付ける。
   攻撃ボタン・効果音ボタン自身・スライダーは除外（攻撃音と二重に
   鳴ったり、OFFにした瞬間に鳴ったりしないように）。
   キャラ選択とプレイ開始は少し特別な音にする。
   ============================================================ */
document.addEventListener('click',e=>{
  const b=e.target&&e.target.closest?e.target.closest('button'):null;
  if(!b) return;
  if(b.id==='atkBtn'||b.id==='sfxTopBtn'||b.id==='sfxOnBtn'||b.id==='sfxOffBtn'||b.id==='sfxTestBtn') return;
  if(b.id==='startBtn'||b.id==='toBattleBtn'||b.id==='againBtn'){ play('start'); return; }
  if(b.classList.contains('char')||b.classList.contains('mode-btn')){ play('select'); return; }
  play('click');
});

window.SFX={
  play,
  charge,
  chargeStop,
  get enabled(){ return enabled; },
  setEnabled,
  setVolume(v){ volume=Math.max(0,Math.min(1,v)); if(master) master.gain.value=0.5*volume; syncSfxUI(); }
};
})();
