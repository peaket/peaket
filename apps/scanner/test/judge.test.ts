// F-05-4 스캐너 앱 판정 10단계 시험(계획 docs/review/plans/F-05-4.md §4 judge.ts·§6).
// 정본: docs/features/offline-gate.md §6.4(1~10 차례, '스캐너 앱 판정 첫 구현')·§3(±30초)·§7, 화면 문구 docs/design/d5-screen-blueprint.md §8.3 판정 표.
// 목록 상태는 시험이 계획 §4의 PackageState 모양으로 직접 만든다(package-state 구현과 따로 본다). QR은 시험이 WebCrypto 키로 서명한다.
// 새 모듈은 동적 불러오기로 읽는다: 모듈이 없으면 각 시험이 '함수가 있다'는 단언에서 떨어진다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { EntryState, PackageState } from '../src/storage/package-state.ts';
import { QR_MS, QR_SEC, qrText, stateOf, tamperedQrText, ticketOf, walletKey } from './scanner-fixture.ts';

type Outcome =
  | { result: 'PASS'; direction: 'IN' | 'OUT'; ticketId: string; keyId: string; qrTimestampMs: number; seatLabel: string }
  | { result: 'REJECT'; reason: string; direction: 'IN' | 'OUT'; ticketId?: string; keyId?: string; qrTimestampMs?: number; ticketGateZone?: string; lastEntry?: EntryState }
  | { result: 'CHECK'; reason: string; direction: 'IN' | 'OUT'; ticketId: string; keyId: string; qrTimestampMs: number; seatLabel: string; lastEntry?: EntryState }
  | { result: 'RETRY' };
type Verify = (publicKey: string, qr: unknown) => Promise<boolean>;
type JudgeModule = {
  judgeScan(i: { raw: string; state: PackageState; nowMs: number; clockOffsetMs: number; verify?: Verify }): Promise<Outcome>;
  messageOf(o: Outcome): string;
};
const MODULE = '../src/judge/judge.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<JudgeModule>;
function judge(): JudgeModule {
  for (const name of ['judgeScan', 'messageOf'] as const) assert.equal(typeof loaded[name], 'function', `${MODULE}의 ${name}가 없다`);
  return loaded as JudgeModule;
}

/** 결과에서 그 칸만 본다(거부의 선택 칸은 계획이 다 정하지 않았다) */
function expectOutcome(o: Outcome, want: Record<string, unknown>, label = ''): void {
  const got: Record<string, unknown> = {};
  for (const k of Object.keys(want)) got[k] = (o as Record<string, unknown>)[k];
  assert.deepEqual(got, want, label);
}

const vector = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/qr-v1-device-key.v1.json', import.meta.url), 'utf8')) as {
  keyIdB64u: string;
  compressedPublicKeyB64u: string;
  qr: { ticketId: string; timeSeconds: number; base45: string };
};

const T = '0190f3a1-7c2e-7a00-8b2a-6c1d5e700001';
const T2 = '0190f3a1-7c2e-7a00-8b2a-6c1d5e700002';
const UNLISTED = '0190f3a1-7c2e-7a00-8b2a-6c1d5e7000ff';
const key = await walletKey();
const otherKey = await walletKey();
const qrOf = (ticketId = T, timestampSec = QR_SEC) => qrText(key, { ticketId, timestampSec });
const base = (over: Parameters<typeof stateOf>[0] = { tickets: [ticketOf(T, key)] }) => stateOf(over);
const run = (raw: string, state: PackageState, nowMs = QR_MS, clockOffsetMs = 0, verify?: Verify) =>
  judge().judgeScan({ raw, state, nowMs, clockOffsetMs, ...(verify ? { verify } : {}) });

test('O-T33 벡터 QR은 그 티켓·키가 든 목록에서 통과(IN)이고 keyId·QR 시각·좌석이 실린다 [ASVS v5.0.0-2.2.1]', async () => {
  const state = stateOf({ tickets: [ticketOf(vector.qr.ticketId, { keyId: vector.keyIdB64u, publicKey: vector.compressedPublicKeyB64u })] });
  const o = await run(vector.qr.base45, state, vector.qr.timeSeconds * 1000);
  assert.deepEqual(o, { result: 'PASS', direction: 'IN', ticketId: vector.qr.ticketId, keyId: vector.keyIdB64u, qrTimestampMs: vector.qr.timeSeconds * 1000, seatLabel: 'R구역 12열 8번' });
  assert.equal(judge().messageOf(o), '통과');
});

