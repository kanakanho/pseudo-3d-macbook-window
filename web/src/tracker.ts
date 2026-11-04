import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { OneEuro } from './oneEuro';
import type { Params } from './params';

// ビルド時に scripts/fetch-model.mjs が public/models/ に取得したものを使う (オフラインでも動くように)
const MODEL_URL = `${import.meta.env.BASE_URL}models/face_landmarker.task`;

// 虹彩中心のランドマーク番号 (MediaPipe Face Mesh, 478 点モデル)
const IRIS_SUBJECT_RIGHT = 468;
const IRIS_SUBJECT_LEFT = 473;

/**
 * FaceTime カメラで目の位置を推定する。
 * 結果はカメラ中心を原点とし、軸を画面座標 S と揃えた座標 (mm) で返す。
 * (+x = ユーザーから見て右, +y = 上, +z = 画面からユーザー側)
 */
export class FaceTracker {
  readonly video = document.createElement('video');
  status = 'not started';
  detectFps = 0;
  /** 生の (フィルタ前の) 奥行き。距離キャリブレーション用。 */
  rawDepthMm = 0;

  private landmarker: FaceLandmarker | null = null;
  private filters = [new OneEuro(), new OneEuro(), new OneEuro()];
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private lastFrameTime = 0; // performance.now() ms
  private hasPose = false;
  private lastDetect = 0;

  constructor(private p: Params) {
    this.video.playsInline = true;
    this.video.muted = true;
  }

  async start() {
    this.status = 'loading model…';
    const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe-wasm`);
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
    });

    this.status = 'requesting camera…';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    this.status = 'tracking';
    this.scheduleNext();
  }

  private scheduleNext() {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this.onFrame());
    else requestAnimationFrame(() => this.onFrame());
  }

  private onFrame() {
    try {
      this.detect();
    } finally {
      this.scheduleNext();
    }
  }

  private detect() {
    if (!this.landmarker || this.video.readyState < 2) return;
    const now = performance.now();
    if (now <= this.lastDetect) return;
    const dtDetect = now - this.lastDetect;
    this.lastDetect = now;
    this.detectFps += (1000 / dtDetect - this.detectFps) * 0.1;

    const res = this.landmarker.detectForVideo(this.video, now);
    const lm = res.faceLandmarks[0];
    if (!lm || lm.length < 478) {
      this.status = 'face lost';
      return;
    }
    this.status = 'tracking';

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const a = lm[IRIS_SUBJECT_RIGHT];
    const b = lm[IRIS_SUBJECT_LEFT];

    // 両目の間の距離 (px)。z もランドマークに含まれるので、顔を横に向けても縮みにくい。
    const ipdPx = Math.hypot((a.x - b.x) * vw, (a.y - b.y) * vh, (a.z - b.z) * vw);
    const f = vw / 2 / Math.tan(THREE.MathUtils.degToRad(this.p.cameraHFovDeg) / 2);
    const rawZ = (f * this.p.ipdMm) / ipdPx;
    this.rawDepthMm = rawZ;
    const z = rawZ * this.p.depthScale;

    const eye = this.p.eye === 'left' ? b : this.p.eye === 'right' ? a : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const ux = eye.x * vw - vw / 2;
    const uy = eye.y * vh - vh / 2;
    // 生のカメラ映像は鏡像ではないので、ユーザーが右に動くと映像上では左へ動く
    const sx = this.p.mirrorX ? 1 : -1;
    const x = (sx * ux * z) / f;
    const y = (-uy * z) / f;

    const t = now / 1000;
    for (const fl of this.filters) {
      fl.minCutoff = this.p.minCutoff;
      fl.beta = this.p.beta;
    }
    this.pos.set(this.filters[0].filter(x, t), this.filters[1].filter(y, t), this.filters[2].filter(z, t));
    this.vel.set(this.filters[0].velocity, this.filters[1].velocity, this.filters[2].velocity);
    this.lastFrameTime = now;
    this.hasPose = true;
  }

  /** 描画時刻に合わせて外挿した目の位置 (カメラ基準, mm)。まだ顔が見つかっていなければ null。 */
  predicted(now: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    if (!this.hasPose) return null;
    const age = (now - this.lastFrameTime) / 1000;
    // 顔を見失って時間が経ったら外挿をやめて最後の位置で止める
    const ahead = age > 0.3 ? 0 : Math.min(age + this.p.predictionMs / 1000, 0.15);
    return out.copy(this.pos).addScaledVector(this.vel, ahead);
  }
}
