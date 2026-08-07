// UI 接線層：大廳、猜拳、狀態列、勝負 overlay、指標事件。狀態文案與流程沿用原版。
import * as game from './game.js';
import { createRenderer3D } from './render3d.js';

const $ = id => document.getElementById(id);
const lobbyArea = $('lobbyArea');
const gameArea = $('gameArea');
const statusText = $('statusText');
const turnDot = $('turnDot');
const count1El = $('count1');
const count2El = $('count2');
const netStatusEl = $('netStatus');
const winnerOverlay = $('winnerOverlay');
const stampCard = $('stampCard');
const stampTitle = $('stampTitle');
const rpsOverlay = $('rpsOverlay');
const rpsHint = $('rpsHint');
const rpsChoicesEl = $('rpsChoicesEl');
const rpsRevealEl = $('rpsRevealEl');
const RPS_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };

const canvas = $('board3d');
const panel = canvas.parentElement;
let r3d = null;
try {
  r3d = createRenderer3D(canvas, panel);
} catch (e) {
  console.error(e);
  panel.innerHTML = '<p style="padding:40px;text-align:center">這個瀏覽器無法建立 WebGL 3D 畫面。可以改玩 2D 原版：<a href="https://haifengli0527.github.io/pencil-duel-space/" style="color:var(--ink-blue)">紙上彈筆對戰</a></p>';
}

let dragging = null;
let animating = false;
let flashTimer = null;

// ---------- 大廳 ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = true; });
    $('panel-' + btn.dataset.tab).hidden = false;
  });
});
$('startLocalBtn').addEventListener('click', () => game.startLocal());
$('createRoomBtn').addEventListener('click', () => game.createRoom());
$('joinRoomBtn').addEventListener('click', doJoin);
$('joinCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
function doJoin() { game.joinRoom($('joinCodeInput').value.trim().toUpperCase()); }
$('leaveBtn').addEventListener('click', () => game.leaveToLobby());
$('restartBtn').addEventListener('click', () => game.restart());
$('restartBtn2').addEventListener('click', () => game.restart());
document.querySelectorAll('.rps-btn').forEach(btn => {
  btn.addEventListener('click', () => game.chooseRps(btn.dataset.choice));
});

function setCreateStatus(html) { $('createStatus').innerHTML = html; }
function setJoinStatus(html) { $('joinStatus').innerHTML = html; }

game.on('createStatus', st => {
  if (st.kind === 'connecting') setCreateStatus('建立中…（連上中繼伺服器）');
  else if (st.kind === 'waiting') {
    setCreateStatus(
      '房間代碼：<span class="room-code">' + st.code + '</span>' +
      '<button class="btn copy-btn" id="copyCodeBtn" type="button">複製</button>' +
      '<div class="waiting-line">等待朋友加入<span class="dots"></span></div>'
    );
    const copyBtn = $('copyCodeBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        if (navigator.clipboard) { navigator.clipboard.writeText(st.code).catch(() => { }); }
      });
    }
  }
  else if (st.kind === 'lost') setCreateStatus('<span class="error-text">連上中繼後連線中斷，請重新整理頁面再試</span>');
  else if (st.kind === 'failed') setCreateStatus('<span class="error-text">連不上中繼伺服器（免費公開 MQTT broker），請確認網路連線，或稍後再試</span>');
});
game.on('joinStatus', st => {
  if (st.kind === 'empty') setJoinStatus('<span class="error-text">請輸入房間代碼</span>');
  else if (st.kind === 'connecting') setJoinStatus('連線中…（正在連上中繼伺服器）');
  else if (st.kind === 'waitingHost') setJoinStatus('連線中…（已連上中繼，等待房主回應）');
  else if (st.kind === 'noHost') setJoinStatus('<span class="error-text">等不到房主回應。請確認代碼是否正確、房主是否還在「建立房間」的等待頁面</span>');
  else if (st.kind === 'lost') setJoinStatus('<span class="error-text">連上中繼後連線中斷，請重新整理頁面再試</span>');
  else if (st.kind === 'failed') setJoinStatus('<span class="error-text">連不上中繼伺服器（免費公開 MQTT broker），請確認網路連線，或稍後再試</span>');
});
game.on('netStatus', txt => { netStatusEl.textContent = txt; });

