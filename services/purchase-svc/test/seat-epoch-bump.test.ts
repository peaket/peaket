// 좌석을 쓰는 Lua가 그 자리에서 회차 세대를 올린다(BUILD_ORDER PRF-168 리뷰 고침 H1, ADR-0210 결정 1·2·4, docs/features/seat-hold.md §6 '쓰는 Lua가 그 자리에서 올린다').
// 공용 사례(test/epoch-bump-cases.ts)를 메모리 저장소(MemorySeatStore, 쌍둥이: 표지는 생성자 nodeId·setNodeId, chk는 주입 시계의 초)로 돌리고,
// 운영 Lua 글이 같은 도우미 하나(hold-lua.ts ENSURE_EPOCH)를 쓰는지 본다. 실제 Valkey는 test-int/seat-store.int.test.ts가 같은 사례를 돈다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  BUMP_EPOCH_LUA,
  ENSURE_EPOCH,
  EXPIRE_LUA,
  HOLD_LUA,
  MemorySeatStore,
  ORDER_HOLD_LUA,
  PIN_LUA,
  RELEASE_FAILED_LUA,
  SEAT_SLOT_READ_LUA,
  SNAPSHOT_LUA,
} from '../src/modules/inventory/index.js';
import { type EpochBumpHarness, epochBumpCases, OLD_PRIMARY } from './epoch-bump-cases.js';
import { DAY, holdInput, newEvent, SEAT_COUNT } from './hold-cases.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const NOW_SEC = Math.floor(NOW / 1000);
/** 클러스터 모양의 표지(노드 ID 40자 + ':' + 설정 세대) */
const CLUSTER_NODE = '9f3c0e7a1b2d4c5e6f708192a3b4c5d6e7f80912:7';

function memoryHarness(nodeId?: string): EpochBumpHarness & { store: MemorySeatStore } {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock, undefined, nodeId === undefined ? {} : { nodeId });
  const ev = (e: string) => store.db.event(e);
  return {
    store,
    clock,
    me: () => nodeId ?? 'standalone',
    serverSec: async () => Math.floor(clock.now() / 1000),
    setEpoch: async (e, f) => {
      const x = ev(e).epoch;
      if (!x) throw new Error('세대 키가 없다');
      if (f.node !== undefined) x.node = f.node;
      if (f.chk !== undefined) x.chk = Number(f.chk);
      if (f.epoch !== undefined) x.epoch = Number(f.epoch);
    },
    epoch: async (e) => {
      const x = store.db.peek(e)?.epoch;
      return x ? { epoch: x.epoch, node: x.node, chk: x.chk ?? null } : null;
    },
    // Valkey HGETALL처럼 있는 칸만 글로
    epochRaw: async (e) => {
      const x = store.db.peek(e)?.epoch;
      return x ? Object.fromEntries(Object.entries(x).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))) : null;
    },
    stream: async (e) => ev(e).stream.map((r) => ({ ...r })),
    published: async (e) => ev(e).published.map((p) => ({ ...p })),
    backdate: async (e, i, at) => {
      const hh = ev(e).holds.get(i);
      if (!hh) throw new Error(`홀드 Hash가 없다: ${i}`);
      hh.exp = at;
      ev(e).expiry.set(i, at);
    },
    pause: async (e) => void ev(e).ctl.set('paused', '1'),
    corrupt: async (e, what, a) => {
      if (what === 'fence') ev(e).fence = 'x1';
      else ev(e).quota.set(a, 1.5);
    },
  };
}

epochBumpCases('메모리 단일 노드', async () => memoryHarness(), { configPart: false });
epochBumpCases('메모리 클러스터 표지', async () => memoryHarness(CLUSTER_NODE), { configPart: true });

