// 텔레메트리 보내기 버퍼(docs/streaming.md §2.6 '생산자(텔레메트리)', ADR-0141 결정 6, ADR-0249 결정 4).
// 요청 처리를 막지 않는다: offer는 기다리지 않고 던지지 않으며, 버퍼가 차거나 보내기에 실패한 기록은 버리고 센다.
import { describe, expect, test } from 'vitest';
import { kafkaTelemetrySend, TelemetrySink, telemetryKafkaFromEnv, type TelemetryProducer } from '../src/telemetry-sink.js';

interface Sent {
  topic: string;
  keys: (string | null)[];
}

function recorder(o: { fail?: () => boolean } = {}) {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (topic: string, messages: { key: string | null; value: Buffer }[]) => {
      if (o.fail?.()) throw new Error('브로커에 닿지 못함');
      sent.push({ topic, keys: messages.map((m) => m.key) });
    },
  };
}

const value = Buffer.from('{}');
const message = { key: 'a', value };

describe('TelemetrySink', () => {
  test('[ASVS v5.0.0-16.3.4] 버퍼가_차면_새기록을버리고_기록별로센다(요청을막지않는다)', async () => {
    const drops: [string, number][] = [];
    const r = recorder();
    const sink = new TelemetrySink({ send: r.send, capacity: 2, batchSize: 10, lingerMs: 60_000, onDropped: (record, n) => drops.push([record, n]) });
    sink.offer('TrustVerdict', 't', { key: 'a', value });
    sink.offer('TrustVerdict', 't', { key: 'b', value });
    // 찼다: 던지지 않고 버린다
    expect(() => sink.offer('BehaviorSignal', 't', { key: 'c', value })).not.toThrow();
    expect(drops).toEqual([['BehaviorSignal', 1]]);
    await sink.close(1000);
    expect(r.sent).toEqual([{ topic: 't', keys: ['a', 'b'] }]);
  });

  test('묶음크기만큼씩_토픽끼리_차례대로보낸다', async () => {
    const r = recorder();
    const sink = new TelemetrySink({ send: r.send, capacity: 100, batchSize: 2, lingerMs: 60_000 });
    for (const k of ['a', 'b', 'c']) sink.offer('TrustVerdict', 'verdicts', { key: k, value });
    sink.offer('BehaviorSignal', 'behavior', { key: 'd', value });
    await sink.close(1000);
    expect(r.sent).toEqual([
      { topic: 'verdicts', keys: ['a', 'b'] },
      { topic: 'verdicts', keys: ['c'] },
      { topic: 'behavior', keys: ['d'] },
    ]);
  });

  test('토픽이번갈아와도_한묶음안에서토픽별로모아보낸다(묶음이1건으로쪼개지지않는다)', async () => {
    const sizes: number[] = [];
    const sink = new TelemetrySink({
      send: async (_t, m) => {
        sizes.push(m.length);
      },
      batchSize: 500,
      lingerMs: 60_000,
    });
    for (let i = 0; i < 500; i++) {
      sink.offer('TrustVerdict', 'verdicts', { key: null, value });
      sink.offer('BehaviorSignal', 'behavior', { key: 'p', value });
    }
    await sink.close(5000);
    expect(sizes).toEqual([250, 250, 250, 250]);
  });

  test('한토픽의순서는_번갈아넣어도그대로다', async () => {
    const r = recorder();
    const sink = new TelemetrySink({ send: r.send, batchSize: 10, lingerMs: 60_000 });
    for (const [t, k] of [['a', '1'], ['b', '2'], ['a', '3'], ['b', '4']] as const) sink.offer('R', t, { key: k, value });
    await sink.close(1000);
    expect(r.sent).toEqual([
      { topic: 'a', keys: ['1', '3'] },
      { topic: 'b', keys: ['2', '4'] },
    ]);
  });

  test('[ASVS v5.0.0-16.3.4] 보내기에실패하면_그묶음을버리고세고_다음묶음을이어보낸다', async () => {
    const drops: [string, number][] = [];
    let failing = true;
    const r = recorder({ fail: () => failing });
    const sink = new TelemetrySink({ send: r.send, capacity: 100, batchSize: 1, lingerMs: 60_000, onDropped: (record, n) => drops.push([record, n]) });
    sink.offer('TrustVerdict', 't', { key: 'a', value });
    await sink.flush();
    expect(drops).toEqual([['TrustVerdict', 1]]);
    failing = false;
    sink.offer('TrustVerdict', 't', { key: 'b', value });
    await sink.close(1000);
    expect(r.sent).toEqual([{ topic: 't', keys: ['b'] }]);
  });

  test('닫은뒤의기록은_버리고센다', async () => {
    const drops: [string, number][] = [];
    const r = recorder();
    const sink = new TelemetrySink({ send: r.send, lingerMs: 60_000, onDropped: (record, n) => drops.push([record, n]) });
    await sink.close(1000);
    sink.offer('TrustVerdict', 't', { key: 'a', value });
    expect(drops).toEqual([['TrustVerdict', 1]]);
    expect(r.sent).toEqual([]);
  });

  test('닫을때_시간안에보내지못한기록은_보내는중인묶음까지버린수에넣는다(종료를붙들지않는다)', async () => {
    const drops: [string, number][] = [];
    const sink = new TelemetrySink({ send: () => new Promise<void>(() => undefined), capacity: 10, batchSize: 1, lingerMs: 60_000, onDropped: (record, n) => drops.push([record, n]) });
    sink.offer('TrustVerdict', 't', { key: 'a', value });
    sink.offer('TrustVerdict', 't', { key: 'b', value });
    await sink.close(20);
    expect(drops.reduce((a, [, n]) => a + n, 0)).toBe(2);
  });

  test('닫은뒤에끝난보내기가_실패해도_버린수를두번세지않는다', async () => {
    const drops: [string, number][] = [];
    let reject: (e: Error) => void = () => undefined;
    const sink = new TelemetrySink({ send: () => new Promise<void>((_res, rej) => (reject = rej)), batchSize: 1, lingerMs: 60_000, onDropped: (record, n) => drops.push([record, n]) });
    sink.offer('TrustVerdict', 't', { key: 'a', value });
    void sink.flush();
    await sink.close(10);
    reject(new Error('늦은 실패'));
    await new Promise((res) => setImmediate(res));
    expect(drops).toEqual([['TrustVerdict', 1]]);
  });

  test('머무름시간이지나면_저절로보낸다', async () => {
    const r = recorder();
    const sink = new TelemetrySink({ send: r.send, lingerMs: 1 });
    sink.offer('TrustVerdict', 't', { key: 'a', value });
    await new Promise((res) => setTimeout(res, 30));
    expect(r.sent).toHaveLength(1);
    await sink.close(1000);
  });
});

