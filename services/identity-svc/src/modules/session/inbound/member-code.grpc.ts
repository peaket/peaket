// identity MemberCodeService.ResolveMemberCodes(BUILD_ORDER GAT-050, HOT-250이 넘긴 것, ADR-0261 결정 6).
// 회원 코드(대문자 Crockford base32 `XXX-XXXX`)를 한 번에 1만 개 [가정]까지 받아, 가입을 마친 ACTIVE 계정의 것만 답한다.
// 없는 코드는 빼고, 모양이 틀린 코드·빈 목록·상한 초과는 INVALID_ARGUMENT다. 회원 코드·계정 ID는 로그에 싣지 않는다.
import * as grpc from '@grpc/grpc-js';

/** 한 번에 받는 회원 코드 상한 [가정](identity.proto ResolveMemberCodesRequest) */
export const RESOLVE_MEMBER_CODES_MAX = 10_000;
/** 가입 완료가 매기는 회원 코드 꼴(domain/signup.ts memberCodeFrom과 같다) */
const MEMBER_CODE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** 찾은 것만 돌려준다. 부르는 쪽 core-svc·ticket-svc의 회원 코드 찾기 */
export interface MemberCodeResolver {
  resolve(codes: readonly string[]): Promise<readonly { readonly memberCode: string; readonly accountId: string }[]>;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function memberCodeHandlers(uc: { readonly resolve: MemberCodeResolver['resolve'] }, onError?: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  return {
    ResolveMemberCodes: (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      const asked = Array.isArray(call.request.member_codes) ? call.request.member_codes.map(text) : [];
      const codes = asked.map((c) => c.trim());
      if (codes.length === 0 || codes.length > RESOLVE_MEMBER_CODES_MAX || codes.some((c) => !MEMBER_CODE.test(c))) {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: '회원 코드가 비었거나 모양이 틀렸다' });
        return;
      }
      const unique = [...new Set(codes)];
      uc.resolve(unique)
        .then((rows) => {
          const allowed = new Set(unique);
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
