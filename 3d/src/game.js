// 遊戲規則與連線層 —— 常數、狀態機、彈射數學、MQTT 訊息格式全部與原版 pencil.html 一致，
// 因此本 3D 版可以和原版 2D 網頁在同一個房間代碼裡連線對戰。
// 原作：https://github.com/haifengli0527/pencil-duel-space（MIT License）

export const C = {
  BOARD_W: 920, BOARD_H: 560, CENTER_X: 460,
  DOT_R: 10,
  MIN_GAP: 30,
  EDGE_MARGIN: 24,
  CENTER_MARGIN: 64,
  MAX_DRAG: 130,
  MIN_SHOT: 60,
  MAX_SHOT: 680,
  MIN_ANGLE_ERR: 2,   // 力道最小時的角度誤差（度）
  MAX_ANGLE_ERR: 14,  // 力道最大時的角度誤差（度）
  HAZARD_HALF_WIDTH: 55, // 中央小行星帶（淘汰區）的半寬
  BASE_R: 14,            // 基地的實際捕獲半徑（只看最終停留點）
  BASE_ICON_R: 14,
  BASE_INSET: 34,        // 基地離該方最外側邊界的距離
};
C.HIT_R = C.DOT_R + 5;
C.BLUE_BASE = { x: C.EDGE_MARGIN + C.BASE_INSET, y: C.BOARD_H / 2 };
C.RED_BASE = { x: C.BOARD_W - C.EDGE_MARGIN - C.BASE_INSET, y: C.BOARD_H / 2 };

const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- 事件（給 UI / 3D 渲染層訂閱） ----------
const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
function emit(ev, ...args) { (listeners[ev] || []).forEach(f => { try { f(...args); } catch (e) { console.error(e); } }); }

