import type { HapticEvent, IHaptics } from '../../src/contracts';

/** Bộ rung giả: ghi lại các sự kiện đã phát. */
export class FakeHaptics implements IHaptics {
  readonly supported: boolean;
  readonly events: HapticEvent[] = [];

  constructor(supported = true) {
    this.supported = supported;
  }

  play(e: HapticEvent): void {
    this.events.push(e);
  }

  clear(): void {
    this.events.length = 0;
  }
}