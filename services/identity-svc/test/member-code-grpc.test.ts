// identity MemberCodeService.ResolveMemberCodes 처리기 시험(BUILD_ORDER GAT-050, HOT-250이 넘긴 것, ADR-0261 결정 6).
// 회원 코드를 한 번에 1만 개 [가정]까지 받아 가입을 마친 ACTIVE 계정만 답한다. 없는 코드는 빼고, 모양이 틀리면 INVALID_ARGUMENT다.
import * as grpc from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { memberCodeHandlers } from '../src/modules/session/inbound/member-code.grpc.js';

const A = '0193f2c0-0000-7000-8000-0000000000a1';
const B = '0193f2c0-0000-7000-8000-0000000000b2';

type Reply = Record<string, unknown>;
const call = (handlers: grpc.UntypedServiceImplementation, codes: unknown): Promise<{ err: grpc.ServiceError | null; res?: Reply }> =>
  new Promise((resolve) => {
    const fn = handlers.ResolveMemberCodes as unknown as (c: unknown, cb: (err: grpc.ServiceError | null, res?: Reply) => void) => void;
    fn({ request: { member_codes: codes }, metadata: new grpc.Metadata() }, (err, res) => resolve({ err, res }));
  });

describe('MemberCodeService.ResolveMemberCodes', () => {
  it('찾은 ACTIVE 계정만 코드와 계정 ID로 답한다', async () => {
    const seen: string[][] = [];
    const handlers = memberCodeHandlers({
      resolve: async (codes) => {
        seen.push([...codes]);
        return codes.filter((c) => c === 'PEAKET-0001').map((c) => ({ memberCode: c, accountId: A }));
      },
    });
    const { err, res } = await call(handlers, ['PEAKET-0001', 'PEAKET-9999']);
    expect(err).toBeNull();
    expect(seen).toEqual([['PEAKET-0001', 'PEAKET-9999']]);
    expect(res).toEqual({ resolved: [{ member_code: 'PEAKET-0001', account_id: A }] });
  });

  it('1만 개를 넘거나 빈 코드·모양이 틀린 코드는 INVALID_ARGUMENT다', async () => {
    const handlers = memberCodeHandlers({
      resolve: async (codes) => codes.map((c) => ({ memberCode: c, accountId: B })),
    });
    expect((await call(handlers, Array.from({ length: 10_001 }, (_, i) => `PEAKET-${String(i).padStart(4, '0')}`))).err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await call(handlers, [''])).err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await call(handlers, ['peaket 0001!'])).err?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });
});
