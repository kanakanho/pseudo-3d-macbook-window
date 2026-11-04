// 全パラメータ。長さの単位は mm。
// 初期値は MacBook Pro 16" (2021) 用。
//   パネル 3456 x 2234 px @ 254 ppi (= 10 px/mm) → 345.6 x 223.4 mm
export const params = {
  // --- 蓋 ---
  /** 蓋の開き角 (度)。90 = 鉛直、大きいほど後ろに倒れる。 */
  lidAngle: 110,

  // --- 本体の寸法 ---
  /** 表示領域の物理的な横幅。Mac アプリからは OS の値 (?displayW=) が渡される。 */
  displayWidthMm: 345.6,
  /** 表示領域の物理的な高さ。0 なら横幅と screen の縦横比から求める。 */
  displayHeightMm: 0,
  /** カメラ中心が表示領域の上端から何 mm 下にあるか (ノッチの中)。 */
  cameraFromTopMm: 4,
  /** 机の面からヒンジ軸までの高さ。 */
  hingeHeightMm: 9,
  /** 蓋に沿って測った、ヒンジ軸から表示領域の下端までの距離。 */
  displayBottomFromHingeMm: 22,
  /** ヒンジ軸から画面の表面までの、画面に垂直な方向の距離。 */
  screenSurfaceOffsetMm: 4,

  // --- トラッキング ---
  source: 'camera' as 'camera' | 'mouse',
  /** FaceTime カメラの水平画角 (度)。 */
  cameraHFovDeg: 70,
  /** 瞳孔間距離。 */
  ipdMm: 63,
  /** 奥行きの補正係数 (距離キャリブレーションで設定)。 */
  depthScale: 1,
  /** どちらの目から見た映像にするか。 */
  eye: 'center' as 'center' | 'left' | 'right',
  /** カメラ映像の左右が逆に処理される環境向け。 */
  mirrorX: false,
  /** One Euro Filter: 静止時のカットオフ周波数 (Hz)。小さいほどブレが減り遅れが増える。 */
  minCutoff: 0.8,
  /** One Euro Filter: 速度に応じてカットオフを上げる係数。 */
  beta: 0.01,
  /** 遅延補償として何 ms 先の位置を予測するか。 */
  predictionMs: 40,
  /** 距離キャリブレーションで使う、画面から目までの実測距離。 */
  calibDistanceMm: 500,

  // --- キャラクター (VRM) ---
  /** 机の上での身長。 */
  characterHeightCm: 10,
  /** 画面中央からの左右位置。 */
  characterXMm: 0,
  /** 奥行き位置 (負 = 画面の奥)。 */
  characterZMm: -150,
  /** 向き (0 = ユーザーの方を向く)。 */
  characterRotDeg: 0,
  /** 顔をユーザーの目の方へ向ける。 */
  lookAtUser: true,

  // --- PLY アニメーション (/ply) ---
  /** 点の大きさ (px)。 */
  plyPointSize: 1.5,
  plyPlaying: true,

  // --- 表示 ---
  deskColor: '#b48a60',
  showGrid: true,
  showVideo: true,
  showHud: true,
};

export type Params = typeof params;
