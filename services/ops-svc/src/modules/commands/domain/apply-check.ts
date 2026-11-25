// 적용 확인 행의 상태 전이(순수 함수)와 경계 상수(F-02-5 OPS-300, ADR-0365 결정 10·14·15, C-T54).
// 시간은 모두 주입 값(nowMs)이고, 나간 시각(Outbox sent_at)부터 30초를 센다. Kafka가 막혀 나가지 않았으면
// 5초까지 CHECKING, 그 뒤 OUTBOX_WAITING이고 30초를 세지 않는다. 판정은 up 파드마다 판 지표 >= 판이다.
import type { CommandDeliveryView } from './command.js';

/** Outbox에 쓴 뒤 이만큼까지는 '아직 보내는 중'으로 본다(ADR-0143 결정 4 '5초') */
export const APPLY_CHECK_OUTBOX_WAIT_MS = 5_000;
/** 나간 시각부터 '모두 적용'을 기다리는 창(정본 30초 [가정]) */
export const APPLY_CHECK_WINDOW_MS = 30_000;
/** UNCONFIRMED 뒤 다시 보는 간격(1분) */
export const APPLY_CHECK_RECHECK_MS = 60_000;
/** UNCONFIRMED 뒤 다시 보는 마지막 시각(나간 시각 + 10분 30초) */
export const APPLY_CHECK_RECHECK_UNTIL_MS = 630_000;
/** 정비 바퀴가 적용 확인을 보는 간격(정본 5초 [가정], ADR-0365 결정 10) */
export const APPLY_CHECK_ROUND_MS = 5_000;
/** Prometheus 즉시 질의 한 번의 시간 한도(2초 [가정]) */
export const APPLY_CHECK_QUERY_TIMEOUT_MS = 2_000;
export const APPLY_STATUSES = ['OUTBOX_WAITING', 'CHECKING', 'CONFIRMED', 'UNCONFIRMED', 'UNKNOWN'] as const;
/** 아직 더 볼 수 있는 상태(정비 바퀴의 due 조건) */
export const ACTIVE_APPLY_STATUSES: readonly ApplyStatus[] = ['OUTBOX_WAITING', 'CHECKING', 'UNCONFIRMED', 'UNKNOWN'];
export type ApplyStatus = (typeof APPLY_STATUSES)[number];
export const SETTINGS_APPLY_ALERT = 'settings-apply-unconfirmed';

/** 사건 단계. 실행(ACKED)·되돌리기(REVERTED)·명령 8 자동 만료(AUTO_EXPIRED)마다 행이 하나다 */
export type ApplyCheckStage = 'ACKED' | 'REVERTED' | 'AUTO_EXPIRED';

/** 적용 확인 행 하나(ops DB command_apply_check, 마이그레이션 0026) */
export interface ApplyCheckRow {
  readonly commandId: string;
  readonly stage: ApplyCheckStage;
  /** 판(설정 사건 occurredAt 밀리초). 같은 범위·종류에서 늘어난다 */
  readonly version: number;
  /** 메시지 키 '<범위>:<종류>:<대상>' */
  readonly messageKey: string;
  /** 설정 사건 Outbox 행 ID(나갔는지 sent_at으로 본다) */
  readonly outboxId: string;
  /** 받는 서비스(settingReceiverOf). 표 밖이면 없다 */
  readonly service?: string;
  readonly status: ApplyStatus;
  readonly writtenAtMs: number;
  readonly sentAtMs?: number;
  /** Prometheus가 센 up 파드 목록. 판이 없으면 version이 없다(못 미친 파드) */
  readonly pods: readonly { readonly pod: string; readonly version?: number }[];
  readonly targetCount: number;
  readonly ackedCount: number;
  readonly alertOpen: boolean;
  readonly reason?: string;
  readonly nextCheckAtMs: number;
  readonly updatedAtMs: number;
}

/** Prometheus 즉시 질의 결과(어댑터 경계) */
export type ProbeResult = { readonly ok: true; readonly pods: readonly { readonly pod: string; readonly version?: number }[] } | { readonly ok: false; readonly reason: string };

const unackedOf = (pods: ApplyCheckRow['pods'], version: number): readonly string[] =>
  pods.filter((p) => p.version === undefined || p.version < version).map((p) => `${p.pod}:${p.version ?? '-'}`);

/**
 * 다음 바퀴의 행과 경보 동작(순수 함수). 상태·경계는 B9~B12, C-T54.
 * @returns alert OPEN은 UNCONFIRMED가 처음 열릴 때, RESOLVE는 열린 경보가 CONFIRMED로 풀릴 때
 */