game.on('enterGame', () => {
  lobbyArea.hidden = true;
  gameArea.hidden = false;
  netStatusEl.textContent = '';
});
game.on('leftGame', () => {
  gameArea.hidden = true;
  lobbyArea.hidden = false;
  $('joinCodeInput').value = '';
  setCreateStatus('');
  setJoinStatus('');
  netStatusEl.textContent = '';
  if (r3d) r3d.reset();
});
game.on('reset', () => {
  dragging = null;
  animating = false;
  clearTimeout(flashTimer);
  if (r3d) r3d.reset();
});

// ---------- 狀態同步 ----------
function selectable(p) {
  const s = game.getState();
  if (!s) return false;
  return (s.phase === 'playing' && p.owner === s.turn && game.canActOn(p.owner))
    || (s.phase === 'king1' && p.owner === 1 && game.canActOn(1))
    || (s.phase === 'king2' && p.owner === 2 && game.canActOn(2));
}

function syncAll() {
  const s = game.getState();
  if (!s || !r3d) return;
  r3d.sync(s, selectable);
  updateStatusUI(s);
}
game.on('sync', syncAll);

game.on('shot', payload => {
  if (!r3d) return;
  animating = true;
  r3d.preview(null);
  r3d.animateShot(payload, game.getState(), () => {
    animating = false;
    syncAll();
    if (payload.selfDeath) {
      const wall = payload.hitWall != null ? payload.hitWall : Math.abs(payload.endX - game.C.CENTER_X) > game.C.HAZARD_HALF_WIDTH;
      flash(wall ? '力道過猛，衝進邊界的黑洞消失了！' : '墜入中央的小行星帶，船報銷了！');
    } else if (payload.baseWin) {
      flash('攻進對方基地，奇襲成功！');
    }
  });
});

function flash(msg) {
  statusText.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { const s = game.getState(); if (s) updateStatusUI(s); }, 1400);
}

function updateStatusUI(s) {
  const c1 = s.pieces.filter(p => p.owner === 1 && p.alive).length;
  const c2 = s.pieces.filter(p => p.owner === 2 && p.alive).length;
  count1El.textContent = c1;
  count2El.textContent = c2;

  let myTag = '';
  if (game.isNetworked() && game.getMyColor()) { myTag = game.getMyColor() === 1 ? '（你是藍方）' : '（你是紅方）'; }

  if (s.phase === 'rps') {
    statusText.textContent = '猜拳決定誰先手…';
    turnDot.style.background = 'var(--graphite-soft)';
  } else if (s.phase === 'setup1') {
    const n = s.pieces.filter(p => p.owner === 1).length;
    statusText.textContent = `藍方請在左半邊點擊放置太空船（${n}/10）${myTag}`;
    turnDot.style.background = 'var(--ink-blue)';
  } else if (s.phase === 'king1') {
    statusText.textContent = `藍方請點選一艘船封為旗艦（雙重生命）${myTag}`;
    turnDot.style.background = 'var(--ink-blue)';
  } else if (s.phase === 'setup2') {
    const n = s.pieces.filter(p => p.owner === 2).length;
    statusText.textContent = `紅方請在右半邊點擊放置太空船（${n}/10）${myTag}`;
    turnDot.style.background = 'var(--ink-red)';
  } else if (s.phase === 'king2') {
    statusText.textContent = `紅方請點選一艘船封為旗艦（雙重生命）${myTag}`;
    turnDot.style.background = 'var(--ink-red)';
  } else if (s.phase === 'playing') {
    statusText.textContent = (s.turn === 1 ? '藍方回合' : '紅方回合') + ' — 拖曳你的船瞄準，放開發射！' + myTag;
    turnDot.style.background = s.turn === 1 ? 'var(--ink-blue)' : 'var(--ink-red)';
  } else if (s.phase === 'over') {
    statusText.textContent = (s.winner === 1 ? '藍方' : '紅方') + ' 獲勝！';
    turnDot.style.background = s.winner === 1 ? 'var(--ink-blue)' : 'var(--ink-red)';
  }

  if (s.phase === 'over') {
    winnerOverlay.classList.add('active');
    stampCard.className = 'stamp-card ' + (s.winner === 1 ? 'p1' : 'p2');
    stampTitle.textContent = (s.winner === 1 ? '藍方' : '紅方') + ' 獲勝！';
  } else {
    winnerOverlay.classList.remove('active');
  }

  if (s.phase === 'rps') {
    rpsOverlay.classList.add('active');
    renderRpsCard(s);
  } else {
    rpsOverlay.classList.remove('active');
  }
}

