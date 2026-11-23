// 명령 상세 + 본 시각 → 명령 카드 상태(F-03-4 T9·T10, C-T4·C-T7 ②). 그리는 글은 d5 §7.3 CMP-036 상태 표, 이 파일은 칸만 정한다.
// 상태의 정본은 REST 상세다(ADR-0100). 흐름 사건 본문으로 카드 상태를 만들지 않는다.

/** 전파 지연 기준: ack가 3초를 넘으면 명령 카드에 '전파 지연'(docs/features/control-tower.md §4 전이 표 T10) */
export const PROPAGATION_DELAY_MS = 3_000;

export interface CardDelivery {
  kind?: 'ACK' | 'APPLY_CHECK' | (string & {});
  ackedCount?: number;
  targetCount?: number;
  unackedTargets?: readonly string[];
  applyStatus?: string;
}

export interface CardDetail {
  type?: string;
  state?: string;
  approvalExpiresAt?: string | null;
  delivery?: CardDelivery | null;
}

export type CardKind =
  | 'pending-approval'
  | 'rejected'
  | 'propagating'
  | 'propagating-delayed'
  | 'failed'
  | 'acked'
  | 'revert-pending'
  | 'reverted'
  | 'auto-expired'
  | 'apply-unknown'
  | 'done';

export interface CardState {
  kind: CardKind;
  remainingMs?: number;
  acked?: number;
  target?: number;
  unacked?: string[];
  retryable?: boolean;
}

function remaining(expiresAt: string | null | undefined, nowMs: number): { remainingMs?: number } {
  const t = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(t) ? { remainingMs: Math.max(0, t - nowMs) } : {};
}

function ackOf(d: CardDelivery | null | undefined): { acked?: number; target?: number; unacked?: string[] } {
  if (!d || d.kind !== 'ACK') return {};
  return {
    ...(typeof d.ackedCount === 'number' ? { acked: d.ackedCount } : {}),
    ...(typeof d.targetCount === 'number' ? { target: d.targetCount } : {}),
    unacked: [...(d.unackedTargets ?? [])],
  };
}

/**
 * at.nowMs: 지금. at.dispatchSeenAtMs: 화면이 이 명령의 DISPATCHED를 처음 본 시각(없으면 지금 본 것으로 센다).
 * 본 뒤 3초 0ms까지는 전파 중, 넘으면 전파 지연이다.
 */
export function commandCardState(detail: CardDetail, at: { nowMs: number; dispatchSeenAtMs?: number }): CardState {
  switch (detail.state) {
    case 'PENDING_APPROVAL':
      return { kind: 'pending-approval', ...remaining(detail.approvalExpiresAt, at.nowMs) };
    case 'REJECTED':
      return { kind: 'rejected' };
    case 'APPROVED':
    case 'DISPATCHED': {
      // 설정형 명령의 적용 확인(F-02-5)은 동결이라 '확인할 수 없음'으로만 그린다
      if (detail.delivery?.kind === 'APPLY_CHECK') return { kind: 'apply-unknown' };
      const late = at.nowMs - (at.dispatchSeenAtMs ?? at.nowMs) > PROPAGATION_DELAY_MS;
      return { kind: late ? 'propagating-delayed' : 'propagating', ...ackOf(detail.delivery) };
    }
    case 'FAILED':
      return { kind: 'failed', retryable: true, ...ackOf(detail.delivery) };
    case 'ACKED':
      return { kind: 'acked', ...ackOf(detail.delivery) };
    case 'REVERT_PENDING':
      return { kind: 'revert-pending', ...remaining(detail.approvalExpiresAt, at.nowMs) };
    case 'REVERTED':
      return { kind: 'reverted' };
    case 'AUTO_EXPIRED':
      return { kind: 'auto-expired' };
    default:
      return { kind: 'done' };
  }
}
