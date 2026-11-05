// identity-svc의 정비 일(relay 프로세스의 정비 리더가 돈다, packages/platform MaintenanceRunner). 플랫폼 공용 일과 함께 넘긴다.
// 탈퇴 뒤 정리와 만 14세 미만 정리 마무리(withdrawal-finish), 끝난 세션의 리프레시 토큰 해시(R-255), 쓴 재인증 토큰 기록,
// 다른 계정 시도 기록 1년(BOT-020), 보존 전용 표의 연계정보 처리 기록 1년(docs/features/identity.md §5·§8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030)
import type { Clock, Database, MaintenanceTask } from '@peaket/platform';
import { AdminAccountStoreForMaintenance, DEFAULT_ADMIN_AUTH_CONFIG } from './modules/admin/index.js';
import { ACCOUNT_HOLD_CLOSED_KEEP_MS, BackfillContactRefs, CloseInvRefBridge, DrizzleSessionStore, FinishWithdrawals, InvRefKeyRing, RotateContactRefs } from './modules/session/index.js';
import { DrizzleVerificationStore, VerificationEraser } from './modules/verification/index.js';

/** 관리 재인증 기록을 남기는 기간 [가정](docs/data.md admin_reauth, BOT-122) */
const ADMIN_REAUTH_KEEP_MS = 90 * 86_400_000;

/** 다른 계정 시도 기록을 남기는 기간 [가정](docs/data.md identity_conflict_attempt) */
const CONFLICT_ATTEMPT_KEEP_MS = 365 * 86_400_000;

/** 한 번에 다시 계산할 EMAIL 연락처 가명 수 [가정] */
const CONTACT_REF_BACKFILL_BATCH = 1_000;

/** invRefs: 조사용 가명 라벨 키 링(없으면 연락처 가명 다시 계산을 건너뛴다). bridges: 키 회전의 이음 설정(옛 판 지우기, BOT-046) */
export function identityMaintenanceTasks(database: Database, clock: Clock, invRefs?: InvRefKeyRing, bridges?: ReturnType<typeof InvRefKeyRing.bridgesFromEnv>, knownSourceWindowMs = DEFAULT_ADMIN_AUTH_CONFIG.knownSourceWindowMs): MaintenanceTask[] {
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
  const finish = new FinishWithdrawals(sessions, new VerificationEraser(verifications), clock);
  return [
    { name: 'withdrawal-finish', when: 'daily', run: (signal) => finish.run(signal) },
    { name: 'refresh-hash-expired', when: 'daily', run: (signal) => sessions.purgeExpiredRefreshHashes(clock.now(), signal) },
    { name: 'reauth-use-expired', when: 'daily', run: () => sessions.purgeReauthUses(clock.now()) },
    // 유휴 만료로 끝난 세션의 화면용 기기 이름은 그 세션의 절대 만료 뒤 비운다(끝낸 세션은 끝낼 때 비운다, docs/data.md session.device_label, BOT-044, ADR-0209)
    { name: 'session-label-expired', when: 'daily', run: (signal) => sessions.clearEndedDeviceLabels(clock.now(), signal) },
    { name: 'conflict-attempt-purge', when: 'window', run: () => verifications.purgeConflictAttempts(clock.now() - CONFLICT_ATTEMPT_KEEP_MS) },
    { name: 'verification-record-purge', when: 'window', run: () => verifications.purgeVerificationRecords(clock.now()) },
    { name: 'restricted-hold-expired', when: 'daily', run: () => verifications.purgeExpiredHolds(clock.now()) },
    // 관리 계정 익숙한 출발지는 마지막 성공에서 30일 [가정] 지나면 지운다(docs/data.md admin_known_source, BOT-123)
    { name: 'admin-known-source-expired', when: 'daily', run: () => new AdminAccountStoreForMaintenance(database, clock).purgeKnownSources(clock.now() - knownSourceWindowMs) },
    // 관리 계정 로그인 단계 행은 만든 지 2일 [가정] 지나면 지운다(5분 수명, 비밀번호만 맞은 로그인 찾기는 만든 지 1일 10분 안, docs/data.md admin_login_step)
    { name: 'admin-login-step-expired', when: 'daily', run: () => new AdminAccountStoreForMaintenance(database, clock).purgeLoginSteps(clock.now() - 2 * 24 * 60 * 60_000) },
    // 관리 리프레시 토큰 발급 해시는 그 세션의 절대 만료가 지나면 지운다(docs/data.md admin_refresh_token_hash, BOT-130)
    { name: 'admin-refresh-hash-expired', when: 'daily', run: () => new AdminAccountStoreForMaintenance(database, clock).purgeRefreshHashes(clock.now()) },
    // 관리 계정 초대는 보낸 때부터 24시간 지나면 만료로 바꾸고 토큰 해시를 지운다(docs/data.md admin_account.invite_expires_at, BOT-150)
    { name: 'admin-invite-expired', when: 'daily', run: () => new AdminAccountStoreForMaintenance(database, clock).expireInvites(clock.now()) },
    // 관리 계정 관리 호출의 멱등 기록은 30일 [가정] 뒤 지운다(docs/data.md admin_account_request, BOT-150)
    { name: 'admin-account-request-expired', when: 'daily', run: () => new AdminAccountStoreForMaintenance(database, clock).purgeRequests(clock.now() - 30 * 24 * 60 * 60_000) },
    // 관리 재인증 기록은 발급에서 90일 [가정] 뒤 지운다(docs/data.md admin_reauth, BOT-122. 법정 접속기록은 접속기록 저장소 단계가 옮긴다)
    { name: 'admin-reauth-expired', when: 'daily', run: () => new AdminAccountStoreForMaintenance(database, clock).purgeReauths(clock.now() - ADMIN_REAUTH_KEEP_MS) },
    // 닫힌 이의 제기·소명 계류 행은 30일 [가정] 뒤 지운다(docs/data.md account_hold, BOT-042)
    { name: 'account-hold-closed', when: 'daily', run: () => sessions.transaction((tx) => tx.purgeClosedHolds(clock.now() - ACCOUNT_HOLD_CLOSED_KEEP_MS)) },
    // 라벨 키가 없어 가입 때 쓰지 못한 EMAIL 연락처 가명을 account.email로 채운다(identity §9.1 '조사용 값의 첫 구현', BOT-045)
    ...(invRefs
      ? [
          { name: 'contact-ref-backfill', when: 'daily' as const, run: async () => { await invRefs.refresh(); return new BackfillContactRefs(sessions, invRefs, clock).run(CONTACT_REF_BACKFILL_BATCH); } },
          // 키 회전의 이음 기간에 EMAIL 연락처 가명을 새 판으로(옛 값은 ref_prev, BOT-046)
          { name: 'contact-ref-rotate', when: 'daily' as const, run: async () => { await invRefs.refresh(); return new RotateContactRefs(sessions, invRefs, bridges ?? invRefs, clock).run(CONTACT_REF_BACKFILL_BATCH); } },
        ]
      : []),
    // 이음 끝 + 7일 [가정]이 지나면 옛 판 값과 옛 판으로 남은 기기 행을 지운다(BOT-046)
    ...(bridges
      ? [{ name: 'inv-ref-bridge-close', when: 'daily' as const, run: async () => { const r = await new CloseInvRefBridge(sessions, bridges, clock).run(); return (r.device?.cleared ?? 0) + (r.device?.removed ?? 0) + (r.contact?.cleared ?? 0); } }]
      : []),
  ];
}
