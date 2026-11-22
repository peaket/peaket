// 회원 코드 일괄 변환의 규칙(BUILD_ORDER GAT-050, HOT-250이 넘긴 것, ADR-0261 결정 6).
// 가입 완료가 매기는 Crockford base32 `XXX-XXXX`만 받고, 한 번에 1만 개 [가정]까지다(identity/domain/signup.ts memberCodeFrom과 같은 꼴).
export const RESOLVE_MEMBER_CODES_MAX = 10_000;
const MEMBER_CODE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** 찾은 것만 돌려준다. 부르는 쪽 core-svc·ticket-svc의 회원 코드 찾기 */
export interface MemberCodeResolver {
  resolve(codes: readonly string[]): Promise<readonly { readonly memberCode: string; readonly accountId: string }[]>;
}

/** 앞뒤 공백을 지우고 중복을 없앤다. 빈 목록·상한 초과·모양이 틀린 코드가 하나라도 있으면 undefined다 */
export function normalizeMemberCodes(codes: readonly string[]): readonly string[] | undefined {
  if (codes.length === 0 || codes.length > RESOLVE_MEMBER_CODES_MAX) return undefined;
  const trimmed = codes.map((c) => c.trim());
  if (trimmed.some((c) => !MEMBER_CODE.test(c))) return undefined;
  return [...new Set(trimmed)];
}
