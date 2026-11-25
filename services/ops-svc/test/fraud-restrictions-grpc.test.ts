// F-04-13 구현 재리뷰 IR-32: 이용 제한 gRPC 어댑터가 identity·queue·purchase 응답을 fail-closed로 읽는지 본다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity, purchaseV1Account, queueV1Queue } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcFraudRestrictions } from '../src/modules/investigations/index.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Def = Parameters<typeof protoLoader.fromJSON>[0];
const pkgOf = (def: Def, group: 'identity' | 'queue' | 'purchase') => (grpc.loadPackageDefinition(protoLoader.fromJSON(def, LOAD)) as any).peaket[group].v1;

const identityPkg = pkgOf(identityV1Identity, 'identity');
const queuePkg = pkgOf(queueV1Queue, 'queue');
const purchasePkg = pkgOf(purchaseV1Account, 'purchase');

let identity: grpc.Server;
let queue: grpc.Server;
let purchase: grpc.Server;
let identityAddr = '';
let queueAddr = '';
let purchaseAddr = '';
const calls = { identity: [] as any[], queue: [] as any[], purchase: [] as any[] };
let identityResult = 'RESTRICTED_CI_HOLD_RESULT_OK';
let queueChanged = true;
let purchaseChanged = true;

beforeAll(async () => {
  identity = new grpc.Server();
  identity.addService(identityPkg.RestrictedCiHoldService.service, {
    SetRestrictedCiHold: (call: any, cb: any) => {
      calls.identity.push(call.request);
      cb(null, { result: identityResult });
    },
  });
  queue = new grpc.Server();
  queue.addService(queuePkg.BookingRestrictionService.service, {
    SetBookingRestriction: (call: any, cb: any) => {
      calls.queue.push(call.request);
      cb(null, { changed: queueChanged });
    },
  });
  purchase = new grpc.Server();
  purchase.addService(purchasePkg.BookingRestrictionService.service, {
    SetBookingRestriction: (call: any, cb: any) => {
      calls.purchase.push(call.request);
      cb(null, { changed: purchaseChanged });
    },
  });
  identityAddr = `127.0.0.1:${await bind(identity)}`;
  queueAddr = `127.0.0.1:${await bind(queue)}`;
  purchaseAddr = `127.0.0.1:${await bind(purchase)}`;
});

afterAll(async () => {
  await Promise.all([stop(identity), stop(queue), stop(purchase)]);
});

const bind = (server: grpc.Server): Promise<number> =>
  new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, port) => (e ? reject(e) : (server.start(), resolve(port)))));
const stop = (server: grpc.Server): Promise<void> => new Promise((resolve) => server.tryShutdown(() => resolve()));

const adapter = () => new GrpcFraudRestrictions({ identityAddress: identityAddr, queueAddress: queueAddr, purchaseAddress: purchaseAddr });

describe('IR-32 GrpcFraudRestrictions 응답 처리', () => {
  test('identity NO_VERIFICATION·STALE은 실패로 닫고 queue·purchase를 부르지 않는다', async () => {
    for (const result of ['RESTRICTED_CI_HOLD_RESULT_NO_VERIFICATION', 'RESTRICTED_CI_HOLD_RESULT_STALE']) {
      identityResult = result;
      calls.identity.length = 0;
      calls.queue.length = 0;
      calls.purchase.length = 0;
      const c = adapter();
      await expect(c.identity.restrict({ accountId: '0194b240-0000-7000-8000-000000000011', caseId: '0194b240-0000-7000-8000-000000000012', version: 1, untilMs: 1_800_000_000_000 })).rejects.toThrow();
      expect(calls.identity).toHaveLength(1);
      expect(calls.queue).toHaveLength(0);
      expect(calls.purchase).toHaveLength(0);
      c.close();
    }
  });

  test('IR-40 queue·purchase의 changed=false는 같은 판 재시도의 멱등 성공이다', async () => {
    identityResult = 'RESTRICTED_CI_HOLD_RESULT_OK';
    const c = adapter();
    queueChanged = false;
    await expect(c.queue.set({ accountId: '0194b240-0000-7000-8000-000000000013', caseId: '0194b240-0000-7000-8000-000000000014', restrictionId: '0194b240-0000-7000-8000-000000000015', state: 'ACTIVE', version: 1, untilMs: 1_800_000_000_000 })).resolves.toBeUndefined();
    queueChanged = true;
    purchaseChanged = false;
    await expect(c.purchase.set({ accountId: '0194b240-0000-7000-8000-000000000013', caseId: '0194b240-0000-7000-8000-000000000014', restrictionId: '0194b240-0000-7000-8000-000000000015', state: 'ACTIVE', version: 1, untilMs: 1_800_000_000_000 })).resolves.toBeUndefined();
    purchaseChanged = true;
    await expect(c.queue.set({ accountId: '0194b240-0000-7000-8000-000000000013', caseId: '0194b240-0000-7000-8000-000000000014', restrictionId: '0194b240-0000-7000-8000-000000000015', state: 'ACTIVE', version: 1, untilMs: 1_800_000_000_000 })).resolves.toBeUndefined();
    c.close();
  });
});