function fakeProducer(o: Partial<Record<'connect' | 'send' | 'disconnect', () => Promise<unknown>>> = {}) {
  const calls: string[] = [];
  const p: TelemetryProducer & { calls: string[] } = {
    calls,
    connect: () => {
      calls.push('connect');
      return o.connect?.() ?? Promise.resolve();
    },
    send: () => {
      calls.push('send');
      return o.send?.() ?? Promise.resolve();
    },
    disconnect: () => {
      calls.push('disconnect');
      return o.disconnect?.() ?? Promise.resolve();
    },
  };
  return p;
}

const never = () => new Promise<void>(() => undefined);
const fails = () => Promise.reject(new Error('연결 실패'));
const noRetryWait = { retryAfterMs: 0 };

describe('kafkaTelemetrySend', () => {
  test('연결에실패하면_다음보내기는새생산자로연결한다(실제클라이언트는같은객체로다시연결하지못한다)', async () => {
    const made = [fakeProducer({ connect: fails }), fakeProducer()];
    let i = 0;
    const send = kafkaTelemetrySend(() => made[i++]!, noRetryWait);
    await expect(send('t', [message])).rejects.toThrow('연결 실패');
    await send('t', [message]);
    await send('t', [message]);
    expect(i).toBe(2);
    expect(made[0]!.calls).toEqual(['connect', 'disconnect']);
    expect(made[1]!.calls).toEqual(['connect', 'send', 'send']);
  });

  test('연결이시간상한을넘으면_실패로끝내고_다음은새생산자다', async () => {
    const made = [fakeProducer({ connect: never }), fakeProducer()];
    let i = 0;
    const send = kafkaTelemetrySend(() => made[i++]!, { connectTimeoutMs: 10, retryAfterMs: 0 });
    const t0 = Date.now();
    await expect(send('t', [message])).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    await send('t', [message]);
    expect(i).toBe(2);
  });

  test('보내기가시간상한을넘으면_실패로끝내고_같은생산자를쓴다', async () => {
    let hang = true;
    const p = fakeProducer({ send: () => (hang ? never() : Promise.resolve()) });
    let made = 0;
    const send = kafkaTelemetrySend(
      () => {
        made += 1;
        return p;
      },
      { sendTimeoutMs: 10, retryAfterMs: 0 },
    );
    await expect(send('t', [message])).rejects.toThrow();
    hang = false;
    await send('t', [message]);
    expect(made).toBe(1);
  });

  test('실패뒤에는_정해진시간동안공장을부르지않고바로실패한다(버퍼비우기가멈추지않는다)', async () => {
    let now = 1000;
    let made = 0;
    const send = kafkaTelemetrySend(
      () => {
        made += 1;
        return fakeProducer({ connect: fails });
      },
      { retryAfterMs: 5000, now: () => now },
    );
    await expect(send('t', [message])).rejects.toThrow();
    await expect(send('t', [message])).rejects.toThrow();
    expect(made).toBe(1);
    now += 5000;
    await expect(send('t', [message])).rejects.toThrow();
    expect(made).toBe(2);
  });

  test('끊을때는_지금생산자를_시간상한안에서끊는다', async () => {
    const made = [fakeProducer({ connect: fails }), fakeProducer({ disconnect: never })];
    let i = 0;
    const send = kafkaTelemetrySend(() => made[i++]!, noRetryWait);
    await expect(send('t', [message])).rejects.toThrow();
    await send('t', [message]);
    const t0 = Date.now();
    await send.disconnect(20);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(made[1]!.calls).toContain('disconnect');
  });

  test('연결전에끊어도_던지지않는다', async () => {
    const send = kafkaTelemetrySend(() => fakeProducer());
    await expect(send.disconnect(10)).resolves.toBeUndefined();
  });
});

