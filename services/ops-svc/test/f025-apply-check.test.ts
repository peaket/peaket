// 설정형 명령의 적용 확인 상태 전이(순수 함수 nextApplyCheck)와 명령 카드 전파 칸(applyCheckViewOf)을 경계값으로 본다
// (F-02-5 OPS-300, ADR-0365 결정 10·14·15, docs/features/control-tower.md C-T54, 계획 docs/review/plans/F-02-5.md 6절 B9~B12·B16, 9절 F025-APPLY).
// 정본 값(코드 상수를 가져오지 않고 정본에서 적는다):
// - Outbox 지연: 나가지 않은 행을 쓴 때부터 5,000ms 이하는 CHECKING, 5,001ms부터 OUTBOX_WAITING(결정 14, ADR-0143 결정 4 '5초')
// - 30초는 나간 시각(Outbox sent_at)부터 센다. + 29,999ms에 못 미친 파드가 있으면 CHECKING, + 30,000ms(정각 포함) UNCONFIRMED·SEV3 경보 한 번(결정 14)
// - UNCONFIRMED 뒤 1분마다 나간 시각 + 10분 30초까지 다시 보고, 모두 맞으면 CONFIRMED·경보 닫음. 넘기면 멈춤(열린 채)(결정 14)
// - 판정: up == 1인 파드마다 판 지표 ≥ 판. 지표 없는 파드는 못 미친 파드(판 없음), 파드 0개는 UNKNOWN(no-targets)(결정 15)
// - Prometheus 실패는 UNKNOWN, 경보 없음, 30초를 넘겨도 UNCONFIRMED로 가지 않음(결정 15)
// - Outbox 행이 없어졌으면 나간 것으로 보고 처음 본 시각을 나간 시각으로(결정 14)
// - unackedTargets 글은 '<파드>:<판>', 판이 없으면 '<파드>:-'(계획 8.2, 14절 4 [가정])
// 판은 두 자리 넘김(…009 → …010, 9 → 10)을 넣어 숫자를 글로 견주는 결함을 잡는다. 시각은 모두 주입 값이다(실제 시계 없음).
import { describe, expect, test } from 'vitest';
import { applyCheckViewOf, nextApplyCheck, type ApplyCheckRow, type ProbeResult } from '../src/modules/commands/index.js';

const SEC = 1_000;
const MIN = 60 * SEC;
/** 정본 경계(결정 14) */
const OUTBOX_WAIT = 5 * SEC;
const WINDOW = 30 * SEC;
const RECHECK_UNTIL = 10 * MIN + 30 * SEC;

/** 설정 사건을 쓴 시각(명령 8 ACKED 트랜잭션) */
const WRITTEN = Date.parse('2026-11-23T05:00:00.000Z');
/** 나간 시각: 쓴 뒤 1,700ms(시험 값, 5초 상수와 다르게) */
const SENT = WRITTEN + 1_700;
/** 판(원장, occurredAt 밀리초). 끝자리 …010이라 …009가 '못 미친 판'이 된다 */
const V = 1_763_874_000_010;
const MESSAGE_KEY = 'PLATFORM:LOG_LEVEL:purchase-svc';

const rowOf = (over: Partial<ApplyCheckRow> = {}): ApplyCheckRow => ({
  commandId: '0193f000-0000-7000-8000-00000000c054',
  stage: 'ACKED',
  version: V,
  messageKey: MESSAGE_KEY,
  outboxId: '0193f000-0000-7000-8000-0000000000b1',
  service: 'purchase-svc',
  status: 'CHECKING',
  writtenAtMs: WRITTEN,
  pods: [],
  targetCount: 0,
  ackedCount: 0,
  alertOpen: false,
  nextCheckAtMs: WRITTEN,
  updatedAtMs: WRITTEN,
  ...over,
});

const sent = (atMs: number = SENT) => ({ exists: true, sentAtMs: atMs });
const unsent = { exists: true } as const;
const ok = (...pods: { pod: string; version?: number }[]): ProbeResult => ({ ok: true, pods });

/** 셋 가운데 하나(purchase-svc-1)가 판 지표를 내지 않는 파드 목록 */
const oneMissing = ok({ pod: 'purchase-svc-0', version: V }, { pod: 'purchase-svc-1' }, { pod: 'purchase-svc-2', version: V + 40 });
/** 모두 판 이상(하나는 더 새 판) */
const allAcked = ok({ pod: 'purchase-svc-0', version: V }, { pod: 'purchase-svc-1', version: V }, { pod: 'purchase-svc-2', version: V + 40 });