test('O-T33 지원하지 않는 형식 버전과 빈 글은 거부이고 문구는 "유효하지 않은 QR입니다"다 [ASVS v5.0.0-2.2.1]', async () => {
  const { messageOf } = judge();
  const v2 = qrText(key, { ticketId: T, timestampSec: QR_SEC, version: 2 });
  const o = await run(await v2, base());
  expectOutcome(o, { result: 'REJECT', reason: 'UNSUPPORTED_VERSION', direction: 'IN' });
  assert.equal(messageOf(o), '유효하지 않은 QR입니다');
  const empty = await run('', base());
  expectOutcome(empty, { result: 'REJECT', reason: 'INVALID_QR', direction: 'IN' });
  assert.equal(messageOf(empty), '유효하지 않은 QR입니다');
});

test('O-T33 폐기 목록의 keyId는 KEY_REVOKED이고 문구는 "양도·취소·재발급된 티켓의 옛 QR입니다"다 [ASVS v5.0.0-2.2.1]', async () => {
  const o = await run(await qrOf(), base({ tickets: [ticketOf(T, otherKey)], revoked: [key.keyId] }));
  expectOutcome(o, { result: 'REJECT', reason: 'KEY_REVOKED', direction: 'IN', ticketId: T });
  assert.equal(judge().messageOf(o), '양도·취소·재발급된 티켓의 옛 QR입니다');
});

test('O-T33 서명 한 바이트를 바꾼 QR은 BAD_SIGNATURE이고 문구는 "위조가 의심됩니다"다 [ASVS v5.0.0-2.2.1]', async () => {
  const o = await run(await tamperedQrText(key, { ticketId: T, timestampSec: QR_SEC }), base());
  expectOutcome(o, { result: 'REJECT', reason: 'BAD_SIGNATURE', direction: 'IN', ticketId: T });
  assert.equal(judge().messageOf(o), '위조가 의심됩니다');
});

test('판정 차례: 단계마다 그 단계만 틀린 QR은 그 단계의 사유다(1~9) [ASVS v5.0.0-2.1.2]', async () => {
  const lastIn: EntryState = { lastDirection: 'IN', lastAtMs: QR_MS - 600_000, gateZone: '동문', source: 'CHANGES' };
  const cases: [string, string, PackageState, number][] = [
    ['INVALID_QR', 'not#base45', base(), QR_MS],
    ['UNKNOWN_TICKET', await qrOf(UNLISTED), base(), QR_MS],
    ['TICKET_CANCELLED', await qrOf(), base({ tickets: [ticketOf(T, key, { status: 'REFUNDED' })] }), QR_MS],
    ['KEY_REVOKED', await qrOf(), base({ tickets: [ticketOf(T, otherKey)], revoked: [key.keyId] }), QR_MS],
    ['KEY_UNKNOWN', await qrOf(), base({ tickets: [ticketOf(T, otherKey)] }), QR_MS],
    ['BAD_SIGNATURE', await tamperedQrText(key, { ticketId: T, timestampSec: QR_SEC }), base(), QR_MS],
    ['QR_EXPIRED', await qrOf(), base(), QR_MS + 31_000],
    ['WRONG_ZONE', await qrOf(), base({ tickets: [ticketOf(T, key, { gateZone: '서문' })] }), QR_MS],
    ['ALREADY_IN', await qrOf(), base({ tickets: [ticketOf(T, key)], entries: [[T, lastIn]] }), QR_MS],
  ];
  for (const [reason, raw, state, nowMs] of cases) expectOutcome(await run(raw, state, nowMs), { result: 'REJECT', reason }, reason);
});

