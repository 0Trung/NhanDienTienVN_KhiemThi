import { describe, expect, it } from 'vitest';
import { createCameraController, createCameraService } from '../../src/camera/camera-controller';
import type { ITorchPort } from '../../src/contracts';
import { FakeVideo, domError, flush, makeHarness } from './camera-fakes';

type Harness = ReturnType<typeof makeHarness>;

/** Handler chuẩn: ghi frameId rồi tự đóng bitmap như bên nhận thật. */
function collectIds(h: Harness): number[] {
  const ids: number[] = [];
  h.camera.onFrame((f) => {
    ids.push(f.meta.frameId);
    f.bitmap.close();
  });
  return ids;
}

describe('F1 — start()', () => {
  it('REQUESTING ngay (đồng bộ) rồi ACTIVE; thẻ video có playsinline, muted, autoplay, aria-hidden true', async () => {
    const h = makeHarness();
    const pending = h.camera.start();
    expect(h.camera.status).toBe('REQUESTING');
    await pending;
    expect(h.camera.status).toBe('ACTIVE');
    expect(h.statuses).toEqual(['REQUESTING', 'ACTIVE']);
    expect(h.video.srcObject).not.toBeNull();
    expect([h.video.muted, h.video.autoplay, h.video.playsInline]).toEqual([true, true, true]);
    expect(h.video.attrs.get('aria-hidden')).toBe('true');
    expect(h.video.attrs.has('playsinline')).toBe(true);
  });

  it('khung hình tới handler đã đăng ký; huỷ đăng ký thì dừng và không rò bitmap', async () => {
    const h = makeHarness();
    const ids = collectIds(h);
    const off = h.camera.onFrame(() => undefined);
    await h.camera.start();
    await h.time.advance(1000);
    expect(ids).toEqual([1, 2, 3]);
    off();
    await h.time.advance(1000);
    expect(h.bitmaps.open).toBe(0);
  });

  it.each([
    { name: 'NotAllowedError', code: 'CAMERA_PERMISSION_DENIED' },
    { name: 'NotFoundError', code: 'CAMERA_NOT_FOUND' },
    { name: 'NotReadableError', code: 'CAMERA_IN_USE' },
    { name: 'AbortError', code: 'CAMERA_FAILED' },
  ])('gặp $name: ném AppError $code, status ERROR, không để lại listener; start lại được', async ({ name, code }) => {
    const h = makeHarness({ script: [name] });
    await expect(h.camera.start()).rejects.toMatchObject({ code });
    expect(h.camera.status).toBe('ERROR');
    expect(h.statuses).toEqual(['REQUESTING', `ERROR:${code}`]);
    expect(h.doc.listenerCount).toBe(0);
    await h.camera.start();
    expect(h.camera.status).toBe('ACTIVE');
  });

  it('video.play() lỗi → CAMERA_FAILED và camera được nhả', async () => {
    const video = new FakeVideo();
    video.playError = domError('NotSupportedError');
    const h = makeHarness({ fakeVideo: video });
    await expect(h.camera.start()).rejects.toMatchObject({ code: 'CAMERA_FAILED' });
    expect(h.media.tracks[0]?.stopCalls).toBe(1);
  });

  it('start() gọi chồng hoặc khi đã ACTIVE chỉ mở camera một lần', async () => {
    const h = makeHarness();
    await Promise.all([h.camera.start(), h.camera.start()]);
    await h.camera.start();
    expect(h.media.calls).toHaveLength(1);
  });

  it('stop() trong lúc đang xin quyền: start() kết thúc êm, track vừa mở bị đóng, không gắn stream', async () => {
    const h = makeHarness();
    let release: () => void = () => undefined;
    h.media.gate = new Promise<void>((resolve) => (release = resolve));
    const pending = h.camera.start();
    await flush();
    h.camera.stop();
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(h.camera.status).toBe('IDLE');
    expect(h.media.tracks[0]?.stopCalls).toBe(1);
    expect(h.video.srcObject).toBeNull();
    expect(h.video.playCalls).toBe(0);
    expect(h.doc.listenerCount).toBe(0);
  });

  it('stop() ngay sau start() thì không mở camera', async () => {
    const h = makeHarness();
    const pending = h.camera.start();
    h.camera.stop();
    await expect(pending).resolves.toBeUndefined();
    expect(h.media.calls).toHaveLength(0);
    expect(h.statuses).toEqual(['REQUESTING', 'IDLE']);
  });

  it('không có Wake Lock hoặc bị từ chối thì bỏ qua, camera vẫn chạy', async () => {
    const refusing = { request: () => Promise.reject(domError('NotAllowedError')) };
    for (const options of [{}, { wakeLock: refusing }]) {
      const h = makeHarness(options);
      const ids = collectIds(h);
      await h.camera.start();
      await h.time.advance(500);
      expect([h.camera.status, ids.length]).toEqual(['ACTIVE', 2]);
    }
  });
});

