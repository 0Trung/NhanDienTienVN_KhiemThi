/** Đồng hồ trả mili-giây. Được tiêm qua tham số để logic nghiệp vụ test được. */
export type Clock = () => number;

/** Đồng hồ thật: performance.now() (cùng hệ quy chiếu với FrameMeta.timestamp). */
export const systemClock: Clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Đồng hồ giả cho test: chỉ chạy khi gọi advance. */
export function createFakeClock(start = 0): { now: Clock; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`advance cần số mili-giây hữu hạn và ≥ 0, nhận được ${String(ms)}`);
      }
      t += ms;
    },
  };
}