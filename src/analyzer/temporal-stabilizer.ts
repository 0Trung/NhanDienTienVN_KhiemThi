import type { AppConfig, BBox, Denomination, Detection, FrameAnalysis } from '../contracts';
import { iou } from '../utils/geometry';
import { mean } from '../utils/math';

/** Cấu hình bộ ổn định, lấy từ config.analyzer.stabilizer. */
export type StabilizerConfig = AppConfig['analyzer']['stabilizer'];

/** Kết luận ổn định của một khung, đúng kiểu FrameAnalysis['stability']. */
export type StabilityInfo = FrameAnalysis['stability'];

/** Phần tối thiểu của một hộp để ghép giữa hai khung: mệnh giá và vị trí (pixel, khung gốc). */
export type MatchableBox = Pick<Detection, 'denomination' | 'bbox'>;

/** Một khung hình đưa vào bộ ổn định. */
export interface StabilizerFrame {
  /** Mốc thời gian chụp khung, mili-giây (FrameMeta.timestamp, cùng hệ quy chiếu performance.now()). */
  timestamp: number;
  /** Khung có hợp lệ để xét ổn định không (xem isFrameValid). */
  valid: boolean;
  /** Các detection CHẮC của khung, theo thứ tự trái → phải. */
  sure: readonly Detection[];
}

/** Bộ ổn định theo thời gian (Detection Tracker): giữ cửa sổ các khung gần nhất. */
export interface TemporalStabilizer {
  /** Ghi một khung mới vào cửa sổ rồi trả kết luận ổn định cho CHÍNH khung đó. */
  push(frame: StabilizerFrame): StabilityInfo;
  /** Xóa toàn bộ cửa sổ. */
  reset(): void;
}

/** Bản chụp một hộp chắc của khung cũ: tách khỏi đối tượng của người gọi để họ sửa sau này cũng không làm hỏng cửa sổ. */
interface TrackedBox {
  readonly denomination: Denomination;
  readonly confidence: number;
  readonly bbox: BBox;
}

interface Entry {
  readonly timestamp: number;
  readonly valid: boolean;
  readonly boxes: readonly TrackedBox[];
}

interface Agreeing {
  readonly boxes: readonly TrackedBox[];
  /** matchOf[i] = chỉ số trong `boxes` được ghép với hộp thứ i của khung mới nhất. */
  readonly matchOf: readonly number[];
}

/**
 * Khung HỢP LỆ để xét ổn định khi: có ít nhất một tờ chắc, KHÔNG có tờ chưa chắc,
 * không chồng lấn và không xung đột lớp. Vị trí (quá nhỏ, chạm mép) và chất lượng ảnh (mờ, tối)
 * không nằm trong điều kiện này: việc chặn theo chúng thuộc về bộ ra quyết định.
 */
export function isFrameValid(f: Pick<FrameAnalysis, 'sure' | 'unsure' | 'overlap' | 'conflict'>): boolean {
  return f.sure.length > 0 && !f.overlap.detected && !f.conflict.detected;
}

/**
 * Ghép hộp của hai khung: mỗi hộp của `a` phải ghép được với ĐÚNG MỘT hộp của `b` (và ngược lại),
 * cùng mệnh giá và IoU ≥ matchIou, ghép tham lam theo IoU giảm dần (hòa thì theo chỉ số nhỏ trước).
 * Ghép đủ cặp kéo theo cùng số tờ và cùng đa tập mệnh giá nên không cần kiểm riêng.
 * Hộp suy biến có IoU 0 nên không bao giờ ghép được.
 *
 * @param a Hộp của khung thứ nhất, pixel khung gốc.
 * @param b Hộp của khung thứ hai, pixel khung gốc.
 * @param matchIou Ngưỡng IoU, không đơn vị trong (0, 1] (config.analyzer.stabilizer.matchIou).
 * @returns matchOf với matchOf[i] = chỉ số hộp của `b` ghép với a[i]; null nếu hai khung không đồng thuận.
 */
export function matchDetections(
  a: readonly MatchableBox[],
  b: readonly MatchableBox[],
  matchIou: number,
): number[] | null {
  if (a.length !== b.length) return null;

  const candidates: Array<{ i: number; j: number; iou: number }> = [];
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    if (left === undefined) continue;
    for (let j = 0; j < b.length; j++) {
      const right = b[j];
      if (right === undefined || left.denomination !== right.denomination) continue;
      const overlap = iou(left.bbox, right.bbox);
      if (overlap >= matchIou) candidates.push({ i, j, iou: overlap });
    }
  }
  candidates.sort((p, q) => q.iou - p.iou || p.i - q.i || p.j - q.j);

  const matchOf: number[] = new Array<number>(a.length).fill(-1);
  const taken: boolean[] = new Array<boolean>(b.length).fill(false);
  let matched = 0;
  for (const c of candidates) {
    if (matchOf[c.i] !== -1 || taken[c.j] === true) continue;
    matchOf[c.i] = c.j;
    taken[c.j] = true;
    matched++;
  }
  return matched === a.length ? matchOf : null;
}

