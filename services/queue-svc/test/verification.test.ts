// 추가 검증 유스케이스를 메모리 저장소로 돈다(test/verification-cases.ts, 같은 사례를 실제 Valkey로는 test-int/verification-store.int.test.ts가 돈다).
// 사람 키 기록 읽기가 진입 컨텍스트의 기록 모양(parseHeld)과 어긋나지 않는지, 글자 세기가 합친 글자 단위인지도 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { parseHeld } from '../src/modules/entry/domain/queue.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { appealFits, entryRefOf, graphemeCount, parseVerify } from '../src/modules/verification/domain/verification.js';
import { hashOf, type VerificationWorld, verificationCases } from './verification-cases.js';

verificationCases('메모리', async () => {
  const clock = fakeClock({ now: Date.parse('2026-11-10T03:00:00Z') });
  const store = new MemoryVerificationStore(clock);
  const db = store.db;
  const w: VerificationWorld = {
    store,
    schedules: new MemoryEventSchedules(),
    clock,
    setDup: async (pid, e, v) => void db.dup.set(`${pid}|${e}`, v),
    setVerify: async (e, h, v) => void db.verifyOf(e).set(h, v),
    verifyOf: async (e, h) => db.verify.get(e)?.get(h) ?? null,
    setServing: async (e, n) => void db.serving.set(e, n),
    setServingLog: async (e, sec, n) => {
      const m = db.servingLog.get(e) ?? new Map<string, number>();
      m.set(String(sec), n);
      db.servingLog.set(e, m);
    },
    setLobbyResult: async (h, seq, gen) => void db.lobbyResults.set(h, `${seq}:${gen}`),
    appealRaw: async (pid, e) => {
      const h = db.appeals.get(`${pid}|${e}`);
      if (!h || clock.now() >= h.until) return {};
      return Object.fromEntries([...h.v].filter(([k]) => !['pc', 'pv', 'po'].includes(k)));
    },
    passTime: async (ms) => clock.advance(ms),
    vsubOf: async (pid, e) => {
      const x = db.vsub.get(`${pid}|${e}`);
      return x && clock.now() < x.until ? x.v : null;
    },
  };
  return w;
});

describe('사람 키 기록과 추가 검증 칸 읽기', () => {
  const t = hashOf('ticket');
  const values = [
    `12:1:rq-1:jny-1:DEVICE_HISTORY:${t}`,
    `12:3:rq-1:jny-1::${t}`,
    '12:1:rq-1:jny-1:',
    `BATCH:1:${t}:rq-2:jny-1:NETWORK`,
    `LOBBY:${t}:rq-3`,
    `LEAVING:rq-1:12:1:rq-1:jny-1:DEVICE_HISTORY:${t}`,
    'PENDING:rq-9',
    'LEFT:rq-9',
    'garbage',
  ];

  test('B-T11 q:dup 기록이 가리키는 대기 참여는 진입 컨텍스트의 parseHeld와 같은 칸을 고른다', () => {
    for (const v of values) {
      const held = parseHeld(v);
      const ref = entryRefOf(v);
      if (!held) {
        expect(ref, v).toBeNull();
        continue;
      }
      expect(ref, v).not.toBeNull();
      expect(ref!.kind).toBe(held.kind);
      if (held.kind === 'NUMBER') {
        expect(ref).toEqual({ kind: 'NUMBER', seq: held.seq, ...(held.ticketHash ? { fieldHash: held.ticketHash } : {}) });
      } else {
        expect(ref!.fieldHash).toBe(held.tokenHash);
      }
    }
  });

  test('B-T11 verify 칸 값은 VERIFYING·PASSED·BLOCKED·ORPHAN만 읽고 모르는 모양은 없음이다', () => {
    expect(parseVerify('VERIFYING:1700000000000:DEVICE_HISTORY')).toEqual({ state: 'VERIFYING', atMs: 1_700_000_000_000, reason: 'DEVICE_HISTORY' });
    expect(parseVerify('PASSED:5:')).toEqual({ state: 'PASSED', atMs: 5, reason: '' });
    expect(parseVerify('BLOCKED:6:NETWORK')).toEqual({ state: 'BLOCKED', atMs: 6, reason: 'NETWORK' });
    expect(parseVerify('ORPHAN:7')).toEqual({ state: 'ORPHAN', atMs: 7 });
    expect(parseVerify('REJECTED:7:X')).toBeNull();
    expect(parseVerify(null)).toBeNull();
  });

  test('[ASVS v5.0.0-2.2.1] 글자 수는 NFC 정규화 뒤 합친 글자(grapheme)로 세고 UTF-16 길이로 세지 않는다', () => {
    // 피부색이 붙은 이모지는 UTF-16 4단위지만 한 글자다
    expect(graphemeCount('👍🏽')).toBe(1);
    expect(graphemeCount('👍🏽'.repeat(1_000))).toBe(1_000);
    expect(appealFits('👍🏽'.repeat(1_000))).toBe(true);
    expect(appealFits('👍🏽'.repeat(1_001))).toBe(false);
    // 결합 문자(e + U+0301)는 NFC 뒤 한 글자
    expect(graphemeCount('é')).toBe(1);
    expect(appealFits('')).toBe(true);
  });

  test('[ASVS v5.0.0-2.2.1] 이의 글에 NUL·양방향 제어·0폭 글자가 있으면 받지 않고 각 범위 바로 바깥 글자는 받는다', () => {
    // 범위의 양 끝: NUL, U+202A~U+202E, U+2066~U+2069, U+200B~U+200D, U+FEFF
    const forbidden = [0x0000, 0x202a, 0x202e, 0x2066, 0x2069, 0x200b, 0x200d, 0xfeff];
    // 바로 바깥: U+0001, U+2029·U+202F, U+2065·U+206A, U+200A·U+200E, U+FEFE·U+FF00
    const outside = [0x0001, 0x2029, 0x202f, 0x2065, 0x206a, 0x200a, 0x200e, 0xfefe, 0xff00];
    for (const c of forbidden) expect(appealFits(`앞${String.fromCodePoint(c)}뒤`), c.toString(16)).toBe(false);
    for (const c of outside) expect(appealFits(`앞${String.fromCodePoint(c)}뒤`), c.toString(16)).toBe(true);
  });
});
