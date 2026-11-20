// Dựng báo cáo markdown của bộ kịch bản. Hàm thuần: nhận SweepResult, trả chuỗi; không in, không ghi file.
import { formatMs, formatOptional, formatRate, renderTable } from '../shared/format';
import type { AggregateMetrics, ScenarioMetrics, UnsafeRead } from './metrics';
import { designGoalMet } from './suite';
import type { SweepResult } from './suite';

/** Số seed tối đa liệt kê trong một dòng cảnh báo. */
const MAX_SEEDS_LISTED = 5;
/** Số chữ số thập phân khi in số khung trung bình và tỷ lệ khung hướng dẫn. */
const FRAME_DIGITS = 1;

const yesNo = (value: boolean | null): string => (value === null ? '—' : value ? 'có' : 'không');
const sequence = (d: readonly number[] | null): string => (d === null ? 'không có tiền' : d.join('+'));

function firstPublicationCells(m: ScenarioMetrics): [string, string] {
  if (m.firstPublication === null) return ['—', '—'];
  return [String(m.firstPublication.frames), formatMs(m.firstPublication.ms)];
}

function guidanceCell(m: ScenarioMetrics): string {
  return m.deliveredFrames === 0 ? '—' : `${m.guidanceFrames}/${m.deliveredFrames}`;
}

function scenarioRows(list: readonly ScenarioMetrics[], withReproduced: boolean): string[][] {
  return list.map((m) => {
    const [frames, ms] = firstPublicationCells(m);
    const cells = [
      `\`${m.scenarioId}\``, m.expectation, String(m.publications), String(m.unsafeReads), String(m.repeatedReads),
      yesNo(m.correctRejection), frames, ms, guidanceCell(m),
    ];
    return withReproduced ? [...cells, yesNo(m.unsafeReads > 0)] : cells;
  });
}

const SCENARIO_HEADERS = ['Kịch bản', 'Kỳ vọng', 'Công bố', 'Đọc sai', 'Đọc lặp', 'Từ chối đúng', 'Khung→đọc đầu', 'ms→đọc đầu', 'Khung có hướng dẫn'];

function aggregateTable(a: AggregateMetrics): string {
  return renderTable(['Chỉ số', 'Giá trị'], [
    ['Số kịch bản × seed', String(a.scenarios)],
    ['Số lần công bố', String(a.publications)],
    ['**Unsafe Read Rate** (đọc sai / công bố)', formatRate(a.unsafeReadRate)],
    ['Đọc lặp (lặp / công bố)', formatRate(a.repeatedReadRate)],
    ['Rejection Rate (từ chối đúng / ca cần từ chối)', formatRate(a.rejectionRate)],
    ['Đọc đúng khi cần đọc (ca cần đọc)', formatRate(a.readSuccessRate)],
    ['Công bố đúng tổng nhưng sai tập mệnh giá', String(a.setMismatches)],
    ['Thời gian tới lần đọc đầu (khung, trung bình)', formatOptional(a.firstPublicationFramesMean, FRAME_DIGITS)],
    ['Thời gian tới lần đọc đầu (ms giả, trung bình / lớn nhất)', `${formatMs(a.firstPublicationMsMean)} / ${formatMs(a.firstPublicationMsMax)}`],
    ['Khung có hướng dẫn (hướng dẫn / khung tới analyzer)', formatRate(a.guidanceShare)],
  ]);
}

/** Cảnh báo không làm hỏng lệnh: đọc lặp, không từ chối khi cần từ chối, bỏ lỡ lần đọc cần có (nhóm chính). */
export function collectWarnings(perSeed: readonly (readonly ScenarioMetrics[])[]): string[] {
  const found = new Map<string, number[]>();
  for (const metrics of perSeed) {
    for (const m of metrics) {
      if (m.knownLimitation) continue;
      const issues: string[] = [];
      if (m.repeatedReads > 0) issues.push('đọc lặp');
      if (m.correctRejection === false) issues.push('không từ chối khi cần từ chối');
      if (m.missedRead === true) issues.push('bỏ lỡ lần đọc cần có');
      for (const issue of issues) {
        const key = `\`${m.scenarioId}\`: ${issue}`;
        found.set(key, [...(found.get(key) ?? []), m.seed]);
      }
    }
  }
  return [...found].map(([key, seeds]) => {
    const shown = seeds.slice(0, MAX_SEEDS_LISTED).join(', ');
    return `- ${key} — ${seeds.length} seed (${shown}${seeds.length > MAX_SEEDS_LISTED ? ', …' : ''})`;
  });
}

