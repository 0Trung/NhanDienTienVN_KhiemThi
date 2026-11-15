import { describe, expect, it } from 'vitest';
import { createTemporalStabilizer, isFrameValid, matchDetections } from '../../src/analyzer/temporal-stabilizer';
import type { MatchableBox, StabilizerConfig, StabilizerFrame, TemporalStabilizer } from '../../src/analyzer/temporal-stabilizer';
import type { BBox, Denomination, Detection } from '../../src/contracts';
import {
  makeAnalysis,
  makeConflictAnalysis,
  makeDetection,
  makeOverlapAnalysis,
  makeSingleSureAnalysis,
  makeUnsureAnalysis,
} from '../fakes';

const CONFIG: StabilizerConfig = { windowSize: 5, minAgree: 4, matchIou: 0.5, maxAgeMs: 2500 };
const STEP_MS = 100;

const box = (x1: number, y1: number, x2: number, y2: number): BBox => ({ x1, y1, x2, y2 });
const LEFT = box(20, 100, 180, 300);
const RIGHT = box(200, 100, 360, 300);

/** Detection chắc với bản sao riêng của hộp, để test sửa một Detection không lan sang hằng số dùng chung. */
const sure = (denomination: Denomination = 20000, confidence = 0.9, bbox: BBox = LEFT, index = 0): Detection =>
  makeDetection({ id: `1-${index}`, denomination, confidence, bbox: { ...bbox } });
const frame = (timestamp: number, sureBoxes: Detection[], valid = true): StabilizerFrame => ({ timestamp, valid, sure: sureBoxes });
const lastOf = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

/** Mã mẫu: A = khung hợp lệ 20000đ, B = khung hợp lệ 50000đ, x = khung không hợp lệ; mỗi khung cách nhau STEP_MS. */
function feedPattern(stabilizer: TemporalStabilizer, pattern: string) {
  return [...pattern].map((code, index) =>
    stabilizer.push(frame(index * STEP_MS, [sure(code === 'B' ? 50000 : 20000)], code !== 'x')),
  );
}

/** Khung có `count` tờ: 1 → [20000 trái]; 2 → [20000 trái, 50000 phải]. */
const notes = (count: 1 | 2): Detection[] =>
  count === 1 ? [sure(20000, 0.9, LEFT, 0)] : [sure(20000, 0.9, LEFT, 0), sure(50000, 0.9, RIGHT, 1)];

describe('createTemporalStabilizer · đồng thuận theo số khung', () => {
  it.each([
    { name: '5 khung đồng thuận', pattern: 'AAAAA', stable: true, agree: 5 },
    { name: 'đủ minAgree đúng ranh (4 khung)', pattern: 'AAAA', stable: true, agree: 4 },
    { name: '3 khung đồng thuận chưa đủ', pattern: 'AAA', stable: false, agree: 3 },
    { name: '3 trong 5 khung hợp lệ (xen khung không hợp lệ)', pattern: 'AxAxA', stable: false, agree: 3 },
    { name: 'khung xen kẽ đổi mệnh giá', pattern: 'ABABA', stable: false, agree: 3 },
    { name: 'một khung lệch mệnh giá ở đầu cửa sổ vẫn ổn định', pattern: 'BAAAA', stable: true, agree: 4 },
    { name: 'một khung không hợp lệ ở đầu cửa sổ không cản', pattern: 'xAAAA', stable: true, agree: 4 },
    { name: 'khung mới nhất đổi mệnh giá', pattern: 'AAAAB', stable: false, agree: 1 },
    { name: 'khung mới nhất không hợp lệ thì không ổn định dù 4 khung trước đồng thuận', pattern: 'AAAAx', stable: false, agree: 0 },
    { name: 'cửa sổ trượt: chỉ tính 5 khung gần nhất', pattern: 'AAAAAAAAAA', stable: true, agree: 5 },
  ])('$name', ({ pattern, stable, agree }) => {
    const infos = feedPattern(createTemporalStabilizer(CONFIG), pattern);
    expect(lastOf(infos)).toMatchObject({ stable, agree });
  });

  it('khung tự khai hợp lệ nhưng không có hộp chắc nào thì không bao giờ ổn định', () => {
    const s = createTemporalStabilizer(CONFIG);
    const infos = [0, 1, 2, 3, 4].map((i) => s.push(frame(i * STEP_MS, [])));
    expect(infos.every((i) => !i.stable && i.agree === 0 && i.consensus === null)).toBe(true);
  });

  it('window luôn bằng windowSize (sức chứa), kể cả khi cửa sổ chưa đầy', () => {
    const infos = feedPattern(createTemporalStabilizer(CONFIG), 'AA');
    expect(infos.map((i) => i.window)).toEqual([5, 5]);
  });

  it('agree tăng dần theo từng khung đồng thuận', () => {
    const infos = feedPattern(createTemporalStabilizer(CONFIG), 'AAAAA');
    expect(infos.map((i) => i.agree)).toEqual([1, 2, 3, 4, 5]);
    expect(infos.map((i) => i.stable)).toEqual([false, false, false, true, true]);
  });
});