// ---------- 共用小工具 ----------
export function makeSeededRandom(seed) {
  let s = seed;
  return function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

export function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 原版 SVG 的船艦輪廓，3D 版拿同一組頂點去擠出成立體船身
export function shipPoints(cx, cy, r, facingRight) {
  if (facingRight) {
    return [[cx + r, cy], [cx - r * 0.55, cy - r * 0.8], [cx - r * 0.25, cy], [cx - r * 0.55, cy + r * 0.8]];
  }
  return [[cx - r, cy], [cx + r * 0.55, cy - r * 0.8], [cx + r * 0.25, cy], [cx + r * 0.55, cy + r * 0.8]];
}
export function kingShipPoints(cx, cy, r, facingRight) {
  const dir = facingRight ? 1 : -1;
  return [
    [cx + dir * r * 1.25, cy],
    [cx + dir * r * 0.35, cy - r * 0.95],
    [cx - dir * r * 0.9, cy - r * 0.55],
    [cx - dir * r * 0.5, cy],
    [cx - dir * r * 0.9, cy + r * 0.55],
    [cx + dir * r * 0.35, cy + r * 0.95]
  ];
}

// ---------- Minimal MQTT 3.1.1 client over WebSocket（原封搬自原版） ----------
const mqttEnc = new TextEncoder();
const mqttDec = new TextDecoder();
function mqttRemainingLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}
function mqttPacketConnect(clientId) {
  const vh = [0x00, 0x04, 0x4D, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x2D];
  const idBytes = mqttEnc.encode(clientId);
  const body = vh.concat([(idBytes.length >> 8) & 0xFF, idBytes.length & 0xFF, ...idBytes]);
  return new Uint8Array([0x10, ...mqttRemainingLen(body.length), ...body]);
}
function mqttPacketSubscribe(topic, pid) {
  const tBytes = mqttEnc.encode(topic);
  const body = [0x00, pid, (tBytes.length >> 8) & 0xFF, tBytes.length & 0xFF, ...tBytes, 0x00];
  return new Uint8Array([0x82, ...mqttRemainingLen(body.length), ...body]);
}
function mqttPacketPublish(topic, payload) {
  const tBytes = mqttEnc.encode(topic);
  const mBytes = mqttEnc.encode(payload);
  const body = [(tBytes.length >> 8) & 0xFF, tBytes.length & 0xFF, ...tBytes, ...mBytes];
  return new Uint8Array([0x30, ...mqttRemainingLen(body.length), ...body]);
}
function mqttData(ev) {
  const d = ev.data;
  if (d instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(d));
  if (d instanceof Blob) return d.arrayBuffer().then(b => new Uint8Array(b));
  return Promise.reject(new Error('unexpected ws data type'));
}
function mqttConnect(brokerUrl) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(brokerUrl, ['mqtt']); }  // 子協定必須，EMQX 沒有它會拒絕
    catch (err) { reject(err); return; }
    ws.binaryType = 'arraybuffer';
    const client = { ws, handlers: [], onDisconnect: null, pingTimer: null };
    let done = false;
    const tmo = setTimeout(() => fail('timeout'), 8000);
    function fail(msg) {
      if (done) return;
      done = true; clearTimeout(tmo);
      try { ws.close(); } catch (e) { }
      reject(new Error(msg));
    }
    ws.onopen = () => ws.send(mqttPacketConnect('pd' + Math.random().toString(36).slice(2, 10)));
    ws.onmessage = ev => mqttData(ev).then(a => {
      if (a[0] === 0x20 && a[1] === 0x02) { // CONNACK
        if (a[3] !== 0) { fail('broker refused'); return; }
        if (done) return;
        done = true; clearTimeout(tmo);
        resolve(client);
      } else if (a[0] === 0x30) { // PUBLISH QoS0
        let i = 1, mult = 1, rl = 0;
        do { rl += (a[i] & 0x7F) * mult; mult *= 128; i++; } while (a[i - 1] & 0x80);
        const tl = (a[i] << 8) | a[i + 1]; i += 2;
        const topic = mqttDec.decode(a.slice(i, i + tl));
        const payload = mqttDec.decode(a.slice(i + tl));
        client.handlers.forEach(h => { try { h(topic, payload); } catch (e) { } });
      }
    }).catch(() => { });
    ws.onclose = () => { if (!done) { fail('closed'); } else if (client.onDisconnect) { client.onDisconnect(); } };
    ws.onerror = () => { if (!done) { fail('ws-error'); } };
  });
}
function mqttSubscribe(client, topic) {
  return new Promise((resolve, reject) => {
    const pid = 1;
    const tmo = setTimeout(() => reject(new Error('suback timeout')), 8000);
    const onSub = ev => mqttData(ev).then(a => {
      if (a[0] !== 0x90) return;
      let i = 1;
      while (a[i] & 0x80) { i++; }
      i++;
      const gotPid = (a[i] << 8) | a[i + 1];
      if (gotPid === pid) {
        clearTimeout(tmo);
        client.ws.removeEventListener('message', onSub);
        resolve();
      }
    }).catch(() => { });
    client.ws.addEventListener('message', onSub);
    client.ws.send(mqttPacketSubscribe(topic, pid));
  });
}
function mqttStartPing(client) {
  client.pingTimer = setInterval(() => {
    if (client.ws.readyState === WebSocket.OPEN) { client.ws.send(new Uint8Array([0xC0, 0x00])); }
  }, 30000);
}
function mqttClose(client) {
  if (client.pingTimer) { clearInterval(client.pingTimer); client.pingTimer = null; }
  try { client.ws.close(); } catch (e) { }
}
function mqttConnectAny(idx) {
  idx = idx || 0;
  if (idx >= MQTT_BROKERS.length) return Promise.reject(new Error('all brokers failed'));
  return mqttConnect(MQTT_BROKERS[idx]).catch(() => mqttConnectAny(idx + 1));
}

// ---------- 遊戲狀態 ----------
let state = null;
let localIdCounters = { 1: 0, 2: 0 };

let mqttClient = null;
let roomTopic = null;
let myRole = null;    // 網路身分：1 = 房主, 2 = 加入者, null = 本機雙人
let myColor = null;   // 遊戲顏色：1 = 藍方, 2 = 紅方，由猜拳決定
let networked = false;
let joinTimeout = null;

export function getState() { return state; }
export function isNetworked() { return networked; }
export function getMyColor() { return myColor; }

function nextIdFor(owner) {
  localIdCounters[owner] += 1;
  return owner + '-' + localIdCounters[owner];
}

function freshState() {
  return { phase: 'rps', turn: 1, pieces: [], traces: [], winner: null, rpsChoices: { 1: null, 2: null }, rpsReveal: null };
}

function resetLocalState() {
  state = freshState();
  myColor = null;
  localIdCounters = { 1: 0, 2: 0 };
  emit('reset');
}

export function canActOn(owner) {
  return (!networked) || (myColor === owner);
}

// ---------- 彈射數學（與原版逐行相同） ----------
export function computeAim(piece, pointer) {
  const dx = pointer.x - piece.x, dy = pointer.y - piece.y;
  const dragDist = Math.hypot(dx, dy);
  if (dragDist < 1e-6) return null;
  const dragClamped = Math.min(dragDist, C.MAX_DRAG);
  const f = dragClamped / C.MAX_DRAG;
  const shotLen = C.MIN_SHOT + f * (C.MAX_SHOT - C.MIN_SHOT);
  const dirX = -dx / dragDist, dirY = -dy / dragDist;
  return { dragDist, f, shotLen, dirX, dirY };
}

