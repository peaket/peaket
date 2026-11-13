// S-T16 ② 정상 요청 확인 p99 1ms 측정(임시 측정 하네스). 실제 Valkey에서 구매 세션 확인(HMGET)·요청 MAC·일련번호 올리기(Lua)를 포함한다.
// 결과는 .cache/bat090-s16.json에 남기고 docs/review/measurements/BAT-090-wave.md에 옮긴다. 시험 이름에는 S-T16 태그를 달지 않는다(장부 notes가 측정으로 잡는다).
import 'reflect-metadata';
import { createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHotRedis, fakeClock, type Principal, purchaseMac, purchaseMacInput, purchaseRequestKey, type HotRedis, verifyPurchaseRequest } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, test } from 'vitest';
import { RedisPurchaseSessionStore, MemoryPurchaseSessionStore, ServerEcdhKey, StoredPurchaseSessions } from '../src/modules/inventory/index.js';
import { openInput } from '../test/purchase-session-cases.js';
import { clientKeyOf } from '../test/session-fixtures.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.now();
const RUN = process.env.PEAKET_MEASURE === '1';
const JTI = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const LOGIN = 'ls-s16';
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000000bb';
const URL = `/v1/events/${EVENT}/holds`;
const PRINCIPAL: Principal = { accountId: ACCOUNT, sessionId: LOGIN, aud: 'fan', scopes: ['ticket:buy'] };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'ES256', typ: 'admission+jwt', kid: 'k1' })}.${b64({ jti: JTI })}.${Buffer.alloc(64, 1).toString('base64url')}`;

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

function request(seq: number, mac: string): FastifyRequest {
  return {
    method: 'POST',
    url: URL,
    raw: { url: URL },
    headers: { 'x-admission-token': TOKEN, 'x-purchase-seq': String(seq), 'x-purchase-mac': mac },
  } as unknown as FastifyRequest;
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1]! };
}

async function measure(n: number, call: (seq: number) => Promise<unknown>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await call(i + 1);
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return out;
}

test.skipIf(!RUN)('S16_ 구매 세션 확인 p99 1ms 측정(실제 Valkey, 5,000표본)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const server = new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'ecdh-s16' });
  const serverPub = createPublicKey({ key: server.publicJwk(), format: 'jwk' });
  const client = clientKeyOf();
  const key = purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: serverPub }), JTI);

  const store = new RedisPurchaseSessionStore(redis);
  const opened = await store.open(openInput({ now: () => NOW }, JTI, { accountId: ACCOUNT, loginSessionId: LOGIN, eventId: EVENT, clientKey: client.text }));
  if (opened.kind !== 'CREATED') throw new Error(`세션 열기 실패: ${opened.kind}`);
  const sessions = new StoredPurchaseSessions({ store, ecdh: server, clock: fakeClock({ now: NOW }) });

  const macOf = (seq: number) => purchaseMac(key, purchaseMacInput('POST', URL, seq, Buffer.alloc(0)));
  const over1ms = (xs: number[]) => xs.filter((x) => x > 1).length;
  // 예열(세션·JIT·연결)
  await measure(500, (seq) => verifyPurchaseRequest(request(seq, macOf(seq)), PRINCIPAL, sessions));
  const fullSamples = await measure(5_000, (seq) => verifyPurchaseRequest(request(seq, macOf(seq)), PRINCIPAL, sessions));
  const full = { ...stats(fullSamples), over1ms: over1ms(fullSamples) };

  // Redis만 뺀 실제 확인 경로(메모리 세션 + 서버 ECDH/HKDF + MAC + 일련번호)
  const memStore = new MemoryPurchaseSessionStore(fakeClock({ now: NOW }));
  const memOpened = await memStore.open(openInput({ now: () => NOW }, JTI, { accountId: ACCOUNT, loginSessionId: LOGIN, eventId: EVENT, clientKey: client.text }));
  if (memOpened.kind !== 'CREATED') throw new Error(`메모리 세션 열기 실패: ${memOpened.kind}`);
  const memSessions = new StoredPurchaseSessions({ store: memStore, ecdh: server, clock: fakeClock({ now: NOW }) });
  await measure(500, (seq) => verifyPurchaseRequest(request(seq, macOf(seq)), PRINCIPAL, memSessions));
  const memSamples = await measure(5_000, (seq) => verifyPurchaseRequest(request(seq, macOf(seq)), PRINCIPAL, memSessions));
  const mem = { ...stats(memSamples), over1ms: over1ms(memSamples) };

  // Redis·ECDH 없이 요청 확인(파싱·MAC·타이밍 비교)만
  const fake: import('@peaket/platform').PurchaseSessionPort = { resolve: async () => ({ ref: JTI, key }), advance: async () => true };
  await measure(2_000, (seq) => verifyPurchaseRequest(request(seq, macOf(seq)), PRINCIPAL, fake));
  const cpuSamples = await measure(20_000, (seq) => verifyPurchaseRequest(request(seq, macOf(seq)), PRINCIPAL, fake));
  const cpu = { ...stats(cpuSamples), over1ms: over1ms(cpuSamples) };

  const result = { measuredAt: new Date().toISOString(), condition: 'Valkey 8.1 로컬, 실제 구매 세션 HMGET+ECDH/HKDF+MAC+일련번호 Lua, 표본 5,000(예열 500)', full, mem, cpu };
  mkdirSync('../../.cache', { recursive: true });
  writeFileSync('../../.cache/bat090-s16.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log('S16_RESULT', JSON.stringify(result));
  // 1ms 목표는 판정만 하고 실패로 만들지 않는다(측정 창의 판정은 보고서가 한다)
  if (full.p99 > 1) console.log('S16_WARN p99 > 1ms');
});
