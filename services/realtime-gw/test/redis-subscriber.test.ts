// 좌석 Redis 구독기 단위 시험(BAT-052 리뷰 반영 RF-T2·RF-T3, 지적 CON-01·CON-02·CON-08·CON-09·COR-05·CON-12).
// 바깥 경계는 RedisChannelSubscriber.forClient(가짜 Pub/Sub 클라이언트)다(새 이음새, 리뷰 반영 계획 RF-I2: sSubscribe·sUnsubscribe·ping·on('ready'|'error'|'end')·destroy).
// 정본: ADR-0297 결정 1, docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '좌석 Redis 구독'(원하는 상태는 구독기 하나가 든다, 같은 채널의 명령은
// 한 번에 하나씩, 실패 뒤의 실제 상태는 '모름'이라 원하는 쪽 명령을 0.2초부터 두 배씩 상한 5초 [가정]로 다시 보냄, 다시 붙은 뒤 다시 맞추기가 실패해도 같은 고리,
// 어긋난 채널 수 realtime_gw_subscribe_mismatch), §12 S-T42 ⑰, docs/data.md §5 이 묶음 행.
// 단언 값은 정본에서 적고 구현 상수를 가져오지 않는다. 시간은 Vitest 가짜 타이머(setTimeout·Date·performance)로 민다.
// 시험이 기댄 이음새: forClient(client, options), options.onMismatch(어긋난 채널 수)·onUp(붙음). 구독기의 subscribe·unsubscribe는 거절하지 않는다.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RedisChannelSubscriber, type PubSubClient } from '../src/modules/stream/index.js';

/** 정본 값(ADR-0297 결정 1, seat-hold §7 '좌석 Redis 구독') */
const SPEC = { firstRetryMs: 200, maxRetryMs: 5_000 } as const;

type Op = 'sSubscribe' | 'sUnsubscribe';

interface Call {
  op: Op;
  channel: string;
  at: number;
  /** 거절했으면 오류 이름 */
  error?: string;
}

/** node-redis 클라이언트와 같은 모양의 가짜. 채널마다 다음 n번을 실패시킬 수 있고, 끊긴 동안에는 명령을 거절한다 */
class FakePubSub extends EventEmitter {
  readonly calls: Call[] = [];
  readonly subs = new Map<string, (message: string, channel: string) => void>();
  /** `${op} ${channel}` → 남은 실패 수와 오류 */
  readonly failures = new Map<string, { left: number; error: () => Error }>();
  down = false;
  destroyed = false;
  pings = 0;

  failNext(op: Op, channel: string, times: number, error: () => Error = () => new Error('ERR fake')): void {
    this.failures.set(`${op} ${channel}`, { left: times, error });
  }

  #run(op: Op, channels: string | string[], ok: (ch: string) => void): Promise<void> {
    const channel = Array.isArray(channels) ? channels[0]! : channels;
    const call: Call = { op, channel, at: Date.now() };
    this.calls.push(call);
    if (this.down) {
      const err = new Error('The client is closed');
      err.name = 'ClientClosedError';
      call.error = err.name;
      return Promise.reject(err);
    }
    const f = this.failures.get(`${op} ${channel}`);
    if (f && f.left > 0) {
      f.left--;
      const err = f.error();
      call.error = err.name + ':' + err.message;
      return Promise.reject(err);
    }
    ok(channel);
    return Promise.resolve();
  }

  sSubscribe(channels: string | string[], listener: (message: string, channel: string) => void): Promise<void> {
    return this.#run('sSubscribe', channels, (ch) => this.subs.set(ch, listener));
  }

  sUnsubscribe(channels?: string | string[]): Promise<void> {
    return this.#run('sUnsubscribe', channels ?? '', (ch) => this.subs.delete(ch));
  }

  ping(): Promise<string> {
    this.pings++;
    return this.down ? Promise.reject(new Error('The client is closed')) : Promise.resolve('PONG');
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  quit(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** 서버가 그 채널에 보낸 메시지 하나(구독하지 않았으면 false) */
  deliver(channel: string, message: string): boolean {
    const l = this.subs.get(channel);
    if (!l) return false;
    l(message, channel);
    return true;
  }

  of(channel: string): Call[] {
    return this.calls.filter((c) => c.channel === channel);
  }
}

interface Rig {
  fake: FakePubSub;
  sub: RedisChannelSubscriber;
  mismatch: number[];
  up: boolean[];
}

async function rig(): Promise<Rig> {
  const fake = new FakePubSub();
  const mismatch: number[] = [];
  const up: boolean[] = [];
  const sub = await RedisChannelSubscriber.forClient(fake as unknown as PubSubClient, {
    onUp: (u: boolean) => up.push(u),
    onError: () => {},
    onMismatch: (n: number) => mismatch.push(n),
  });
  // 붙은 클라이언트로 본다(이미 붙어 있다고 보는 구현이면 다시 맞출 것이 없어 아무 일도 없다)
  fake.emit('ready');
  await vi.advanceTimersByTimeAsync(0);
  return { fake, sub, mismatch, up };
}

const lastOf = (calls: Call[]): Call | undefined => calls.at(-1);

let current: Rig | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'], now: Date.parse('2026-11-19T01:00:00.037Z') });
});

