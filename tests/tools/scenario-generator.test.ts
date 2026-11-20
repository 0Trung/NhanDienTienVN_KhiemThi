import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/app-config';
import { measureBlur } from '../../src/analyzer/blur-detector';
import { measureBrightness } from '../../src/analyzer/brightness-analyzer';
import type { Denomination } from '../../src/contracts';
import { deriveGeneratorOptions, generateFrames } from '../../tools/scenario-replay/scenario';
import type { FrameQuality, GenerationSpec } from '../../tools/scenario-replay/scenario';
import { SINGLE_BOX } from '../../tools/scenario-replay/scenarios/shared';
import { NOISY_SINGLE_SCENARIO } from '../../tools/scenario-replay/scenarios/single-notes';
import { OPTIONS, fingerprint, oneNote, scenarioOf } from './helpers';

const NOISY = scenarioOf(oneNote(40, { confidenceSigma: 0.05, positionSigmaPx: 4, dropRate: 0.2, blurRate: 0.1, darkRate: 0.1 }));

describe('generateFrames · lặp lại theo seed', () => {
  it.each([1, 7, 2026])('seed %i cho hai lần sinh giống hệt nhau', (seed) => {
    expect(fingerprint(generateFrames(NOISY, seed, OPTIONS))).toBe(fingerprint(generateFrames(NOISY, seed, OPTIONS)));
  });

  it('hai seed khác nhau cho dãy khung khác nhau khi có nhiễu', () => {
    expect(fingerprint(generateFrames(NOISY, 1, OPTIONS))).not.toBe(fingerprint(generateFrames(NOISY, 2, OPTIONS)));
  });

  it('kịch bản nhiễu có sẵn của bộ cũng lặp lại theo seed', () => {
    const a = fingerprint(generateFrames(NOISY_SINGLE_SCENARIO, 5, OPTIONS));
    expect(a).toBe(fingerprint(generateFrames(NOISY_SINGLE_SCENARIO, 5, OPTIONS)));
  });

  it('đổi dropRate không làm lệch nhiễu của các khung còn lại', () => {
    const base = generateFrames(scenarioOf(oneNote(30, { confidenceSigma: 0.05, positionSigmaPx: 4 })), 3, OPTIONS);
    const dropping = generateFrames(scenarioOf(oneNote(30, { confidenceSigma: 0.05, positionSigmaPx: 4, dropRate: 0.5 })), 3, OPTIONS);
    const survivors = dropping.filter((f) => !f.dropped);
    expect(survivors.length).toBeGreaterThan(0);
    for (const f of survivors) expect(f.result?.detections).toEqual(base[f.slot]?.result?.detections);
  });
});

describe('generateFrames · khung không nhiễu', () => {
  const frames = generateFrames(scenarioOf(oneNote(4)), 1, OPTIONS);

  it('mốc thời gian là slot × chu kỳ khung, frameId bắt đầu từ 1', () => {
    expect(frames.map((f) => [f.frameId, f.atMs])).toEqual([[1, 0], [2, 333], [3, 666], [4, 999]]);
    expect(frames.map((f) => f.result?.meta.timestamp)).toEqual([0, 333, 666, 999]);
  });

  it('hộp, mệnh giá và id detection đúng như mô tả', () => {
    const d = frames[0]?.result?.detections[0];
    expect(d).toMatchObject({ id: '1-0', denomination: 20000, confidence: 0.9, bbox: SINGLE_BOX, frameId: 1, timestamp: 0 });
  });

  it('chu kỳ khung và cỡ ảnh xám suy ra từ cấu hình', () => {
    expect(deriveGeneratorOptions(DEFAULT_CONFIG)).toMatchObject({
      frameWidth: 640, frameHeight: 480, frameIntervalMs: 333, grayWidth: 256, grayHeight: 192, confLow: 0.25,
    });
  });
});

