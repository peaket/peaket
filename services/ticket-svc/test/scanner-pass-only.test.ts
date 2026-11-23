// IR-05 재현 시험(구현 리뷰): 앱이 거부한 기록은 '가장 이른 IN'·중복 판정에 끼지 않는다.
// 정본 offline-gate §7.1은 '같은 티켓의 통과 기록이 둘 이상'만 중복으로 본다. 거부·확인 필요 기록은 남기되 판정 기준이 아니다.
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5801';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f5802';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f5803';
const A = '0190f3a1-7c2e-7a00-8000-0000000f5804';
const B = '0190f3a1-7c2e-7a00-8000-0000000f5805';
const C = '0190f3a1-7c2e-7a00-8000-0000000f5806';
const D = '0190f3a1-7c2e-7a00-8000-0000000f5807';

let store: MemoryScannerGateStore;
let n = 0;

const scan = (ticketId: string, atMs: number, result: 'PASS' | 'REJECT' | 'CHECK', reason?: ScanEventInput['reason']): ScanEventInput => ({
  id: `0190f3a1-7c2e-7f00-8000-${String(++n).padStart(12, '0')}`,
  eventId: EVENT,
  ticketId,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result,
  ...(reason !== undefined ? { reason } : {}),
  gateZone: '동문',
  scannedAtDevice: new Date(atMs).toISOString(),
  knownSeq: 0,
  deviceSeq: n,
});
const accept = (scans: ScanEventInput[], o: { reentryAllowed?: boolean } = {}) =>
  store.acceptScans({
    eventId: EVENT,
    deviceId: DEVICE,
    sessionId: SESSION,
    sessions: { [SESSION]: { accountId: 'acc', validFromMs: T0 - 3_600_000, validUntilMs: T0 + 3_600_000 } },
    ...(o.reentryAllowed === true ? { reentryAllowed: true } : {}),
    scans,
    nowMs: T0 + 3_600_000,
  });
const duplicates = () => [...store.flags.values()].filter((f) => f.kind === 'DUPLICATE');

beforeEach(() => {
  store = new MemoryScannerGateStore();
  for (const id of [A, B, C, D]) store.seedTicket({ ticketId: id, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  n = 0;
});

describe('IR-05 거부 기록은 통과 IN 중복 판정에 끼지 않는다', () => {
  test('나중에 통과한 PASS 뒤에 더 이른 BAD_SIGNATURE 거부가 올라와도 PASS는 내려가지 않고 DUPLICATE도 없다', async () => {
    const pass = scan(A, T0 + 10_000, 'PASS');
    expect((await accept([pass])).flags).toEqual([]);
    const reject = scan(A, T0, 'REJECT', 'BAD_SIGNATURE');
    const r = await accept([reject]);
    expect(r.flags).toEqual([]);
    expect(store.scans.get(pass.id)).toMatchObject({ result: 'PASS', flag: 'NONE' });
    expect(store.scans.get(reject.id)).toMatchObject({ result: 'REJECT', reason: 'BAD_SIGNATURE', flag: 'NONE' });
    expect(duplicates()).toEqual([]);
  });

  test('통과한 PASS 뒤에 더 늦은 QR_EXPIRED 거부가 올라와도 거부는 거부로 남고 DUPLICATE가 붙지 않는다', async () => {
    const pass = scan(B, T0 + 10_000, 'PASS');
    expect((await accept([pass])).flags).toEqual([]);
    const reject = scan(B, T0 + 20_000, 'REJECT', 'QR_EXPIRED');
    const r = await accept([reject]);
    expect(r.flags).toEqual([]);
    expect(store.scans.get(reject.id)).toMatchObject({ result: 'REJECT', reason: 'QR_EXPIRED', flag: 'NONE' });
    expect(duplicates()).toEqual([]);
  });

  test('통과 기록 둘은 지금처럼 늦은 쪽이 ALREADY_IN·DUPLICATE다(고침이 중복 탐지를 끄지 않았다)', async () => {
    const first = scan(C, T0 + 10_000, 'PASS');
    await accept([first]);
    const second = scan(C, T0 + 20_000, 'PASS');
    const r = await accept([second]);
    expect(r.flags.map((f) => f.kind)).toEqual(['DUPLICATE']);
    expect(store.scans.get(second.id)).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN' });
    expect(store.scans.get(first.id)).toMatchObject({ result: 'PASS' });
  });

  test('재입장 허용 회차에서도 거부 기록은 REJECT/사유 그대로이고 NO_EXIT를 만들지 않는다', async () => {
    const pass = scan(D, T0 + 10_000, 'PASS');
    expect((await accept([pass], { reentryAllowed: true })).flags).toEqual([]);
    for (const reason of ['BAD_SIGNATURE', 'QR_EXPIRED', 'KEY_UNKNOWN'] as const) {
      const reject = scan(D, T0 + 20_000, 'REJECT', reason);
      const r = await accept([reject], { reentryAllowed: true });
      expect(r.flags, reason).toEqual([]);
      expect(store.scans.get(reject.id), reason).toMatchObject({ result: 'REJECT', reason, flag: 'NONE' });
      expect(store.scans.get(pass.id), reason).toMatchObject({ result: 'PASS' });
    }
    // 앱이 실제로 보내는 재입장 확인(CHECK/NO_EXIT_RECORD)은 §7.1의 NO_EXIT 이상 표시를 만든다
    const check = scan(D, T0 + 30_000, 'CHECK', 'NO_EXIT_RECORD');
    const rc = await accept([check], { reentryAllowed: true });
    expect(rc.flags.map((f) => f.kind)).toEqual(['NO_EXIT']);
    expect(store.scans.get(check.id)).toMatchObject({ result: 'CHECK', reason: 'NO_EXIT_RECORD', flag: 'NO_EXIT' });
    // 재입장 허용 회차의 PASS 다음 PASS는 지금처럼 확인 필요(퇴장 기록 없음)다
    const second = scan(D, T0 + 40_000, 'PASS');
    const r = await accept([second], { reentryAllowed: true });
    expect(r.flags.map((f) => f.kind)).toEqual(['NO_EXIT']);
    expect(store.scans.get(second.id)).toMatchObject({ result: 'CHECK', reason: 'NO_EXIT_RECORD' });
  });
});
