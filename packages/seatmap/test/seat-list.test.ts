// 접근성 좌석 목록의 Worker 메시지(BUILD_ORDER HOT-354, docs/frontend.md §4.7·§5.2, CMP-022).
// 목록이 구역을 열면 그 구역 전체를 한 번(sectionState), 그 뒤에는 바뀐 좌석만(stateChanged) 받는다. 상태 배열은 복사하지 않고 넘긴다.
import { describe, expect, it, vi } from 'vitest';
import { FromWorker, LIST_STATES } from '../src/protocol';
import { createHandler } from '../src/worker';
import { encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

type Posted = { type: string } & Record<string, unknown>;
const code = (s: (typeof LIST_STATES)[number]) => LIST_STATES.indexOf(s);

async function open() {
  const posted: Posted[] = [];
  const transfers: Transferable[][] = [];
  const host = {
    post: (m: unknown, t?: Transferable[]) => {
      posted.push(FromWorker.parse(m) as Posted);
      transfers.push(t ?? []);
    },
    fetch: vi.fn(async (url: string) =>
      url.endsWith('.json')
        ? new Response(JSON.stringify(makeLayout()))
        : new Response(encodeSnapshot({ layoutVersion: makeLayout().layoutVersion, seatEpoch: 1, sections: [[0, 1], [1, 1], [2, 1], [3, 1]], occupied: Array.from({ length: 800 }, (_, i) => i === 2) }).buffer as ArrayBuffer),
    ),
    nextFrame: async () => {},
    now: () => 1000,
  };
  const handle = createHandler(host, () => fakeCtx());
  await handle({ type: 'init', canvas: {}, layoutUrl: 'http://w/1.json', snapshotUrl: 'http://a/snap', admission: { token: 't' }, width: 800, height: 600, dpr: 1, theme: 'light' });
  posted.length = 0;
  transfers.length = 0;
  return { handle, posted, transfers };
}

describe('FE-T18 CMP-022 목록 메시지(§4.7)', () => {
  it('listSections에 구역 이름과 남은 좌석 상태를 한 번 답한다', async () => {
    const { handle, posted } = await open();
    await handle({ type: 'listSections' });
    expect(posted).toHaveLength(1);
    const m = posted[0] as unknown as { type: string; sections: Array<{ section: number; name: string; status: string }> };
    expect(m.type).toBe('sectionList');
    expect(m.sections).toHaveLength(4);
    expect(m.sections[0]).toMatchObject({ section: 0, name: makeLayout().sections[0]!.name });
    expect(['plenty', 'few', 'soldout']).toContain(m.sections[0]!.status);
  });

  it('구역을 열면 그 구역의 열·좌석과 상태 전체를 한 번 주고, 상태 배열은 소유권을 넘긴다', async () => {
    const { handle, posted, transfers } = await open();
    await handle({ type: 'listSection', section: 0 });
    expect(posted).toHaveLength(1);
    const m = posted[0] as unknown as { type: string; section: number; baseIndex: number; states: Uint8Array; seats: { seatId: string[]; row: string[]; number: string[]; tier: number[]; wheelchair: number[] }; tiers: string[] };
    const sec = makeLayout().sections[0]!;
    expect(m).toMatchObject({ type: 'sectionState', section: 0, baseIndex: 0, tiers: makeLayout().tiers });
    expect(m.seats.seatId).toEqual(sec.seats.seatId);
    expect(m.seats.row).toEqual(sec.seats.row);
    expect(m.states).toHaveLength(sec.seats.seatId.length);
    expect(m.states[0]).toBe(code('available'));
    expect(m.states[2]).toBe(code('sold'));
    expect(transfers[0]).toEqual([m.states.buffer]);
  });

  it('없는 구역은 답하지 않는다', async () => {
    const { handle, posted } = await open();
    await handle({ type: 'listSection', section: 99 });
    expect(posted.filter((m) => m.type === 'sectionState')).toEqual([]);
  });

  it('연 구역의 좌석을 고르거나 풀면 바뀐 좌석만 보내고 배열을 넘긴다', async () => {
    const { handle, posted, transfers } = await open();
    await handle({ type: 'listSection', section: 0 });
    posted.length = 0;
    transfers.length = 0;
    await handle({ type: 'select', seatIndex: 5 });
    const changed = posted.find((m) => m.type === 'stateChanged') as unknown as { section: number; version: number; offsets: Uint32Array; states: Uint8Array };
    expect(changed.section).toBe(0);
    expect([...changed.offsets]).toEqual([5]);
    expect([...changed.states]).toEqual([code('mine')]);
    expect(transfers[posted.indexOf(changed as never)]).toEqual([changed.offsets.buffer, changed.states.buffer]);
    posted.length = 0;
    await handle({ type: 'select', seatIndex: 5 });
    expect([...(posted.find((m) => m.type === 'stateChanged') as unknown as { states: Uint8Array }).states]).toEqual([code('available')]);
  });

  it('다른 구역의 좌석이거나 목록을 닫았으면 보내지 않는다', async () => {
    const { handle, posted } = await open();
    await handle({ type: 'listSection', section: 0 });
    await handle({ type: 'select', seatIndex: 300 });
    expect(posted.filter((m) => m.type === 'stateChanged')).toEqual([]);
    await handle({ type: 'listSection', section: null });
    await handle({ type: 'select', seatIndex: 5 });
    expect(posted.filter((m) => m.type === 'stateChanged')).toEqual([]);
  });
});
