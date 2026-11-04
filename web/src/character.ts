import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { Params } from './params';

/**
 * 机の上に立つ VRM キャラクター。
 * root を机座標 D に置き、root のスケールでフィギュアくらいの大きさに縮める。
 */
export class Character {
  readonly root = new THREE.Group();
  name = '';

  private vrm: VRM | null = null;
  private naturalHeight = 1; // 等倍での身長 (m)
  private readonly loader = new GLTFLoader();
  private readonly lookTarget = new THREE.Object3D();
  private nextBlink = 2;
  private blinkStart = -1;
  private headYaw = 0;
  private headPitch = 0;
  private appliedScale = 0;
  /** VRM 0.x は正規化ボーンの座標系が y 軸まわりに 180° 回っているので、x と z の回転を反転する。 */
  private flip = 1;

  constructor(
    scene: THREE.Scene,
    private p: Params,
  ) {
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
    scene.add(this.root, this.lookTarget);
  }

  get loaded() {
    return this.vrm !== null;
  }

  async loadFile(file: File) {
    const url = URL.createObjectURL(file);
    try {
      const gltf = await this.loader.loadAsync(url);
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) throw new Error(`${file.name} は VRM ではありません`);

      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm); // VRM 0.x も +z (ユーザー側) を向くようにそろえる

      this.clear();
      vrm.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          m.frustumCulled = false; // 揺れものが視錐台の外に出て消えるのを防ぐ
        }
      });

      this.flip = vrm.meta?.metaVersion === '0' ? -1 : 1;
      this.applyRestPose(vrm, 0);
      vrm.update(0);
      vrm.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(vrm.scene);
      this.naturalHeight = Math.max(box.max.y - box.min.y, 0.01);
      vrm.scene.position.y = -box.min.y; // 足の裏を y = 0 (机の面) に合わせる

      if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

      this.root.add(vrm.scene);
      this.vrm = vrm;
      this.appliedScale = 0;
      const meta = vrm.meta as { name?: string; title?: string } | undefined;
      this.name = meta?.name || meta?.title || file.name;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  clear() {
    if (!this.vrm) return;
    this.root.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
    this.name = '';
  }

  /** T ポーズから腕を下ろした待機姿勢。t で呼吸などの小さな動きを付ける。 */
  /** 正規化ボーンの回転を、「キャラが +z を向き、左腕が +x に伸びる」座標系 (VRM 1.0) で指定する。 */
  private setBone(vrm: VRM, name: Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0], x: number, y: number, z: number) {
    vrm.humanoid.getNormalizedBoneNode(name)?.rotation.set(x * this.flip, y, z * this.flip);
  }

  private applyRestPose(vrm: VRM, t: number) {
    const breath = Math.sin(t * 1.7);
    const sway = Math.sin(t * 0.6);
    this.setBone(vrm, 'leftUpperArm', 0, 0, -1.15 + breath * 0.02);
    this.setBone(vrm, 'rightUpperArm', 0, 0, 1.15 - breath * 0.02);
    this.setBone(vrm, 'leftLowerArm', 0, -0.25, 0);
    this.setBone(vrm, 'rightLowerArm', 0, 0.25, 0);
    this.setBone(vrm, 'spine', breath * 0.015, 0, sway * 0.015);
    this.setBone(vrm, 'chest', breath * 0.015, 0, 0);
  }

  /** 顔をユーザーの目の方へ向ける (首と頭で分担)。 */
  private applyHeadLook(vrm: VRM, dt: number) {
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    let yaw = 0;
    let pitch = 0;
    if (this.p.lookAtUser && head) {
      // root の座標系ではキャラは常に +z を向いている (VRM 0.x の 180° 回転は vrm.scene 側にある)
      const headPos = this.root.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
      const target = this.root.worldToLocal(this.lookTarget.position.clone());
      const d = target.sub(headPos);
      yaw = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -0.9, 0.9);
      pitch = THREE.MathUtils.clamp(-Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.6, 0.4);
    }
    // 急に首が回らないように追従を遅らせる
    const k = 1 - Math.exp(-dt * 6);
    this.headYaw += (yaw - this.headYaw) * k;
    this.headPitch += (pitch - this.headPitch) * k;
    this.setBone(vrm, 'neck', this.headPitch * 0.4, this.headYaw * 0.4, 0);
    this.setBone(vrm, 'head', this.headPitch * 0.6, this.headYaw * 0.6, 0);
  }

  private applyBlink(vrm: VRM, t: number) {
    const em = vrm.expressionManager;
    if (!em) return;
    if (this.blinkStart < 0 && t > this.nextBlink) this.blinkStart = t;
    let v = 0;
    if (this.blinkStart >= 0) {
      const u = (t - this.blinkStart) / 0.15; // 0.15 秒で閉じて開く
      if (u >= 1) {
        this.blinkStart = -1;
        this.nextBlink = t + 2 + Math.random() * 4;
      } else v = Math.sin(u * Math.PI);
    }
    em.setValue('blink', v);
  }

  /**
   * @param t 秒
   * @param dt 前フレームからの秒数
   * @param eyeWorld ユーザーの目の位置 (机座標 D)
   */
  update(t: number, dt: number, eyeWorld: THREE.Vector3) {
    const vrm = this.vrm;
    if (!vrm) return;

    const MM = 0.001;
    this.root.position.set(this.p.characterXMm * MM, 0, this.p.characterZMm * MM);
    this.root.rotation.y = THREE.MathUtils.degToRad(this.p.characterRotDeg);
    const scale = (this.p.characterHeightCm / 100) / this.naturalHeight;
    if (scale !== this.appliedScale) {
      this.root.scale.setScalar(scale);
      this.root.updateMatrixWorld(true);
      vrm.springBoneManager?.reset(); // 大きさが変わったら揺れものを初期状態に戻す
      this.appliedScale = scale;
    }

    this.lookTarget.position.copy(eyeWorld);
    this.applyRestPose(vrm, t);
    this.applyHeadLook(vrm, dt);
    this.applyBlink(vrm, t);
    vrm.update(Math.min(dt, 0.05));
  }
}