function assertValidConfig(c: StabilizerConfig): void {
  if (!Number.isInteger(c.windowSize) || c.windowSize < 1) {
    throw new RangeError(`stabilizer.windowSize phải là số nguyên ≥ 1, nhận ${c.windowSize}`);
  }
  if (!Number.isInteger(c.minAgree) || c.minAgree < 1 || c.minAgree > c.windowSize) {
    throw new RangeError(`stabilizer.minAgree phải là số nguyên trong [1, windowSize = ${c.windowSize}], nhận ${c.minAgree}`);
  }
  if (!(c.matchIou > 0 && c.matchIou <= 1)) {
    throw new RangeError(`stabilizer.matchIou phải thuộc (0, 1], nhận ${c.matchIou}`);
  }
  if (!(c.maxAgeMs >= 0)) {
    throw new RangeError(`stabilizer.maxAgeMs phải ≥ 0 (mili-giây), nhận ${c.maxAgeMs}`);
  }
}

function snapshotBox(d: Detection): TrackedBox {
  return { denomination: d.denomination, confidence: d.confidence, bbox: { ...d.bbox } };
}

function toEntry(frame: StabilizerFrame): Entry {
  // Khung tự khai "hợp lệ" nhưng không có hộp chắc nào thì không thể làm bằng chứng ổn định.
  const valid = frame.valid && frame.sure.length > 0;
  return { timestamp: frame.timestamp, valid, boxes: valid ? frame.sure.map(snapshotBox) : [] };
}

/** Detection của khung mới nhất, confidence = trung bình confidence của hộp được ghép ở mọi khung đồng thuận (kể cả chính nó). */
function buildConsensus(latest: readonly Detection[], agreeing: readonly Agreeing[]): Detection[] {
  return latest.map((d, i) => {
    const confidences = [d.confidence];
    for (const a of agreeing) {
      const j = a.matchOf[i];
      const other = j === undefined ? undefined : a.boxes[j];
      if (other !== undefined) confidences.push(other.confidence);
    }
    return { ...d, bbox: { ...d.bbox }, confidence: mean(confidences) };
  });
}

/**
 * Tạo bộ ổn định theo thời gian.
 *
 * Cửa sổ giữ tối đa windowSize khung gần nhất (kể cả khung không hợp lệ). Mỗi lần push:
 * 1. Bỏ các mục cũ hơn maxAgeMs (mili-giây) so với mốc thời gian của khung hiện tại; mục có mốc SAU khung hiện tại
 *    (đồng hồ lùi) hoặc mốc không xác định (NaN) cũng bị bỏ, để bằng chứng cũ không sống sót qua một lần lùi đồng hồ.
 * 2. Thêm khung hiện tại rồi cắt còn windowSize mục mới nhất.
 * 3. Kết luận (Fail Safe): stable chỉ có thể true khi CHÍNH khung hiện tại hợp lệ. Khi đó
 *    agree = 1 + số khung hợp lệ khác trong cửa sổ ĐỒNG THUẬN với khung hiện tại (xem matchDetections);
 *    stable = agree ≥ minAgree. Khung hiện tại không hợp lệ cho stable false, agree 0.
 * 4. consensus chỉ khác null khi stable: các Detection (bản sao) của khung hiện tại, trái → phải,
 *    với confidence là trung bình mọi khung đồng thuận.
 * `window` trong kết quả luôn bằng windowSize (sức chứa), không phải số mục đang có.
 *
 * Bộ ổn định chụp lại dữ liệu hộp khi push nên người gọi sửa Detection sau đó không ảnh hưởng cửa sổ.
 * Ném RangeError nếu cấu hình không hợp lệ (windowSize, minAgree nguyên và 1 ≤ minAgree ≤ windowSize; 0 < matchIou ≤ 1; maxAgeMs ≥ 0).
 *
 * @param config config.analyzer.stabilizer: windowSize (khung), minAgree (khung), matchIou (không đơn vị), maxAgeMs (mili-giây).
 */
export function createTemporalStabilizer(config: StabilizerConfig): TemporalStabilizer {
  assertValidConfig(config);
  const { windowSize, minAgree, matchIou, maxAgeMs } = config;
  let entries: Entry[] = [];

  function push(frame: StabilizerFrame): StabilityInfo {
    const now = frame.timestamp;
    const fresh = entries.filter((e) => {
      const age = now - e.timestamp;
      return age >= 0 && age <= maxAgeMs;
    });
    const latest = toEntry(frame);
    entries = [...fresh, latest].slice(-windowSize);

    if (!latest.valid) return { stable: false, agree: 0, window: windowSize, consensus: null };

    const agreeing: Agreeing[] = [];
    for (const e of entries) {
      if (e === latest || !e.valid) continue;
      const matchOf = matchDetections(latest.boxes, e.boxes, matchIou);
      if (matchOf !== null) agreeing.push({ boxes: e.boxes, matchOf });
    }
    const agree = 1 + agreeing.length;
    if (agree < minAgree) return { stable: false, agree, window: windowSize, consensus: null };
    return { stable: true, agree, window: windowSize, consensus: buildConsensus(frame.sure, agreeing) };
  }

  function reset(): void {
    entries = [];
  }

  return { push, reset };
}