describe('createTemporalStabilizer · đổi số tờ', () => {
  it.each([
    { name: 'ba khung một tờ rồi hai khung hai tờ', counts: [1, 1, 1, 2, 2] as const, stable: false, agree: 2 },
    { name: 'một khung một tờ rồi bốn khung hai tờ (khung cũ lệch bị bỏ qua)', counts: [1, 2, 2, 2, 2] as const, stable: true, agree: 4 },
    { name: 'bốn khung hai tờ rồi một khung một tờ', counts: [2, 2, 2, 2, 1] as const, stable: false, agree: 1 },
  ])('$name', ({ counts, stable, agree }) => {
    const s = createTemporalStabilizer(CONFIG);
    const infos = counts.map((count, index) => s.push(frame(index * STEP_MS, notes(count))));
    expect(lastOf(infos)).toMatchObject({ stable, agree });
  });
});

describe('createTemporalStabilizer · mục quá hạn', () => {
  it.each([
    { name: 'bốn khung trong hạn', times: [0, 500, 1000, 1500], stable: true, agree: 4 },
    { name: 'khung cũ nhất già hơn maxAgeMs thì bị loại', times: [0, 500, 1000, 2600], stable: false, agree: 3 },
    { name: 'đúng maxAgeMs thì còn giữ', times: [0, 100, 200, 2500], stable: true, agree: 4 },
    { name: 'hơn maxAgeMs 1 ms thì bị loại', times: [0, 100, 200, 2501], stable: false, agree: 3 },
    { name: 'đồng hồ lùi thì bỏ các mục "ở tương lai"', times: [1000, 1100, 1200, 500], stable: false, agree: 1 },
    { name: 'mốc thời gian NaN thì bỏ mọi mục cũ', times: [0, 100, 200, Number.NaN], stable: false, agree: 1 },
  ])('$name', ({ times, stable, agree }) => {
    const s = createTemporalStabilizer(CONFIG);
    const infos = times.map((t) => s.push(frame(t, [sure()])));
    expect(lastOf(infos)).toMatchObject({ stable, agree });
  });
});

describe('createTemporalStabilizer · reset', () => {
  it('sau reset phải đủ minAgree khung mới mới ổn định lại', () => {
    const s = createTemporalStabilizer(CONFIG);
    expect(lastOf(feedPattern(s, 'AAAA'))?.stable).toBe(true);
    s.reset();
    const after = [0, 1, 2, 3].map((i) => s.push(frame(1000 + i * STEP_MS, [sure()])));
    expect(after.map((i) => i.agree)).toEqual([1, 2, 3, 4]);
    expect(after.map((i) => i.stable)).toEqual([false, false, false, true]);
  });
});