describe('telemetryKafkaFromEnv', () => {
  test('주소가없으면_어느환경이든시작을막지않고_경고와함께끈다', () => {
    for (const PEAKET_ENV of ['local', 'ci', 'demo', 'staging', 'prod', undefined]) {
      expect(telemetryKafkaFromEnv('trust-svc', { ...(PEAKET_ENV ? { PEAKET_ENV } : {}) })).toMatchObject({ enabled: false, warning: expect.any(String) });
    }
  });

  test('주소가있으면_켜지고_틀린조각은끄고_몇번째인지만알린다', () => {
    expect(telemetryKafkaFromEnv('trust-svc', { PEAKET_ENV: 'ci', PEAKET_TELEMETRY_KAFKA_BROKERS: 'a:9092, b:9093' })).toMatchObject({ enabled: true, brokers: ['a:9092', 'b:9093'], env: 'ci' });
    const bad = telemetryKafkaFromEnv('trust-svc', { PEAKET_ENV: 'prod', PEAKET_TELEMETRY_KAFKA_BROKERS: 'a:9092,비밀값' });
    expect(bad).toMatchObject({ enabled: false });
    expect((bad as { warning: string }).warning).toMatch(/2번째/);
    expect((bad as { warning: string }).warning).not.toContain('비밀값');
  });

  test('인증설정이틀려도_시작을막지않고_끈다', () => {
    const r = telemetryKafkaFromEnv('trust-svc', { PEAKET_ENV: 'prod', PEAKET_TELEMETRY_KAFKA_BROKERS: 'a:9092', PEAKET_KAFKA_AUTH: '모르는값' });
    expect(r).toMatchObject({ enabled: false, warning: expect.any(String) });
    expect((r as { warning: string }).warning).not.toContain('모르는값');
  });
});
