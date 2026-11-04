// identity-svc의 정비 일(relay 프로세스의 정비 리더가 돈다, packages/platform MaintenanceRunner). 플랫폼 공용 일과 함께 넘긴다.
// 탈퇴 뒤 정리와 만 14세 미만 정리 마무리(withdrawal-finish), 끝난 세션의 리프레시 토큰 해시(R-255), 쓴 재인증 토큰 기록,
// 다른 계정 시도 기록 1년(BOT-020), 보존 전용 표의 연계정보 처리 기록 1년(docs/features/identity.md §5·§8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030)
import type { Clock, Database, MaintenanceTask } from '@peaket/platform';
import { ACCOUNT_HOLD_CLOSED_KEEP_MS, BackfillContactRefs, DrizzleSessionStore, FinishWithdrawals, type InvRefKeyRing } from './modules/session/index.js';
import { DrizzleVerificationStore, VerificationEraser } from './modules/verification/index.js';

/** 다른 계정 시도 기록을 남기는 기간 [가정](docs/data.md identity_conflict_attempt) */
const CONFLICT_ATTEMPT_KEEP_MS = 365 * 86_400_000;

/** 한 번에 다시 계산할 EMAIL 연락처 가명 수 [가정] */
const CONTACT_REF_BACKFILL_BATCH = 1_000;

/** invRefs: 조사용 가명 라벨 키 링(없으면 연락처 가명 다시 계산을 건너뛴다) */
export function identityMaintenanceTasks(database: Database, clock: Clock, invRefs?: InvRefKeyRing): MaintenanceTask[] {
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
  const finish = new FinishWithdrawals(sessions, new VerificationEraser(verifications), clock);
  return [
    { name: 'withdrawal-finish', when: 'daily', run: (signal) => finish.run(signal) },
    { name: 'refresh-hash-expired', when: 'daily', run: (signal) => sessions.purgeExpiredRefreshHashes(clock.now(), signal) },
    { name: 'reauth-use-expired', when: 'daily', run: () => sessions.purgeReauthUses(clock.now()) },
    { name: 'conflict-attempt-purge', when: 'window', run: () => verifications.purgeConflictAttempts(clock.now() - CONFLICT_ATTEMPT_KEEP_MS) },
    { name: 'verification-record-purge', when: 'window', run: () => verifications.purgeVerificationRecords(clock.now()) },
    { name: 'restricted-hold-expired', when: 'daily', run: () => verifications.purgeExpiredHolds(clock.now()) },
    // 닫힌 이의 제기·소명 계류 행은 30일 [가정] 뒤 지운다(docs/data.md account_hold, BOT-042)
    { name: 'account-hold-closed', when: 'daily', run: () => sessions.transaction((tx) => tx.purgeClosedHolds(clock.now() - ACCOUNT_HOLD_CLOSED_KEEP_MS)) },
    // 라벨 키가 없어 가입 때 쓰지 못한 EMAIL 연락처 가명을 account.email로 채운다(identity §9.1 '조사용 값의 첫 구현', BOT-045)
    ...(invRefs
      ? [{ name: 'contact-ref-backfill', when: 'daily' as const, run: async () => { await invRefs.refresh(); return new BackfillContactRefs(sessions, invRefs, clock).run(CONTACT_REF_BACKFILL_BATCH); } }]
      : []),
  ];
}
