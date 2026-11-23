// F-05-6 입장 기록 마감 판단의 순수 규칙 시험(BUILD_ORDER GAT-180, O-T29 ①②·⑤ 본문 검사).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'(로그인했던 기기·비웠다는 보고로 치는 것·판단·미보고 스캐너 건의 eventKey),
// openapi putScannerEventQueueReport 본문(pendingUploads 정수, 0 이상, 남는 칸 없음), 계획 docs/review/plans/F-05-6.md §4.
// 단언 값은 정본에서 숫자로 적는다: 역할 유효 끝 = ends_at + 7,200,000ms, 미보고 대기 = 86,400,000ms. 코드 상수를 가져오지 않는다.
// ends_at은 분·초 경계가 아닌 값으로 골라 반올림하는 결함이 드러나게 한다.
// 새 모듈(domain/entry-close.ts)은 아직 없으므로 시험마다 동적으로 불러온다(불러오기 실패가 그 시험의 실패가 된다).
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ScannerGateInputError } from '../src/modules/scanner/domain/scanner-gate.js';

type EntryCloseModule = typeof import('../src/modules/scanner/domain/entry-close.js');
const load = (): Promise<EntryCloseModule> => import('../src/modules/scanner/domain/entry-close.js');

/** 정본 '역할 유효 끝은 ends_at + 2시간' */
const ROLE_END_AFTER_ENDS_MS = 7_200_000;
/** 정본 '24시간 [가정]' */
const UNREPORTED_WAIT_MS = 86_400_000;
const ENDS = Date.parse('2026-11-23T12:17:43.219Z');
const R = ENDS + ROLE_END_AFTER_ENDS_MS;

const A = '0190f3a1-7c2e-7a00-8000-0000000f0601';
const B = '0190f3a1-7c2e-7a00-8000-0000000f0602';
const C = '0190f3a1-7c2e-7a00-8000-0000000f0603';

