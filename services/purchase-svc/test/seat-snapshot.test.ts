// 좌석 스냅샷 읽기 계약 사례(test/seat-snapshot-cases.ts)를 메모리 저장소(MemorySeatStore)로 돈다. 같은 사례를 실제 Valkey 8.1 Lua로 도는 것은
// test-int/seat-snapshot.int.test.ts다. 앱 쪽 시각은 주입한 가짜 시계다.
import { fakeClock } from '@peaket/platform';
import { MemorySeatStore } from '../src/modules/inventory/index.js';
import { type SnapshotHarness, seatSnapshotCases } from './seat-snapshot-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');

function memoryHarness(): SnapshotHarness {
  const clock = fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock);
  const ev = (e: string) => store.db.event(e);
  return {
    store,
    clock,
    // 비트맵 바이트(높은 비트부터)에서 1인 좌석 색인만 Set에 둔다. 비트맵 크기는 바이트 수 × 8비트다
    setBitmapBytes: async (e, bytes) => {
      const event = ev(e);
      event.bits.clear();
      event.seatCount = bytes.length * 8;
      for (let k = 0; k < bytes.length * 8; k++) if ((bytes[k >> 3]! & (0x80 >> (k & 7))) !== 0) event.bits.add(k);
    },
    dropBitmap: async (e) => {
      ev(e).bits.clear();
      ev(e).seatCount = undefined;
    },
    dropEpoch: async (e) => void (ev(e).epoch = undefined),
    setSecver: async (e, s, v) => void ev(e).secver.set(s, v),
    dropSecver: async (e) => ev(e).secver.clear(),
    bit: async (e, i) => (ev(e).bits.has(i) ? 1 : 0),
    secver: async (e) => Object.fromEntries([...ev(e).secver].map(([k, v]) => [String(k), v])),
    dump: async (e) => {
      const x = ev(e);
      return JSON.parse(
        JSON.stringify({
          epoch: x.epoch,
          seatCount: x.seatCount,
          bits: [...x.bits].sort((a, b) => a - b),
          holds: [...x.holds],
          expiry: [...x.expiry],
          quota: [...x.quota],
          secver: [...x.secver],
          fence: x.fence,
          stream: x.stream,
          published: x.published,
          expireAt: [...x.expireAt],
          idem: [...x.idem],
          ctlEvents: [...store.db.ctlEvents].sort(),
        }),
      ) as unknown;
    },
  };
}

seatSnapshotCases('메모리', async () => memoryHarness());
