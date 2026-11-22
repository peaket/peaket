// identity MemberCodeService.ResolveMemberCodes(BUILD_ORDER GAT-050, HOT-250이 넘긴 것, ADR-0261 결정 6).
// 회원 코드를 한 번에 1만 개 [가정]까지 받아, 가입을 마친 ACTIVE 계정의 것만 답한다.
// 없는 코드는 빼고, 모양이 틀린 코드·빈 목록·상한 초과는 INVALID_ARGUMENT다. 회원 코드·계정 ID는 로그에 싣지 않는다.
import * as grpc from '@grpc/grpc-js';
import { type MemberCodeResolver, normalizeMemberCodes, RESOLVE_MEMBER_CODES_MAX } from '../domain/member-code.js';

export { RESOLVE_MEMBER_CODES_MAX, type MemberCodeResolver } from '../domain/member-code.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function memberCodeHandlers(uc: { readonly resolve: MemberCodeResolver['resolve'] }, onError?: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  return {
    ResolveMemberCodes: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const asked = Array.isArray(call.request.member_codes) ? call.request.member_codes.map(text) : [];
      const codes = normalizeMemberCodes(asked);
      if (codes === undefined) {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: '회원 코드가 비었거나 모양이 틀렸다' });
        return;
      }
      uc.resolve(codes)
        .then((rows) => {
          const allowed = new Set(codes);
          cb(null, {
            resolved: rows
              .filter((r) => allowed.has(r.memberCode))
              .map((r) => ({ member_code: r.memberCode, account_id: r.accountId })),
          });
        })
        .catch((err: unknown) => {
          onError?.('ResolveMemberCodes', err);
          cb({ code: grpc.status.INTERNAL, details: '회원 코드를 찾지 못했다' });
        });
    },
  };
}
