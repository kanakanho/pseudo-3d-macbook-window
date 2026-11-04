// PLY (binary_little_endian) を取得して、位置と色の配列に変換するワーカー。
// 1 フレーム約 20MB / 75 万点あるので、メインスレッド (トラッキングと描画) を止めないようにここで処理する。

export interface PlyRequest {
  id: number;
  /** サーバーから取得する */
  url?: string;
  /** ドロップされたファイルを読む (ディスク上のファイルを必要なときに読むだけで、コピーはしない) */
  file?: File;
}

export interface PlyResult {
  id: number;
  count: number;
  positions?: Float32Array; // xyz
  colors?: Uint8Array; // rgb
  error?: string;
}

const TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

function parse(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const marker = 'end_header';
  // ヘッダーは先頭数百バイトなので、先頭だけ文字列にして探す
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const markerAt = head.indexOf(marker);
  if (markerAt < 0) throw new Error('PLY header end not found');
  const headerEnd = head.indexOf('\n', markerAt) + 1;
  const lines = head.slice(0, headerEnd).split(/\r?\n/);
  if (!lines.some((l) => l.startsWith('format binary_little_endian'))) {
    throw new Error('binary_little_endian の PLY だけに対応しています');
  }

  let count = 0;
  let inVertex = false;
  let stride = 0;
  const offsets: Record<string, { offset: number; type: string }> = {};
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'element') {
      inVertex = p[1] === 'vertex';
      if (inVertex) count = Number(p[2]);
    } else if (p[0] === 'property' && inVertex) {
      if (p[1] === 'list') throw new Error('vertex の list プロパティには対応していません');
      offsets[p[2]] = { offset: stride, type: p[1] };
      stride += TYPE_SIZE[p[1]] ?? 0;
    }
  }
  for (const k of ['x', 'y', 'z']) {
    if (offsets[k]?.type !== 'float' && offsets[k]?.type !== 'float32') throw new Error(`${k} が float ではありません`);
  }

  const view = new DataView(buffer, headerEnd);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const ox = offsets.x.offset;
  const oy = offsets.y.offset;
  const oz = offsets.z.offset;
  const cr = offsets.red ?? offsets.r;
  const cg = offsets.green ?? offsets.g;
  const cb = offsets.blue ?? offsets.b;
  const hasColor = cr?.type.includes('char') && cg?.type.includes('char') && cb?.type.includes('char');

  for (let i = 0, o = 0; i < count; i++, o += stride) {
    const j = i * 3;
    positions[j] = view.getFloat32(o + ox, true);
    positions[j + 1] = view.getFloat32(o + oy, true);
    positions[j + 2] = view.getFloat32(o + oz, true);
    if (hasColor) {
      colors[j] = view.getUint8(o + cr.offset);
      colors[j + 1] = view.getUint8(o + cg.offset);
      colors[j + 2] = view.getUint8(o + cb.offset);
    } else {
      colors[j] = colors[j + 1] = colors[j + 2] = 255;
    }
  }
  return { count, positions, colors };
}

self.onmessage = async (e: MessageEvent<PlyRequest>) => {
  const { id, url, file } = e.data;
  try {
    let buffer: ArrayBuffer;
    if (file) {
      buffer = await file.arrayBuffer();
    } else {
      const res = await fetch(url!);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      buffer = await res.arrayBuffer();
    }
    const { count, positions, colors } = parse(buffer);
    const msg: PlyResult = { id, count, positions, colors };
    (self as unknown as Worker).postMessage(msg, [positions.buffer, colors.buffer]);
  } catch (err) {
    const msg: PlyResult = { id, count: 0, error: String((err as Error)?.message ?? err) };
    (self as unknown as Worker).postMessage(msg);
  }
};
