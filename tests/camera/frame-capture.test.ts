import { describe, expect, it } from 'vitest';
import { createFrameCapture, sanitizeFps } from '../../src/camera/frame-capture';
import type { CapturedFrame } from '../../src/contracts';
import { BitmapCounter, FakeCallbackVideo, FakeVideo, createFakeTime, flush } from './camera-fakes';

/** Vòng lấy mẫu 2 fps (500 ms một khung) với đồng hồ giả; `frames` gom khung của handler mặc định. */
function setup(fps = 2, video: FakeVideo = new FakeVideo()) {
  const time = createFakeTime();
  const bitmaps = new BitmapCounter();
  const capture = createFrameCapture({ source: video, createBitmap: bitmaps.create, clock: time.clock, scheduler: time.scheduler, fps });
  const frames: CapturedFrame[] = [];
  const collect = (f: CapturedFrame): void => void frames.push(f);
  const timestamps = (): number[] => frames.map((f) => f.meta.timestamp);
  return { time, video, bitmaps, capture, frames, collect, timestamps };
}

describe('F3 — lấy mẫu tuần tự', () => {
  it('frameId tăng từ 1, timestamp lấy từ đồng hồ lúc chụp, kích thước theo bitmap; camera không đóng thay bên nhận', async () => {
    const t = setup();
    t.capture.addHandler(t.collect);
    t.capture.start();
    await t.time.advance(1000);
    expect(t.frames.map((f) => f.meta.frameId)).toEqual([1, 2, 3]);
    expect(t.timestamps()).toEqual([0, 500, 1000]);
    expect(t.frames[0]?.meta).toMatchObject({ width: 1280, height: 720 });
    expect(t.bitmaps.closed).toBe(0);
  });

  it('handler chậm: không chồng khung, khung kế bắt đầu ngay khi handler xong (đã bù thời gian)', async () => {
    const t = setup();
    let running = 0;
    let maxRunning = 0;
    t.capture.addHandler(async (f) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      t.collect(f);
      await t.time.sleep(1200); // chậm hơn khoảng 500 ms
      running -= 1;
    });
    t.capture.start();
    await t.time.advance(2500);
    expect(maxRunning).toBe(1);
    expect(t.timestamps()).toEqual([0, 1200, 2400]);
  });

  it('handler nhanh: hai lần BẮT ĐẦU cách nhau đúng 1000/fps, không cộng thêm thời gian handler', async () => {
    const t = setup();
    t.capture.addHandler(async (f) => {
      t.collect(f);
      await t.time.sleep(100);
    });
    t.capture.start();
    await t.time.advance(1000);
    expect(t.timestamps()).toEqual([0, 500, 1000]);
  });

  it('nhiều handler được gọi lần lượt, handler sau chờ handler trước; huỷ đăng ký thì không được gọi nữa', async () => {
    const t = setup();
    const order: string[] = [];
    t.capture.addHandler(async () => {
      order.push('a:start');
      await t.time.sleep(50);
      order.push('a:end');
    });
    const offB = t.capture.addHandler(() => void order.push('b'));
    t.capture.start();
    await t.time.advance(100);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
    offB();
    await t.time.advance(500);
    expect(order).toEqual(['a:start', 'a:end', 'b', 'a:start', 'a:end']);
  });

  it.each([
    { kind: 'ném đồng bộ', fail: (): void => { throw new Error('lỗi đồng bộ'); } },
    { kind: 'từ chối bất đồng bộ', fail: (): Promise<void> => Promise.reject(new Error('lỗi async')) },
  ])('handler $kind: bitmap được đóng và vòng lặp vẫn sống', async ({ fail }) => {
    const t = setup();
    let calls = 0;
    t.capture.addHandler(() => (calls += 1, fail()));
    t.capture.start();
    await t.time.advance(1000);
    expect([calls, t.bitmaps.created, t.bitmaps.open]).toEqual([3, 3, 0]);
  });

  it('không có handler: bitmap vẫn được đóng, vòng lặp vẫn sống', async () => {
    const t = setup();
    t.capture.start();
    await t.time.advance(1000);
    expect([t.bitmaps.created, t.bitmaps.open]).toEqual([3, 0]);
  });

  it('chưa có khung hình thật (readyState thấp) thì bỏ qua, không tốn frameId; createImageBitmap lỗi thì bỏ khung đó', async () => {
    const t = setup();
    t.video.readyState = 0;
    t.bitmaps.failures = 1;
    t.capture.addHandler(t.collect);
    t.capture.start();
    await t.time.advance(1000);
    expect(t.bitmaps.created).toBe(0);
    t.video.readyState = 4;
    await t.time.advance(500); // tick ở 1500: createImageBitmap lỗi
    await t.time.advance(500); // tick ở 2000: thành công
    expect(t.frames.map((f) => f.meta.frameId)).toEqual([1]);
  });

  it('stop khi đang chụp dở: bitmap bị đóng, handler không được gọi', async () => {
    const t = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const capture = createFrameCapture({
      source: t.video,
      createBitmap: async () => (await gate, t.bitmaps.create()),
      clock: t.time.clock,
      scheduler: t.time.scheduler,
      fps: 2,
    });
    capture.addHandler(t.collect);
    capture.start();
    await t.time.advance(0);
    capture.stop();
    release();
    await flush();
    expect(t.frames).toHaveLength(0);
    expect(t.bitmaps.open).toBe(0);
  });

  it('stop dừng hẳn, start chạy tiếp và frameId nối tiếp', async () => {
    const t = setup();
    t.capture.addHandler(t.collect);
    t.capture.start();
    await t.time.advance(500);
    t.capture.stop();
    await t.time.advance(3000);
    expect(t.frames).toHaveLength(2);
    t.capture.start();
    await t.time.advance(0);
    expect(t.frames.map((f) => f.meta.frameId)).toEqual([1, 2, 3]);
  });
});

