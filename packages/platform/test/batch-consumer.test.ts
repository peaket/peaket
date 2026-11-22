// 스트림 작업자 묶음 조각의 단위 시험(BAT-220 계획 §6 OPS-150 ①②③④⑥⑧, docs/streaming.md §2.4 표·'묶음 세부'·§2.6·§2.7).
// Kafka 없이 BatchPartition(가짜 시계)·dedupToken·retryDelayMs·커밋 위치·지표 이름을 본다. 실행기(runBatchWorker)의 커밋·다시 시도·동시 묶음·
// 재조정은 실제 Kafka로 test-int/batch-worker.int.test.ts가 본다(실행기는 Kafka 클라이언트를 주입받지 않는다).
// 단언 값은 정본에서 적는다: 표시 글 `<토픽>:<파티션>:<첫 오프셋>:<끝 오프셋>`(§2.4 '묶음 세부'), 지연 0.2초에서 두 배씩 30초에서 멈춤(같은 줄),
// 커밋 '끝 오프셋 + 1'(§2.4 표 아래 첫 줄), 지표 여섯의 이름·라벨(§2.7), 기본 동시 묶음 4개·재조정 기다림 10초(§2.4 표·'묶음 세부').
import { Registry } from '@prometheus-io/client';
import { describe, expect, test } from 'vitest';
import { BATCH_WORKER_DEFAULTS, BatchPartition, BatchWorkerMetrics, dedupToken, retryDelayMs, type BatchRecord, type RejectedPosition, type RejectReason } from '../src/batch-consumer.js';

const TOPIC = 'trade.orders';

/** 시험 시계: 생성자에 주입하는 단조 시계(ms) */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v), advance: (ms: number) => void (t += ms) };
}

const rec = (offset: string, value = Number(offset), partition = 3): BatchRecord<number> => ({ topic: TOPIC, partition, offset, timestamp: '1700000000000', value });
const rej = (offset: string, reason: RejectReason = 'DESERIALIZE', schemaId: number | null = null, partition = 3): RejectedPosition => ({ topic: TOPIC, partition, offset, kafkaTs: '1700000000001', schemaId, reason });

describe('OPS-150 ② 묶음 닫기', () => {
  test('OPS-150 ② 건수 한도 − 1은 닫지 않고 한도에 닿는 레코드에서 닫는다(시험 한도 3건, 거절 레코드도 센다)', () => {
    const c = clock();
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 3, maxWaitMs: 60_000, now: c.now });
    expect(p.push(rec('7'))).toBeUndefined();
    expect(p.push(rej('8'))).toBeUndefined();
    expect(p.size).toBe(2);
    const b = p.push(rec('9'));
    expect(b).toEqual({
      topic: TOPIC,
      partition: 3,
      firstOffset: '7',
      lastOffset: '9',
      dedupToken: 'trade.orders:3:7:9',
      records: [rec('7'), rec('9')],
      rejected: [rej('8')],
    });
    // 닫은 뒤에는 새 묶음이다
    expect(p.size).toBe(0);
    expect(p.poll()).toBeUndefined();
    expect(p.push(rec('10'))).toBeUndefined();
    expect(p.size).toBe(1);
  });

  test('OPS-150 ② 첫 레코드부터 시간 한도 − 1ms는 닫지 않고 한도에 닫는다(시험 한도 50ms, 가짜 시계). 끝 레코드가 아니라 첫 레코드부터 잰다', () => {
    const c = clock(5_000);
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 1_000, maxWaitMs: 50, now: c.now });
    expect(p.msUntilDue()).toBeUndefined();
    expect(p.poll()).toBeUndefined();
    p.push(rec('20'));
    expect(p.msUntilDue()).toBe(50);
    c.set(5_030);
    expect(p.push(rec('21'))).toBeUndefined();
    // 끝 레코드(5,030)부터 재면 아직 30ms가 남지만, 첫 레코드(5,000)부터 재므로 20ms가 남는다
    expect(p.msUntilDue()).toBe(20);
    c.set(5_049);
    expect(p.poll()).toBeUndefined();
    expect(p.msUntilDue()).toBe(1);
    c.set(5_050);
    expect(p.msUntilDue()).toBe(0);
    expect(p.poll()).toMatchObject({ firstOffset: '20', lastOffset: '21', dedupToken: 'trade.orders:3:20:21', records: [rec('20'), rec('21')], rejected: [] });
    expect(p.poll()).toBeUndefined();
  });

  test('OPS-150 ② 시간 한도가 지난 뒤 들어온 레코드는 그 레코드까지 넣고 바로 닫는다', () => {
    const c = clock();
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 1_000, maxWaitMs: 50, now: c.now });
    p.push(rec('1'));
    c.advance(51);
    expect(p.push(rec('2'))).toMatchObject({ firstOffset: '1', lastOffset: '2', records: [rec('1'), rec('2')] });
  });

  test('OPS-150 ② 다른 파티션 레코드와 앞 레코드보다 크지 않은 오프셋은 받지 않는다', () => {
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 10, maxWaitMs: 50, now: clock().now });
    expect(() => p.push(rec('1', 1, 4))).toThrow('다른 파티션');
    expect(() => p.push({ ...rec('1'), topic: 'trade.payments' })).toThrow('다른 파티션');
    p.push(rec('9'));
    expect(() => p.push(rec('9'))).toThrow('크지 않다');
    expect(() => p.push(rec('8'))).toThrow('크지 않다');
    // 글로 견주면 '10' < '9'라 여기서 던진다(자리가 바뀌는 오프셋)
    expect(p.push(rec('10'))).toBeUndefined();
    expect(p.size).toBe(2);
  });
});

