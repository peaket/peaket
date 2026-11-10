// identity MemberCodeService 클라이언트: 로컬 grpc-js 서버(identity 경계 대역)로 칸 이름·나눠 부르기·실패 바꾸기·답 검사를 본다(ADR-0261 결정 6, BUILD_ORDER HOT-250).
// 단언 값은 정본의 글(한 번에 1만 개 [가정], 데드라인 2초 [가정])로 적는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { GrpcMemberCodeDirectory, MemberCodeLookupFailed } from '../src/modules/catalog/index.js';

type Behaviour = (codes: string[], n: number) => { error?: grpc.status; delayMs?: number; resolved?: { member_code: string; account_id: string }[] };

let server: grpc.Server;
let bare: grpc.Server;
let port = 0;
let barePort = 0;
const seen: string[][] = [];
let behave: Behaviour = () => ({});
const accounts = new Map<string, string>();

const code = (i: number) => {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const d = (n: number, k: number) => A[Math.floor(n / 32 ** k) % 32];
  return `${d(i, 6)}${d(i, 5)}${d(i, 4)}-${d(i, 3)}${d(i, 2)}${d(i, 1)}${d(i, 0)}`;
};

beforeAll(async () => {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
  server = new grpc.Server();
  server.addService(pkg.MemberCodeService!.service, {
    ResolveMemberCodes: (call: grpc.ServerUnaryCall<{ member_codes: string[] }, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      seen.push(call.request.member_codes);
      const b = behave(call.request.member_codes, seen.length);
      const answer = () => {
        if (b.error !== undefined) return cb({ code: b.error, details: '시험이 넣음' } as grpc.ServiceError);
        cb(null, { resolved: b.resolved ?? call.request.member_codes.filter((c) => accounts.has(c)).map((c) => ({ member_code: c, account_id: accounts.get(c)! })) });
      };
      if (b.delayMs) setTimeout(answer, b.delayMs);
      else answer();
    },
  });
  port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  // 서비스를 등록하지 않은 identity(GAT-050 전): UNIMPLEMENTED
  bare = new grpc.Server();
  bare.addService(pkg.AdminAuthzService!.service, { GetAdminAuthz: (_c: unknown, cb: grpc.sendUnaryData<unknown>) => cb(null, {}) });
  barePort = await new Promise<number>((res, rej) => bare.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
});
afterAll(() => {
  server?.forceShutdown();
  bare?.forceShutdown();
});
beforeEach(() => {
  seen.length = 0;
  behave = () => ({});
});

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MemberCodeLookupFailed);
    return (e as MemberCodeLookupFailed).reason;
  }
  throw new Error('실패해야 한다');
};

