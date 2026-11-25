// GAT-260 후속: core-svc gRPC AccountMergeCheckService가 실제 포트로 답하는지 시험한다(시험 먼저, IR-04).
// 정상(찜 수)·없는 계정(0)·오류(INTERNAL)와 종료 차례(닫은 뒤 UNAVAILABLE, 두 번 닫아도 같음)를 본다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { WishLifecycle } from '../src/modules/catalog/application/wish-lifecycle.js';
import { accountMergeCheckHandlers, corePackage } from '../src/modules/catalog/inbound/account-merge-check.grpc.js';
import { startGrpcServer } from '../src/grpc-server.js';

type Message = Record<string, unknown>;
type Cb = (e: grpc.ServiceError | null, v?: Message) => void;
type Unary = (req: Message, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb) => void;
type Client = grpc.Client & { CheckAccountMerge: Unary };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

/** 실제 gRPC 포트에 처리기를 올리고 클라이언트를 돌려준다 */
async function serve(lifecycle: Pick<WishLifecycle, 'absorbedWishes'> = new WishLifecycle(new MemoryCatalogRepository())) {
  const errors: [string, unknown][] = [];
  const handlers = accountMergeCheckHandlers({ wishes: lifecycle }, (method, err) => errors.push([method, err]));
  const server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: corePackage().AccountMergeCheckService.service, handlers }],
  });
  const client = new (corePackage().AccountMergeCheckService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  closers.push(async () => {
    client.close();
    await server.close();
  });
  const call = (req: Message) => new Promise<Message>((res, rej) => client.CheckAccountMerge(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
  return { server, client, call, errors };
}

const failureOf = async (p: Promise<unknown>): Promise<{ code: string; details: string }> => {
  try {
    await p;
  } catch (e) {
    const err = e as grpc.ServiceError;
    return { code: grpc.status[err.code]!, details: err.details };
  }
  return { code: 'OK', details: '' };
};

describe('core-svc AccountMergeCheckService', () => {
  test('GAT-260 흡수 계정의 찜 수를 absorbed_wishes로 답하고 나머지 개수는 0이다', async () => {
    const repo = new MemoryCatalogRepository();
    const absorbed = randomUUID();
    const primary = randomUUID();
    repo.wishes.set(absorbed, new Map([['p1', new Date()], ['p2', new Date()]]));
    repo.wishes.set(primary, new Map([['p3', new Date()]]));
    const s = await serve(new WishLifecycle(repo));

    const r = await s.call({ primary_account_id: primary, absorbed_account_id: absorbed });
    expect(r).toEqual({ blocks: [], absorbed_wishes: 2, absorbed_subscriptions: 0, absorbed_addresses: 0 });
    // 계정 ID는 대소문자를 가리지 않는다
    expect((await s.call({ primary_account_id: primary.toUpperCase(), absorbed_account_id: absorbed.toUpperCase() })).absorbed_wishes).toBe(2);
  });

  test('GAT-260 없는 계정은 0건이고 빈 계정 ID는 INVALID_ARGUMENT다', async () => {
    const s = await serve();
    const r = await s.call({ primary_account_id: randomUUID(), absorbed_account_id: randomUUID() });
    expect(r).toMatchObject({ absorbed_wishes: 0 });
    expect(await failureOf(s.call({ primary_account_id: randomUUID(), absorbed_account_id: '' }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await failureOf(s.call({ absorbed_account_id: randomUUID() }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  test('GAT-260 닫기를 불러도 처리 중인 호출은 마치고 그 뒤 새 호출은 받지 않는다', async () => {
    let release: (() => void) | undefined;
    let started!: () => void;
    const handled = new Promise<void>((res) => (started = res));
    const s = await serve({
      absorbedWishes: () => new Promise<number>((res) => {
        release = () => res(4);
        started();
      }),
    });
    const inFlight = s.call({ primary_account_id: randomUUID(), absorbed_account_id: randomUUID() });
    await handled;
    // 처리기가 답하기 전에 닫기를 부른다. 플랫폼의 close는 처리 중인 호출을 기다린다(10초 [가정])
    const closing = s.server.close();
    release!();
    expect(await inFlight).toMatchObject({ absorbed_wishes: 4 });
    await closing;
    expect(await failureOf(s.call({ primary_account_id: randomUUID(), absorbed_account_id: randomUUID() }))).toMatchObject({ code: 'UNAVAILABLE' });
  });

  test('GAT-260 원천이 실패하면 INTERNAL로 닫고 오류를 남기며, 닫은 뒤 호출은 UNAVAILABLE이고 두 번 닫아도 같다', async () => {
    const boom = new Error('DB 끊김');
    const s = await serve({ absorbedWishes: async () => Promise.reject(boom) });
    expect(await failureOf(s.call({ primary_account_id: randomUUID(), absorbed_account_id: randomUUID() }))).toMatchObject({ code: 'INTERNAL' });
    expect(s.errors).toEqual([['CheckAccountMerge', boom]]);

    const other = await serve();
    await other.server.close();
    expect(await failureOf(other.call({ primary_account_id: randomUUID(), absorbed_account_id: randomUUID() }))).toMatchObject({ code: 'UNAVAILABLE' });
    await expect(other.server.close()).resolves.toBeUndefined();
  });
});
