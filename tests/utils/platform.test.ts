import { describe, expect, it } from 'vitest';
import { getPlatform, isNative } from '../../src/utils/platform';

// Chạy trong Node, không có vỏ Capacitor native.
describe('platform ngoài Capacitor', () => {
  it('getPlatform trả web', () => {
    expect(getPlatform()).toBe('web');
  });

  it('isNative trả false', () => {
    expect(isNative()).toBe(false);
  });
});