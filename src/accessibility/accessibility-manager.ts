// STUB P10 — module thật sẽ GHI ĐÈ file này.
export function createAccessibilityManager(
  o: {
    root: HTMLElement;
    torchSupported: boolean;
    onReplay: () => void;
    onToggleTorch: () => void;
    onOpenSettings: () => void;
  },
): { setTorchPressed(on: boolean): void; setStatusText(t: string): void; focusReplay(): void; dispose(): void } {
  throw new Error('STUB: createAccessibilityManager chưa được cài (P10)');
}