/* ============================================================
   ロビーと部屋の切り替え：assets/js/lobby.js
   画面（部屋）を増やしたいときは、index.htmlに .room を足して
   ボタンに data-go="部屋id" を付けるだけ
   キャラの立ち絵は data.js のデザイン（skin/outfit/hat）から
   丸っこいキャラをSVGで描く（バトル中の見た目とおそろい）
   ============================================================ */
let selected=0;
/* フレイレ・ヴェラーのモード（案1 spiral／案2 shot）。キャラ部屋で選ぶ。
   BOTのヴェラーはバトルごとにランダム（game.js の makeEntity） */
let veraMode='spiral';

function showRoom(id){
  document.querySelectorAll('.room').forEach(r=>r.classList.toggle('is-active', r.id==='room-'+id));
  document.querySelectorAll('[data-go]').forEach(b=>b.classList.toggle('active', b.dataset.go===id));
  /* 部屋を開いたら必ず一番上から表示する。
     スクロールするのは #startScreen 本体と .room-body の両方の可能性があるので両方戻し、
     レイアウト確定後（次のフレーム）にももう一度戻して、表示切り替え直後の
     ブラウザのスクロール復元に上書きされないようにする */
  const lobby=document.getElementById('startScreen');
  const roomEl=document.getElementById('room-'+id);
  const bodyEl=roomEl?roomEl.querySelector('.room-body'):null;
  const toTop=()=>{ if(lobby) lobby.scrollTop=0; if(bodyEl) bodyEl.scrollTop=0; };
  toTop();
  requestAnimationFrame(()=>{ toTop(); requestAnimationFrame(toTop); });
}
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>showRoom(b.dataset.go)));
/* ロビー中央のキャラ（立ち絵・名前）を押してもキャラ部屋へ行けるようにする。
   クリックは上の [data-go] で処理されるので、ここではキーボード操作（Enter／Space）だけ足す */
const heroGoEl=document.getElementById('heroFigure');
if(heroGoEl) heroGoEl.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); showRoom('chars'); } });

/* 丸っこいキャラの立ち絵（SVG）。バトルの drawEntity と同じデザイン。
   ほっぺの赤みはやめて、眉・傷・服の仕立てで海賊らしく描き込む */