describe('F025-APPLY Outbox 대기(결정 14, B9)', () => {
  test('F025-APPLY ① 나가지 않은 행은 쓴 뒤 5,000ms 정각까지 CHECKING이고 5,001ms부터 OUTBOX_WAITING이다', () => {
    const at5000 = nextApplyCheck(rowOf(), { nowMs: WRITTEN + OUTBOX_WAIT, outbox: unsent });
    expect(at5000.row.status).toBe('CHECKING');
    expect(at5000.alert).toBeUndefined();
    const at5001 = nextApplyCheck(rowOf(), { nowMs: WRITTEN + OUTBOX_WAIT + 1, outbox: unsent });
    expect(at5001.row.status).toBe('OUTBOX_WAITING');
    expect(at5001.alert).toBeUndefined();
    expect(at5001.row.sentAtMs).toBeUndefined();
    expect(applyCheckViewOf(at5001.row)).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'OUTBOX_WAITING', targetCount: 0, ackedCount: 0, unackedTargets: [] });
  });

  test('F025-APPLY ② Kafka가 막힌 동안은 30초를 세지 않는다: 쓴 뒤 40초에도 나가지 않았으면 OUTBOX_WAITING이고 경보가 없다', () => {
    const r = nextApplyCheck(rowOf({ status: 'OUTBOX_WAITING' }), { nowMs: WRITTEN + 40 * SEC, outbox: unsent, probe: oneMissing });
    expect(r.row.status).toBe('OUTBOX_WAITING');
    expect(r.alert).toBeUndefined();
  });

  test('F025-APPLY ③ 30초는 나간 시각부터 센다: 쓴 뒤 20초에 나가 쓴 뒤 35초(나간 뒤 15초)에 못 미친 파드가 있어도 CHECKING이다', () => {
    const lateSent = WRITTEN + 20 * SEC;
    const r = nextApplyCheck(rowOf({ status: 'OUTBOX_WAITING' }), { nowMs: WRITTEN + 35 * SEC, outbox: sent(lateSent), probe: oneMissing });
    expect(r.row.status).toBe('CHECKING');
    expect(r.row.sentAtMs).toBe(lateSent);
    expect(r.alert).toBeUndefined();
    // 그 행의 30초 정각은 나간 시각 + 30,000ms다
    const due = nextApplyCheck(r.row, { nowMs: lateSent + WINDOW, outbox: sent(lateSent), probe: oneMissing });
    expect(due.row.status).toBe('UNCONFIRMED');
    expect(due.alert).toBe('OPEN');
  });

  test('F025-APPLY ④ Outbox 행이 없어졌으면(파티션 지우기) 나간 것으로 보고 처음 본 시각을 나간 시각으로 쓴다', () => {
    const firstSeen = WRITTEN + 12 * SEC;
    const r = nextApplyCheck(rowOf(), { nowMs: firstSeen, outbox: { exists: false }, probe: oneMissing });
    expect(r.row.sentAtMs).toBe(firstSeen);
    expect(r.row.status).toBe('CHECKING');
    const before = nextApplyCheck(r.row, { nowMs: firstSeen + WINDOW - 1, outbox: { exists: false }, probe: oneMissing });
    expect(before.row.sentAtMs).toBe(firstSeen);
    expect(before.row.status).toBe('CHECKING');
    const atWindow = nextApplyCheck(before.row, { nowMs: firstSeen + WINDOW, outbox: { exists: false }, probe: oneMissing });
    expect(atWindow.row.status).toBe('UNCONFIRMED');
  });
});