function renderRpsCard(s) {
  const networked = game.isNetworked();
  if (s.rpsReveal) {
    rpsChoicesEl.style.display = 'none';
    rpsRevealEl.style.display = 'flex';
    const { c1, c2, winnerColor } = s.rpsReveal;
    rpsRevealEl.innerHTML =
      '<span>' + RPS_EMOJI[c1] + '</span><span class="rps-vs">VS</span><span>' + RPS_EMOJI[c2] + '</span>';
    rpsHint.textContent = !networked
      ? ((winnerColor === 1 ? '玩家一' : '玩家二') + ' 猜拳獲勝，是藍方、優先出手！')
      : (game.getMyColor() === 1 ? '你猜拳獲勝！你是藍方，優先出手' : '對方猜拳獲勝，你是紅方');
    return;
  }
  rpsRevealEl.style.display = 'none';
  rpsChoicesEl.style.display = 'flex';
  if (!networked) {
    rpsHint.textContent = (s.turn === 1 ? '玩家一' : '玩家二') + ' 請出拳（選完換人，別讓對方看到剛剛選了什麼）';
    rpsChoicesEl.querySelectorAll('.rps-btn').forEach(b => { b.disabled = false; });
  } else {
    const picked = !!s.rpsChoices[game.getMyRole()];
    rpsHint.textContent = picked ? '已出拳，等待對方…' : '請出拳:剪刀、石頭、布,勝者優先出手';
    rpsChoicesEl.querySelectorAll('.rps-btn').forEach(b => { b.disabled = picked; });
  }
}

// ---------- 指標操作 ----------
function onPointerDown(e) {
  const s = game.getState();
  if (!s || !r3d || s.phase === 'over' || s.phase === 'rps' || animating) return;
  const pt = r3d.toBoard(e);
  if (!pt) return;
  const piece = game.pieceAt(pt);
  if (piece && (s.phase === 'playing' || s.phase === 'king1' || s.phase === 'king2')) {
    if (s.phase === 'king1' && piece.owner === 1) {
      const res = game.selectKing(piece);
      if (!res.ok) flash(res.msg);
      e.preventDefault();
      return;
    }
    if (s.phase === 'king2' && piece.owner === 2) {
      const res = game.selectKing(piece);
      if (!res.ok) flash(res.msg);
      e.preventDefault();
      return;
    }
    if (s.phase === 'playing' && piece.owner === s.turn && game.canActOn(piece.owner)) {
      dragging = { piece };
      r3d.setCursor('grabbing');
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd, { once: true });
      e.preventDefault();
    }
    return;
  }
  if (!piece && (s.phase === 'setup1' || s.phase === 'setup2')) {
    const owner = s.phase === 'setup1' ? 1 : 2;
    if (game.canActOn(owner)) {
      const res = game.placeAt(pt);
      if (!res.ok) flash(res.msg);
    } else {
      flash('還沒輪到你放置');
    }
  }
}

function onDragMove(e) {
  if (!dragging || !r3d) return;
  const pt = r3d.toBoard(e);
  if (!pt) return;
  const aim = game.computeAim(dragging.piece, pt);
  if (aim) r3d.preview(dragging.piece, { ...aim, pointerX: pt.x, pointerY: pt.y });
  else r3d.preview(null);
}

function onDragEnd(e) {
  window.removeEventListener('pointermove', onDragMove);
  if (!r3d) return;
  r3d.preview(null);
  r3d.setCursor('');
  if (!dragging) return;
  const piece = dragging.piece;
  dragging = null;
  const pt = r3d.toBoard(e);
  if (pt) game.releaseShot(piece, pt);
}

function onHoverMove(e) {
  if (dragging || animating || !r3d) return;
  const s = game.getState();
  if (!s) return;
  if (!(s.phase === 'playing' || s.phase === 'king1' || s.phase === 'king2')) { r3d.setCursor(''); return; }
  const pt = r3d.toBoard(e);
  if (!pt) { r3d.setCursor(''); return; }
  const piece = game.pieceAt(pt);
  r3d.setCursor(piece && selectable(piece) ? 'grab' : '');
}

if (r3d) {
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onHoverMove);
}

// 測試輔助（不影響遊戲）：棋盤座標 ↔ 螢幕座標、讀取狀態
window.__pdDebug = {
  state: () => game.getState(),
  toScreen: (x, y) => r3d ? r3d.toScreen(x, y) : null,
  isAnimating: () => animating,
};
