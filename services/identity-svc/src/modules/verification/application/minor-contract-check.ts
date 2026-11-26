// 미성년자 계약 취소 확인(F-06-3 R-T26 ③, docs/features/identity.md §5, POL-038 ⑧).
// 확인 POST가 만든 resultToken(10분 JWS)의 서명·대상·만료·계정을 보고, 토큰의 ci를 계정의 연계정보 HMAC과 대조한다.
// 주문별 결제 승인 시각(KST)으로 계약 당시 만 19세 미만이었는지 계산하며, 생년월일·연계정보·토큰은 저장·로그하지 않는다.
import { ProblemError, type Clock } from '@peaket/platform';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import type { PublicKeys } from '../../session/index.js';
import { ageOnKst } from '../domain/verification.js';
import type { MinorContractOrderBasis, MinorContractOrders, VerificationStore } from '../domain/ports.js';

export class MinorContractProblem extends Error {
  constructor(
    readonly code: 'invalid-body' | 'identity-required' | 'minor-contract-ci-mismatch' | 'minor-contract-not-owner' | 'minor-contract-mixed-orders',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MinorContractProblem';
  }
}

export interface MinorContractCheckDeps {
  readonly store: VerificationStore;
  readonly publicKeys: PublicKeys;
  readonly orders: MinorContractOrders;
  readonly clock: Clock;
}

const AUDIENCE = 'identity-minor-contract';
const UNDER_19 = 19;

export class MinorContractCheck {
  constructor(private readonly d: MinorContractCheckDeps) {}

  async run(accountId: string, input: { orderIds: readonly string[]; consent: boolean; verificationResultToken: string }): Promise<{ under19AtContract: boolean }> {
    if (input.consent !== true || input.orderIds.length < 1 || input.orderIds.length > 20) throw new MinorContractProblem('invalid-body', 400, '확인 동의와 주문 1~20개가 필요합니다');
    const now = this.d.clock.now();
    const claims = await this.#verifyToken(input.verificationResultToken, now);
    if (claims.sub !== accountId) throw new MinorContractProblem('identity-required', 403, '본인확인을 다시 해 주세요');
    const birth = typeof claims.birth === 'string' ? claims.birth : undefined;
    if (!birth || typeof claims.ci !== 'string') throw new MinorContractProblem('invalid-body', 422, '본인확인 결과에 생년월일이 없습니다');
    const record = await this.d.store.transaction((tx) => tx.verificationOf(accountId));
    if (!record) throw new MinorContractProblem('identity-required', 403, '본인확인을 다시 해 주세요');
    if (record.ciHmac.toString('hex') !== claims.ci) throw new MinorContractProblem('minor-contract-ci-mismatch', 409, '확인한 사람이 계정의 연계정보와 다릅니다');
    const results: boolean[] = [];
    for (const orderId of input.orderIds) {
      const basis = await this.d.orders.basis(orderId);
      if (!basis || basis.payerAccountId !== accountId) throw new MinorContractProblem('minor-contract-not-owner', 409, '결제한 주문이 아닙니다');
      const age = ageOnKst(birth, basis.paidAtMs);
      if (age === null) throw new MinorContractProblem('invalid-body', 422, '생년월일을 확인할 수 없습니다');
      results.push(age < UNDER_19);
    }
    if (results.some((v) => v) && results.some((v) => !v)) throw new MinorContractProblem('minor-contract-mixed-orders', 422, '미성년·성인 주문이 섞여 있습니다');
    return { under19AtContract: results.every((v) => v) };
  }

  async #verifyToken(token: string, now: number): Promise<{ sub?: string; birth?: unknown; ci?: unknown }> {
    try {
      const header = decodeProtectedHeader(token);
      const key = (this.d.publicKeys.jwks('fan', now).keys as JWK[]).find((k) => k.kid === header.kid);
      if (!key) throw new Error('키 없음');
      const imported = await importJWK(key, 'ES256');
      const { payload } = await jwtVerify(token, imported, { audience: AUDIENCE, currentDate: new Date(now) });
      return payload as { sub?: string; birth?: unknown; ci?: unknown };
    } catch {
      throw new MinorContractProblem('identity-required', 403, '확인 토큰이 유효하지 않습니다');
    }
  }
}

export const minorContractProblemOf = (e: MinorContractProblem): ProblemError =>
  new ProblemError({ type: e.code, status: e.status, title: e.message });