function charArt(c){
  const R=c.id==='don'?37:33, fy=c.id==='don'?44:48;
  /* 服の仕立て */
  let outfit='';
  if(c.id==='jack'){ /* 青ベスト＋白シャツ＋金ボタン */
    outfit=`<path d="M46 62 L74 62 L67 110 L53 110 Z" fill="#e9e2d0"/>
    <path d="M46 62 L53 110 M74 62 L67 110" stroke="${c.outfitDark}" stroke-width="3" fill="none"/>
    <circle cx="60" cy="76" r="2.4" fill="#c98f00"/><circle cx="60" cy="90" r="2.4" fill="#c98f00"/><circle cx="60" cy="104" r="2.4" fill="#c98f00"/>`;
  } else if(c.id==='ruby'){ /* 矢筒の斜めベルト＋襟巻き */
    outfit=`<path d="M36 62 L86 112" stroke="#5d3a12" stroke-width="8" stroke-linecap="round"/>
    <path d="M36 62 L86 112" stroke="#ffc93c" stroke-width="2" stroke-linecap="round"/>
    <path d="M38 66 A26 26 0 0 0 82 66" stroke="${c.outfitDark}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  } else if(c.id==='vera'){ /* ヴェラ：炎の斜めサッシュ＋金の留め具 */
    outfit=`<path d="M36 66 L86 108" stroke="#7a1503" stroke-width="9" stroke-linecap="round"/>
    <path d="M36 66 L86 108" stroke="#ffc93c" stroke-width="2" stroke-linecap="round"/>
    <circle cx="60" cy="86" r="4.5" fill="#ffc93c" stroke="#8a5a24" stroke-width="1.6"/>
    <path d="M40 60 A27 27 0 0 0 80 60" stroke="${c.outfitDark}" stroke-width="6" fill="none" stroke-linecap="round"/>`;
  } else if(c.id==='gustav'){ /* グスタフ：紺コートの前立て＋真鍮ボタン＋砲弾ベルト */
    outfit=`<rect x="53" y="56" width="14" height="58" fill="#ffffff30"/>
    <circle cx="60" cy="72" r="2.8" fill="#c98f00"/><circle cx="60" cy="88" r="2.8" fill="#c98f00"/><circle cx="60" cy="104" r="2.8" fill="#c98f00"/>
    <path d="M38 96 L82 76" stroke="#26221f" stroke-width="8" stroke-linecap="round"/>
    <circle cx="50" cy="90" r="3.4" fill="#39404d"/><circle cx="62" cy="84" r="3.4" fill="#39404d"/><circle cx="74" cy="79" r="3.4" fill="#39404d"/>`;
  } else if(c.id==='bruno'){ /* ブルーノ：道着の白い前合わせ（V字）＋黒帯 */
    outfit=`<path d="M44 62 L76 62 L60 92 Z" fill="#e9e2d0"/>
    <path d="M44 62 L60 92 L76 62" stroke="${c.outfitDark}" stroke-width="3" fill="none"/>
    <rect x="34" y="98" width="52" height="9" rx="3" fill="#1d1f26"/>
    <circle cx="60" cy="102" r="3" fill="#ffc93c"/>`;
  } else if(c.id==='bonnie'){ /* ボニー：白シャツ＋散弾ベルト（赤いシェル） */
    outfit=`<path d="M46 62 L74 62 L67 110 L53 110 Z" fill="#e9e2d0"/>
    <path d="M36 70 L86 104" stroke="#1d1a17" stroke-width="9" stroke-linecap="round"/>
    <circle cx="48" cy="78" r="3.6" fill="#c0271f"/><circle cx="60" cy="85" r="3.6" fill="#c0271f"/><circle cx="72" cy="92" r="3.6" fill="#c0271f"/>
    <circle cx="60" cy="70" r="2.4" fill="#c98f00"/>`;
  } else if(c.id==='bart'){ /* バート：開けた白シャツ＋オレンジの腰巻き＋瓶の紐 */
    outfit=`<path d="M44 62 L76 62 L60 90 Z" fill="#e9e2d0"/>
    <path d="M44 62 L60 90 L76 62" stroke="${c.outfitDark}" stroke-width="3" fill="none"/>
    <path d="M36 66 L84 106" stroke="#5d3a12" stroke-width="3.4" stroke-linecap="round"/>
    <rect x="34" y="98" width="52" height="9" rx="3" fill="#d35400"/>`;
  } else if(c.id==='captain'){ /* 幽霊・キャプテン：紺コートのラペル（金の縁）＋白いクラバット＋金ボタン */
    outfit=`<path d="M46 62 L74 62 L67 110 L53 110 Z" fill="#e9e2d0"/>
    <path d="M44 60 L56 80 L52 112 M76 60 L64 80 L68 112" stroke="#c98f00" stroke-width="2.6" fill="none"/>
    <circle cx="60" cy="88" r="2.6" fill="#c98f00"/><circle cx="60" cy="102" r="2.6" fill="#c98f00"/>`;
  } else if(c.id==='reaper'){ /* 死神：闇色ローブの襟＋胸元の魂の玉 */
    outfit=`<path d="M40 60 A27 27 0 0 0 80 60" stroke="${c.outfitDark}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <circle cx="60" cy="88" r="5.5" fill="#8ef6ff" stroke="#1d4e5e" stroke-width="1.8"/>
    <circle cx="58" cy="86" r="1.8" fill="#ffffff" opacity=".8"/>`;
  } else { /* ドン：コートの前立て＋ボタン */
    outfit=`<rect x="53" y="56" width="14" height="58" fill="#ffffff45"/>
    <circle cx="60" cy="72" r="2.8" fill="#3a2c14"/><circle cx="60" cy="88" r="2.8" fill="#3a2c14"/><circle cx="60" cy="104" r="2.8" fill="#3a2c14"/>`;
  }
  /* 頭の飾りと顔まわり（キャラごとに描き分け） */
  let gear='', face='';
  if(c.id==='jack'){ /* 赤バンダナ＋ドクロ印＋結び目、頬の傷 */
    gear=`<path d="M33 ${fy} a27 27 0 0 1 54 0 Z" fill="${c.hatColor}"/>
    <path d="M33 ${fy-2} L87 ${fy-2}" stroke="#00000030" stroke-width="2.5"/>
    <circle cx="60" cy="${fy-13}" r="4.2" fill="#fff"/><rect x="57.6" y="${fy-9.5}" width="4.8" height="2.6" fill="#fff"/>
    <circle cx="89" cy="${fy-5}" r="6" fill="${c.hatColor}"/><path d="M92 ${fy-2} l11 9 l-5 7 l-9-7 Z" fill="${c.hatColor}"/><path d="M88 ${fy} l4 12 l-6 3 l-3-10 Z" fill="#00000018"/>
    <path d="M42 ${fy+7} l6 8" stroke="#a03c28" stroke-width="2" stroke-linecap="round" opacity=".8"/>`;
    face=`<path d="M55 ${fy+13} L65 ${fy+13}" stroke="#7a4a2a" stroke-width="2.4" stroke-linecap="round"/>`;
  } else if(c.id==='ruby'){ /* 横分けの髪＋羽付き帽子 */
    gear=`<path d="M33 ${fy} a27 27 0 0 1 54 0 Z" fill="${c.hair}"/>
    <path d="M46 ${fy-24} q4 12 1 22 M60 ${fy-27} q5 13 2 25 M74 ${fy-23} q4 11 1 20" stroke="#00000030" stroke-width="1.8" fill="none"/>
    <ellipse cx="83" cy="${fy-38}" rx="5.5" ry="13" transform="rotate(24 83 ${fy-38})" fill="#27ae60"/>
    <path d="M83 ${fy-50} L83 ${fy-27}" stroke="#0a5030" stroke-width="1.6"/>
    <ellipse cx="60" cy="${fy-23}" rx="25" ry="9.5" transform="rotate(-8 60 ${fy-23})" fill="${c.hatColor}"/>
    <ellipse cx="60" cy="${fy-20}" rx="25" ry="6" transform="rotate(-8 60 ${fy-20})" fill="#00000018"/>
    <circle cx="44" cy="${fy-25}" r="2.6" fill="#ffc93c"/>`;
    face=`<path d="M56 ${fy+13} L64 ${fy+13}" stroke="#7a4a2a" stroke-width="2.4" stroke-linecap="round"/>`;
  } else if(c.id==='vera'){ /* ヴェラ：炎色ポニーテール＋黒バンドと炎の前髪 */
    gear=`<path d="M33 ${fy} a27 27 0 0 1 54 0 Z" fill="${c.hair}"/>
    <path d="M84 ${fy-14} q16 4 13 22 q-2 10-10 14 q3-16-3-30 Z" fill="${c.hair}"/>
    <path d="M84 ${fy-14} q16 4 13 22" stroke="#00000030" stroke-width="1.8" fill="none"/>
    <path d="M34 ${fy-3} L86 ${fy-3}" stroke="#26221f" stroke-width="6"/>
    <path d="M52 ${fy-30} q4-10 8-2 q5-12 9-3 q6-8 7 1 q1 8-6 10 l-14 0 q-7-2-4-12 Z" fill="#ff7b1c"/>
    <path d="M56 ${fy-26} q3-6 5-1 q4-7 6-2 q4-5 5 1 q0 5-5 6 l-8 0 q-4-1-3-8 Z" fill="#ffc93c"/>
    <circle cx="60" cy="${fy-3}" r="3.2" fill="#ffc93c" stroke="#8a5a24" stroke-width="1.2"/>`;
    face=`<path d="M56 ${fy+13} L64 ${fy+13}" stroke="#7a4a2a" stroke-width="2.4" stroke-linecap="round"/>`;
  } else if(c.id==='gustav'){ /* グスタフ：黒い三角帽子（金の縁取り）＋横髪。顔には眼帯（face側ではなく頭まわりで紐を描く） */
    gear=`<path d="M33 ${fy} a27 27 0 0 1 54 0 Z" fill="${c.hair}"/>
    <path d="M30 ${fy-4} q30 -14 60 0 q-6 8 -16 7 l-28 0 q-10 1 -16 -7 Z" fill="${c.hatColor}"/>
    <path d="M42 ${fy-6} a18 15 0 0 1 36 0 Z" fill="${c.hatColor}"/>
    <path d="M30 ${fy-4} q30 -14 60 0" stroke="#c98f00" stroke-width="2.6" fill="none"/>
    <circle cx="60" cy="${fy-14}" r="3.4" fill="#fff"/><rect x="58" y="${fy-11.5}" width="4" height="2.4" fill="#fff"/>
    <path d="M36 ${fy+2} L84 ${fy+10}" stroke="#1d1f26" stroke-width="3.4"/>`;
    face=`<circle cx="71" cy="${fy+2}" r="5.6" fill="#1d1f26"/><path d="M56 ${fy+13} L64 ${fy+13}" stroke="#7a4a2a" stroke-width="2.4" stroke-linecap="round"/>`;
  } else if(c.id==='bruno'){ /* ブルーノ：黒髪＋黄色いハチマキ（結び目と垂れ布、中央に赤い丸印） */
    gear=`<path d="M33 ${fy} a27 27 0 0 1 54 0 Z" fill="${c.hair}"/>
    <path d="M34 ${fy-6} L86 ${fy-6}" stroke="${c.hatColor}" stroke-width="9"/>
    <path d="M34 ${fy-1.5} L86 ${fy-1.5}" stroke="#00000030" stroke-width="1.8"/>
    <circle cx="60" cy="${fy-6}" r="3" fill="#c0271f"/>
    <circle cx="88" cy="${fy-6}" r="5" fill="${c.hatColor}"/><path d="M91 ${fy-3} l10 10 l-4 6 l-9-8 Z" fill="${c.hatColor}"/><path d="M86 ${fy-1} l3 12 l-6 3 l-3-11 Z" fill="#00000018"/>`;
    face=`<path d="M55 ${fy+13} L65 ${fy+13}" stroke="#7a4a2a" stroke-width="2.6" stroke-linecap="round"/>`;
  } else if(c.id==='bonnie'){ /* ボニー：横分けの髪＋紫の羽付き帽子（ピンクの羽） */
    gear=`<path d="M33 ${fy} a27 27 0 0 1 54 0 Z" fill="${c.hair}"/>
    <path d="M46 ${fy-24} q4 12 1 22 M60 ${fy-27} q5 13 2 25 M74 ${fy-23} q4 11 1 20" stroke="#00000030" stroke-width="1.8" fill="none"/>
    <ellipse cx="83" cy="${fy-38}" rx="5.5" ry="13" transform="rotate(24 83 ${fy-38})" fill="#e84393"/>
    <path d="M83 ${fy-50} L83 ${fy-27}" stroke="#7a1040" stroke-width="1.6"/>
    <ellipse cx="60" cy="${fy-23}" rx="25" ry="9.5" transform="rotate(-8 60 ${fy-23})" fill="${c.hatColor}"/>
    <ellipse cx="60" cy="${fy-20}" rx="25" ry="6" transform="rotate(-8 60 ${fy-20})" fill="#00000018"/>
    <circle cx="44" cy="${fy-25}" r="2.6" fill="#ffc93c"/>`;
    face=`<path d="M56 ${fy+13} L64 ${fy+13}" stroke="#7a4a2a" stroke-width="2.4" stroke-linecap="round"/>`;
  } else if(c.id==='bart'){ /* バート：ティール色バンダナ＋金の耳輪。口元は火吹きらしく少し開ける */
    gear=`<path d="M33 ${fy} a27 27 0 0 1 54 0 Z" fill="${c.hatColor}"/>
    <path d="M33 ${fy-2} L87 ${fy-2}" stroke="#00000030" stroke-width="2.5"/>
    <circle cx="89" cy="${fy-5}" r="6" fill="${c.hatColor}"/><path d="M92 ${fy-2} l11 9 l-5 7 l-9-7 Z" fill="${c.hatColor}"/>
    <circle cx="34" cy="${fy+8}" r="3.4" fill="none" stroke="#ffc93c" stroke-width="2"/>`;
    face=`<ellipse cx="60" cy="${fy+14}" rx="4.6" ry="3.2" fill="#7a2c14"/>`;
  } else if(c.id==='captain'){ /* 幽霊・キャプテン：紺の船長帽（二角帽）＋金の縁＋ドクロ印＋白い横髪。顔は白い口ひげ */
    gear=`<path d="M31 ${fy+2} q-5 8-2 16 M89 ${fy+2} q5 8 2 16" stroke="${c.hair}" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    <path d="M27 ${fy-5} q33 -17 66 0 q-5 11 -20 10 l-26 0 q-15 1 -20 -10 Z" fill="${c.hatColor}"/>
    <path d="M42 ${fy-7} a18 15 0 0 1 36 0 Z" fill="${c.hatColor}"/>
    <path d="M27 ${fy-5} q33 -17 66 0" stroke="#ffc93c" stroke-width="2.6" fill="none"/>
    <circle cx="60" cy="${fy-13}" r="3.4" fill="#fff"/><rect x="58.2" y="${fy-10.4}" width="3.6" height="2.4" fill="#fff"/>`;
    face=`<path d="M47 ${fy+11} q6.5 4.5 13 0 q6.5 4.5 13 0" stroke="#dfe9ec" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
  } else if(c.id==='reaper'){ /* 死神：深い闇色のフード。目は水色に光る（face側で上書き） */
    gear=`<path d="M29 ${fy+6} a31 31 0 0 1 62 0 Z" fill="${c.hatColor}"/>
    <path d="M38 ${fy+2} a22 22 0 0 1 44 0 Z" fill="#00000059"/>
    <path d="M31 ${fy+2} l-2 14 l9-2 l1-10 Z M89 ${fy+2} l2 14 l-9-2 l-1-10 Z" fill="${c.hatColor}"/>
    <path d="M38 ${fy-24} a27 27 0 0 1 16-8" stroke="#8ef6ff" stroke-width="2" fill="none" opacity=".55"/>`;
    face=`<circle cx="49" cy="${fy+2}" r="3.8" fill="#8ef6ff"/><circle cx="71" cy="${fy+2}" r="3.8" fill="#8ef6ff"/><circle cx="60" cy="${fy+13}" r="2.6" fill="none" stroke="#5b4a7a" stroke-width="2"/>`;
  } else { /* ドン：大きな黒ヒゲ（毛流れ付き）＋口ヒゲ＋太眉 */
    gear=`<circle cx="60" cy="${fy+14}" r="24" fill="${c.hair}"/>
    <circle cx="60" cy="${fy-3}" r="20.5" fill="${c.skin}" stroke="rgba(0,0,0,.25)" stroke-width="2.5"/>
    <path d="M39.5 ${fy-3} a20.5 20.5 0 0 1 41 0 Z" fill="${c.hair}"/>
    <path d="M44 ${fy+34} q3 8 1 13 M60 ${fy+37} q1 8 0 14 M76 ${fy+34} q-3 8 -1 13" stroke="#ffffff22" stroke-width="2" fill="none"/>
    <path d="M47 ${fy+9} q13 7 26 0" stroke="${c.hair}" stroke-width="6" fill="none" stroke-linecap="round"/>`;
    face=``;
  }
  /* 眉（決意の角度）＋目（ハイライト入り）。ドンは太眉 */
  const browW=c.id==='don'?4.5:3, browY=c.id==='don'?fy-9:fy-6, eyeY=c.id==='don'?fy-1:fy+2;
  const faceBase=`
    <path d="M40 ${browY} L54 ${browY+4} M80 ${browY} L66 ${browY+4}" stroke="#2a1c10" stroke-width="${browW}" stroke-linecap="round" fill="none"/>
    <circle cx="49" cy="${eyeY}" r="3.4" fill="#1d1f26"/><circle cx="71" cy="${eyeY}" r="3.4" fill="#1d1f26"/>
    <circle cx="48" cy="${eyeY-1}" r="1.1" fill="#fff"/><circle cx="70" cy="${eyeY-1}" r="1.1" fill="#fff"/>`;
  let weapon='';
  if(c.id==='jack'||c.id==='captain'){ /* カットラス（キャプテンは片手の海賊サーベル） */
    weapon=`<path d="M90 76 q27-5 32-27" stroke="#dfe7ef" stroke-width="7" stroke-linecap="round" fill="none"/><path d="M92 73 q22-5 27-22" stroke="#93a5b8" stroke-width="2" fill="none"/><path d="M84 82 l12-7" stroke="#5d3a12" stroke-width="6" stroke-linecap="round"/><path d="M88 70 a8 8 0 0 1 10 6" stroke="#ffc93c" stroke-width="4" fill="none"/>`;
  } else if(c.id==='ruby'){ /* クロスボウ */
    weapon=`<g transform="translate(93 74) rotate(18)"><rect x="-4" y="-4" width="30" height="8" rx="3" fill="#6e4517"/><path d="M21 -17 A19 19 0 0 1 21 17" stroke="#3d4450" stroke-width="4.5" fill="none"/><path d="M21 -17 L8 0 L21 17" stroke="#f5f0dc" stroke-width="1.6" fill="none"/><path d="M-2 0 L24 0" stroke="#e8eef5" stroke-width="3"/><path d="M24 0 L18 -3.4 L18 3.4 Z" fill="#c0271f"/></g>`;
  } else if(c.id==='vera'){ /* ヴェラ：武器の代わりに周りを回る炎玉3個（ロビーでは静止画で3方向に配置） */
    weapon=`<circle cx="14" cy="52" r="13" fill="#ff7b1c" opacity=".35"/><circle cx="14" cy="52" r="9" fill="#ff7b1c"/><circle cx="14" cy="52" r="4.5" fill="#ffc93c"/>
    <circle cx="106" cy="52" r="13" fill="#ff7b1c" opacity=".35"/><circle cx="106" cy="52" r="9" fill="#ff7b1c"/><circle cx="106" cy="52" r="4.5" fill="#ffc93c"/>
    <circle cx="60" cy="112" r="13" fill="#ff7b1c" opacity=".35"/><circle cx="60" cy="112" r="9" fill="#ff7b1c"/><circle cx="60" cy="112" r="4.5" fill="#ffc93c"/>`;
  } else if(c.id==='gustav'){ /* グスタフ：武器の代わりに右腕そのものの大砲（太い砲身＋砲口＋真鍮の帯） */
    weapon=`<g transform="translate(88 78) rotate(-14)"><rect x="-6" y="-11" width="42" height="22" rx="9" fill="#39404d"/><rect x="-6" y="-11" width="42" height="8" rx="4" fill="#57606e"/><rect x="6" y="-12" width="6" height="24" fill="#c98f00"/><rect x="24" y="-12" width="6" height="24" fill="#c98f00"/><circle cx="38" cy="0" r="11" fill="#23262c"/><circle cx="38" cy="0" r="6.5" fill="#060708"/><circle cx="-8" cy="0" r="10" fill="#2b3038"/></g>`;
  } else if(c.id==='bruno'){ /* ブルーノ：武器の代わりに両手の赤いグローブ（右拳・左拳） */
    weapon=`<circle cx="16" cy="76" r="12" fill="#c0271f"/><circle cx="12" cy="72" r="4" fill="#ffffff40"/><path d="M8 76 L24 76 M8 82 L24 82" stroke="#00000030" stroke-width="1.8"/><rect x="22" y="70" width="7" height="12" rx="2" fill="#f5f0dc"/>
    <circle cx="104" cy="76" r="12" fill="#c0271f"/><circle cx="100" cy="72" r="4" fill="#ffffff40"/><path d="M96 76 L112 76 M96 82 L112 82" stroke="#00000030" stroke-width="1.8"/><rect x="91" y="70" width="7" height="12" rx="2" fill="#f5f0dc"/>`;
  } else if(c.id==='bonnie'){ /* ブランダーバス：短い銃身＋ラッパ状に広がった銃口 */
    weapon=`<g transform="translate(90 76) rotate(8)"><path d="M-16 2 L2 -3 L2 9 L-16 10 Z" fill="#5d3a12"/><rect x="0" y="-5" width="26" height="13" rx="4" fill="#39404d"/><rect x="10" y="-6" width="5" height="15" fill="#c98f00"/><ellipse cx="30" cy="1" rx="6" ry="11" fill="#23262c" stroke="#c98f00" stroke-width="2.4"/><ellipse cx="30" cy="1" rx="3" ry="6" fill="#060708"/></g>`;
  } else if(c.id==='bart'){ /* バート：片手のラム酒瓶（緑の瓶＋コルク＋ラベル）＋口元の小さな炎 */
    weapon=`<g transform="translate(13 66)"><rect x="-7" y="-2" width="14" height="24" rx="4" fill="#1e7a4f"/><rect x="-3" y="-12" width="6" height="11" fill="#27ae60"/><rect x="-3.5" y="-17" width="7" height="5" fill="#c9a35f"/><rect x="-5" y="6" width="10" height="8" fill="#f5e9c9"/></g>
    <circle cx="94" cy="58" r="10" fill="#ff7b1c" opacity=".35"/><path d="M84 62 q10-12 20-4 q-8 10-20 4 Z" fill="#ff7b1c"/><path d="M88 61 q6-7 12-3 q-5 6-12 3 Z" fill="#ffc93c"/>`;
  } else if(c.id==='reaper'){ /* 死神の大鎌：長い柄＋大きく弧を描く刃 */
    weapon=`<g transform="translate(94 74) rotate(-16)"><path d="M-18 20 L14 -14" stroke="#3a2c14" stroke-width="5.5" stroke-linecap="round"/><path d="M12 -12 q24 -6 26 -28 q-20 0 -30 16 q-3 6 4 12 Z" fill="#dfe7ef"/><path d="M14 -13 q18 -5 21 -20" stroke="#93a5b8" stroke-width="2" fill="none"/><circle cx="13" cy="-13" r="3.4" fill="#8ef6ff"/></g>`;
  } else { /* 爆弾 */
    weapon=`<circle cx="95" cy="72" r="15" fill="#1d1f26"/><rect x="90" y="54" width="10" height="6" fill="#39404d"/><circle cx="90" cy="67" r="4.5" fill="#ffffff40"/><path d="M95 54 q2-8 9-9" stroke="#8a5a24" stroke-width="3" fill="none"/><circle cx="105" cy="44" r="4" fill="#ffcf3f"/><circle cx="105" cy="44" r="2" fill="#ff7b1c"/>`;
  }
  return `<svg viewBox="-2 -8 124 134" class="char-art" aria-hidden="true">
    ${weapon}
    <circle cx="27" cy="82" r="9.5" fill="${c.skin}" stroke="rgba(0,0,0,.25)" stroke-width="2.5"/>
    <circle cx="60" cy="86" r="${R}" fill="${c.outfit}" stroke="rgba(0,0,0,.30)" stroke-width="3"/>
    <ellipse cx="47" cy="70" rx="14" ry="9" transform="rotate(-20 47 70)" fill="#ffffff2e"/>
    <path d="M ${60-R*0.55} ${86+R*0.72} A ${R} ${R} 0 0 0 ${60+R*0.55} ${86+R*0.72}" stroke="#00000020" stroke-width="7" fill="none"/>
    ${outfit}
    <path d="M ${60-R*0.82} ${86+R*0.52} A ${R} ${R} 0 0 0 ${60+R*0.82} ${86+R*0.52}" stroke="#5d3a12" stroke-width="4.5" fill="none"/>
    <rect x="55" y="${86+R*0.80}" width="10" height="8" rx="2" fill="#ffc93c" stroke="#8a5a24" stroke-width="1.6"/>
    <circle cx="60" cy="${fy}" r="27" fill="${c.skin}" stroke="rgba(0,0,0,.25)" stroke-width="3"/>
    ${gear}
    ${faceBase}
    ${face}
    <circle cx="93" cy="80" r="9.5" fill="${c.id==='gustav'?'#2b3038':c.skin}" stroke="rgba(0,0,0,.25)" stroke-width="2.5"/>
  </svg>`;
}

