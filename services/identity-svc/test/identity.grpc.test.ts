// gRPC IdentityService.GetVerificationStatus 받는 층(docs/api/proto identity.proto, docs/features/identity.md §5 'pid 키 전환의 첫 구현', BUILD_ORDER BOT-025, I-T49 ①).
// 실제 grpc-js 서버를 루프백에 띄우고 계약 설명자로 만든 클라이언트로 부른다.
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { GetVerificationStatus } from '../src/modules/session/application/get-verification-status.js';
import { identityPackage, identityServiceHandlers } from '../src/modules/session/inbound/session.grpc.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { PidRotation } from '../src/modules/verification/application/pid-rotation.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, kit, newKey, noClosure, testAgency } from './support.js';

type Cb<T> = (e: grpc.ServiceError | null, v?: T) => void;
type Client = grpc.Client & { GetVerificationStatus(req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb<Record<string, unknown>>): void };

const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });
const verifications = new MemoryVerificationStore();
const sessions = new MemorySessionStore();
const claims = new VerificationClaims(verifications);
const errors: string[] = [];
let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
let k: Awaited<ReturnType<typeof kit>>;

beforeAll(async () => {
  k = await kit(sessions, { claims, clock });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: identityPackage().IdentityService.service, handlers: identityServiceHandlers({ status: new GetVerificationStatus(sessions, claims, clock) }, (m) => errors.push(m)) }],
  });
  client = new (identityPackage().IdentityService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});

afterAll(async () => {
  client?.close();
  await server?.close();
});

const call = (req: Record<string, unknown>) =>
  new Promise<Record<string, unknown>>((res, rej) => client.GetVerificationStatus(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return grpc.status[(e as grpc.ServiceError).code];
  }
};

describe('IdentityService(gRPC)', () => {
  test('I-T49①_GetVerificationStatus는_본인확인한계정의살아있는세션이면verified와pid를_전환중에는previous_pid도준다', async () => {
    const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'grpc-1', email: null, deviceId: null });
    const ids = { account_id: s.accountId, session_id: s.sessionId };
    expect(await call(ids)).toEqual({ verified: false, pid: '', previous_pid: '' });
    const provider = testAgency(clock);
    const st = await new StartVerification(verifications, provider, noClosure, clock).run({ accountId: s.accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    const h1 = new HmacIdentityHashers({ ciKeys: new Map([[1, Buffer.alloc(32, 1)]]), pidKey: Buffer.alloc(32, 41), pidVersion: 1 });
    await new ConfirmVerification(verifications, provider, h1, noClosure, clock).run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person: 'grpc-person' }) });
    const before = await call(ids);
    expect(before).toMatchObject({ verified: true, previous_pid: '' });
    const h2 = new HmacIdentityHashers({ ciKeys: new Map([[1, Buffer.alloc(32, 1)]]), pidKey: Buffer.alloc(32, 42), pidVersion: 2 });
    await new PidRotation(verifications, h2, clock).start({ until: clock.now() + 2 * 86_400_000 });
    const during = await call(ids);
    expect(during.verified).toBe(true);
    expect(during.previous_pid).toBe(before.pid);
    expect(during.pid).not.toBe(before.pid);
  });

  test('GetVerificationStatus는_ID모양이틀리면INVALID_ARGUMENT다', async () => {
    expect(await status(call({ account_id: 'x', session_id: 'y' }))).toBe('INVALID_ARGUMENT');
    expect(errors).toEqual([]);
  });
});
