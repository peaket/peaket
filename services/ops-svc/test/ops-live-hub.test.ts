// 파드 하나의 알림 표 읽기(PushHub) 단위 시험: 리뷰 반영(F-03-1 RV-01·RV-02).
// 정본: openapi /v1/ops/live 'Last-Event-ID가 없으면 첫 덩이에 지금 순번을 id로만 둔다', ADR-0360 결정 2(첫 덩이 지금 순번, 되돌린 번호는 2초 뒤 건너뜀),
// ADR-0100 결정 2 '빠지지 않게 다시 붙기'·FE-T28 ①('빠진 command·alert가 없다'). ADR-0360 '결과와 남는 한계'는 늦게 커밋된 순번의 빠짐을 한계로 적지 않았다.
// 알림 표 대역 InFlightPushEvents는 순번을 먼저 받고(트리거의 nextval) 나중에 커밋하는 PostgreSQL 모양을 따른다: latest()는 커밋 전 번호까지 포함한
// 시퀀스 마지막 값이다(DrizzlePushEvents.latest()와 같다. 실제 PostgreSQL 쪽은 test-int/ops-live.int.test.ts의 RV-01·RV-02 시험이 본다).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditCheckpointService, MemoryAuditChain, MemoryAuditCheckpointStore } from '../src/modules/audit/index.js';
import { MemoryCommandStore } from '../src/modules/commands/index.js';
import { OpsLiveFeed, PushHub, type PushEventRow, type PushEventSource } from '../src/modules/live/index.js';

const T0 = Date.parse('2026-11-23T01:00:00.000Z');
/** ADR-0360 결정 2 '2초 [가정] 뒤에도 비면 건너뛴다' */
const GAP_WAIT_MS = 2_000;

class InFlightPushEvents implements PushEventSource {
  #next = 0;
  readonly #rows: PushEventRow[] = [];
  constructor(private readonly now: () => number) {}
  /** 순번만 받는다(트랜잭션 안 트리거의 nextval, 아직 커밋 전) */
  reserve(): number {
    this.#next += 1;
    return this.#next;
  }
  /** 받은 순번의 행이 커밋되어 보인다 */
  commit(seq: number): void {
    this.#rows.push({ seq, kind: 'alert', eventId: null, roles: ['viewer', 'operator', 'commander'], body: { alertId: `a${seq}`, status: 'firing' }, createdAtMs: this.now() });
    this.#rows.sort((a, b) => a.seq - b.seq);
  }
  /** 받고 바로 커밋 */
  append(): number {
    const s = this.reserve();
    this.commit(s);
    return s;
  }
  async after(seq: number, limit: number): Promise<readonly PushEventRow[]> {
    return this.#rows.filter((r) => r.seq > seq).slice(0, limit);
  }
  async latest(): Promise<number> {
    return this.#next;
  }
  async oldestWithin(windowMs: number): Promise<number | undefined> {
    return this.#rows.find((r) => r.createdAtMs >= this.now() - windowMs)?.seq;
  }
  async deleteOlderThan(): Promise<number> {
    return 0;
  }
}

function world() {
  let now = T0;
  const source = new InFlightPushEvents(() => now);
  const chain = new MemoryAuditChain();
  const feed = new OpsLiveFeed({ commands: new MemoryCommandStore(chain), checkpoints: new AuditCheckpointService(new MemoryAuditCheckpointStore(), chain, () => now) });
  const hub = new PushHub(source, feed, { gapWaitMs: GAP_WAIT_MS, now: () => now });
  /** 컨트롤러처럼 연결 하나를 붙인다: ready 뒤 정한 번호가 Last-Event-ID 없는 연결의 첫 id다 */
  const connect = async () => {
    const got: number[] = [];
    const off = hub.subscribe((batch) => got.push(...batch.map((d) => d.row.seq)));
    await hub.ready();
    return { got, firstId: hub.settled, off };
  };
  return { source, hub, connect, advance: (ms: number) => (now += ms) };
}

