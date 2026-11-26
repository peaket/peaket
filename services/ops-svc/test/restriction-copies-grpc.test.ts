// F-06-4 보내는 쪽 사본 시험(Q-T59 ①~⑤). 받는 쪽(queue-svc·purchase-svc·core-svc)은 proto 설명자로 세운 실제 gRPC 서버다.
// 시험 리뷰 TR-06·TR-25 반영: core 화면용 사본의 토큰·호출자·ends_at, 같은 판 changed:false를 성공으로 보는 엔진, 상태를 가진 사본의 재전송.
// 정본: docs/features/queue-admission.md §6, docs/api/proto/peaket/{queue,purchase,core}/v1/*.proto, docs/data.md §3 q:rst·s:rst·sup:rst.
// 받는 쪽 집행(입장 확정 403·주문 403)은 queue·purchase의 기존 시험(services/queue-svc/test*/booking-restriction*, services/purchase-svc/test*/booking-restrict*)이 본다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { startGrpcServer, type StartedGrpcServer } from '@peaket/platform';
import { coreV1Core, purchaseV1Account, queueV1Queue } from '@peaket/contracts/proto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { approvedRestriction, nextYear, NOW_MS, restrictionHarness, type RestrictionCopiesPort, type RestrictionHarness } from './restriction-support.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Def = Parameters<typeof protoLoader.fromJSON>[0];
type Ctor = grpc.ServiceClientConstructor;
const queuePkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(queueV1Queue as Def, LOAD)) as unknown as { peaket: { queue: { v1: { BookingRestrictionService: Ctor } } } }).peaket.queue.v1;
const purchasePkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(purchaseV1Account as Def, LOAD)) as unknown as { peaket: { purchase: { v1: { BookingRestrictionService: Ctor } } } }).peaket.purchase.v1;
const corePkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(coreV1Core as Def, LOAD)) as unknown as { peaket: { core: { v1: { BookingRestrictionViewService: Ctor } } } }).peaket.core.v1;

const TOKEN = 'restriction-internal-token-000000';
const CALLER = 'ops-svc';
interface Seen {
  readonly method: string;
  readonly request: Record<string, unknown>;
  readonly md: Record<string, string>;
}
const seen: Seen[] = [];
const answer = { changed: true };

function handlers(method: string, guard: { caller: boolean }): grpc.UntypedServiceImplementation {
  const h: grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>> = (call, cb) => {
    const md: Record<string, string> = {};
    for (const [k, v] of Object.entries(call.metadata.getMap())) md[k] = String(v);
    seen.push({ method, request: call.request, md });
    if (md['x-peaket-internal-token'] !== TOKEN) return cb({ code: grpc.status.PERMISSION_DENIED, details: 'token' });
    if (guard.caller && md['x-peaket-caller'] !== CALLER) return cb({ code: grpc.status.PERMISSION_DENIED, details: 'caller' });
    cb(null, { ...answer });
  };
  return { [method]: h };
}

let servers: StartedGrpcServer[] = [];
let queueUrl = '';
let purchaseUrl = '';
let coreUrl = '';
let h: RestrictionHarness | undefined;
let grpcCopies: RestrictionCopiesPort | undefined;

beforeAll(async () => {
  const start = async (services: Array<{ definition: grpc.ServiceDefinition; handlers: grpc.UntypedServiceImplementation }>) => {
    const s = await startGrpcServer({ host: '127.0.0.1', port: 0, profile: 'service', drainMs: 0, services });
    servers.push(s);
    return `127.0.0.1:${s.port}`;
  };
  queueUrl = await start([{ definition: queuePkg.BookingRestrictionService!.service, handlers: handlers('SetBookingRestriction', { caller: false }) }]);
  purchaseUrl = await start([{ definition: purchasePkg.BookingRestrictionService!.service, handlers: handlers('SetBookingRestriction', { caller: false }) }]);
  coreUrl = await start([{ definition: corePkg.BookingRestrictionViewService!.service, handlers: handlers('SetBookingRestrictionView', { caller: true }) }]);
});
beforeEach(() => {
  seen.length = 0;
  answer.changed = true;
});
afterEach(async () => {
  await h?.close();
  h = undefined;
});
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

