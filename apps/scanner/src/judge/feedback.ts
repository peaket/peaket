// 판정 소리·진동·화면 낭독(O-T14, d5 §8.3). 순수 모듈은 값만 정하고, 브라우저 부품이 실제로 낸다.
import { messageOf, type JudgeOutcome } from './judge.ts';

export type FeedbackTone = 'pass' | 'reject' | 'check' | 'retry';

export interface ScanFeedback {
  tone: FeedbackTone;
  icon: string;
  sound: 'pass' | 'reject' | 'check' | 'retry';
  vibrationMs: readonly number[];
  announcement: string;
}

const SOUNDS: Record<FeedbackTone, ScanFeedback['sound']> = {
  pass: 'pass',
  reject: 'reject',
  check: 'check',
  retry: 'retry',
};

const VIBRATIONS: Record<FeedbackTone, readonly number[]> = {
  pass: [60],
  reject: [140, 80, 140],
  check: [80, 60, 80],
  retry: [40, 40],
};

const ICONS: Record<FeedbackTone, string> = {
  pass: 'check-circle',
  reject: 'x-circle',
  check: 'alert',
  retry: 'refresh',
};

function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

export function feedbackOf(outcome: unknown): ScanFeedback {
  const o = (outcome ?? {}) as Partial<JudgeOutcome> & { result?: string };
  if (o.result === 'PASS') {
    const seat = typeof (o as { seatLabel?: unknown }).seatLabel === 'string' ? (o as { seatLabel: string }).seatLabel : '';
    return {
      tone: 'pass',
      icon: ICONS.pass,
      sound: SOUNDS.pass,
      vibrationMs: VIBRATIONS.pass,
      announcement: sentence(seat ? `통과. ${seat}` : '통과'),
    };
  }
  if (o.result === 'RETRY') {
    return {
      tone: 'retry',
      icon: ICONS.retry,
      sound: SOUNDS.retry,
      vibrationMs: VIBRATIONS.retry,
      announcement: sentence('다시 찍어 주세요'),
    };
  }
  if (o.result === 'CHECK') {
    return {
      tone: 'check',
      icon: ICONS.check,
      sound: SOUNDS.check,
      vibrationMs: VIBRATIONS.check,
      announcement: sentence(`확인 필요. ${messageOf(o as JudgeOutcome)}`),
    };
  }
  return {
    tone: 'reject',
    icon: ICONS.reject,
    sound: SOUNDS.reject,
    vibrationMs: VIBRATIONS.reject,
    announcement: sentence(`거부. ${messageOf(o as JudgeOutcome)}`),
  };
}

/** 소리·진동 실패가 낭독을 막지 않는다. 포트가 없거나 던져도 판정 결과를 바꾸지 않는다 */
export async function emitFeedback(
  feedback: ScanFeedback,
  port: {
    play?(sound: ScanFeedback['sound']): void | Promise<void>;
    vibrate?(pattern: readonly number[]): void;
    announce?(text: string): void;
  },
): Promise<void> {
  try {
    await port.play?.(feedback.sound);
  } catch {
    // 소리를 낼 수 없어도 글자·아이콘·낭독은 그대로다
  }
  try {
    port.vibrate?.(feedback.vibrationMs);
  } catch {
    // 진동을 낼 수 없어도 판정 결과는 그대로다
  }
  try {
    port.announce?.(feedback.announcement);
  } catch {
    // 낭독기가 없어도 판정 결과는 그대로다
  }
}
