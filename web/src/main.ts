import * as THREE from 'three';
import GUI from 'lil-gui';
import { params } from './params';
import { applyOffAxis, cameraPosS, displaySizeMm, screenFrame, setViewportOverride, sToD, viewportRectS } from './geometry';
import { buildScene } from './scene';
import { Character } from './character';
import { PlyPlayer } from './ply/plyPlayer';
import { collectDroppedFiles } from './dropFiles';
import { FaceTracker } from './tracker';

// ---------- ネイティブ (WKWebView ラッパー) からの入力 ----------
// ラッパーは window.__native に値を書き込み、ここで毎フレーム読む。
// 蓋の角度の優先順: ネイティブ > クエリ ?lid= > GUI スライダー
type Viewport = { left: number; top: number; width: number; height: number };
declare global {
  interface Window {
    __native?: { lidAngle?: number; viewport?: Viewport; display?: { widthMm: number; heightMm: number } };
    setLidAngle: (deg: number) => void;
    setViewportRect: (r: Viewport | null) => void;
  }
}
// 手動で試すための口 (ブラウザのコンソールからも呼べる)
window.setLidAngle = (deg) => ((window.__native ??= {}).lidAngle = deg);
window.setViewportRect = (r) => ((window.__native ??= {}).viewport = r ?? undefined);

let lidSource = 'slider';
const q = new URLSearchParams(location.search);
const qLid = Number(q.get('lid'));
if (q.has('lid') && Number.isFinite(qLid)) {
  params.lidAngle = qLid;
  lidSource = 'query';
}

// 画面の物理サイズ: ネイティブ > クエリ ?displayW=&displayH= > 初期値 (16" 2021)
let displaySource = 'default';
const qW = Number(q.get('displayW'));
const qH = Number(q.get('displayH'));
if (qW > 0) {
  params.displayWidthMm = qW;
  params.displayHeightMm = qH > 0 ? qH : 0;
  displaySource = 'query';
}

let lastNativeLid: number | undefined;
let lastNativeDisplay: string | undefined;
function pollNative() {
  const n = window.__native;
  const lid = n?.lidAngle;
  if (lid !== undefined && Number.isFinite(lid) && lid !== lastNativeLid) {
    lastNativeLid = lid;
    params.lidAngle = lid;
    lidSource = 'native';
    lidCtrl.updateDisplay();
  }
  const d = n?.display;
  const dKey = d && `${d.widthMm}x${d.heightMm}`;
  if (d && d.widthMm > 0 && d.heightMm > 0 && dKey !== lastNativeDisplay) {
    lastNativeDisplay = dKey;
    params.displayWidthMm = d.widthMm;
    params.displayHeightMm = d.heightMm;
    displaySource = 'native';
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
  setViewportOverride(n?.viewport ?? null);
}

// ---------- 描画 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));

const camera = new THREE.PerspectiveCamera();
const { scene, update } = buildScene(params);

// /ply なら連番 PLY のループ再生、それ以外は VRM のドラッグ & ドロップ
const plyMode = location.pathname.replace(/\/+$/, '') === '/ply';

// ---------- PLY アニメーション (/ply) ----------
const ply = plyMode ? new PlyPlayer(scene, params) : null;
ply?.start().catch((e) => {
  console.error(e);
  ply.status = `error: ${e?.message ?? e}`;
});

// ---------- キャラクター (VRM のドラッグ & ドロップ) ----------
const character = new Character(scene, params);
(window as any).__debug = { params, character, ply }; // コンソールからの調整用
const dropHint = document.getElementById('drop-hint')!;
if (plyMode) dropHint.querySelector('span')!.textContent = 'PLY のフォルダをドロップ';
let characterStatus = '';

async function loadVrm(file: File) {
  characterStatus = `loading ${file.name}…`;
  try {
    await character.loadFile(file);
    characterStatus = character.name;
  } catch (e: any) {
    console.error(e);
    characterStatus = `error: ${e?.message ?? e}`;
  }
}

addEventListener('dragover', (e) => {
  e.preventDefault();
  dropHint.classList.add('over');
});
addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropHint.classList.remove('over');
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dropHint.classList.remove('over');
  if (!e.dataTransfer) return;
  if (ply) {
    // PLY: フォルダ (または .ply ファイルの束) を受け取る
    collectDroppedFiles(e.dataTransfer)
      .then(({ files, name }) => ply.loadFiles(files, name))
      .catch((err) => {
        console.error(err);
        ply.status = `error: ${err?.message ?? err}`;
      });
    return;
  }
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.vrm$/i.test(f.name));
  if (file) loadVrm(file);
  else characterStatus = 'error: .vrm ファイルをドロップしてください';
});