function describeUnsafe(u: UnsafeRead): string {
  const when = `khung #${u.frameId} (khe ${u.slot}, ${formatMs(u.atMs)} giả)`;
  const truth = u.truthTotal === null ? 'không có tiền' : `${u.truthTotal} [${sequence(u.truth)}]`;
  return `- \`${u.scenarioId}\` · seed ${u.seed} · ${when}: đọc ${u.announcedTotal} [${sequence(u.announced)}], sự thật ${truth}. Vì sao: ${u.cause}. Mã engine: ${u.reasons.join(', ')}.`;
}

/** Báo cáo đầy đủ: bảng từng kịch bản (seed đầu), tổng hợp nhóm chính, nhóm hạn chế đã biết, cảnh báo, kết luận. */
export function renderReport(sweep: SweepResult): string {
  const first = sweep.perSeed[0] ?? [];
  const main = first.filter((m) => !m.knownLimitation);
  const known = first.filter((m) => m.knownLimitation);
  const out: string[] = [];
  out.push('# Phát lại kịch bản qua FrameAnalyzer + DecisionEngine');
  out.push(`Seed: ${sweep.seeds[0] ?? '—'}${sweep.seeds.length > 1 ? `…${sweep.seeds[sweep.seeds.length - 1]}` : ''} (${sweep.seeds.length} seed). Bảng theo kịch bản là của seed đầu; bảng tổng hợp cộng dồn mọi seed.`);
  out.push('## Nhóm chính (tính vào Unsafe Read Rate)');
  out.push(renderTable(SCENARIO_HEADERS, scenarioRows(main, false)));
  out.push('### Tổng hợp nhóm chính');
  out.push(aggregateTable(sweep.main));
  out.push('## Hạn chế đã biết (báo RIÊNG, không tính vào chỉ số chính)');
  out.push(known.length === 0
    ? 'Không có kịch bản nào được đánh dấu knownLimitation.'
    : renderTable([...SCENARIO_HEADERS, 'Tái hiện'], scenarioRows(known, true)));
  out.push(`Tổng hợp: ${sweep.known.publications} lần công bố, ${sweep.known.unsafeReads} lần đọc sai (${formatRate(sweep.known.unsafeReadRate)}).`);
  if (known.some((m) => m.unsafeReads === 0)) {
    out.push('Lưu ý: có hạn chế đã biết KHÔNG còn tái hiện ở seed đầu; cân nhắc có nên bỏ cờ knownLimitation hay không.');
  }
  const warnings = collectWarnings(sweep.perSeed);
  out.push('## Cảnh báo (không làm hỏng lệnh)');
  out.push(warnings.length === 0 ? 'Không có.' : warnings.join('\n'));
  out.push('## Kết luận');
  if (designGoalMet(sweep)) {
    out.push(`ĐẠT: Unsafe Read Rate (nhóm chính) = ${formatRate(sweep.main.unsafeReadRate)}.`);
  } else if (sweep.mainUnsafe.length === 0) {
    out.push('KHÔNG KẾT LUẬN: nhóm chính không công bố lần nào nên Unsafe Read Rate = 0 chỉ là hệ quả của việc từ chối tất cả.');
  } else {
    out.push(`KHÔNG ĐẠT: ${sweep.mainUnsafe.length} lần đọc sai ở nhóm chính (mục tiêu thiết kế là 0). Chi tiết:`);
    out.push(sweep.mainUnsafe.map(describeUnsafe).join('\n'));
  }
  return `${out.join('\n\n')}\n`;
}