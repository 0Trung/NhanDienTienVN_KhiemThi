import { describe, expect, it } from 'vitest';
import { CONSTRAINT_STEPS, createCameraSource, pickMainBackCamera } from '../../src/camera/camera-service';
import type { CameraSource } from '../../src/camera/camera-service';
import type { ITorchPort } from '../../src/contracts';
import { FakeMediaDevices, makeDevice } from './camera-fakes';

function makeSource(media: FakeMediaDevices | undefined, torchPort?: ITorchPort, secure = true): CameraSource {
  return createCameraSource({ mediaDevices: media, isSecureContext: secure, onEnded: () => undefined, ...(torchPort ? { torchPort } : {}) });
}

function makePort(supported: boolean): ITorchPort & { sets: boolean[] } {
  const sets: boolean[] = [];
  return { sets, isSupported: () => Promise.resolve(supported), set: (on) => (sets.push(on), Promise.resolve(true)) };
}

describe('F1 — điều kiện mở camera và chuỗi hạ ràng buộc', () => {
  it.each([
    { title: 'ngữ cảnh không an toàn', media: new FakeMediaDevices(), secure: false },
    { title: 'thiếu navigator.mediaDevices', media: undefined, secure: true },
  ])('$title → UNSUPPORTED_BROWSER, không gọi getUserMedia', async ({ media, secure }) => {
    await expect(makeSource(media, undefined, secure).open()).rejects.toMatchObject({ code: 'UNSUPPORTED_BROWSER' });
    expect(media?.calls ?? []).toHaveLength(0);
  });

  it('bước đầu: audio false, facingMode environment, 1280x720, 30 fps (đều ideal)', async () => {
    const media = new FakeMediaDevices();
    await makeSource(media).open();
    expect(media.calls[0]).toEqual({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  });

  it('Overconstrained hai lần: bỏ độ phân giải rồi bỏ facingMode, lần ba thành công', async () => {
    const media = new FakeMediaDevices(['OverconstrainedError', 'OverconstrainedError']);
    await makeSource(media).open();
    expect(media.calls).toEqual(CONSTRAINT_STEPS);
    const [full, noSize, noFacing] = media.calls.map((c) => c.video as MediaTrackConstraints);
    expect(full).toHaveProperty('width');
    expect(noSize).toHaveProperty('facingMode');
    expect(noSize).not.toHaveProperty('width');
    expect(noSize).not.toHaveProperty('height');
    expect(noFacing).not.toHaveProperty('facingMode');
    expect(media.calls.every((c) => c.audio === false)).toBe(true);
  });

  it('hạ hết mà vẫn Overconstrained → CAMERA_FAILED sau đúng 3 lần thử', async () => {
    const media = new FakeMediaDevices(Array(3).fill('OverconstrainedError') as string[]);
    await expect(makeSource(media).open()).rejects.toMatchObject({ code: 'CAMERA_FAILED' });
    expect(media.calls).toHaveLength(3);
  });

  it.each([
    { name: 'NotAllowedError', code: 'CAMERA_PERMISSION_DENIED' },
    { name: 'NotFoundError', code: 'CAMERA_NOT_FOUND' },
    { name: 'NotReadableError', code: 'CAMERA_IN_USE' },
  ])('$name không hạ ràng buộc, báo thẳng $code', async ({ name, code }) => {
    const media = new FakeMediaDevices([name]);
    await expect(makeSource(media).open()).rejects.toMatchObject({ code });
    expect(media.calls).toHaveLength(1);
  });
});

describe('F4 — đèn', () => {
  it('track có capabilities.torch: bật/tắt bằng applyConstraints advanced torch', async () => {
    const media = new FakeMediaDevices([], { torch: true });
    const source = makeSource(media, makePort(true));
    await source.open();
    expect(source.torchSupported).toBe(true);
    expect(await source.setTorch(true)).toBe(true);
    expect(await source.setTorch(false)).toBe(true);
    expect(media.tracks[0]?.applied).toEqual([{ advanced: [{ torch: true }] }, { advanced: [{ torch: false }] }]);
  });

  it('applyConstraints từ chối → false, không ném', async () => {
    const media = new FakeMediaDevices([], { torch: true });
    const source = makeSource(media);
    await source.open();
    if (media.tracks[0]) media.tracks[0].rejectApply = true;
    await expect(source.setTorch(true)).resolves.toBe(false);
  });

  it('không có torch và không có cổng: torchSupported false, setTorch trả false, không ném', async () => {
    const media = new FakeMediaDevices();
    const source = makeSource(media);
    await source.open();
    expect(source.torchSupported).toBe(false);
    await expect(source.setTorch(true)).resolves.toBe(false);
    expect(media.tracks[0]?.applied).toEqual([]);
  });

  it('getUserMedia không điều khiển được đèn mà có torchPort hỗ trợ: dùng cổng, close() thì tắt đèn', async () => {
    const media = new FakeMediaDevices();
    const port = makePort(true);
    const source = makeSource(media, port);
    await source.open();
    expect(source.torchSupported).toBe(true);
    expect(await source.setTorch(true)).toBe(true);
    source.close();
    expect(port.sets).toEqual([true, false]);
    expect(media.tracks[0]?.applied).toEqual([]);
  });

  it('torchPort không hỗ trợ hoặc báo lỗi khi dò → torchSupported false', async () => {
    const failing: ITorchPort = { isSupported: () => Promise.reject(new Error('plugin lỗi')), set: () => Promise.resolve(true) };
    for (const port of [makePort(false), failing]) {
      const source = makeSource(new FakeMediaDevices(), port);
      await source.open();
      expect(source.torchSupported).toBe(false);
    }
  });
});

describe('F5 — lấy nét và chọn camera chính', () => {
  it.each([
    { modes: ['manual', 'continuous'], applied: [{ advanced: [{ focusMode: 'continuous' }] }] },
    { modes: ['manual'], applied: [] },
  ])('focusMode $modes → áp dụng $applied', async ({ modes, applied }) => {
    const media = new FakeMediaDevices([], { focusMode: modes });
    await makeSource(media).open();
    expect(media.tracks[0]?.applied).toEqual(applied);
  });

  const ultra = makeDevice('A', 'camera2 0, facing back, ultra wide');
  const main = makeDevice('B', 'camera2 1, facing back');
  const front = makeDevice('C', 'camera2 2, facing front');
  it.each([
    { title: 'đang dùng ống kính phụ, có camera chính → chuyển', devices: [ultra, main, front], current: 'A', expected: 'B' },
    { title: 'đang dùng camera chính → giữ', devices: [ultra, main, front], current: 'B', expected: null },
    { title: 'chỉ một camera sau → giữ', devices: [main, front], current: 'B', expected: null },
    { title: 'nhãn rỗng (chưa có quyền) → không làm', devices: [makeDevice('A', ''), makeDevice('B', '')], current: 'A', expected: null },
    { title: 'toàn ống kính phụ → không có camera chính', devices: [ultra, makeDevice('T', 'back telephoto')], current: 'A', expected: null },
    { title: 'không biết camera đang dùng → giữ', devices: [ultra, main], current: undefined, expected: null },
    { title: 'tele, macro, depth đều bị loại', devices: [makeDevice('T', 'back tele'), makeDevice('M', 'back macro'), makeDevice('D', 'back depth'), main], current: 'M', expected: 'B' },
  ])('pickMainBackCamera: $title', ({ devices, current, expected }) => {
    expect(pickMainBackCamera(devices, current)).toBe(expected);
  });

  it('open() chuyển sang camera chính: đóng luồng cũ rồi mở đúng deviceId', async () => {
    const media = new FakeMediaDevices([], {}, { deviceId: 'A' });
    media.devices = [ultra, main, front];
    await makeSource(media).open();
    expect(media.calls).toHaveLength(2);
    expect((media.calls[1]?.video as MediaTrackConstraints).deviceId).toEqual({ exact: 'B' });
    expect(media.tracks[0]?.stopCalls).toBe(1);
  });

  it('mở camera chính lỗi thì quay về đường mặc định; close() gọi nhiều lần vẫn an toàn', async () => {
    const media = new FakeMediaDevices(['ok', 'NotReadableError'], {}, { deviceId: 'A' });
    media.devices = [ultra, main];
    const source = makeSource(media);
    await source.open();
    expect(media.calls).toHaveLength(3);
    expect(source.isLive()).toBe(true);
    source.close();
    source.close();
    expect(media.tracks.at(-1)?.stopCalls).toBe(1);
    expect(source.isLive()).toBe(false);
  });
});