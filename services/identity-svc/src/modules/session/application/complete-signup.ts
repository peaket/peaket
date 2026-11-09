// 가입 마무리(openapi POST /v1/identity/signup-completions, ADR-0203 결정 1·2, ADR-0235 결정 4, BUILD_ORDER BOT-047, I-T79·I-T80).
// 계정을 잠그고 → 이미 마쳤는지 보고 → 닉네임 키를 잠근 뒤 쓰인 키인지 보고 → 한 트랜잭션에 쓴다(잠금 차례 계정 → 닉네임 키). 고지 문안 판과 시각은 서버가 정한다.
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SESSION_SIGNALS, SESSION_STORE, type SessionSignals, type SessionStore, type SessionTx } from '../domain/ports.js';
import { CONSENT_NOTICE_VERSIONS, type ConsentKind, MARKETING_CHANNELS, memberCodeFrom, nicknameKey, nicknameProblem, normalizeNickname, signupCompleted } from '../domain/signup.js';
import { AccountError } from './account-error.js';
import { type FanAccountSummaryView, GetAccountSummary, requireLiveSession } from './get-account-summary.js';

export type SignupErrorCode = 'NICKNAME_INVALID' | 'NICKNAME_TAKEN' | 'ALREADY_COMPLETED' | 'UNDER_14';

/** 가입 마무리의 업무 오류(받는 층이 RFC 9457 오류로 바꾼다) */
export class SignupError extends Error {
  constructor(readonly code: SignupErrorCode) {
    super(`가입 마무리 실패: ${code}`);
    this.name = 'SignupError';
  }
}

/** 계약 SignupCompletionInput을 통과한 값 */
export interface SignupInput {
  ageOver14: true;
  consents: { terms: true; privacy: true; marketing: boolean; phone: boolean };
  nickname: string;
  phone?: string;
}

/** 회원 코드가 겹치면 다시 뽑는 횟수 [가정] */
const MEMBER_CODE_TRIES = 5;

async function newMemberCode(tx: SessionTx): Promise<string> {
  for (let i = 0; i < MEMBER_CODE_TRIES; i++) {
    const code = memberCodeFrom(randomBytes(7));
    if (!(await tx.memberCodeTaken(code))) return code;
  }
  throw new Error('회원 코드를 고르지 못했다');
}

@Injectable()
export class CompleteSignup {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    private readonly summary: GetAccountSummary,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
  ) {}

  /** @throws SignupError @throws AccountError SESSION_ENDED */
  async run(i: { accountId: string; sessionId: string; input: SignupInput }): Promise<FanAccountSummaryView> {
    const { accountId } = await requireLiveSession(this.store, this.clock, i);
    const problem = nicknameProblem(i.input.nickname);
    if (problem !== null) throw new SignupError('NICKNAME_INVALID');
    const nickname = normalizeNickname(i.input.nickname);
    const key = nicknameKey(nickname);
    const now = this.clock.now();
    await this.store.transaction(async (tx) => {
      await tx.lockAccount(accountId);
      const state = await tx.signupStateOf(accountId);
      if (!state || state.status !== 'ACTIVE') {
        // 만 14세 미만으로 정리 중인 계정은 화면이 그 안내를 보이게 따로 답한다(403 under-14, 본인확인과 같다, ADR-0235 결정 6)
        if ((await tx.closureReasonOf(accountId)) === 'UNDER_14') throw new SignupError('UNDER_14');
        throw new AccountError('SESSION_ENDED', '가입을 마칠 수 없는 계정이다');
      }
      if (signupCompleted(state.ageVerified, state.consentKinds)) throw new SignupError('ALREADY_COMPLETED');
      await tx.lockNicknameKey(key);
      if (await tx.nicknameKeyTaken(key)) throw new SignupError('NICKNAME_TAKEN');
      const consent = (kind: ConsentKind, channels: string | null = null) => ({ kind, noticeVersion: CONSENT_NOTICE_VERSIONS[kind], channels });
      const consents = [consent('TERMS'), consent('PRIVACY_REQUIRED')];
      if (i.input.consents.phone) consents.push(consent('PRIVACY_PHONE'));
      if (i.input.consents.marketing) consents.push(consent('MARKETING', MARKETING_CHANNELS));
      await tx.completeSignup({ accountId, nickname, nicknameKey: key, phone: i.input.consents.phone ? (i.input.phone ?? null) : null, memberCode: await newMemberCode(tx), consents, now });
    });
    this.signals.signupCompleted(i.input.consents.marketing);
    return this.summary.of(accountId);
  }
}