interface CopiesModule {
  grpcRestrictionCopies(o: { queueUrl: string; purchaseUrl: string; coreUrl: string; token: string }): RestrictionCopiesPort;
}
async function loadCopies(): Promise<CopiesModule> {
  const spec = '../src/modules/restrictions/adapters/grpc-restriction-copies.js';
  try {
    return (await import(/* @vite-ignore */ spec)) as CopiesModule;
  } catch (err) {
    if (err instanceof Error && /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|Does the file exist/i.test(err.message)) {
      throw new Error('src/modules/restrictions/adapters/grpc-restriction-copies.ts가 없다(계획 §3)');
    }
    throw err;
  }
}

/** 각 시험이 새 앱을 세운다. 사본 어댑터가 없으면 여기서 그 시험만 실패한다(파일 전체를 건너뛰지 않는다) */
async function setup(o: { copies?: RestrictionCopiesPort; token?: string } = {}): Promise<RestrictionHarness> {
  if (!grpcCopies) {
    const mod = await loadCopies();
    grpcCopies = mod.grpcRestrictionCopies({ queueUrl, purchaseUrl, coreUrl, token: TOKEN });
  }
  const copies = o.copies ?? (o.token ? (await loadCopies()).grpcRestrictionCopies({ queueUrl, purchaseUrl, coreUrl, token: o.token }) : grpcCopies);
  h = await restrictionHarness({ copies });
  return h;
}

const ts = (v: unknown): number => {
  const o = v as { seconds?: number; nanos?: number };
  return Number(o.seconds) * 1000 + Math.floor(Number(o.nanos ?? 0) / 1_000_000);
};

