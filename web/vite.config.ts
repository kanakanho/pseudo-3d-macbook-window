import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';

// PLY の連番データは元モデルの規約上配布できるか確認できていないので、リポジトリにもビルド結果にも含めない (README 参照)。
// 手元の web/ply-data/ (git 管理外) を、開発・プレビューサーバーから /ply-data/ として配信する。
// フォルダの場所は環境変数 PLY_DIR で変えられる。
const PLY_DIR = resolve(process.env.PLY_DIR ?? resolve(__dirname, 'ply-data'));
const PREFIX = '/ply-data/';
const FPS = 15;

/** frame_*.ply の一覧。データフォルダに index.json を置かなくて済むようにその場で作る。 */
function frameIndex() {
  const frames = readdirSync(PLY_DIR)
    .filter((n) => /\.ply$/i.test(n))
    .sort();
  return JSON.stringify({ fps: FPS, frames });
}

const servePlyData: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url?.split('?')[0] ?? '';
  if (!url.startsWith(PREFIX)) return next();
  if (url === `${PREFIX}index.json`) {
    try {
      const body = frameIndex();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      return res.end(body);
    } catch {
      res.statusCode = 404; // フォルダがない
      return res.end();
    }
  }
  const file = normalize(join(PLY_DIR, decodeURIComponent(url.slice(PREFIX.length))));
  if (!file.startsWith(PLY_DIR + sep)) {
    res.statusCode = 403; // ディレクトリの外は見せない
    return res.end();
  }
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return next();
    size = st.size;
  } catch {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(file).pipe(res);
};

const plyData = (): Plugin => ({
  name: 'serve-ply-data',
  configureServer: (server) => void server.middlewares.use(servePlyData),
  configurePreviewServer: (server) => void server.middlewares.use(servePlyData),
});

export default defineConfig({
  plugins: [plyData()],
});