function statRow(label,val,max,color){
  const pct=Math.max(4,Math.min(100,Math.round(val/max*100)));
  return `<div class="statbar"><span>${label}</span><span class="track"><i style="width:${pct}%;background:${color}"></i></span><span>${val}</span></div>`;
}
function reloadText(c){
  if(c.id==='vera'){ const m=veraModeInfo(veraMode); return m.id==='spiral' ? '弾1発だけ ／ 1発 0.7秒で装填（螺旋型）' : '弾3発 ／ 1発 1.0秒で装填（ショット型・連射を抑えて遅め）'; }
  if(c.id==='bart') return 'なし（代わりに「息」：連続3秒まで吐けて、タップの一吹きでも0.35秒分使う。離すと回復）';
  return c.ammo>0?`弾${c.ammo}発 ／ 1発 ${c.reload}秒で装填`:'なし（近接）';
}
function chargeLineHtml(c){
  if(c.id==='vera') return `<div class="charge-line">🔥 モード：<b>${veraModeInfo(veraMode).name}</b>（下の詳細で切り替えできるよ）<br>炎玉${c.fireCount}個はゲージ満タン（${c.chargeTime}秒長押し）で出現／溜め中も足は遅くならない</div>`;
  if(c.id==='bonnie') return `<div class="charge-line">💥 溜め攻撃：<b>${c.chargeName}</b>（${c.chargeTime}秒長押し／高速ダッシュ・ダメージなし・弾は消費しない）<br>溜めている間も足は遅くならない</div>`;
  if(c.id==='bart') return `<div class="charge-line">🔥 攻撃：<b>ファイアブレス</b>（押している間ずっと噴き続ける／毎秒約${c.dmg}ダメージ）<br>連続で吐けるのは${c.breathMax}秒まで。溜め攻撃はないよ</div>`;
  if(c.id==='reaper') return `<div class="charge-line">💥 溜め攻撃：<b>${c.chargeName}</b>（${c.chargeTime}秒長押し／地面に潜って向いている方向へ瞬間移動・ダメージなし・弾は消費しない）<br>溜めている間も足は遅くならない</div>`;
  if(c.id==='captain') return `<div class="charge-line">👻 長押し：<b>${c.chargeName}</b>（${c.chargeTime}秒長押しで発動／最大${c.ghostMax}秒。透明になって攻撃が当たらず、障害物もすり抜けられる）<br>長押し中は少しだけ足が遅くなる（他のキャラほどではない）</div>`;
  return `<div class="charge-line">💥 溜め攻撃：<b>${c.chargeName}</b>（${c.chargeTime}秒長押し／${c.chargeDmg}ダメージ）</div>`;
}
function chargeDetailText(c){
  if(c.id==='bonnie') return `💥 溜め攻撃「${c.chargeName}」：${c.chargeDesc}<br>🔫 散弾は全${c.pellets}発（1発${c.pelletDmg}）。ゼロ距離で全部当たれば${c.dmg}ダメージが最高火力。離れるほど散らばって当たる数が減り、1発の威力も射程端で約38%まで落ちるよ（遠距離の威力は今まで通り）<br>`;
  if(c.id==='reaper') return `💥 溜め攻撃「${c.chargeName}」：${c.chargeDesc}<br>👻 幽霊の体で、普段から障害物（木・岩・マスト・タル・氷ブロック）をすり抜けて移動できるよ（宝箱はすり抜けない）。テレポートの行き先はオートエイムではなく「今向いている方向」で決まるよ<br>`;
  if(c.id==='captain') return `👻 長押し「${c.chargeName}」：${c.chargeDesc}<br>👻 幽霊化を使い切ると、ゲージが1.2秒分まで戻るまで幽霊化できないよ（回復は毎秒0.8秒分）。幽霊化していない普段は障害物を通れないよ<br>`;
  if(c.id==='bart') return `🔥 ファイアブレス：攻撃ボタンを押している間、口から火を噴き続けるよ（射程${c.range}の扇形／毎秒約${c.dmg}ダメージ）。連続で吐けるのは${c.breathMax}秒まで。息が切れると、息が1.2秒分まで戻るまで吐けなくなるよ。離している間は毎秒0.9秒分ずつ回復するよ。タップの一吹きでも息を${c.breathPuff}秒分使うので、連打しても息が続かず無限には打てないよ。吐いている間は少しゆっくり（0.7倍）歩けるよ。溜め攻撃はないよ<br>`;
  if(c.id==='vera'){
    const m=veraModeInfo(veraMode);
    return `🔥 選んでいるモード：<b>${m.name}</b> ― ${m.desc}<br>🔥 共通：炎玉${c.fireCount}個は長押しゲージが満タン（${c.chargeTime}秒）になってから出現するよ（長押しした瞬間には出ない）。出現中は触れた敵に${c.fireDmg}ダメージ（同じ敵は${c.fireTick}秒に1回まで）＋炎玉に当たった敵の弾・爆弾は消える（ガード）。ヴェラーはどちらのモードも、溜めている間は足が遅くならず通常の速さのままだよ<br>🤖 BOTのヴェラーはモードがランダムだよ。ヴェラー同士でも違う能力で戦うことがあるよ<br>`;
  }
  return `💥 溜め攻撃「${c.chargeName}」：${c.chargeDesc}<br>`;
}
/* ヴェラー専用：モード選択ボタン（案1／案2）。選ぶと即反映される */
function veraModeHtml(c){
  if(c.id!=='vera') return '';
  return `<div class="mode-select"><div class="mode-select-title">🔥 ヴェラーのモードを選んでね（バトルのBOTヴェラーはランダムだよ）</div><div class="mode-btns">${VERA_MODES.map(m=>`<button type="button" class="mode-btn ${m.id===veraMode?'active':''}" data-vera-mode="${m.id}"><b>${m.name}</b><small>${m.desc}</small></button>`).join('')}</div></div>`;
}
/* 自動回復は全キャラ共通ルール：3秒戦闘なしで、最大HPの6%/秒（秒数は data.js の REGEN_DELAY） */
function regenText(c){
  return `${REGEN_DELAY}秒戦闘なしで回復開始 ／ 毎秒 +${Math.round(c.hp*REGEN_RATE)}（最大HPの${Math.round(REGEN_RATE*100)}%）`;
}
/* キャラ部屋の「並び替え」と「表示の仕方」（この画面を開いている間だけの状態。
   ページを閉じたら今の並び・カード表示に戻る）
   並び替え：default=今の並び（data.js の CHARS の順）／name=名前順／
             added=追加された順（CHARS は追加された順に並んでいる）／
             hp・dmg・speed=その性能が高い順
   表示：card=今まで通りの詳細カード／compact=顔と名前だけの小さなタイル／
         list=1列の横並び行（性能は数字で一列に） */