describe('Q-T59 보내는 쪽 사본', () => {
  test('Q-T59 ① ACTIVE 사본 다섯 값(계정·제한 ID·상태·끝·판)이 queue·purchase에 닿고 view에 사유·시작·소명 기한·호출자·토큰이 실린다', async () => {
    const app = await setup();
    const r = await approvedRestriction(app, { accountId: '0194f064-0000-7000-8000-000000000001', endsAtMs: Date.parse('2027-02-03T10:00:00.000Z') });
    expect(seen.map((s) => s.method)).toEqual(['SetBookingRestriction', 'SetBookingRestriction', 'SetBookingRestrictionView']);
    const [q, p, v] = seen;
    for (const s of [q!, p!]) {
      expect(s.request).toMatchObject({ account_id: r.accountId, restriction_id: r.restrictionId, state: 'BOOKING_RESTRICTION_STATE_ACTIVE', version: r.version });
      expect(ts(s.request.ends_at)).toBe(Date.parse('2027-02-03T10:00:00.000Z'));
      expect(s.md['x-peaket-internal-token']).toBe(TOKEN);
    }
    expect(v!.request).toMatchObject({ account_id: r.accountId, restriction_id: r.restrictionId, state: 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE', reason_code: 'ABUSE_CANCEL', version: r.version });
    expect(ts(v!.request.starts_at)).toBe(NOW_MS);
    expect(ts(v!.request.ends_at)).toBe(Date.parse('2027-02-03T10:00:00.000Z'));
    expect(ts(v!.request.appeal_due_at)).toBe(NOW_MS + 86_400_000);
    expect(v!.md['x-peaket-internal-token']).toBe(TOKEN);
    expect(v!.md['x-peaket-caller']).toBe(CALLER);
  });

  test('Q-T59 ② 같은 판을 다시 보내면 받는 쪽이 changed:false로 답하고, 엔진은 그 답을 성공으로 보아 승인을 DONE으로 둔다', async () => {
    // 받는 쪽이 이미 그 판을 가지고 있는 상태(같은 판 changed:false)를 흉내 낸다
    const copies: RestrictionCopiesPort = { async queue() { return { changed: false }; }, async purchase() { return { changed: false }; }, async view() { return { changed: false }; } };
    const app = await setup({ copies });
    const r = await approvedRestriction(app, { accountId: '0194f064-0000-7000-8000-000000000002' });
    expect(app.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'ACTIVE', version: r.version });
    // 직접 어댑터도 false를 그대로 돌려준다
    answer.changed = false;
    await expect(grpcCopies!.queue({ accountId: r.accountId, restrictionId: r.restrictionId, state: 'ACTIVE', endsAtMs: NOW_MS + 86_400_000, version: 3 })).resolves.toEqual({ changed: false });
    expect(seen.map((s) => s.request.version)).toEqual([3]);
  });

  test('Q-T59 ③ 큰 판 LIFTED를 보내면 두 집행 사본이 LIFTED로 바뀐다(입장 확정 통과는 받는 쪽 기존 시험 짝)', async () => {
    await setup();
    const i = { accountId: '0194f064-0000-7000-8000-000000000003', restrictionId: '0194f064-0000-7000-8000-000000000103', state: 'LIFTED', version: 4 };
    await grpcCopies!.queue(i);
    await grpcCopies!.purchase(i);
    expect(seen.map((s) => [s.method, s.request.state, s.request.version])).toEqual([
      ['SetBookingRestriction', 'BOOKING_RESTRICTION_STATE_LIFTED', 4],
      ['SetBookingRestriction', 'BOOKING_RESTRICTION_STATE_LIFTED', 4],
    ]);
    expect(seen[0]!.request.ends_at).toBeUndefined();
  });

  test('Q-T59 ④ 끝이 지난 ACTIVE는 정비가 EXPIRED로 바꾸고 사본을 더 보내지 않는다', async () => {
    const app = await setup();
    const r = await approvedRestriction(app, { accountId: '0194f064-0000-7000-8000-000000000004', endsAtMs: NOW_MS + 3_600_000 });
    seen.length = 0;
    app.clock.advance(3_600_000 + 1);
    await app.tick();
    expect(app.kit().rows().find((x) => x.restrictionId === r.restrictionId)).toMatchObject({ status: 'EXPIRED' });
    expect(seen).toEqual([]);
  });

  test('Q-T59 ⑤ 사본을 잃은 계정을 다시 보내기 작업이 같은 판으로 다시 세운다(상태를 가진 받는 쪽 대역)', async () => {
    // 받는 쪽의 판 가드와 저장을 흉내 내는 대역. 지우면 다시 세워지는지 본다
    const store = new Map<string, number>();
    const copies: RestrictionCopiesPort = {
      async queue(i) { const k = `queue:${i.accountId}`; const v = Number(i.version); if (v <= (store.get(k) ?? 0)) return { changed: false }; store.set(k, v); return { changed: true }; },
      async purchase(i) { const k = `purchase:${i.accountId}`; const v = Number(i.version); if (v <= (store.get(k) ?? 0)) return { changed: false }; store.set(k, v); return { changed: true }; },
      async view(i) { const k = `view:${i.accountId}:${i.restrictionId}`; const v = Number(i.version); if (v <= (store.get(k) ?? 0)) return { changed: false }; store.set(k, v); return { changed: true }; },
    };
    const app = await setup({ copies });
    const r = await approvedRestriction(app, { accountId: '0194f064-0000-7000-8000-000000000005', endsAtMs: nextYear() });
    expect([store.get(`queue:${r.accountId}`), store.get(`purchase:${r.accountId}`), store.get(`view:${r.accountId}:${r.restrictionId}`)]).toEqual([r.version, r.version, r.version]);
    store.clear();
    app.clock.advance(600_000);
    await app.tick();
    expect([store.get(`queue:${r.accountId}`), store.get(`purchase:${r.accountId}`), store.get(`view:${r.accountId}:${r.restrictionId}`)]).toEqual([r.version, r.version, r.version]);
  });

  test('TR-06 토큰이 틀린 view 어댑터는 PERMISSION_DENIED로 멈춘다', async () => {
    const wrong = (await loadCopies()).grpcRestrictionCopies({ queueUrl, purchaseUrl, coreUrl, token: 'wrong-token' });
    await expect(wrong.view({ accountId: '0194f064-0000-7000-8000-000000000006', restrictionId: '0194f064-0000-7000-8000-000000000106', state: 'ACTIVE', reasonCode: 'ABUSE_CANCEL', startsAtMs: NOW_MS, endsAtMs: nextYear(), appealDueAtMs: NOW_MS + 86_400_000, version: 1 })).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
  });
});
