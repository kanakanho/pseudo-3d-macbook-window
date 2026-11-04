// MediaPipe の顔検出モデルを public/models/ に取得する (すでにあれば何もしない)。
// build / dev の前に自動で実行され、ビルド結果とアプリにモデルが同梱される。
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'face_landmarker.task');

if (existsSync(out) && statSync(out).size > 0) {
  console.log(`model: ${out} (cached)`);
} else {
  console.log(`model: downloading ${URL_}`);
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, buf); // 途中で失敗したときに壊れたファイルを残さない
  renameSync(`${out}.tmp`, out);
  console.log(`model: saved ${out} (${(buf.length / 1e6).toFixed(1)} MB)`);
}
