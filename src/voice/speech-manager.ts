// STUB P08 — module thật sẽ GHI ĐÈ file này.
import type { AppConfig, IHaptics, ISpeech, ITtsEngine, Settings } from '../contracts';

export function createSpeechManager(
  o: {
    engines: ITtsEngine[];
    haptics: IHaptics;
    getSettings: () => Settings;
    config: AppConfig['speech'];
    now?: () => number;
  },
): ISpeech {
  throw new Error('STUB: createSpeechManager chưa được cài (P08)');
}