const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = '.vrm';
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadVrm(f);
  fileInput.value = '';
});

// ---------- トラッキング ----------
const tracker = new FaceTracker(params);
const videoEl = tracker.video;
videoEl.id = 'preview';
document.body.appendChild(videoEl);

tracker.start().catch((e) => {
  console.error(e);
  tracker.status = `error: ${e?.message ?? e}`;
  params.source = 'mouse';
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
});

// マウスモード (カメラが使えないときの開発用)
const mouse = new THREE.Vector2();
addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
});

// ---------- GUI ----------
const gui = new GUI({ title: 'Pseudo 3D Window  (H で表示切替 / F でフルスクリーン)' });
const fLid = gui.addFolder('蓋');
const lidCtrl = fLid
  .add(params, 'lidAngle', 80, 160, 0.1)
  .name('開き角 (°)')
  .onChange(() => (lidSource = 'slider'));

const fTrack = gui.addFolder('トラッキング');
fTrack.add(params, 'source', ['camera', 'mouse']).name('入力');
fTrack.add(params, 'eye', ['center', 'left', 'right']).name('視点の目');
fTrack.add(params, 'cameraHFovDeg', 40, 100, 0.5).name('カメラ水平画角 (°)');
fTrack.add(params, 'ipdMm', 50, 75, 0.5).name('瞳孔間距離 (mm)');
fTrack.add(params, 'minCutoff', 0.05, 5, 0.05).name('平滑化 minCutoff');
fTrack.add(params, 'beta', 0, 0.1, 0.001).name('平滑化 beta');
fTrack.add(params, 'predictionMs', 0, 120, 1).name('予測 (ms)');
fTrack.add(params, 'mirrorX').name('左右反転');
fTrack.add(params, 'calibDistanceMm', 200, 1000, 1).name('実測距離 (mm)');
fTrack
  .add(
    {
      calibrate: () => {
        if (tracker.rawDepthMm > 0) {
          params.depthScale = params.calibDistanceMm / tracker.rawDepthMm;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
        }
      },
    },
    'calibrate',
  )
  .name('今の距離 = 実測距離 として補正');
fTrack.add(params, 'depthScale', 0.5, 2, 0.001).name('奥行き補正');

const fGeo = gui.addFolder('本体の寸法 (mm)');
fGeo
  .add(params, 'displayWidthMm', 250, 400, 0.1)
  .name('表示領域の横幅')
  .onChange(() => (displaySource = 'slider'));
fGeo
  .add(params, 'displayHeightMm', 0, 300, 0.1)
  .name('表示領域の高さ (0=自動)')
  .onChange(() => (displaySource = 'slider'));
fGeo.add(params, 'cameraFromTopMm', 0, 15, 0.1).name('カメラ: 上端から');
fGeo.add(params, 'hingeHeightMm', 0, 30, 0.5).name('ヒンジ軸の高さ');
fGeo.add(params, 'displayBottomFromHingeMm', 0, 40, 0.5).name('ヒンジ→表示下端');
fGeo.add(params, 'screenSurfaceOffsetMm', 0, 15, 0.5).name('ヒンジ→画面表面');
fGeo.close();

const fChar = gui.addFolder(plyMode ? 'PLY アニメーション' : 'キャラクター');
if (plyMode) {
  fChar.add(params, 'plyPlaying').name('再生');
  fChar.add(params, 'plyPointSize', 0.5, 6, 0.1).name('点の大きさ (px)');
} else {
  fChar.add({ open: () => fileInput.click() }, 'open').name('VRM を開く… (ドロップでも可)');
}
fChar.add(params, 'characterHeightCm', 3, 80, 0.5).name('身長 (cm)');
fChar.add(params, 'characterXMm', -200, 200, 1).name('左右 (mm)');
fChar.add(params, 'characterZMm', -700, 50, 1).name('奥行き (mm, 負=奥)');
fChar.add(params, 'characterRotDeg', -180, 180, 1).name('向き (°)');
if (!plyMode) {
  fChar.add(params, 'lookAtUser').name('こちらを見る');
  fChar
    .add(
      {
        clear: () => {
          character.clear();
          characterStatus = '';
        },
      },
      'clear',
    )
    .name('取り除く');
}

