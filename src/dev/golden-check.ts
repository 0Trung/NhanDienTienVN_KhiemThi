import { DEFAULT_CONFIG } from '../config/app-config';
import type { Detection, GoldenBox, GoldenFixture, GoldenFixtures, IInferenceClient } from '../contracts';
import { iou } from '../utils/geometry';
import { setLogLevel } from '../utils/logger';
import { createSolidFrameSource, runBenchmark } from '../vision/benchmark';
import type { Stats } from '../vision/benchmark';
import { createInferenceClient } from '../vision/inference-client';

/**
 * Trang kiểm tra vàng, CHỈ dành cho dev (golden-check.html, không vào bản build APK).
 * Chạy client.infer THẬT trên ảnh trong public/golden/ rồi so với golden_fixtures.json của P01.
 * Thêm ?bench=30 (và &res=1280x720) để chạy benchmark sau phần kiểm tra.
 */

/** Dung sai theo đề bài P05 (không dùng `tolerance` gợi ý trong golden_fixtures.json). */
const MAX_CONF_DIFF = 0.02;
const MIN_IOU = 0.95;

export interface GoldenVerdict { pass: boolean; maxConfDiff: number; minIou: number; note: string }

/** So kết quả thật với hộp vàng: cùng số hộp, cùng lớp, lệch confidence ≤ 0,02 và IoU ≥ 0,95 (cả hai bên đã sắp trái → phải). */
export function compareToGolden(actual: readonly Detection[], expected: readonly GoldenBox[]): GoldenVerdict {
  if (actual.length !== expected.length) {
    return { pass: false, maxConfDiff: NaN, minIou: NaN, note: `số hộp ${actual.length} ≠ ${expected.length}` };
  }
  let maxConfDiff = 0;
  let minIou = 1;
  const problems: string[] = [];
  expected.forEach((box, i) => {
    const det = actual[i];
    if (!det) return;
    if (det.classId !== box.classId) problems.push(`hộp ${i}: lớp ${det.classId} ≠ ${box.classId}`);
    maxConfDiff = Math.max(maxConfDiff, Math.abs(det.confidence - box.confidence));
    minIou = Math.min(minIou, iou(det.bbox, box.bbox));
  });
  if (maxConfDiff > MAX_CONF_DIFF) problems.push(`lệch confidence ${maxConfDiff.toFixed(4)} > ${MAX_CONF_DIFF}`);
  if (minIou < MIN_IOU) problems.push(`IoU ${minIou.toFixed(4)} < ${MIN_IOU}`);
  return { pass: problems.length === 0, maxConfDiff, minIou, note: problems.join('; ') };
}

const root = document.getElementById('out') ?? document.body;
const fmt = (x: number, digits = 4): string => (Number.isFinite(x) ? x.toFixed(digits) : '-');

function add(tag: string, text: string): void {
  const el = document.createElement(tag);
  el.textContent = text;
  root.append(el);
}

