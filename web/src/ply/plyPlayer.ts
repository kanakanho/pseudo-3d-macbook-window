import * as THREE from 'three';
import type { Params } from '../params';
import type { PlyRequest, PlyResult } from './plyWorker';

interface Frame {
  count: number;
  positions: Float32Array;
  colors: Uint8Array;
}

const BASE = '/ply-data/';
const PREFETCH = 8; // 何フレーム先まで読んでおくか
const WORKERS = 3;

/** ファイル名の数字部分を数として比べる (frame_2 < frame_10) */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * 連番 PLY を点群としてループ再生する。
 * フレームの読み込み元は 2 通り: サーバーの /ply-data/ (Mac アプリで選んだフォルダや開発時の web/ply-data)、
 * またはドロップされたフォルダのファイル (loadFiles)。
 * 時刻から表示すべきフレームを決め、読み込みが間に合わなければ直前のフレームを表示し続ける。
 * root を机座標 D に置き、root のスケールで机の上のフィギュアくらいの大きさに縮める。
 */
export class PlyPlayer {
  readonly root = new THREE.Group();
  status = 'loading index…';
  /** どこから読んでいるか (HUD 表示用) */
  sourceName = '';
  frameCount = 0;
  fps = 15;
  shownIndex = -1;

  /** フレームごとの読み込み元。URL (サーバー) か File (ドロップ) */
  private sources: (string | File)[] = [];
  /** 読み込み元を差し替えたら増やし、古い読み込み結果を捨てる */
  private generation = 0;
  private geometry = new THREE.BufferGeometry();
  private capacity = 0;
  private readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly offset = new THREE.Group(); // 足元を原点に合わせる
  private naturalHeight = 1;
  private calibrated = false;

  private readonly cache = new Map<number, Frame>();
  private readonly pending = new Set<number>(); // ワーカーに投げたもの
  private readonly queue: number[] = [];
  private readonly idle: Worker[] = [];
  private nextId = 0;
  private readonly requests = new Map<number, { gen: number; index: number }>();
  private playhead = 0; // 秒
  private retryAt = 0; // 読み込みに失敗したら少し待ってから再試行する (performance.now() ms)
  private appliedScale = 0;