const fView = gui.addFolder('表示');
fView.addColor(params, 'deskColor').name('机の色');
fView.add(params, 'showGrid').name('グリッド');
fView.add(params, 'showVideo').name('カメラ映像');
fView.add(params, 'showHud').name('数値表示');

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'h' || e.key === 'H') gui.show(gui._hidden);
  if (e.key === 'f' || e.key === 'F') {
    // WKWebView 内ではネイティブのウィンドウをフルスクリーンにする
    const native = (window as any).webkit?.messageHandlers?.native;
    if (native) native.postMessage('toggleFullscreen');
    else if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }
});

// ---------- ループ ----------
const hud = document.getElementById('hud')!;
const eyeCam = new THREE.Vector3();
const eyeS = new THREE.Vector3();
const pa = new THREE.Vector3();
const pb = new THREE.Vector3();
const pc = new THREE.Vector3();
const pe = new THREE.Vector3();
const fallbackEyeS = new THREE.Vector3(0, 150, 550);
let lastNow = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  pollNative();

  // 目の位置 (画面座標 S, mm)
  if (params.source === 'camera' && tracker.predicted(now, eyeCam)) {
    eyeS.copy(cameraPosS(params)).add(eyeCam);
  } else if (params.source === 'mouse') {
    eyeS.set(mouse.x * 250, 150 + mouse.y * 200, 550);
  } else {
    eyeS.copy(fallbackEyeS);
  }

  // 画面と目を机座標 D へ
  const sf = screenFrame(params);
  const rect = viewportRectS(params);
  sToD(sf, rect.x0, rect.y0, 0, pa);
  sToD(sf, rect.x1, rect.y0, 0, pb);
  sToD(sf, rect.x0, rect.y1, 0, pc);
  sToD(sf, eyeS.x, eyeS.y, eyeS.z, pe);

  applyOffAxis(camera, pa, pb, pc, pe, 0.01, 20);
  const dt = Math.max(0, (now - lastNow) / 1000);
  lastNow = now;
  update();
  if (ply) ply.update(dt);
  else character.update(now / 1000, dt, pe);
  dropHint.style.display = (ply ? ply.hasData : character.loaded) ? 'none' : 'grid';
  renderer.render(scene, camera);

  videoEl.style.display = params.showVideo && params.source === 'camera' ? 'block' : 'none';
  hud.style.display = params.showHud ? 'block' : 'none';
  if (params.showHud) {
    const disp = displaySizeMm(params);
    hud.textContent = [
      `tracker  : ${tracker.status}  (${tracker.detectFps.toFixed(0)} fps)`,
      `eye (S)  : x ${eyeS.x.toFixed(0)}  y ${eyeS.y.toFixed(0)}  z ${eyeS.z.toFixed(0)} mm`,
      `eye (desk): x ${(pe.x * 1000).toFixed(0)}  h ${(pe.y * 1000).toFixed(0)}  z ${(pe.z * 1000).toFixed(0)} mm`,
      `lid      : ${params.lidAngle.toFixed(1)}°  [${lidSource}]`,
      `display  : ${disp.width.toFixed(1)} x ${disp.height.toFixed(1)} mm  [${displaySource}]`,
      ply
        ? `ply      : ${ply.status}  frame ${ply.shownIndex + 1}/${ply.frameCount} @${ply.fps}fps  buffered ${ply.buffered}  [${ply.sourceName || '-'}]`
        : `character: ${characterStatus || '-'}`,
      `viewport : x ${rect.x0.toFixed(0)}..${rect.x1.toFixed(0)}  y ${rect.y0.toFixed(0)}..${rect.y1.toFixed(0)} mm`,
    ].join('\n');
  }
}
requestAnimationFrame(frame);

// ラッパーに初期化完了を伝える (受け取ると現在の値をすべて送り直してくる)
(window as any).webkit?.messageHandlers?.native?.postMessage('ready');
