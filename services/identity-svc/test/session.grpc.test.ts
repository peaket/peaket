// gRPC SessionService 받는 층(docs/api/proto identity.proto, docs/api/proto/README.md §2 상태 코드, I-T50, I-T54).
// 실제 grpc-js 서버를 루프백에 띄우고, 계약 설명자(@peaket/contracts/proto)로 만든 클라이언트로 부른다.
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryLinkProposals } from '../src/modules/session/adapters/memory-link-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { GetLinkProposal } from '../src/modules/session/application/get-link-proposal.js';
import { SeparateAccount } from '../src/modules/session/application/separate-account.js';
import { identityPackage, sessionServiceHandlers } from '../src/modules/session/inbound/session.grpc.js';
import { kit, newKey } from './support.js';

type Cb<T> = (e: grpc.ServiceError | null, v?: T) => void;
type Unary = (req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb<Record<string, any>>) => void;
type Client = grpc.Client & Record<'CreateSession' | 'EndSession' | 'IssueReauthToken' | 'GetLinkProposal' | 'SeparateAccount', Unary>;

let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
const errors: string[] = [];

beforeAll(async () => {
  const store = new MemorySessionStore();
  const k0 = await kit(store);
  const links = new MemoryLinkProposals(k0.clock);
  const k = await kit(store, { clock: k0.clock, links });
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: identityPackage().SessionService.service,
        handlers: sessionServiceHandlers({ ...k, linkView: new GetLinkProposal(links, k.clock), separate: new SeparateAccount(k.create, links) }, (method) => errors.push(method)),
      },
    ],
  });
  client = new (identityPackage().SessionService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});

afterAll(async () => {
  client?.close();
  await server?.close();
});

const call = (method: keyof Pick<Client, 'CreateSession' | 'EndSession' | 'IssueReauthToken' | 'GetLinkProposal' | 'SeparateAccount'>, req: Record<string, unknown>) =>
  new Promise<Record<string, any>>((res, rej) => client[method](req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return grpc.status[(e as grpc.ServiceError).code];
  }
};
const create = (over: Record<string, unknown> = {}) =>
  call('CreateSession', { idempotency_key: newKey(), provider: 'PROVIDER_KAKAO', provider_user_id: '4000001', email: 'fan@kakao.test', email_verified: true, device_id: 'dev-A', ...over });