describe('createTemporalStabilizer · consensus', () => {
  it('confidence là trung bình các khung đồng thuận, phần còn lại lấy từ khung mới nhất', () => {
    const s = createTemporalStabilizer(CONFIG);
    const confidences = [0.8, 0.9, 0.85, 0.95];
    const infos = confidences.map((c, i) =>
      s.push(frame(i * STEP_MS, [makeDetection({ id: `${i + 1}-0`, frameId: i + 1, timestamp: i * STEP_MS, confidence: c, bbox: LEFT })])),
    );
    const consensus = lastOf(infos)?.consensus;
    expect(consensus).toHaveLength(1);
    expect(consensus?.[0]?.confidence).toBeCloseTo(0.875, 9);
    expect(consensus?.[0]).toMatchObject({ id: '4-0', frameId: 4, timestamp: 300, denomination: 20000, bbox: LEFT });
  });

  it('hai tờ: mỗi tờ có trung bình riêng, giữ thứ tự trái → phải', () => {
    const s = createTemporalStabilizer(CONFIG);
    const rightConfidences = [0.7, 0.9, 0.7, 0.9];
    const infos = rightConfidences.map((c, i) =>
      s.push(frame(i * STEP_MS, [sure(20000, 0.8, LEFT, 0), sure(50000, c, RIGHT, 1)])),
    );
    const consensus = lastOf(infos)?.consensus ?? [];
    expect(consensus.map((d) => d.denomination)).toEqual([20000, 50000]);
    expect(consensus[0]?.confidence).toBeCloseTo(0.8, 9);
    expect(consensus[1]?.confidence).toBeCloseTo(0.8, 9);
  });

  it('khung không hợp lệ trong cửa sổ không được tính vào trung bình', () => {
    const s = createTemporalStabilizer(CONFIG);
    s.push(frame(0, [sure(20000, 0.9)]));
    s.push(frame(100, [sure(20000, 0.1)], false));
    s.push(frame(200, [sure(20000, 0.8)]));
    s.push(frame(300, [sure(20000, 0.8)]));
    const info = s.push(frame(400, [sure(20000, 0.9)]));
    expect(info.stable).toBe(true);
    expect(info.consensus?.[0]?.confidence).toBeCloseTo(0.85, 9);
  });

  it('hộp xê dịch nhẹ giữa các khung (IoU ≥ matchIou) vẫn đồng thuận, bbox lấy từ khung mới nhất', () => {
    const s = createTemporalStabilizer(CONFIG);
    const infos = [0, 5, 10, 15].map((dx, i) => s.push(frame(i * STEP_MS, [sure(20000, 0.9, box(20 + dx, 100, 180 + dx, 300))])));
    const last = lastOf(infos);
    expect(last?.stable).toBe(true);
    expect(last?.consensus?.[0]?.bbox).toEqual(box(35, 100, 195, 300));
  });

  it('chưa ổn định hoặc khung mới nhất không hợp lệ thì consensus là null', () => {
    const s = createTemporalStabilizer(CONFIG);
    expect(s.push(frame(0, [sure()])).consensus).toBeNull();
    expect(s.push(frame(100, [sure()], false)).consensus).toBeNull();
  });

  it('consensus là bản sao: sửa nó không làm đổi đầu vào', () => {
    const s = createTemporalStabilizer({ ...CONFIG, minAgree: 1 });
    const input = sure(20000, 0.9);
    const consensus = s.push(frame(0, [input])).consensus;
    expect(consensus).not.toBeNull();
    const first = consensus?.[0];
    if (first === undefined) return;
    first.confidence = 0.1;
    first.bbox.x1 = 999;
    expect(input.confidence).toBe(0.9);
    expect(input.bbox).toEqual(LEFT);
  });
});