describe('F025-APPLY 30초와 판정(결정 14·15, B10·B12)', () => {
  test('F025-APPLY ⑤ 나간 뒤 29,999ms에 못 미친 파드가 있으면 CHECKING, 30,000ms 정각이면 UNCONFIRMED·경보 OPEN·못 미친 파드와 판', () => {
    const before = nextApplyCheck(rowOf({ sentAtMs: SENT }), { nowMs: SENT + WINDOW - 1, outbox: sent(), probe: oneMissing });
    expect(before.row.status).toBe('CHECKING');
    expect(before.alert).toBeUndefined();
    expect(before.row.alertOpen).toBe(false);

    const at = nextApplyCheck(before.row, { nowMs: SENT + WINDOW, outbox: sent(), probe: oneMissing });
    expect(at.row.status).toBe('UNCONFIRMED');
    expect(at.alert).toBe('OPEN');
    expect(at.row.alertOpen).toBe(true);
    expect(at.row.targetCount).toBe(3);
    expect(at.row.ackedCount).toBe(2);
    expect(applyCheckViewOf(at.row)).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'UNCONFIRMED', targetCount: 3, ackedCount: 2, unackedTargets: ['purchase-svc-1:-'] });
  });

  test('F025-APPLY ⑥ 판 지표가 판보다 작은 파드는 그 판을 실어 못 미친 파드다(…009 < …010)', () => {
    const r = nextApplyCheck(rowOf({ sentAtMs: SENT }), {
      nowMs: SENT + WINDOW,
      outbox: sent(),
      probe: ok({ pod: 'purchase-svc-0', version: V - 1 }, { pod: 'purchase-svc-1', version: V }),
    });
    expect(r.row.status).toBe('UNCONFIRMED');
    expect(applyCheckViewOf(r.row).unackedTargets).toEqual([`purchase-svc-0:${V - 1}`]);
    expect(applyCheckViewOf(r.row)).toMatchObject({ targetCount: 2, ackedCount: 1 });
  });

  test('F025-APPLY ⑦ 판 9와 10을 숫자로 견준다: 판 10에 9를 낸 파드는 못 미치고, 판 9에 10을 낸 파드는 맞는다', () => {
    const ten = nextApplyCheck(rowOf({ version: 10, sentAtMs: SENT }), { nowMs: SENT + WINDOW, outbox: sent(), probe: ok({ pod: 'core-svc-0', version: 9 }) });
    expect(ten.row.status).toBe('UNCONFIRMED');
    expect(applyCheckViewOf(ten.row).unackedTargets).toEqual(['core-svc-0:9']);
    const nine = nextApplyCheck(rowOf({ version: 9, sentAtMs: SENT }), { nowMs: SENT + 1_000, outbox: sent(), probe: ok({ pod: 'core-svc-0', version: 10 }) });
    expect(nine.row.status).toBe('CONFIRMED');
    expect(nine.alert).toBeUndefined();
  });

  test('F025-APPLY ⑧ 모든 파드가 판 이상이면 30초 전이라도 그 바퀴에 CONFIRMED이고 경보가 없다(더 새 판을 받은 파드도 맞음)', () => {
    const r = nextApplyCheck(rowOf({ sentAtMs: SENT }), { nowMs: SENT + 3 * SEC, outbox: sent(), probe: allAcked });
    expect(r.row.status).toBe('CONFIRMED');
    expect(r.alert).toBeUndefined();
    expect(r.row.alertOpen).toBe(false);
    expect(applyCheckViewOf(r.row)).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'CONFIRMED', targetCount: 3, ackedCount: 3, unackedTargets: [] });
  });

  test('F025-APPLY ⑨ 같은 키의 더 새 판을 받은 파드로 옛 행이 맞는다(판 이상 비교, 결정 14)', () => {
    const newer = V + 90_000;
    const r = nextApplyCheck(rowOf({ sentAtMs: SENT, status: 'UNCONFIRMED', alertOpen: true }), {
      nowMs: SENT + 90 * SEC,
      outbox: sent(),
      probe: ok({ pod: 'purchase-svc-0', version: newer }, { pod: 'purchase-svc-1', version: newer }),
    });
    expect(r.row.status).toBe('CONFIRMED');
    expect(r.alert).toBe('RESOLVE');
  });

  test('F025-APPLY ⑩ up 파드가 0개면 UNKNOWN(no-targets)이고 30초를 넘겨도 UNCONFIRMED·경보가 아니다(빈 목록을 모두 맞음으로 보지 않음)', () => {
    const early = nextApplyCheck(rowOf({ sentAtMs: SENT }), { nowMs: SENT + 1_000, outbox: sent(), probe: ok() });
    expect(early.row.status).toBe('UNKNOWN');
    expect(early.row.reason).toBe('no-targets');
    expect(early.alert).toBeUndefined();
    const late = nextApplyCheck(early.row, { nowMs: SENT + WINDOW + 5 * SEC, outbox: sent(), probe: ok() });
    expect(late.row.status).toBe('UNKNOWN');
    expect(late.row.reason).toBe('no-targets');
    expect(late.alert).toBeUndefined();
    expect(late.row.alertOpen).toBe(false);
  });

  test('F025-APPLY ⑪ Prometheus에 닿지 못하면 UNKNOWN(받은 사유), 경보 없음, 30초 정각·뒤에도 UNCONFIRMED로 가지 않는다(C-T54 ③의 판정 몫)', () => {
    const fail: ProbeResult = { ok: false, reason: 'prometheus-timeout' };
    const at = nextApplyCheck(rowOf({ sentAtMs: SENT }), { nowMs: SENT + WINDOW, outbox: sent(), probe: fail });
    expect(at.row.status).toBe('UNKNOWN');
    expect(at.row.reason).toBe('prometheus-timeout');
    expect(at.alert).toBeUndefined();
    const later = nextApplyCheck(at.row, { nowMs: SENT + 2 * MIN, outbox: sent(), probe: fail });
    expect(later.row.status).toBe('UNKNOWN');
    expect(later.alert).toBeUndefined();
    expect(later.row.alertOpen).toBe(false);
    // 다시 닿고 모두 맞으면 그 바퀴에 CONFIRMED
    const back = nextApplyCheck(later.row, { nowMs: SENT + 2 * MIN + 5 * SEC, outbox: sent(), probe: allAcked });
    expect(back.row.status).toBe('CONFIRMED');
  });

  test('F025-APPLY ⑫ 이미 UNCONFIRMED·경보 열림인 행을 다시 보아도 못 미치면 경보를 다시 열지 않는다(명령마다 하나)', () => {
    const open = rowOf({ sentAtMs: SENT, status: 'UNCONFIRMED', alertOpen: true });
    const r = nextApplyCheck(open, { nowMs: SENT + 90 * SEC, outbox: sent(), probe: oneMissing });
    expect(r.row.status).toBe('UNCONFIRMED');
    expect(r.alert).toBeUndefined();
    expect(r.row.alertOpen).toBe(true);
  });
});

