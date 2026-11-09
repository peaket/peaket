#!/usr/bin/env node
// 좌석 홀드 경로 Lua의 서버 쪽 실행 시간을 옛 코드와 새 코드로 견준다(방법과 결과: docs/review/pilot-purchase-path-perf.md).
// 통합 시험과 같은 Valkey 이미지를 하나 띄우고, SLOWLOG가 명령마다 적은 마이크로초로 p50·p99를 구한다. 네트워크와 대기 시간은 이 값에 들어가지 않는다.
// Lua 원문은 seat-lua.mjs처럼 TS 모듈을 그대로 가져온다(git show로 그 커밋의 글을 임시 폴더에 내려 읽는다). 원문을 고치지 않고, 느려진 판만 첫 줄 뒤에 빈 반복을 끼운다.
//
// 쓰는 법(저장소 뿌리에서, 측정 중에는 시험·빌드를 돌리지 않는다):
//   node loadtest/micro/lua-compare.mjs [--base 1a85da7a] [--head HEAD] [--blocks 40] [--calls 100] [--big-calls 100]
//                                       [--only 이름,이름] [--slow 이름,이름] [--slow-tiers 10,30,100] [--seed 1] [--reverse] [--slowlog-us 5] [--out 결과.json] [--md 표.md] [--raw] [--keep]
// --raw는 호출 하나하나의 µs를 차례대로 JSON에 남긴다(Lua 가비지 수거가 도는 자리처럼 호출 위치별로 볼 때).
// 끝나면 쓴 컨테이너를 docker rm -f -v로 지운다(--keep이면 남긴다).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY = 'services/purchase-svc/src/modules/inventory';
/** 통합 시험의 valkey/valkey:8.1-alpine을 deploy/local/valkey.yaml과 같은 다이제스트로 고정한다 */
const IMAGE = 'valkey/valkey:8.1-alpine@sha256:2602ace2be6569bc2bbb06f873776516ab9089821525be34f4305c67eb9db02a';
const { createClient } = createRequire(join(ROOT, 'packages', 'platform', 'package.json'))('redis');

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const BASE = opt('base', '1a85da7a');
const HEAD = opt('head', 'HEAD');
const BLOCKS = Number(opt('blocks', '40'));
const CALLS = Number(opt('calls', '100'));
const BIG_CALLS = Number(opt('big-calls', '100'));
const ONLY = opt('only', '') ? new Set(opt('only', '').split(',')) : null;
const SLOW = new Set(opt('slow', 'sale-count,pin-4,release-failed-4,expire-100').split(',').filter(Boolean));
const SLOW_TIERS = opt('slow-tiers', '10,30,100').split(',').map(Number); // 일부러 느리게 만드는 정도(%)
const SEED = Number(opt('seed', '1'));
const OUT = opt('out', join(ROOT, '.cache', 'peaket-loadtest', `lua-compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const MD = opt('md', '');
// 값이 0이면 Valkey 8.1은 Lua 안의 redis.call까지 하나하나 기록해 기록 비용이 Lua 시간에 더해지고 기록이 넘친다. 맨 바깥 EVALSHA(재는 것 중 가장 짧아도 15µs대)만 남도록 5µs로 둔다
const SLOWLOG_US = Number(opt('slowlog-us', '5'));
if (!Number.isInteger(BLOCKS) || BLOCKS < 3) throw new Error('--blocks는 3 이상의 정수다(결과를 낼 때는 30 이상)');
// Lua 가비지 수거는 스크립트 50번마다 한 걸음 돈다: 다리 길이를 50의 배수로 해서 두 쪽이 같은 수의 걸음을 맞게 한다
for (const n of [CALLS, BIG_CALLS]) if (!Number.isInteger(n) || n < 50 || n % 50 !== 0) throw new Error('호출 수는 50의 배수다');

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DITHER = rng(SEED);

// ── Lua 원문 ─────────────────────────────────────────────────────────────────────────────────────────────────────
const MODULES = ['hold-lua.ts', 'expire-lua.ts', 'pin-lua.ts', 'purchase-session-lua.ts', 'sale-count-lua.ts', 'order-hold-lua.ts', 'rebuild-lua.ts', 'hold-lifecycle-lua.ts'];
const tempDirs = [];

/** 그 커밋의 Lua 모듈을 임시 폴더에 내려 읽어 {모듈: 이름들}을 돌려준다. 옛 커밋에 없는 모듈(hold-lifecycle-lua.ts)은 건너뛴다 */
async function loadLua(rev) {
  const dir = mkdtempSync(join(tmpdir(), 'lua-compare-'));
  tempDirs.push(dir);
  const show = (p) => execFileSync('git', ['-C', ROOT, 'show', `${rev}:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  // pin-lua.ts는 domain/pin.ts의 상수 하나만 가져온다(그 모듈은 다른 도메인을 줄줄이 가져오므로 값만 옮겨 적는다)
  const ttl = /export const FAILED_HOLD_MARK_TTL_MS = (.+?);/.exec(show(`${INVENTORY}/domain/pin.ts`))[1];
  const present = [];
  for (const m of MODULES) {
    let text;
    try {
      text = show(`${INVENTORY}/adapters/${m}`);
    } catch {
      continue;
    }
    text = text.replace(/from '\.\/([\w-]+)\.js'/g, "from './$1.ts'").replace(/import \{ FAILED_HOLD_MARK_TTL_MS \} from '\.\.\/domain\/pin\.js';/, `const FAILED_HOLD_MARK_TTL_MS = ${ttl};`);
    writeFileSync(join(dir, m), text);
    present.push(m);
  }
  const out = {};
  for (const m of present) out[m] = await import(pathToFileURL(join(dir, m)).href);
  return out;
}

// ── 키와 기본 상태(5만 석 회차, docs/data.md §3의 키 이름) ──────────────────────────────────────────────────────────────
const E = 'perf-event-1';
const P = `s:{event:${E}}`;
const K = {
  bitmap: `${P}:bitmap`, expiry: `${P}:expiry`, stream: `${P}:stream`, epoch: `${P}:epoch`, secver: `${P}:secver`, fence: `${P}:fence`,
  ordered: `${P}:ordered`, paused: `${P}:paused`, rebuild: `${P}:rebuild`, section: `${P}:sec:`,
  hold: (i) => `${P}:hold:${i}`, quota: (a) => `${P}:quota:${a}`, rel: (a) => `${P}:rel:${a}`, failed: (h) => `${P}:failed:${h}`,
  session: (j) => `s:session:{${j}}`,
};
const HOLD = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const PSID = '33333333-3333-4333-8333-333333333333';
const FENCE = '1700000000000001';
const BITMAP = Buffer.alloc(6250, 0xaa); // 5만 석, 절반이 잡힌 비트맵
const seats = (n, perSection = 20) => Array.from({ length: n }, (_, i) => ({
  index: 1000 + i, sectionIndex: Math.floor(i / perSection), seatOffset: i % perSection, seatId: `seat-${1000 + i}`,
  tierId: '44444444-4444-4444-8444-444444444444', sectionId: `sec-${String(Math.floor(i / perSection)).padStart(4, '0')}`,
}));
const seatArgs = (S) => S.flatMap((s) => [String(s.index), String(s.sectionIndex), String(s.seatOffset), s.seatId, s.tierId, s.sectionId]);
const holdKeys = (S) => S.map((s) => K.hold(s.index));
const members = (S) => S.map((s) => String(s.index));
const pairs = (S, score) => S.flatMap((s) => [String(score), String(s.index)]);
const setBits = (S) => ['BITFIELD', K.bitmap, ...S.flatMap((s) => ['SET', 'u1', String(s.index), '1'])];
/** 홀드 Lua가 쓰는 칸 그대로(hold-lua.ts). exp·extra만 시나리오마다 다르다 */
const hset = (s, exp, owner = OWNER, extra = []) => ['HSET', K.hold(s.index), 'holdId', HOLD, 'owner', owner, 'psid', PSID, 'fence', FENCE, 'heldAt', String(exp - 420000), 'exp', String(exp), 'kind', 'FAN', 'ext', '0', ...extra];
/** 다른 사람의 홀드가 있는 보통 상태: 만료 인덱스 5,000개, 주문 뒤 집합 2,000개, Stream 1,000건, 구역 20개 */
function baseState(ctx) {
  const zs = (from, count, score) => Array.from({ length: count }, (_, i) => [String(score), String(from + i)]).flat();
  const cmds = [
    ['FLUSHALL'],
    ['SET', K.bitmap, BITMAP],
    ['HSET', K.epoch, 'epoch', '1700000000', 'node', 'standalone', 'gen', '1', 'chk', '0'],
    ['HSET', K.secver, ...Array.from({ length: 20 }, (_, i) => [String(i), '7']).flat()],
    ['SET', K.fence, FENCE],
    ['ZADD', K.expiry, ...zs(20000, 5000, ctx.keep)],
    ['ZADD', K.ordered, ...zs(30000, 2000, ctx.now())],
  ];
  for (let i = 0; i < 1000; i++) cmds.push(['XADD', K.stream, '*', 'type', 'HELD', 'seatIdx', String(i)]);
  return cmds;
}

// ── 시나리오: 부를 때마다 상태를 만들고(each), 대상 스크립트만 잰다 ───────────────────────────────────────────────────
const scenarios = [];
const add = (s) => scenarios.push({ big: false, ...s });

function expireScenario(name, n, m) {
  const S = seats(n);
  const owners = Array.from({ length: m }, (_, j) => `aaaaaaaa-0000-4000-8000-${String(j).padStart(12, '0')}`);
  const each = n / m;
  add({
    name, title: `만료 Lua ${n}석(계정 ${m})`, seats: n, big: n >= 100, module: 'expire-lua.ts', script: 'EXPIRE_LUA', old: true,
    expect: (r) => r[0] === 'OK' && Number(r[2]) === n,
    each: (ctx) => {
      const exp = ctx.now() - 60000;
      return [
        ['DEL', ...holdKeys(S)],
        ...S.map((s, i) => hset(s, exp, owners[Math.floor(i / each)])),
        setBits(S),
        ['ZADD', K.expiry, ...pairs(S, exp)],
        ...owners.flatMap((a) => [['SET', K.quota(a), String(each)], ['DEL', K.rel(a)]]),
      ];
    },
    call: (ctx, side) => {
      const keys = [K.bitmap, K.expiry, K.stream, K.epoch, K.secver, ...holdKeys(S), ...owners.map(K.quota), ...owners.map(K.rel)];
      const fields = S.flatMap((s, i) => [String(s.index), HOLD, FENCE, String(Math.floor(i / each) + 1), String(s.sectionIndex), String(s.seatOffset), s.seatId, s.tierId, s.sectionId]);
      const head = ['30000', K.section, String(ctx.keep), String(m)];
      return side === 'old' ? { keys, args: [...head, ...owners, ...fields] } : { keys: [...keys, K.ordered], args: [...head, '', ...owners, ...fields] };
    },
  });
}
expireScenario('expire-4', 4, 1);
expireScenario('expire-100', 100, 25);

{
  const S = seats(4);
  const holdState = (ctx) => {
    const exp = ctx.now() + 300000;
    return [['DEL', ...holdKeys(S)], ...S.map((s) => hset(s, exp)), setBits(S), ['ZADD', K.expiry, ...pairs(S, exp)]];
  };
  add({
    name: 'pin-4', title: '묶기 Lua 4석(내 홀드)', seats: 4, module: 'pin-lua.ts', script: 'PIN_LUA', old: true,
    expect: (r) => r[0] === 'OK' && Number(r[2]) === 0,
    each: (ctx) => [...holdState(ctx), ['ZADD', K.ordered, ...pairs(S, ctx.now() - 30000)]],
    call: (ctx, side) => {
      const keys = [K.bitmap, K.expiry, K.quota(OWNER), K.stream, K.epoch, K.secver, K.fence, ...holdKeys(S), K.failed(HOLD)];
      return { keys: side === 'old' ? keys : [...keys, K.ordered, K.paused], args: [OWNER, PSID, HOLD, '4', '1', '420000', String(ctx.keep), K.section, ...seatArgs(S)] };
    },
  });
  add({
    name: 'release-failed-4', title: '실패 해제 Lua 4석', seats: 4, module: 'pin-lua.ts', script: 'RELEASE_FAILED_LUA', old: true,
    expect: (r) => r[0] === 'OK' && Number(r[1]) === 4,
    each: (ctx) => [...holdState(ctx), ['ZADD', K.ordered, ...pairs(S, ctx.now() - 30000)], ['SET', K.quota(OWNER), '4']],
    call: (ctx, side) => {
      const keys = [K.bitmap, K.expiry, K.quota(OWNER), K.stream, K.epoch, K.secver, ...holdKeys(S), K.failed(HOLD)];
      return { keys: side === 'old' ? keys : [...keys, K.ordered, K.paused], args: [OWNER, HOLD, String(ctx.keep), K.section, ...seatArgs(S)] };
    },
  });
  const orderHoldSetup = (ctx) => S.map((s) => hset(s, ctx.keep));
  add({
    name: 'order-hold-4', title: '주문 홀드 확인 Lua 4석', seats: 4, module: 'order-hold-lua.ts', script: 'ORDER_HOLD_LUA', old: true,
    expect: (r) => r[0] === 'OK',
    setup: orderHoldSetup,
    call: () => ({ keys: [K.epoch, ...holdKeys(S)], args: [HOLD, OWNER, PSID] }),
  });
  add({
    name: 'order-hold-expiry-4', title: '결제 시도 홀드 만료 Lua 4석', seats: 4, module: 'order-hold-lua.ts', script: 'ORDER_HOLD_EXPIRY_LUA', old: true,
    expect: (r) => /^\d+$/.test(String(r)),
    setup: orderHoldSetup,
    call: () => ({ keys: holdKeys(S), args: [HOLD] }),
  });
  // 여기부터 새 Lua(옛 값이 없어 절대값만)
  add({
    name: 'hold-read-4', title: '홀드 다시 읽기 Lua 4석', seats: 4, module: 'hold-lifecycle-lua.ts', script: 'HOLD_READ_LUA', old: false,
    expect: (r) => r[0] === 'OK',
    setup: orderHoldSetup,
    call: () => ({ keys: [K.epoch, ...holdKeys(S)], args: [HOLD, OWNER, PSID] }),
  });
  add({
    name: 'hold-release-4', title: '홀드 해제 Lua 4석', seats: 4, module: 'hold-lifecycle-lua.ts', script: 'HOLD_RELEASE_LUA', old: false,
    expect: (r) => r[0] === 'OK' && Number(r[1]) === 4,
    each: (ctx) => [...holdState(ctx), ['SET', K.quota(OWNER), '4'], ['DEL', K.rel(OWNER)]],
    call: (ctx) => ({
      keys: [K.bitmap, K.expiry, K.quota(OWNER), K.stream, K.epoch, K.secver, K.rel(OWNER), K.ordered, K.paused, ...holdKeys(S)],
      args: [OWNER, HOLD, PSID, '30000', String(ctx.keep), K.section, ...seatArgs(S)],
    }),
  });
  add({
    name: 'hold-extend-4', title: '홀드 연장 Lua 4석', seats: 4, module: 'hold-lifecycle-lua.ts', script: 'HOLD_EXTEND_LUA', old: false,
    expect: (r) => r[0] === 'OK',
    each: holdState,
    call: () => ({ keys: [K.expiry, K.epoch, ...holdKeys(S)], args: [OWNER, HOLD, PSID, '180000'] }),
  });
  add({
    name: 'hold-mark-4', title: '주문 표시 Lua 4석', seats: 4, module: 'hold-lifecycle-lua.ts', script: 'HOLD_MARK_ORDERED_LUA', old: false,
    expect: (r) => r[0] === 'OK' && Number(r[1]) === 4,
    each: (ctx) => [...holdState(ctx), ['ZREM', K.ordered, ...members(S)]],
    call: (ctx) => ({ keys: [K.ordered, K.epoch, ...holdKeys(S)], args: [OWNER, HOLD, PSID, String(ctx.keep), String(ctx.keep), ...members(S)] }),
  });
}

function freezeScenario(name, n) {
  const S = seats(n);
  add({
    name, title: `결제 정지 옮기기 Lua ${n}석`, seats: n, big: n >= 100, module: 'hold-lifecycle-lua.ts', script: 'HOLD_FREEZE_LUA', old: false,
    expect: (r) => r[0] === 'OK' && Number(r[1]) === n,
    each: (ctx) => {
      const now = ctx.now();
      const exp = now + 300000;
      return [
        ['DEL', ...holdKeys(S)],
        ...S.map((s) => hset(s, exp, OWNER, ['ordAt', String(now - 30000), 'maxStay', String(now + 900000)])),
        ['ZADD', K.expiry, ...pairs(S, exp)],
        ['ZADD', K.ordered, ...pairs(S, now - 30000)],
        ['ZREM', K.paused, ...members(S)],
      ];
    },
    call: (ctx) => ({ keys: [K.ordered, K.expiry, K.paused, K.epoch, ...holdKeys(S)], args: [String(ctx.now() - 10000), String(ctx.keep), ...members(S)] }),
  });
}
function thawScenario(name, n) {
  const S = seats(n);
  add({
    name, title: `결제 정지 되돌리기 Lua ${n}석`, seats: n, big: n >= 100, module: 'hold-lifecycle-lua.ts', script: 'HOLD_THAW_LUA', old: false,
    expect: (r) => r[0] === 'OK' && Number(r[1]) === n,
    each: (ctx) => {
      const now = ctx.now();
      const maxStay = now + 900000;
      return [
        ['DEL', ...holdKeys(S)],
        ...S.map((s) => hset(s, now - 1000, OWNER, ['ordAt', String(now - 30000), 'maxStay', String(maxStay), 'rem', '180000'])),
        ['ZADD', K.paused, ...pairs(S, maxStay)],
        ['ZREM', K.expiry, ...members(S)],
        ['ZREM', K.ordered, ...members(S)],
      ];
    },
    call: (ctx) => ({ keys: [K.paused, K.expiry, K.ordered, K.epoch, ...holdKeys(S)], args: [String(ctx.keep), ...members(S)] }),
  });
}
freezeScenario('hold-freeze-4', 4);
freezeScenario('hold-freeze-200', 200);
thawScenario('hold-thaw-4', 4);
thawScenario('hold-thaw-200', 200);

add({
  name: 'hold-page', title: '홀드 쪽 읽기 Lua 1,000건', seats: 1000, module: 'sale-count-lua.ts', script: 'HOLD_PAGE_LUA', old: false,
  expect: (r) => Array.isArray(r) && r.length === 1000,
  call: () => ({ keys: [K.expiry, K.paused], args: ['0', '1000'] }),
});
add({
  name: 'sale-count', title: '판매 상태 셈 Lua(비트맵 5만 석)', seats: 0, module: 'sale-count-lua.ts', script: 'SALE_COUNT_LUA', old: true,
  expect: (r) => r[0] === 'OK',
  call: (ctx, side) => ({ keys: side === 'old' ? [K.bitmap, K.expiry, K.epoch] : [K.bitmap, K.expiry, K.epoch, K.paused], args: [] }),
});
{
  const jti = '55555555-5555-4555-8555-555555555555';
  const sessionKey = K.session(jti);
  const fields = (idle, max, holds) => {
    const out = ['acct', OWNER, 'login', '66666666-6666-4666-8666-666666666666', 'event', E, 'jny', '77777777-7777-4777-8777-777777777777', 'cpk', 'B'.repeat(88), 'seq', '3', 'idle', String(idle), 'started', String(max - 1200000), 'max', String(max), 'fh', '1', 'sev', '1'];
    for (let h = 0; h < holds; h++) out.push(`h:88888888-0000-4000-8000-${String(h).padStart(12, '0')}`, 'seat-1000,seat-1001,seat-1002,seat-1003');
    return out;
  };
  const end = (name, holds) => add({
    name, title: `세션 끝내기 Lua(홀드 ${holds}개)`, seats: 0, module: 'purchase-session-lua.ts', script: 'END_SESSION_LUA', old: true,
    expect: (r) => r[0] === 'ENDED',
    each: (ctx) => [['DEL', sessionKey], ['HSET', sessionKey, ...fields(ctx.now() + 300000, ctx.keep, holds)]],
    call: () => ({ keys: [sessionKey], args: [] }),
  });
  end('end-session-1hold', 1);
  end('end-session-5holds', 5);
  const sweep = (name, title, idleOffset, want) => add({
    name, title, seats: 0, module: 'purchase-session-lua.ts', script: 'SWEEP_SESSION_LUA', old: true,
    expect: (r) => r[0] === want[0] && (want[1] === undefined || r[1] === want[1]),
    each: (ctx) => [['DEL', sessionKey], ['HSET', sessionKey, ...fields(ctx.now() + idleOffset, ctx.keep, 1)]],
    call: () => ({ keys: [sessionKey], args: ['300000'] }),
  });
  sweep('sweep-live', '세션 정리 점검 Lua(살아 있음)', 300000, ['LIVE']);
  sweep('sweep-idle', '세션 정리 점검 Lua(유휴 종료)', -1000, ['ENDED', 'IDLE']);
}
add({
  name: 'begin-rebuild', title: '다시 만들기 시작 Lua', seats: 0, module: 'rebuild-lua.ts', script: 'BEGIN_REBUILD_LUA', old: true,
  expect: (r) => r[0] === 'OK',
  each: (ctx) => {
    const z = (count, from) => Array.from({ length: count }, (_, i) => [String(ctx.keep), String(from + i)]).flat();
    return [['DEL', K.epoch, K.rebuild], ['SET', K.bitmap, BITMAP], ['ZADD', K.expiry, ...z(300, 40000)], ['ZADD', K.ordered, ...z(100, 41000)], ['ZADD', K.paused, ...z(20, 42000)]];
  },
  call: (ctx, side) => {
    const keys = [K.bitmap, K.expiry, K.epoch, K.rebuild];
    return { keys: side === 'old' ? keys : [...keys, K.ordered, K.paused], args: ['2', String(ctx.keep)] };
  },
});

// ── 재기: SLOWLOG가 적은 EVALSHA 시간만 쓴다 ──────────────────────────────────────────────────────────────────────
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const containerName = `peaket-lua-compare-${process.pid}`;
let client = null;
const MAX_MISSING = 2;
const tally = { measured: 0, missing: 0 };
const rawLegs = [];
let fillerSha = '';
const cmd = (c) => client.sendCommand(c);
const pipe = (cmds) => Promise.all(cmds.map(cmd));

/**
 * 다리 하나(호출 calls번): 상태를 만들고 대상 호출만 재서 마이크로초 배열을 돌려준다. 답이 예상과 다르면 잘못 재는 것이므로 멈춘다.
 * Lua 가비지 수거는 스크립트 50번마다 한 걸음 돈다. 호출 수가 늘 같으면 그 걸음이 다리의 같은 자리에 묶여 어느 쪽 스크립트가 값을 치르는지가 고정되고(첫 측정의 p99가 그랬다),
 * A/A는 양쪽이 같은 스크립트라 이것을 보지 못한다. 다리 앞에 임의 횟수(0~49번)의 빈 Lua를 불러 수거 위치를 다리마다 흐트러뜨린다
 */
async function runLeg(s, ctx, variant, calls, where = {}) {
  const fill = Math.floor(DITHER() * 50);
  for (let f = 0; f < fill; f++) await cmd(['EVALSHA', fillerSha, '0']);
  await cmd(['XTRIM', K.stream, 'MAXLEN', '1000']);
  await cmd(['SLOWLOG', 'RESET']);
  for (let i = 0; i < calls; i++) {
    if (s.each) await pipe(s.each(ctx, i));
    const { keys, args } = s.call(ctx, variant.side, i);
    const reply = await cmd(['EVALSHA', variant.sha, String(keys.length), ...keys, ...args]);
    if (!s.expect(reply)) throw new Error(`${s.name}/${variant.label}: 답이 예상과 다르다: ${JSON.stringify(reply).slice(0, 300)}`);
  }
  const log = await cmd(['SLOWLOG', 'GET', '-1']);
  const out = [];
  const inOrder = []; // 기록 번호(id) 순서 = 호출 순서(--raw로 호출 자리별로 볼 때만 쓴다)
  for (const e of log) {
    if (String(e[3][0]).toUpperCase() === 'EVALSHA' && e[3][1] === variant.sha) {
      out.push(Number(e[2]));
      inOrder.push([Number(e[0]), Number(e[2])]);
    }
  }
  if (flag('raw')) {
    inOrder.sort((x, y) => x[0] - y[0]);
    rawLegs.push({ name: s.name, variant: variant.label, ...where, us: inOrder.map((x) => x[1]) });
  }
  // 이 서버는 벽시계(POSIX clock_gettime 판)로 시간을 재서 시계가 잠깐 뒤로 가면 한 건이 기록되지 않는 일이 드물게 있다. 다리마다 MAX_MISSING건까지만 봐주고 수를 남긴다
  const missing = calls - out.length;
  if (missing < 0 || missing > MAX_MISSING) {
    const seen = {};
    for (const e of log) seen[String(e[3][0]).toUpperCase()] = (seen[String(e[3][0]).toUpperCase()] ?? 0) + 1;
    throw new Error(`${s.name}/${variant.label}: SLOWLOG에 대상 호출 ${out.length}건, 호출은 ${calls}번이다(기록이 넘쳤거나 하한 ${SLOWLOG_US}µs보다 짧은 호출이 있다). 전체 ${log.length}건 ${JSON.stringify(seen)}`);
  }
  tally.measured += out.length;
  tally.missing += missing;
  return out;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 묶음 하나(ABBA): 쪽마다 두 다리를 합쳐 p50·p99를 구한다 */
async function runBlock(s, ctx, a, b, calls, track = '') {
  const legs = [a, b, b, a];
  const durations = { a: [], b: [] };
  for (let i = 0; i < legs.length; i++) {
    const d = await runLeg(s, ctx, legs[i], calls, { track, pos: i === 0 || i === 3 ? 'a' : 'b' });
    (i === 0 || i === 3 ? durations.a : durations.b).push(...d);
  }
  const stat = (d) => {
    const sorted = d.sort((x, y) => x - y);
    return { p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1], n: sorted.length };
  };
  return { a: stat(durations.a), b: stat(durations.b) };
}

// 판정선: A/A(같은 스크립트끼리) 비율을 묶음 단위로 다시 뽑아(부트스트랩) 99%가 들어가는 폭을 잡음으로 삼고, SLOWLOG 눈금(1µs)보다 좁게는 두지 않는다
function bootstrapWidth(blocks, metric, resamples = 4000) {
  const r = rng(20261110);
  const n = blocks.length;
  const widths = [];
  for (let b = 0; b < resamples; b++) {
    const pa = [];
    const pb = [];
    for (let i = 0; i < n; i++) {
      const k = Math.floor(r() * n);
      pa.push(blocks[k].a[metric]);
      pb.push(blocks[k].b[metric]);
    }
    widths.push(Math.abs(Math.log(median(pb) / median(pa))));
  }
  widths.sort((x, y) => x - y);
  return percentile(widths, 0.99);
}
const summarize = (blocks, metric) => ({ a: median(blocks.map((b) => b.a[metric])), b: median(blocks.map((b) => b.b[metric])) });
const ratioOf = (blocks, metric) => {
  const s = summarize(blocks, metric);
  return s.b / s.a;
};
const pairedRatio = (blocks, metric) => median(blocks.map((b) => b.b[metric] / b.a[metric]));
function thresholds(blocks) {
  const line = {};
  for (const m of ['p50', 'p99']) {
    const value = summarize(blocks, m).a;
    const width = Math.max(bootstrapWidth(blocks, m), Math.log(1 + 1 / value));
    line[m] = { width, ratio: Math.exp(width) };
  }
  return line;
}
const verdict = (ratio, line) => (ratio > line.ratio ? '느림' : ratio < 1 / line.ratio ? '빠름' : '안');
const wasteLua = (text, count) => text.replace(/^(#!lua[^\n]*)\n/, `$1\nfor __waste_i = 1, ${count} do redis.call('EXISTS', KEYS[1]) end\n`);

async function scriptVariants(lua, s) {
  const vars = {};
  const load = async (label, side, text) => {
    vars[label] = { label, side, text, sha: await cmd(['SCRIPT', 'LOAD', text]) };
  };
  await load('new', 'new', lua.new[s.module][s.script]);
  if (s.old) await load('old', 'old', lua.old[s.module][s.script]);
  return { vars, load };
}

/** 빈 반복 한 번의 값을 재서 약 10%·30%·100% 느린 판을 만든다. 긴 스크립트에서도 잡음보다 크게 재도록 기준의 절반쯤 되는 반복으로 잰다 */
async function calibrateSlow(s, ctx, loaded, calls) {
  const { vars, load } = loaded;
  const warm = await runBlock(s, ctx, vars.new, vars.new, calls);
  const base = median([warm.a.p50, warm.b.p50]);
  const probeLoops = Math.max(100, Math.round((0.5 * base) / 0.45));
  await load('probe', 'new', wasteLua(vars.new.text, probeLoops));
  const probe = await runBlock(s, ctx, vars.new, vars.probe, calls);
  const perLoop = Math.max(0.05, (probe.b.p50 - probe.a.p50) / probeLoops);
  const out = [];
  for (const [label, target] of SLOW_TIERS.map((t) => [`slow${t}`, t / 100])) {
    const loops = target === 0 ? 0 : Math.max(1, Math.round((target * base) / perLoop)); // 0%는 위약 대조(글자만 다르고 일은 같다)
    await load(label, 'new', wasteLua(vars.new.text, loops));
    out.push({ label, target, loops, perLoopUs: perLoop });
  }
  return out;
}

async function runScenario(s, ctx, lua) {
  await pipe(baseState(ctx));
  if (s.setup) await pipe(s.setup(ctx));
  const calls = s.big ? BIG_CALLS : CALLS;
  const loaded = await scriptVariants(lua, s);
  const { vars } = loaded;
  const tracks = [];
  if (s.old) {
    tracks.push({ name: 'AA1', a: vars.new, b: vars.new }, { name: 'AB', a: vars.old, b: vars.new }, { name: 'AA2', a: vars.new, b: vars.new });
  } else {
    tracks.push({ name: 'ABS', a: vars.new, b: vars.new });
  }
  let slowPlan = null;
  if (s.old && SLOW.has(s.name)) {
    slowPlan = await calibrateSlow(s, ctx, loaded, calls); // 예열을 겸한다
    for (const p of slowPlan) tracks.push({ name: p.label, a: vars.new, b: vars[p.label] });
  } else {
    await runBlock(s, ctx, tracks[0].a, tracks[0].b, calls); // 예열
  }
  const started = Date.now();
  for (const t of tracks) t.blocks = [];
  for (let round = 0; round < BLOCKS; round++) for (const t of tracks) t.blocks.push(await runBlock(s, ctx, t.a, t.b, calls, t.name));
  const result = { name: s.name, title: s.title, seats: s.seats, script: s.script, kind: s.old ? 'compare' : 'absolute', callsPerSide: BLOCKS * 2 * calls, tracks: {} };
  for (const t of tracks) result.tracks[t.name] = { a: t.a.label, b: t.b.label, blocks: t.blocks };
  if (s.old) {
    result.aa = { p50: ratioOf(trackBlocks(result, 'AA1'), 'p50'), p99: ratioOf(trackBlocks(result, 'AA1'), 'p99') };
    result.line = thresholds(trackBlocks(result, 'AA1'));
  }
  if (slowPlan) result.slowPlan = slowPlan;
  console.log(`[끝] ${s.name} (${Math.round((Date.now() - started) / 1000)}초)`);
  return result;
}
const trackBlocks = (r, name) => r.tracks[name].blocks;

function report(results, meta) {
  const us = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
  const pct = (w) => `±${(100 * (Math.exp(w) - 1)).toFixed(1)}%`;
  const rate = (x) => x.toFixed(3);
  const row = (cells) => `| ${cells.join(' | ')} |`;
  const lines = [`측정: ${meta.startedAt} ~ ${meta.endedAt}, 묶음 ${BLOCKS}, 호출/다리 ${CALLS}(큰 묶음 ${BIG_CALLS}), Valkey ${meta.serverVersion}, 시계 ${meta.monotonicClock}, SLOWLOG 하한 ${SLOWLOG_US}µs, 잰 호출 ${meta.slowlogMeasured}건 가운데 기록이 빠진 호출 ${meta.slowlogMissing}건`, ''];
  const compare = results.filter((r) => r.kind === 'compare');
  lines.push('### 옛 코드 대 새 코드(묶음별 p50·p99의 중앙값, µs)', '');
  lines.push(row(['스크립트', '호출 수(쪽마다)', '옛 p50', '새 p50', 'p50 비율', '옛 p99', '새 p99', 'p99 비율', 'p50 판정선', 'p99 판정선', '판정', '대응 비교 p50', '대응 비교 p99']));
  lines.push(row(Array(13).fill('---')));
  for (const r of compare) {
    const b = trackBlocks(r, 'AB');
    const p50 = summarize(b, 'p50');
    const p99 = summarize(b, 'p99');
    const v50 = verdict(ratioOf(b, 'p50'), r.line.p50);
    const v99 = verdict(ratioOf(b, 'p99'), r.line.p99);
    lines.push(row([`${r.script} ${r.name}`, r.callsPerSide, us(p50.a), us(p50.b), rate(ratioOf(b, 'p50')), us(p99.a), us(p99.b), rate(ratioOf(b, 'p99')), rate(r.line.p50.ratio), rate(r.line.p99.ratio), `${v50}/${v99}`, rate(pairedRatio(b, 'p50')), rate(pairedRatio(b, 'p99'))]));
  }
  lines.push('', '### A/A 잡음(같은 스크립트끼리)', '');
  lines.push(row(['스크립트', 'A/A p50 비율', 'p50 폭(99%)', 'A/A p99 비율', 'p99 폭(99%)', '둘째 A/A p50', '둘째 A/A p99', '둘째 A/A 판정']));
  lines.push(row(Array(8).fill('---')));
  for (const r of compare) {
    const aa2 = trackBlocks(r, 'AA2');
    lines.push(row([r.name, rate(r.aa.p50), pct(r.line.p50.width), rate(r.aa.p99), pct(r.line.p99.width), rate(ratioOf(aa2, 'p50')), rate(ratioOf(aa2, 'p99')), `${verdict(ratioOf(aa2, 'p50'), r.line.p50)}/${verdict(ratioOf(aa2, 'p99'), r.line.p99)}`]));
  }
  lines.push('', '### 새 Lua 절대값(µs, 묶음별 값의 중앙값)', '');
  lines.push(row(['스크립트', '좌석·건', '호출 수', 'p50', 'p99', '가장 오래 걸린 호출']));
  lines.push(row(Array(6).fill('---')));
  for (const r of results.filter((x) => x.kind === 'absolute')) {
    const b = trackBlocks(r, 'ABS');
    const p50s = b.flatMap((x) => [x.a.p50, x.b.p50]);
    const p99s = b.flatMap((x) => [x.a.p99, x.b.p99]);
    const maxOf = Math.max(...b.flatMap((x) => [x.a.max, x.b.max]));
    lines.push(row([r.script, r.seats, r.callsPerSide * 2, us(median(p50s)), us(median(p99s)), us(maxOf)]));
  }
  const slowRows = results.filter((r) => r.slowPlan);
  if (slowRows.length) {
    lines.push('', '### 일부러 느리게 만든 판의 검출(새 코드 대 새 코드 + 빈 반복)', '');
    lines.push(row(['스크립트', '목표', '빈 반복 수', '반복 한 번(µs)', '실제 p50 비율', '실제 p99 비율', 'p50 판정선', 'p99 판정선', '결과']));
    lines.push(row(Array(9).fill('---')));
    for (const r of slowRows) {
      for (const p of r.slowPlan) {
        const b = trackBlocks(r, p.label);
        const v50 = verdict(ratioOf(b, 'p50'), r.line.p50);
        const v99 = verdict(ratioOf(b, 'p99'), r.line.p99);
        lines.push(row([r.name, `+${Math.round(p.target * 100)}%`, p.loops, p.perLoopUs.toFixed(3), rate(ratioOf(b, 'p50')), rate(ratioOf(b, 'p99')), rate(r.line.p50.ratio), rate(r.line.p99.ratio), v50 === '느림' || v99 === '느림' ? `검출(p50 ${v50}, p99 ${v99})` : '놓침']));
      }
    }
  }
  return lines.join('\n');
}

async function main() {
  const lua = { old: await loadLua(BASE), new: await loadLua(HEAD) };
  const startedAt = new Date().toISOString();
  docker('run', '-d', '--name', containerName, '-p', '127.0.0.1::6379', IMAGE, 'valkey-server', '--save', '', '--appendonly', 'no');
  const mapped = docker('port', containerName, '6379/tcp').split('\n')[0];
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  client = createClient({ url: `redis://127.0.0.1:${port}`, socket: { connectTimeout: 30000 } });
  client.on('error', () => {});
  for (let i = 0; ; i++) {
    try {
      await client.connect();
      await cmd(['PING']);
      break;
    } catch (err) {
      if (i >= 100) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await cmd(['CONFIG', 'SET', 'slowlog-log-slower-than', String(SLOWLOG_US)]);
  await cmd(['CONFIG', 'SET', 'slowlog-max-len', '200000']);
  fillerSha = await cmd(['SCRIPT', 'LOAD', '#!lua flags=no-writes\nreturn 1']);
  const server = await cmd(['INFO', 'server']);
  const serverVersion = /valkey_version:(\S+)/.exec(server)?.[1] ?? '?';
  const monotonicClock = /monotonic_clock:([^\r\n]+)/.exec(server)?.[1] ?? '?';
  const [sec, us] = await cmd(['TIME']);
  const offset = Number(sec) * 1000 + Math.floor(Number(us) / 1000) - Date.now();
  const ctx = { now: () => Date.now() + offset, keep: Date.now() + offset + 7 * 86400000 };
  const picked = ONLY ? scenarios.filter((s) => ONLY.has(s.name)) : [...scenarios];
  if (flag('reverse')) picked.reverse(); // 앞 시나리오가 남긴 Lua 상태의 영향을 보려고 순서를 뒤집는다
  console.log(`시나리오 ${picked.length}개, 묶음 ${BLOCKS}, Valkey ${serverVersion}`);
  const results = [];
  for (const s of picked) results.push(await runScenario(s, ctx, lua));
  const meta = { startedAt, endedAt: new Date().toISOString(), blocks: BLOCKS, calls: CALLS, bigCalls: BIG_CALLS, base: BASE, head: HEAD, image: IMAGE, serverVersion, monotonicClock, slowlogConfig: { 'slowlog-log-slower-than': SLOWLOG_US, 'slowlog-max-len': 200000 }, slowlogMeasured: tally.measured, slowlogMissing: tally.missing };
  const table = report(results, meta);
  console.log(table);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ meta, results, rawLegs }));
  console.log(`결과 JSON: ${OUT}`);
  if (MD) writeFileSync(MD, `${table}\n`);
}

function cleanup() {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  if (!flag('keep')) {
    try {
      docker('rm', '-f', '-v', containerName);
    } catch {
      // 없으면 그만이다
    }
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
try {
  await main();
} finally {
  await client?.quit().catch(() => {});
  cleanup();
}