describe('F-03-1 리뷰 반영: 파드의 알림 표 읽기', () => {
  // 허브의 0.5초 반복은 시험이 poll()을 직접 불러 대신한다(실제 시계 반복이 끼어들지 않게)
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('F-03-1 RV-01 ① 연결이 0이 되어 읽기가 멈춘 뒤 Last-Event-ID 없이 연 연결은 첫 id가 지금 순번이고 멈춘 동안의 지난 사건을 받지 않는다(openapi /v1/ops/live, ADR-0360 결정 2)', async () => {
    const w = world();
    w.source.append();
    const a = await w.connect();
    expect(a.firstId).toBe(1);
    w.source.append();
    await w.hub.poll();
    expect(a.got).toEqual([2]);
    a.off();
    expect(w.hub.listenerCount).toBe(0);
    // 아무도 보지 않는 동안 행 둘
    w.source.append();
    w.source.append();
    w.advance(60_000);
    const b = await w.connect();
    expect(b.firstId).toBe(4);
    await w.hub.poll();
    expect(b.got).toEqual([]);
    w.source.append();
    await w.hub.poll();
    expect(b.got).toEqual([5]);
    b.off();
  });

  test('F-03-1 RV-01 ② 파드가 처음 읽을 때 커밋 전 순번(시퀀스 마지막 값)을 정한 번호로 잡지 않아, 그 행이 커밋되면 받는다', async () => {
    const w = world();
    w.source.append(); // 1 커밋
    const inFlight = w.source.reserve(); // 2 진행 중(트랜잭션 안)
    const c = await w.connect();
    expect(c.firstId).toBeLessThan(inFlight);
    w.source.commit(inFlight);
    await w.hub.poll();
    expect(c.got).toEqual([inFlight]);
    c.off();
  });

  test('F-03-1 RV-02 ADR-0100 결정 2 빠지지 않게(정본이 늦은 커밋의 빠짐을 허용하지 않음) 2초 넘게 늦게 커밋된 순번은 건너뛴 뒤에도 커밋되면 흐름에 늦게라도 온다', async () => {
    const w = world();
    w.source.append(); // 1
    const c = await w.connect();
    const late = w.source.reserve(); // 2: 커밋이 늦는 트랜잭션
    w.source.append(); // 3
    await w.hub.poll();
    expect(c.got).toEqual([]);
    w.advance(GAP_WAIT_MS - 1);
    await w.hub.poll();
    expect(c.got).toEqual([]);
    w.advance(1);
    await w.hub.poll();
    expect(c.got).toEqual([3]);
    // 3초 늦게 커밋된다
    w.advance(1_000);
    w.source.commit(late);
    await w.hub.poll();
    w.advance(500);
    await w.hub.poll();
    expect(c.got).toEqual([3, late]);
    // 되돌려 영영 비는 번호(4)는 2초 뒤 건너뛰고 뒤 번호는 막히지 않는다(ADR-0360 결정 2)
    w.source.reserve();
    const after = w.source.append();
    w.advance(GAP_WAIT_MS);
    await w.hub.poll();
    await w.hub.poll();
    expect(c.got).toEqual([3, late, after]);
    c.off();
  });

  test('F-03-1 RV-02 ② V-R5 늦은 행(번호 10)을 낼 때 정한 번호가 15면, 커서 10~15로 다시 붙는 연결은 9부터 다시 받아 늦은 행을 받고, 커서 9·16은 당겨지지 않는다(ADR-0100 결정 2 빠지지 않게 다시 붙기)', async () => {
    const w = world();
    for (let i = 1; i <= 9; i += 1) w.source.append();
    const c = await w.connect();
    expect(c.firstId).toBe(9);
    const late = w.source.reserve(); // 10: 커밋이 늦는 트랜잭션
    for (let i = 11; i <= 15; i += 1) w.source.append();
    await w.hub.poll();
    w.advance(GAP_WAIT_MS);
    await w.hub.poll();
    expect(c.got).toEqual([11, 12, 13, 14, 15]);
    expect(w.hub.settled).toBe(15);
    // 늦은 행이 나타나기 전에는 당길 것이 없다
    expect(w.hub.rewind(15)).toBe(15);
    w.advance(1_000);
    w.source.commit(late);
    await w.hub.poll();
    expect(c.got).toEqual([11, 12, 13, 14, 15, late]);
    // 끊긴 연결의 커서가 늦은 행 번호 이상·그때 정한 번호 이하면 그 행을 받았는지 모르므로 늦은 행 바로 앞부터 다시 보낸다
    expect([10, 12, 15].map((cursor) => w.hub.rewind(cursor))).toEqual([9, 9, 9]);
    // 늦은 행 앞의 커서는 보통 다시 보내기가 그 행을 싣고, 그때 정한 번호 뒤의 커서는 늦은 행이 나타난 뒤에 이어 받던 연결이다
    expect(w.hub.rewind(9)).toBe(9);
    expect(w.hub.rewind(16)).toBe(16);
    // 다시 붙는 연결이 실제로 받는 행: 당긴 커서부터 지금 정한 번호까지(늦은 행 포함)
    const replayed = await w.hub.replay(w.hub.rewind(15), w.hub.settled);
    expect(replayed.map((d) => d.row.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    c.off();
  });
});
