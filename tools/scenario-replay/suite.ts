// Chạy cả bộ kịch bản (một hoặc nhiều seed) và gom chỉ số theo nhóm chính / hạn chế đã biết.
import type { AppConfig } from '../../src/contracts';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { aggregateMetrics, computeScenarioMetrics, splitByLimitation } from './metrics';
import type { AggregateMetrics, ScenarioMetrics, UnsafeRead } from './metrics';
import { DEFAULT_SEED, replayScenario } from './replay';
import type { ReplayDeps } from './replay';
import type { Scenario } from './scenario';

export interface SweepOptions {
  config?: AppConfig;
  /** Seed đầu tiên; các seed kế tiếp là seed + 1, seed + 2, ... */
  seed?: number;
  /** Số seed cần quét (mặc định 1). */
  seedCount?: number;
  speechDurationMs?: number;
}

export interface SweepResult {
  seeds: number[];
  /** Chỉ số từng kịch bản theo từng seed (theo thứ tự seed rồi kịch bản). */
  perSeed: ScenarioMetrics[][];
  /** Tổng hợp trên MỌI seed, nhóm chính: các kịch bản không phải hạn chế đã biết. */
  main: AggregateMetrics;
  /** Tổng hợp trên mọi seed, nhóm hạn chế đã biết (báo riêng, không giấu). */
  known: AggregateMetrics;
  /** Mọi lần đọc sai ở nhóm chính; khác rỗng nghĩa là mục tiêu thiết kế bị vi phạm. */
  mainUnsafe: UnsafeRead[];
}

/**
 * Mục tiêu thiết kế đạt khi nhóm chính không có lần đọc sai nào VÀ có công bố thật.
 * Điều kiện thứ hai chặn lối "từ chối tất cả": không công bố gì thì Unsafe Read Rate = 0 một cách vô nghĩa.
 */
export function designGoalMet(sweep: SweepResult): boolean {
  return sweep.mainUnsafe.length === 0 && sweep.main.publications > 0;
}

/** Chạy mọi kịch bản với từng seed rồi tổng hợp. XÁC ĐỊNH theo (scenarios, deps, options). */
export function runSweep(scenarios: readonly Scenario[], deps: ReplayDeps, options: SweepOptions = {}): SweepResult {
  const config = options.config ?? DEFAULT_CONFIG;
  const firstSeed = options.seed ?? DEFAULT_SEED;
  const seedCount = options.seedCount ?? 1;
  if (!Number.isInteger(seedCount) || seedCount < 1) {
    throw new RangeError(`seedCount phải là số nguyên ≥ 1, nhận ${String(seedCount)}`);
  }
  const seeds = Array.from({ length: seedCount }, (_, i) => firstSeed + i);
  const perSeed = seeds.map((seed) =>
    scenarios.map((s) =>
      computeScenarioMetrics(
        s,
        replayScenario(s, deps, { config, seed, speechDurationMs: options.speechDurationMs }),
        config.decision.emptyFramesToReset,
      ),
    ),
  );
  const { main, known } = splitByLimitation(perSeed.flat());
  return {
    seeds,
    perSeed,
    main: aggregateMetrics(main),
    known: aggregateMetrics(known),
    mainUnsafe: main.flatMap((m) => m.unsafeDetails),
  };
}