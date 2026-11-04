import * as THREE from 'three';
import type { Params } from './params';

// シーンはすべて机座標 D (m) で置く。y = 0 が現実の机の面。
// 画面はヒンジ付近 (z ≈ 0) に立っているので、画面の奥は z < 0。

function gridTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, size, size);
  g.strokeStyle = 'rgba(0,0,0,0.10)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(size / 2, 0);
  g.lineTo(size / 2, size);
  g.moveTo(0, size / 2);
  g.lineTo(size, size / 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function buildScene(p: Params) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#15161a');

  // --- 床 (現実の机の延長) ---
  const FLOOR_W = 1.6;
  const FLOOR_D = 1.2;
  const grid = gridTexture();
  grid.repeat.set(FLOOR_W / 0.1, FLOOR_D / 0.1); // 10cm マス (中線で 5cm)
  const floorMat = new THREE.MeshStandardMaterial({ color: p.deskColor, roughness: 0.85, map: grid });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_W, FLOOR_D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 0.1 - FLOOR_D / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // --- 照明 ---
  scene.add(new THREE.HemisphereLight('#ffffff', '#5a4a3a', 0.9));
  const sun = new THREE.DirectionalLight('#fff4e6', 2.2);
  sun.position.set(0.35, 0.9, 0.3);
  sun.target.position.set(0, 0, -0.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -0.7;
  sc.right = 0.7;
  sc.top = 0.7;
  sc.bottom = -0.7;
  sc.near = 0.1;
  sc.far = 3;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.002;
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);

  const update = () => {
    floorMat.color.set(p.deskColor);
    const map = p.showGrid ? grid : null;
    if (floorMat.map !== map) {
      floorMat.map = map;
      floorMat.needsUpdate = true; // map の有無が変わるとシェーダの再コンパイルが要る
    }
  };

  return { scene, update };
}
