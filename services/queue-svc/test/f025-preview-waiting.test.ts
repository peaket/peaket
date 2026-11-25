// F-02-5(OPS-300) queue-svc 사전 모의 센 값: 명령 3 키 waiting(대기 인원)을 읽기 전용 PreviewControl로 준다
// (ADR-0365 결정 11 표 'waiting = 대기열 발급 번호 q:{event:E}:seq − serving − 건너뛴 구간의 번호 수', 결정 16 꼴·'아무것도 쓰지 않는다').
// 계획 docs/review/plans/F-02-5.md 8.3의 이름 그대로: QueueWaitingReader { waiting(eventId) }, PreviewWaiting({ reader }).run({ eventId, keys }), QueueControlDeps.preview.
// 읽기 포트(QueueWaitingReader)는 Redis 어댑터 자리의 짝 가짜(implements)다. 진짜 Lua 한 번 읽기와 셈은 test-int/f025-preview-waiting.int.test.ts가 본다.
// 제어 포트 처리기는 saleSuspensionControlBinding(deps).handlers.PreviewControl을 그대로 부른다(sale-control-grpc.test.ts와 같은 꼴, proto 칸 이름 그대로).
// 시험 이름: C-T6 ①, 장부 밖 세부는 F025-PREVIEW(B21·B22).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { saleSuspensionControlBinding, type QueueControlDeps } from '../src/control/control-server.js';
import { PreviewWaiting, type QueueWaitingReader } from '../src/modules/entry/index.js';
import { MemorySaleSuspensionCopies, SetSaleSuspensionCopy } from '../src/modules/sale/index.js';

/** grpc 상태 코드(@grpc/grpc-js status 값, gRPC 정본 번호) */
const INVALID_ARGUMENT = 3;
const UNIMPLEMENTED = 12;
const MEASURED_AT = Date.parse('2026-12-05T11:03:07.418Z');
const NO_SOURCE = 'no-source';
const UNKNOWN_KEY = 'unknown-key';

/** 대기 인원 읽기 짝 가짜: 회차마다 정한 답을 주고, 불린 회차와 횟수를 남긴다 */
class FixedWaitingReader implements QueueWaitingReader {
  readonly asked: string[] = [];
  constructor(private readonly answers: ReadonlyMap<string, { waiting: number; measuredAtMs: number }>) {}
  async waiting(eventId: string): Promise<{ waiting: number; measuredAtMs: number } | undefined> {
    this.asked.push(eventId);
    return this.answers.get(eventId);
  }
}

const call = (handlers: Record<string, unknown>, request: Record<string, unknown>) =>
  new Promise<{ e: { code?: number; message?: string } | null; v?: Record<string, unknown> }>((resolve) => {
    const fn = handlers.PreviewControl as ((c: { request: Record<string, unknown> }, cb: (e: { code?: number; message?: string } | null, v?: Record<string, unknown>) => void) => void) | undefined;
    // 처리기가 없으면 gRPC 서버는 UNIMPLEMENTED로 답한다(@grpc/grpc-js 기본). 그 답을 그대로 흉내 낸다
    if (typeof fn !== 'function') return resolve({ e: { code: UNIMPLEMENTED, message: 'PreviewControl 처리기 없음' } });
    fn({ request }, (e, v) => resolve({ e, v }));
  });

function fixture(answers: ReadonlyMap<string, { waiting: number; measuredAtMs: number }>, o: { preview?: boolean } = {}) {
  const reader = new FixedWaitingReader(answers);
  const copies = new MemorySaleSuspensionCopies();
  const deps: QueueControlDeps = {
    setSuspension: new SetSaleSuspensionCopy(copies),
    podName: 'queue-svc-7',
    nowMs: () => MEASURED_AT + 60_000,
    ...(o.preview === false ? {} : { preview: new PreviewWaiting({ reader }) }),
  };
  return { reader, copies, handlers: saleSuspensionControlBinding(deps).handlers as Record<string, unknown> };
}

const tsMs = (t: unknown): number => {
  const at = t as { seconds?: number | string; nanos?: number };
  return Number(at.seconds) * 1000 + Math.floor((at.nanos ?? 0) / 1_000_000);
};

describe('C-T6 ① queue-svc PreviewWaiting 센 값 (B20)', () => {
  test('C-T6 ① waiting은 읽기 포트가 같은 슬롯에서 한 번에 센 대기 인원 그대로이고 measuredAtMs는 그 읽기 시각이다', async () => {
    const e = randomUUID();
    const reader = new FixedWaitingReader(new Map([[e, { waiting: 48_213, measuredAtMs: MEASURED_AT }]]));
    const r = await new PreviewWaiting({ reader }).run({ eventId: e, keys: ['waiting'] });
    expect(r.unavailable).toEqual([]);
    expect(r.counts).toHaveLength(1);
    expect(r.counts[0]).toMatchObject({ key: 'waiting', value: 48_213, measuredAtMs: MEASURED_AT });
    expect(r.counts[0]!.source).toMatch(/^[a-z][a-z0-9:_-]*$/);
    expect(reader.asked).toEqual([e]);
  });

  test('C-T6 ① 대기 인원 0은 센 값 0이다(읽기가 0을 셌을 때만)', async () => {
    const e = randomUUID();
    const r = await new PreviewWaiting({ reader: new FixedWaitingReader(new Map([[e, { waiting: 0, measuredAtMs: MEASURED_AT }]])) }).run({ eventId: e, keys: ['waiting'] });
    expect(r.counts.map((c) => [c.key, c.value])).toEqual([['waiting', 0]]);
  });
});