describe('ResolveMemberCodes 클라이언트', () => {
  test('회원 코드를 proto 칸 이름으로 1만 개씩 차례대로 보내고 찾은 것만 계정 ID로 돌려준다', async () => {
    const codes = Array.from({ length: 25_000 }, (_, i) => code(i));
    for (const c of codes.slice(0, 3)) accounts.set(c, randomUUID());
    accounts.set(codes[24_999]!, randomUUID().toUpperCase());
    const c = new GrpcMemberCodeDirectory(`127.0.0.1:${port}`);
    try {
      const out = await c.resolve(codes, {});
      expect(seen.map((s) => s.length)).toEqual([10_000, 10_000, 5_000]);
      expect(seen[0]![0]).toBe(codes[0]);
      expect(seen[2]!.at(-1)).toBe(codes[24_999]);
      expect([...out.keys()]).toEqual([...codes.slice(0, 3), codes[24_999]]);
      // 계정 ID는 소문자로 둔다
      expect(out.get(codes[24_999]!)).toBe(accounts.get(codes[24_999]!)!.toLowerCase());
      // 코드가 없으면 부르지 않는다
      seen.length = 0;
      expect((await c.resolve([], {})).size).toBe(0);
      expect(seen).toEqual([]);
    } finally {
      c.close();
    }
  });

  test('UNAVAILABLE·INTERNAL·UNIMPLEMENTED·데드라인 2초 넘김은 모두 변환 실패이고, 여러 번 가운데 마지막 호출만 실패해도 결과를 주지 않는다', async () => {
    const c = new GrpcMemberCodeDirectory(`127.0.0.1:${port}`);
    try {
      behave = () => ({ error: grpc.status.UNAVAILABLE });
      expect(await failure(c.resolve(['PK7-42Q9'], {}))).toBe('UNAVAILABLE');
      behave = () => ({ error: grpc.status.INTERNAL });
      expect(await failure(c.resolve(['PK7-42Q9'], {}))).toBe('INTERNAL');
      behave = () => ({ delayMs: 2_300 });
      const t = Date.now();
      expect(await failure(c.resolve(['PK7-42Q9'], {}))).toBe('DEADLINE_EXCEEDED');
      expect(Date.now() - t).toBeGreaterThanOrEqual(1_900);
      behave = () => ({ delayMs: 1_500 });
      expect((await c.resolve(['PK7-42Q9'], {})).size).toBe(0);
      seen.length = 0;
      behave = (_codes, n) => (n === 3 ? { error: grpc.status.UNAVAILABLE } : {});
      expect(await failure(c.resolve(Array.from({ length: 20_001 }, (_, i) => code(i)), {}))).toBe('UNAVAILABLE');
      expect(seen.map((s) => s.length)).toEqual([10_000, 10_000, 1]);
    } finally {
      c.close();
    }
    const none = new GrpcMemberCodeDirectory(`127.0.0.1:${barePort}`);
    try {
      expect(await failure(none.resolve(['PK7-42Q9'], {}))).toBe('UNIMPLEMENTED');
    } finally {
      none.close();
    }
  }, 30_000);

  test('보내지 않은 코드·UUID가 아닌 계정 ID·한 코드에 두 계정인 답은 정한 모양이 아닌 답으로 실패다', async () => {
    const c = new GrpcMemberCodeDirectory(`127.0.0.1:${port}`);
    try {
      behave = () => ({ resolved: [{ member_code: 'ZZZ-ZZZZ', account_id: randomUUID() }] });
      expect(await failure(c.resolve(['PK7-42Q9'], {}))).toBe('INVALID_RESPONSE');
      behave = () => ({ resolved: [{ member_code: 'PK7-42Q9', account_id: 'not-a-uuid' }] });
      expect(await failure(c.resolve(['PK7-42Q9'], {}))).toBe('INVALID_RESPONSE');
      behave = () => ({ resolved: [{ member_code: 'PK7-42Q9', account_id: randomUUID() }, { member_code: 'PK7-42Q9', account_id: randomUUID() }] });
      expect(await failure(c.resolve(['PK7-42Q9'], {}))).toBe('INVALID_RESPONSE');
    } finally {
      c.close();
    }
  });

  test('취소 신호의 abort 듣기는 호출마다 떼고, 신호가 끊기면 남은 호출을 하지 않는다(리뷰 C6)', async () => {
    const c = new GrpcMemberCodeDirectory(`127.0.0.1:${port}`);
    try {
      const ctl = new AbortController();
      await c.resolve(Array.from({ length: 25_000 }, (_, i) => code(i)), { signal: ctl.signal });
      expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
      seen.length = 0;
      behave = (_codes, n) => {
        if (n === 1) ctl.abort();
        return {};
      };
      expect(await failure(c.resolve(Array.from({ length: 25_000 }, (_, i) => code(i)), { signal: ctl.signal }))).toBe('CANCELLED');
      expect(seen).toHaveLength(1);
    } finally {
      c.close();
    }
  });

  test('주소가 host:port가 아니면 만들 때 실패한다', () => {
    expect(() => new GrpcMemberCodeDirectory('identity-svc')).toThrow(/host:port/);
  });
});
