// 좌석 묶기·결제 실패 해제(BUILD_ORDER PRF-142) 계약 사례(test/pin-cases.ts)를 메모리 저장소(MemorySeatStore, 주입 가짜 시계)로 돈다.
// 상태는 MemorySeatStore가 내보내는 db(MemorySeatEvent)를 직접 읽고 쓴다(hold-seats.test.ts의 메모리 도구와 같은 방식).
import { fakeClock } from '@peaket/platform';
import { MemorySeatStore, type MemoryHoldHash, type MemorySeatEvent } from '../src/modules/inventory/index.js';
import { type PinHarness, pinCases } from './pin-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');

/** 세대 키에 다시 만들기 판 번호 gen 칸을 더한 모양(메모리 구현은 epoch.gen(수)으로 둔다고 본다) */
type EpochWithGen = NonNullable<MemorySeatEvent['epoch']> & { gen?: number };

function memoryPinHarness(): PinHarness {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  const ev = (e: string) => store.db.event(e);
  const strings = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
  // 메모리 Hash의 시각 칸은 수다(MemoryHoldHash)
  const typed = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === 'heldAt' || k === 'exp' ? Number(v) : v]));
  return {
    store,
    clock,
    skewMs: 0,
    published: async (e) => ev(e).published.map((p) => ({ ...p })),
    setQuota: async (e, a, q) => void ev(e).quota.set(a, q),
    setFence: async (e, v) => {
      ev(e).fence = v;
    },
    setCtl: async (e, f) => {
      for (const [k, v] of Object.entries(f)) ev(e).ctl.set(k, v);
    },
    dropEpoch: async (e) => void (ev(e).epoch = undefined),
    setGen: async (e, g) => {
      const x = ev(e).epoch as EpochWithGen | undefined;
      if (!x) throw new Error('세대 키가 없다');
      if (g === null) delete x.gen;
      else x.gen = g;
    },
    setHoldRaw: async (e, i, fields) => {
      if (fields === null) ev(e).holds.delete(i);
      else ev(e).holds.set(i, typed(fields) as unknown as MemoryHoldHash);
    },
    setHoldField: async (e, i, field, value) => void ev(e).holds.set(i, { ...(ev(e).holds.get(i) ?? {}), ...typed({ [field]: value }) } as unknown as MemoryHoldHash),
    setExpiry: async (e, member, score) => void ev(e).expiry.set(Number(member), score),
    bit: async (e, i) => (ev(e).bits.has(i) ? 1 : 0),
    holdHash: async (e, i) => {
      const x = ev(e).holds.get(i);
      return x ? strings(x) : null;
    },
    expiryScore: async (e, i) => ev(e).expiry.get(i) ?? null,
    quota: async (e, a) => ev(e).quota.get(a) ?? null,
    fence: async (e) => ev(e).fence ?? null,
    secver: async (e) => Object.fromEntries([...ev(e).secver].map(([k, v]) => [String(k), v])),
    stream: async (e) => ev(e).stream.map((r) => ({ ...r })),
    rel: async (e, a) => Object.fromEntries([...(ev(e).rel.get(a) ?? new Map<number, number>())].map(([k, v]) => [String(k), v])),
    expireAt: async (e, key) => ev(e).expireAt.get(key) ?? null,
    epoch: async (e) => {
      const x = ev(e).epoch;
      return x ? { epoch: x.epoch, node: x.node } : null;
    },
    gen: async (e) => {
      const x = ev(e).epoch as EpochWithGen | undefined;
      return x?.gen === undefined ? null : Number(x.gen);
    },
  };
}

pinCases(async () => memoryPinHarness());
