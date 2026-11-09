// S-T27 다시 재기 측정 도구의 시험(docs/features/seat-hold.md §8 'S-T27 다시 재기', BUILD_ORDER PRF-135).
// 대상: loadtest/poc/seat-lua.mjs(운영 Lua 내보내기), bench/src/seat-contract.mjs(운영 KEYS·ARGV와 같은 규칙), bench/src/oversell.mjs(오버셀 검사),
// st27-plan.mjs·st27-plan.json(정식 측정 계획과 상태 파일).
// 운영 조립과 같은지는 운영 RedisSeatStore를 가짜 HotRedis로 부르는 자식 프로세스(fixtures/seat-store-probe.mjs)의 출력과 견준다.
// Docker·Redis는 건드리지 않는다. 실행: node --test loadtest/test/poc-seat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEAT_LUA, exportSeatLua, readSeatLua } from '../poc/seat-lua.mjs';
import {
  EXPIRY_BACKOFF_MS,
  EXPIRY_BATCH_SIZE,
  EXPIRY_CONCURRENCY,
  EXPIRY_MAX_BATCHES_PER_TICK,
  EXPIRY_TICK_MS,
  REHOLD_WAIT_MS,
  dueHoldCommand,
  dueRangeCommand,
  expireCall,
  holdCall,
  parseDueHold,
  parseDueRange,
  parseExpire,
  parseHold,
  relayTrimCommand,
  replayCommand,
  seatKeys,
  streamTailCommand,
} from '../poc/bench/src/seat-contract.mjs';
import { MAX_TIME_US, SeatLog, bitAt, checkOversell, compareSeats } from '../poc/bench/src/oversell.mjs';
import { mixedP99Percentiles, parseArgs } from '../poc/bench/src/lib.mjs';
import { batchOutcome, isResting, nextTickDelayMs, runLanes, runSweepLoop, sweepOrder } from '../poc/bench/src/sweep-rules.mjs';
import { PLAN_PATH, benchArgs, checkState, ledgerOf, loadPlan, newState, pendingRuns, pickSeries, readState, runIdOf, validatePlan, writeState } from '../poc/st27-plan.mjs';

const PROBE = fileURLToPath(new URL('./fixtures/seat-store-probe.mjs', import.meta.url));
const SEAT_SHARD = fileURLToPath(new URL('../poc/bench/src/seat-shard.mjs', import.meta.url));