describe('F6 — vòng đời', () => {
  it('pause() dừng lấy mẫu và nhả Wake Lock; resume() chạy lại và xin lại Wake Lock', async () => {
    const h = makeHarness();
    const ids = collectIds(h);
    await h.camera.start();
    await h.time.advance(500);
    expect([ids.length, h.wakeLock.held]).toEqual([2, 1]);
    h.camera.pause();
    expect([h.camera.status, h.video.pauseCalls]).toEqual(['PAUSED', 1]);
    await h.time.advance(2000);
    expect([ids.length, h.wakeLock.held]).toEqual([2, 0]);
    await h.camera.resume();
    await h.time.advance(0);
    expect([h.camera.status, ids.length, h.wakeLock.held]).toEqual(['ACTIVE', 3, 1]);
  });

  it('trang bị ẩn thì tự tạm dừng, hiện lại thì tự tiếp tục và xin lại Wake Lock', async () => {
    const h = makeHarness();
    const ids = collectIds(h);
    await h.camera.start();
    await h.time.advance(0);
    h.doc.setVisibility('hidden');
    expect(h.camera.status).toBe('PAUSED');
    await h.time.advance(2000);
    expect([ids.length, h.wakeLock.held]).toEqual([1, 0]);
    h.doc.setVisibility('visible');
    await h.time.advance(0);
    expect([h.camera.status, ids.length, h.wakeLock.requests, h.wakeLock.held]).toEqual(['ACTIVE', 2, 2, 1]);
  });

  it('app đã pause() thì trang hiện lại không tự tiếp tục; resume() vẫn chạy được lúc trang còn ẩn', async () => {
    const h = makeHarness();
    await h.camera.start();
    h.doc.setVisibility('hidden');
    h.camera.pause();
    h.doc.setVisibility('visible');
    await h.time.advance(0);
    expect(h.camera.status).toBe('PAUSED');
    h.doc.setVisibility('hidden');
    await h.camera.resume();
    expect(h.camera.status).toBe('ACTIVE');
  });

  it('pause() và resume() khi chưa chạy là không làm gì', async () => {
    const h = makeHarness();
    h.camera.pause();
    await h.camera.resume();
    expect([h.camera.status, h.statuses]).toEqual(['IDLE', []]);
  });

  it('track kết thúc ngoài ý muốn: ERROR kèm AppError, tự mở lại đúng 1 lần', async () => {
    const h = makeHarness();
    await h.camera.start();
    h.media.tracks[0]?.endExternally();
    await h.time.advance(0);
    expect(h.statuses).toEqual(['REQUESTING', 'ACTIVE', 'ERROR:CAMERA_IN_USE', 'REQUESTING', 'ACTIVE']);
    expect(h.media.tracks).toHaveLength(2);
    h.media.tracks[1]?.endExternally();
    await h.time.advance(0);
    expect([h.camera.status, h.media.tracks.length]).toEqual(['ERROR', 2]); // hết lượt tự mở lại
  });

  it('mở lại cũng thất bại: ERROR kèm lỗi mới và không thử lần ba', async () => {
    const h = makeHarness({ script: ['ok', 'NotReadableError'] });
    await h.camera.start();
    h.media.tracks[0]?.endExternally();
    await h.time.advance(0);
    expect(h.statuses).toEqual(['REQUESTING', 'ACTIVE', 'ERROR:CAMERA_IN_USE', 'REQUESTING', 'ERROR:CAMERA_IN_USE']);
    expect(h.media.calls).toHaveLength(2);
  });

  it('track kết thúc lúc đang tạm dừng: resume() mở lại êm, không báo ERROR', async () => {
    const h = makeHarness();
    await h.camera.start();
    h.camera.pause();
    h.media.tracks[0]?.endExternally();
    expect(h.camera.status).toBe('PAUSED');
    await h.camera.resume();
    expect([h.camera.status, h.media.tracks.length]).toEqual(['ACTIVE', 2]);
    expect(h.statuses.some((s) => s.startsWith('ERROR'))).toBe(false);
  });
});

