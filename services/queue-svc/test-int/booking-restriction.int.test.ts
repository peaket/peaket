// Q-T59 예매 제한 사본 쓰기 경로 실제 Valkey·gRPC 통합 시험(BAT-465 잔여 2차, GAT-310).
// queue.proto BookingRestrictionService가 q:rst:{account}에 판 번호가 클 때만 st·until·rid·ver를 쓰는지 본다.
import * as grpc from '@grpc/grpc-js';
import { randomUUID } from 'node:crypto';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { queuePackage } from '../src/grpc-package.js';
import { startGrpcServer } from '../src/grpc-server.js';
import { bookingRestrictionHandlers, RedisBookingRestrictions } from '../src/modules/admission/index.js';
import { bookingRestrictionKeyOf } from '../src/modules/admission/domain/booking-restriction.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

type Unary = (req: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type Client = grpc.Client & Record<'SetBookingRestriction', Unary>;

let valkey: ValkeyContainer;
let redis: HotRedis;
let store: RedisBookingRestrictions;
let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;

const A = randomUUID();
const UNTIL = 1_793_761_199_200;

const call = (req: object): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => client.SetBookingRestriction(req, new grpc.Metadata(), {}, (e, v) => (e ? reject(e) : resolve(v ?? {}))));
const fields = (accountId: string): Promise<unknown[]> =>
  redis.command(['HMGET', bookingRestrictionKeyOf(accountId), 'st', 'until', 'rid', 'ver'], { key: bookingRestrictionKeyOf(accountId) }) as Promise<unknown[]>;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisBookingRestrictions(redis);
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: queuePackage().BookingRestrictionService.service, handlers: bookingRestrictionHandlers({ apply: (i) => store.apply(i) }, () => undefined) }],
  });
  client = new (queuePackage().BookingRestrictionService as unknown as new (address: string, credentials: grpc.ChannelCredentials) => Client)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure());
});

afterAll(async () => {
  client?.close();
  await server?.close();
  await redis?.close();
  valkey?.stop();
});

describe('Q-T59 queue-svc SetBookingRestriction 실제 Valkey', () => {
  test('판 번호가 클 때만 q:rst를 바꾸고 같은 판·옛 판은 changed false다', async () => {
    expect(await store.apply({ accountId: A, restrictionId: 'r1', state: 'ACTIVE', untilMs: UNTIL, version: 1 })).toEqual({ changed: true });
    expect(await fields(A)).toEqual(['ACTIVE', String(UNTIL), 'r1', '1']);
    expect(await store.read(A)).toEqual({ st: 'ACTIVE', untilMs: UNTIL, rid: 'r1', ver: 1 });

    expect(await store.apply({ accountId: A, restrictionId: 'r1', state: 'LIFTED', version: 1 })).toEqual({ changed: false });
    expect(await store.read(A)).toMatchObject({ st: 'ACTIVE', untilMs: UNTIL, ver: 1 });

    expect(await store.apply({ accountId: A, restrictionId: 'r1', state: 'LIFTED', version: 2 })).toEqual({ changed: true });
    const lifted = await store.read(A);
    expect(lifted).toEqual({ st: 'LIFTED', rid: 'r1', ver: 2 });
    expect(lifted).not.toHaveProperty('untilMs');
    expect(await fields(A)).toEqual(['LIFTED', null, 'r1', '2']);
  });

  test('끝 시각이 없는 ACTIVE로 올리면 until 칸을 지우고, 옛 판은 되돌리지 못한다', async () => {
    const b = randomUUID();
    expect(await store.apply({ accountId: b, restrictionId: 'r2', state: 'ACTIVE', untilMs: UNTIL, version: 1 })).toEqual({ changed: true });
    expect(await store.apply({ accountId: b, restrictionId: 'r2', state: 'ACTIVE', version: 2 })).toEqual({ changed: true });
    const row = await store.read(b);
    expect(row).toEqual({ st: 'ACTIVE', rid: 'r2', ver: 2 });
    expect(await fields(b)).toEqual(['ACTIVE', null, 'r2', '2']);

    expect(await store.apply({ accountId: b, restrictionId: 'r2', state: 'ACTIVE', untilMs: UNTIL, version: 1 })).toEqual({ changed: false });
    expect(await store.read(b)).toEqual({ st: 'ACTIVE', rid: 'r2', ver: 2 });
  });

  test('gRPC SetBookingRestriction이 proto 칸을 읽어 실제 q:rst에 쓴다', async () => {
    const c = randomUUID();
    const ends = { seconds: 1_793_761_199, nanos: 200_000_000 };
    expect(await call({ account_id: c, restriction_id: 'r3', state: 'BOOKING_RESTRICTION_STATE_ACTIVE', ends_at: ends, version: 10 })).toEqual({ changed: true });
    expect(await store.read(c)).toEqual({ st: 'ACTIVE', untilMs: UNTIL, rid: 'r3', ver: 10 });
    expect(await call({ account_id: c, restriction_id: 'r3', state: 'BOOKING_RESTRICTION_STATE_LIFTED', version: 10 })).toEqual({ changed: false });
    expect(await call({ account_id: c, restriction_id: 'r3', state: 'BOOKING_RESTRICTION_STATE_LIFTED', version: 11 })).toEqual({ changed: true });
    expect(await store.read(c)).toEqual({ st: 'LIFTED', rid: 'r3', ver: 11 });
  });

  test('모양이 틀린 gRPC 요청은 INVALID_ARGUMENT이고 저장소를 바꾸지 않는다', async () => {
    const d = randomUUID();
    await expect(call({ account_id: d, restriction_id: 'r4', state: 'BOOKING_RESTRICTION_STATE_ACTIVE', version: 0 })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    await expect(call({ account_id: d, restriction_id: 'r4', state: 'BOOKING_RESTRICTION_STATE_UNSPECIFIED', version: 1 })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    await expect(call({ account_id: 'not-a-uuid', restriction_id: 'r4', state: 'BOOKING_RESTRICTION_STATE_ACTIVE', version: 1 })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    await expect(call({ account_id: d, restriction_id: '', state: 'BOOKING_RESTRICTION_STATE_ACTIVE', version: 1 })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    expect(await store.read(d)).toBeUndefined();
  });
});
