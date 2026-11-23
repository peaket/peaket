// 시험 공용: payment-svc 지급대행 등록 포트의 짝 대역(F-07-7 계획 §5.1(아), ADR-0370 결정 3·4).
// 포트를 implements해 진짜와 모양이 묶인다. 부른 값을 모으고, 시험이 정한 답·오류를 돌려준다.
// 진짜 쪽(HttpPayoutRegistration)이 payment 내부 HTTP의 422·502·503·연결 실패를 같은 이름의 ProblemError로 바꾸는지는
// test/http-payout-registration.test.ts가 로컬 HTTP 대역 서버로 본다(행동 짝).
//
// 인터페이스 빈칸(계획 §5.1에 없어 이 시험이 고른 이름, 구현 담당은 이 이름으로 만들거나 계획 담당에게 '인터페이스 이의'를 낸다):
// - AppModule.register({ memory: true, …, payoutRegistration })의 칸 이름 `payoutRegistration`(saleOpen·opsApprovals와 같은 자리).
//   주지 않으면 memory 조립은 UnavailablePayoutRegistration('둘 다 꺼짐')이다.
import { ProblemError } from '@peaket/platform';
import type { PayoutRegistrationPort, PayoutRegistrationView } from '../src/modules/catalog/index.js';

export type RegisterInput = Parameters<PayoutRegistrationPort['register']>[0];
export type VerifySellerInput = Parameters<PayoutRegistrationPort['verifySeller']>[1];
type SellerStatus = PayoutRegistrationView['tossSellers'][number]['status'];

/** 두 결제사 모두 꺼진 읽기(계획 I-05: Unavailable의 '둘 다 꺼짐'과 같은 모양) */
export const BOTH_OFF: PayoutRegistrationView = {
  payoutAccount: null,
  agencySyncPending: false,
  tossEnabled: false,
  portoneEnabled: false,
  tossSellers: [],
  portonePartnerRegistered: false,
};

/** 둘 다 켜지고 조건이 모두 참인 읽기. 은행 088·끝 4자리 4321·일반 상점 PARTIALLY_APPROVED */
export function readyView(o: { standard?: SellerStatus | null; escrow?: SellerStatus | null } & Partial<PayoutRegistrationView> = {}): PayoutRegistrationView {
  const { standard = 'PARTIALLY_APPROVED', escrow = 'APPROVAL_REQUIRED', ...rest } = o;
  const sellers: PayoutRegistrationView['tossSellers'] = [];
  if (standard !== null) sellers.push({ pgStore: 'STANDARD', status: standard });
  if (escrow !== null) sellers.push({ pgStore: 'ESCROW', status: escrow });
  return {
    payoutAccount: { bankCode: '88', last4: '4321', holdUntil: null, holderVerified: true },
    agencySyncPending: false,
    tossEnabled: true,
    portoneEnabled: true,
    tossSellers: sellers,
    portonePartnerRegistered: true,
    ...rest,
  };
}

export const problem = (type: string, status: number, title = '결제사 대역 오류') => new ProblemError({ type, status, title });

export class RecordingPayoutRegistration implements PayoutRegistrationPort {
  readonly registers: RegisterInput[] = [];
  readonly reads: string[] = [];
  readonly verifications: { promoterId: string; input: VerifySellerInput }[] = [];
  /** 파트너마다 돌려줄 등록 읽기. 없으면 BOTH_OFF */
  readonly views = new Map<string, PayoutRegistrationView>();
  /** 다음 register 답. 오류면 던진다 */
  registerAnswer: { holderChecked: boolean } | Error = { holderChecked: true };
  /** 다음 read 오류(있으면 던진다) */
  readError: Error | undefined;
  /** verifySeller 오류(있으면 던진다) */
  verifyError: Error | undefined;

  async register(input: RegisterInput): Promise<{ holderChecked: boolean }> {
    this.registers.push(structuredClone(input));
    if (this.registerAnswer instanceof Error) throw this.registerAnswer;
    return this.registerAnswer;
  }

  async read(promoterId: string): Promise<PayoutRegistrationView> {
    this.reads.push(promoterId);
    if (this.readError) throw this.readError;
    return structuredClone(this.views.get(promoterId) ?? BOTH_OFF);
  }

  async verifySeller(promoterId: string, input: VerifySellerInput): Promise<void> {
    this.verifications.push({ promoterId, input: { ...input } });
    if (this.verifyError) throw this.verifyError;
  }

  reset(): void {
    this.registers.length = 0;
    this.reads.length = 0;
    this.verifications.length = 0;
    this.views.clear();
    this.registerAnswer = { holderChecked: true };
    this.readError = undefined;
    this.verifyError = undefined;
  }
}