describe('F025-APPLY 다시 보기(결정 14, B11)', () => {
  test('F025-APPLY ⑬ UNCONFIRMED가 되면 다음 볼 시각은 1분 뒤다', () => {
    const r = nextApplyCheck(rowOf({ sentAtMs: SENT }), { nowMs: SENT + WINDOW + 2_300, outbox: sent(), probe: oneMissing });
    expect(r.row.status).toBe('UNCONFIRMED');
    expect(r.row.nextCheckAtMs).toBe(SENT + WINDOW + 2_300 + MIN);
  });

  test('F025-APPLY ⑭ UNCONFIRMED 뒤 모두 맞으면 CONFIRMED로 바꾸고 경보를 닫는다(RESOLVE)', () => {
    const r = nextApplyCheck(rowOf({ sentAtMs: SENT, status: 'UNCONFIRMED', alertOpen: true }), { nowMs: SENT + 4 * MIN, outbox: sent(), probe: allAcked });
    expect(r.row.status).toBe('CONFIRMED');
    expect(r.alert).toBe('RESOLVE');
    expect(r.row.alertOpen).toBe(false);
    expect(applyCheckViewOf(r.row).unackedTargets).toEqual([]);
  });

  test('F025-APPLY ⑮ 나간 시각 + 10분 30초 − 1ms와 정각에는 다시 보아 맞으면 닫고, 그 뒤(+1ms)에는 맞아도 열린 채 UNCONFIRMED로 멈춘다', () => {
    const open = rowOf({ sentAtMs: SENT, status: 'UNCONFIRMED', alertOpen: true });
    const minus1 = nextApplyCheck(open, { nowMs: SENT + RECHECK_UNTIL - 1, outbox: sent(), probe: allAcked });
    expect(minus1.row.status).toBe('CONFIRMED');
    expect(minus1.alert).toBe('RESOLVE');
    const exact = nextApplyCheck(open, { nowMs: SENT + RECHECK_UNTIL, outbox: sent(), probe: allAcked });
    expect(exact.row.status).toBe('CONFIRMED');
    expect(exact.alert).toBe('RESOLVE');
    const past = nextApplyCheck(open, { nowMs: SENT + RECHECK_UNTIL + 1, outbox: sent(), probe: allAcked });
    expect(past.row.status).toBe('UNCONFIRMED');
    expect(past.row.alertOpen).toBe(true);
    expect(past.alert).toBeUndefined();
  });
});

describe('F025-APPLY 전파 칸(B16)', () => {
  test('F025-APPLY ⑯ 칸은 kind APPLY_CHECK와 상태·파드 수를 싣고, 못 미친 파드 글은 <파드>:<판>·<파드>:-이다', () => {
    const r = nextApplyCheck(rowOf({ sentAtMs: SENT }), {
      nowMs: SENT + WINDOW,
      outbox: sent(),
      probe: ok({ pod: 'ops-svc-b', version: V - 10 }, { pod: 'ops-svc-a' }, { pod: 'ops-svc-c', version: V }),
    });
    const view = applyCheckViewOf(r.row);
    expect(view.kind).toBe('APPLY_CHECK');
    expect(view.applyStatus).toBe('UNCONFIRMED');
    expect(view.targetCount).toBe(3);
    expect(view.ackedCount).toBe(1);
    expect([...view.unackedTargets].sort()).toEqual(['ops-svc-a:-', `ops-svc-b:${V - 10}`]);
  });

  test('F025-APPLY ⑰ UNKNOWN 칸도 kind APPLY_CHECK이고 applyStatus UNKNOWN이다', () => {
    const r = nextApplyCheck(rowOf({ sentAtMs: SENT }), { nowMs: SENT + 1_000, outbox: sent(), probe: { ok: false, reason: 'prometheus-not-wired' } });
    expect(applyCheckViewOf(r.row)).toMatchObject({ kind: 'APPLY_CHECK', applyStatus: 'UNKNOWN' });
  });
});
