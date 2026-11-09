// 통합 시험: 실제 Valkey(판정 피처 키)와 실제 gRPC로 ScoreRisk를 끝까지 돈다. 사람 확인 API는 로컬 흉내 서버다(실제 Cloudflare·실제 키를 쓰지 않는다).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { keys, RedisFeatureStore } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { LogVerdictRecorder } from '../src/modules/scoring/adapters/prom-trust-signals.js';
import { deviceRefsFromEnv } from '../src/modules/scoring/adapters/device-refs.js';
import { TurnstileHumanCheck } from '../src/modules/scoring/adapters/turnstile-human-check.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import { parseRuleSet } from '../src/modules/scoring/domain/rules.js';
import { trustPackage, trustServiceHandlers } from '../src/modules/scoring/inbound/trust.grpc.js';
import { recordingSignals, SYNTHETIC_RULES_JSON } from '../test/support.js';
import { startValkey } from './valkey.js';

const DAY = 86_400_000;
/** 시험 코드가 직접 부르는 명령은 긴 마감을 준다(부하가 몰려도 시험 자체가 깨지지 않게, 제품 코드의 100ms와 다르다) */
const slow = (key: string) => ({ key, deadlineMs: 5_000 });

type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
const clientPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })) as unknown as { peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } };

const deviceRef = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: Buffer.alloc(32, 9).toString('base64') }, systemClock).refs;
/** 형식에 맞는 기기 식별값(base64url 22자) */
const dev = (name: string) => `D${name.replace(/[^A-Za-z0-9]/g, '').padEnd(21, '0').slice(0, 21)}`;

let turnstile: Server;
let siteverifyCalls = 0;
let humanSuccess = true;
let turnstileUrl = '';

async function world(url: string) {
  const redis = await createHotRedis({ url });
  const pending: Promise<unknown>[] = [];
  const human = new TurnstileHumanCheck({ url: turnstileUrl, secret: 'test-secret-value', hostname: 'www.peaket.example' });
  const score = new ScoreRisk({
    rules: { current: () => parseRuleSet(SYNTHETIC_RULES_JSON), intensity: () => 'BASE' },
    human,
    features: new RedisFeatureStore(redis),
    devices: deviceRef,
    asn: { classify: () => 'OTHER' },
    recorder: new LogVerdictRecorder({ info: () => undefined }),
    behaviors: { behavior: () => undefined },
    signals: recordingSignals(),
    clock: systemClock,
    after: (w) => {
      pending.push(w());
    },
  });
  const srv = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: trustPackage().TrustService.service, handlers: trustServiceHandlers(score, () => undefined) }] });
  const client = new clientPkg.peaket.trust.v1.TrustService(`127.0.0.1:${srv.port}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { ScoreRisk: Unary };
  const call = (o: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      client.ScoreRisk(
        { context: 'SCORE_CONTEXT_PREVERIFY', lobby_shuffle: 'LOBBY_SHUFFLE_OFF', event_id: 'ev-1', pid: 'pid-1', device_id: dev('one'), human_check_token: 'tok', client: { ip: '198.51.100.7', user_agent: 'UA', asn: 64512 }, ...o },
        new grpc.Metadata(),
        { deadline: Date.now() + 800 },
        (e, v) => (e ? rej(e) : res(v ?? {})),
      );
    });
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };
  return {
    redis,
    call,
    settle,
    close: async () => {
      client.close();
      await srv.close();
      await redis.close();
    },
  };
}

const valkey = startValkey();
let w: Awaited<ReturnType<typeof world>>;

beforeAll(async () => {
  turnstile = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      siteverifyCalls += 1;
      res.setHeader('content-type', 'application/json');
      res.end(humanSuccess ? JSON.stringify({ success: true, hostname: 'www.peaket.example', action: 'preverify' }) : JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }));
    });
  });
  await new Promise<void>((r) => turnstile.listen(0, '127.0.0.1', r));
  turnstileUrl = `http://127.0.0.1:${(turnstile.address() as AddressInfo).port}/siteverify`;
  w = await world(valkey.url);
});