function addTable(head: readonly string[], rows: ReadonlyArray<readonly string[]>): void {
  const table = document.createElement('table');
  const addRow = (cells: readonly string[], tag: 'th' | 'td'): void => {
    const tr = document.createElement('tr');
    for (const text of cells) {
      const cell = document.createElement(tag);
      cell.textContent = text;
      tr.append(cell);
    }
    const last = cells[cells.length - 1] ?? '';
    if (tag === 'td' && last.startsWith('ĐẠT')) tr.className = 'pass';
    if (tag === 'td' && last.startsWith('KHÔNG ĐẠT')) tr.className = 'fail';
    table.append(tr);
  };
  addRow(head, 'th');
  for (const r of rows) addRow(r, 'td');
  root.append(table);
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không đọc được ${url} (HTTP ${res.status}). Chép nội dung thư mục fixtures/ của gói P01 vào public/golden/.`);
  return res;
}

async function checkOne(client: IInferenceClient, fixture: GoldenFixture, frameId: number): Promise<{ row: string[]; pass: boolean }> {
  const bitmap = await createImageBitmap(await (await fetchOk(`./golden/${fixture.image}`)).blob(), { colorSpaceConversion: 'none' });
  const { width, height } = bitmap;
  const result = await client.infer({ bitmap, meta: { frameId, width, height, timestamp: performance.now() } });
  let verdict: GoldenVerdict;
  if (width !== fixture.srcWidth || height !== fixture.srcHeight) {
    verdict = { pass: false, maxConfDiff: NaN, minIou: NaN, note: `ảnh ${width}×${height} ≠ ${fixture.srcWidth}×${fixture.srcHeight}` };
  } else if (result === null) {
    verdict = { pass: false, maxConfDiff: NaN, minIou: NaN, note: 'khung bị bỏ' };
  } else {
    verdict = compareToGolden(result.detections, fixture.boxes);
  }
  const row = [
    fixture.image, fixture.kind, `${result?.detections.length ?? '-'} / ${fixture.boxes.length}`,
    fmt(verdict.maxConfDiff), fmt(verdict.minIou), fmt(result?.timings.totalMs ?? NaN, 1),
    verdict.pass ? 'ĐẠT' : `KHÔNG ĐẠT (${verdict.note})`,
  ];
  return { row, pass: verdict.pass };
}

function parseResolution(text: string | null): [number, number] {
  const [w, h] = (text ?? '640x480').split('x').map(Number);
  return [Number.isFinite(w) && w ? w : 640, Number.isFinite(h) && h ? h : 480];
}

async function main(): Promise<void> {
  setLogLevel('debug');
  const params = new URLSearchParams(location.search);
  add('h1', 'Kiểm tra vàng (chỉ dành cho dev)');
  const golden = (await (await fetchOk('./golden/golden_fixtures.json')).json()) as GoldenFixtures;
  const p = golden.params;
  const client = createInferenceClient({
    modelBaseUrl: './models/',
    ortBaseUrl: './ort/',
    config: {
      ...DEFAULT_CONFIG.inference,
      confLow: p.confLow, confSure: p.confSure, nmsIou: p.nmsIou, agnosticNms: p.agnosticNms, maxDetections: p.maxDetections,
      verifyChecksum: DEFAULT_CONFIG.inference.verifyChecksum && isSecureContext, // crypto.subtle chỉ có ở ngữ cảnh an toàn
    },
  });
  try {
    const info = await client.init();
    add('p', `Mô hình ${info.version} · size ${info.inputSize} · ${info.backend} · ${info.threads} luồng · nạp ${info.loadMs.toFixed(0)} ms · chạy nóng ${info.warmupMs.toFixed(0)} ms · crossOriginIsolated=${String(crossOriginIsolated)}`);
    const fixtures = golden.fixtures.filter((f) => f.size === info.inputSize);
    const rows: string[][] = [];
    let allPass = fixtures.length > 0;
    for (const [i, fixture] of fixtures.entries()) {
      try {
        const { row, pass } = await checkOne(client, fixture, i + 1);
        rows.push(row);
        allPass = allPass && pass;
      } catch (e) {
        rows.push([fixture.image, fixture.kind, '-', '-', '-', '-', `KHÔNG ĐẠT (${e instanceof Error ? e.message : String(e)})`]);
        allPass = false;
      }
    }
    addTable(['ảnh', 'loại', 'hộp thật / vàng', 'max Δconf', 'min IoU', 'ms', 'kết quả'], rows);
    if (fixtures.length === 0) add('p', `Không có mục vàng nào cho size ${info.inputSize}.`);
    const verdict = allPass ? 'ĐẠT' : 'KHÔNG ĐẠT';
    add('h2', `KẾT QUẢ: ${verdict}`);
    document.title = `Kiểm tra vàng: ${verdict}`;
    document.body.dataset.result = allPass ? 'pass' : 'fail';

    const n = Number(params.get('bench') ?? 0);
    if (n > 0) {
      const [w, h] = parseResolution(params.get('res'));
      add('h2', `Benchmark ${n} khung ${w}×${h}`);
      const stats = await runBenchmark(client, createSolidFrameSource(w, h), n);
      const line = (name: string, s: Stats): string[] => [name, s.mean.toFixed(1), s.p50.toFixed(1), s.p95.toFixed(1)];
      addTable(['chỉ số', 'mean (ms)', 'p50 (ms)', 'p95 (ms)'], [line('totalMs', stats.totalMs), line('inferMs', stats.inferMs)]);
      document.body.dataset.bench = 'done';
    }
  } finally {
    client.dispose();
  }
}

main().catch((e: unknown) => {
  add('h2', `LỖI: ${e instanceof Error ? e.message : String(e)}`);
  document.body.dataset.result = 'error';
});
