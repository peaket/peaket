// PriorityGrantService gRPC 시험(queue.proto, BUILD_ORDER GAT-135). 실제 gRPC 서버·클라이언트로 요청 모양과 오류 코드를 본다.
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { queuePackage } from '../src/grpc-package.js';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryPriorityGrantStore } from '../src/modules/admission/adapters/memory-priority-grants.js';
import { SetPriorityGrant } from '../src/modules/admission/application/set-priority-grant.js';
import { priorityGrantHandlers } from '../src/modules/admission/inbound/priority-grant.grpc.js';
import type { PriorityGrantStore } from '../src/modules/admission/domain/ports.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, newEvent } from './support.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const clock = fakeClock({ now: NOW });
const memory = new MemoryPriorityGrantStore();
let down = false;
const store: PriorityGrantStore = {
  set: (i) => (down ? Promise.reject(new QueueStoreUnavailable(new Error('down'))) : memory.set(i)),
  get: (i) => memory.get(i),
};
const errors: string[] = [];
let server: { port: number; close(): Promise<void> };
type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
let client: grpc.Client & { SetPriorityGrant: Unary };

beforeAll(async () => {
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: queuePackage().PriorityGrantService.service,
        handlers: priorityGrantHandlers(new SetPriorityGrant(store, clock), (m) => void errors.push(m)),
      },
    ],
  });
  const Client = queuePackage().PriorityGrantService as unknown as new (address: string, credentials: grpc.ChannelCredentials) => typeof client;
  client = new Client(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure());
});

afterAll(async () => {
  client?.close();
  await server?.close();
});

const call = (r: object) => new Promise<Record<string, unknown>>((res, rej) => client.SetPriorityGrant(r, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v ?? {}))));
const statusOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: grpc.ServiceError) => e.code,
  );

const request = (over: Record<string, unknown> = {}) => {
  const exp = NOW + 48 * 3600_000;
  return {
    account_id: ACCOUNT,
    event_id: newEvent(),
    grant_id: crypto.randomUUID(),
    state: 'PRIORITY_GRANT_STATE_OFFERED',
    expires_at: { seconds: Math.floor(exp / 1000), nanos: (exp % 1000) * 1_000_000 },
    version: 1,
    ...over,
  };
};

describe('PriorityGrantService [GAT-135]', () => {
  test('OFFERED 사본을 쓰고 같은 판은 changed=false, 높은 판은 반영한다', async () => {
    const r = request();
    expect(await call(r)).toEqual({ changed: true });
    expect(await call(r)).toEqual({ changed: false });
    expect(await call({ ...r, state: 'PRIORITY_GRANT_STATE_WITHDRAWN', version: 2 })).toEqual({ changed: true });
    expect((await memory.get({ accountId: ACCOUNT, eventId: r.event_id, grantId: r.grant_id }))?.state).toBe('WITHDRAWN');
  });

  test('모르는 상태·틀린 권리 ID는 INVALID_ARGUMENT이고, 저장소 장애는 UNAVAILABLE이다', async () => {
    expect(await statusOf(call(request({ state: 'PRIORITY_GRANT_STATE_UNSPECIFIED' })))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await statusOf(call(request({ grant_id: 'not-a-uuid' })))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await statusOf(call(request({ account_id: '' })))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await statusOf(call(request({ expires_at: undefined })))).toBe(grpc.status.INVALID_ARGUMENT);
    down = true;
    expect(await statusOf(call(request()))).toBe(grpc.status.UNAVAILABLE);
    down = false;
  });
});
