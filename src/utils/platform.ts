import { Capacitor } from '@capacitor/core';
import type { Platform } from '../contracts';

/** true khi đang chạy trong vỏ Capacitor native (APK). Ngoài Capacitor hoặc có lỗi thì false. */
export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** 'android-native' khi chạy trong APK, ngược lại 'web' (trình duyệt khi dev). */
export function getPlatform(): Platform {
  return isNative() ? 'android-native' : 'web';
}