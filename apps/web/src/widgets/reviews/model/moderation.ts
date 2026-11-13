// 후기 운영자 조치의 입력 검사(SCR-016 운영자 보기, POL-044). 서버도 같은 규칙을 다시 본다.
import type { ReviewModeration, ReviewModerationAction, ReviewModerationViolation } from '@peaket/api-client/model';

export type ModerationAction = ReviewModerationAction;
export type ModerationViolation = ReviewModerationViolation;

const MAX_TEMP_BLOCK_MS = 30 * 24 * 60 * 60 * 1000;

export function buildModerationPayload(input: {
  action: ModerationAction;
  reason: string;
  violation?: ModerationViolation;
  /** TEMP_BLOCK의 끝 시각(ISO) */
  endsAt?: string;
  nowMs: number;
}): { ok: true; body: ReviewModeration } | { ok: false; message: string } {
  const reason = input.reason.trim();
  if (reason === '') return { ok: false, message: '사유를 적어 주세요' };
  if (input.action === 'RELEASE') return { ok: true, body: { action: 'RELEASE', reason } };
  if (!input.violation) return { ok: false, message: '위반 유형을 골라 주세요' };
  if (input.action === 'BLOCK') return { ok: true, body: { action: 'BLOCK', reason, violation: input.violation } };
  const endsAt = input.endsAt ? Date.parse(input.endsAt) : Number.NaN;
  if (!Number.isFinite(endsAt) || endsAt <= input.nowMs) return { ok: false, message: '임시조치 끝 시각을 골라 주세요' };
  if (endsAt > input.nowMs + MAX_TEMP_BLOCK_MS) return { ok: false, message: '임시조치는 30일을 넘을 수 없습니다' };
  return { ok: true, body: { action: 'TEMP_BLOCK', reason, violation: input.violation, endsAt: new Date(endsAt).toISOString() } };
}
