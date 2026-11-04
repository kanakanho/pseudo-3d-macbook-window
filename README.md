# pseudo-3d-macbook-window

MacBook Pro の画面を「机の奥へ続く窓」に見せる、頭部追従型の擬似 3D 表示。

- FaceTime カメラ + MediaPipe Face Landmarker で目の 3D 位置を推定
- 机を基準にした座標系で、画面を投影面とする off-axis 投影 (Kooima の一般化透視投影)
- 仮想の床 = 現実の机の面 (y = 0)。蓋の角度で画面の傾きを補正する

## 起動

```bash
cd web && npm install && npm run dev
```

Chrome か Safari で http://localhost:5173 を開き、カメラを許可して **F でフルスクリーン**にする。
H で設定パネルの表示を切り替える。

## キャラクター (VRM)

`.vrm` ファイルをウィンドウにドラッグ & ドロップすると、机の上に立つキャラクターとして表示される
(設定パネルの「VRM を開く…」からも選べる)。

- 大きさはフィギュアくらい (初期値は身長 10cm)。身長・位置・向きは設定パネルで変えられる
- 腕を下ろした待機姿勢で、呼吸とまばたきをする
- 「こちらを見る」が有効なら、首と目がトラッキングしたユーザーの目の位置を追う
- VRM 0.x / 1.0 の両方に対応 (0.x は向きと正規化ボーンの座標系の違いを補正している)

## PLY アニメーション (/ply)

http://localhost:5173/ply を開くと、連番 PLY の点群アニメーションが机の上でループ再生される。
データは `wgsl-ply-viewer` の `public/ply/` からコピーしたもの (450 フレーム, 15fps, 1 フレーム約 20MB / 75 万点)。

- **PLY のフォルダをウィンドウにドラッグ & ドロップすると、その中の `*.ply` を名前順に再生する** (サブフォルダも含む。
  `.ply` ファイルをまとめてドロップしてもよい)。ファイルはディスクから必要な分だけ読み、コピーはしない。
  ブラウザの制約でフォルダの場所は記憶できないので、次回もドロップが必要
- 毎回ドロップしたくない場合は、サーバー側のフォルダを使う (ドロップするとそちらより優先される):
  - Mac アプリ: View → 「PLY フォルダを選択…」(⌘O)。次回以降も記憶される
  - 開発時: 手元の `web/ply-data/` (または環境変数 `PLY_DIR` で指定したフォルダ) を、
  Vite のプラグイン ([vite.config.ts](web/vite.config.ts)) が `/ply-data/` として配信する
- フレームの一覧 (`/ply-data/index.json`) はサーバーがフォルダ内の `*.ply` からその場で作る。データフォルダには何も足さない
- 取得と解析は Web Worker (3 本) で行い、8 フレーム先まで先読みする。間に合わないときはフレームを飛ばして時刻に合わせる
- 大きさ・位置・向き・点の大きさ・一時停止は設定パネルの「PLY アニメーション」で変えられる
- Mac アプリでは View メニューの「PLY アニメーション」(⌘2) で切り替える

## 合わせ込みの手順

1. 蓋の開き角をスライダーで実際の角度に合わせる (分度器アプリなどで測る)
2. 画面から目までの距離を定規で測って「実測距離」に入れ、「今の距離 = 実測距離 として補正」を押す
3. 頭を左右に動かし、奥の物体が「泳ぐ」なら瞳孔間距離を調整する
   (左右の推定量は瞳孔間距離に比例する。カメラ画角は奥行きにしか効かず、手順 2 の補正で吸収される)
4. MacBook の左右に見えている現実の机と、画面の中の床のグリッドがつながって見えるように
   「本体の寸法」のヒンジ関連の値を調整する

片目を閉じて見るか、スマホのカメラ越しに見ると立体感がよくわかる。

## Mac アプリ (蓋の角度センサー付き)

`mac/` は Web 版を WKWebView で表示する薄いラッパー。蓋の角度センサーを読んで Web 側に流し込む。
ビルドした Web 版 (`web/dist`、顔検出モデルとライセンス表記を含む) を `.app` に同梱するので、開発サーバーなしで起動できる。
PLY データは同梱しない (元モデルの規約上、配布できるか確認できていないため。詳しくは「PLY アニメーション」の節)。

```bash
./mac/build.sh && open mac/build/Pseudo3DWindow.app
```

- `build.sh` は `web` のビルド → Swift のビルド → `.app` へのまとめ → 署名を行う
  - `web/dist` → `Contents/Resources/web`
  - `web` のビルドでは、顔検出モデルの取得 (`scripts/fetch-model.mjs`、初回のみ) と
    ライセンス表記 `THIRD_PARTY_LICENSES.txt` の生成 (`scripts/collect-licenses.mjs`) も行う
- アプリは `127.0.0.1` の空いているポートで内蔵 HTTP サーバーを立て、そこから同梱版を開く
  (独自 URL スキームではカメラが使えないため。外部からは接続できない)
- 初回はカメラの許可ダイアログが出る
- View メニュー: ⌘1 で VRM、⌘2 で PLY アニメーション、⌘O で PLY フォルダを選択 (次回以降も記憶)、
  ⌘R で再読み込み、⌃⌘F (または F キー) でフルスクリーン
