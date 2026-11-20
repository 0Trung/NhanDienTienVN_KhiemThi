// Chỉ số an toàn của một lần phát lại (theo kịch bản) và tổng hợp nhiều kịch bản.
// Định nghĩa (xem tools/README.md):
// - Unsafe Read: lần công bố có tổng ≠ sự thật tại khung đó (không có tiền mà vẫn đọc cũng là Unsafe Read).
// - Từ chối đúng: kịch bản kỳ vọng REJECT mà không có lần công bố nào.
// - Đọc lặp: công bố lại ĐÚNG tập mệnh giá của lần công bố liền trước khi tiền chưa rời khung.
import type { Denomination } from '../../src/contracts';
import { makeRate, meanOrNull } from '../shared/format';
import type { Rate } from '../shared/format';
import type { FrameRecord, PublicationRecord, ReplayOutcome } from './replay';
import type { Expectation, Scenario } from './scenario';

/** Chi tiết một lần đọc sai: đủ để trả lời "kịch bản nào, khung nào, vì sao". */
export interface UnsafeRead {
  scenarioId: string;
  seed: number;
  slot: number;
  frameId: number;
  atMs: number;
  announced: Denomination[];
  announcedTotal: number;
  truth: readonly Denomination[] | null;
  truthTotal: number | null;
  /** Nguyên nhân bằng tiếng Việt. */
  cause: string;
  /** Mã lý do của engine. */
  reasons: string[];
}

export interface ScenarioMetrics {
  scenarioId: string;
  name: string;
  seed: number;
  knownLimitation: boolean;
  expectation: Expectation;
  /** Số khung thực sự tới analyzer (không tính khung rơi). */
  deliveredFrames: number;
  publications: number;
  correctReads: number;
  unsafeReads: number;
  /** Công bố có tổng đúng nhưng tập mệnh giá sai (không tính vào Unsafe Read, nhưng cần xem). */
  setMismatches: number;
  repeatedReads: number;
  /** null khi kỳ vọng PUBLISH; ngược lại true nếu không công bố gì. */
  correctRejection: boolean | null;
  /** null khi kỳ vọng REJECT; ngược lại true nếu cần đọc mà không có lần công bố đúng nào. */
  missedRead: boolean | null;
  /** Từ lúc tiền xuất hiện đến lần công bố đầu: số khung tới analyzer và mili-giây giả. null nếu không có. */
  firstPublication: { frames: number; ms: number } | null;
  guidanceFrames: number;
  unsafeDetails: UnsafeRead[];
}

export interface AggregateMetrics {
  scenarios: number;
  publications: number;
  unsafeReads: number;
  /** Unsafe Read Rate = đọc sai / công bố. */
  unsafeReadRate: Rate;
  repeatedReads: number;
  repeatedReadRate: Rate;
  /** Rejection Rate = từ chối đúng / kịch bản kỳ vọng REJECT. */
  rejectionRate: Rate;
  /** Đọc đúng khi cần đọc = kịch bản PUBLISH có ít nhất một lần đọc đúng / kịch bản PUBLISH (chặn lối "từ chối tất cả cho an toàn"). */
  readSuccessRate: Rate;
  setMismatches: number;
  firstPublicationFramesMean: number | null;
  firstPublicationMsMean: number | null;
  firstPublicationMsMax: number | null;
  /** Tỷ lệ khung có lời hướng dẫn trên các khung tới analyzer. */
  guidanceShare: Rate;
}

const sequenceKey = (d: readonly number[]): string => d.join(',');