export function nextApplyCheck(
  row: ApplyCheckRow,
  q: { readonly nowMs: number; readonly outbox: { readonly exists: boolean; readonly sentAtMs?: number }; readonly probe?: ProbeResult },
): { readonly row: ApplyCheckRow; readonly alert?: 'OPEN' | 'RESOLVE' } {
  const now = q.nowMs;
  const base = { ...row, updatedAtMs: now };

  // 아직 Outbox에 있으면 30초를 세지 않는다. 5초까지는 CHECKING, 그 뒤 OUTBOX_WAITING
  if (!row.sentAtMs) {
    if (!q.outbox.exists) {
      // 파티션 지우기로 행이 없어졌으면 처음 본 때를 나간 시각으로 쓴다(결정 14)
      return finish({ ...base, sentAtMs: now }, q.probe);
    }
    if (q.outbox.sentAtMs !== undefined) return finish({ ...base, sentAtMs: q.outbox.sentAtMs }, q.probe);
    const waited = now - row.writtenAtMs;
    // 5,000ms 정각까지는 CHECKING이고 5,001ms부터 OUTBOX_WAITING이다. 다음 바퀴가 그 경계를 놓치지 않게 경계+1ms를 다음 볼 시각으로 잡는다
    if (waited <= APPLY_CHECK_OUTBOX_WAIT_MS) {
      return { row: { ...base, status: 'CHECKING', nextCheckAtMs: Math.min(now + APPLY_CHECK_ROUND_MS, row.writtenAtMs + APPLY_CHECK_OUTBOX_WAIT_MS + 1) } };
    }
    // 나가지 않은 동안은 매 바퀴 다시 본다(나간 때를 빨리 알아야 30초 창의 기준이 선다, C-T54 ④)
    return { row: { ...base, status: 'OUTBOX_WAITING', nextCheckAtMs: now } };
  }

  return finish(base, q.probe);
}

/** 나간 뒤의 판정(30초 창·판 비교·경보) */
function finish(row: ApplyCheckRow, probe: ProbeResult | undefined): { readonly row: ApplyCheckRow; readonly alert?: 'OPEN' | 'RESOLVE' } {
  const now = row.updatedAtMs;
  const sent = row.sentAtMs!;
  // 10분 30초를 넘긴 UNCONFIRMED는 더 보지 않고 열린 채로 멈춘다(맞아도 닫지 않는다, B11)
  if (row.status === 'UNCONFIRMED' && now > sent + APPLY_CHECK_RECHECK_UNTIL_MS) {
    return { row: { ...row, nextCheckAtMs: sent + APPLY_CHECK_RECHECK_UNTIL_MS + 1 } };
  }
  if (!probe) return { row: { ...row, status: row.status === 'OUTBOX_WAITING' ? 'CHECKING' : row.status, nextCheckAtMs: now + APPLY_CHECK_ROUND_MS } };
  if (!probe.ok) {
    return { row: { ...row, status: 'UNKNOWN', reason: probe.reason, pods: [], targetCount: 0, ackedCount: 0, nextCheckAtMs: now + APPLY_CHECK_ROUND_MS } };
  }
  const pods = probe.pods;
  if (pods.length === 0) {
    return { row: { ...row, status: 'UNKNOWN', reason: 'no-targets', pods: [], targetCount: 0, ackedCount: 0, nextCheckAtMs: now + APPLY_CHECK_ROUND_MS } };
  }
  const acked = pods.filter((p) => p.version !== undefined && p.version >= row.version);
  const targetCount = pods.length;
  const ackedCount = acked.length;
  const missing = targetCount - ackedCount;
  if (missing === 0) {
    return {
      row: { ...row, status: 'CONFIRMED', reason: undefined, pods, targetCount, ackedCount, alertOpen: false, nextCheckAtMs: now + APPLY_CHECK_ROUND_MS },
      ...(row.alertOpen ? { alert: 'RESOLVE' as const } : {}),
    };
  }
  const inWindow = now - sent < APPLY_CHECK_WINDOW_MS;
  // 창 안에서는 30초 정각을 다음 바퀴가 놓치지 않게 그 시각까지를 다음 볼 시각으로 잡는다(C-T54 ①)
  if (inWindow) {
    return { row: { ...row, status: 'CHECKING', reason: undefined, pods, targetCount, ackedCount, nextCheckAtMs: Math.min(now + APPLY_CHECK_ROUND_MS, sent + APPLY_CHECK_WINDOW_MS) } };
  }
  // 10분 30초를 넘기면 더 보지 않고 열린 채로 멈춘다(다음 볼 시각을 아주 뒤로 둔다)
  if (now > sent + APPLY_CHECK_RECHECK_UNTIL_MS) {
    return { row: { ...row, status: 'UNCONFIRMED', reason: undefined, pods, targetCount, ackedCount, nextCheckAtMs: sent + APPLY_CHECK_RECHECK_UNTIL_MS + 1 } };
  }
  if (row.alertOpen) return { row: { ...row, status: 'UNCONFIRMED', reason: undefined, pods, targetCount, ackedCount, nextCheckAtMs: now + APPLY_CHECK_RECHECK_MS } };
  return {
    row: { ...row, status: 'UNCONFIRMED', reason: undefined, pods, targetCount, ackedCount, alertOpen: true, nextCheckAtMs: now + APPLY_CHECK_RECHECK_MS },
    alert: 'OPEN',
  };
}

/** 명령 카드의 delivery(openapi CommandState.delivery, kind APPLY_CHECK) */
export function applyCheckViewOf(row: ApplyCheckRow): CommandDeliveryView {
  return {
    kind: 'APPLY_CHECK',
    applyStatus: row.status,
    targetCount: row.targetCount,
    ackedCount: row.ackedCount,
    unackedTargets: unackedOf(row.pods, row.version),
  };
}