describe('OPS-150 ③ 중복 거르기 표시', () => {
  test('OPS-150 ③ 표시 글은 `<토픽>:<파티션>:<첫 오프셋>:<끝 오프셋>` 10진수 한 줄이다', () => {
    expect(dedupToken('telemetry.queue', 11, '9', '10')).toBe('telemetry.queue:11:9:10');
    expect(dedupToken('trade.orders', 0, '0', '0')).toBe('trade.orders:0:0:0');
    for (const bad of ['-1', '1.5', '01', '', '1e3', ' 1']) expect(() => dedupToken(TOPIC, 0, bad, '5'), bad).toThrow(TypeError);
    expect(() => dedupToken(TOPIC, 0, '5', 'x')).toThrow(TypeError);
  });

  test('OPS-150 ③ 첫·끝 레코드가 거절 레코드여도 표시와 첫·끝 오프셋은 그 거절 레코드의 오프셋이다', () => {
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 3, maxWaitMs: 50, now: clock().now });
    p.push(rej('99', 'UNKNOWN_SCHEMA', 41));
    p.push(rec('100'));
    const b = p.push(rej('101', 'MISSING_FIELD', 7))!;
    expect(b.firstOffset).toBe('99');
    expect(b.lastOffset).toBe('101');
    expect(b.dedupToken).toBe('trade.orders:3:99:101');
    expect(b.records).toEqual([rec('100')]);
    expect(b.rejected).toEqual([rej('99', 'UNKNOWN_SCHEMA', 41), rej('101', 'MISSING_FIELD', 7)]);
  });

  test('OPS-150 ③ 2^53을 넘는 오프셋도 잃지 않는다(숫자로 바꾸면 9007199254740992와 …993이 같은 값이 된다)', () => {
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 2, maxWaitMs: 50, now: clock().now });
    p.push(rec('9007199254740992', 1));
    // Number로 견주면 두 값이 같아(9007199254740992) '크지 않다'로 던진다
    const b = p.push(rec('9007199254740993', 2))!;
    expect(b.firstOffset).toBe('9007199254740992');
    expect(b.lastOffset).toBe('9007199254740993');
    expect(b.dedupToken).toBe('trade.orders:3:9007199254740992:9007199254740993');
    expect(BatchPartition.commitOffset(b)).toBe('9007199254740994');
  });
});

describe('OPS-150 ① 커밋 위치', () => {
  test('OPS-150 ① 쓰기가 끝난 묶음의 커밋 위치는 끝 오프셋 + 1이다(9 → 10, 99 → 100, 끝이 거절 레코드여도)', () => {
    expect(BatchPartition.commitOffset({ lastOffset: '9' })).toBe('10');
    expect(BatchPartition.commitOffset({ lastOffset: '99' })).toBe('100');
    expect(BatchPartition.commitOffset({ lastOffset: '0' })).toBe('1');
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 2, maxWaitMs: 50, now: clock().now });
    p.push(rec('8'));
    expect(BatchPartition.commitOffset(p.push(rej('9'))!)).toBe('10');
    expect(() => BatchPartition.commitOffset({ lastOffset: '9.0' })).toThrow(TypeError);
  });
});

describe('OPS-150 ④ 다시 시도 지연', () => {
  test('OPS-150 ④ 지연은 0.2초에서 매번 두 배, 30초에서 멈춘다(정본 §2.4 묶음 세부)', () => {
    const delays = Array.from({ length: 12 }, (_, i) => retryDelayMs(i));
    expect(delays).toEqual([200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000, 30_000, 30_000]);
    // 몇 번을 실패해도 상한에 머물고 끝없이 커지거나 숫자가 넘치지 않는다
    for (const a of [50, 1_023, 1_024, 10_000, Number.MAX_SAFE_INTEGER]) expect(retryDelayMs(a), String(a)).toBe(30_000);
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => retryDelayMs(bad), String(bad)).toThrow(RangeError);
  });
});