function applyAngleError(dirX, dirY, f) {
  const maxErrDeg = C.MIN_ANGLE_ERR + f * (C.MAX_ANGLE_ERR - C.MIN_ANGLE_ERR);
  const errDeg = (Math.random() * 2 - 1) * maxErrDeg;
  const a = errDeg * Math.PI / 180;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  return { dirX: dirX * cosA - dirY * sinA, dirY: dirX * sinA + dirY * cosA };
}

function clipToBoard(piece, dirX, dirY, shotLen) {
  const minX = C.DOT_R, maxX = C.BOARD_W - C.DOT_R, minY = C.DOT_R, maxY = C.BOARD_H - C.DOT_R;
  let sMaxX = Infinity, sMaxY = Infinity;
  if (dirX > 0) sMaxX = (maxX - piece.x) / dirX;
  else if (dirX < 0) sMaxX = (minX - piece.x) / dirX;
  if (dirY > 0) sMaxY = (maxY - piece.y) / dirY;
  else if (dirY < 0) sMaxY = (minY - piece.y) / dirY;
  const wallLimit = Math.min(sMaxX, sMaxY);
  const sFinal = Math.max(0, Math.min(shotLen, wallLimit));
  const hitWall = wallLimit < shotLen - 0.5;
  return { endX: piece.x + dirX * sFinal, endY: piece.y + dirY * sFinal, hitWall };
}

function computeFinalShot(piece, pointer) {
  const aim = computeAim(piece, pointer);
  if (!aim) return null;
  const err = applyAngleError(aim.dirX, aim.dirY, aim.f);
  const clip = clipToBoard(piece, err.dirX, err.dirY, aim.shotLen);
  return { dragDist: aim.dragDist, endX: clip.endX, endY: clip.endY, hitWall: clip.hitWall };
}

export function isValidPlacement(x, y, owner) {
  if (y < C.EDGE_MARGIN || y > C.BOARD_H - C.EDGE_MARGIN) return false;
  if (owner === 1) {
    if (x < C.EDGE_MARGIN || x > C.CENTER_X - C.CENTER_MARGIN) return false;
  } else {
    if (x < C.CENTER_X + C.CENTER_MARGIN || x > C.BOARD_W - C.EDGE_MARGIN) return false;
  }
  for (const p of state.pieces) {
    if (Math.hypot(p.x - x, p.y - y) < C.MIN_GAP) return false;
  }
  return true;
}

// 依原版 hit-area（shipR + 12）找指標附近可互動的棋子
export function pieceAt(pt) {
  let best = null, bestD = Infinity;
  for (const p of state.pieces) {
    if (!p.alive) continue;
    const shipR = p.king ? C.DOT_R * 1.7 : C.DOT_R;
    const d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d <= shipR + 12 && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

// ---------- 網路 ----------
function sendMsg(msg) {
  if (networked && mqttClient && mqttClient.ws.readyState === WebSocket.OPEN) {
    msg.from = myRole;
    try { mqttClient.ws.send(mqttPacketPublish(roomTopic, JSON.stringify(msg))); } catch (e) { }
  }
}

function handleRemoteMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.from === myRole) return;  // MQTT 會把自己發布的訊息送回，過濾掉
  if (msg.type === 'join') {
    if (msg.from !== 2) return;
    if (joinTimeout) { clearTimeout(joinTimeout); joinTimeout = null; }
    networked = true; myRole = 1;
    try { mqttClient.ws.send(mqttPacketPublish(roomTopic, JSON.stringify({ type: 'welcome', from: 1 }))); } catch (e) { }
    enterGame();
    return;
  }
  if (msg.type === 'welcome') {
    if (msg.from !== 1) return;
    if (joinTimeout) { clearTimeout(joinTimeout); joinTimeout = null; }
    networked = true; myRole = 2;
    enterGame();
    return;
  }
  if (msg.type === 'rps') {
    state.rpsChoices[msg.from] = msg.choice;
    emit('sync');
    tryResolveRps();
    return;
  }
  if (msg.type === 'place') {
    state.pieces.push({ id: msg.id, x: msg.x, y: msg.y, owner: msg.owner, alive: true, lives: 1, king: false });
    const count = state.pieces.filter(p => p.owner === msg.owner).length;
    if (count >= 10) {
      if (msg.owner === 1) { state.phase = 'king1'; }
      else { state.phase = 'king2'; }
    }
    emit('sync');
  } else if (msg.type === 'king') {
    const piece = state.pieces.find(p => p.id === msg.id);
    if (piece) { piece.king = true; piece.lives = 2; }
    if (msg.owner === 1) { state.phase = 'setup2'; }
    else { state.phase = 'playing'; state.turn = 1; }
    emit('sync');
  } else if (msg.type === 'shot') {
    applyShotEffect(msg);
    emit('shot', msg);
  } else if (msg.type === 'restart') {
    resetLocalState();
    emit('sync');
  }
}

function genCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function roomTopicFor(code) { return 'pencilduel/' + code + '/game'; }

export function createRoom() {
  const code = genCode(5);
  emit('createStatus', { kind: 'connecting' });
  roomTopic = roomTopicFor(code);
  mqttConnectAny().then(c => {
    mqttClient = c;
    mqttClient.handlers.push((topic, payload) => {
      if (topic !== roomTopic) return;
      let msg; try { msg = JSON.parse(payload); } catch (e) { return; }
      handleRemoteMessage(msg);
    });
    return mqttSubscribe(mqttClient, roomTopic).then(() => {
      mqttStartPing(mqttClient);
      mqttClient.onDisconnect = () => {
        if (networked) { emit('netStatus', '連線中斷，重新整理頁面可重連'); }
        else { emit('createStatus', { kind: 'lost' }); }
      };
      emit('createStatus', { kind: 'waiting', code });
    });
  }).catch(() => {
    emit('createStatus', { kind: 'failed' });
  });
}

export function joinRoom(codeRaw) {
  if (!codeRaw) { emit('joinStatus', { kind: 'empty' }); return; }
  emit('joinStatus', { kind: 'connecting' });
  roomTopic = roomTopicFor(codeRaw);
  myRole = 2;  // 先宣告自己是加入者，避免收到自己 join 的回送被誤判
  joinTimeout = setTimeout(() => {
    joinTimeout = null;
    myRole = null;
    emit('joinStatus', { kind: 'noHost' });
    if (mqttClient) { mqttClose(mqttClient); mqttClient = null; }
  }, 15000);
  mqttConnectAny().then(c => {
    mqttClient = c;
    mqttClient.handlers.push((topic, payload) => {
      if (topic !== roomTopic) return;
      let msg; try { msg = JSON.parse(payload); } catch (e) { return; }
      handleRemoteMessage(msg);
    });
    return mqttSubscribe(mqttClient, roomTopic).then(() => {
      mqttStartPing(mqttClient);
      mqttClient.onDisconnect = () => {
        if (networked) { emit('netStatus', '連線中斷，重新整理頁面可重連'); }
        else { emit('joinStatus', { kind: 'lost' }); }
      };
      emit('joinStatus', { kind: 'waitingHost' });
      try { mqttClient.ws.send(mqttPacketPublish(roomTopic, JSON.stringify({ type: 'join', from: 2 }))); } catch (e) { }
    });
  }).catch(() => {
    clearTimeout(joinTimeout); joinTimeout = null;
    myRole = null;
    if (mqttClient) { mqttClose(mqttClient); mqttClient = null; }
    emit('joinStatus', { kind: 'failed' });
  });
}

export function startLocal() {
  networked = false; myRole = null;
  enterGame();
}

function enterGame() {
  emit('enterGame');
  resetLocalState();
  emit('sync');
}

export function leaveToLobby() {
  if (mqttClient) { mqttClose(mqttClient); }
  mqttClient = null; roomTopic = null; networked = false; myRole = null; myColor = null;
  if (joinTimeout) { clearTimeout(joinTimeout); joinTimeout = null; }
  emit('leftGame');
}

export function restart() {
  resetLocalState();
  emit('sync');
  sendMsg({ type: 'restart' });
}

// ---------- 猜拳 ----------
export function chooseRps(choice) {
  if (!state || state.phase !== 'rps') return;
  if (!networked) {
    // 本機雙人：輪流出拳、不揭曉，信任對方不要偷看
    if (state.turn === 1) {
      if (state.rpsChoices[1]) return;
      state.rpsChoices[1] = choice;
      state.turn = 2;
      emit('sync');
    } else {
      if (state.rpsChoices[2]) return;
      state.rpsChoices[2] = choice;
      tryResolveRps();
    }
  } else {
    if (state.rpsChoices[myRole]) return;
    state.rpsChoices[myRole] = choice;
    sendMsg({ type: 'rps', choice });
    emit('sync');
    tryResolveRps();
  }
}