/** 운영 RedisSeatStore를 자식 프로세스로 부른다(ops 하나마다 새 가짜 HotRedis) */
function probe(ops) {
  const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', PROBE], { input: JSON.stringify({ ops }), encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`운영 좌석 저장소를 부르지 못했다(종료 코드 ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// 운영 Lua 원문을 한 번 읽고, 임시 폴더로 한 번 내보낸다
const sources = await readSeatLua();
const outDir = mkdtempSync(join(tmpdir(), 'peaket-seat-lua-'));
const exported = await exportSeatLua(outDir);
const exportedText = Object.fromEntries(exported.map((r) => [r.file, readFileSync(r.path, 'utf8')]));
rmSync(outDir, { recursive: true, force: true });

// ───────────────────────── 1. 운영 Lua 내보내기 ─────────────────────────

for (const s of SEAT_LUA) {
  test(`ST27_NFR003_내보낸 ${s.file}는 ${s.module} ${s.name}과 글자 하나 다르지 않고, 빈 글이 아니며 첫 줄이 #!lua다`, () => {
    const src = sources.find((x) => x.file === s.file).text;
    assert.equal(exportedText[s.file], src, '내보낸 글이 원문과 다르다');
    // 만료 Lua(expire-lua.ts EXPIRE_LUA)는 구현 담당이 시험을 쓴 뒤 채운다. 그 전까지 이 시험은 실패한다(건너뛰지 않는다)
    assert.ok(src.length > 0, `${s.module} ${s.name}이(가) 빈 글이다. 원문을 채우면 통과한다`);
    assert.equal(src.split('\n')[0], '#!lua', '첫 줄이 #!lua가 아니다(ADR-0086, 내보낼 때 머리 주석을 붙이면 안 된다)');
    const meta = exported.find((x) => x.file === s.file);
    assert.equal(meta.empty, false);
    assert.equal(meta.bytes, Buffer.byteLength(src));
  });
}

// ───────────────────────── 2. 운영 조립과 같은 규칙 ─────────────────────────

const seat = (index, sectionIndex, seatOffset) => ({ seatId: `S${String(index).padStart(6, '0')}`, index, sectionId: `SEC${sectionIndex}`, sectionIndex, seatOffset, tierId: `T${sectionIndex % 4}` });
const holdInputs = [
  { eventId: 'st27e0x3', accountId: 'a42', purchaseSessionId: 'ps42', holdId: '0193f0a4-1111-7000-8000-000000000001', idempotencyKey: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', fingerprint: 'a'.repeat(64), seats: [seat(7, 0, 7)], limit: 4, keepUntilMs: 1_800_000_000_000 },
  // 구역 경계를 넘는 넉 석(구역 두 개)
  { eventId: 'E-big_1', accountId: 'acct_9', purchaseSessionId: 'ps-9', holdId: 'h-2', idempotencyKey: '9b2d3c1e-0000-4000-8000-000000000002', fingerprint: 'b'.repeat(64), seats: [seat(2498, 0, 2498), seat(2499, 0, 2499), seat(2500, 1, 0), seat(2501, 1, 1)], limit: 2, keepUntilMs: 1_799_999_999_999 },
];
const expireInputs = [
  {
    eventId: 'E1',
    keepUntilMs: 1_800_000_000_000,
    seats: [
      { index: 5, expected: { holdId: 'h1', fencingToken: '1730000000000001', owner: 'a1' }, seat: seat(5, 0, 5) },
      { index: 7, expected: null, seat: seat(7, 0, 7) },
      { index: 9, expected: { holdId: 'h2', fencingToken: '1730000000000002', owner: 'a2' } },
      { index: 11, expected: { holdId: 'h3', fencingToken: '1730000000000003', owner: 'a1' }, seat: seat(11, 1, 0) },
    ],
  },
];
const replayInput = { eventId: 'E1', accountId: 'a7', idempotencyKey: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', fingerprint: 'c'.repeat(64) };
const dueInput = { eventId: 'E1', nowMs: 1_730_000_000_000, limit: 100 };
const prod = probe([
  { op: 'keys', args: ['E1', 'X2', 'Y3'] },
  ...holdInputs.map((input) => ({ op: 'hold', input, replies: { EVAL: [['OK', '1730000000000123', '1730000000000', '1730000420000']] } })),
  { op: 'replay', input: replayInput, replies: { HMGET: [[null, null]] } },
  ...expireInputs.map((input) => ({ op: 'expire', input, replies: { EVAL: [['OK', '1730000000500000', '2', '1', '1', '5', '1730000000000001', '11', '1730000000000003']] } })),
  { op: 'dueExpiries', input: dueInput, replies: { ZRANGE: [['5', '1729999999000', '7', '1729999999001']], HMGET: [['h1', '1730000000000001', 'a1'], [null, null, null]] } },
]);
const prodOf = (op) => prod.results.filter((r) => r.op === op);

test('ST27_NFR003_측정 도구의 상수는 운영 값과 같다(만료 묶음 100석·한 틱 20묶음·반복 1초·동시 회차 4·오류 뒤 5초 쉼·다시 잡기 30초)', () => {
  assert.equal(EXPIRY_BATCH_SIZE, prod.constants.EXPIRY_BATCH_SIZE);
  assert.equal(EXPIRY_MAX_BATCHES_PER_TICK, prod.constants.EXPIRY_MAX_BATCHES_PER_TICK);
  assert.equal(EXPIRY_TICK_MS, prod.constants.EXPIRY_TICK_MS);
  assert.equal(EXPIRY_CONCURRENCY, prod.constants.EXPIRY_CONCURRENCY);
  assert.equal(EXPIRY_BACKOFF_MS, prod.constants.EXPIRY_BACKOFF_MS);
  assert.equal(REHOLD_WAIT_MS, prod.constants.REHOLD_WAIT_MS);
});

test('ST27_NFR003_seatKeys는 운영 seatKeys와 이름과 결과가 같다', () => {
  const p = prodOf('keys')[0].result;
  assert.deepEqual(Object.keys(seatKeys).sort(), Object.keys(p).sort());
  for (const [name, fn] of Object.entries(seatKeys)) assert.equal(fn('E1', 'X2', 'Y3'), p[name], name);
});

test('ST27_NFR003_holdCall은 운영 RedisSeatStore.hold와 같은 KEYS·ARGV를 내고, 운영이 보내는 Lua는 내보낸 seat-hold.lua와 같다', () => {
  const runs = prodOf('hold');
  assert.equal(runs.length, holdInputs.length);
  holdInputs.forEach((input, k) => {
    const p = runs[k];
    assert.equal(p.error, undefined, p.error);
    assert.equal(p.calls.length, 1);
    const mine = holdCall({ ...input, ttlMs: prod.constants.HOLD_TTL_MS });
    assert.deepEqual(mine.keys, p.calls[0].keys);
    assert.deepEqual(mine.args, p.calls[0].args);
    assert.equal(p.calls[0].lua, exportedText['seat-hold.lua']);
    // 측정은 TTL(ARGV 6)만 바꾼다
    const short = holdCall({ ...input, ttlMs: 5000 });
    assert.deepEqual(short.keys, mine.keys);
    assert.deepEqual(short.args.filter((_, i) => i !== 5), mine.args.filter((_, i) => i !== 5));
    assert.equal(short.args[5], '5000');
  });
});

test('ST27_NFR003_replayCommand는 운영 RedisSeatStore.replay와 같은 HMGET 한 번이다', () => {
  const [p] = prodOf('replay');
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.calls.length, 1);
  const mine = replayCommand(replayInput.eventId, replayInput.accountId, replayInput.idempotencyKey);
  assert.deepEqual(mine.args, p.calls[0].args);
  assert.equal(mine.key, p.calls[0].key);
});

test('ST27_NFR003_expireCall은 expire-lua.ts 계약의 KEYS·ARGV 차례를 따른다(계정은 처음 나온 차례, 고아는 빈 글·0, 좌석이 없으면 좌석 칸 빈 글)', () => {
  const x = expireCall(expireInputs[0]);
  const k = (s) => `s:{event:E1}:${s}`;
  assert.deepEqual(x.owners, ['a1', 'a2']);
  assert.deepEqual(x.keys, [k('bitmap'), k('expiry'), k('stream'), k('epoch'), k('secver'), k('hold:5'), k('hold:7'), k('hold:9'), k('hold:11'), k('quota:a1'), k('quota:a2'), k('rel:a1'), k('rel:a2')]);
  assert.deepEqual(x.args, [
    '30000', 's:{event:E1}:sec:', '1800000000000', '2', 'a1', 'a2',
    '5', 'h1', '1730000000000001', '1', '0', '5', 'S000005', 'T0', 'SEC0',
    '7', '', '', '0', '0', '7', 'S000007', 'T0', 'SEC0',
    '9', 'h2', '1730000000000002', '2', '', '', '', '', '',
    '11', 'h3', '1730000000000003', '1', '1', '0', 'S000011', 'T1', 'SEC1',
  ]);
  // #KEYS = 5 + n + 2m, #ARGV = 4 + m + 9n
  assert.equal(x.keys.length, 5 + 4 + 2 * 2);
  assert.equal(x.args.length, 4 + 2 + 9 * 4);
});

test('ST27_NFR003_expireCall은 운영 RedisSeatStore.expire와 같은 KEYS·ARGV를 낸다', () => {
  const [p] = prodOf('expire');
  assert.equal(p.error, undefined, p.error);
  const mine = expireCall(expireInputs[0]);
  assert.deepEqual(mine.keys, p.calls[0].keys);
  assert.deepEqual(mine.args, p.calls[0].args);
  assert.equal(p.calls[0].lua, exportedText['seat-expire.lua']);
  assert.deepEqual(parseExpire(['OK', '1730000000500000', '2', '1', '1', '5', '1730000000000001', '11', '1730000000000003']).expired, p.result.expired);
});

test('ST27_NFR003_만료 1단계(ZRANGE … LIMIT 0 100 → 좌석마다 HMGET)는 운영 RedisSeatStore.dueExpiries와 같은 명령·결과다', () => {
  const [p] = prodOf('dueExpiries');
  assert.equal(p.error, undefined, p.error);
  const range = dueRangeCommand(dueInput.eventId, dueInput.nowMs, dueInput.limit);
  const due = parseDueRange(['5', '1729999999000', '7', '1729999999001']);
  const mine = [range.args, ...due.map((d) => dueHoldCommand(dueInput.eventId, d.index).args)];
  assert.deepEqual(p.calls.map((c) => c.args), mine);
  const replies = [['h1', '1730000000000001', 'a1'], [null, null, null]];
  assert.deepEqual(p.result, due.map((d, i) => ({ ...d, hold: parseDueHold(replies[i], d.index) })));
});

test('ST27_NFR003_만료 1단계 명령과 릴레이 흉내 명령의 모양', () => {
  assert.deepEqual(dueRangeCommand('E1', 1730000000000, 100), { key: 's:{event:E1}:expiry', args: ['ZRANGE', 's:{event:E1}:expiry', '-inf', '1730000000000', 'BYSCORE', 'LIMIT', '0', '100', 'WITHSCORES'] });
  assert.deepEqual(dueHoldCommand('E1', 42).args, ['HMGET', 's:{event:E1}:hold:42', 'holdId', 'fence', 'owner']);
  assert.deepEqual(relayTrimCommand('E1', '1730000000000-3').args, ['XTRIM', 's:{event:E1}:stream', 'MINID', '1730000000000-3']);
  assert.deepEqual(streamTailCommand('E1').args, ['XREVRANGE', 's:{event:E1}:stream', '+', '-', 'COUNT', '1']);
});

// ───────────────────────── 3. 답 읽기 ─────────────────────────

test('ST27_NFR003_parseHold: OK의 토큰(약 1.7e15)을 정확히 읽고, 안전한 정수가 아니면 Error다', () => {
  assert.deepEqual(parseHold(['OK', '1730000000000123', '1730000000000', '1730000420000']), { kind: 'OK', fencingToken: 1730000000000123, heldAtMs: 1730000000000, expiresAtMs: 1730000420000 });
  assert.deepEqual(parseHold(['CONFLICT', '7']), { kind: 'CONFLICT' });
  assert.deepEqual(parseHold([Buffer.from('REHOLD_WAIT'), '1', '7']), { kind: 'REHOLD_WAIT' });
  assert.throws(() => parseHold(['OK', '9007199254740993', '1', '2']), /안전한 정수/);
  assert.throws(() => parseHold(['OK', '1.7e15', '1', '2']), /안전한 정수/);
  assert.throws(() => parseHold('OK'), /모르는 값/);
});

test('ST27_NFR003_parseExpire: 계약 6의 모양을 읽고, 길이·토큰이 틀리면 Error다', () => {
  assert.deepEqual(parseExpire(['NOT_READY']), { kind: 'NOT_READY' });
  assert.deepEqual(parseExpire(['OK', '1730000000500000', '0', '3', '0']), { kind: 'OK', nowUs: 1730000000500000, released: 0, skipped: 3, orphans: 0, expired: [] });
  const r = parseExpire(['OK', '1730000000500000', '2', '0', '1', '5', '1730000000000001', '11', '9007199254740991']);
  assert.deepEqual(r.expired, [{ index: 5, fencingToken: 1730000000000001 }, { index: 11, fencingToken: 9007199254740991 }]);
  assert.throws(() => parseExpire(['OK', '1730000000500000', '2', '0', '0', '5', '1']), /길이/);
  assert.throws(() => parseExpire(['OK', '1730000000500000', '1', '0', '0', '5', '9007199254740993']), /안전한 정수/);
  assert.throws(() => parseExpire(['WHAT']), /모르는 값/);
});

test('ST27_NFR003_parseDueRange는 RESP2·RESP3 답을 같게 읽고, parseDueHold는 세 칸이 모두 없으면 null·일부만 있으면 Error다', () => {
  const want = [{ index: 5, expiresAtMs: 1729999999000 }, { index: 7, expiresAtMs: 1729999999001 }];
  assert.deepEqual(parseDueRange(['5', '1729999999000', '7', '1729999999001']), want);
  assert.deepEqual(parseDueRange([['5', 1729999999000], ['7', 1729999999001]]), want);
  assert.deepEqual(parseDueRange([]), []);
  assert.throws(() => parseDueRange(['x', '1']), /좌석 색인/);
  assert.deepEqual(parseDueHold(['h1', '1730000000000001', 'a1'], 5), { holdId: 'h1', fencingToken: '1730000000000001', owner: 'a1' });
  assert.equal(parseDueHold([null, null, null], 5), null);
  assert.throws(() => parseDueHold(['h1', null, 'a1'], 5), /PEAKET_CORRUPT_KEY/);
});

// ───────────────────────── 4. 오버셀 검사(Float64·µs 순서) ─────────────────────────

const T0 = 1_730_000_000_000_000; // 2024년 무렵의 µs(약 1.7e15). Int32·'토큰 × 2^17'이 넘치는 크기
const TTL_US = 5_000_000;

test('ST27_NFR003_예전 표현(Int32·토큰 × 2^17)은 이 크기의 토큰에서 넘친다(고친 까닭)', () => {
  assert.notEqual(Int32Array.of(T0)[0], T0);
  assert.ok(T0 * 131072 > Number.MAX_SAFE_INTEGER);
  assert.ok(T0 * 2 + 1 <= Number.MAX_SAFE_INTEGER);
});

test('ST27_NFR003_큰 토큰으로 좌석마다 잡기·놓기가 번갈아 오면 오버셀 0·짝 없는 놓기 0이고, 기록 차례와 상관없다', () => {
  const entries = [];
  // 좌석 3: 잡기 → 놓기 → 같은 µs에 다시 잡기(토큰 = 놓은 µs) → 놓기 → 잡기(끝에 잡혀 있음)
  entries.push(['h', T0, 3], ['r', T0 + TTL_US, 3, T0], ['h', T0 + TTL_US, 3], ['r', T0 + 2 * TTL_US + 7, 3, T0 + TTL_US], ['h', T0 + 2 * TTL_US + 8, 3]);
  // 좌석 0·49999(끝 좌석): 한 홀드 두 좌석
  entries.push(['h', T0 + 1, 0], ['h', T0 + 1, 49_999], ['r', T0 + TTL_US + 100, 0, T0 + 1], ['r', T0 + TTL_US + 100, 49_999, T0 + 1]);
  // 1µs 차이로 붙은 토큰(같은 µs에 두 홀드가 오면 fence + 1)
  entries.push(['h', T0 + 2, 10], ['h', T0 + 3, 11]);
  const run = (list) => {
    const log = new SeatLog();
    for (const [k, t, s, tok] of list) k === 'h' ? log.hold(t, s) : log.release(t, s, tok);
    return checkOversell(log, 50_000);
  };
  const want = { oversell: 0, unknown_release: 0, held_at_end: 3, holds: 7, releases: 4 };
  assert.deepEqual(run(entries), want);
  assert.deepEqual(run([...entries].reverse()), want);
  assert.deepEqual(run([entries[4], entries[1], entries[3], entries[0], entries[2], ...entries.slice(5)]), want);
});

test('ST27_NFR003_잡혀 있는 좌석을 또 잡으면 오버셀, 빈 좌석을 놓거나 다른 토큰을 놓으면 짝 없는 놓기로 센다', () => {
  const log = new SeatLog();
  log.hold(T0, 1);
  log.hold(T0 + 10, 1); // 오버셀
  log.release(T0 + TTL_US, 2, T0); // 빈 좌석을 놓음
  log.hold(T0 + 20, 3);
  log.release(T0 + TTL_US + 30, 3, T0 + 21); // 다른 토큰(1 차이)을 놓음
  const r = checkOversell(log, 4);
  assert.equal(r.oversell, 1);
  assert.equal(r.unknown_release, 2);
  assert.equal(r.held_at_end, 1);
});

test('ST27_NFR003_2^52 바로 아래 토큰까지 정확하고, 2^52 이상·정수가 아닌 값·좌석 수 밖 색인은 RangeError다', () => {
  const big = MAX_TIME_US - 2;
  const log = new SeatLog();
  log.hold(big - 1, 0);
  log.release(big, 0, big - 1);
  log.hold(big, 0);
  assert.deepEqual(checkOversell(log, 1), { oversell: 0, unknown_release: 0, held_at_end: 1, holds: 2, releases: 1 });
  assert.throws(() => new SeatLog().hold(MAX_TIME_US, 0), RangeError);
  assert.throws(() => new SeatLog().hold(T0 + 0.5, 0), RangeError);
  assert.throws(() => new SeatLog().release(T0, 0, 2 ** 53 + 2), RangeError);
  const out = new SeatLog();
  out.hold(T0, 5);
  assert.throws(() => checkOversell(out, 5), RangeError);
});

test('ST27_NFR003_기록이 많아도(좌석 5만·잡기 20만) 배열이 늘어나며 정확히 센다', () => {
  const log = new SeatLog();
  const seats = 50_000;
  let t = T0;
  for (let round = 0; round < 4; round += 1) {
    for (let s = 0; s < seats; s += 1) log.hold(t + s, s);
    for (let s = 0; s < seats; s += 1) log.release(t + TTL_US + s, s, t + s);
    t += 2 * TTL_US;
  }
  assert.deepEqual(checkOversell(log, seats), { oversell: 0, unknown_release: 0, held_at_end: 0, holds: 4 * seats, releases: 4 * seats });
});

/** 좌석 색인들의 비트를 켠 Redis 비트맵 바이트(SETBIT 차례: 바이트마다 높은 비트가 앞) */
const bitmapOf = (seats, on) => {
  const b = new Uint8Array(Math.ceil(seats / 8));
  for (const i of on) b[i >> 3] |= 0x80 >> (i & 7);
  return b;
};

test('ST27_NFR003_bitAt은 SETBIT 차례(바이트마다 높은 비트가 앞)로 읽고, 짧은 비트맵의 뒤는 0이다', () => {
  const b = Uint8Array.of(0b1000_0001, 0b0100_0000);
  assert.deepEqual([0, 1, 6, 7, 8, 9, 15, 16, 999].map((i) => bitAt(b, i)), [1, 0, 0, 1, 0, 1, 0, 0, 0]);
});

test('ST27_NFR003_checkOversell의 heldOut은 좌석마다 끝에 잡은 홀드의 토큰(비었으면 −1)이다', () => {
  const log = new SeatLog();
  log.hold(T0, 1);
  log.hold(T0 + 1, 2);
  log.release(T0 + TTL_US, 2, T0 + 1);
  const held = new Float64Array(4).fill(7);
  checkOversell(log, 4, held);
  assert.deepEqual([...held], [-1, T0, -1, -1]);
});

test('ST27_NFR003_compareSeats: 총수가 같아도 좌석이 어긋나면 잡는다(놓기 기록 없이 꺼진 비트·기록에 없는 켜진 비트·만료 인덱스 차이)', () => {
  // 기록: 좌석 1·2·3이 잡혀 있다
  const log = new SeatLog();
  for (const s of [1, 2, 3]) log.hold(T0 + s, s);
  const held = new Float64Array(16);
  checkOversell(log, 16, held);
  // 같으면 모두 0
  assert.deepEqual(compareSeats(held, bitmapOf(16, [1, 2, 3]), [1, 2, 3]), { bit_without_log: 0, log_without_bit: 0, index_without_log: 0, log_without_index: 0, sample: [] });
  // 켜진 비트 수(3)와 만료 인덱스 수(3)는 같지만 좌석 2의 비트가 놓기 기록 없이 꺼지고 좌석 9가 기록 없이 켜졌다
  assert.deepEqual(compareSeats(held, bitmapOf(16, [1, 3, 9]), [1, 3, 9]), { bit_without_log: 1, log_without_bit: 1, index_without_log: 1, log_without_index: 1, sample: [2, 9] });
  // 좌석 수 밖의 켜진 비트·만료 인덱스 멤버도 센다(비트맵은 좌석 수를 8로 올린 바이트)
  const held13 = new Float64Array(13);
  checkOversell(log, 13, held13);
  assert.deepEqual(compareSeats(held13, bitmapOf(16, [1, 2, 3, 15]), [1, 2, 3, 20]), { bit_without_log: 1, log_without_bit: 0, index_without_log: 1, log_without_index: 0, sample: [15] });
  // 비트맵 키가 없으면(빈 바이트) 기록의 잡힌 좌석이 모두 '놓기 기록 없이 꺼진 비트'다
  assert.equal(compareSeats(held, new Uint8Array(0), [1, 2, 3]).log_without_bit, 3);
});

test('ST27_NFR003_mixedP99Percentiles: 홀드·만료가 섞인 EVALSHA 분포에서 읽은 백분위가 홀드만의 p99를 끼고, 만료가 모두 느리면 아래 끝이 정확하다', () => {
  // 순위 백분위(가장 작은 x로 몫 ≥ p): 정렬한 값의 ceil(p·n) − 1번째
  const quantile = (sorted, pct) => sorted[Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const holds = Array.from({ length: 40_000 }, () => 10 + Math.floor(rnd() * 290));
  const v = quantile([...holds].sort((a, b) => a - b), 99);
  const small = Array.from({ length: 30 }, () => 10 + Math.floor(rnd() * 40)); // 좌석이 적은 만료(빠를 수 있다)
  const large = Array.from({ length: 370 }, () => 1000 + Math.floor(rnd() * 2000)); // 100석 만료(느리다)
  const mixed = [...holds, ...small, ...large].sort((a, b) => a - b);
  const p = mixedP99Percentiles(mixed.length, 400, 30);
  assert.ok(p.lo < p.est && p.est < p.hi, JSON.stringify(p));
  assert.ok(quantile(mixed, p.lo) <= v && v <= quantile(mixed, p.est) && quantile(mixed, p.est) <= quantile(mixed, p.hi));
  // 섞인 분포의 그냥 p99는 만료에 끌려 크게 나온다(고친 까닭)
  assert.ok(quantile(mixed, 99) > v);
  // 만료가 모두 느리면 아래 끝이 정확하다
  const slowOnly = [...holds, ...large].sort((a, b) => a - b);
  assert.equal(quantile(slowOnly, mixedP99Percentiles(slowOnly.length, 370, 0).lo), v);
  // 만료가 없으면 셋 다 p99
  assert.deepEqual(mixedP99Percentiles(40_000, 0, 0), { lo: 99, est: 99, hi: 99 });
  assert.throws(() => mixedP99Percentiles(0, 0, 0), RangeError);
  assert.throws(() => mixedP99Percentiles(10, 3, 4), RangeError);
});

// ───────────────────────── 5. 만료 반복의 규칙(운영 ExpirySweeper와 같다) ─────────────────────────
// 운영: services/purchase-svc/src/modules/inventory/application/expiry-sweeper.ts tick()·start()·#loop·#sweepEvent

test('ST27_NFR003_batchOutcome: 운영 #sweepEvent의 묶음 되풀이와 같은 차례로 가른다(읽은 수 0 → 푼 것·고아 0 → 읽은 수 부족 → 20묶음 → 이어서)', () => {
  const o = (i) => batchOutcome({ batches: 1, ...i });
  assert.equal(o({ dueCount: 0 }), 'DRAINED');
  assert.equal(o({ dueCount: 100, released: 100 }), 'CONTINUE');
  assert.equal(o({ dueCount: 100, released: 60, orphans: 40 }), 'CONTINUE');
  assert.equal(o({ dueCount: 100, released: 0, orphans: 3 }), 'CONTINUE'); // 고아도 진전이다
  assert.equal(o({ dueCount: 100, released: 0, orphans: 0 }), 'NO_PROGRESS');
  assert.equal(o({ dueCount: 37, released: 0, orphans: 0 }), 'NO_PROGRESS'); // 읽은 수가 적어도 진전 없음을 먼저 본다
  assert.equal(o({ dueCount: 37, released: 30 }), 'DRAINED');
  // 상한: 만료 Lua를 20번 불렀고 그 묶음이 꽉 차고 진전이 있을 때만 BATCH_LIMIT이다
  const last = (i) => batchOutcome({ batches: EXPIRY_MAX_BATCHES_PER_TICK, ...i });
  assert.equal(batchOutcome({ batches: EXPIRY_MAX_BATCHES_PER_TICK - 1, dueCount: 100, released: 100 }), 'CONTINUE');
  assert.equal(last({ dueCount: 100, released: 100 }), 'BATCH_LIMIT');
  assert.equal(last({ dueCount: 99, released: 99 }), 'DRAINED'); // 20번째가 덜 찼으면 상한이 아니다
  assert.equal(last({ dueCount: 100, released: 0, orphans: 0 }), 'NO_PROGRESS');
  // 묶음 크기를 바꾸면(--expire-batch) 그 크기로 가른다
  assert.equal(batchOutcome({ dueCount: 50, released: 50, batches: 2, batchSize: 50 }), 'CONTINUE');
  assert.equal(batchOutcome({ dueCount: 50, released: 50, batches: 20, batchSize: 50 }), 'BATCH_LIMIT');
  assert.throws(() => batchOutcome({ dueCount: -1, batches: 0 }), RangeError);
  assert.throws(() => batchOutcome({ dueCount: 1.5, batches: 0 }), RangeError);
});

test('ST27_NFR003_nextTickDelayMs: 상한에 닿은 틱 뒤에는 대기 0, 다 풀렸거나 진전이 없으면 다음 1초 격자까지(격자 위에서 끝나면 1초)', () => {
  // 상한이 찼을 때 대기 0: 다른 회차가 무엇이든, 격자 위에서 끝났어도
  assert.equal(nextTickDelayMs(['BATCH_LIMIT'], 0), 0);
  assert.equal(nextTickDelayMs(['DRAINED', 'BATCH_LIMIT', 'NO_PROGRESS'], 123.4), 0);
  assert.equal(nextTickDelayMs(['BATCH_LIMIT'], 3000), 0);
  assert.equal(nextTickDelayMs(new Set(['BATCH_LIMIT']), 10), 0); // 반복 가능한 값이면 된다
  // 다 풀렸을 때 1초
  assert.equal(nextTickDelayMs(['DRAINED'], 0), EXPIRY_TICK_MS);
  assert.equal(nextTickDelayMs(['DRAINED', 'DRAINED'], 0), 1000);
  // 진전이 없을 때 1초
  assert.equal(nextTickDelayMs(['NO_PROGRESS'], 0), 1000);
  assert.equal(nextTickDelayMs(['NO_PROGRESS'], 5000), 1000);
  // 격자 사이에서 끝났으면 남은 만큼(틱 시작이 1초 간격으로 유지된다)
  assert.equal(nextTickDelayMs(['DRAINED'], 250), 750);
  assert.equal(nextTickDelayMs(['DRAINED'], 999.5), 0.5);
  // 틱이 이어져 격자를 지났으면 지난 격자는 버리고(운영 overlapped) 다음 격자까지
  assert.equal(nextTickDelayMs(['DRAINED'], 2500), 500);
  assert.equal(nextTickDelayMs(['NO_PROGRESS'], 3999), 1);
  // 상한이 아닌 다른 결과는 모두 기다린다(오류 뒤 5초 쉼은 회차 쪽 일이다, isResting)
  for (const o of ['NOT_READY', 'UNAVAILABLE', 'ERROR', 'BACKOFF', 'NOT_LEASED', 'NO_CONFIG', 'STOPPED']) assert.equal(nextTickDelayMs([o], 0), 1000, o);
  assert.equal(nextTickDelayMs([], 400), 600); // 회차가 없어도 격자는 간다
  assert.equal(nextTickDelayMs(['DRAINED'], 30, 100), 70); // 격자 간격을 주면 그 간격
  assert.throws(() => nextTickDelayMs(['DRAINED'], -1), RangeError);
  assert.throws(() => nextTickDelayMs(['DRAINED'], Number.NaN), RangeError);
  assert.throws(() => nextTickDelayMs(['DRAINED'], 0, 0), RangeError);
});

test('ST27_NFR003_sweepOrder: 회차 ID를 문자 코드 순으로 겹침 없이 낸다(운영 tick()의 ids)', () => {
  assert.deepEqual(sweepOrder(['st27e1x2', 'st27e0x0', 'ST', 'st27e1x2', 'a', 'B']), ['B', 'ST', 'a', 'st27e0x0', 'st27e1x2']);
  assert.deepEqual(sweepOrder([]), []);
});

test('ST27_NFR003_runLanes: 동시에 도는 회차는 운영 상수(EXPIRY_CONCURRENCY 4)개까지이고, 회차는 주어진 차례로 꺼낸다', async () => {
  const run = async (n, concurrency) => {
    const ids = Array.from({ length: n }, (_, i) => `e${i}`);
    let inflight = 0;
    let max = 0;
    const started = [];
    const results = await runLanes(ids, concurrency, async (id) => {
      inflight += 1;
      max = Math.max(max, inflight);
      started.push(id);
      await new Promise((r) => setImmediate(r));
      inflight -= 1;
      return id.toUpperCase();
    });
    return { max, started, results, ids };
  };
  const five = await run(5, EXPIRY_CONCURRENCY); // 다섯 회차(S-T27 ②)
  assert.equal(EXPIRY_CONCURRENCY, 4);
  assert.equal(five.max, 4);
  assert.deepEqual(five.started, five.ids);
  assert.deepEqual(five.results, ['E0', 'E1', 'E2', 'E3', 'E4']);
  assert.equal((await run(40, EXPIRY_CONCURRENCY)).max, 4);
  assert.equal((await run(3, EXPIRY_CONCURRENCY)).max, 3); // 회차가 상한보다 적으면 그 수
  assert.equal((await run(1, EXPIRY_CONCURRENCY)).max, 1); // 한 회차(S-T27 ①)
  assert.equal((await run(6, 1)).max, 1);
  assert.deepEqual(await runLanes([], EXPIRY_CONCURRENCY, async () => 1), []);
  await assert.rejects(() => runLanes(['a'], 0, async () => 1), RangeError);
  await assert.rejects(() => runLanes(['a'], 2.5, async () => 1), RangeError);
});

test('ST27_NFR003_isResting: 오류가 난 회차는 EXPIRY_BACKOFF_MS(5초) 동안 쉰다', () => {
  assert.equal(isResting(undefined, 1_000_000), false);
  assert.equal(isResting(1000, 1000), true);
  assert.equal(isResting(1000, 1000 + EXPIRY_BACKOFF_MS - 1), true);
  assert.equal(isResting(1000, 1000 + EXPIRY_BACKOFF_MS), false);
  assert.equal(isResting(1000, 1500, 100), false);
  assert.equal(isResting(0, 4999), true); // 시각 0도 오류 시각이다(없음과 다르다)
});

/** 가짜 시계로 runSweepLoop을 돌린다. script의 틱마다 걸린 시간(dur)과 회차별 결과(out)를 돌려주고, 다 돌면 멈춘다 */
async function driveLoop(script, { stopAfter = script.length } = {}) {
  let t = 0;
  let i = 0;
  const sleeps = [];
  const flags = [];
  const stats = await runSweepLoop({
    tick: async (immediate) => {
      flags.push(immediate);
      const s = script[i++];
      t += s.dur;
      return s.out;
    },
    elapsedMs: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    running: () => i < stopAfter,
  });
  return { stats, sleeps, flags, end: t };
}

test('ST27_NFR003_runSweepLoop: 상한에 닿은 틱 뒤에는 기다림 없이 다음 틱을 열고, 아니면 다음 1초 격자까지 기다린다', async () => {
  const r = await driveLoop([
    { dur: 300, out: ['BATCH_LIMIT', 'DRAINED'] }, // 격자 0에서 시작, 상한 → 바로 다음 틱
    { dur: 300, out: ['BATCH_LIMIT'] }, // 이어 돈 틱, 또 상한
    { dur: 100, out: ['DRAINED', 'DRAINED'] }, // 이어 돈 틱, 다 풀렸다 → 700ms에서 격자 1000까지 300ms
    { dur: 50, out: ['NO_PROGRESS'] }, // 격자 1000에서 시작, 진전 없음 → 1050에서 격자 2000까지 950ms
    { dur: 700, out: ['BATCH_LIMIT'] }, // 격자 2000에서 시작, 상한 → 바로 다음 틱
    { dur: 40, out: ['DRAINED'] }, // 이어 돈 틱(마지막)
  ]);
  assert.deepEqual(r.flags, [false, true, true, false, false, true]);
  assert.deepEqual(r.sleeps, [300, 950]);
  assert.deepEqual(r.stats, { ticks: 6, capTicks: 3, immediateTicks: 3 });
});

test('ST27_NFR003_runSweepLoop: 상한에 계속 닿으면 한 번도 기다리지 않고, 한 번도 안 닿으면 틱마다 1초 간격이다', async () => {
  const capped = await driveLoop(Array.from({ length: 5 }, () => ({ dur: 40, out: ['BATCH_LIMIT'] })));
  assert.deepEqual(capped.sleeps, []);
  assert.deepEqual(capped.stats, { ticks: 5, capTicks: 5, immediateTicks: 4 });
  assert.equal(capped.end, 200);
  const calm = await driveLoop(Array.from({ length: 3 }, () => ({ dur: 10, out: ['DRAINED'] })));
  assert.deepEqual(calm.sleeps, [990, 990]);
  assert.deepEqual(calm.stats, { ticks: 3, capTicks: 0, immediateTicks: 0 });
  assert.equal(calm.end, 2010); // 틱 시작이 0·1000·2000으로 1초 간격이다
});

test('ST27_NFR003_runSweepLoop: 멈춤 표시가 서면 돌던 틱만 마치고 다음 틱을 열지 않는다(상한에 닿았어도)', async () => {
  const stopped = await driveLoop([{ dur: 40, out: ['BATCH_LIMIT'] }, { dur: 40, out: ['BATCH_LIMIT'] }], { stopAfter: 1 });
  assert.deepEqual(stopped.stats, { ticks: 1, capTicks: 1, immediateTicks: 0 });
  assert.deepEqual(stopped.sleeps, []);
  const never = await driveLoop([{ dur: 40, out: ['DRAINED'] }], { stopAfter: 0 });
  assert.deepEqual(never.stats, { ticks: 0, capTicks: 0, immediateTicks: 0 });
});

test('ST27_NFR003_seat-shard.mjs의 만료 반복은 규칙 모듈과 운영 상수로 돈다(고치기 전의 1초 고정·한 줄 반복으로 돌아가지 않게)', () => {
  const src = readFileSync(SEAT_SHARD, 'utf8');
  for (const need of ['runSweepLoop(', 'runLanes(sweepIds, EXPIRY_CONCURRENCY', 'sweepOrder(', 'batchOutcome(', 'isResting(', 'tickMs: EXPIRY_TICK_MS']) assert.ok(src.includes(need), `${need}가 없다`);
  assert.ok(!/repeatEvery\(\s*1000/.test(src), '만료 반복이 1초 고정 반복으로 돌아갔다');
  // 결과에 남기는 칸(회차별은 events[].expire, 요약은 sweep)
  for (const field of ['immediate_ticks', 'cap_ticks', 'max_concurrent', 'event_ticks', 'expire_calls', 'released']) assert.ok(src.includes(`${field}`), `${field} 칸이 없다`);
});

// ───────────────────────── 6. 정식 측정 계획과 상태 파일 ─────────────────────────

const plan = loadPlan();

test('ST27_NFR003_계획은 7번이다: ② 한 샤드 TLS 켬 3·② 나눈 배치 1·① 1·TLS 끈 짝 2, 번마다 예열 60초 + 600초, 측정 컨테이너 CPU 2', () => {
  const count = (f) => plan.runs.filter(f).length;
  assert.equal(plan.runs.length, 7);
  assert.equal(count((r) => r.mode === 'five' && r.layout === 'same' && r.tls), 3);
  assert.equal(count((r) => r.mode === 'five' && r.layout === 'spread' && r.tls), 1);
  assert.equal(count((r) => r.mode === 'one' && r.tls), 1);
  assert.equal(count((r) => !r.tls), 2);
  assert.deepEqual(plan.runs.filter((r) => !r.tls).map((r) => `${r.mode}-${r.layout}`).sort(), ['five-same', 'one-same']);
  assert.equal(plan.common.warmup_s, 60);
  assert.equal(plan.common.duration_s, 600);
  assert.equal(plan.common.expire, 'on');
  assert.equal(plan.common.expire_batch, EXPIRY_BATCH_SIZE);
  assert.equal(plan.common.replay_ratio, 0.1);
  assert.equal(plan.common.relay_trim_ms, 1000);
  assert.equal(plan.environment.bench_container_cpus, '2');
  for (const k of ['result', 'log', 'ledger_input', 'ledger', 'doc']) assert.ok(plan.outputs[k], `outputs.${k}`);
  assert.equal(plan.state_file, '.cache/peaket-poc/out/st27-state.json');
  // TLS 켬을 먼저 몰아 클러스터를 두 번만 만든다
  const firstOff = plan.runs.findIndex((r) => !r.tls);
  assert.ok(plan.runs.slice(firstOff).every((r) => !r.tls));
});

test('ST27_NFR003_측정 인자는 seat-shard.mjs가 읽는 이름뿐이고 계획 값을 그대로 싣는다', () => {
  const src = readFileSync(SEAT_SHARD, 'utf8');
  for (const run of plan.runs) {
    const args = benchArgs(plan, run, 'valkey-1:6379,valkey-2:6379,valkey-3:6379');
    assert.equal(args[0], 'src/seat-shard.mjs');
    const a = parseArgs(args.slice(1));
    assert.deepEqual(a, { nodes: 'valkey-1:6379,valkey-2:6379,valkey-3:6379', tls: String(run.tls), mode: run.mode, layout: run.layout, duration: '600', warmup: '60', expire: 'on', 'expire-batch': '100', 'expire-call': 'evalsha', 'replay-ratio': '0.1', 'relay-trim-ms': '1000' });
    for (const k of Object.keys(a)) assert.ok(src.includes(`a.${k} `) || src.includes(`a.${k}.`) || src.includes(`a['${k}']`) || src.includes(`a.${k})`), `seat-shard.mjs가 --${k}를 읽지 않는다`);
  }
});

test('ST27_NFR003_장부 칸: 측정 ID는 시작한 날을 쓰고(-st27-), TLS 짝은 같은 날의 짝 ID다', () => {
  const day = '2026-11-05';
  const r1 = plan.runs.find((r) => r.key === 'five-same-tls-r1');
  assert.equal(runIdOf(day, r1.key), '2026-11-05-st27-prod-five-same-tls-r1');
  assert.match(runIdOf(day, r1.key), /-st27-/);
  const l = ledgerOf(plan, r1, day);
  assert.equal(l.kpi, 'NFR-003');
  assert.equal(l.rps, 6000);
  assert.equal(l.redisTls, true);
  assert.equal(l.pairOf, '2026-11-05-st27-prod-five-same-notls-r1');
  assert.equal(l.scenario, 'loadtest/poc/bench/src/seat-shard.mjs');
  assert.equal(ledgerOf(plan, plan.runs.find((r) => r.layout === 'spread'), day).pairOf, undefined);
  // 묶음 글자가 있으면 ID와 짝 ID에 함께 붙는다
  assert.equal(runIdOf(day, r1.key, 'b'), '2026-11-05-st27-prod-b-five-same-tls-r1');
  assert.equal(ledgerOf(plan, r1, day, 'b').pairOf, '2026-11-05-st27-prod-b-five-same-notls-r1');
  assert.match(ledgerOf(plan, r1, day).scenarioArgs, /--expire-call evalsha/);
});

test('ST27_NFR003_같은 날 처음부터 다시 돌면 앞 묶음(고치기 전 운영 Lua의 r1 등)의 ID를 덮지 않게 다음 묶음 글자를 고른다', () => {
  const day = '2026-11-04';
  assert.equal(pickSeries(plan, day, []), '');
  // 2026-11-04 고치기 전 운영 Lua로 1번만 돈 묶음('')이 있으면 b
  assert.equal(pickSeries(plan, day, ['2026-11-04-st27-prod-five-same-tls-r1', 'plan', 'st27-state']), 'b');
  // 겹치는 ID가 하나라도 있으면 그 묶음을 쓰지 않는다
  assert.equal(pickSeries(plan, day, ['2026-11-04-st27-prod-one-same-notls-r1', '2026-11-04-st27-prod-b-five-spread-tls-r1']), 'c');
  // 다른 날의 ID는 상관없다
  assert.equal(pickSeries(plan, day, ['2026-11-03-st27-prod-five-same-tls-r1']), '');
  const s = newState(plan, day, {}, 'b');
  assert.equal(s.series, 'b');
  assert.deepEqual(plan.runs.map((r) => runIdOf(s.day, r.key, s.series)).filter((id) => id === '2026-11-04-st27-prod-five-same-tls-r1'), []);
});

test('ST27_NFR003_record.mjs: --note는 --only 없이 쓰면 아무것도 옮기지 않고 멈추고, --only 뒤에 값이 없어도 멈춘다', () => {
  const RECORD = fileURLToPath(new URL('../poc/record.mjs', import.meta.url));
  const note = spawnSync(process.execPath, [RECORD, '--note', '고치기 전 운영 Lua'], { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(note.status, 0);
  assert.match(note.stderr, /--note는 --only와 함께만/);
  const only = spawnSync(process.execPath, [RECORD, '--only'], { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(only.status, 0);
  assert.match(only.stderr, /--only 뒤에 값이 없다/);
});

test('ST27_NFR003_상태 파일로 이어 돈다: 끝난 번은 건너뛰고 실패·도중에 멈춘 번은 다시 돈다. Lua 원문이 바뀌었으면 Error다', () => {
  const lua = { 'seat-hold.lua': 'aa', 'seat-open-sale.lua': 'bb', 'seat-expire.lua': 'cc' };
  const s = newState(plan, '2026-11-05', lua);
  assert.deepEqual(pendingRuns(plan, s).map((r) => r.n), [1, 2, 3, 4, 5, 6, 7]);
  s.runs['five-same-tls-r1'] = { status: 'done' };
  s.runs['five-same-tls-r2'] = { status: 'failed' };
  s.runs['five-same-tls-r3'] = { status: 'running' };
  assert.deepEqual(pendingRuns(plan, s).map((r) => r.n), [2, 3, 4, 5, 6, 7]);
  checkState(s, plan, lua);
  assert.throws(() => checkState(s, plan, { ...lua, 'seat-expire.lua': 'dd' }), /seat-expire\.lua/);
  assert.throws(() => checkState({ ...s, plan: 'other' }, plan, lua), /계획/);
  const dir = mkdtempSync(join(tmpdir(), 'peaket-st27-state-'));
  try {
    const p = join(dir, 'st27-state.json');
    assert.equal(readState(p), null);
    writeState(p, s);
    assert.deepEqual(readState(p), s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ST27_NFR003_계획 모양이 틀리면 validatePlan이 Error다', () => {
  const bad = (f) => {
    const p = structuredClone(plan);
    f(p);
    return () => validatePlan(p);
  };
  assert.throws(bad((p) => (p.runs[1].key = p.runs[0].key)), /겹친다/);
  assert.throws(bad((p) => (p.runs[2].n = 9)), /n이/);
  assert.throws(bad((p) => (p.runs[0].mode = 'six')), /mode/);
  assert.throws(bad((p) => (p.runs[0].pair = 'nope')), /짝/);
  assert.throws(bad((p) => delete p.common.duration_s), /duration_s/);
  assert.throws(bad((p) => (p.common.expire_call = 'fcall')), /expire_call/);
  assert.equal(PLAN_PATH.endsWith(join('loadtest', 'poc', 'st27-plan.json')), true);
});
