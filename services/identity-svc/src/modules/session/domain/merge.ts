// 계정 병합의 규칙(docs/features/identity.md §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042, POL-034, I-T31·I-T32).
// 대표 계정 고르기, 세 서비스의 막는 사유를 openapi MergeProposal.blockers 코드로 옮기기, 요약 만들기. 저장소·호출은 모른다.
import type { Provider } from './session.js';

/** 병합 제안의 수명 10분(docs/data.md id:merge) */
export const MERGE_PROPOSAL_TTL_MS = 10 * 60_000;
/** CheckAccountMerge 한 번의 기한 [가정](identity §2.1) */
export const MERGE_CHECK_DEADLINE_MS = 1_000;
/** CLOSED account_hold 행을 남기는 기간 [가정](늦게 온 열림을 무시하려고) */
export const ACCOUNT_HOLD_CLOSED_KEEP_MS = 30 * 86_400_000;

/** openapi MergeProposal.blockers */
export type MergeBlocker = 'ACTIVE_PURCHASE_SESSION' | 'PENDING_PAYMENT' | 'QUOTA_EXCEEDED' | 'BOTH_VERIFIED' | 'WITHDRAWAL_IN_PROGRESS' | 'APPEAL_PENDING' | 'ENTRY_STARTED';
export const BLOCKER_ORDER: readonly MergeBlocker[] = ['ACTIVE_PURCHASE_SESSION', 'PENDING_PAYMENT', 'QUOTA_EXCEEDED', 'BOTH_VERIFIED', 'WITHDRAWAL_IN_PROGRESS', 'APPEAL_PENDING', 'ENTRY_STARTED'];

/** 세 서비스의 CheckAccountMerge가 돌려준 사유(proto enum 이름에서 접두어를 뗀 값) */
export type CheckBlock =
  | { service: 'purchase'; reason: 'SEAT_HOLD' | 'PURCHASE_SESSION' | 'PAYMENT_PENDING_ORDER' }
  | { service: 'ticket'; reason: 'ABSORBED_HAS_TICKETS' | 'TICKET_IN_ENTRY_WINDOW' }
  | { service: 'core'; reason: 'ABSORBED_HAS_REVIEWS' | 'LIMITED_MERCH_OVER_LIMIT' };

export interface CheckResult {
  blocks: CheckBlock[];
  /** 흡수 계정의 옮겨질·함께 보일 수(그 서비스 몫만) */
  counts: Partial<Record<'orders' | 'wishes' | 'subscriptions' | 'addresses', number>>;
}

/** openapi MergeProposal.moved */
export interface MovedSummary {
  tickets: number;
  orders: number;
  wishes: number;
  reviews: number;
  subscriptions: number;
  addresses: number;
  providers: number;
}

export interface StoredMergeProposal {
  id: string;
  /** 제안한 계정·세션(지금 로그인한 쪽). 조회·확정은 이 계정만 */
  requesterAccountId: string;
  requesterSessionId: string;
  primaryAccountId: string;
  absorbedAccountId: string;
  /** 추가하려던 제공자(다른 계정의 것. 그 계정이 대표면 흡수되는 쪽은 지금 계정이다) */
  newProvider: Provider;
  /** 그 제공자의 사용자 ID(sub). 확정 때 아직 다른 계정의 것인지 본다(새 맥락 리뷰 낮음 12) */
  newProviderUserId: string;
  status: 'PROPOSED' | 'BLOCKED';
  blockers: MergeBlocker[];
  /** 남는 계정이 본인확인을 마쳤는가(제안을 만든 때, 화면 문구 '본인확인한 계정', BOT-043) */
  primaryVerified: boolean;
  /** 흡수 계정에 티켓·후기가 있다(불변식 위반, SEV3) */
  invariantViolated: boolean;
  moved: MovedSummary;
  createdAt: number;
  expiresAt: number;
}

/** 대표 계정: 본인확인을 마친 쪽, 둘 다 아니면 지금 계정, 둘 다면 막는다(BOTH_VERIFIED, POL-034) */
export function choosePrimary(i: { current: string; other: string; currentVerified: boolean; otherVerified: boolean }): { primary: string; absorbed: string; bothVerified: boolean } {
  if (i.currentVerified && i.otherVerified) return { primary: i.current, absorbed: i.other, bothVerified: true };
  if (i.otherVerified) return { primary: i.other, absorbed: i.current, bothVerified: false };
  return { primary: i.current, absorbed: i.other, bothVerified: false };
}

/** 서비스 사유 → 화면 사유. 불변식 위반(흡수 계정의 티켓·후기)은 사유 목록이 아니라 따로 센다 */
export function mapBlocks(blocks: readonly CheckBlock[]): { blockers: MergeBlocker[]; invariantViolated: boolean } {
  const set = new Set<MergeBlocker>();
  let invariantViolated = false;
  for (const b of blocks) {
    if (b.reason === 'SEAT_HOLD' || b.reason === 'PURCHASE_SESSION') set.add('ACTIVE_PURCHASE_SESSION');
    else if (b.reason === 'PAYMENT_PENDING_ORDER') set.add('PENDING_PAYMENT');
    else if (b.reason === 'TICKET_IN_ENTRY_WINDOW') set.add('ENTRY_STARTED');
    else if (b.reason === 'LIMITED_MERCH_OVER_LIMIT') set.add('QUOTA_EXCEEDED');
    else invariantViolated = true;
  }
  return { blockers: BLOCKER_ORDER.filter((x) => set.has(x)), invariantViolated };
}

/** 세 서비스 결과와 identity 사유로 상태·사유·요약을 만든다 */
export function summarize(i: { checks: readonly CheckResult[]; identityBlockers: readonly MergeBlocker[]; absorbedProviders: number }): Pick<StoredMergeProposal, 'status' | 'blockers' | 'invariantViolated' | 'moved'> {
  const { blockers, invariantViolated } = mapBlocks(i.checks.flatMap((c) => c.blocks));
  const all = BLOCKER_ORDER.filter((x) => blockers.includes(x) || i.identityBlockers.includes(x));
  const sum = (k: 'orders' | 'wishes' | 'subscriptions' | 'addresses') => i.checks.reduce((n, c) => n + Math.max(0, Math.floor(c.counts[k] ?? 0)), 0);
  return {
    status: all.length > 0 || invariantViolated ? 'BLOCKED' : 'PROPOSED',
    blockers: all,
    invariantViolated,
    moved: { tickets: 0, reviews: 0, orders: sum('orders'), wishes: sum('wishes'), subscriptions: sum('subscriptions'), addresses: sum('addresses'), providers: i.absorbedProviders },
  };
}