describe('메모리 쌍둥이의 세대 올리기(BUMP_EPOCH_LUA와 같은 규칙, chk)', () => {
  test('ST26_리뷰 고침 H1_ 세대 올리기도 같은 도우미 규칙이다: 노드 ID가 같고 설정 세대만 다르면 chk가 이번 초 이상인 동안 SAME, chk가 지난 초면 BUMPED 한 번(node = 지금 표지, chk = 지금 초)이다. 다른 노드 ID는 chk와 관계없이 BUMPED다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const h = memoryHarness(CLUSTER_NODE);
    const e = newEvent();
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
    const stale = `${CLUSTER_NODE.split(':')[0]}:6`;
    await h.setEpoch(e, { node: stale, chk: String(NOW_SEC) });
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: NOW_SEC, bumps: 0 });
    expect(await h.epoch(e)).toEqual({ epoch: NOW_SEC, node: stale, chk: NOW_SEC });
    await h.setEpoch(e, { chk: String(NOW_SEC - 1) });
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'BUMPED', epoch: NOW_SEC + 1, bumps: 1 });
    expect(await h.epoch(e)).toEqual({ epoch: NOW_SEC + 1, node: CLUSTER_NODE, chk: NOW_SEC });
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: NOW_SEC + 1, bumps: 1 });
    await h.setEpoch(e, { node: OLD_PRIMARY, chk: String(NOW_SEC + 100) });
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'BUMPED', epoch: NOW_SEC + 2, bumps: 2 });
  });

  test('ST26_리뷰 고침 H1_ setNodeId로 승격을 흉내 내면 감시 없이 다음 홀드가 그 자리에서 세대를 올린다(HELD의 seatEpoch = 새 세대) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const h = memoryHarness();
    const e = newEvent();
    const keepUntilMs = NOW + 2 * DAY;
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    h.store.setNodeId(CLUSTER_NODE);
    const r = await h.store.hold(holdInput(e, ['A01'], { keepUntilMs }));
    expect(r.kind).toBe('OK');
    expect(await h.epoch(e)).toEqual({ epoch: NOW_SEC + 1, node: CLUSTER_NODE, chk: NOW_SEC });
    expect(h.store.db.event(e).stream.at(-1)).toMatchObject({ type: 'HELD', seatEpoch: String(NOW_SEC + 1) });
    expect(await h.store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: NOW_SEC + 1, bumps: 1 });
  });

  test('ST26_리뷰 고침 H1_ 세대 칸이 u32 정수가 아니면(NaN·음수·소수) 올려야 할 때도 아무것도 쓰지 않고 PEAKET_CORRUPT_KEY {세대 키}를 던진다 [S-T26]', async () => {
    for (const bad of ['NaN', '-1', '1.5']) {
      const h = memoryHarness();
      const e = newEvent();
      const keepUntilMs = NOW + 2 * DAY;
      await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
      await h.setEpoch(e, { node: OLD_PRIMARY, epoch: bad });
      await expect(h.store.hold(holdInput(e, ['A01'], { keepUntilMs })), bad).rejects.toThrow(/PEAKET_CORRUPT_KEY s:\{event:[^}]+\}:epoch/);
      await expect(h.store.bumpEpoch(e), bad).rejects.toThrow(/PEAKET_CORRUPT_KEY s:\{event:[^}]+\}:epoch/);
      expect(h.store.db.event(e).bits.size).toBe(0);
      expect((await h.epoch(e))!.node).toBe(OLD_PRIMARY);
    }
  });

  test('ST26_리뷰 고침 중간 1_ bumps 칸이 0 이상의 안전한 정수가 아니면 세대 키가 망가진 것이다: 홀드·세대 올리기가 아무것도 쓰지 않고 PEAKET_CORRUPT_KEY {세대 키}를 던진다 [S-T26]', async () => {
    const h = memoryHarness();
    const e = newEvent();
    const keepUntilMs = NOW + 2 * DAY;
    await h.store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    h.store.db.event(e).epoch!.bumps = -1;
    await h.setEpoch(e, { node: OLD_PRIMARY });
    await expect(h.store.hold(holdInput(e, ['A01'], { keepUntilMs }))).rejects.toThrow(/PEAKET_CORRUPT_KEY s:\{event:[^}]+\}:epoch/);
    await expect(h.store.bumpEpoch(e)).rejects.toThrow(/PEAKET_CORRUPT_KEY s:\{event:[^}]+\}:epoch/);
    expect(h.store.db.event(e).epoch).toMatchObject({ epoch: NOW_SEC, node: OLD_PRIMARY, bumps: -1 });
  });
});

describe('운영 Lua 글: 세대 확인 도우미 하나(ENSURE_EPOCH, ADR-0210 결정 4)', () => {
  test('ST26_리뷰 고침 H1_ 홀드·만료·묶기·실패 해제·세대 올리기 Lua는 hold-lua.ts ENSURE_EPOCH 글을 그대로 싣고(만료 Lua는 가져오지 않고 같은 글을 둔다), 세대 키를 그 도우미로만 읽는다. 스냅샷·주문 홀드 확인·슬롯 읽기 Lua는 CLUSTER 명령을 부르지 않는다 [ASVS v5.0.0-15.4.2] [S-T26]', () => {
    expect(typeof ENSURE_EPOCH).toBe('string');
    expect(ENSURE_EPOCH).toMatch(/local function ensureEpoch\(/);
    for (const [name, src] of Object.entries({ HOLD_LUA, EXPIRE_LUA, PIN_LUA, RELEASE_FAILED_LUA, BUMP_EPOCH_LUA })) {
      expect(src.includes(ENSURE_EPOCH), `${name}에 ENSURE_EPOCH 글이 그대로 있다`).toBe(true);
      expect(src.split(ENSURE_EPOCH).length, `${name}에 한 번만`).toBe(2);
    }
    // 쓰는 Lua는 세대(Stream·델타에 싣는 값)를 도우미가 돌려준 값으로만 쓴다(세대 올리기 Lua는 망가진 값을 CLUSTER 명령 전에 거르려고 칸을 먼저 본다)
    for (const [name, src] of Object.entries({ HOLD_LUA, EXPIRE_LUA, PIN_LUA, RELEASE_FAILED_LUA })) {
      expect(src, `${name}이 세대 키 epoch 칸을 도우미 밖에서 읽지 않는다`).not.toMatch(/H(M)?GET', KEYS\[\d+\], 'epoch'/);
    }
    for (const [name, src] of Object.entries({ SNAPSHOT_LUA, ORDER_HOLD_LUA, SEAT_SLOT_READ_LUA })) expect(src, name).not.toMatch(/CLUSTER/);
  });
});
