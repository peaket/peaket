// F-05-11 identity 몫 시험: 휴대폰·닉네임 RPC와 ticket 탈퇴 참여자 배선(계획 docs/review/plans/F-05-11.md §4·§5 T5·T6·T7).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). ResolvePhone·BatchGetNicknames·ticket 참여자는 아직 없다.
// 정본: docs/features/identity.md §6.2(휴대폰·닉네임)·§8(탈퇴 참여자)·§11 I-T43 ①, docs/features/transfer-refund.md §4.
// - 진짜: gRPC 처리기와 환경값 참여자 조립. 바꿔 끼운 것은 identity 조회 포트(가짜)뿐이다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { withdrawalParticipantsFromEnv } from '../src/modules/session/adapters/grpc-withdrawal-participants.js';

type Req = Record<string, unknown>;
type Cb = (e: grpc.ServiceError | null, v?: Req) => void;
interface Unary {
  (call: { request: Req }, cb: Cb): void;
}

const PHONE_B = '010-9371-2468';
const DIGITS = '01093712468';
const B = '0193f2c0-0000-7000-8000-000000511002';
const C = '0193f2c0-0000-7000-8000-000000511003';

const asUnary = (f: unknown): Unary => f as Unary;
const call = (request: Req, metadata?: grpc.Metadata): { request: Req; metadata?: grpc.Metadata } => ({ request, ...(metadata ? { metadata } : {}) });
const invoke = (h: Unary, request: Req, metadata?: grpc.Metadata): Promise<{ err: grpc.ServiceError | null; body: Req | undefined }> => {
  if (typeof h !== 'function') return Promise.reject(new Error('RPC 처리기가 없다'));
  return new Promise((resolve) => h(call(request, metadata), (err, body) => resolve({ err, body: body as Req | undefined })));
};

async function handlers() {
  const mod = await import(/* @vite-ignore */ new URL('../src/modules/session/inbound/recipient-query.grpc.ts', import.meta.url).href).catch(() => undefined);
  expect(mod, 'recipient-query.grpc 모듈이 없다').toBeDefined();
  const make = (mod as { recipientQueryHandlers?: (uc: object) => Record<string, unknown> }).recipientQueryHandlers;
  if (!make) throw new Error('recipientQueryHandlers가 없다');
  const phones: string[] = [];
  const nicknames: string[][] = [];
  const h = make!({
    resolvePhone: async (digits: string) => {
      phones.push(digits);
      return digits === DIGITS ? { accountId: B, nickname: '지민' } : undefined;
    },
    resolveNicknames: async (ids: readonly string[]) => {
      nicknames.push([...ids]);
      return new Map(ids.filter((id) => id === B || id === C).map((id) => [id, id === B ? '지민' : '서윤']));
    },
  });
  return { h, phones, nicknames };
}

