import { AppError } from '../contracts';
import type { BBox, RawModelOutput } from '../contracts';

/** Bố cục tensor đầu ra của YOLO: channels_first = [1, 4+nc, N]; channels_last = [1, N, 4+nc]. */
export type OutputLayout = 'channels_first' | 'channels_last';

/** Số kênh toạ độ đứng đầu mỗi anchor: tâm x, tâm y, rộng, cao (pixel của ảnh vuông S×S). */
export const BOX_CHANNELS = 4;

/** Số ứng viên tối đa được giữ lại trước NMS (F3). */
export const MAX_NMS_CANDIDATES = 300;

/** Số cột của đầu ra đã nhúng NMS: [1, N, 6] = x1, y1, x2, y2, điểm, lớp. */
const EMBEDDED_NMS_COLUMNS = 6;

/** Hình dạng đã nhận diện của tensor đầu ra. */
export interface TensorLayout {
  layout: OutputLayout;
  /** N: số anchor, lấy từ dims (không hard-code). */
  anchors: number;
  /** 4 + nc. */
  channels: number;
}

function structuralError(message: string, dims: readonly number[]): AppError {
  return new AppError('INFERENCE_FAILED', message, true, { dims: [...dims] });
}

/**
 * F1: nhận diện bố cục từ dims với nc = classCount.
 * Dims quyết định bố cục; `hint` chỉ dùng để hoà khi cả hai cách đọc cùng khớp (ví dụ [1, 13, 13]),
 * không có hint thì mặc định channels_first (đầu ra chuẩn của YOLO11).
 * Ném AppError INFERENCE_FAILED (fatal) nêu dims nhận được và dims mong đợi khi không khớp;
 * riêng dạng [1, N, 6] (NMS nhúng sẵn) có thông điệp hướng dẫn xuất lại với nms=False.
 */
export function resolveLayout(dims: readonly number[], classCount: number, hint?: OutputLayout): TensorLayout {
  const channels = BOX_CHANNELS + classCount;
  const got = `[${dims.join(', ')}]`;
  const expected = `[1, ${channels}, N] (channels_first) hoặc [1, N, ${channels}] (channels_last), nc = ${classCount}`;
  const [batch, d1, d2] = dims;
  if (
    dims.length !== 3 || batch !== 1 || d1 === undefined || d2 === undefined ||
    !dims.every((d) => Number.isInteger(d) && d > 0)
  ) {
    throw structuralError(`Dims đầu ra không hợp lệ: nhận ${got}, mong đợi ${expected}.`, dims);
  }

  const firstMatches = d1 === channels;
  const lastMatches = d2 === channels;
  if (!firstMatches && !lastMatches) {
    if (d2 === EMBEDDED_NMS_COLUMNS) {
      throw structuralError(
        `Đầu ra ${got} có dạng [1, N, 6]: mô hình đã nhúng NMS nên không dùng được. ` +
          `Hãy xuất lại ONNX với nms=False (mong đợi ${expected}).`,
        dims,
      );
    }
    throw structuralError(`Dims đầu ra không khớp: nhận ${got}, mong đợi ${expected}.`, dims);
  }

  let layout: OutputLayout;
  if (firstMatches && lastMatches) layout = hint ?? 'channels_first';
  else layout = firstMatches ? 'channels_first' : 'channels_last';
  return { layout, anchors: layout === 'channels_first' ? d2 : d1, channels };
}

/**
 * F2 + F3: giải mã anchor thành ứng viên, giữ bộ nhớ tạm giữa các khung (F8).
 * Mọi mảng được cấp phát một lần rồi ghi đè; chỉ lớn thêm khi gặp tensor có nhiều anchor hơn trước.
 */
export class AnchorDecoder {
  /** Số ứng viên của khung vừa giải mã; boxes, classIds, scores chỉ có nghĩa ở [0, count). */
  count = 0;
  /** Hộp x1, y1, x2, y2 trong hệ toạ độ ảnh vuông S×S, sắp theo điểm GIẢM DẦN. Đối tượng bị ghi đè ở khung sau. */
  readonly boxes: BBox[] = [];
  readonly classIds = new Int32Array(MAX_NMS_CANDIDATES);
  readonly scores = new Float32Array(MAX_NMS_CANDIDATES);

  // Vùng nháp theo anchor đã qua ngưỡng (chưa cắt trần, chưa sắp).
  private anchorOf = new Int32Array(0);
  private classOf = new Int32Array(0);
  private scoreOf = new Float32Array(0);
  private order = new Int32Array(0);

