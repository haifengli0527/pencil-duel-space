// Three.js 3D 渲染層：棋盤平面 = XZ 平面，棋盤座標 (x, y) 直接映射到世界座標 (x, 0, y)，
// 因此所有遊戲邏輯座標不需任何轉換。船艦造型直接沿用原版 SVG 輪廓擠出成立體。
import * as THREE from 'three';
import { C, shipPoints, kingShipPoints, makeSeededRandom } from './game.js';

const COL = {
  blue: 0x4fc3ff, blueSoft: 0x9fe0ff,
  red: 0xff6b6b, redSoft: 0xffb199,
  gold: 0xffd76b, asteroid: 0x7a7266,
  bg: 0x03040c,
};
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function ownerColor(owner) { return owner === 1 ? COL.blue : COL.red; }

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function radialTexture(inner, outer) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function boardTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(256, 230, 40, 256, 256, 350);
  g.addColorStop(0, '#111a44');
  g.addColorStop(0.6, '#080b22');
  g.addColorStop(1, '#020208');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const rnd = makeSeededRandom(7);
  for (let i = 0; i < 260; i++) {  // 盤面上的微弱噪點，仿原版 feTurbulence 顆粒感
    ctx.fillStyle = 'rgba(255,255,255,' + (0.015 + rnd() * 0.03) + ')';
    ctx.fillRect(rnd() * 512, rnd() * 512, 1.2, 1.2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRenderer3D(canvas, panel) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.bg);
  scene.fog = new THREE.Fog(COL.bg, 1500, 3000);

  const camera = new THREE.PerspectiveCamera(38, C.BOARD_W / C.BOARD_H, 10, 5000);
  const CAM_POS = new THREE.Vector3(C.CENTER_X, 600, 1010);
  const CAM_TARGET = new THREE.Vector3(C.CENTER_X, 0, 255);
  camera.position.copy(CAM_POS);
  camera.lookAt(CAM_TARGET);

  scene.add(new THREE.HemisphereLight(0x8fa3ff, 0x0a0a18, 0.95));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight.position.set(C.CENTER_X - 300, 800, 600);
  scene.add(dirLight);

  // ---- 棋盤平面 ----
  const boardMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(C.BOARD_W, C.BOARD_H).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.92, metalness: 0.08 })
  );
  boardMesh.position.set(C.CENTER_X, 0, C.BOARD_H / 2);
  scene.add(boardMesh);

  // ---- 邊界「黑洞」框 ----
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x140f2e, emissive: 0x7a4dff, emissiveIntensity: 0.55 });
  const mkEdge = (len, x, z, alongX) => {
    const geo = alongX ? new THREE.BoxGeometry(len, 2.6, 2.6) : new THREE.BoxGeometry(2.6, 2.6, len);
    const m = new THREE.Mesh(geo, edgeMat);
    m.position.set(x, 1.3, z);
    scene.add(m);
  };
  mkEdge(C.BOARD_W + 6, C.CENTER_X, 0, true);
  mkEdge(C.BOARD_W + 6, C.CENTER_X, C.BOARD_H, true);
  mkEdge(C.BOARD_H + 6, 0, C.BOARD_H / 2, false);
  mkEdge(C.BOARD_H + 6, C.BOARD_W, C.BOARD_H / 2, false);

  // ---- 星空 ----
  const starGroup = new THREE.Group();
  starGroup.position.set(C.CENTER_X, 0, C.BOARD_H / 2);
  {
    const rnd = makeSeededRandom(7);
    const n = 1100, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 1500 + rnd() * 1100;
      const theta = rnd() * Math.PI * 2;
      const phi = Math.acos(rnd() * 2 - 1);
      let x = r * Math.sin(phi) * Math.cos(theta);
      let y = r * Math.cos(phi);
      let z = r * Math.sin(phi) * Math.sin(theta);
      if (y < -250) y = -y * 0.4;  // 盤面下方少放一點
      pos.set([x, y, z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGroup.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.4, transparent: true, opacity: 0.85, sizeAttenuation: true })));
  }
  scene.add(starGroup);

  // ---- 中央小行星帶（佈局用與原版相同的 seed 42） ----
  const hazardTint = new THREE.Mesh(
    new THREE.PlaneGeometry(C.HAZARD_HALF_WIDTH * 2, C.BOARD_H).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: COL.asteroid, transparent: true, opacity: 0.1, depthWrite: false })
  );
  hazardTint.position.set(C.CENTER_X, 0.25, C.BOARD_H / 2);
  hazardTint.renderOrder = 1;
  scene.add(hazardTint);

  const asteroids = [];
  {
    const rnd = makeSeededRandom(42);
    const rockMat = new THREE.MeshStandardMaterial({ color: COL.asteroid, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 40; i++) {
      const y = rnd() * C.BOARD_H;
      const x = C.CENTER_X + (rnd() * 2 - 1) * C.HAZARD_HALF_WIDTH * 0.9;
      const r = 3 + rnd() * 6;
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), rockMat);
      rock.position.set(x, 5 + r, y);
      rock.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      asteroids.push({ mesh: rock, baseY: 5 + r, phase: rnd() * 6.28, spin: 0.15 + rnd() * 0.35 });
      scene.add(rock);
    }
  }

  // ---- 基地 ----
  const basePulseMats = [];
  function buildBase(bx, by, color) {
    const g = new THREE.Group();
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(C.BASE_ICON_R + 18, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,255,255,0.6)', 'rgba(255,255,255,0)'), color, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    glow.position.y = 0.35;
    g.add(glow);
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
    basePulseMats.push(ringMat);
    const ring = new THREE.Mesh(new THREE.RingGeometry(C.BASE_ICON_R - 1.2, C.BASE_ICON_R + 0.6, 44).rotateX(-Math.PI / 2), ringMat);
    ring.position.y = 0.55;
    ring.renderOrder = 2;
    g.add(ring);
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + i * (2 * Math.PI / 5);
      pts.push(new THREE.Vector3(Math.cos(ang) * C.BASE_ICON_R, 0, Math.sin(ang) * C.BASE_ICON_R));
    }
    const penta = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
    );
    penta.position.y = 0.75;
    g.add(penta);
    const core = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 10), new THREE.MeshBasicMaterial({ color }));
    core.position.y = 3;
    g.add(core);
    const light = new THREE.PointLight(color, 1.3, 340, 0);
    light.position.y = 70;
    g.add(light);
    g.position.set(bx, 0, by);
    scene.add(g);
  }
  buildBase(C.BLUE_BASE.x, C.BLUE_BASE.y, COL.blue);
  buildBase(C.RED_BASE.x, C.RED_BASE.y, COL.red);

  // ---- 佈署階段的陣地提示區 ----
  function buildZone(x0, x1, color) {
    const w = x1 - x0, h = C.BOARD_H - C.EDGE_MARGIN * 2;
    const grp = new THREE.Group();
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, depthWrite: false })
    );
    fill.renderOrder = 1;
    grp.add(fill);
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 })
    );
    border.position.y = 0.1;
    grp.add(border);
    grp.position.set((x0 + x1) / 2, 0.3, C.BOARD_H / 2);
    grp.visible = false;
    scene.add(grp);
    return grp;
  }
  const zoneBlue = buildZone(C.EDGE_MARGIN, C.CENTER_X - C.CENTER_MARGIN, COL.blue);
  const zoneRed = buildZone(C.CENTER_X + C.CENTER_MARGIN, C.BOARD_W - C.EDGE_MARGIN, COL.red);

  // ---- 船艦幾何（原版 SVG 輪廓擠出）與材質 ----
  const geomCache = new Map();
  function shipGeometry(owner, king) {
    const key = owner + '-' + (king ? 'k' : 'n');
    if (geomCache.has(key)) return geomCache.get(key);
    const r = king ? C.DOT_R * 1.7 : C.DOT_R;
    const pts = king ? kingShipPoints(0, 0, r, owner === 1) : shipPoints(0, 0, r, owner === 1);
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
    const depth = king ? 9 : 6;
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 1, bevelSize: 0.9, bevelSegments: 1 });
    geo.rotateX(Math.PI / 2);              // shape 的 y（棋盤 y）→ 世界 z，擠出方向朝下
    geo.translate(0, depth + 1.2, 0);      // 抬回棋盤上方
    const edges = new THREE.EdgesGeometry(geo, 24);
    const pair = { geo, edges };
    geomCache.set(key, pair);
    return pair;
  }

  const bodyMatNormal = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.45, metalness: 0.25 });
  const bodyMatKing = {
    1: new THREE.MeshStandardMaterial({ color: COL.blue, transparent: true, opacity: 0.5, roughness: 0.25, metalness: 0.2, emissive: COL.blue, emissiveIntensity: 0.25 }),
    2: new THREE.MeshStandardMaterial({ color: COL.red, transparent: true, opacity: 0.5, roughness: 0.25, metalness: 0.2, emissive: COL.red, emissiveIntensity: 0.25 }),
  };
  const bodyMatDead = new THREE.MeshStandardMaterial({ color: 0x4a4f5e, roughness: 0.95, transparent: true, opacity: 0.6 });
  const edgeMats = {
    1: new THREE.LineBasicMaterial({ color: COL.blue }),
    2: new THREE.LineBasicMaterial({ color: COL.red }),
    dead: new THREE.LineBasicMaterial({ color: 0x777c8a, transparent: true, opacity: 0.6 }),
  };
  const selRingMats = {
    1: new THREE.MeshBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }),
    2: new THREE.MeshBasicMaterial({ color: COL.red, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }),
  };
  const thinRingMats = {
    1: new THREE.MeshBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }),
    2: new THREE.MeshBasicMaterial({ color: COL.red, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }),
  };
  const ringGeoCache = new Map();
  function ringGeo(rIn, rOut) {
    const key = rIn.toFixed(1) + '-' + rOut.toFixed(1);
    if (!ringGeoCache.has(key)) ringGeoCache.set(key, new THREE.RingGeometry(rIn, rOut, 40).rotateX(-Math.PI / 2));
    return ringGeoCache.get(key);
  }

  // ---- 棋子網格管理 ----
  const pieceGroups = new Map(); // id → group
  function pieceHash(id) { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) & 0xffff; return h; }

  function buildPieceGroup(p) {
    const grp = new THREE.Group();
    grp.userData = { variant: null, body: null, edges: null, selRing: null, kingRing: null, livesRing: null };
    grp.position.set(p.x, 0, p.y);
    scene.add(grp);
    pieceGroups.set(p.id, grp);
    return grp;
  }

  function applyPieceLook(p) {
    const grp = pieceGroups.get(p.id);
    if (!grp) return;
    const u = grp.userData;
    const variant = p.owner + '-' + (p.king ? 'k' : 'n');
    if (u.variant !== variant) {
      if (u.body) { grp.remove(u.body); grp.remove(u.edges); }
      if (u.selRing) { grp.remove(u.selRing); grp.remove(u.kingRing); grp.remove(u.livesRing); }
      const { geo, edges } = shipGeometry(p.owner, p.king);
      u.body = new THREE.Mesh(geo, bodyMatNormal);
      u.edges = new THREE.LineSegments(edges, edgeMats[p.owner]);
      grp.add(u.body); grp.add(u.edges);
      const shipR = p.king ? C.DOT_R * 1.7 : C.DOT_R;
      u.selRing = new THREE.Mesh(ringGeo(shipR + 5.8, shipR + 8.2), selRingMats[p.owner]);
      u.selRing.position.y = 0.5; u.selRing.renderOrder = 3;
      u.kingRing = new THREE.Mesh(ringGeo(shipR + 4, shipR + 6), thinRingMats[p.owner]);
      u.kingRing.position.y = 0.62; u.kingRing.renderOrder = 3;
      u.livesRing = new THREE.Mesh(ringGeo(shipR + 9, shipR + 11), thinRingMats[p.owner]);
      u.livesRing.position.y = 0.62; u.livesRing.renderOrder = 3;
      grp.add(u.selRing); grp.add(u.kingRing); grp.add(u.livesRing);
      u.variant = variant;
    }
    if (p.alive) {
      u.body.material = p.king ? bodyMatKing[p.owner] : bodyMatNormal;
      u.edges.material = edgeMats[p.owner];
      grp.rotation.z = 0;
      grp.position.y = 0;
      u.kingRing.visible = !!p.king;
      u.livesRing.visible = !!p.king && p.lives >= 2;
    } else {
      u.body.material = bodyMatDead;
      u.edges.material = edgeMats.dead;
      grp.rotation.z = (pieceHash(p.id) % 2 ? 1 : -1) * 0.16;  // 殘骸微傾
      grp.position.y = -1.6;
      u.kingRing.visible = false;
      u.livesRing.visible = false;
      u.selRing.visible = false;
    }
  }

  // ---- 航跡 ----
  const traceGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const traceMats = {
    1: new THREE.MeshBasicMaterial({ color: COL.blueSoft, transparent: true, opacity: 0.8 }),
    2: new THREE.MeshBasicMaterial({ color: COL.redSoft, transparent: true, opacity: 0.8 }),
  };
  const traceMeshes = [];
  const UP = new THREE.Vector3(0, 1, 0);
  function traceTransform(mesh, x1, y1, x2, y2, len) {
    const dx = x2 - x1, dy = y2 - y1;
    const full = Math.hypot(dx, dy) || 1;
    const ux = dx / full, uy = dy / full;
    mesh.scale.set(1.4, Math.max(len, 0.01), 1.4);
    mesh.quaternion.setFromUnitVectors(UP, new THREE.Vector3(ux, 0, uy));
    mesh.position.set(x1 + ux * len / 2, 1.2, y1 + uy * len / 2);
  }
  function ensureTrace(i, t) {
    if (traceMeshes[i]) return traceMeshes[i];
    const mesh = new THREE.Mesh(traceGeo, traceMats[t.owner]);
    const len = Math.hypot(t.x2 - t.x1, t.y2 - t.y1);
    traceTransform(mesh, t.x1, t.y1, t.x2, t.y2, len);
    scene.add(mesh);
    traceMeshes[i] = mesh;
    return mesh;
  }

  // ---- 粒子爆炸 ----
  const bursts = [];
  function spawnBurst(x, z, color, count, speed, ttl) {
    if (REDUCED) return;
    const n = count || 30;
    const pos = new Float32Array(n * 3);
    const vels = [];
    for (let i = 0; i < n; i++) {
      pos.set([x, 6, z], i * 3);
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 2 - 1);
      const sp = (speed || 130) * (0.35 + Math.random() * 0.65);
      vels.push([Math.sin(ph) * Math.cos(th) * sp, Math.abs(Math.cos(ph)) * sp * 0.7, Math.sin(ph) * Math.sin(th) * sp]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size: 4.5, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(geo, mat);
    scene.add(pts);
    bursts.push({ pts, vels, life: 0, ttl: ttl || 0.7 });
  }

  let camShake = 0;
  function shake(amp) { if (!REDUCED) camShake = Math.max(camShake, amp); }

  // ---- 瞄準預覽 ----
  const previewGroup = new THREE.Group();
  previewGroup.visible = false;
  scene.add(previewGroup);
  const dragLineGeo = new THREE.BufferGeometry();
  dragLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const dragLineMats = {
    1: new THREE.LineDashedMaterial({ color: COL.blue, dashSize: 4, gapSize: 6, transparent: true, opacity: 0.4 }),
    2: new THREE.LineDashedMaterial({ color: COL.red, dashSize: 4, gapSize: 6, transparent: true, opacity: 0.4 }),
  };
  const dragLine = new THREE.Line(dragLineGeo, dragLineMats[1]);
  previewGroup.add(dragLine);
  const guideMats = {
    1: new THREE.MeshBasicMaterial({ color: COL.blue, transparent: true, opacity: 0.6 }),
    2: new THREE.MeshBasicMaterial({ color: COL.red, transparent: true, opacity: 0.6 }),
  };
  const guideShaft = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1, 6), guideMats[1]);
  const guideTip = new THREE.Mesh(new THREE.ConeGeometry(3.2, 9, 8), guideMats[1]);
  previewGroup.add(guideShaft); previewGroup.add(guideTip);

  function preview(piece, aim) {
    if (!piece || !aim) { previewGroup.visible = false; return; }
    previewGroup.visible = true;
    const posAttr = dragLineGeo.getAttribute('position');
    posAttr.setXYZ(0, piece.x, 2, piece.y);
    posAttr.setXYZ(1, aim.pointerX, 2, aim.pointerY);
    posAttr.needsUpdate = true;
    dragLine.material = dragLineMats[piece.owner];
    dragLine.computeLineDistances();
    dragLineGeo.computeBoundingSphere();
    const guideLen = 40;
    const dir = new THREE.Vector3(aim.dirX, 0, aim.dirY);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    guideShaft.material = guideMats[piece.owner];
    guideTip.material = guideMats[piece.owner];
    guideShaft.scale.set(1, guideLen, 1);
    guideShaft.quaternion.copy(q);
    guideShaft.position.set(piece.x + aim.dirX * guideLen / 2, 2, piece.y + aim.dirY * guideLen / 2);
    guideTip.quaternion.copy(q);
    guideTip.position.set(piece.x + aim.dirX * (guideLen + 4), 2, piece.y + aim.dirY * (guideLen + 4));
  }

  // ---- 彈射動畫 ----
  const tweens = [];
  let animatingCount = 0;

  // 收尾不依賴 RAF：分頁被切到背景、RAF 凍結時，setTimeout 到時仍強制完成，
  // 避免輸入鎖與狀態列卡在動畫中。
  function finishTween(tw) {
    if (tw.done) return;
    tw.done = true;
    const idx = tweens.indexOf(tw);
    if (idx >= 0) tweens.splice(idx, 1);
    tw.update(1);
    if (tw.end) tw.end();
  }
  function pushTween(tw) {
    tweens.push(tw);
    setTimeout(() => finishTween(tw), tw.dur * 1000 + 80);
  }

  function animateShot(payload, state, done) {
    const grp = pieceGroups.get(payload.pieceId);
    const p = state.pieces.find(pp => pp.id === payload.pieceId);
    const traceIdx = state.traces.length - 1;
    const t = state.traces[traceIdx];
    if (!grp || !t) { sync(state); done(); return; }
    animatingCount++;
    const dx = payload.endX - payload.startX, dy = payload.endY - payload.startY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // 船頭轉向飛行方向（藍船頭朝 +X，紅船頭朝 -X）
    grp.rotation.y = -Math.atan2(uy, ux) + (payload.owner === 2 ? Math.PI : 0);
    const traceMesh = ensureTrace(traceIdx, t);
    traceTransform(traceMesh, t.x1, t.y1, t.x2, t.y2, 0.01);
    // 命中目標的時間點（沿航跡的投影比例）
    const hitEvents = (payload.hitIds || []).map(hid => {
      const hp = state.pieces.find(pp => pp.id === hid);
      if (!hp) return null;
      const proj = ((hp.x - payload.startX) * ux + (hp.y - payload.startY) * uy);
      return { piece: hp, k: Math.max(0, Math.min(1, proj / len)), fired: false };
    }).filter(Boolean);

    const dur = REDUCED ? 0.16 : 0.5 + 0.4 * (len / C.MAX_SHOT);
    pushTween({
      dur,
      update(k) {
        const e = easeOutCubic(k);
        const cx = payload.startX + ux * len * e, cy = payload.startY + uy * len * e;
        grp.position.x = cx; grp.position.z = cy;
        traceTransform(traceMesh, t.x1, t.y1, t.x2, t.y2, len * e);
        hitEvents.forEach(h => {
          if (!h.fired && e >= h.k) {
            h.fired = true;
            spawnBurst(h.piece.x, h.piece.y, 0xffffff, 16, 90, 0.45);
            const hg = pieceGroups.get(h.piece.id);
            if (hg) pushTween({ dur: 0.28, update(kk) { const s = 1 + 0.3 * Math.sin(Math.PI * kk); hg.scale.set(s, s, s); }, end() { hg.scale.set(1, 1, 1); applyPieceLook(h.piece); } });
            if (!h.piece.alive) { spawnBurst(h.piece.x, h.piece.y, ownerColor(h.piece.owner), 34, 150, 0.8); shake(4); }
          }
        });
      },
      end() {
        hitEvents.forEach(h => { if (!h.fired) { h.fired = true; applyPieceLook(h.piece); } });
        if (payload.baseWin && p && p.alive) {
          spawnBurst(payload.endX, payload.endY, COL.gold, 60, 200, 1.1);
          shake(6);
        } else if (payload.selfDeath) {
          const wall = payload.hitWall != null ? payload.hitWall : Math.abs(payload.endX - C.CENTER_X) > C.HAZARD_HALF_WIDTH;
          spawnBurst(payload.endX, payload.endY, wall ? 0x9b6bff : 0xffa864, 40, 160, 0.9);
          shake(5);
        }
        animatingCount--;
        sync(state);
        done();
      }
    });
  }

  // ---- 同步狀態 → 場景 ----
  let lastState = null;
  function sync(state, selectableFn) {
    lastState = state;
    if (selectableFn) lastSelectableFn = selectableFn;
    const seen = new Set();
    state.pieces.forEach(p => {
      seen.add(p.id);
      let grp = pieceGroups.get(p.id);
      if (!grp) grp = buildPieceGroup(p);
      if (animatingCount === 0 || grp.userData.variant === null) {
        grp.position.x = p.x; grp.position.z = p.y;
      }
      applyPieceLook(p);
      const sel = lastSelectableFn ? lastSelectableFn(p) : false;
      grp.userData.selRing.visible = !!(p.alive && sel);
    });
    for (const [id, grp] of pieceGroups) {
      if (!seen.has(id)) { scene.remove(grp); pieceGroups.delete(id); }
    }
    state.traces.forEach((t, i) => ensureTrace(i, t));
    zoneBlue.visible = state.phase === 'setup1';
    zoneRed.visible = state.phase === 'setup2';
  }
  let lastSelectableFn = null;

  function reset() {
    for (const [, grp] of pieceGroups) scene.remove(grp);
    pieceGroups.clear();
    traceMeshes.forEach(m => { if (m) scene.remove(m); });
    traceMeshes.length = 0;
    bursts.forEach(b => scene.remove(b.pts));
    bursts.length = 0;
    tweens.forEach(tw => { tw.done = true; });  // 讓未到期的 setTimeout 收尾變 no-op
    tweens.length = 0;
    animatingCount = 0;
    previewGroup.visible = false;
  }

  // ---- 指標 → 棋盤座標 ----
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitV = new THREE.Vector3();
  function toBoard(e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.ray.intersectPlane(groundPlane, hitV);
    if (!hit) return null;
    return { x: hit.x, y: hit.z };
  }

  function toScreen(bx, by) {  // 測試輔助：棋盤座標 → 頁面座標
    const v = new THREE.Vector3(bx, 0, by).project(camera);
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
  }

  // ---- 尺寸 ----
  function resize() {
    const w = panel.clientWidth, h = panel.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(panel);
  resize();

  // ---- 主迴圈 ----
  const clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    // 補間用時鐘絕對時間，RAF 被節流（背景分頁、低幀率）時動畫仍照實際時間完成
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (tw.start == null) tw.start = t;
      const k = Math.min((t - tw.start) / tw.dur, 1);
      if (k >= 1) { finishTween(tw); }
      else { tw.update(k); }
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.life += dt;
      const pos = b.pts.geometry.getAttribute('position');
      for (let j = 0; j < b.vels.length; j++) {
        pos.setXYZ(j, pos.getX(j) + b.vels[j][0] * dt, pos.getY(j) + b.vels[j][1] * dt, pos.getZ(j) + b.vels[j][2] * dt);
      }
      pos.needsUpdate = true;
      b.pts.material.opacity = Math.max(0, 1 - b.life / b.ttl);
      if (b.life >= b.ttl) { scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); bursts.splice(i, 1); }
    }
    if (!REDUCED) {
      const pulse = 0.45 + 0.35 * Math.sin(t * 4.8);
      selRingMats[1].opacity = pulse; selRingMats[2].opacity = pulse;
      const bp = 0.62 + 0.28 * Math.sin(t * (Math.PI * 2 / 2.2));
      basePulseMats.forEach(m => { m.opacity = bp; });
      asteroids.forEach(a => {
        a.mesh.rotation.x += a.spin * dt * 0.6;
        a.mesh.rotation.y += a.spin * dt;
        a.mesh.position.y = a.baseY + Math.sin(t * 0.8 + a.phase) * 1.6;
      });
      starGroup.rotation.y += dt * 0.004;
    }
    if (camShake > 0.05) {
      camera.position.set(
        CAM_POS.x + (Math.random() - 0.5) * camShake,
        CAM_POS.y + (Math.random() - 0.5) * camShake,
        CAM_POS.z + (Math.random() - 0.5) * camShake
      );
      camShake *= Math.pow(0.0001, dt);  // 快速衰減
      camera.lookAt(CAM_TARGET);
    } else if (camShake !== 0) {
      camShake = 0;
      camera.position.copy(CAM_POS);
      camera.lookAt(CAM_TARGET);
    }
    if (canvas.width > 0) renderer.render(scene, camera);
  }
  frame();

  return {
    sync, reset, animateShot, preview, toBoard, toScreen,
    setCursor(c) { canvas.style.cursor = c; },
    isAnimating() { return animatingCount > 0; },
  };
}
