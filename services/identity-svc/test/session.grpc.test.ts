// gRPC SessionService 받는 층(docs/api/proto identity.proto, docs/api/proto/README.md §2 상태 코드, I-T50, I-T54).
// 실제 grpc-js 서버를 루프백에 띄우고, 계약 설명자(@peaket/contracts/proto)로 만든 클라이언트로 부른다.
import * as grpc from '@grpc/grpc-js';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryLinkProposals } from '../src/modules/session/adapters/memory-link-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { GetLinkProposal } from '../src/modules/session/application/get-link-proposal.js';
import { SeparateAccount } from '../src/modules/session/application/separate-account.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { identityPackage, sessionServiceHandlers } from '../src/modules/session/inbound/session.grpc.js';
import { fanReauthToken, ISSUER, kit, newKey } from './support.js';

type Cb<T> = (e: grpc.ServiceError | null, v?: T) => void;
type Unary = (req: Record<string, unknown>, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb<Record<string, any>>) => void;
type Client = grpc.Client & Record<'CreateSession' | 'EndSession' | 'IssueReauthToken' | 'GetLinkProposal' | 'SeparateAccount' | 'AddProvider', Unary>;

let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: Client;
let kitRef: Awaited<ReturnType<typeof kit>>;
let storeRef: MemorySessionStore;
const errors: string[] = [];

beforeAll(async () => {
  const store = new MemorySessionStore();
  storeRef = store;
  const k0 = await kit(store);
  const links = new MemoryLinkProposals(k0.clock);
  const k = await kit(store, { clock: k0.clock, links });
  kitRef = k;
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: identityPackage().SessionService.service,
        handlers: sessionServiceHandlers(
          { ...k, linkView: new GetLinkProposal(links, k.clock), separate: new SeparateAccount(k.create, links), addProvider: new AddProvider(store, new JoseReauthVerifier(k.keys, ISSUER, k.clock), k.clock) },
          (method) => errors.push(method),
        ),
      },
    ],
  });
  client = new (identityPackage().SessionService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
});

afterAll(async () => {
  client?.close();
  await server?.close();
});