  /** Điểm cao hơn đứng trước; hoà điểm thì anchor có chỉ số nhỏ hơn đứng trước (kết quả xác định). */
  private readonly byScoreDesc = (a: number, b: number): number => {
    const sa = this.scoreOf[a] ?? 0;
    const sb = this.scoreOf[b] ?? 0;
    if (sa !== sb) return sa > sb ? -1 : 1;
    return a - b;
  };

  /**
   * Giải mã một tensor. Với mỗi anchor, lớp thắng là argmax điểm lớp (hoà thì lớp nhỏ hơn), không có objectness;
   * anchor được giữ khi điểm > confLow (so sánh nghiêm ngặt, ở độ chính xác float32 như giai_ma của bản mẫu P01).
   * Rồi giữ tối đa MAX_NMS_CANDIDATES điểm cao nhất và đổi tâm-rộng-cao sang x1, y1, x2, y2.
   * Anchor có toạ độ không hữu hạn bị bỏ và không chiếm chỗ. Trả về số ứng viên.
   */
  decode(raw: RawModelOutput, layout: TensorLayout, confLow: number): number {
    const { data } = raw;
    const { anchors, channels } = layout;
    if (data.length !== anchors * channels) {
      throw new AppError(
        'INFERENCE_FAILED',
        `Độ dài dữ liệu đầu ra (${data.length}) không khớp dims [${raw.dims.join(', ')}] (cần ${anchors * channels}).`,
        false,
        { dims: [...raw.dims], length: data.length },
      );
    }
    this.reserve(anchors);
    const { anchorOf, classOf, scoreOf, order } = this;

    const classCount = channels - BOX_CHANNELS;
    const channelsFirst = layout.layout === 'channels_first';
    const anchorStride = channelsFirst ? 1 : channels; // bước nhảy giữa hai anchor liền nhau
    const channelStride = channelsFirst ? anchors : 1; // bước nhảy giữa hai kênh của cùng một anchor
    const threshold = Math.fround(confLow);

    let passed = 0;
    for (let i = 0; i < anchors; i++) {
      const scoreBase = i * anchorStride + BOX_CHANNELS * channelStride;
      let best = Number.NEGATIVE_INFINITY;
      let bestClass = -1;
      for (let c = 0; c < classCount; c++) {
        const s = data[scoreBase + c * channelStride];
        if (s !== undefined && s > best) {
          best = s;
          bestClass = c;
        }
      }
      if (best > threshold) {
        anchorOf[passed] = i;
        classOf[passed] = bestClass;
        scoreOf[passed] = best;
        passed++;
      }
    }

    const ranked = order.subarray(0, passed);
    for (let k = 0; k < passed; k++) ranked[k] = k;
    ranked.sort(this.byScoreDesc);

    let count = 0;
    for (let r = 0; r < passed && count < MAX_NMS_CANDIDATES; r++) {
      const slot = ranked[r] ?? 0;
      const base = (anchorOf[slot] ?? 0) * anchorStride;
      const cx = data[base] ?? Number.NaN;
      const cy = data[base + channelStride] ?? Number.NaN;
      const w = data[base + 2 * channelStride] ?? Number.NaN;
      const h = data[base + 3 * channelStride] ?? Number.NaN;
      if (!Number.isFinite(cx + cy + w + h)) continue; // NaN hoặc vô cực ở bất kỳ giá trị nào
      // Làm tròn từng toạ độ về float32 như bản mẫu P01 (giai_ma ép xyxy sang float32 trước NMS).
      const x1 = Math.fround(cx - w / 2);
      const y1 = Math.fround(cy - h / 2);
      const x2 = Math.fround(cx + w / 2);
      const y2 = Math.fround(cy + h / 2);
      this.setCandidate(count, x1, y1, x2, y2, classOf[slot] ?? 0, scoreOf[slot] ?? 0);
      count++;
    }
    this.count = count;
    return count;
  }

  private reserve(anchors: number): void {
    if (this.anchorOf.length >= anchors) return;
    this.anchorOf = new Int32Array(anchors);
    this.classOf = new Int32Array(anchors);
    this.scoreOf = new Float32Array(anchors);
    this.order = new Int32Array(anchors);
  }

  private setCandidate(k: number, x1: number, y1: number, x2: number, y2: number, classId: number, score: number): void {
    const box = this.boxes[k];
    if (box === undefined) {
      this.boxes[k] = { x1, y1, x2, y2 };
    } else {
      box.x1 = x1;
      box.y1 = y1;
      box.x2 = x2;
      box.y2 = y2;
    }
    this.classIds[k] = classId;
    this.scores[k] = score;
  }
}