describe('F-05-11 T6 identity ResolvePhone', () => {
  test('F-05-11 T6 ⑤ 하이픈·국가번호를 숫자로 맞춰 찾고, 모양이 틀리면 INVALID_ARGUMENT, 없으면 found=false다', async () => {
    const { h, phones } = await handlers();
    const resolve = asUnary(h.ResolvePhone);
    for (const raw of [PHONE_B, '+82 10-9371-2468', '010 9371 2468']) {
      const r = await invoke(resolve, { phone_number: raw });
      expect(r.err, `${raw}: ${r.err?.details}`).toBeNull();
      expect(r.body).toEqual({ found: true, account_id: B, nickname: '지민' });
    }
    expect(phones).toEqual([DIGITS, DIGITS, DIGITS]);
    const bad = await invoke(resolve, { phone_number: '02-123-4567' });
    expect(bad.err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(phones).toHaveLength(3);
    const missing = await invoke(resolve, { phone_number: '010-0000-0000' });
    expect(missing.err).toBeNull();
    expect(missing.body).toEqual({ found: false });
  });

  test('F-05-11 T6 ⑥ 부르는 쪽이 던지면 INTERNAL이고 계정 정보를 싣지 않는다', async () => {
    const r = await import(/* @vite-ignore */ new URL('../src/modules/session/inbound/recipient-query.grpc.ts', import.meta.url).href);
    const make = (r as { recipientQueryHandlers?: (uc: object) => Record<string, unknown> }).recipientQueryHandlers;
    if (!make) throw new Error('recipientQueryHandlers가 없다');
    const h = make({ resolvePhone: async () => { throw new Error('DB 연결 실패'); }, resolveNicknames: async () => new Map() });
    const out = await invoke(asUnary(h.ResolvePhone), { phone_number: PHONE_B });
    expect(out.err?.code).toBe(grpc.status.INTERNAL);
    expect(JSON.stringify(out.err)).not.toContain(PHONE_B);
  });
  test('F-05-11 T6 ⑦ 내부 토큰이 설정되면 ResolvePhone·BatchGetNicknames는 ticket-svc 호출자만 받는다', async () => {
    const r = await import(/* @vite-ignore */ new URL('../src/modules/session/inbound/recipient-query.grpc.ts', import.meta.url).href);
    const make = (r as { recipientQueryHandlers?: (uc: object, onError?: (m: string, e: unknown) => void, o?: { internalToken?: string }) => Record<string, unknown> }).recipientQueryHandlers;
    if (!make) throw new Error('recipientQueryHandlers가 없다');
    const h = make({ resolvePhone: async () => ({ accountId: B, nickname: '지민' }), resolveNicknames: async () => new Map([[B, '지민']]) }, undefined, { internalToken: 'f0511-identity-token' });
    const md = (token?: string, caller?: string): grpc.Metadata => {
      const m = new grpc.Metadata();
      if (token !== undefined) m.set('x-peaket-internal-token', token);
      if (caller !== undefined) m.set('x-peaket-internal-caller', caller);
      return m;
    };
    for (const method of ['ResolvePhone', 'BatchGetNicknames'] as const) {
      const req = method === 'ResolvePhone' ? { phone_number: PHONE_B } : { account_ids: [B] };
      const missing = await invoke(asUnary(h[method]), req);
      expect(missing.err?.code, `${method} 토큰 없음`).toBe(grpc.status.UNAUTHENTICATED);
      const wrongCaller = await invoke(asUnary(h[method]), req, md('f0511-identity-token', 'core-svc'));
      expect(wrongCaller.err?.code, `${method} 다른 호출자`).toBe(grpc.status.PERMISSION_DENIED);
      const ok = await invoke(asUnary(h[method]), req, md('f0511-identity-token', 'ticket-svc'));
      expect(ok.err?.code, `${method} ticket-svc`).toBeUndefined();
    }
  });
});

describe('F-05-11 T7 identity BatchGetNicknames', () => {
  test('F-05-11 T7 ④ 계정 ID 2개를 한 번에 받아 ACTIVE만 돌려주고, 501개는 INVALID_ARGUMENT다', async () => {
    const { h, nicknames } = await handlers();
    const batch = asUnary(h.BatchGetNicknames);
    const ok = await invoke(batch, { account_ids: [B, C, 'not-a-uuid'] });
    expect(ok.err).toBeNull();
    expect(ok.body).toEqual({ recipients: [{ account_id: B, nickname: '지민' }, { account_id: C, nickname: '서윤' }] });
    expect(nicknames).toEqual([[B, C]]);
    const tooMany = await invoke(batch, { account_ids: Array.from({ length: 501 }, () => B) });
    expect(tooMany.err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    const empty = await invoke(batch, { account_ids: [] });
    expect(empty.err?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });
});

describe('F-05-11 T5 I-T43 ① identity 탈퇴 참여자 배선', () => {
  test('F-05-11 T5 I-T43 ① ① 두 주소가 있으면 purchase·ticket 참여자가 둘 다 선다', () => {
    const r = withdrawalParticipantsFromEnv({ PEAKET_ENV: 'ci', PEAKET_PURCHASE_GRPC_URL: '127.0.0.1:50052', PEAKET_TICKET_GRPC_URL: '127.0.0.1:50051' });
    expect(r.participants.map((p) => p.name).sort()).toEqual(['purchase', 'ticket-svc']);
    expect(r.clients).toHaveLength(2);
    expect(r.warnings).toEqual([]);
  });

  test('F-05-11 T5 I-T43 ① ② local·ci에서 ticket 주소가 없으면 그 참여자를 빼고 경고를 남긴다(구매는 대역)', () => {
    const r = withdrawalParticipantsFromEnv({ PEAKET_ENV: 'ci', PEAKET_PURCHASE_GRPC_URL: '127.0.0.1:50052' });
    expect(r.participants.map((p) => p.name)).toEqual(['purchase']);
    expect(r.warnings.join('\n')).toContain('PEAKET_TICKET_GRPC_URL');
  });

  test('F-05-11 T5 I-T43 ① ③ 운영에서 ticket 주소가 없으면 답하지 않는 참여자로 두어 탈퇴를 끝내지 않는다', () => {
    const r = withdrawalParticipantsFromEnv({ PEAKET_ENV: 'staging', PEAKET_PURCHASE_GRPC_URL: '127.0.0.1:50052' });
    const ticket = r.participants.find((p) => p.name === 'ticket-svc');
    expect(ticket, '운영에서 ticket 참여자가 없다(조용히 건너뛰면 받은 티켓이 남은 채 탈퇴가 끝난다)').toBeDefined();
    return expect(ticket!.process(B, { deadlineMs: Date.now() + 1_000 })).rejects.toBeTruthy();
  });
});