describe('F7 — stop()', () => {
  it('gọi hai lần không lỗi và giải phóng track, Wake Lock, vòng lặp, listener', async () => {
    const h = makeHarness();
    const ids = collectIds(h);
    await h.camera.start();
    await h.time.advance(500);
    h.camera.stop();
    h.camera.stop();
    expect(h.camera.status).toBe('IDLE');
    expect([h.media.tracks[0]?.stopCalls, h.wakeLock.held, h.doc.listenerCount, h.video.srcObject]).toEqual([1, 0, 0, null]);
    const before = ids.length;
    await h.time.advance(5000);
    expect(ids).toHaveLength(before);
    expect(h.statuses.filter((s) => s === 'IDLE')).toHaveLength(1);
  });

  it('stop() khi chưa start là an toàn và không phát trạng thái; start lại sau stop() chạy bình thường', async () => {
    const h = makeHarness();
    h.camera.stop();
    h.camera.stop();
    expect(h.statuses).toEqual([]);
    await h.camera.start();
    h.camera.stop();
    await h.camera.start();
    expect([h.camera.status, h.doc.listenerCount]).toEqual(['ACTIVE', 1]);
  });
});

describe('F4 — đèn qua ICameraService', () => {
  it('đèn đang bật: tạm dừng thì tắt, resume thì bật lại; stop thì quên', async () => {
    const h = makeHarness({ trackCaps: { torch: true } });
    await h.camera.start();
    expect(h.camera.torchSupported).toBe(true);
    expect(await h.camera.setTorch(true)).toBe(true);
    h.camera.pause();
    await h.camera.resume();
    expect(h.media.tracks[0]?.applied).toEqual([{ advanced: [{ torch: true }] }, { advanced: [{ torch: false }] }, { advanced: [{ torch: true }] }]);
    h.camera.stop();
    expect(h.camera.torchSupported).toBe(false);
    await expect(h.camera.setTorch(true)).resolves.toBe(false);
  });

  it('torchPort được dùng khi camera không điều khiển được đèn, và tắt khi stop()', async () => {
    const sets: boolean[] = [];
    const torchPort: ITorchPort = { isSupported: () => Promise.resolve(true), set: (on) => (sets.push(on), Promise.resolve(true)) };
    const h = makeHarness({ torchPort });
    await h.camera.start();
    expect(h.camera.torchSupported).toBe(true);
    expect(await h.camera.setTorch(true)).toBe(true);
    h.camera.stop();
    expect(sets).toEqual([true, false]);
  });

  it('không hỗ trợ đèn: torchSupported false, setTorch trả false, không ném', async () => {
    const h = makeHarness();
    await h.camera.start();
    expect(h.camera.torchSupported).toBe(false);
    await expect(h.camera.setTorch(true)).resolves.toBe(false);
  });
});

describe('createCameraService (bảng đăng ký xuất khẩu)', () => {
  it('dùng đúng video được truyền vào, cấu hình thẻ video ngay khi tạo, bắt đầu ở IDLE', () => {
    const video = new FakeVideo();
    const service = createCameraService({ video: video.element, fps: 2 });
    expect([service.video, service.status, service.torchSupported]).toEqual([video.element, 'IDLE', false]);
    expect(video.attrs.get('aria-hidden')).toBe('true');
    expect(video.style).toMatchObject({ width: '100%', height: '100%', objectFit: 'cover' });
    service.stop();
    service.stop();
  });

  it('không có video và không có document thì ném UNSUPPORTED_BROWSER', () => {
    let caught: unknown;
    try {
      createCameraController({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'UNSUPPORTED_BROWSER' });
  });
});