test('판정 차례: 실패가 둘 이상인 QR은 앞 단계의 사유다 [ASVS v5.0.0-2.1.2]', async () => {
  const lastIn: EntryState = { lastDirection: 'IN', lastAtMs: QR_MS - 600_000, gateZone: '동문', source: 'LOCAL' };
  const cases: [string, string, PackageState, number][] = [
    // 목록에 없는 티켓 + 시각 초과 → 2단계
    ['UNKNOWN_TICKET', await qrOf(UNLISTED), base(), QR_MS + 31_000],
    // 취소 + 폐기 키 → 3단계
    ['TICKET_CANCELLED', await qrOf(), base({ tickets: [ticketOf(T, otherKey, { status: 'REFUNDED' })], revoked: [key.keyId] }), QR_MS],
    // 폐기 키 + 서명 틀림 → 4단계
    ['KEY_REVOKED', await tamperedQrText(key, { ticketId: T, timestampSec: QR_SEC }), base({ tickets: [ticketOf(T, otherKey)], revoked: [key.keyId] }), QR_MS],
    // 모르는 키 + 다른 구역 → 5단계
    ['KEY_UNKNOWN', await qrOf(), base({ tickets: [ticketOf(T, otherKey, { gateZone: '서문' })] }), QR_MS],
    // 서명 틀림 + 시각 초과 → 6단계
    ['BAD_SIGNATURE', await tamperedQrText(key, { ticketId: T, timestampSec: QR_SEC }), base(), QR_MS + 31_000],
    // 시각 초과 + 다른 구역 → 7단계
    ['QR_EXPIRED', await qrOf(), base({ tickets: [ticketOf(T, key, { gateZone: '서문' })] }), QR_MS + 31_000],
    // 다른 구역 + 입장 기록 있음 → 8단계
    ['WRONG_ZONE', await qrOf(), base({ tickets: [ticketOf(T, key, { gateZone: '서문' })], entries: [[T, lastIn]] }), QR_MS],
  ];
  for (const [reason, raw, state, nowMs] of cases) expectOutcome(await run(raw, state, nowMs), { result: 'REJECT', reason }, reason);
});

