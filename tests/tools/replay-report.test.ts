import { describe, expect, it } from 'vitest';
import { collectWarnings, renderReport } from '../../tools/scenario-replay/report';
import { runSweep } from '../../tools/scenario-replay/suite';
import { fakeDeps, oneNote, recognition, scenarioOf } from './helpers';

const announce50k = () => fakeDeps((n, now) => (n === 0 ? recognition(50000, [50000], now) : null)).deps;
/** Công bố ở lần phân tích thứ 0 và thứ 10 (sau khi giọng nói giả 2 giây đã xong): hai lần cùng một tập. */
const announceTwice = () => fakeDeps((n, now) => (n === 0 || n === 10 ? recognition(50000, [50000], now) : null)).deps;

const normalOk = scenarioOf(oneNote(30), { id: 'normal-ok', groundTruth: [50000] });
const normalBad = scenarioOf(oneNote(30), { id: 'normal-bad', groundTruth: [20000] });
const knownMiss = scenarioOf(oneNote(30), { id: 'known-miss', groundTruth: [20000], knownLimitation: true });
const knownFixed = scenarioOf(oneNote(30), { id: 'known-fixed', groundTruth: [50000], knownLimitation: true });

describe('renderReport · bố cục', () => {
  const text = renderReport(runSweep([normalOk, knownMiss], announce50k()));

  it('có đủ các phần theo thứ tự: nhóm chính, hạn chế đã biết, cảnh báo, kết luận', () => {
    const order = ['## Nhóm chính', '## Hạn chế đã biết', '## Cảnh báo', '## Kết luận'].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('kịch bản hạn chế đã biết chỉ xuất hiện ở phần riêng, không lẫn vào bảng chính', () => {
    const knownSection = text.indexOf('## Hạn chế đã biết');
    expect(text.indexOf('`known-miss`')).toBeGreaterThan(knownSection);
    expect(text.indexOf('`normal-ok`')).toBeLessThan(knownSection);
  });

  it('phần riêng nêu số lần đọc sai của hạn chế đã biết', () => {
    expect(text).toContain('Tổng hợp: 1 lần công bố, 1 lần đọc sai');
  });

  it('kết luận ĐẠT kèm tử số và mẫu số của Unsafe Read Rate nhóm chính', () => {
    expect(text).toContain('ĐẠT: Unsafe Read Rate (nhóm chính) = 0,0% (0/1)');
  });
});

describe('renderReport · các kết luận khác', () => {
  it('đọc sai ở kịch bản thường: KHÔNG ĐẠT, nói rõ kịch bản, khung, nguyên nhân và mã engine', () => {
    const text = renderReport(runSweep([normalOk, normalBad], announce50k()));
    expect(text).toContain('KHÔNG ĐẠT: 1 lần đọc sai ở nhóm chính');
    expect(text).toMatch(/`normal-bad` · seed 1 · khung #1 \(khe 0, 0 ms giả\): đọc 50000 \[50000\], sự thật 20000 \[20000\]\. Vì sao: sai mệnh giá/);
    expect(text).toContain('Mã engine: FAKE');
  });

  it('không công bố lần nào: KHÔNG KẾT LUẬN thay vì ĐẠT', () => {
    const text = renderReport(runSweep([normalOk], fakeDeps(() => null).deps));
    expect(text).toContain('KHÔNG KẾT LUẬN');
    expect(text).not.toContain('ĐẠT:');
  });

  it('không có kịch bản hạn chế đã biết thì nói rõ', () => {
    expect(renderReport(runSweep([normalOk], announce50k()))).toContain('Không có kịch bản nào được đánh dấu knownLimitation.');
  });

  it('hạn chế đã biết không còn tái hiện thì nhắc cân nhắc bỏ cờ', () => {
    expect(renderReport(runSweep([normalOk, knownFixed], announce50k()))).toContain('KHÔNG còn tái hiện');
  });

  it('nhiều seed: nêu khoảng seed và số seed', () => {
    const text = renderReport(runSweep([normalOk], announce50k(), { seed: 5, seedCount: 3 }));
    expect(text).toContain('Seed: 5…7 (3 seed)');
  });
});

describe('collectWarnings', () => {
  it('đọc lặp ở kịch bản thường được cảnh báo kèm seed', () => {
    const sweep = runSweep([normalOk], announceTwice(), { seed: 3, seedCount: 2 });
    expect(collectWarnings(sweep.perSeed)).toEqual(['- `normal-ok`: đọc lặp — 2 seed (3, 4)']);
  });

  it('hạn chế đã biết không sinh cảnh báo', () => {
    const sweep = runSweep([knownMiss], announceTwice());
    expect(collectWarnings(sweep.perSeed)).toEqual([]);
  });

  it('kịch bản cần từ chối mà vẫn đọc, và kịch bản cần đọc mà không đọc, đều bị cảnh báo', () => {
    const rejecting = scenarioOf(oneNote(30), { id: 'must-reject', expectation: 'REJECT', groundTruth: null });
    const sweep = runSweep([rejecting, normalOk], announce50k());
    const silentSweep = runSweep([normalOk], fakeDeps(() => null).deps);
    expect(collectWarnings(sweep.perSeed)).toEqual(['- `must-reject`: không từ chối khi cần từ chối — 1 seed (1)']);
    expect(collectWarnings(silentSweep.perSeed)).toEqual(['- `normal-ok`: bỏ lỡ lần đọc cần có — 1 seed (1)']);
  });
});