- Help メニュー: サードパーティのライセンス
- 起動オプション (`open mac/build/Pseudo3DWindow.app --args ...`。アプリが起動中だと無視される)
  - `--path /ply`: 最初に PLY アニメーションを開く
  - `--dev`: 同梱版ではなく Vite の開発サーバー (`cd web && npm run dev`) を開く。Web 側を編集しながら確認するとき用
  - `--url <url>`: 任意の URL を開く
  - `--ply-dir <フォルダ>`: PLY の読み込み元 (メニューで選んだものより優先)
- 起動ログを見るには `open --stdout <ファイル> --stderr <ファイル> mac/build/Pseudo3DWindow.app`
- 顔検出モデルも同梱しているので、オフラインでも動く
- MediaPipe が 60 秒ごとに Google (`odml.pa.googleapis.com`) へ送る利用統計 (タスクの種類、処理時間、実行回数、
  OS の種類など。映像や検出結果は含まない) は、WKWebView のコンテンツブロック (`WKContentRuleList`) で遮断している。
  MediaPipe は送信に失敗すると以後の送信をやめる。ブラウザで開いた場合 (`--dev` を含まない通常のブラウザ) は遮断されない

蓋の角度センサーは非公式の HID デバイス (VID 0x05AC / PID 0x8104) で、値は 1° 刻みの整数。
MacBookPro18,2 (16" 2021) で読めることを確認済み。読めない機種では Web 側のスライダーを使う。

### ネイティブと Web の受け渡し

| 方向 | 方法 | 内容 |
|---|---|---|
| ネイティブ → Web | `?lid=112` | 起動時の蓋の角度 |
| ネイティブ → Web | `?displayW=344.70&displayH=222.82` | 起動時の画面の物理サイズ (mm, `CGDisplayScreenSize` の値) |
| ネイティブ → Web | `window.__native.display` | 画面の物理サイズ `{widthMm, heightMm}`。ウィンドウが別の画面に移ったときに更新される |
| ネイティブ → Web | `window.__native.lidAngle` | 蓋の角度。Web 側が毎フレーム読む |
| ネイティブ → Web | `window.__native.viewport` | WKWebView の画面上の位置 `{left, top, width, height}` (pt, 画面左上原点) |
| Web → ネイティブ | `messageHandlers.native.postMessage('ready')` | Web の初期化完了。ネイティブは全部の値を送り直す |
| Web → ネイティブ | `postMessage('toggleFullscreen')` | ウィンドウのフルスクリーン切り替え |

関数呼び出しではなく値を置く方式にしているのは、ページ読み込み直後に Web のモジュールがまだ実行されていなくても値が失われないようにするため。
ブラウザのコンソールでは `setLidAngle(deg)` / `setViewportRect(rect)` でも同じ値を設定できる。

## 座標系

- 机座標 D (m): 原点はヒンジ軸の真下の机の面。+x 右、+y 上、+z ユーザー側
- 画面座標 S (mm): 原点は表示領域の下端中央。+y は画面に沿って上、+z は画面の法線

実装は [web/src/geometry.ts](web/src/geometry.ts) を参照。

## リリース (GitHub Actions)

[.github/workflows/release.yml](.github/workflows/release.yml) が Mac アプリをビルドして GitHub Release に置く。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

- `v*` のタグを push すると、macOS ランナーで `mac/build.sh` を実行し (`VERSION` はタグから、`UNIVERSAL=1`)、
  `Pseudo3DWindow-<version>-macOS.zip` を添付したリリースを作る
- Actions 画面から手動実行すると、リリースは作らず zip を成果物 (artifact) として残す
- アプリは Apple Silicon / Intel 両対応の Universal バイナリ。署名は ad-hoc で、Apple の公証は受けていない。
  そのためダウンロードしたアプリは初回にブロックされる (リリースノートに解除方法を書いている)。
  一般に配布するなら Developer ID での署名と公証が必要
- `build.sh` は `.app` に `.ply` が含まれていたら失敗する

## ライセンス

アプリに同梱しているサードパーティのソフトウェアとモデルは、すべて MIT か Apache-2.0。
ビルド時に `web/dist/THIRD_PARTY_LICENSES.txt` に著作権表示とライセンス本文をまとめ、アプリにも同梱する
(Help → サードパーティのライセンス)。

| 対象 | ライセンス | 備考 |
|---|---|---|
| three.js | MIT | GLTFLoader (examples/jsm) を含む |
| @pixiv/three-vrm とその構成パッケージ | MIT | |
| lil-gui | MIT | |
| @mediapipe/tasks-vision (JS と WASM) | Apache-2.0 | npm パッケージに LICENSE が入っていないので、Apache 2.0 の全文を補っている |
| MediaPipe Face Landmarker モデル | Apache-2.0 | 構成モデル (BlazeFace / Face Mesh V2 / Blendshape V2) のモデルカードに記載 |
| vite, typescript, @types/three | MIT / Apache-2.0 | 開発時のみ。アプリには含まれない |