test('판정 차례: 취소 접수·환급·무효는 거부, 발권·활성·양도 대기·이상 표시는 통과, 목록이 모르는 상태 값은 다시 찍기다 [ASVS v5.0.0-2.1.2]', async () => {
  const { messageOf } = judge();
  for (const status of ['CANCEL_REQUESTED', 'REFUNDED', 'VOIDED']) {
    const o = await run(await qrOf(), base({ tickets: [ticketOf(T, key, { status })] }));
    expectOutcome(o, { result: 'REJECT', reason: 'TICKET_CANCELLED' }, status);
    assert.equal(messageOf(o), '취소되었거나 무효가 된 티켓입니다');
  }
  for (const status of ['ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'FLAGGED']) {
    expectOutcome(await run(await qrOf(), base({ tickets: [ticketOf(T, key, { status })] })), { result: 'PASS', direction: 'IN', ticketId: T }, status);
  }
  for (const status of ['SUSPENDED', '', 'active']) {
    const o = await run(await qrOf(), base({ tickets: [ticketOf(T, key, { status })] }));
    assert.deepEqual(o, { result: 'RETRY' }, JSON.stringify(status));
    assert.equal(messageOf(o), '다시 찍어 주세요');
  }
});

test('판정 차례: 유효 키에 있어도 공개키가 없거나 읽히지 않으면 KEY_UNKNOWN, 검증이 던지면 다시 찍기다 [ASVS v5.0.0-2.1.2]', async () => {
  expectOutcome(await run(await qrOf(), base({ tickets: [ticketOf(T, undefined, { keys: [{ keyId: key.keyId }] })] })), { result: 'REJECT', reason: 'KEY_UNKNOWN' }, '공개키 없음');
  expectOutcome(await run(await qrOf(), base({ tickets: [ticketOf(T, undefined, { keys: [{ keyId: key.keyId, publicKey: 'AAAA' }] })] })), { result: 'REJECT', reason: 'KEY_UNKNOWN' }, '공개키 못 읽음');
  let calls = 0;
  const throwing: Verify = async () => {
    calls++;
    throw new Error('시험이 넣은 검증 오류');
  };
  assert.deepEqual(await run(await qrOf(), base(), QR_MS, 0, throwing), { result: 'RETRY' });
  assert.equal(calls, 1, '주입한 검증을 불렀다');
});

test('O-T8 시각 경계: 보정 시각이 QR 시각 ±30,000ms면 통과, ±30,001ms면 QR_EXPIRED다(앞·뒤 양쪽, 오차 1,234ms를 더한 값)', async () => {
  const { messageOf } = judge();
  const raw = await qrOf();
  const offset = 1_234;
  // 보정 시각 = 기기 시각 + 오차 → 기기 시각 = 목표 보정 시각 − 오차
  for (const [delta, want] of [
    [30_000, 'PASS'],
    [-30_000, 'PASS'],
    [30_001, 'QR_EXPIRED'],
    [-30_001, 'QR_EXPIRED'],
  ] as const) {
    const o = await run(raw, base(), QR_MS + delta - offset, offset);
    if (want === 'PASS') expectOutcome(o, { result: 'PASS', qrTimestampMs: QR_MS }, String(delta));
    else {
      expectOutcome(o, { result: 'REJECT', reason: 'QR_EXPIRED' }, String(delta));
      assert.equal(messageOf(o), '유효시간이 지난 QR입니다');
    }
  }
});

test('O-T5 기기 시계가 +60,000ms·−60,000ms 어긋나도 근무 준비가 잰 오차를 쓰면 통과하고, 오차 0으로 판정하면 QR_EXPIRED다', async () => {
  const raw = await qrOf();
  expectOutcome(await run(raw, base(), QR_MS + 60_000, -60_000), { result: 'PASS', direction: 'IN' }, '+60초');
  expectOutcome(await run(raw, base(), QR_MS - 60_000, 60_000), { result: 'PASS', direction: 'IN' }, '−60초');
  expectOutcome(await run(raw, base(), QR_MS + 60_000, 0), { result: 'REJECT', reason: 'QR_EXPIRED' }, '+60초 보정 없음');
  expectOutcome(await run(raw, base(), QR_MS - 60_000, 0), { result: 'REJECT', reason: 'QR_EXPIRED' }, '−60초 보정 없음');
});

test('O-T3 티켓 구역이 기기 배치 구역과 다르면 WRONG_ZONE이고 티켓 구역을 실어 "다른 게이트 티켓입니다(서문)"로 안내한다', async () => {
  const o = await run(await qrOf(), base({ tickets: [ticketOf(T, key, { gateZone: '서문' })], placement: { gateZone: '동문', mode: 'IN', version: 2 } }));
  expectOutcome(o, { result: 'REJECT', reason: 'WRONG_ZONE', direction: 'IN', ticketId: T, ticketGateZone: '서문' });
  assert.equal(judge().messageOf(o), '다른 게이트 티켓입니다(서문)');
});

test('O-T25 목록이 모르는 키의 QR은 KEY_UNKNOWN이고 "키가 아직 반영되지 않았습니다. 부스나 책임자에게 안내하세요"다', async () => {
  const o = await run(await qrOf(), base({ tickets: [ticketOf(T, otherKey)] }));
  expectOutcome(o, { result: 'REJECT', reason: 'KEY_UNKNOWN', direction: 'IN', ticketId: T });
  assert.equal(judge().messageOf(o), '키가 아직 반영되지 않았습니다. 부스나 책임자에게 안내하세요');
});

test('O-T9 9단계 경계: 모드 둘 × 재입장 정책 둘 × 마지막 방향 셋(없음·IN·OUT) 열두 칸', async () => {
  const { messageOf } = judge();
  const raw = await qrOf();
  const entry = (d: 'IN' | 'OUT'): EntryState => ({ lastDirection: d, lastAtMs: QR_MS - 600_000, gateZone: '동문', source: 'CHANGES' });
  type Cell = ['IN' | 'OUT', boolean, 'none' | 'IN' | 'OUT', string, string?];
  const cells: Cell[] = [
    ['IN', false, 'none', 'PASS'],
    ['IN', false, 'IN', 'REJECT', 'ALREADY_IN'],
    ['IN', false, 'OUT', 'REJECT', 'ALREADY_IN'],
    ['IN', true, 'none', 'PASS'],
    ['IN', true, 'IN', 'CHECK', 'NO_EXIT_RECORD'],
    ['IN', true, 'OUT', 'PASS'],
    ['OUT', false, 'none', 'CHECK', 'NO_ENTRY_RECORD'],
    ['OUT', false, 'IN', 'PASS'],
    ['OUT', false, 'OUT', 'CHECK', 'NO_ENTRY_RECORD'],
    ['OUT', true, 'none', 'CHECK', 'NO_ENTRY_RECORD'],
    ['OUT', true, 'IN', 'PASS'],
    ['OUT', true, 'OUT', 'CHECK', 'NO_ENTRY_RECORD'],
  ];
  for (const [mode, reentryAllowed, last, result, reason] of cells) {
    const label = `${mode}·${reentryAllowed ? '허용' : '불허'}·${last}`;
    const state = base({ tickets: [ticketOf(T, key)], reentryAllowed, placement: { gateZone: '동문', mode, version: 3 }, entries: last === 'none' ? [] : [[T, entry(last)]] });
    const o = await run(raw, state);
    if (result === 'PASS') assert.deepEqual(o, { result: 'PASS', direction: mode, ticketId: T, keyId: key.keyId, qrTimestampMs: QR_MS, seatLabel: 'R구역 12열 8번' }, label);
    else expectOutcome(o, { result, reason, direction: mode, ticketId: T }, label);
    if (reason === 'NO_EXIT_RECORD') {
      expectOutcome(o, { keyId: key.keyId, qrTimestampMs: QR_MS, seatLabel: 'R구역 12열 8번' }, label);
      assert.equal(messageOf(o), '퇴장 기록 없음');
    }
    if (reason === 'NO_ENTRY_RECORD') assert.equal(messageOf(o), '입장 기록 없음');
  }
});

test('O-T23 다른 기기의 입장 상태(변경분)가 있는 티켓은 ALREADY_IN이고 마지막 시각·구역을 실어 "이미 입장한 티켓입니다(19:02, 동문)"로 보인다', async () => {
  // 시각은 한국 시각(Asia/Seoul)으로 보인다: 10:02Z = 19:02
  const lastEntry: EntryState = { lastDirection: 'IN', lastAtMs: Date.parse('2026-11-23T10:02:00.000Z'), gateZone: '동문', source: 'CHANGES' };
  const qrSec = Date.parse('2026-11-23T10:04:00.000Z') / 1000;
  const o = await run(await qrText(key, { ticketId: T, timestampSec: qrSec }), base({ tickets: [ticketOf(T, key)], entries: [[T, lastEntry]] }), qrSec * 1000);
  expectOutcome(o, { result: 'REJECT', reason: 'ALREADY_IN', direction: 'IN', ticketId: T, lastEntry });
  assert.equal(judge().messageOf(o), '이미 입장한 티켓입니다(19:02, 동문)');
});

test('O-T24 재입장 허용 회차에서 다른 기기의 퇴장(OUT)을 반영한 입장 기기는 같은 티켓을 통과(IN)시킨다', async () => {
  const out: EntryState = { lastDirection: 'OUT', lastAtMs: QR_MS - 5_000, gateZone: '동문', source: 'CHANGES' };
  const o = await run(await qrOf(), base({ tickets: [ticketOf(T, key), ticketOf(T2, key)], reentryAllowed: true, entries: [[T, out]] }));
  assert.deepEqual(o, { result: 'PASS', direction: 'IN', ticketId: T, keyId: key.keyId, qrTimestampMs: QR_MS, seatLabel: 'R구역 12열 8번' });
});

test('GAT-140 판정 문구는 d5 §8.3 표 그대로다(다른 회차·통과)', async () => {
  const { messageOf } = judge();
  const unknown = await run(await qrOf(UNLISTED), base());
  expectOutcome(unknown, { result: 'REJECT', reason: 'UNKNOWN_TICKET', direction: 'IN' });
  assert.equal(messageOf(unknown), '이 회차 티켓이 아니거나 발권되지 않은 티켓입니다');
  assert.equal(messageOf({ result: 'PASS', direction: 'OUT', ticketId: T, keyId: key.keyId, qrTimestampMs: QR_MS, seatLabel: 'A' }), '통과');
});