afterEach(async () => {
  if (current) {
    void current.sub.close();
    await vi.advanceTimersByTimeAsync(3_000);
    current = undefined;
  }
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('S-T42 ⑰ 구독기가 원하는 상태의 유일한 주인(ADR-0297 결정 1)', () => {
  test('S-T42 ⑰ subscribe·unsubscribe는 원하는 상태를 적고 곧 돌려주며, 밑의 명령이 실패해도 거절하지 않는다', async () => {
    const r = (current = await rig());
    r.fake.failNext('sSubscribe', 'c0', 1);
    await expect(r.sub.subscribe('c0', () => {})).resolves.toBeUndefined();
    r.fake.failNext('sUnsubscribe', 'c0', 1);
    await expect(r.sub.unsubscribe('c0')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
  });

  test('S-T42 ⑰ 붙은 채 sUnsubscribe가 한 번 실패한 뒤 다시 원하면 sSubscribe를 다시 보낸다(실패 뒤 실제 상태는 모름): 마지막 명령이 sSubscribe이고 메시지가 새 함수로 온다', async () => {
    const r = (current = await rig());
    const first: string[] = [];
    const second: string[] = [];
    r.sub.subscribe('c1', (m) => first.push(m));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.fake.of('c1').map((c) => c.op)).toEqual(['sSubscribe']);
    r.fake.failNext('sUnsubscribe', 'c1', 1);
    r.sub.unsubscribe('c1');
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOf(r.fake.of('c1'))).toMatchObject({ op: 'sUnsubscribe', error: expect.any(String) });
    // 실패한 해제 뒤 다시 원한다: 실제를 '구독 중'으로 보지 않고 sSubscribe를 꼭 보낸다
    r.sub.subscribe('c1', (m) => second.push(m));
    await vi.advanceTimersByTimeAsync(SPEC.maxRetryMs * 2);
    const calls = r.fake.of('c1');
    const failedAt = calls.findIndex((c) => c.op === 'sUnsubscribe' && c.error);
    expect(calls.slice(failedAt + 1).some((c) => c.op === 'sSubscribe' && !c.error)).toBe(true);
    expect(lastOf(calls)).toMatchObject({ op: 'sSubscribe' });
    expect(lastOf(calls)!.error).toBeUndefined();
    expect(r.fake.deliver('c1', 'm-after')).toBe(true);
    expect(second).toEqual(['m-after']);
    // 맞춘 뒤에는 더 보내지 않는다
    const n = r.fake.calls.length;
    await vi.advanceTimersByTimeAsync(SPEC.maxRetryMs * 4);
    expect(r.fake.calls).toHaveLength(n);
    expect(r.mismatch.at(-1)).toBe(0);
  });

  test('S-T42 ⑰ 붙은 채 sSubscribe가 실패한 뒤 원하지 않게 되면 sUnsubscribe를 보낸다(아무도 없는 채널의 구독이 남지 않는다)', async () => {
    const r = (current = await rig());
    r.fake.failNext('sSubscribe', 'c2', 1);
    r.sub.subscribe('c2', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(r.fake.of('c2')).toMatchObject([{ op: 'sSubscribe', error: expect.any(String) }]);
    r.sub.unsubscribe('c2');
    await vi.advanceTimersByTimeAsync(SPEC.maxRetryMs * 2);
    const calls = r.fake.of('c2');
    expect(lastOf(calls)).toMatchObject({ op: 'sUnsubscribe' });
    expect(lastOf(calls)!.error).toBeUndefined();
    expect(r.fake.subs.has('c2')).toBe(false);
    const n = r.fake.calls.length;
    await vi.advanceTimersByTimeAsync(SPEC.maxRetryMs * 4);
    expect(r.fake.calls).toHaveLength(n);
    expect(r.mismatch.at(-1)).toBe(0);
  });

  test('S-T42 ⑰ 다시 보내는 간격은 0.2초에서 두 배씩 늘고 5초에서 멈춘다(200·400·800·1,600·3,200·5,000·5,000ms). 실패 동안 realtime_gw_subscribe_mismatch는 1이고 맞춘 뒤 0이다', async () => {
    const r = (current = await rig());
    r.fake.failNext('sSubscribe', 'c3', 7);
    r.sub.subscribe('c3', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(r.mismatch.at(-1)).toBe(1);
    // 다 실패하고 여덟째에 맞는다: 200 + 400 + 800 + 1,600 + 3,200 + 5,000 + 5,000 = 16,200ms
    for (let i = 0; i < 17; i++) await vi.advanceTimersByTimeAsync(1_000);
    const attempts = r.fake.of('c3').filter((c) => c.op === 'sSubscribe');
    expect(attempts).toHaveLength(8);
    expect(attempts.slice(0, 7).every((c) => c.error)).toBe(true);
    expect(attempts[7]!.error).toBeUndefined();
    const gaps = attempts.slice(1).map((c, i) => c.at - attempts[i]!.at);
    expect(gaps).toEqual([200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
    // 실패 동안은 1, 맞춘 뒤 0
    const from = r.mismatch.indexOf(1);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(r.mismatch.slice(from, -1).every((v) => v === 1)).toBe(true);
    expect(r.mismatch.at(-1)).toBe(0);
    // 맞춘 뒤에는 더 보내지 않는다
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.fake.of('c3').filter((c) => c.op === 'sSubscribe')).toHaveLength(8);
  });

  test('S-T42 ⑰ 어긋난 채널 수는 채널마다 센다: 둘이 실패하면 2, 하나가 맞으면 1, 둘 다 맞으면 0', async () => {
    const r = (current = await rig());
    r.fake.failNext('sSubscribe', 'ca', 1);
    r.fake.failNext('sSubscribe', 'cb', 3);
    r.sub.subscribe('ca', () => {});
    r.sub.subscribe('cb', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(r.mismatch.at(-1)).toBe(2);
    // ca는 200ms 뒤 맞고, cb는 200 + 400 + 800ms 뒤 맞는다
    await vi.advanceTimersByTimeAsync(SPEC.firstRetryMs);
    expect(r.mismatch.at(-1)).toBe(1);
    await vi.advanceTimersByTimeAsync(400 + 800);
    expect(r.mismatch.at(-1)).toBe(0);
  });
});

describe('S-T42 ⑰ 다시 붙은 뒤 다시 맞추기(ADR-0297 결정 1, CON-02)', () => {
  test('S-T42 ⑰ 끊긴 동안 받은 구독은 다시 붙은(ready) 뒤 보내고, 그 sSubscribe가 한 번 TRYAGAIN으로 거절되면 물러선 뒤(0.2초 이상) 다시 보내 맞춘다', async () => {
    const r = (current = await rig());
    r.sub.subscribe('c4', () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOf(r.fake.of('c4'))).toMatchObject({ op: 'sSubscribe' });
    // 끊긴다
    r.fake.down = true;
    r.fake.emit('end');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.up.at(-1)).toBe(false);
    const got: string[] = [];
    await expect(r.sub.subscribe('c5', (m) => got.push(m))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_000);
    // 다시 붙는다. 다시 맞추기의 첫 sSubscribe('c5')는 TRYAGAIN으로 거절된다
    r.fake.down = false;
    r.fake.failNext('sSubscribe', 'c5', 1, () => new Error('TRYAGAIN Multiple keys request during rehashing of slot'));
    const readyAt = Date.now();
    r.fake.emit('ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.up.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(SPEC.maxRetryMs * 2);
    const after = r.fake.of('c5').filter((c) => c.at >= readyAt);
    const tryAgain = after.findIndex((c) => c.op === 'sSubscribe' && c.error?.includes('TRYAGAIN'));
    expect(tryAgain).toBeGreaterThanOrEqual(0);
    const retry = after.slice(tryAgain + 1).find((c) => c.op === 'sSubscribe' && !c.error);
    expect(retry).toBeDefined();
    expect(retry!.at - after[tryAgain]!.at).toBeGreaterThanOrEqual(SPEC.firstRetryMs);
    expect(r.fake.deliver('c5', 'm5')).toBe(true);
    expect(got).toEqual(['m5']);
    expect(r.mismatch.at(-1)).toBe(0);
  });

  test('S-T42 ⑰ 끊긴 동안 뺀 구독은 다시 붙은 뒤 원하지 않는 상태로 맞춘다(그 채널의 마지막 명령이 성공한 sUnsubscribe이거나, 다시 구독하지 않는다)', async () => {
    const r = (current = await rig());
    const got: string[] = [];
    r.sub.subscribe('c6', (m) => got.push(m));
    await vi.advanceTimersByTimeAsync(0);
    r.fake.down = true;
    r.fake.emit('end');
    await vi.advanceTimersByTimeAsync(0);
    r.sub.unsubscribe('c6');
    await vi.advanceTimersByTimeAsync(2_000);
    r.fake.down = false;
    const readyAt = Date.now();
    r.fake.emit('ready');
    await vi.advanceTimersByTimeAsync(SPEC.maxRetryMs * 2);
    const after = r.fake.of('c6').filter((c) => c.at >= readyAt && !c.error);
    // 다시 구독하지 않았거나, 했다면 그 뒤에 해제했다
    if (after.length > 0) expect(lastOf(after)).toMatchObject({ op: 'sUnsubscribe' });
    // 원하지 않는 채널의 메시지는 받은 쪽으로 가지 않는다
    r.fake.deliver('c6', 'late');
    expect(got).toEqual([]);
    expect(r.mismatch.at(-1) ?? 0).toBe(0);
  });
});