describe('createTemporalStabilizer · tính độc lập với đối tượng của người gọi', () => {
  it('sửa Detection sau khi push không làm hỏng cửa sổ', () => {
    const s = createTemporalStabilizer(CONFIG);
    const first = sure(20000, 0.8);
    s.push(frame(0, [first]));
    first.confidence = 0.1;
    first.bbox.x1 = 600;
    first.bbox.x2 = 640;
    const infos = [1, 2, 3].map((i) => s.push(frame(i * STEP_MS, [sure(20000, 0.8)])));
    const last = lastOf(infos);
    expect(last?.stable).toBe(true);
    expect(last?.consensus?.[0]?.confidence).toBeCloseTo(0.8, 9);
  });

  it('đầu vào đóng băng vẫn chạy được', () => {
    const s = createTemporalStabilizer(CONFIG);
    const frozen = Object.freeze([Object.freeze(makeDetection({ id: '1-0', bbox: Object.freeze({ ...LEFT }) }))]);
    expect(() => {
      for (let i = 0; i < 4; i++) s.push({ timestamp: i * STEP_MS, valid: true, sure: frozen });
    }).not.toThrow();
  });
});

describe('createTemporalStabilizer · cấu hình', () => {
  it.each([
    { name: 'windowSize 0', patch: { windowSize: 0 } },
    { name: 'windowSize không nguyên', patch: { windowSize: 2.5 } },
    { name: 'minAgree 0', patch: { minAgree: 0 } },
    { name: 'minAgree lớn hơn windowSize', patch: { minAgree: 6 } },
    { name: 'minAgree không nguyên', patch: { minAgree: 3.5 } },
    { name: 'matchIou 0', patch: { matchIou: 0 } },
    { name: 'matchIou lớn hơn 1', patch: { matchIou: 1.2 } },
    { name: 'maxAgeMs âm', patch: { maxAgeMs: -1 } },
    { name: 'maxAgeMs NaN', patch: { maxAgeMs: Number.NaN } },
  ])('ném RangeError khi $name', ({ patch }) => {
    expect(() => createTemporalStabilizer({ ...CONFIG, ...patch })).toThrow(RangeError);
  });

  it.each([
    { name: 'cửa sổ một khung, minAgree 1', config: { ...CONFIG, windowSize: 1, minAgree: 1 }, pattern: 'A', stable: true },
    { name: 'maxAgeMs vô hạn tắt việc loại theo tuổi', config: { ...CONFIG, maxAgeMs: Number.POSITIVE_INFINITY }, pattern: 'AAAA', stable: true },
    { name: 'minAgree 2 thì hai khung là đủ', config: { ...CONFIG, minAgree: 2 }, pattern: 'AA', stable: true },
  ])('chấp nhận $name', ({ config, pattern, stable }) => {
    expect(lastOf(feedPattern(createTemporalStabilizer(config), pattern))?.stable).toBe(stable);
  });
});