function tryResolveRps() {
  const c1 = state.rpsChoices[1], c2 = state.rpsChoices[2];
  if (!c1 || !c2) return;
  if (c1 === c2) {
    state.rpsChoices = { 1: null, 2: null };
    state.turn = 1;
    emit('sync');
    return;
  }
  const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  const winnerColor = (beats[c1] === c2) ? 1 : 2;
  if (networked) { myColor = (myRole === winnerColor) ? 1 : 2; }
  state.rpsReveal = { c1, c2, winnerColor };
  emit('sync');
  setTimeout(() => {
    if (!state || state.phase !== 'rps') return;
    state.phase = 'setup1';
    state.turn = 1;
    state.rpsReveal = null;
    emit('sync');
  }, 1600);
}

export function getMyRole() { return myRole; }

// ---------- 放置 / 封王 / 出手 ----------
export function placeAt(pt) {
  const owner = state.phase === 'setup1' ? 1 : 2;
  if (!isValidPlacement(pt.x, pt.y, owner)) {
    return { ok: false, msg: '位置太擠或超出己方區域，換個地方試試' };
  }
  const id = nextIdFor(owner);
  state.pieces.push({ id, x: pt.x, y: pt.y, owner, alive: true, lives: 1, king: false });
  const count = state.pieces.filter(p => p.owner === owner).length;
  if (count >= 10) {
    if (owner === 1) { state.phase = 'king1'; }
    else { state.phase = 'king2'; }
  }
  sendMsg({ type: 'place', id, owner, x: pt.x, y: pt.y });
  emit('sync');
  return { ok: true };
}

export function selectKing(piece) {
  if (!canActOn(piece.owner)) { return { ok: false, msg: '還沒輪到你選王' }; }
  piece.king = true;
  piece.lives = 2;
  sendMsg({ type: 'king', id: piece.id, owner: piece.owner });
  if (piece.owner === 1) { state.phase = 'setup2'; }
  else { state.phase = 'playing'; state.turn = 1; }
  emit('sync');
  return { ok: true };
}

function applyShotEffect(payload) {
  const piece = state.pieces.find(p => p.id === payload.pieceId);
  if (piece) {
    piece.x = payload.endX; piece.y = payload.endY;
    if (payload.selfDeath) { piece.alive = false; piece.lives = 0; }
  }
  const hits = payload.hitIds || [];
  hits.forEach(hid => {
    const op = state.pieces.find(p => p.id === hid);
    if (op) {
      op.lives = (op.lives == null ? 1 : op.lives) - 1;
      if (op.lives <= 0) { op.alive = false; }
    }
  });
  state.traces.push({ x1: payload.startX, y1: payload.startY, x2: payload.endX, y2: payload.endY, owner: payload.owner });
  const owner = payload.owner;
  const opponent = owner === 1 ? 2 : 1;
  state.turn = opponent;
  if (payload.baseWin && piece && piece.alive) {
    state.phase = 'over';
    state.winner = owner;
    return;
  }
  const ownerAlive = state.pieces.some(p => p.owner === owner && p.alive);
  const oppAlive = state.pieces.some(p => p.owner === opponent && p.alive);
  if (!oppAlive) {
    state.phase = 'over';
    state.winner = owner;
  } else if (!ownerAlive) {
    state.phase = 'over';
    state.winner = opponent;
  }
}

// 放開拖曳，真正發射。誤差只在這一刻套用，預覽階段看不到。
export function releaseShot(piece, pointer) {
  const shot = computeFinalShot(piece, pointer);
  if (!shot || shot.dragDist < 8) { return { fired: false }; }
  const startX = piece.x, startY = piece.y;
  const endX = shot.endX, endY = shot.endY;
  const opponent = piece.owner === 1 ? 2 : 1;
  const hitIds = [];
  state.pieces.forEach(op => {
    if (op.owner === opponent && op.alive) {
      const d = pointSegDist(op.x, op.y, startX, startY, endX, endY);
      if (d <= C.HIT_R) { hitIds.push(op.id); }
    }
  });
  const targetBase = piece.owner === 1 ? C.RED_BASE : C.BLUE_BASE;
  const baseWin = Math.hypot(endX - targetBase.x, endY - targetBase.y) <= C.BASE_R;
  const inHazard = !baseWin && Math.abs(endX - C.CENTER_X) <= C.HAZARD_HALF_WIDTH;
  const selfDeath = shot.hitWall || inHazard;
  // hitWall 是額外欄位，原版 2D 客戶端會忽略它，不影響互通
  const payload = { type: 'shot', pieceId: piece.id, startX, startY, endX, endY, hitIds, owner: piece.owner, selfDeath, baseWin, hitWall: shot.hitWall };
  applyShotEffect(payload);
  sendMsg(payload);
  emit('shot', payload);
  return { fired: true };
}
