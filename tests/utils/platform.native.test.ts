import { describe, expect, it, vi } from 'vitest';
import { getPlatform, isNative } from '../../src/utils/platform';

const capacitorMock = vi.hoisted(() => ({ isNativePlatform: vi.fn(() => false) }));
vi.mock('@capacitor/core', () => ({ Capacitor: capacitorMock }));

describe('platform khi Capacitor được giả lập', () => {
  it.each([
    { native: true, expected: 'android-native' },
    { native: false, expected: 'web' },
  ])('isNativePlatform = $native → $expected', ({ native, expected }) => {
    capacitorMock.isNativePlatform.mockReturnValue(native);
    expect(isNative()).toBe(native);
    expect(getPlatform()).toBe(expected);
  });

  it('Capacitor ném lỗi thì coi như web', () => {
    capacitorMock.isNativePlatform.mockImplementation(() => {
      throw new Error('không có bridge');
    });
    expect(isNative()).toBe(false);
    expect(getPlatform()).toBe('web');
  });
});