describe('OPS-150 ⑥ 거절 기록', () => {
  test('OPS-150 ⑥ 모두 거절인 묶음은 레코드 없이 닫히고 거절 위치 셋(reason 세 값 각각)을 싣는다', () => {
    const p = new BatchPartition<number>({ topic: TOPIC, partition: 3, maxRecords: 3, maxWaitMs: 50, now: clock().now });
    p.push(rej('40', 'DESERIALIZE', null));
    p.push(rej('41', 'UNKNOWN_SCHEMA', 12));
    const b = p.push(rej('42', 'MISSING_FIELD', 13))!;
    expect(b.records).toEqual([]);
    expect(b.rejected.map((r) => r.reason)).toEqual(['DESERIALIZE', 'UNKNOWN_SCHEMA', 'MISSING_FIELD']);
    expect(b.dedupToken).toBe('trade.orders:3:40:42');
    // 거절 위치에는 위치·시각·스키마 ID·분류만 있다(원문 바이트·값 없음, streaming §2.4 '읽지 못한 레코드')
    for (const r of b.rejected) expect(Object.keys(r).sort()).toEqual(['kafkaTs', 'offset', 'partition', 'reason', 'schemaId', 'topic']);
  });
});

describe('OPS-150 ⑧ 지표', () => {
  test('OPS-150 ⑧ 지표 여섯의 이름·라벨이 정본 §2.7 그대로다', async () => {
    const r = new Registry();
    const m = BatchWorkerMetrics.for(r, 'ops-rt');
    // 같은 저장소면 같은 묶음을 준다(두 번 만들면 이름이 겹쳐 실패한다)
    expect(BatchWorkerMetrics.for(r, 'ops-rt')).toBe(m);
    m.consumerLag.set({ worker: 'ops-rt', topic: TOPIC, partition: '3' }, 17);
    m.insertSeconds.observe({ worker: 'ops-rt', table: 'rt.order_events' }, 0.2);
    m.insertRetries.inc({ worker: 'ops-rt' });
    m.rejected.inc({ worker: 'ops-rt', topic: TOPIC, reason: 'UNKNOWN_SCHEMA' });
    m.unrecognizedSymbols.inc({ worker: 'ops-rt', topic: TOPIC, record: 'peaket.trade.OrderEvent', field: 'type' });
    m.pausedPartitions.inc({ worker: 'ops-rt' });
    const json = await r.getMetricsAsJSON();
    const labelsOf = (name: string) => {
      const metric = json.find((x) => x.name === name);
      expect(metric, name).not.toBeUndefined();
      return [...new Set(metric!.values.flatMap((v) => Object.keys(v.labels).filter((k) => k !== 'le')))].sort();
    };
    expect(json.map((x) => x.name).sort()).toEqual([
      'stream_consumer_lag_records',
      'stream_insert_retries_total',
      'stream_insert_seconds',
      'stream_paused_partitions',
      'stream_rejected_total',
      'stream_unrecognized_symbol_total',
    ]);
    expect(labelsOf('stream_consumer_lag_records')).toEqual(['partition', 'topic', 'worker']);
    expect(labelsOf('stream_insert_seconds')).toEqual(['table', 'worker']);
    expect(labelsOf('stream_insert_retries_total')).toEqual(['worker']);
    expect(labelsOf('stream_rejected_total')).toEqual(['reason', 'topic', 'worker']);
    expect(labelsOf('stream_unrecognized_symbol_total')).toEqual(['field', 'record', 'topic', 'worker']);
    expect(labelsOf('stream_paused_partitions')).toEqual(['worker']);
    expect(json.find((x) => x.name === 'stream_consumer_lag_records')!.type).toBe('gauge');
    expect(json.find((x) => x.name === 'stream_paused_partitions')!.type).toBe('gauge');
    expect(json.find((x) => x.name === 'stream_insert_seconds')!.type).toBe('histogram');
    expect(json.find((x) => x.name === 'stream_rejected_total')!.type).toBe('counter');
  });

  test('OPS-150 ⑧ 작업자 기본값은 동시 묶음 4개, 재조정·종료 기다림 10초다(정본 §2.4)', () => {
    expect(BATCH_WORKER_DEFAULTS).toEqual({ maxInFlight: 4, drainTimeoutMs: 10_000 });
  });
});