describe('generateFrames · khung rơi, mờ, tối', () => {
  it.each([
    { dropRate: 0, expectedDropped: 0 },
    { dropRate: 1, expectedDropped: 20 },
  ])('dropRate $dropRate làm rơi $expectedDropped/20 khung và khung rơi không có result', ({ dropRate, expectedDropped }) => {
    const frames = generateFrames(scenarioOf(oneNote(20, { dropRate })), 1, OPTIONS);
    expect(frames.filter((f) => f.dropped)).toHaveLength(expectedDropped);
    expect(frames.every((f) => f.dropped === (f.result === null))).toBe(true);
  });

  it.each<{ noise: Partial<Record<'blurRate' | 'darkRate', number>>; expected: FrameQuality }>([
    { noise: {}, expected: 'SHARP' },
    { noise: { blurRate: 1 }, expected: 'BLURRY' },
    { noise: { darkRate: 1 }, expected: 'DARK' },
  ])('noise $noise cho mọi khung chất lượng $expected', ({ noise, expected }) => {
    const frames = generateFrames(scenarioOf(oneNote(10, noise)), 1, OPTIONS);
    expect(new Set(frames.map((f) => f.quality))).toEqual(new Set([expected]));
  });

  it.each<{ quality: FrameQuality; blurry: boolean; lowLight: boolean }>([
    { quality: 'SHARP', blurry: false, lowLight: false },
    { quality: 'BLURRY', blurry: true, lowLight: false },
    { quality: 'DARK', blurry: false, lowLight: true },
  ])('ảnh $quality được bộ đo thật của analyzer phân loại blurry=$blurry, lowLight=$lowLight', ({ quality, blurry, lowLight }) => {
    const noise = quality === 'BLURRY' ? { blurRate: 1 } : quality === 'DARK' ? { darkRate: 1 } : {};
    const frame = generateFrames(scenarioOf(oneNote(1, noise)), 1, OPTIONS)[0]?.result;
    if (frame === undefined || frame === null) throw new Error('khung đầu phải tồn tại');
    expect(measureBlur(frame.gray, frame.meta, [], DEFAULT_CONFIG.analyzer.blurThreshold).blurry).toBe(blurry);
    expect(measureBrightness(frame.gray, DEFAULT_CONFIG.analyzer.lowLightMean).lowLight).toBe(lowLight);
  });
});

describe('generateFrames · nội dung detection', () => {
  const spec = (confidence: number | readonly number[]): GenerationSpec => ({
    phases: [{ frames: 2, objects: [{ denomination: 20000, box: SINGLE_BOX, confidence }] }],
  });

  it('bỏ hộp có độ tin cậy dưới confLow như mô hình thật', () => {
    const frames = generateFrames(scenarioOf(spec(0.2)), 1, OPTIONS);
    expect(frames.map((f) => f.result?.detections.length)).toEqual([0, 0]);
  });

  it('độ tin cậy dạng mảng xoay vòng theo chỉ số khung trong pha', () => {
    const frames = generateFrames(scenarioOf(spec([0.75, 0.4])), 1, OPTIONS);
    expect(frames.map((f) => f.result?.detections[0]?.confidence)).toEqual([0.75, 0.4]);
  });

  it('detection được sắp từ trái sang phải dù mô tả theo thứ tự ngược', () => {
    const right = { x1: 400, y1: 150, x2: 600, y2: 330 };
    const left = { x1: 40, y1: 150, x2: 240, y2: 330 };
    const frames = generateFrames(scenarioOf({
      phases: [{ frames: 1, objects: [
        { denomination: 50000, box: right, confidence: 0.9 },
        { denomination: 10000, box: left, confidence: 0.9 },
      ] }],
    }), 1, OPTIONS);
    expect(frames[0]?.result?.detections.map((d) => [d.id, d.denomination])).toEqual([['1-0', 10000], ['1-1', 50000]]);
  });
});

describe('generateFrames · sự thật theo pha', () => {
  const object = { denomination: 20000 as Denomination, box: SINGLE_BOX, confidence: 0.9 };

  it.each<{ name: string; truth?: readonly Denomination[] | null; objects: GenerationSpec['phases'][number]['objects']; expected: readonly Denomination[] | null }>([
    { name: 'pha không có vật thì không có tiền', objects: [], expected: null },
    { name: 'pha có vật dùng groundTruth của kịch bản', objects: [object], expected: [20000] },
    { name: 'pha ghi đè sự thật', objects: [object], truth: [50000], expected: [50000] },
    { name: 'pha khai không có tiền dù có vật (vật giống tiền)', objects: [object], truth: null, expected: null },
  ])('$name', ({ objects, truth, expected }) => {
    const phase = truth === undefined ? { frames: 1, objects } : { frames: 1, objects, truth };
    expect(generateFrames(scenarioOf({ phases: [phase] }), 1, OPTIONS)[0]?.truth).toEqual(expected);
  });

  it.each([-1, 1.5, Number.NaN])('phase.frames = %s bị từ chối bằng RangeError', (frames) => {
    expect(() => generateFrames(scenarioOf({ phases: [{ frames, objects: [] }] }), 1, OPTIONS)).toThrow(RangeError);
  });
});