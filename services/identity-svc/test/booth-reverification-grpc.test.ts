// F-05-12 O-T28 ① 부스 대조 gRPC 처리기(TR-05). 정본: docs/api/proto/peaket/identity/v1/identity.proto,
// docs/features/offline-gate.md §9.1 '서버 흐름', docs/review/plans/F-05-12.md §4 VerifyBoothReverification.
//
// 기존 identity 시험은 VerifyBoothReverification 클래스를 직접 불러 gRPC 처리기 등록·오류 매핑을 보지 않았다.
// 이 시험은 실제 grpc-js 서버에 ReverificationCheckService를 올려 VerifyBoothReverification을 부른다.
// 처리기 모듈·proto 메서드가 없으면 UNIMPLEMENTED/불러오기 실패로 떨어진다.
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { identityPackage } from '../src/modules/session/inbound/session.grpc.js';

interface Client {
  VerifyBoothReverification(req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res?: { ok?: boolean }) => void): void;
}
let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
let answer: (i: { token: string; accountId: string; ticketId: string }) => Promise<boolean>;
const errors: string[] = [];

beforeAll(async () => {
  const path = new URL('../src/modules/verification/inbound/booth-reverification.grpc.ts', import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ path)) as unknown as {
    boothReverificationHandlers: (d: { verify: { run(i: { token: string; accountId: string; ticketId: string }): Promise<boolean> } }, onError: (method: string, err: unknown) => void) => grpc.UntypedServiceImplementation;
  };
  expect(typeof mod.boothReverificationHandlers, `${path}의 boothReverificationHandlers가 없다`).toBe('function');
  const uc = { verify: { run: (i: { token: string; accountId: string; ticketId: string }) => answer(i) } };
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: identityPackage().ReverificationCheckService.service, handlers: mod.boothReverificationHandlers(uc, (method, err) => errors.push(`${method}:${String(err)}`)) }],
  });
  client = new (identityPackage().ReverificationCheckService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});
afterAll(async () => {
  await server?.close();
});

const call = (req: Record<string, unknown>): Promise<{ ok?: boolean }> =>
  new Promise((res, rej) => client.VerifyBoothReverification(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));

describe('O-T28 ① 부스 대조 gRPC 처리기', () => {
  test('O-T28 ① VerifyBoothReverification은 토큰·계정·티켓을 유스케이스에 그대로 넘기고 ok를 돌려준다', async () => {
    const seen: { token: string; accountId: string; ticketId: string }[] = [];
    answer = async (i) => {
      seen.push(i);
      return i.token === 'good-token';
    };
    expect(await call({ token: 'good-token', account_id: 'acct-1', ticket_id: 'ticket-1' })).toEqual({ ok: true });
    expect(seen).toEqual([{ token: 'good-token', accountId: 'acct-1', ticketId: 'ticket-1' }]);
    expect(await call({ token: 'bad-token', account_id: 'acct-1', ticket_id: 'ticket-1' })).toEqual({ ok: false });
  });

  test('O-T28 ① 저장소 장애는 UNAVAILABLE로 답하고, 처리기 오류 문구에 토큰·계정·티켓 값을 싣지 않는다', async () => {
    answer = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    await expect(call({ token: 'secret-token', account_id: 'acct-secret', ticket_id: 'ticket-secret' })).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    expect(errors.join('\n')).not.toContain('secret-token');
    expect(errors.join('\n')).not.toContain('acct-secret');
    expect(errors.join('\n')).not.toContain('ticket-secret');
  });
});
