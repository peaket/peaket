// 이의 내용 읽기·결과 반영(queue.proto VerificationAppealService, 부르는 쪽은 ops-svc만, docs/features/bot-defense.md §12 '결과 반영', ADR-0259 결정 5).
// 결과 반영은 건 ID·판 번호로 멱등이다. 판이 저장한 판보다 클 때만 반영하고, 거절 판정 뒤에 건 ID 색인 q:appealcase를 SET NX로 잡아 같은 건에 다른 이의가 오면 ALREADY_EXISTS다.
// 사람 키(q:appeal)와 회차 키(verify)는 슬롯이 달라 한 Lua로 묶지 못한다(docs/data.md §5 경합 ③): 사람 슬롯에 진행 표지(건·판·결과)를 남기고 →
// 회차 슬롯 Lua가 VERIFYING일 때만 PASSED(인정)·BLOCKED(기각)로 바꾸고 → 사람 슬롯의 판 번호·결과를 뒤에 올린다.
// 회차 쓰기 뒤 판 번호를 올리기 전에 끊기면 다시 부른 호출이 진행 표지로 제 쓰기를 알아보아 같은 결과(APPLIED)를 낸다.
// 이미 PASSED·BLOCKED로 바뀌었거나 끝난 대기 참여는 바꾸지 않는다(NOT_ISOLATED). 라벨 반영(trust-svc ApplyLabel)은 ops-svc가 따로 부른다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Clock, CLOCK, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { VERIFICATION_STORE, type VerificationStore } from '../domain/ports.js';
import { type AppealOutcome, outcomeState, parseVerify, protoReasonOf, type ResolveResult, type StoredAppeal } from '../domain/verification.js';
import { VerificationError } from './verification-error.js';

/** queue.proto AppealEntryState */
export type AppealEntryState = 'VERIFYING' | 'PASSED' | 'ENDED';

export interface AppealView {
  appealId: string;
  eventId: string;
  accountId: string;
  pid: string;
  text: string;
  /** trust.proto ReasonCategory 이름 */
  reasonCategory: string;
  receivedAtMs: number;
  entryState: AppealEntryState;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 건 ID는 키의 해시 태그 안에 들어가므로 모양을 묻는다 */
const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function load(store: VerificationStore, appealId: string): Promise<{ eventId: string; pid: string; appeal: StoredAppeal }> {
  if (!UUID.test(appealId)) throw new VerificationError('INVALID', '이의 ID 모양이 틀렸다');
  const at = await store.findAppeal(appealId);
  const appeal = at ? await store.readAppeal(at.pid, at.eventId) : null;
  // 보관 기간이 지났거나 같은 사람 키를 새 대기 참여의 이의가 차지했다
  if (!at || !appeal || appeal.appealId !== appealId) throw new VerificationError('APPEAL_NOT_FOUND', '이의가 없다');
  return { ...at, appeal };
}

@Injectable()
export class GetVerificationAppeal {
  constructor(@Inject(VERIFICATION_STORE) private readonly store: VerificationStore) {}

  async run(appealId: string): Promise<AppealView> {
    const { eventId, pid, appeal } = await load(this.store, appealId);
    const v = parseVerify(await this.store.readVerify(eventId, appeal.fieldHash));
    const entryState: AppealEntryState = v?.state === 'VERIFYING' ? 'VERIFYING' : v?.state === 'PASSED' ? 'PASSED' : 'ENDED';
    return { appealId, eventId, accountId: appeal.accountId, pid, text: appeal.text, reasonCategory: protoReasonOf(appeal.reason), receivedAtMs: appeal.receivedAtMs, entryState };
  }
}

export interface ResolveInput {
  appealId: string;
  caseId: string;
  caseVersion: number;
  outcome: AppealOutcome;
}

@Injectable()
export class ResolveVerificationAppeal {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  async run(i: ResolveInput): Promise<ResolveResult> {
    if (!CASE_ID.test(i.caseId)) throw new VerificationError('INVALID', '건 ID 모양이 틀렸다');
    if (!Number.isSafeInteger(i.caseVersion) || i.caseVersion < 1) throw new VerificationError('INVALID', '판 번호는 1 이상의 정수다');
    if (i.outcome !== 'ACCEPTED' && i.outcome !== 'REJECTED') throw new VerificationError('INVALID', '결과가 없다');
    const { eventId, pid, appeal } = await load(this.store, i.appealId);
    const begin = await this.store.beginResolve(pid, eventId, i.appealId, { caseId: i.caseId, version: i.caseVersion, outcome: i.outcome });
    if (begin.kind === 'NOT_FOUND') throw new VerificationError('APPEAL_NOT_FOUND', '이의가 없다');
    if (begin.kind === 'OTHER_CASE') throw new VerificationError('CASE_CONFLICT', '이 이의는 다른 건에 묶였다');
    if (begin.kind === 'UNCHANGED') {
      this.#log(i, 'UNCHANGED', eventId);
      return 'UNCHANGED';
    }
    // 건 ID 색인은 거절 판정(없는 이의·다른 건에 묶인 이의) 뒤에 잡는다: 거절된 호출이 그 건 ID를 남이 쓰지 못하게 남기지 않게(리뷰 R11)
    const owner = await this.store.claimCase(i.caseId, i.appealId, appeal.expireAtMs);
    if (owner !== i.appealId) throw new VerificationError('CASE_CONFLICT', '같은 건 ID에 다른 이의가 묶였다');
    const target = outcomeState(i.outcome);
    const s = await this.store.settleVerify(eventId, appeal.fieldHash, target);
    // 다시 부른 호출이 제 앞 쓰기(같은 건·판·결과)를 만나면 같은 결과다
    const mine = s.kind === 'CURRENT' && begin.retry && parseVerify(s.value)?.state === target;
    const result: ResolveResult = s.kind === 'APPLIED' || mine ? 'APPLIED' : 'NOT_ISOLATED';
    await this.store.commitResolve(pid, eventId, i.appealId, { caseId: i.caseId, version: i.caseVersion, outcome: i.outcome, result });
    this.#log(i, result, eventId);
    return result;
  }

  /** 보안 로그 줄(이의 ID·건 ID·판·결과·회차·시각, ASVS 16.3.3) */
  #log(i: ResolveInput, result: ResolveResult, eventId: string): void {
    this.logger?.info({ kind: 'security', event: 'queue_verification_appeal_resolved', eventId, appealId: i.appealId, caseId: i.caseId, caseVersion: i.caseVersion, outcome: i.outcome, result, at: new Date(this.clock.now()).toISOString() }, '이의 결과 반영');
  }
}
