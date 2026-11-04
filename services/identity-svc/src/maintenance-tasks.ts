// identity-svc의 정비 일(relay 프로세스의 정비 리더가 돈다, packages/platform MaintenanceRunner). 플랫폼 공용 일과 함께 넘긴다.
// 탈퇴 뒤 정리와 만 14세 미만 정리 마무리(withdrawal-finish), 끝난 세션의 리프레시 토큰 해시(R-255), 쓴 재인증 토큰 기록,
// 다른 계정 시도 기록 1년(BOT-020), 보존 전용 표의 연계정보 처리 기록 1년(docs/features/identity.md §5·§8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030)
import type { Clock, Database, MaintenanceTask } from '@peaket/platform';
import { DrizzleSessionStore, FinishWithdrawals } from './modules/session/index.js';
import { DrizzleVerificationStore, VerificationEraser } from './modules/verification/index.js';

/** 다른 계정 시도 기록을 남기는 기간 [가정](docs/data.md identity_conflict_attempt) */
const CONFLICT_ATTEMPT_KEEP_MS = 365 * 86_400_000;

export function identityMaintenanceTasks(database: Database, clock: Clock): MaintenanceTask[] {
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
  ];
}