  constructor(
    scene: THREE.Scene,
    private p: Params,
  ) {
    // PLY の色は撮影時の sRGB の値なので、色空間変換やトーンマッピングをせずにそのまま出す
    this.material = new THREE.ShaderMaterial({
      uniforms: { size: { value: p.plyPointSize } },
      vertexShader: /* glsl */ `
        uniform float size;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }`,
      toneMapped: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.castShadow = true;
    this.offset.add(this.points);
    this.root.add(this.offset);
    scene.add(this.root);

    for (let i = 0; i < WORKERS; i++) {
      const w = new Worker(new URL('./plyWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<PlyResult>) => this.onResult(w, e.data);
      this.idle.push(w);
    }
  }

  get hasData() {
    return this.frameCount > 0;
  }

  /** サーバーにフォルダが設定されていればそれを使う。なければドロップを待つ。 */
  async start() {
    const res = await fetch(`${BASE}index.json`);
    if (res.status === 404) {
      // PLY は元モデルの規約上配布できるか確認できていないので同梱していない (README 参照)。フォルダをドロップしてもらう
      if (!this.hasData) this.status = 'PLY のフォルダをドロップしてください';
      return;
    }
    if (!res.ok) throw new Error(`${BASE}index.json の取得に失敗しました (HTTP ${res.status})`);
    const index = (await res.json()) as { fps?: number; frames: string[] };
    if (this.hasData) return; // 先にドロップされていればそちらを優先
    this.setSources(index.frames.sort(byName).map((f) => BASE + f), 'server');
    if (index.fps) this.fps = index.fps;
  }

  /** ドロップされたファイルから再生する (.ply 以外は無視)。 */
  loadFiles(files: File[], name: string) {
    const plys = files.filter((f) => /\.ply$/i.test(f.name)).sort((a, b) => byName(a.name, b.name));
    if (!plys.length) throw new Error('.ply ファイルが見つかりません');
    this.setSources(plys, name);
  }

  private setSources(sources: (string | File)[], name: string) {
    this.generation++;
    this.sources = sources;
    this.frameCount = sources.length;
    this.sourceName = name;
    this.cache.clear();
    this.pending.clear();
    this.queue.length = 0;
    this.playhead = 0;
    this.shownIndex = -1;
    this.calibrated = false;
    this.appliedScale = 0;
    this.retryAt = 0;
    this.geometry.setDrawRange(0, 0);
    this.status = 'buffering…';
  }

  private onResult(w: Worker, r: PlyResult) {
    this.idle.push(w);
    const req = this.requests.get(r.id)!;
    this.requests.delete(r.id);
    if (req.gen !== this.generation) return this.pump(); // 差し替え前の読み込み結果
    const index = req.index;
    this.pending.delete(index);
    if (r.error || !r.positions || !r.colors) {
      console.error(r.error);
      this.status = `error: ${r.error}`;
      this.retryAt = performance.now() + 1000;
    } else if (this.inWindow(index)) {
      this.cache.set(index, { count: r.count, positions: r.positions, colors: r.colors });
    }
    this.pump();
  }

  /** 今の再生位置から先読み範囲に入っているか */
  private inWindow(index: number) {
    const cur = this.currentIndex();
    const d = (index - cur + this.frameCount) % this.frameCount;
    return d <= PREFETCH;
  }

  private currentIndex() {
    return Math.floor(this.playhead * this.fps) % this.frameCount;
  }

  private request(index: number) {
    if (this.cache.has(index) || this.pending.has(index) || this.queue.includes(index)) return;
    this.queue.push(index);
  }

  private pump() {
    if (performance.now() < this.retryAt) return;
    while (this.idle.length && this.queue.length) {
      const index = this.queue.shift()!;
      if (!this.inWindow(index) || this.cache.has(index)) continue; // 古くなった要求は捨てる
      const w = this.idle.pop()!;
      const id = this.nextId++;
      this.requests.set(id, { gen: this.generation, index });
      this.pending.add(index);
      const src = this.sources[index];
      const msg: PlyRequest = typeof src === 'string' ? { id, url: src } : { id, file: src };
      w.postMessage(msg);
    }
  }

  private show(index: number, f: Frame) {
    if (f.count > this.capacity) {
      // 容量が足りなければ余裕を持って作り直す (GPU バッファを毎フレーム作らないように固定長で使い回す)
      this.capacity = Math.ceil(f.count * 1.25);
      this.geometry.dispose();
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3));
      this.geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.capacity * 3), 3, true));
      this.points.geometry = this.geometry;
    }
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    (pos.array as Float32Array).set(f.positions);
    (col.array as Uint8Array).set(f.colors);
    for (const a of [pos, col]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, f.count * 3);
      a.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, f.count);
    this.shownIndex = index;

    if (!this.calibrated) {
      // 最初のフレームで足元の高さと身長を決め、以降は固定する (フレームごとに揺れないように)
      const ys: number[] = [];
      const step = Math.max(1, Math.floor(f.count / 20000));
      for (let i = 0; i < f.count; i += step) ys.push(f.positions[i * 3 + 1]);
      ys.sort((a, b) => a - b);
      const lo = ys[Math.floor(ys.length * 0.001)];
      const hi = ys[Math.floor(ys.length * 0.999)];
      this.offset.position.y = -lo;
      this.naturalHeight = Math.max(hi - lo, 0.01);
      this.calibrated = true;
    }
  }

  update(dt: number) {
    if (!this.frameCount) return;
    const MM = 0.001;
    this.root.position.set(this.p.characterXMm * MM, 0, this.p.characterZMm * MM);
    this.root.rotation.y = THREE.MathUtils.degToRad(this.p.characterRotDeg);
    const scale = this.p.characterHeightCm / 100 / this.naturalHeight;
    if (scale !== this.appliedScale) {
      this.root.scale.setScalar(scale);
      this.appliedScale = scale;
    }
    this.material.uniforms.size.value = this.p.plyPointSize * devicePixelRatio;

    const desired = this.currentIndex();
    const ready = this.cache.get(desired);
    if (ready && desired !== this.shownIndex) this.show(desired, ready);

    // 最初のフレームが出るまでは時間を進めない。その後は読み込みが遅れたらフレームを飛ばす。
    if (this.p.plyPlaying && this.shownIndex >= 0) this.playhead += dt;

    // 先読み範囲の外を捨て、範囲内を要求する
    for (const k of this.cache.keys()) if (!this.inWindow(k)) this.cache.delete(k);
    const cur = this.currentIndex();
    for (let d = 0; d <= PREFETCH; d++) this.request((cur + d) % this.frameCount);
    this.pump();

    if (!this.status.startsWith('error') || (ready && performance.now() >= this.retryAt)) {
      this.status = this.shownIndex < 0 ? 'buffering…' : this.p.plyPlaying ? 'playing' : 'paused';
    }
  }

  get buffered() {
    return this.cache.size;
  }
}
