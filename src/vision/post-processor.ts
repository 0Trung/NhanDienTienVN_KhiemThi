import { AppError } from '../contracts';
import type {
  BBox,
  Denomination,
  Detection,
  FrameMeta,
  IPostProcessor,
  LetterboxMeta,
  PostProcessorOptions,
  RawModelOutput,
} from '../contracts';
import { isDenomination } from '../config/denominations';
import { clampBox, isValidBox } from '../utils/geometry';
import { AnchorDecoder, MAX_NMS_CANDIDATES, resolveLayout } from './decode';
import { greedyNms } from './nms';
import type { NmsOptions } from './nms';

/** Một kết quả đã về khung hình gốc, chờ sắp từ trái sang phải và gán id. */
interface Pending {
  classId: number;
  denomination: Denomination;
  confidence: number;
  bbox: BBox;
  cx: number;
  cy: number;
}

/** Cấu hình sai (NaN, ngưỡng ngoài [0, 1]...) làm NMS âm thầm hỏng nên phải từ chối ngay khi tạo. */
function assertOptions(classMap: readonly Denomination[], inference: PostProcessorOptions['inference']): void {
  if (classMap.length === 0) {
    throw new AppError('MODEL_CORRUPT', 'classMap rỗng: không có lớp nào để ánh xạ ra mệnh giá.', true);
  }
  const { confLow, nmsIou, maxDetections } = inference;
  const problems: string[] = [];
  if (!Number.isFinite(confLow)) problems.push(`confLow = ${confLow}`);
  if (!(nmsIou >= 0 && nmsIou <= 1)) problems.push(`nmsIou = ${nmsIou} (cần trong [0, 1])`);
  if (!Number.isInteger(maxDetections) || maxDetections < 0) {
    problems.push(`maxDetections = ${maxDetections} (cần số nguyên ≥ 0)`);
  }
  if (problems.length > 0) {
    throw new AppError('INFERENCE_FAILED', `Cấu hình suy luận không hợp lệ: ${problems.join('; ')}.`, true);
  }
}

/** Letterbox hỏng (scale ≤ 0, NaN...) sẽ cho toạ độ vô nghĩa nên ném lỗi thay vì trả hộp sai. */
function assertLetterbox(lb: LetterboxMeta): void {
  const valid =
    Number.isFinite(lb.scale) && lb.scale > 0 &&
    Number.isFinite(lb.padX) && Number.isFinite(lb.padY) &&
    Number.isFinite(lb.srcWidth) && lb.srcWidth > 0 &&
    Number.isFinite(lb.srcHeight) && lb.srcHeight > 0;
  if (!valid) {
    throw new AppError(
      'INFERENCE_FAILED',
      `Letterbox không hợp lệ (scale=${lb.scale}, lề=${lb.padX},${lb.padY}, ảnh gốc=${lb.srcWidth}×${lb.srcHeight}).`,
      false,
      lb,
    );
  }
}

/** F5: từ ảnh vuông S×S về khung hình gốc, rồi cắt trong [0, srcWidth] × [0, srcHeight]. Trả hộp mới. */
function toSourceFrame(b: BBox, lb: LetterboxMeta): BBox {
  return clampBox(
    {
      x1: (b.x1 - lb.padX) / lb.scale,
      y1: (b.y1 - lb.padY) / lb.scale,
      x2: (b.x2 - lb.padX) / lb.scale,
      y2: (b.y2 - lb.padY) / lb.scale,
    },
    lb.srcWidth,
    lb.srcHeight,
  );
}

/** F6: classId → mệnh giá qua classMap. Lớp không có trong classMap (hoặc giá trị không phải mệnh giá) là MODEL_CORRUPT. */
function lookupDenomination(classMap: readonly Denomination[], classId: number): Denomination {
  const value: number | undefined = classMap[classId];
  if (value === undefined || !isDenomination(value)) {
    throw new AppError(
      'MODEL_CORRUPT',
      `classId ${classId} không có trong classMap (hoặc không phải mệnh giá hợp lệ): classes.json và mô hình không khớp.`,
      true,
      { classId, classCount: classMap.length },
    );
  }
  return value;
}

/**
 * F8: hậu xử lý đầu ra YOLO (decode → NMS → về khung gốc) thành Detection[] sắp từ trái sang phải.
 * Hàm thuần theo từng khung: không phụ thuộc ONNX, DOM hay API riêng của Node.
 * Bộ nhớ tạm được tái sử dụng giữa các khung; Detection trả về luôn là đối tượng mới, không dùng chung bộ nhớ tạm.
 * Một bộ xử lý chỉ dùng cho một luồng khung hình (không gọi đồng thời).
 */
export function createPostProcessor(o: PostProcessorOptions): IPostProcessor {
  const { classMap, inference, layoutHint } = o;
  assertOptions(classMap, inference);
  const { confLow } = inference; // chốt ngưỡng ngay khi tạo, cùng chỗ với cấu hình NMS bên dưới

  const decoder = new AnchorDecoder();
  const nmsOptions: NmsOptions = {
    iouThreshold: inference.nmsIou,
    agnostic: inference.agnosticNms,
    maxDetections: inference.maxDetections,
  };
  const kept = new Int32Array(Math.min(MAX_NMS_CANDIDATES, inference.maxDetections));

  return {
    process(raw: RawModelOutput, letterbox: LetterboxMeta, meta: FrameMeta): Detection[] {
      assertLetterbox(letterbox);
      const layout = resolveLayout(raw.dims, classMap.length, layoutHint);
      decoder.decode(raw, layout, confLow);
      const keptCount = greedyNms(decoder.boxes, decoder.classIds, decoder.count, nmsOptions, kept);

      const pending: Pending[] = [];
      for (let k = 0; k < keptCount; k++) {
        const rank = kept[k] ?? 0;
        const source = decoder.boxes[rank];
        if (source === undefined) continue;
        const classId = decoder.classIds[rank] ?? -1;
        const denomination = lookupDenomination(classMap, classId);
        const bbox = toSourceFrame(source, letterbox);
        if (!isValidBox(bbox)) continue; // hộp suy biến sau khi cắt (nằm hẳn trong vùng lề) bị loại
        pending.push({
          classId,
          denomination,
          confidence: decoder.scores[rank] ?? 0,
          bbox,
          cx: (bbox.x1 + bbox.x2) / 2,
          cy: (bbox.y1 + bbox.y2) / 2,
        });
      }

      // F7: tâm x tăng dần, hoà thì theo tâm y; id đánh theo thứ tự cuối cùng này.
      pending.sort((a, b) => (a.cx !== b.cx ? a.cx - b.cx : a.cy - b.cy));
      return pending.map((p, index) => ({
        id: `${meta.frameId}-${index}`,
        classId: p.classId,
        denomination: p.denomination,
        confidence: p.confidence,
        bbox: p.bbox,
        frameId: meta.frameId,
        timestamp: meta.timestamp,
      }));
    },
  };
}