describe('F025-PREVIEW queue-svc 세지 못함 (B21)', () => {
  test('F025-PREVIEW ① 그 회차의 발급 원천이 없으면(읽기가 undefined) waiting은 no-source이고 0으로 적지 않는다', async () => {
    const r = await new PreviewWaiting({ reader: new FixedWaitingReader(new Map()) }).run({ eventId: randomUUID(), keys: ['waiting'] });
    expect(r.counts).toEqual([]);
    expect(r.unavailable).toEqual([{ key: 'waiting', reason: NO_SOURCE }]);
  });

  test('F025-PREVIEW ② queue-svc가 세지 않는 명령 3 키(purchase-svc 몫)와 모르는 글은 unknown-key이고, waiting은 그대로 센다', async () => {
    const e = randomUUID();
    const r = await new PreviewWaiting({ reader: new FixedWaitingReader(new Map([[e, { waiting: 911, measuredAtMs: MEASURED_AT }]])) }).run({
      eventId: e,
      keys: ['purchaseSessions', 'waiting', 'paymentSessions', 'currentTarget'],
    });
    expect(r.counts.map((c) => [c.key, c.value])).toEqual([['waiting', 911]]);
    expect([...r.unavailable].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'currentTarget', reason: UNKNOWN_KEY },
      { key: 'paymentSessions', reason: UNKNOWN_KEY },
      { key: 'purchaseSessions', reason: UNKNOWN_KEY },
    ]);
  });

  test('F025-PREVIEW ③ waiting을 묻지 않으면 읽기 포트를 부르지 않는다', async () => {
    const reader = new FixedWaitingReader(new Map());
    const r = await new PreviewWaiting({ reader }).run({ eventId: randomUUID(), keys: ['holdsPerSecond5m'] });
    expect(r).toEqual({ counts: [], unavailable: [{ key: 'holdsPerSecond5m', reason: UNKNOWN_KEY }] });
    expect(reader.asked).toEqual([]);
  });
});

describe('F025-PREVIEW queue-svc 제어 포트 PreviewControl 꼴 (B22)', () => {
  test('F025-PREVIEW ④ 처리기는 센 값(measured_at Timestamp)·파드 이름을 proto 칸으로 주고 판매 중지 사본은 쓰지 않는다', async () => {
    const e = randomUUID();
    const f = fixture(new Map([[e, { waiting: 1_234, measuredAtMs: MEASURED_AT }]]));
    const r = await call(f.handlers, { scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['waiting', 'paymentSessions'] });
    expect(r.e).toBeNull();
    expect(r.v?.pod_name).toBe('queue-svc-7');
    const counts = r.v?.counts as Record<string, unknown>[];
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ key: 'waiting', value: 1_234 });
    expect(tsMs(counts[0]!.measured_at)).toBe(MEASURED_AT);
    expect(r.v?.unavailable).toEqual([{ key: 'paymentSessions', reason: UNKNOWN_KEY }]);
    expect(f.copies.written.size).toBe(0);
  });

  test('F025-PREVIEW ⑤ 범위가 소문자 UUID가 아니면(대문자·PLATFORM·빈 글) INVALID_ARGUMENT이고 읽지 않는다', async () => {
    const f = fixture(new Map());
    for (const scope of [randomUUID().toUpperCase(), 'PLATFORM', '', 'abc']) {
      const r = await call(f.handlers, { scope, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['waiting'] });
      expect(r.e?.code, `scope=${scope}`).toBe(INVALID_ARGUMENT);
    }
    expect(f.reader.asked).toEqual([]);
  });

  test('F025-PREVIEW ⑥ keys 0개·17개는 INVALID_ARGUMENT, 16개(상한 정각)는 받는다', async () => {
    const e = randomUUID();
    const f = fixture(new Map([[e, { waiting: 5, measuredAtMs: MEASURED_AT }]]));
    expect((await call(f.handlers, { scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: [] })).e?.code).toBe(INVALID_ARGUMENT);
    const sixteen = ['waiting', ...Array.from({ length: 15 }, (_, i) => `x${i}`)];
    const ok = await call(f.handlers, { scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: sixteen });
    expect(ok.e).toBeNull();
    expect((ok.v?.counts as unknown[]).length + (ok.v?.unavailable as unknown[]).length).toBe(16);
    expect((await call(f.handlers, { scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: [...sixteen, 'x99'] })).e?.code).toBe(INVALID_ARGUMENT);
  });

  test('F025-PREVIEW ⑦ CONTROL_KIND_SALE_PAUSE가 아닌 종류와 사전 모의를 조립하지 않은 파드는 UNIMPLEMENTED다', async () => {
    const e = randomUUID();
    const f = fixture(new Map([[e, { waiting: 5, measuredAtMs: MEASURED_AT }]]));
    for (const kind of ['CONTROL_KIND_ADMISSION_TARGET', 'CONTROL_KIND_LOBBY_BANNER', 'CONTROL_KIND_SALE_SUSPENSION']) {
      expect((await call(f.handlers, { scope: e, kind, keys: ['waiting'] })).e?.code, `kind=${kind}`).toBe(UNIMPLEMENTED);
    }
    const bare = fixture(new Map([[e, { waiting: 5, measuredAtMs: MEASURED_AT }]]), { preview: false });
    expect((await call(bare.handlers, { scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['waiting'] })).e?.code).toBe(UNIMPLEMENTED);
  });
});