/** 정본 'scanner-unreported:{회차 ID}:{기기 ID}의 SHA-256 앞 16바이트로 만든 UUID'를 시험이 따로 계산한다 */
const unreportedKey = (eventId: string, deviceId: string): string => {
  const h = createHash('sha256').update(`scanner-unreported:${eventId}:${deviceId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** 던진 오류를 돌려준다(던지지 않으면 undefined). 단언은 바깥에서 한다 */
const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('입장 기록 마감 판단 decideEntryClose(offline-gate §7.3, O-T29 ①)', () => {
  test('O-T29 ① 로그인했던 기기가 없는 회차는 역할 유효 끝 1ms 전 판단에서는 마감되지 않고, 역할 유효 끝 판단에서 ALL_REPORTED로 마감된다', async () => {
    const m = await load();
    expect(m.decideEntryClose({ nowMs: R - 1, endsAtMs: ENDS, devices: [] })).toEqual({ close: false });
    expect(m.decideEntryClose({ nowMs: R, endsAtMs: ENDS, devices: [] })).toEqual({ close: true, reason: 'ALL_REPORTED', roleEndsAtMs: R, unreportedDeviceIds: [] });
  });

  test('O-T29 ① 역할 유효 끝 1ms 전에 받은 비움 보고는 세지 않고(마감 안 함), 역할 유효 끝에 받은 보고는 센다(ALL_REPORTED)', async () => {
    const m = await load();
    const early = m.decideEntryClose({ nowMs: R + 60_000, endsAtMs: ENDS, devices: [{ deviceId: A, report: { pendingUploads: 0, reportedAtMs: R - 1 } }] });
    expect(early).toEqual({ close: false });
    const onTime = m.decideEntryClose({ nowMs: R + 60_000, endsAtMs: ENDS, devices: [{ deviceId: A, report: { pendingUploads: 0, reportedAtMs: R } }] });
    expect(onTime).toEqual({ close: true, reason: 'ALL_REPORTED', roleEndsAtMs: R, unreportedDeviceIds: [] });
  });

  test('O-T29 ① 모든 기기가 역할 유효 끝에 비움을 보고했으면 판단 시각 R에서 ALL_REPORTED, R−1ms 판단에서는 마감하지 않는다', async () => {
    const m = await load();
    const devices = [
      { deviceId: A, report: { pendingUploads: 0, reportedAtMs: R } },
      { deviceId: B, report: { pendingUploads: 0, reportedAtMs: R } },
    ];
    expect(m.decideEntryClose({ nowMs: R - 1, endsAtMs: ENDS, devices })).toEqual({ close: false });
    expect(m.decideEntryClose({ nowMs: R, endsAtMs: ENDS, devices })).toEqual({ close: true, reason: 'ALL_REPORTED', roleEndsAtMs: R, unreportedDeviceIds: [] });
  });
});

describe('미보고 대기 끝의 TIMEOUT(offline-gate §7.3, O-T29 ②)', () => {
  test('O-T29 ② 한 대가 보고하지 않으면 역할 유효 끝 + 86,400,000ms 1ms 전에는 마감하지 않고, 그때 TIMEOUT으로 마감하며 미보고 기기는 그 한 대뿐이다', async () => {
    const m = await load();
    const devices = [{ deviceId: A, report: { pendingUploads: 0, reportedAtMs: R + 5 } }, { deviceId: B }];
    expect(m.decideEntryClose({ nowMs: R + UNREPORTED_WAIT_MS - 1, endsAtMs: ENDS, devices })).toEqual({ close: false });
    expect(m.decideEntryClose({ nowMs: R + UNREPORTED_WAIT_MS, endsAtMs: ENDS, devices })).toEqual({ close: true, reason: 'TIMEOUT', roleEndsAtMs: R, unreportedDeviceIds: [B] });
  });

  test('O-T29 ② 마지막 보고의 pendingUploads가 1이면 비운 것이 아니다(대기 끝에 TIMEOUT, 그 기기가 미보고)', async () => {
    const m = await load();
    const devices = [{ deviceId: A, report: { pendingUploads: 0, reportedAtMs: R } }, { deviceId: B, report: { pendingUploads: 1, reportedAtMs: R + 10 } }];
    expect(m.decideEntryClose({ nowMs: R + 60_000, endsAtMs: ENDS, devices })).toEqual({ close: false });
    expect(m.decideEntryClose({ nowMs: R + UNREPORTED_WAIT_MS, endsAtMs: ENDS, devices })).toEqual({ close: true, reason: 'TIMEOUT', roleEndsAtMs: R, unreportedDeviceIds: [B] });
  });

  test('O-T29 ② 역할 유효 끝 전에 보낸 pendingUploads 0 보고도 미보고로 센다(대기 끝 TIMEOUT의 미보고 목록에 든다)', async () => {
    const m = await load();
    const devices = [{ deviceId: A, report: { pendingUploads: 0, reportedAtMs: R - 1 } }, { deviceId: B, report: { pendingUploads: 0, reportedAtMs: R } }, { deviceId: C }];
    const d = m.decideEntryClose({ nowMs: R + UNREPORTED_WAIT_MS, endsAtMs: ENDS, devices });
    expect(d.close).toBe(true);
    expect(d).toMatchObject({ reason: 'TIMEOUT', roleEndsAtMs: R });
    expect(d.close && [...d.unreportedDeviceIds].sort()).toEqual([A, C].sort());
  });

  test('O-T29 ② 대기 끝 전에 그 기기가 비웠다고 보고하면 그 판단에서 ALL_REPORTED로 마감되고 미보고는 없다', async () => {
    const m = await load();
    const devices = [{ deviceId: A, report: { pendingUploads: 0, reportedAtMs: R } }, { deviceId: B, report: { pendingUploads: 0, reportedAtMs: R + 3_600_000 } }];
    expect(m.decideEntryClose({ nowMs: R + 3_600_001, endsAtMs: ENDS, devices })).toEqual({ close: true, reason: 'ALL_REPORTED', roleEndsAtMs: R, unreportedDeviceIds: [] });
  });

  test('O-T29 ② 대기 끝이 지났어도 모두 비웠다고 보고했으면 이유는 TIMEOUT이 아니라 ALL_REPORTED다', async () => {
    const m = await load();
    const devices = [{ deviceId: A, report: { pendingUploads: 0, reportedAtMs: R + UNREPORTED_WAIT_MS + 1 } }];
    expect(m.decideEntryClose({ nowMs: R + UNREPORTED_WAIT_MS + 2, endsAtMs: ENDS, devices })).toEqual({ close: true, reason: 'ALL_REPORTED', roleEndsAtMs: R, unreportedDeviceIds: [] });
  });
});

describe('미보고 스캐너 건의 eventKey(offline-gate §7.3, O-T29 ②)', () => {
  test('O-T29 ② eventKey는 scanner-unreported:{회차}:{기기}의 SHA-256 앞 16바이트 UUID(소문자 8-4-4-4-12)이고 회차·기기마다 다르다', async () => {
    const m = await load();
    const eventId = randomUUID();
    const key = m.scannerUnreportedEventKey(eventId, A);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(key).toBe(unreportedKey(eventId, A));
    // 같은 입력은 같은 키(다시 보내도 ops-svc에서 한 건), 기기·회차가 다르면 다른 키
    expect(m.scannerUnreportedEventKey(eventId, A)).toBe(key);
    expect(m.scannerUnreportedEventKey(eventId, B)).toBe(unreportedKey(eventId, B));
    expect(m.scannerUnreportedEventKey(eventId, B)).not.toBe(key);
    const other = randomUUID();
    expect(m.scannerUnreportedEventKey(other, A)).toBe(unreportedKey(other, A));
    expect(m.scannerUnreportedEventKey(other, A)).not.toBe(key);
  });
});

describe('큐 비움 보고 본문 assertQueueReport(openapi putScannerEventQueueReport, O-T29 ⑤)', () => {
  test('O-T29 ⑤ pendingUploads가 0 이상 정수이면 그 값을 돌려준다(0과 0이 아닌 값)', async () => {
    const m = await load();
    expect(m.assertQueueReport({ pendingUploads: 0 })).toEqual({ pendingUploads: 0 });
    expect(m.assertQueueReport({ pendingUploads: 37 })).toEqual({ pendingUploads: 37 });
  });

  test('O-T29 ⑤ 음수·실수·글자·빠짐·null·남는 칸·배열·객체 아님은 ScannerGateInputError(QUEUE)다', async () => {
    const m = await load();
    const bad: unknown[] = [{ pendingUploads: -1 }, { pendingUploads: 1.5 }, { pendingUploads: '0' }, { pendingUploads: null }, {}, { pendingUploads: 0, extra: 1 }, [{ pendingUploads: 0 }], null, 'pendingUploads=0', 0];
    for (const body of bad) {
      const e = thrown(() => m.assertQueueReport(body));
      expect(e, JSON.stringify(body)).toBeInstanceOf(ScannerGateInputError);
      expect((e as ScannerGateInputError).code, JSON.stringify(body)).toBe('QUEUE');
    }
  });
});