describe('matchDetections · ghép hộp giữa hai khung', () => {
  const m = (denomination: Denomination, bbox: BBox): MatchableBox => ({ denomination, bbox });
  const base = box(0, 0, 100, 100);

  it.each([
    { name: 'hai hộp giống hệt', a: [m(20000, base)], b: [m(20000, base)], expected: [0] },
    { name: 'IoU đúng ngưỡng 0,5 thì ghép được (so sánh ≥)', a: [m(20000, base)], b: [m(20000, box(0, 0, 100, 50))], expected: [0] },
    { name: 'IoU 0,49 thì không ghép', a: [m(20000, base)], b: [m(20000, box(0, 0, 100, 49))], expected: null },
    { name: 'khác mệnh giá', a: [m(20000, base)], b: [m(50000, base)], expected: null },
    { name: 'khác số tờ', a: [m(20000, base)], b: [m(20000, base), m(20000, box(300, 0, 400, 100))], expected: null },
    { name: 'cùng số tờ nhưng khác đa tập mệnh giá', a: [m(20000, LEFT), m(20000, RIGHT)], b: [m(20000, LEFT), m(50000, RIGHT)], expected: null },
    { name: 'hai tờ đổi chỗ cho nhau thì không ghép được dù cùng đa tập', a: [m(20000, LEFT), m(50000, RIGHT)], b: [m(50000, LEFT), m(20000, RIGHT)], expected: null },
    { name: 'thứ tự trong mảng khác nhau nhưng vị trí khớp', a: [m(20000, LEFT), m(50000, RIGHT)], b: [m(50000, RIGHT), m(20000, LEFT)], expected: [1, 0] },
    { name: 'hộp suy biến không ghép được', a: [m(20000, box(5, 5, 5, 50))], b: [m(20000, box(5, 5, 5, 50))], expected: null },
  ])('$name', ({ a, b, expected }) => {
    expect(matchDetections(a, b, 0.5)).toEqual(expected);
  });

  it('một hộp cũ không thể được ghép cho hai hộp mới', () => {
    const a = [m(20000, box(0, 0, 100, 100)), m(20000, box(60, 0, 160, 100))];
    const b = [m(20000, box(30, 0, 130, 100)), m(20000, box(300, 0, 400, 100))];
    expect(matchDetections(a, b, 0.5)).toBeNull();
  });

  it('ghép tham lam theo IoU giảm dần tìm đủ cặp mà ghép theo thứ tự chỉ số sẽ bỏ lỡ', () => {
    // b[0] (x = 60) là lựa chọn duy nhất của a[1] (x = 62, IoU 0,96) nhưng cũng là ứng viên đầu tiên của a[0] (x = 32, IoU 0,56);
    // b[1] (x = 0) chỉ vừa đủ cho a[0] (IoU 0,52). Phải ưu tiên cặp IoU cao nhất thì mới ghép đủ.
    const a = [m(20000, box(32, 0, 132, 100)), m(20000, box(62, 0, 162, 100))];
    const b = [m(20000, box(60, 0, 160, 100)), m(20000, box(0, 0, 100, 100))];
    expect(matchDetections(a, b, 0.5)).toEqual([1, 0]);
  });

  it('ưu tiên cặp IoU cao nhất trước (giảm dần), không phải thấp nhất', () => {
    // a[1] chỉ hợp b[1] (IoU 0,96); a[0] hợp b[0] (0,90) và b[1] (0,52). Ưu tiên IoU thấp trước sẽ để a[0] chiếm b[1] rồi bỏ lỡ a[1].
    const a = [m(20000, box(5, 0, 105, 100)), m(20000, box(39, 0, 139, 100))];
    const b = [m(20000, box(0, 0, 100, 100)), m(20000, box(37, 0, 137, 100))];
    expect(matchDetections(a, b, 0.5)).toEqual([0, 1]);
  });

  it('không sửa đầu vào', () => {
    const a = Object.freeze([Object.freeze(m(20000, Object.freeze(base)))]);
    expect(() => matchDetections(a, a, 0.5)).not.toThrow();
  });
});

describe('isFrameValid · điều kiện khung hợp lệ', () => {
  it.each([
    { name: 'một tờ chắc, không cờ nào', analysis: makeSingleSureAnalysis(), expected: true },
    { name: 'không có tờ nào', analysis: makeAnalysis(), expected: false },
    { name: 'chỉ có tờ chưa chắc', analysis: makeUnsureAnalysis(), expected: false },
    {
      name: 'có tờ chắc nhưng kèm một tờ chưa chắc',
      analysis: makeSingleSureAnalysis(20000, { unsure: [makeDetection({ id: '1-1', confidence: 0.5 })] }),
      expected: false,
    },
    { name: 'chồng lấn', analysis: makeOverlapAnalysis(), expected: false },
    { name: 'xung đột lớp', analysis: makeConflictAnalysis(), expected: false },
    {
      name: 'quá nhỏ, chạm mép, mờ và tối không làm khung mất hợp lệ',
      analysis: makeSingleSureAnalysis(20000, {
        position: { tooSmall: true, partial: true },
        quality: { blurScore: 1, blurry: true, brightness: 5, lowLight: true },
      }),
      expected: true,
    },
  ])('$name', ({ analysis, expected }) => {
    expect(isFrameValid(analysis)).toBe(expected);
  });
});