const call = (method: keyof Pick<Client, 'CreateSession' | 'EndSession' | 'IssueReauthToken' | 'GetLinkProposal' | 'SeparateAccount' | 'AddProvider'>, req: Record<string, unknown>) =>
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

  test('IR-13③ gRPC x-request-id가 로그인 성공·실패 법정 줄의 request_id가 된다', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
    const key = newKey();
    try {
      const md = new grpc.Metadata();
      md.set('x-request-id', 'http-request-ok');
      const r = await new Promise<Record<string, any>>((res, rej) =>
        client.CreateSession({ idempotency_key: key, provider: 'PROVIDER_KAKAO', provider_user_id: 'grpc-request-ok', email: '', email_verified: false }, md, { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))),
      );
      expect(r.outcome).toBe('session');
      // 같은 멱등 키에 다른 제공자·사용자면 ALREADY_EXISTS이고 실패 줄이 남는다
      const fail = new grpc.Metadata();
      fail.set('x-request-id', 'http-request-fail');
      await new Promise((res) => client.CreateSession({ idempotency_key: key, provider: 'PROVIDER_NAVER', provider_user_id: 'grpc-request-fail' }, fail, { deadline: Date.now() + 5_000 }, () => res(undefined)));
    } finally {
      spy.mockRestore();
    }
    const lines = chunks
      .flatMap((c) => c.split('\n'))
      .filter((l) => l.includes('"kind":"legal-access"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.event === 'LOGIN' && l.result === 'SUCCESS' && l.request_id === 'http-request-ok')).toBeTruthy();
    expect(lines.find((l) => l.event === 'LOGIN' && l.result === 'FAILED' && l.request_id === 'http-request-fail')).toBeTruthy();
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

  test('I-T34_AddProvider는_재인증토큰으로새제공자를잇고결과를열거로준다(재인증이맞지않거나다시쓰면REAUTH_REQUIRED)', async () => {
    const r = await create({ provider_user_id: 'grpc-add-1', email: '' });
    const tok = (await kitRef.signer.reauth({ accountId: r.session.account_id, sessionId: r.session.session_id, provider: 'kakao', strength: 'verified', operation: 'LOGIN_METHOD_ADD' }, kitRef.clock.now())).token;
    const base = { session_id: r.session.session_id, account_id: r.session.account_id, provider: 'PROVIDER_GOOGLE', provider_user_id: 'grpc-add-g' };
    expect(await call('AddProvider', { ...base, reauth_token: 'nope' })).toEqual({ result: 'ADD_PROVIDER_RESULT_REAUTH_REQUIRED', merge_proposal_id: '' });
    expect(await call('AddProvider', { ...base, reauth_token: tok })).toEqual({ result: 'ADD_PROVIDER_RESULT_LINKED', merge_proposal_id: '' });
    expect(await call('AddProvider', { ...base, reauth_token: tok })).toEqual({ result: 'ADD_PROVIDER_RESULT_REAUTH_REQUIRED', merge_proposal_id: '' });
  });

  test('I-T85 ③ AddProvider(gRPC)는 op가 LOGIN_METHOD_ADD가 아닌 토큰에 REAUTH_REQUIRED이고 잇지 않는다', async () => {
    const r = await create({ provider_user_id: 'grpc-add-op', email: '' });
    // 정본 모양의 토큰을 직접 만든다(같은 세션·act FAN_SENSITIVE, op만 고른다)
    const tokenOf = (op: string) => fanReauthToken(kitRef.keys, { accountId: r.session.account_id, sessionId: r.session.session_id, act: 'FAN_SENSITIVE', op, now: kitRef.clock.now() });
    const base = { session_id: r.session.session_id, account_id: r.session.account_id, provider: 'PROVIDER_GOOGLE', provider_user_id: 'grpc-add-op-g' };
    for (const op of ['LOGIN_METHOD_REMOVE', 'ACCOUNT_MERGE', 'TICKET_CANCEL'] as const) {
      expect(await call('AddProvider', { ...base, reauth_token: await tokenOf(op) }), op).toEqual({ result: 'ADD_PROVIDER_RESULT_REAUTH_REQUIRED', merge_proposal_id: '' });
    }
    expect(storeRef.providerCount(r.session.account_id)).toBe(1);
    expect(await call('AddProvider', { ...base, reauth_token: await tokenOf('LOGIN_METHOD_ADD') })).toEqual({ result: 'ADD_PROVIDER_RESULT_LINKED', merge_proposal_id: '' });
  });

  test('I-T76_CreateSession·SeparateAccount의user_agent에서화면용기기이름만뽑아세션에둔다(원문은두지않는다)', async () => {
    const ua = 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36';
    const r = await create({ provider_user_id: 'grpc-ua-1', email: '', user_agent: ua });
    expect(storeRef.peekSession(r.session.session_id)).toMatchObject({ deviceLabel: 'Samsung Internet · Android' });
    expect(JSON.stringify(storeRef.peekSession(r.session.session_id))).not.toContain('SM-S928N');
    await create({ provider_user_id: 'grpc-ua-k', email: 'ua@peaket.test' });
    const q = await create({ provider: 'PROVIDER_GOOGLE', provider_user_id: 'grpc-ua-g', email: 'ua@peaket.test' });
    const sep = await call('SeparateAccount', { link_proposal_id: q.link_proposal_id, link_binding: q.link_binding, idempotency_key: newKey(), device_id: 'dev-U', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' });
    expect(storeRef.peekSession(sep.session.session_id)).toMatchObject({ deviceLabel: 'Safari · iPhone' });
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
    const base = { session_id: r.session.session_id, account_id: r.session.account_id, provider: 'PROVIDER_KAKAO', provider_user_id: '4000123', operation: 'REAUTH_OPERATION_SESSION_END' };
    const ok = await call('IssueReauthToken', { ...base, strength: 'REAUTH_STRENGTH_VERIFIED' });
    expect(ok.result).toBe('REAUTH_RESULT_ISSUED');
    expect(ok.reauth_token.split('.')).toHaveLength(3);
    expect(ok.reauth_token_expires_at_ms).toBeGreaterThan(0);
    const other = await call('IssueReauthToken', { ...base, provider_user_id: '4000124', strength: 'REAUTH_STRENGTH_REQUESTED' });
    expect(other).toMatchObject({ result: 'REAUTH_RESULT_ACCOUNT_MISMATCH', reauth_token: '' });
    expect(await status(call('IssueReauthToken', { ...base, strength: 'REAUTH_STRENGTH_UNSPECIFIED' }))).toBe('INVALID_ARGUMENT');
    expect(await status(call('IssueReauthToken', { ...base, strength: 'REAUTH_STRENGTH_VERIFIED', operation: 'REAUTH_OPERATION_UNSPECIFIED' }))).toBe('INVALID_ARGUMENT');
    const naver = await create({ provider: 'PROVIDER_NAVER', provider_user_id: 'nv-9' });
    expect(await call('IssueReauthToken', { session_id: naver.session.session_id, account_id: naver.session.account_id, provider: 'PROVIDER_NAVER', provider_user_id: 'nv-9', strength: 'REAUTH_STRENGTH_REQUESTED', operation: 'REAUTH_OPERATION_TRANSFER_REQUEST' })).toMatchObject({ result: 'REAUTH_RESULT_REVERIFY_REQUIRED', reauth_token: '' });
  });

  // I-T85 ②(docs/features/identity.md §12, §7.1 ③④, ADR-0293 결정 2·4). 값은 docs/security/authz-matrix.md §6 '받는 쪽 작업 op의 값' 표에서 옮겨 적는다
  const OP_ACT: ReadonlyArray<readonly [string, 'FAN_SENSITIVE' | 'FAN_HIGH_RISK']> = [
    ['ACCOUNT_WITHDRAW', 'FAN_SENSITIVE'],
    ['SESSION_END', 'FAN_SENSITIVE'],
    ['SCANNER_SESSION_END', 'FAN_SENSITIVE'],
    ['LOGIN_METHOD_ADD', 'FAN_SENSITIVE'],
    ['LOGIN_METHOD_REMOVE', 'FAN_SENSITIVE'],
    ['ACCOUNT_MERGE', 'FAN_SENSITIVE'],
    ['CONTACT_CHANGE', 'FAN_SENSITIVE'],
    ['TICKET_CANCEL', 'FAN_SENSITIVE'],
    ['TICKET_CANCEL_REFUND_ACCOUNT', 'FAN_HIGH_RISK'],
    ['DEVICE_KEY_ISSUE', 'FAN_SENSITIVE'],
    ['TICKET_RETURN', 'FAN_SENSITIVE'],
    ['TRANSFER_REQUEST', 'FAN_HIGH_RISK'],
    ['REFUND_ACCOUNT', 'FAN_HIGH_RISK'],
    ['COMPENSATION_ACCOUNT', 'FAN_HIGH_RISK'],
    ['SHOP_CANCEL_REFUND_ACCOUNT', 'FAN_HIGH_RISK'],
  ];
  /** 옛 칸 purpose를 그 작업과 반대 묶음 값으로 채운다(읽지 않는지 본다) */
  const oppositePurpose = (act: string) => (act === 'FAN_HIGH_RISK' ? 'REAUTH_PURPOSE_SENSITIVE' : 'REAUTH_PURPOSE_HIGH_RISK');

  test('I-T85 ②-1 IssueReauthToken은 열다섯 작업마다 토큰의 op에 그 작업을, act에 표의 묶음을 싣는다(옛 purpose는 반대 묶음이어도 읽지 않는다)', async () => {
    expect(OP_ACT).toHaveLength(15);
    for (const [op, act] of OP_ACT) {
      const r = await create({ provider_user_id: `op-${op}` });
      const got = await call('IssueReauthToken', {
        session_id: r.session.session_id,
        account_id: r.session.account_id,
        provider: 'PROVIDER_KAKAO',
        provider_user_id: `op-${op}`,
        strength: 'REAUTH_STRENGTH_VERIFIED',
        operation: `REAUTH_OPERATION_${op}`,
        purpose: oppositePurpose(act),
      });
      expect(got.result, op).toBe('REAUTH_RESULT_ISSUED');
      expect(decodeProtectedHeader(got.reauth_token)).toMatchObject({ typ: 'reauth+jwt' });
      const claims = decodeJwt(got.reauth_token);
      expect({ op: claims.op, act: claims.act }, op).toEqual({ op, act });
      expect(claims).toMatchObject({ sub: r.session.account_id, sid: r.session.session_id, aud: 'fan' });
    }
  });

  test('I-T85 ②-2 operation이 UNSPECIFIED·칸 없음·모르는 번호면 INVALID_ARGUMENT이고 토큰을 주지 않는다(옛 purpose만 채워도)', async () => {
    const r = await create({ provider_user_id: 'op-none' });
    const base = { session_id: r.session.session_id, account_id: r.session.account_id, provider: 'PROVIDER_KAKAO', provider_user_id: 'op-none', strength: 'REAUTH_STRENGTH_VERIFIED' };
    const issuedBefore = kitRef.signals.seen.filter((x) => x.startsWith('reauth:')).length;
    for (const extra of [
      { operation: 'REAUTH_OPERATION_UNSPECIFIED' },
      { operation: 0 },
      { operation: 99 },
      {},
      { purpose: 'REAUTH_PURPOSE_SENSITIVE' },
      { purpose: 'REAUTH_PURPOSE_HIGH_RISK' },
      { operation: 'REAUTH_OPERATION_UNSPECIFIED', purpose: 'REAUTH_PURPOSE_SENSITIVE' },
    ]) {
      expect(await status(call('IssueReauthToken', { ...base, ...extra })), JSON.stringify(extra)).toBe('INVALID_ARGUMENT');
    }
    // 토큰을 한 번도 서명하지 않았다(발급 신호 0)
    expect(kitRef.signals.seen.filter((x) => x.startsWith('reauth:')).length).toBe(issuedBefore);
  });

  test("I-T85 ②-3 '요청만 함'·로그인 판정 CHALLENGE 세션에서 TRANSFER_REQUEST는 본인확인 재통과가 필요하고 SESSION_END는 토큰이 나온다(옛 purpose와 반대로 채워도)", async () => {
    const ask = async (op: string, purpose: string) => {
      const sub = `nv-ch-${op}`;
      const r = await create({ provider: 'PROVIDER_NAVER', provider_user_id: sub, email: null, email_verified: false });
      await storeRef.transaction((tx) => tx.setLoginVerdict(r.session.session_id, 'CHALLENGE', 'NETWORK', kitRef.clock.now()));
      return call('IssueReauthToken', {
        session_id: r.session.session_id,
        account_id: r.session.account_id,
        provider: 'PROVIDER_NAVER',
        provider_user_id: sub,
        strength: 'REAUTH_STRENGTH_REQUESTED',
        operation: `REAUTH_OPERATION_${op}`,
        purpose,
      });
    };
    expect(await ask('TRANSFER_REQUEST', 'REAUTH_PURPOSE_SENSITIVE')).toMatchObject({ result: 'REAUTH_RESULT_REVERIFY_REQUIRED', reauth_token: '' });
    const end = await ask('SESSION_END', 'REAUTH_PURPOSE_HIGH_RISK');
    expect(end.result).toBe('REAUTH_RESULT_ISSUED');
    expect(decodeJwt(end.reauth_token)).toMatchObject({ op: 'SESSION_END', act: 'FAN_SENSITIVE', strength: 'requested' });
    // 고위험 다섯은 모두 재통과가 필요하다
    for (const op of ['TICKET_CANCEL_REFUND_ACCOUNT', 'REFUND_ACCOUNT', 'COMPENSATION_ACCOUNT', 'SHOP_CANCEL_REFUND_ACCOUNT']) {
      expect((await ask(op, 'REAUTH_PURPOSE_SENSITIVE')).result, op).toBe('REAUTH_RESULT_REVERIFY_REQUIRED');
    }
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
