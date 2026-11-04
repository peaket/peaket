// 좌석 Lua 오류 갈래(seatLuaErrorOf)와 지표 seat_lua_errors_total{script,code}(PromSeatSignals), docs/observability.md §5 '좌석 Lua 오류 신호',
// seat-hold.md §3 '쓰기 전 지킴'·§9, BUILD_ORDER PRF-135 'PRF-130 리뷰 낮음 4'. 로그·지표에는 키 종류만 남긴다(ASVS 16.2.5).
import { PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PromSeatSignals, type SeatKeyKind, SeatStoreUnavailable, seatKeys, seatLuaErrorOf } from '../src/modules/inventory/index.js';

const ACC = '0190f3a1-7c2e-7a00-8000-0000000000a1';

/** 노출 글에서 seat_lua_errors_total 표본을 '{이름표 이름들} {script}/{code} {값}'으로(이름표 차례와 관계없이) */
function samples(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('seat_lua_errors_total{'))
    .map((l) => {
      const labels = Object.fromEntries([...l.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      return `${Object.keys(labels).sort().join(',')} ${labels.script}/${labels.code} ${l.slice(l.lastIndexOf(' ') + 1)}`;
    })
    .sort();
}
const E = 'ev-1';

describe('seatLuaErrorOf(저장소 오류 → 지표·로그 갈래)', () => {
  test('NFR015_ 메모리 부족 SeatStoreUnavailable은 OOM이고, 일시 장애는 Lua 오류로 세지 않는다(undefined) [ASVS v5.0.0-16.3.4]', () => {
    expect(seatLuaErrorOf(new SeatStoreUnavailable(new Error('OOM command not allowed'), 'oom'))).toEqual({ code: 'OOM' });
    expect(seatLuaErrorOf(new SeatStoreUnavailable(new Error('down')))).toBeUndefined();
    expect(seatLuaErrorOf(new SeatStoreUnavailable(new Error('down'), 'unavailable'))).toBeUndefined();
  });

  test('ST4_ PEAKET_CORRUPT_KEY는 CORRUPT_KEY와 그 뒤 첫 키 이름의 종류이고, 계정 ID·회차 ID·오류 글은 결과에 없다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', () => {
    const cases: [string, SeatKeyKind][] = [
      [seatKeys.quota(E, ACC), 'quota'],
      [seatKeys.hold(E, 12), 'hold'],
      [seatKeys.bitmap(E), 'bitmap'],
      [seatKeys.expiry(E), 'expiry'],
      [seatKeys.stream(E), 'stream'],
      [seatKeys.secver(E), 'secver'],
      [seatKeys.fence(E), 'fence'],
      [seatKeys.epoch(E), 'epoch'],
      [seatKeys.ctl(E), 'ctl'],
      [seatKeys.rel(E, ACC), 'rel'],
      [seatKeys.idem(E, ACC, '9a1f0c3e-4b2d-4c8e-9f00-000000000001'), 'idem'],
      [seatKeys.sweep(E), 'sweep'],
      [seatKeys.ctlEvents(), 'ctl:events'],
      [`s:{event:${E}}:zzz`, 'unknown'],
      ['s:nothing', 'unknown'],
      ['', 'unknown'],
    ];
    for (const [key, keyKind] of cases) {
      for (const msg of [`ERR PEAKET_CORRUPT_KEY ${key}`, `PEAKET_CORRUPT_KEY ${key}`, `ERR Error running script: @user_script:9: PEAKET_CORRUPT_KEY ${key}`]) {
        const r = seatLuaErrorOf(new Error(msg));
        expect({ msg, r }).toEqual({ msg, r: { code: 'CORRUPT_KEY', keyKind } });
        expect(JSON.stringify(r)).not.toContain(ACC);
        expect(JSON.stringify(r)).not.toContain(E);
      }
    }
  });

  test('ST4_ PEAKET_KEEP_UNTIL_PAST·PEAKET_FENCE_OVERFLOW는 그 code이고 키 종류가 없다. 그 밖의 Error와 Error가 아닌 값은 OTHER이며 던지지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    expect(seatLuaErrorOf(new Error('ERR PEAKET_KEEP_UNTIL_PAST keepUntil 1 now 2'))).toStrictEqual({ code: 'KEEP_UNTIL_PAST' });
    expect(seatLuaErrorOf(new Error('PEAKET_FENCE_OVERFLOW 9007199254740992'))).toStrictEqual({ code: 'FENCE_OVERFLOW' });
    for (const x of [new Error('ERR Error running script'), new Error('WRONGTYPE Operation against a key'), new RangeError('x'), 'PEAKET_CORRUPT_KEY s:{event:e}:quota:a', null, undefined, 42, {}]) {
      expect({ x: String(x), r: seatLuaErrorOf(x) }).toEqual({ x: String(x), r: { code: 'OTHER' } });
    }
  });
});

describe('PromSeatSignals(seat_lua_errors_total)', () => {
  test('NFR015_ register는 서비스 레지스트리에 붙이고 자신을 돌려주며, luaError는 {script, code} 이름표만으로 1씩 올린다(회차·계정·키 이름표 없음) [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromSeatSignals();
    expect(s.register(metrics.registry)).toBe(s);
    s.luaError('expire', 'OOM');
    s.luaError('expire', 'OOM');
    s.luaError('hold', 'CORRUPT_KEY');
    s.luaError('expire', 'NOT_READY');
    const text = await metrics.registry.metrics();
    expect(samples(text)).toEqual(['code,script expire/NOT_READY 1', 'code,script expire/OOM 2', 'code,script hold/CORRUPT_KEY 1']);
    expect(text).toContain('# TYPE seat_lua_errors_total counter');
  });

  test('NFR015_ 붙이기 전에도 luaError는 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않는다', async () => {
    const a = new PromSeatSignals();
    expect(() => a.luaError('hold', 'OTHER')).not.toThrow();
    const m = new PlatformMetrics('purchase-svc');
    const b = new PromSeatSignals().register(m.registry);
    b.luaError('hold', 'KEEP_UNTIL_PAST');
    expect(samples(await m.registry.metrics())).toEqual(['code,script hold/KEEP_UNTIL_PAST 1']);
  });
});
