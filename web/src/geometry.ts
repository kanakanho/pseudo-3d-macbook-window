import * as THREE from 'three';
import type { Params } from './params';

// 座標系
//
// 机座標 D (Three.js のワールド座標, 単位 m):
//   原点 = ヒンジ軸の真下にある机の面 (左右は画面中央)
//   +x = ユーザーから見て右, +y = 上 (重力の逆), +z = ユーザー側
//   仮想の床 = y = 0 の平面
//
// 画面座標 S (単位 mm):
//   原点 = 表示領域の下端中央
//   +x = 右, +y = 画面に沿って上, +z = 画面からユーザーへ向かう法線

const MM = 0.001;

export interface ScreenFrame {
  origin: THREE.Vector3; // 机座標 D での S の原点 (m)
  r: THREE.Vector3;
  u: THREE.Vector3;
  n: THREE.Vector3;
}

/** 蓋の角度から、画面座標 S が机座標 D のどこにあるかを求める。 */
export function screenFrame(p: Params): ScreenFrame {
  const th = THREE.MathUtils.degToRad(p.lidAngle);
  const r = new THREE.Vector3(1, 0, 0);
  // 蓋に沿った上向き: 90° で (0,1,0)、180° で (0,0,-1)
  const u = new THREE.Vector3(0, Math.sin(th), Math.cos(th));
  // 画面の法線 (ユーザー側): r × u
  const n = new THREE.Vector3(0, -Math.cos(th), Math.sin(th));
  const hinge = new THREE.Vector3(0, p.hingeHeightMm * MM, 0);
  const origin = hinge
    .clone()
    .addScaledVector(u, p.displayBottomFromHingeMm * MM)
    .addScaledVector(n, p.screenSurfaceOffsetMm * MM);
  return { origin, r, u, n };
}

/** 画面座標 S (mm) の点を机座標 D (m) に変換する。 */
export function sToD(f: ScreenFrame, x: number, y: number, z: number, out = new THREE.Vector3()) {
  return out
    .copy(f.origin)
    .addScaledVector(f.r, x * MM)
    .addScaledVector(f.u, y * MM)
    .addScaledVector(f.n, z * MM);
}

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** ネイティブ側から渡される、画面上のビューポート位置 (CSS px, 画面左上原点)。 */
let viewportOverride: { left: number; top: number; width: number; height: number } | null = null;
export function setViewportOverride(v: typeof viewportOverride) {
  viewportOverride = v;
}

/** 表示領域全体の物理サイズ (mm) と、CSS px → mm の換算係数 (横 kx, 縦 ky)。 */
export function displaySizeMm(p: Params) {
  const kx = p.displayWidthMm / screen.width;
  const height = p.displayHeightMm > 0 ? p.displayHeightMm : screen.height * kx;
  return { width: p.displayWidthMm, height, kx, ky: height / screen.height };
}

/**
 * ブラウザのビューポート (= 描画している canvas) が、物理的な画面のどこを占めているか。
 * 画面座標 S (mm) の矩形で返す。
 */
export function viewportRectS(p: Params): Rect {
  const { width: W, height: H, kx, ky } = displaySizeMm(p);
  let left: number, top: number, w: number, h: number;
  if (viewportOverride) {
    ({ left, top, width: w, height: h } = viewportOverride);
  } else {
    w = innerWidth;
    h = innerHeight;
    const chromeless = outerHeight - innerHeight < 2 && outerWidth - innerWidth < 2;
    if (chromeless && innerWidth >= screen.width - 1) {
      // フルスクリーン: ノッチの下、画面の下端に揃っている
      left = 0;
      top = screen.height - innerHeight;
    } else {
      // ウィンドウ表示: ツールバーは上側にだけあると仮定する
      left = screenX + (outerWidth - innerWidth) / 2;
      top = screenY + (outerHeight - innerHeight);
    }
  }
  const x0 = left * kx - W / 2;
  const y0 = H - (top + h) * ky;
  return { x0, x1: x0 + w * kx, y0, y1: y0 + h * ky };
}

/** カメラ (レンズ中心) の位置。画面座標 S (mm)。 */
export function cameraPosS(p: Params) {
  const { height: H } = displaySizeMm(p);
  return new THREE.Vector3(0, H - p.cameraFromTopMm, 0);
}

const _vr = new THREE.Vector3();
const _vu = new THREE.Vector3();
const _vn = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Kooima の一般化透視投影。
 * pa = 左下, pb = 右下, pc = 左上 (投影面の 3 隅), pe = 目。すべて机座標 D。
 * 投影面は物理的な画面に固定し、目からその四隅へ向かう非対称な視錐台を作る。
 */
export function applyOffAxis(
  camera: THREE.PerspectiveCamera,
  pa: THREE.Vector3,
  pb: THREE.Vector3,
  pc: THREE.Vector3,
  pe: THREE.Vector3,
  near: number,
  far: number,
): boolean {
  _vr.subVectors(pb, pa).normalize();
  _vu.subVectors(pc, pa).normalize();
  _vn.crossVectors(_vr, _vu).normalize();

  _va.subVectors(pa, pe);
  _vb.subVectors(pb, pe);
  _vc.subVectors(pc, pe);

  const d = -_va.dot(_vn); // 目から投影面までの距離
  if (d <= 1e-4) return false; // 目が画面の裏側にある

  const l = (_vr.dot(_va) * near) / d;
  const r = (_vr.dot(_vb) * near) / d;
  const b = (_vu.dot(_va) * near) / d;
  const t = (_vu.dot(_vc) * near) / d;

  camera.position.copy(pe);
  _m.makeBasis(_vr, _vu, _vn);
  camera.quaternion.setFromRotationMatrix(_m);
  camera.updateMatrixWorld(true);

  camera.near = near;
  camera.far = far;
  camera.projectionMatrix.makePerspective(l, r, t, b, near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return true;
}