describe('setFps', () => {
  it('đổi nhịp có hiệu lực ngay cả khi đang chờ lần chụp kế', async () => {
    const t = setup(1);
    t.capture.addHandler(t.collect);
    t.capture.start();
    await t.time.advance(300); // khung 1 ở 0; khung 2 lẽ ra ở 1000
    t.capture.setFps(10);
    await t.time.advance(200);
    expect(t.timestamps()).toEqual([0, 300, 400, 500]);
  });

  it.each([{ bad: 0 }, { bad: -5 }, { bad: Number.NaN }, { bad: Number.POSITIVE_INFINITY }])('bỏ qua giá trị không hợp lệ $bad', async ({ bad }) => {
    const t = setup();
    t.capture.addHandler(t.collect);
    t.capture.start();
    t.capture.setFps(bad);
    await t.time.advance(1000);
    expect(t.timestamps()).toEqual([0, 500, 1000]);
  });

  it.each([
    { fps: 5, expected: 5 },
    { fps: 1000, expected: 30 },
    { fps: 0.01, expected: 0.2 },
    { fps: Number.NaN, expected: 7 },
    { fps: 0, expected: 7 },
  ])('sanitizeFps($fps) = $expected', ({ fps, expected }) => {
    expect(sanitizeFps(fps, 7)).toBe(expected);
  });
});

describe('requestVideoFrameCallback', () => {
  it('có thì chờ khung video mới; mỗi khung chỉ chụp khi đã đủ khoảng cách 1000/fps', async () => {
    const video = new FakeCallbackVideo();
    const t = setup(2, video);
    t.capture.addHandler(t.collect);
    t.capture.start();
    await t.time.advance(0);
    expect(t.bitmaps.created).toBe(0); // chưa có khung video thì chưa chụp
    video.fireFrame();
    await flush();
    await t.time.advance(100);
    video.fireFrame(); // t = 100 < 500: bỏ qua, chờ khung kế
    await flush();
    expect(t.frames).toHaveLength(1);
    await t.time.advance(400);
    video.fireFrame(); // t = 500: đủ
    await flush();
    expect(t.timestamps()).toEqual([0, 500]);
  });

  it('callback ngừng bắn: sau 1 giây chuyển hẳn sang hẹn giờ, vẫn giữ khoảng cách 1000/fps', async () => {
    const video = new FakeCallbackVideo();
    const t = setup(0.5, video); // 2000 ms một khung
    t.capture.addHandler(t.collect);
    t.capture.start();
    video.fireFrame(); // khung đầu ở t = 0, sau đó callback không bắn nữa
    await flush();
    await t.time.advance(2000);
    expect(t.timestamps()).toEqual([0, 2000]); // watchdog ở t = 1000 không được chụp sớm
    expect(video.cancelCalls).toBeGreaterThan(0);
    await t.time.advance(2000);
    expect(t.timestamps()).toEqual([0, 2000, 4000]);
  });
});