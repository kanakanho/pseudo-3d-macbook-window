// ビルド結果 (dist/) に同梱するサードパーティのライセンス表記を作る。
// package.json の dependencies を再帰的にたどり、各パッケージの LICENSE を集める。
// MIT / Apache-2.0 とも、再配布時に著作権表示とライセンス本文を含める必要があるため。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'dist', 'THIRD_PARTY_LICENSES.txt');

// npm パッケージに LICENSE が入っていないものの補足
const APACHE_2_TEXT = readFileSync(join(nm, 'typescript', 'LICENSE'), 'utf8'); // 標準の Apache License 2.0 全文
const MISSING = {
  '@mediapipe/tasks-vision': {
    note: 'Copyright The MediaPipe Authors. https://github.com/google-ai-edge/mediapipe',
    text: APACHE_2_TEXT,
  },
};

function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return f ? readFileSync(join(dir, f), 'utf8').trim() : null;
}

const seen = new Map();
function visit(name) {
  if (seen.has(name)) return;
  const dir = join(nm, name);
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`not installed: ${name}`);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const missing = MISSING[name];
  const text = licenseText(dir) ?? missing?.text;
  if (!text) throw new Error(`LICENSE が見つかりません: ${name} (${pkg.license})。MISSING に追記してください`);
  seen.set(name, { version: pkg.version, license: pkg.license, note: missing?.note, text });
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep);
}

const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const dep of Object.keys(app.dependencies ?? {})) visit(dep);

const sections = [...seen.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, p]) =>
    [`${name}@${p.version}  (${p.license})`, p.note, '', p.text].filter((x) => x !== undefined).join('\n'),
  );

// ビルド時に取得して同梱する MediaPipe の顔検出モデル
sections.push(
  [
    'MediaPipe Face Landmarker model (face_landmarker.task)  (Apache-2.0)',
    'Copyright Google LLC. Bundled components and their model cards (each "Licensed under Apache License, Version 2.0"):',
    '  - BlazeFace (Short Range): https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf',
    '  - Face Mesh V2: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf',
    '  - Blendshape V2: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf',
    'License text: see the Apache License 2.0 in the @mediapipe/tasks-vision section above.',
  ].join('\n'),
);

const header =
  'This application includes the following third-party software and models.\n' +
  'このアプリケーションには、以下のサードパーティのソフトウェアとモデルが含まれています。\n';
writeFileSync(out, header + '\n' + sections.join(`\n\n${'='.repeat(78)}\n\n`) + '\n');
console.log(`licenses: wrote ${out} (${seen.size} packages + 1 model)`);
