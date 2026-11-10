// 추가 검증 상태 읽기(openapi GET /v1/queues/{eventId}/verification, ADR-0259 결정 3·12). 화면(SCR-009)이 새로고침 뒤 사유 범주·통과 경로·유예 마감·이의 접수 여부를 되살린다.
// 읽기만 한다(trust-svc·identity-svc를 부르지 않고 아무것도 바꾸지 않는다). 이의는 건 요청 발행이 확인된 것만 '접수'로 보인다
// (발행이 실패해 503을 받은 이의를 '접수됨'으로 보이면 화면이 다시 보내지 않는다). 이의 글은 본인에게만 돌려준다(이 경로는 그 계정의 q:dup으로만 찾는다).
// 통과 경로(passedVia)는 정본에 저장 자리가 없어 지금 키에서 끌어낸다: 같은 대기 참여의 이의 결과 반영이 verify 칸을 바꿨으면(q:appeal의 ap = ACCEPTED) APPEAL, 아니면 CHALLENGE.
// 결과 반영이 회차 쓰기 뒤 판 쓰기 전에 끊긴 동안(작업 워커가 다시 부르기 전)은 CHALLENGE로 보인다(verify 값 모양을 바꾸지 않으려고 고른 대가).
import { Inject, Injectable } from '@nestjs/common';
import type { EventSchedules } from '../../entry/index.js';
import { VERIFICATION_OPTIONS, VERIFICATION_SCHEDULES, VERIFICATION_STORE, type VerificationStore } from '../domain/ports.js';
import { reasonOf, type ReasonCategory, type StoredAppeal, type VerificationOptions } from '../domain/verification.js';
import { type Caller, findEntry, graceUntilOf, personsOf, scheduleOf, seqOf } from './entries.js';
import { VerificationError } from './verification-error.js';

/** 200 본문(openapi QueueVerificationState) */
export interface VerificationState {
  state: 'VERIFYING' | 'PASSED' | 'BLOCKED';
  /** PASSED일 때만: CHALLENGE 제출로 통과, APPEAL 이의 인정으로 통과 */
  passedVia: 'CHALLENGE' | 'APPEAL' | null;
  /** PASSED이고 차례가 지났을 때만: 차례와 통과 가운데 늦은 때 + 유예 */
  graceUntil: string | null;
  verificationReason: ReasonCategory | null;
  appeal: { appealId: string; receivedAt: string; text: string } | null;
}

@Injectable()
export class ReadVerification {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(VERIFICATION_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(VERIFICATION_OPTIONS) private readonly options: VerificationOptions,
  ) {}

  async run(i: Caller): Promise<VerificationState> {
    await scheduleOf(this.schedules, i.eventId);
    // 대기 참여가 없을 때만 404다
    const entry = await findEntry(this.store, i);
    const v = entry.verify;
    // 대기 참여는 있는데 추가 검증 칸이 없다(추가 검증으로 보내지 않았거나 대기 취소·1인 1순번 위반으로 지워짐): 제출과 같은 409
    if (!v || v.state === 'ORPHAN' || !entry.fieldHash) throw new VerificationError('NOT_VERIFYING', '추가 검증 중인 대기 참여가 아니다');
    // 이 대기 참여의 이의(pid 키 전환 기간에는 옛 pid부터)
    let mine: StoredAppeal | null = null;
    for (const pid of personsOf(i)) {
      const a = await this.store.readAppeal(pid, i.eventId);
      if (a && a.fieldHash === entry.fieldHash) {
        mine = a;
        break;
      }
    }
    const passed = v.state === 'PASSED';
    return {
      state: v.state,
      passedVia: passed ? (mine?.appliedOutcome === 'ACCEPTED' ? 'APPEAL' : 'CHALLENGE') : null,
      graceUntil: passed ? await graceUntilOf(this.store, i.eventId, await seqOf(this.store, entry), v.atMs, this.options.graceMs) : null,
      verificationReason: reasonOf(v.reason),
      appeal: mine?.sent ? { appealId: mine.appealId, receivedAt: new Date(mine.receivedAtMs).toISOString(), text: mine.text } : null,
    };
  }
}