let charSort='default';
let charView='card';
function sortedCharIndices(){
  const idx=CHARS.map((c,i)=>i);
  if(charSort==='name') idx.sort((a,b)=>CHARS[a].name.localeCompare(CHARS[b].name,'ja'));
  else if(charSort==='hp') idx.sort((a,b)=>CHARS[b].hp-CHARS[a].hp);
  else if(charSort==='dmg') idx.sort((a,b)=>CHARS[b].dmg-CHARS[a].dmg);
  else if(charSort==='speed') idx.sort((a,b)=>CHARS[b].speed-CHARS[a].speed);
  /* default と added はどちらも CHARS の並び（＝追加された順）そのまま */
  return idx;
}
/* キャラを選んだら、画面下の詳細（＋出航ボタン）が見える位置までスクロールする */
function scrollToCharDetail(){
  const el=document.getElementById('charDetail');
  if(!el) return;
  const reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({behavior:reduce?'auto':'smooth', block:'start'});
}
function renderChars(){
  const list=document.getElementById('charList');
  list.className='chars view-'+charView;
  list.innerHTML=sortedCharIndices().map(i=>{
    const c=CHARS[i], sel=i===selected?'selected':'';
    if(charView==='compact') return `
    <button class="char compact-card ${sel}" data-i="${i}">
      <div class="face">${charArt(c)}</div>
      <h3>${c.name}</h3>
      <span class="role">${c.role} ／ ランク${c.rank}</span>
    </button>`;
    if(charView==='list') return `
    <button class="char list-row ${sel}" data-i="${i}">
      <div class="face">${charArt(c)}</div>
      <div class="list-main"><h3>${c.name}</h3><span class="role">${c.role} ／ ランク${c.rank}</span></div>
      <div class="list-stats">❤️ ${c.hp}　⚔️ ${c.dmg}　👟 ${c.speed}　🎯 ${c.range}</div>
    </button>`;
    return `
    <button class="char ${sel}" data-i="${i}">
      <div class="face">${charArt(c)}</div>
      <h3>${c.name}</h3>
      <p>${c.desc}</p>
      <span class="role">${c.role} ／ ランク${c.rank}</span>
      ${statRow('❤️ HP',c.hp,1400,'#2ed573')}
      ${statRow('⚔️ 攻撃',c.dmg,300,'#ff4757')}
      ${statRow('👟 速さ',c.speed,200,'#25a6e8')}
      ${statRow('🎯 射程',c.range,360,'#ffc93c')}
      <div class="speed-line">👟 足の速さ：<b>${c.speedNote||''}</b></div>
      ${chargeLineHtml(c)}
      <div class="reload-line">🔁 リロード：<b>${reloadText(c)}</b></div>
      <div class="reload-line">💚 自動回復：<b>${regenText(c)}</b></div>
    </button>`;
  }).join('');
  list.querySelectorAll('.char').forEach(b=>b.onclick=()=>{selected=+b.dataset.i;renderChars();renderHero();scrollToCharDetail();});
  renderDetail();
  syncCharToolbar();
}
/* 並び替えセレクトと表示切り替えボタンを、今の状態に合わせて見せる */
function syncCharToolbar(){
  const sel=document.getElementById('charSort');
  if(sel) sel.value=charSort;
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active', b.dataset.view===charView));
}
const charSortSel=document.getElementById('charSort');
if(charSortSel) charSortSel.addEventListener('change',()=>{ charSort=charSortSel.value; renderChars(); });
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{ charView=b.dataset.view; renderChars(); }));
function renderDetail(){
  const c=CHARS[selected], el=document.getElementById('charDetail');
  if(!el) return;
  el.innerHTML=`<div class="big">${charArt(c)}</div><div><h3>${c.name} ― ${c.role}</h3><p>${c.desc}<br>${chargeDetailText(c)}🔁 リロード：${reloadText(c)}<br>💚 自動回復：${regenText(c)}<br>👟 足の速さ：${c.speed}（${c.speedNote||''}）<br>🏆 トロフィー ${c.trophy} ／ パワー ${c.power}<br>💬 「${c.quote}」</p>${veraModeHtml(c)}</div>`;
  el.querySelectorAll('[data-vera-mode]').forEach(b=>b.onclick=()=>{ veraMode=b.dataset.veraMode; renderChars(); renderHero(); });
}
function renderHero(){
  const c=CHARS[selected];
  const body=document.getElementById('heroBody');
  body.innerHTML=charArt(c);
  body.style.background='radial-gradient(circle at 50% 30%, #ffffff40, #00000010 72%)';
  document.getElementById('heroWeapon').textContent='';
  document.getElementById('heroName').textContent=c.name;
  document.getElementById('heroQuote').innerHTML= c.id==='vera'
    ? `💬 「${c.quote}」 ― モード <b>${veraModeInfo(veraMode).name}</b>（炎玉${c.fireCount}個はゲージ満タンで出現）`
    : `💬 「${c.quote}」 ― 溜め攻撃 <b>${c.chargeName}</b>`;
  document.getElementById('heroTrophy').innerHTML=`<small>トロフィー</small>🏆 ${c.trophy}`;
  document.getElementById('heroPower').innerHTML=`<small>パワー</small>⚡ ${c.power} ／ ランク${c.rank}`;
}
function renderCrew(){
  const el=document.getElementById('crewList');
  if(el) el.innerHTML=BOT_NAMES.map((n,i)=>`<div class="crew-member"><span class="face">${BOT_FACES[i]}</span>${n}<small>バトルではライバルBOTとして登場。<br>倒すとパワーキューブを落とすよ。</small></div>`).join('');
  const ev=document.getElementById('eventInfo');
  if(ev) ev.innerHTML=`<div class="gem">${GAME_EVENT.icon}</div><div><b>${GAME_EVENT.name}</b><small>${GAME_EVENT.map} ― ${GAME_EVENT.note}</small></div><div class="timer">毒ゾーンは<br>12秒後から縮小</div>`;
}
renderChars();
renderHero();
renderCrew();
