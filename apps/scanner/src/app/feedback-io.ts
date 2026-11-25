// 브라우저 판정 소리·진동 부품(계획 F-05-10 §3 emitFeedback의 실제 포트).
// 소리·진동이 없거나 막혀도 emitFeedback이 예외를 삼키므로 판정 화면은 그대로다.
import type { ScanFeedback } from '../judge/feedback';

const FREQUENCY: Record<ScanFeedback['sound'], number> = {
  pass: 880,
  reject: 220,
  check: 520,
  retry: 440,
};

type AudioContextLike = {
  currentTime: number;
  destination: unknown;
  createOscillator(): { type: string; frequency: { value: number }; connect(n: unknown): void; start(): void; stop(t?: number): void };
  createGain(): { gain: { value: number }; connect(n: unknown): void };
  close?(): Promise<void>;
};

export function browserFeedbackPort(): {
  play(sound: ScanFeedback['sound']): Promise<void>;
  vibrate(pattern: readonly number[]): void;
} {
  return {
    async play(sound) {
      const Ctor =
        (globalThis as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = FREQUENCY[sound];
        gain.gain.value = 0.08;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
        await ctx.close?.();
      } catch {
        await ctx.close?.().catch(() => undefined);
      }
    },
    vibrate(pattern) {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern as number[]);
    },
  };
}