/** Số khung liên tiếp dài nhất KHÔNG có tiền thật nằm giữa hai khe (không tính chính hai khe), tính cả khung rơi. */
function longestMoneyFreeRun(frames: readonly FrameRecord[], afterSlot: number, beforeSlot: number): number {
  let run = 0;
  let longest = 0;
  for (const f of frames) {
    if (f.slot <= afterSlot || f.slot >= beforeSlot) continue;
    run = f.moneyPresent ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Đếm đọc lặp: cùng tập với lần công bố liền trước và khoảng giữa có ít hơn leaveFrames khung không tiền. */
function countRepeatedReads(pubs: readonly PublicationRecord[], frames: readonly FrameRecord[], leaveFrames: number): number {
  let repeated = 0;
  for (let i = 1; i < pubs.length; i++) {
    const prev = pubs[i - 1];
    const cur = pubs[i];
    if (prev === undefined || cur === undefined) continue;
    const same = sequenceKey(prev.denominations) === sequenceKey(cur.denominations);
    if (same && longestMoneyFreeRun(frames, prev.slot, cur.slot) < leaveFrames) repeated++;
  }
  return repeated;
}

function describeCause(p: PublicationRecord): string {
  if (p.truth === null) return 'không có tiền trong cảnh nhưng hệ thống vẫn đọc';
  if (p.truth.length !== p.denominations.length) {
    return `mô hình/bộ phân tích thấy ${p.denominations.length} tờ, sự thật có ${p.truth.length} tờ`;
  }
  return `sai mệnh giá: đọc ${p.denominations.join('+')} nhưng sự thật ${p.truth.join('+')}`;
}

function firstPublicationOf(outcome: ReplayOutcome): ScenarioMetrics['firstPublication'] {
  const firstMoney = outcome.frames.find((f) => f.moneyPresent);
  if (firstMoney === undefined) return null;
  const first = outcome.publications.find((p) => p.slot >= firstMoney.slot);
  if (first === undefined) return null;
  const frames = outcome.frames.filter((f) => !f.dropped && f.slot >= firstMoney.slot && f.slot <= first.slot).length;
  return { frames, ms: first.atMs - firstMoney.atMs };
}

/**
 * Tính chỉ số một kịch bản.
 * @param leaveFrames Số khung không tiền liên tiếp để coi là "tiền đã rời khung" (mặc định lấy config.decision.emptyFramesToReset).
 */
export function computeScenarioMetrics(scenario: Scenario, outcome: ReplayOutcome, leaveFrames: number): ScenarioMetrics {
  const pubs = outcome.publications;
  const unsafe = pubs.filter((p) => !p.correct);
  const correct = pubs.length - unsafe.length;
  return {
    scenarioId: scenario.id,
    name: scenario.name,
    seed: outcome.seed,
    knownLimitation: scenario.knownLimitation,
    expectation: scenario.expectation,
    deliveredFrames: outcome.frames.filter((f) => !f.dropped).length,
    publications: pubs.length,
    correctReads: correct,
    unsafeReads: unsafe.length,
    setMismatches: pubs.filter((p) => p.correct && !p.exactSet).length,
    repeatedReads: countRepeatedReads(pubs, outcome.frames, leaveFrames),
    correctRejection: scenario.expectation === 'REJECT' ? pubs.length === 0 : null,
    missedRead: scenario.expectation === 'PUBLISH' ? correct === 0 : null,
    firstPublication: firstPublicationOf(outcome),
    guidanceFrames: outcome.frames.filter((f) => f.guidance).length,
    unsafeDetails: unsafe.map((p) => ({
      scenarioId: scenario.id,
      seed: outcome.seed,
      slot: p.slot,
      frameId: p.frameId,
      atMs: p.atMs,
      announced: p.denominations,
      announcedTotal: p.total,
      truth: p.truth,
      truthTotal: p.truthTotal,
      cause: describeCause(p),
      reasons: p.reasons,
    })),
  };
}

const sum = (xs: readonly number[]): number => xs.reduce((s, v) => s + v, 0);

/** Tổng hợp nhiều kịch bản (một nhóm: chính hoặc hạn chế đã biết). Danh sách rỗng cho mọi tỷ lệ N/A. */
export function aggregateMetrics(list: readonly ScenarioMetrics[]): AggregateMetrics {
  const publications = sum(list.map((m) => m.publications));
  const unsafeReads = sum(list.map((m) => m.unsafeReads));
  const repeatedReads = sum(list.map((m) => m.repeatedReads));
  const rejectCases = list.filter((m) => m.correctRejection !== null);
  const publishCases = list.filter((m) => m.missedRead !== null);
  const firsts = list.flatMap((m) => (m.firstPublication === null ? [] : [m.firstPublication]));
  const frameMs = firsts.map((f) => f.ms);
  return {
    scenarios: list.length,
    publications,
    unsafeReads,
    unsafeReadRate: makeRate(unsafeReads, publications),
    repeatedReads,
    repeatedReadRate: makeRate(repeatedReads, publications),
    rejectionRate: makeRate(rejectCases.filter((m) => m.correctRejection === true).length, rejectCases.length),
    readSuccessRate: makeRate(publishCases.filter((m) => m.missedRead === false).length, publishCases.length),
    setMismatches: sum(list.map((m) => m.setMismatches)),
    firstPublicationFramesMean: meanOrNull(firsts.map((f) => f.frames)),
    firstPublicationMsMean: meanOrNull(frameMs),
    firstPublicationMsMax: frameMs.length === 0 ? null : Math.max(...frameMs),
    guidanceShare: makeRate(sum(list.map((m) => m.guidanceFrames)), sum(list.map((m) => m.deliveredFrames))),
  };
}

/** Tách kết quả thành nhóm chính (tính vào Unsafe Read Rate) và nhóm hạn chế đã biết (báo riêng, không giấu). */
export function splitByLimitation(list: readonly ScenarioMetrics[]): { main: ScenarioMetrics[]; known: ScenarioMetrics[] } {
  return { main: list.filter((m) => !m.knownLimitation), known: list.filter((m) => m.knownLimitation) };
}