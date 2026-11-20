/**
 * Lớp debug (chỉ được dựng khi có ?debug=1 hoặc bản dựng development): vẽ hộp phát hiện lên video, hiện FPS,
 * độ trễ từng bước, state, status, reasons; có nút tải log JSON. KHÔNG BAO GIỜ lưu hay gửi ảnh: log chỉ chứa số liệu,
 * mã trạng thái, tọa độ hộp và dòng log chữ.
 */
import type { AppView, ScanFrameView } from '../app/app';
import { DEFAULT_CONFIG } from '../config/app-config';
import type { AppState, BBox, DecisionStatus, InferenceTimings } from '../contracts';
import { getRecentLogs } from '../utils/logger';
import type { Clock } from '../utils/time';

/** Số bản ghi tối đa giữ trong bộ nhớ cho log JSON (cũ nhất bị bỏ). */
export const MAX_DEBUG_ENTRIES = 300;
/** Số khung gần nhất dùng để tính FPS thực đo được. */
const FPS_WINDOW = 10;
const MS_PER_SECOND = 1000;
const SURE_COLOR = '#00ff66';
const UNSURE_COLOR = '#ffb000';
const UNSURE_DASH = [6, 4]; // nét đứt = chưa chắc: không chỉ dựa vào màu

export interface DebugEntry {
  t: number;
  state: AppState;
  status: DecisionStatus | null;
  reasons: string[];
  frame: {
    latencyMs: number;
    samplingFps: number;
    timings: InferenceTimings;
    detections: Array<{ denomination: number; confidence: number; bbox: BBox }>;
  } | null;
}

export interface DebugLog {
  createdAt: string;
  entries: DebugEntry[];
  logs: string[];
}

export interface DebugOverlay {
  update(view: AppView): void;
  buildLog(): DebugLog;
  dispose(): void;
}

export function createDebugOverlay(
  o: { doc: Document; surface: HTMLElement; panelHost: HTMLElement; now: Clock; confSure?: number },
): DebugOverlay {
  const { doc } = o;
  const confSure = o.confSure ?? DEFAULT_CONFIG.inference.confSure;
  const entries: DebugEntry[] = [];
  const stamps: number[] = [];
  let lastFrame: ScanFrameView | null = null;

  const canvas = doc.createElement('canvas');
  canvas.className = 'debug-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  o.surface.append(canvas);

  const panel = doc.createElement('div');
  panel.className = 'debug-panel';
  panel.setAttribute('data-role', 'debug');
  const text = doc.createElement('pre');
  text.setAttribute('aria-hidden', 'true');
  const save = doc.createElement('button');
  save.type = 'button';
  save.setAttribute('aria-label', 'Tải log JSON');
  save.textContent = 'Tải log JSON';
  panel.append(text, save);
  o.panelHost.append(panel);

  const measuredFps = (): number => {
    const first = stamps[0];
    const last = stamps[stamps.length - 1];
    return first === undefined || last === undefined || last <= first ? 0 : ((stamps.length - 1) * MS_PER_SECOND) / (last - first);
  };

  function draw(frame: ScanFrameView): void {
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    const { width, height } = frame.meta;
    if (width <= 0 || height <= 0) return;
    const scale = Math.min(w / width, h / height); // video hiển thị object-fit: contain
    const ox = (w - width * scale) / 2;
    const oy = (h - height * scale) / 2;
    ctx.lineWidth = 3;
    ctx.font = '14px monospace';
    for (const d of frame.detections) {
      const sure = d.confidence >= confSure;
      const x = ox + d.bbox.x1 * scale;
      const y = oy + d.bbox.y1 * scale;
      ctx.strokeStyle = sure ? SURE_COLOR : UNSURE_COLOR;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.setLineDash(sure ? [] : UNSURE_DASH);
      ctx.strokeRect(x, y, (d.bbox.x2 - d.bbox.x1) * scale, (d.bbox.y2 - d.bbox.y1) * scale);
      ctx.fillText(`${d.denomination} ${Math.round(d.confidence * 100)}%`, x + 4, Math.max(14, y - 4));
    }
  }

  function render(view: AppView): void {
    const lines = [`state ${view.state}  status ${view.status ?? '-'}`, `reasons ${view.reasons.join(', ') || '-'}`];
    if (lastFrame !== null) {
      const t = lastFrame.timings;
      const ms = (v: number): string => String(Math.round(v));
      lines.push(
        `fps ${measuredFps().toFixed(1)} / lấy mẫu ${lastFrame.samplingFps}  trễ ${ms(lastFrame.latencyMs)} ms`,
        `tiền xử lý ${ms(t.preprocessMs)}  suy luận ${ms(t.inferMs)}  hậu xử lý ${ms(t.postprocessMs)}  tổng ${ms(t.totalMs)} ms`,
      );
    }
    text.textContent = lines.join('\n');
  }

  function buildLog(): DebugLog {
    return { createdAt: new Date().toISOString(), entries: [...entries], logs: getRecentLogs() };
  }

  /** Tải về bằng liên kết blob. Trong WebView Android thao tác này có thể không tải được: dùng chrome://inspect hoặc trình duyệt. */
  save.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(buildLog(), null, 2)], { type: 'application/json' }));
    const link = doc.createElement('a');
    link.href = url;
    link.download = `money-reader-log-${Date.now()}.json`;
    doc.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  return {
    update(view) {
      const frame = view.frame;
      if (frame !== null) {
        lastFrame = frame;
        stamps.push(o.now());
        if (stamps.length > FPS_WINDOW) stamps.shift();
        draw(frame);
      }
      entries.push({
        t: o.now(), state: view.state, status: view.status, reasons: [...view.reasons],
        frame: frame === null ? null : {
          latencyMs: frame.latencyMs, samplingFps: frame.samplingFps, timings: frame.timings,
          detections: frame.detections.map((d) => ({ denomination: d.denomination, confidence: d.confidence, bbox: d.bbox })),
        },
      });
      if (entries.length > MAX_DEBUG_ENTRIES) entries.shift();
      render(view);
    },
    buildLog,
    dispose() {
      canvas.remove();
      panel.remove();
    },
  };
}