describe('SessionService(gRPC)', () => {
  test('I-T50_ADR0119_CreateSession은_세션토큰과새계정표시를돌려준다', async () => {
    const r = await create();
    expect(r.outcome).toBe('session');
    expect(r.new_account).toBe(true);
    expect(r.session).toMatchObject({ account_id: expect.any(String), session_id: expect.any(String), access_token: expect.any(String), refresh_token: expect.any(String) });
    expect(r.session.access_token_expires_at_ms).toBeGreaterThan(Date.parse('2026-11-03T03:00:00Z'));
    expect(typeof r.session.refresh_token_expires_at_ms).toBe('number');
  });

  test('I-T50_①②_같은키다시보내기는같은세션_다른내용은ALREADY_EXISTS다', async () => {
    const key = newKey();
    const a = await create({ idempotency_key: key, provider_user_id: '4000077' });
    const b = await create({ idempotency_key: key, provider_user_id: '4000077' });
    expect(b.session.session_id).toBe(a.session.session_id);
    expect(b.session.refresh_token).not.toBe(a.session.refresh_token);
    expect(await status(create({ idempotency_key: key, provider_user_id: '4000078' }))).toBe('ALREADY_EXISTS');
  });

  test('I-T50_요청모양이틀리면_INVALID_ARGUMENT다', async () => {
    expect(await status(create({ provider: 'PROVIDER_UNSPECIFIED' }))).toBe('INVALID_ARGUMENT');
    expect(await status(create({ idempotency_key: '' }))).toBe('INVALID_ARGUMENT');
    expect(await status(create({ provider_user_id: '' }))).toBe('INVALID_ARGUMENT');
    expect(await status(call('EndSession', { session_id: 'x', account_id: 'y' }))).toBe('INVALID_ARGUMENT');
  });

  test('I-T30_없는연결제안ID나모양이틀린ID로온로그인은_NOT_FOUND이다', async () => {
    expect(await status(create({ link_proposal_id: '0190f3a1-7c2e-7a00-8000-000000000009', link_binding: 'x'.repeat(43) }))).toBe('NOT_FOUND');
    expect(await status(create({ link_proposal_id: 'A'.repeat(22), link_binding: 'x'.repeat(43) }))).toBe('NOT_FOUND');
  });

  test('I-T29·I-T30_gRPC로_연결제안(ID·묶음값)·제안조회·다른계정불일치·연결맺기·새계정만들기가오간다', async () => {
    await create({ provider_user_id: 'grpc-k-1', email: 'link@peaket.test' });
    const p = await create({ provider: 'PROVIDER_GOOGLE', provider_user_id: 'grpc-g-1', email: 'Link@peaket.test' });
    expect(p.outcome).toBe('link_proposal_id');
    expect(p.link_binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ids = { link_proposal_id: p.link_proposal_id, link_binding: p.link_binding };
    expect(await call('GetLinkProposal', ids)).toMatchObject({ existing_provider: 'PROVIDER_KAKAO', new_provider: 'PROVIDER_GOOGLE', attempts_left: 3 });
    const miss = await create({ provider_user_id: 'grpc-k-none', email: '', email_verified: false, ...ids });
    expect(miss.outcome).toBe('link_mismatch');
    expect(miss.link_mismatch).toEqual({ attempts_left: 2 });
    const ok = await create({ provider_user_id: 'grpc-k-1', email: '', email_verified: false, ...ids });
    expect(ok.outcome).toBe('session');
    expect(ok.linked_provider).toBe('PROVIDER_GOOGLE');
    expect(await status(call('GetLinkProposal', ids))).toBe('NOT_FOUND');
    // 새 계정 만들기
    await create({ provider_user_id: 'grpc-k-2', email: 'sep@peaket.test' });
    const q = await create({ provider: 'PROVIDER_GOOGLE', provider_user_id: 'grpc-g-2', email: 'sep@peaket.test' });
    const sep = await call('SeparateAccount', { link_proposal_id: q.link_proposal_id, link_binding: q.link_binding, idempotency_key: newKey(), device_id: 'dev-S' });
    expect(sep.outcome).toBe('session');
    expect(sep.new_account).toBe(true);
    expect(await status(call('SeparateAccount', { link_proposal_id: q.link_proposal_id, link_binding: q.link_binding, idempotency_key: newKey() }))).toBe('NOT_FOUND');
  });

  test('I-T50_④_EndSession은멱등이다', async () => {
    const r = await create({ provider_user_id: '4000099' });
    const ids = { session_id: r.session.session_id, account_id: r.session.account_id };
    expect(await call('EndSession', ids)).toEqual({ ended: true });
    expect(await call('EndSession', ids)).toEqual({ ended: false });
    expect(await status(call('EndSession', { ...ids, session_id: '0190f3a1-7c2e-7a00-8000-0000000000aa' }))).toBe('NOT_FOUND');
  });

  test('I-T54_IssueReauthToken은_강도를받아_토큰이나계정불일치를돌려준다', async () => {
    const r = await create({ provider_user_id: '4000123' });
    const base = { session_id: r.session.session_id, account_id: r.session.account_id, provider: 'PROVIDER_KAKAO', provider_user_id: '4000123', purpose: 'REAUTH_PURPOSE_SENSITIVE' };
    const ok = await call('IssueReauthToken', { ...base, strength: 'REAUTH_STRENGTH_VERIFIED' });
    expect(ok.result).toBe('REAUTH_RESULT_ISSUED');
    expect(ok.reauth_token.split('.')).toHaveLength(3);
    expect(ok.reauth_token_expires_at_ms).toBeGreaterThan(0);
    const other = await call('IssueReauthToken', { ...base, provider_user_id: '4000124', strength: 'REAUTH_STRENGTH_REQUESTED' });
    expect(other).toMatchObject({ result: 'REAUTH_RESULT_ACCOUNT_MISMATCH', reauth_token: '' });
    expect(await status(call('IssueReauthToken', { ...base, strength: 'REAUTH_STRENGTH_UNSPECIFIED' }))).toBe('INVALID_ARGUMENT');
    expect(await status(call('IssueReauthToken', { ...base, strength: 'REAUTH_STRENGTH_VERIFIED', purpose: 'REAUTH_PURPOSE_UNSPECIFIED' }))).toBe('INVALID_ARGUMENT');
    const naver = await create({ provider: 'PROVIDER_NAVER', provider_user_id: 'nv-9' });
    expect(await call('IssueReauthToken', { session_id: naver.session.session_id, account_id: naver.session.account_id, provider: 'PROVIDER_NAVER', provider_user_id: 'nv-9', strength: 'REAUTH_STRENGTH_REQUESTED', purpose: 'REAUTH_PURPOSE_HIGH_RISK' })).toMatchObject({ result: 'REAUTH_RESULT_REVERIFY_REQUIRED', reauth_token: '' });
  });

  test('proto README §2_DB연결실패는_UNAVAILABLE이다', async () => {
    const down = { run: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' })) };
    const s = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: identityPackage().SessionService.service, handlers: sessionServiceHandlers({ create: down, end: down, reauth: down } as never, () => {}) }],
    });
    const c = new (identityPackage().SessionService)(`127.0.0.1:${s.port}`, grpc.credentials.createInsecure()) as unknown as Client;
    try {
      const err = await new Promise<grpc.ServiceError>((res) => c.EndSession({ session_id: 'a', account_id: 'b' }, new grpc.Metadata(), {}, (e) => res(e!)));
      expect(grpc.status[err.code]).toBe('UNAVAILABLE');
      expect(err.details).not.toContain('10.0.0.9');
    } finally {
      c.close();
      await s.close();
    }
  });

  test('받는층은_예상하지못한오류의내용을_부르는쪽에보내지않는다', async () => {
    // 업무 오류(SessionError)가 아닌 것은 INTERNAL과 고정 문구, 이유는 서버 쪽 기록에만 남긴다
    const fail = async () => Promise.reject(new Error('postgres://identity:비밀@db 연결 실패'));
    const boom = { run: fail, outcome: fail };
    const seen: string[] = [];
    const s = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: identityPackage().SessionService.service, handlers: sessionServiceHandlers({ create: boom, end: boom, reauth: boom } as never, (m, e) => seen.push(`${m}:${String(e)}`)) }],
    });
    const c = new (identityPackage().SessionService)(`127.0.0.1:${s.port}`, grpc.credentials.createInsecure()) as unknown as Client;
    try {
      const err = await new Promise<grpc.ServiceError>((res) =>
        c.CreateSession({ idempotency_key: newKey(), provider: 'PROVIDER_KAKAO', provider_user_id: '1' }, new grpc.Metadata(), {}, (e) => res(e!)),
      );
      expect(grpc.status[err.code]).toBe('INTERNAL');
      expect(err.details).not.toContain('비밀');
      expect(seen).toEqual(['CreateSession:Error: postgres://identity:비밀@db 연결 실패']);
    } finally {
      c.close();
      await s.close();
    }
    expect(errors).toEqual([]);
  });
});