afterAll(async () => {
  await w?.close();
  await new Promise((r) => turnstile?.close(r));
  valkey.stop();
});

describe('ScoreRisk 통합', () => {
  test('B-T1_차단목록키가있는기기는CHALLENGE이고_사유는기기기록이다', async () => {
    const ref = deviceRef.ref(dev('block'))!;
    await w.redis.command(['SET', keys.block(ref), 'x', 'PX', '60000'], slow(keys.block(ref)));
    siteverifyCalls = 0;
    const r = await w.call({ device_id: dev('block') });
    expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY', degraded: false });
    expect(siteverifyCalls).toBe(1);
  });

  test('B-T1_허니팟키가있는사람은CHALLENGE이고_사유는화면조작모양이다', async () => {
    await w.redis.command(['SET', keys.honeypot('pid-hp'), 'x', 'PX', '60000'], slow(keys.honeypot('pid-hp')));
    const r = await w.call({ pid: 'pid-hp', device_id: dev('hp') });
    expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_INTERACTION' });
  });

  test('B-T14_CHALLENGE면기기이력과판정근거키가실제키에남고수명이있다_뒤의CHALLENGE는근거를덮지않는다', async () => {
    humanSuccess = false;
    const r = await w.call({ pid: 'pid-int-1', device_id: dev('two'), event_id: 'ev-int' });
    humanSuccess = true;
    expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_HUMAN_CHECK' });
    await w.settle();
    const ref = deviceRef.ref(dev('two'))!;
    const e = keys.evidence('pid-int-1', 'ev-int');
    const first = String(await w.redis.command(['GET', e], slow(e)));
    expect(JSON.parse(first)).toMatchObject({ reason: 'HUMAN_CHECK', hardSignal: 'NONE', deviceRef: ref, profileVersion: 7 });
    expect(Number(await w.redis.command(['PTTL', e], slow(e)))).toBeGreaterThan(0);
    // 같은 날 칸에 보냄 1
    const fields = (await w.redis.command(['HKEYS', keys.devHistory(ref)], slow(keys.devHistory(ref)))) as unknown[];
    expect(fields.map(String).some((f) => f.startsWith('sent:'))).toBe(true);
    expect(Number(await w.redis.command(['PTTL', keys.devHistory(ref)], slow(keys.devHistory(ref))))).toBeGreaterThan(0);
    // 뒤의 CHALLENGE(차단 목록)가 앞선 근거를 덮지 않는다
    await w.redis.command(['SET', keys.block(ref), 'x', 'PX', '60000'], slow(keys.block(ref)));
    await w.call({ pid: 'pid-int-1', device_id: dev('two'), event_id: 'ev-int' });
    await w.settle();
    expect(String(await w.redis.command(['GET', e], slow(e)))).toBe(first);
  });

  test('리뷰4_사람확인을통과한사람만tr:devacct에쌓이고_상한20을넘지않는다', async () => {
    humanSuccess = false;
    await w.call({ pid: 'pid-no', device_id: dev('nohuman') });
    await w.settle();
    humanSuccess = true;
    const noRef = deviceRef.ref(dev('nohuman'))!;
    expect(await w.redis.command(['ZCARD', keys.devAccounts(noRef)], slow(keys.devAccounts(noRef)))).toBe(0);
    const device = dev('many');
    for (let i = 0; i < 25; i++) {
      await w.call({ pid: `pid-many-${i}`, device_id: device });
      await w.settle();
    }
    const ref = deviceRef.ref(device)!;
    expect(await w.redis.command(['ZCARD', keys.devAccounts(ref)], slow(keys.devAccounts(ref)))).toBe(20);
    expect(Number(await w.redis.command(['PTTL', keys.devAccounts(ref)], slow(keys.devAccounts(ref))))).toBeGreaterThan(0);
  });

  test('리뷰4_pid의하루새기기상한은실제키로센다', async () => {
    for (let i = 0; i < 3; i++) {
      await w.call({ pid: 'pid-roam', device_id: dev(`roam${i}`) });
      await w.settle();
    }
    const n = async (i: number) => {
      const k = keys.devAccounts(deviceRef.ref(dev(`roam${i}`))!);
      return w.redis.command(['ZCARD', k], slow(k));
    };
    expect([await n(0), await n(1), await n(2)]).toEqual([1, 1, 0]);
  });

  test('리뷰5_지난30일이지난사람과날짜칸은세지않고_쓸때지운다', async () => {
    const store = new RedisFeatureStore(w.redis);
    const now = Date.now();
    const ref = 'k1.lifetime';
    const k = keys.devAccounts(ref);
    await w.redis.command(['ZADD', k, String(now - 31 * DAY), 'old-pid'], slow(k));
    await w.redis.command(['ZADD', k, String(now - 29 * DAY), 'kept-pid'], slow(k));
    const h = keys.devHistory(ref);
    const today = Math.floor(now / DAY);
    await w.redis.command(['HSET', h, `failed:${today - 31}`, '5', `failed:${today - 29}`, '2'], slow(h));
    const r = await store.read({ deviceRef: ref, pid: '', now });
    expect(r.accounts).toBe(1);
    expect(r.history).toEqual({ sent: 0, passed: 0, failed: 2 });
    await store.addAccount({ deviceRef: ref, pid: 'new-pid', now, newDevicesPerDay: 5 });
    await store.recordVerification({ deviceRef: ref, passed: false, now });
    expect((await w.redis.command(['ZRANGE', k, '0', '-1'], slow(k))) as unknown[]).not.toContain('old-pid');
    const hk = (await w.redis.command(['HKEYS', h], slow(h))) as unknown[];
    expect(hk.map(String)).not.toContain(`failed:${today - 31}`);
    expect(Number(await w.redis.command(['PTTL', k], slow(k)))).toBeGreaterThan(29 * DAY);
  });

  describe('재검토4 기기 집합 넣기', () => {
    const now = Date.now();
    const day = Math.floor(now / DAY);
    const add = (ref: string, pid: string, cap = 5) => new RedisFeatureStore(w.redis).addAccount({ deviceRef: ref, pid, now, newDevicesPerDay: cap });
    const quota = async (pid: string) => {
      const k = keys.newDevices(pid, day);
      return w.redis.command(['GET', k], slow(k));
    };

    test('재검토4_상한20이찬기기에새사람을넣으려하면몫을쓰지않는다', async () => {
      const ref = 'k1.full-device';
      const k = keys.devAccounts(ref);
      for (let i = 0; i < 20; i++) await w.redis.command(['ZADD', k, String(now), `member-${i}`], slow(k));
      await add(ref, 'pid-full');
      expect(await quota('pid-full')).toBeNull();
      expect(await w.redis.command(['ZSCORE', k, 'pid-full'], slow(k))).toBeNull();
    });

    test('재검토4_30일지난사람은새사람으로보고몫을쓴다', async () => {
      const ref = 'k1.stale-member';
      const k = keys.devAccounts(ref);
      await w.redis.command(['ZADD', k, String(now - 31 * DAY), 'pid-stale'], slow(k));
      await add(ref, 'pid-stale');
      expect(await quota('pid-stale')).toBe('1');
      expect(Number(await w.redis.command(['ZSCORE', k, 'pid-stale'], slow(k)))).toBe(now);
    });

    test('재검토4_30일안에본사람은몫을쓰지않고시각만고친다', async () => {
      const ref = 'k1.fresh-member';
      const k = keys.devAccounts(ref);
      await w.redis.command(['ZADD', k, String(now - DAY), 'pid-fresh'], slow(k));
      await add(ref, 'pid-fresh');
      expect(await quota('pid-fresh')).toBeNull();
      expect(Number(await w.redis.command(['ZSCORE', k, 'pid-fresh'], slow(k)))).toBe(now);
    });

    test('재검토4_몫이없으면넣지않는다', async () => {
      const ref = 'k1.no-quota';
      const k = keys.devAccounts(ref);
      await add(ref, 'pid-none', 0 + 1);
      await add('k1.no-quota-2', 'pid-none', 1);
      expect(await w.redis.command(['ZSCORE', keys.devAccounts('k1.no-quota-2'), 'pid-none'], slow(keys.devAccounts('k1.no-quota-2')))).toBeNull();
      expect(await w.redis.command(['ZSCORE', k, 'pid-none'], slow(k))).not.toBeNull();
    });
  });

  test('B-T16_기기가명은§3.2의식과같고_Redis키에원문이없다', async () => {
    await w.call({ pid: 'pid-int-ref', device_id: dev('ref') });
    await w.settle();
    const ref = deviceRef.ref(dev('ref'))!;
    expect(ref).toMatch(/^k1\.[A-Za-z0-9_-]{43}$/);
    expect(await w.redis.command(['EXISTS', keys.devAccounts(ref)], slow(keys.devAccounts(ref)))).toBe(1);
    expect(await w.redis.command(['EXISTS', `tr:devacct:{${dev('ref')}}`], slow(`tr:devacct:{${dev('ref')}}`))).toBe(0);
  });

  test('[Q-T40] 허니팟적중표시는_tr:hp에24시간쓰이고_다음사전검증의확정신호가된다', async () => {
    const pid = 'pid-honeypot';
    await new RedisFeatureStore(w.redis).recordHoneypot({ pid, eventId: 'ev-1', now: Date.now() });
    expect(await w.redis.command(['GET', keys.honeypot(pid)], slow(keys.honeypot(pid)))).toMatch(/"eventId":"ev-1"/);
    const ttl = Number(await w.redis.command(['PTTL', keys.honeypot(pid)], slow(keys.honeypot(pid))));
    expect(ttl).toBeGreaterThan(DAY - 60_000);
    expect(ttl).toBeLessThanOrEqual(DAY);
    await expect(w.call({ pid, device_id: dev('hp') })).resolves.toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_INTERACTION' });
  });

  test('[Q-T40] 허니팟회차기록은_pid당20개까지_한키안에서원자적으로세고_표시는상한과상관없이쓴다', async () => {
    const pid = 'pid-honeypot-cap';
    const store = new RedisFeatureStore(w.redis);
    const now = Date.now();
    const events = Array.from({ length: 30 }, (_, n) => `0190f3a1-7c2e-7a00-8000-${n.toString(16).padStart(12, '0')}`);
    const firsts = await Promise.all(events.map((eventId) => store.recordHoneypot({ pid, eventId, now })));
    expect(firsts.filter(Boolean)).toHaveLength(20);
    expect(await w.redis.command(['ZCARD', keys.honeypotEvents(pid)], slow(keys.honeypotEvents(pid)))).toBe(20);
    expect(await w.redis.command(['EXISTS', keys.honeypot(pid)], slow(keys.honeypot(pid)))).toBe(1);
    // 기록한 회차를 다시 불러도 처음이 아니고, 24시간이 지난 칸은 지워 다시 센다
    const recorded = events.find((_, i) => firsts[i])!;
    expect(await store.recordHoneypot({ pid, eventId: recorded, now })).toBe(false);
    expect(await store.recordHoneypot({ pid, eventId: recorded, now: now + DAY })).toBe(true);
    const ttl = Number(await w.redis.command(['PTTL', keys.honeypotEvents(pid)], slow(keys.honeypotEvents(pid))));
    expect(ttl).toBeGreaterThan(DAY - 60_000);
  });

  test('B-T6①_시험빈틈_실제Valkey를끊으면degraded가참이고_판정은계속한다', async () => {
    const second = startValkey();
    const x = await world(second.url);
    try {
      await expect(x.call({ device_id: dev('ok') })).resolves.toMatchObject({ verdict: 'VERDICT_ALLOW', degraded: false });
      second.stop();
      await expect(x.call({ device_id: dev('ok') })).resolves.toMatchObject({ verdict: 'VERDICT_ALLOW', degraded: true });
      // 기기 식별값이 없어도 실패가 숨지 않는다
      await expect(x.call({ device_id: '' })).resolves.toMatchObject({ degraded: true });
    } finally {
      second.stop();
      await x.close();
    }
  });
});
