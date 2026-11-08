// 세션 컨텍스트의 포트: 저장소(트랜잭션 하나에서 쓰는 일), 토큰 서명, 기기 가명, 운영 신호.
import type { InvRefLabel } from './inv-ref.js';
import type { ConsentKind } from './signup.js';
import type { ActiveSession, LiveSession, LoginVerdict, Provider, ReauthPurpose, ReauthStrength, TerminationReason } from './session.js';

export interface CreateKeyRecord {
  provider: Provider;
  providerUserId: string;
  sessionId: string;
  /** 처음 응답의 new_account(다시 보낼 때 같은 값을 준다) */
  newAccount: boolean;
}

export type AccountStatus = 'ACTIVE' | 'WITHDRAWAL_PENDING' | 'MERGED' | 'DELETED';

export interface AccountRow {
  id: string;
  status: AccountStatus;
}

export interface SessionRow {
  id: string;
  accountId: string;
  deviceId: string | null;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  terminatedAt: number | null;
  /** 끝난 까닭(세션을 끝낼 때 적는다, ADR-0235 결정 1). 끝나지 않았거나 그 칸 전에 끝난 세션은 null */
  terminatedReason: string | null;
  loginVerdict: LoginVerdict;
  refreshFamily: string;
}

/** 가입 마무리 상태(계정 행과 동의 행, ADR-0235 결정 3). 계정이 없으면 null */
export interface SignupState {
  status: AccountStatus;
  nickname: string | null;
  ageVerified: boolean;
  consentKinds: string[];
}

/** 가입 마무리의 저장(한 트랜잭션, ADR-0203 결정 1, ADR-0235 결정 4) */
export interface SignupRecord {
  accountId: string;
  nickname: string;
  nicknameKey: string;
  phone: string | null;
  memberCode: string;
  consents: ReadonlyArray<{ kind: ConsentKind; noticeVersion: string; channels: string | null }>;
  now: number;
}

export interface NewSession {
  id: string;
  accountId: string;
  deviceId: string | null;
  refreshHash: Uint8Array;
  refreshFamily: string;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
  /** 로그인 판정(identity §7). trust-svc가 생기기 전에는 UNKNOWN(판정을 받지 못함, identity §2 '첫 구현') */
  loginVerdict: LoginVerdict;
  createdAt: number;
  /** 화면용 기기 이름(application/device-label.ts, ADR-0209). 마지막 활동은 createdAt으로 시작한다 */
  deviceLabel: string | null;
}

/** 갱신에 쓰려고 리프레시 토큰 해시로 찾은 세션(쓰기 잠금) */
export interface RefreshRow extends SessionRow {
  match: 'current' | 'previous' | 'history';
  rotatedAt: number | null;
  refreshUsed: boolean;
}

/** 트랜잭션 하나 안에서 하는 일. 저장소 어댑터가 트랜잭션·잠금을 맡는다 */
export interface SessionTx {
  /**
   * 그 멱등 키로 들어온 다른 요청이 끝날 때까지 기다린 뒤(같은 키는 한 번에 하나만), 기억하는 기록을 돌려준다.
   * 10분이 지난 기록은 잊는다(지우고 null)
   */
  lockCreateKey(key: string, now: number): Promise<CreateKeyRecord | null>;
  saveCreateKey(key: string, rec: CreateKeyRecord, now: number): Promise<void>;
  /** 같은 (제공자, provider_user_id)의 로그인이 겹치면 한 번에 하나만 계정을 찾고 만든다(트랜잭션 끝까지) */
  lockProvider(provider: Provider, providerUserId: string): Promise<void>;
  /** 계정 단위로 기기 수를 세고 정리하는 일을 한 번에 하나만 한다(트랜잭션 끝까지) */
  lockAccount(accountId: string): Promise<void>;
  findAccountByProvider(provider: Provider, providerUserId: string): Promise<AccountRow | null>;
  /** emailVerified: 제공자가 준 이메일 검증 여부(가입 때 연결 제안의 대상 조건, identity §2.1) */
  createAccount(input: { id: string; email: string | null; emailVerified?: boolean }, now: number): Promise<void>;
  /** 가입 때 연결 제안의 대상 후보: 이메일(normalizeEmail 값)이 같고 검증 표시가 있는 ACTIVE 계정과 그 로그인 수단(처음 연결한 순). 최대 2개(하나인지만 본다) */
  findLinkTargets(email: string): Promise<{ accountId: string; providers: Provider[] }[]>;
  linkProvider(accountId: string, provider: Provider, providerUserId: string, now: number): Promise<void>;
  isProviderLinked(accountId: string, provider: Provider, providerUserId: string): Promise<boolean>;
  /** 그 계정에 연결된 로그인 수단(연결한 순서) */
  providersOf(accountId: string): Promise<{ provider: Provider; linkedAt: number; lastLoginAt: number | null }[]>;
  /** 그 (제공자, sub)로 로그인 세션을 만들었다(SCR-040 '최근 로그인', BOT-041) */
  touchProviderLogin(provider: Provider, providerUserId: string, now: number): Promise<void>;
  /** 그 계정의 그 종류 로그인 수단을 지운다. 지운 행 수 */
  unlinkProvider(accountId: string, provider: Provider): Promise<number>;
  /** 로그인 수단 연결·해제 사건을 Outbox에 적는다. 트랜잭션의 마지막 쓰기다(identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BOT-041) */
  recordLoginMethodChanged(i: { accountId: string; change: 'LINKED' | 'UNLINKED'; provider: Provider; occurredAt: number }): Promise<void>;
  /**
   * 그 계정에 본인확인 기록이 있는가(병합 확정이 두 계정을 잠근 뒤 대표 계정을 다시 고른다, 새 맥락 리뷰 높음 1).
   * 본인확인 컨텍스트의 표를 같은 DB 트랜잭션에서 읽는다(본인확인 확정은 계정을 공유 잠금으로 읽으므로 잠근 뒤의 값이 맞다). 표를 보지 못하는 저장소는 null
   */
  verifiedOf(accountId: string): Promise<boolean | null>;
  /** 그 계정의 열린(OPEN) 이의 제기·소명 계류 행 수(account_hold, 병합의 APPEAL_PENDING, BOT-042) */
  openHoldsOf(accountId: string): Promise<number>;
  /**
   * account_hold 쓰기: 판 번호가 저장한 판보다 클 때만(같은 source_ref에 다른 계정·종류면 'CONFLICT'). 반영했으면 'APPLIED', 아니면 'STALE'.
   * 그 계정이 identity에 없으면 쓰지 않고 'NOT_FOUND'(account_hold.account_id는 account를 가리키는 외래키다, BOT-042가 넘긴 것)
   */
  setAccountHold(i: { sourceRef: string; accountId: string; kind: 'VERIFICATION_APPEAL' | 'DISPUTE' | 'APPEAL'; state: 'OPEN' | 'CLOSED'; sourceVersion: number; now: number }): Promise<'APPLIED' | 'STALE' | 'CONFLICT' | 'NOT_FOUND'>;
  /** before 전에 닫힌 account_hold 행을 지운다. 지운 수 */
  purgeClosedHolds(before: number): Promise<number>;
  /**
   * 병합 확정의 계정 쓰기(identity §2.1 '계정 병합의 첫 구현'): 흡수 계정의 로그인 수단을 대표 계정으로 옮기고, 흡수 계정의 기기 행도 대표 계정으로 옮긴다
   * (흡수 행의 device_ref·device_ref_prev가 대표 계정 행의 device_ref·device_ref_prev(빈 값 빼고)와 같으면 같은 기기라 흡수 쪽 행을 지운다. 그 행을 가리키던 세션의 기기 칸은 빈다.
   * 흡수 행만 새 판이면(흡수 행의 device_ref_prev가 대표 행의 device_ref) 대표 행이 행 ID 그대로 흡수 행의 두 값을 이어받은 뒤 흡수 행을 지운다, identity §9.1 '병합 때 기기 행', OPEN[22]). 흡수 계정을 MERGED로 바꾸며 이메일·닉네임을 지우고, 흡수 계정을 가리키던 계정도 대표 계정을 가리키게 고친 뒤
   * account_merge 행을 남긴다. 세션 끝내기와 사건은 부르는 쪽이 한다
   */
  mergeAccounts(i: { mergeId: string; primaryAccountId: string; absorbedAccountId: string; mergedProvider: Provider; moved: Record<string, number>; requestedAt: number; now: number }): Promise<void>;
  /** 병합 사건(identity.accounts-merged)을 Outbox에 적는다. 트랜잭션의 마지막 쓰기다 */
  recordAccountMerged(i: { mergeId: string; primaryAccountId: string; mergedAccountId: string; confirmedAt: number }): Promise<void>;
  /** 계정의 그 기기 가명 행 ID. 없으면 만든다 */
  /**
   * 기기 행을 묶고 ID를 돌려준다. prevRef(키 회전의 이음 기간의 옛 판 값)가 있으면: 새 판 값의 행이 없고 옛 판 값의 행이 있으면 그 행을 새 판 값으로 바꾸고
   * device_ref_prev에 옛 판을 둔다(새 기기로 세지 않는다). 새로 묶는 행에도 device_ref_prev를 둔다(identity §9.1 '조사용 가명 키 회전 이음의 첫 구현')
   */
  bindDevice(accountId: string, deviceRef: string, now: number, prevRef?: string): Promise<string>;
  /** 끝나지 않았고 만료 전인 그 계정의 세션 */
  activeSessions(accountId: string, now: number): Promise<ActiveSession[]>;
  /** 끝나지 않은 그 계정의 세션 ID(만료와 상관없이, 쓰기 잠금). 탈퇴가 모두 끝낸다(만료 경계에서 갱신과 겹쳐도 남지 않게) */
  unterminatedSessions(accountId: string): Promise<string[]>;
  /**
   * 세션을 끝내고 그 세션들의 리프레시 토큰 해시와 화면용 기기 이름을 지우며, 같은 트랜잭션에 세션 종료 사건(control.sessions-terminated)을 적는다
   * (ADR-0143 결정 3, R-255, ADR-0209 결정 1)
   */
  terminateSessions(ids: readonly string[], reason: TerminationReason, now: number): Promise<void>;
  /**
   * 사유가 다른 세션들을 한 번에 끝낸다(terminateSessions와 같은 일). 세션 상태를 모두 고친 뒤 사건을 적으므로, 한 트랜잭션에서 사유가 둘인 끝내기도
   * 사건 쓰기가 마지막에 온다(ADR-0116 결정 3, 병합 확정의 MERGED와 LOGIN_METHOD_CHANGED, 새 맥락 리뷰 낮음 3)
   */
  endSessions(items: ReadonlyArray<{ id: string; reason: TerminationReason }>, now: number): Promise<void>;
  /** 탈퇴 사건(pid를 실음)을 이 트랜잭션의 Outbox에 적는다. 세션 종료 사건 뒤, 트랜잭션의 마지막 쓰기다(identity §8 '탈퇴 계정의 대기열 키 지우기', BOT-037) */
  recordWithdrawn(i: { accountId: string; pids: readonly string[]; withdrawnAt: number }): Promise<void>;
  /** ACTIVE 계정을 WITHDRAWAL_PENDING과 정리 사유·시작 시각으로 둔다. 이미 정리 중이거나 다른 상태면 그대로 둔다(멱등) */
  markClosure(accountId: string, reason: 'UNDER_14', now: number): Promise<void>;
  /** 정리 중(WITHDRAWAL_PENDING)인 계정의 정리 사유. 아니면 null */
  closureReasonOf(accountId: string): Promise<'UNDER_14' | null>;
  /** 계정 상태. 없으면 null */
  accountStatusOf(accountId: string): Promise<AccountStatus | null>;
  /** 가입 마무리 상태. 계정이 없으면 null. 계정 잠금과 함께 쓰면 잠근 뒤의 값이다 */
  signupStateOf(accountId: string): Promise<SignupState | null>;
  /** 닉네임 키를 트랜잭션 끝까지 잠근다(같은 키는 한 번에 하나만, ADR-0203 결정 2). 키를 저장하기 전에 부른다 */
  lockNicknameKey(key: string): Promise<void>;
  /** 그 닉네임 키를 다른 계정이 쓰는가(계정을 지울 때 키도 지운다) */
  nicknameKeyTaken(key: string): Promise<boolean>;
  /** 그 회원 코드를 이미 쓰는 계정이 있는가 */
  memberCodeTaken(code: string): Promise<boolean>;
  /** 가입 마무리 쓰기: age_verified, 닉네임·키, 휴대폰 번호, 회원 코드, 동의 행. 부르는 쪽이 계정과 닉네임 키를 잠근 뒤 부른다 */
  completeSignup(r: SignupRecord): Promise<void>;
  /** before 때나 그 전에 만든 가입 전 ACTIVE 계정 ID(최대 limit개, 정비 signup-incomplete-purge) */
  incompleteSignupsBefore(before: number, limit: number): Promise<string[]>;
  /**
   * 탈퇴 끝내기의 계정 쪽(identity §8 '탈퇴의 첫 구현'): DELETED·deleted_at, 프로필 칸 비우기, 로그인 수단 연결·기기 행·세션 생성 기억 지우기.
   * 세션 끝내기는 부르는 쪽이 terminateSessions로 한다
   */
  eraseAccount(accountId: string, now: number): Promise<void>;
  /** 조사용 연락처 가명 행을 쓴다(있으면 값과 시각을 바꾼다, docs/data.md account_contact_ref, identity §9.1 '조사용 값의 첫 구현') */
  /** refPrev: 문자열이면 그 값, null이면 남은 옛 판 값을 그대로, 없으면 판이 바뀔 때 지금 값을 옛 판으로(domain/inv-ref.ts nextRefPrev) */
  setContactRef(i: { accountId: string; kind: ContactKind; ref: string; refPrev?: string | null; now: number }): Promise<void>;
  /** 정리 사유 UNDER_14로 before 때나 그 전에 정리를 시작한 정리 중 계정 ID(최대 limit개) */
  closuresStartedBefore(before: number, limit: number): Promise<string[]>;
  /** since 뒤에 탈퇴한(DELETED) 계정 ID를 ID 순으로 after 뒤부터 최대 limit개 */
  deletedSince(since: number, after: string, limit: number): Promise<string[]>;
  /**
   * 그 계정이 남겼거나 이은 끝나지 않은 대조값 보관 행 하나(RESTRICTED 먼저, 같으면 늦은 끝). 탈퇴가 계정을 잠근 뒤 같은 트랜잭션에서 다시 본다
   * (본인확인 컨텍스트의 표를 같은 DB 트랜잭션에서 읽는다. 표를 보지 못하는 저장소는 null)
   */
  activeHoldOf(accountId: string, now: number): Promise<{ state: 'CASE_OPEN' | 'RESTRICTED'; until: number } | null>;
  /** 재인증 토큰의 jti를 한 번 쓴다. 이미 썼으면 false */
  useReauth(r: { jti: string; accountId: string; usedAt: number; expiresAt: number }): Promise<boolean>;
  insertSession(row: NewSession): Promise<void>;
  /** 세션 행(쓰기 잠금). 없으면 null */
  getSessionForUpdate(id: string): Promise<SessionRow | null>;
  /** 지금 리프레시 토큰만 바꾼다(CreateSession 다시 보내기, 갱신 재시도). 앞 토큰·회전 시각은 그대로 */
  setRefreshHash(sessionId: string, hash: Uint8Array): Promise<void>;
  /** 회전: 지금 토큰을 앞 토큰으로 옮기고 새 토큰을 둔다. rotated_at = now, last_active_at = now(마지막 활동, ADR-0209 결정 2), refresh_used = false, 유휴 만료를 고친다 */
  rotateRefresh(sessionId: string, hash: Uint8Array, now: number, idleExpiresAt: number): Promise<void>;
  /** 발급한 리프레시 토큰 해시를 그 세션의 절대 만료까지 남긴다(재사용 탐지) */
  recordRefreshHash(r: { hash: Uint8Array; sessionId: string; refreshFamily: string; issuedAt: number; expiresAt: number }): Promise<void>;
  /** 리프레시 토큰 해시로 세션을 찾는다(지금·바로 앞·예전 발급). 없으면 null */
  findByRefreshHash(hash: Uint8Array): Promise<RefreshRow | null>;
  /** 그 패밀리의 끝나지 않은 세션 ID */
  familySessions(refreshFamily: string): Promise<string[]>;
}

export const SESSION_STORE = Symbol('identity.SessionStore');
export interface SessionStore {
  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T>;
  /** 끝났거나 유휴·절대 만료가 지난 세션의 리프레시 토큰 해시를 지우고 지운 줄 수(정비 refresh-hash-expired, R-255) */
  purgeExpiredRefreshHashes(now: number, signal?: AbortSignal): Promise<number>;
  /** 토큰 만료가 지난 재인증 토큰 사용 기록을 지우고 지운 줄 수(정비) */
  purgeReauthUses(now: number): Promise<number>;
  /**
   * 지금·바로 앞 리프레시 토큰 해시의 계정 ID. 잠그지 않는다. 갱신이 트랜잭션 앞에서 토큰에 실을 계정 값을 읽는 데 쓴다
   * (트랜잭션 안에서 다른 저장소 연결을 잡지 않고 쓰기 전에 서명하려고, BOT-130이 넘긴 것). 지난 토큰(이력)은 보지 않는다
   */
  refreshOwner(hash: Uint8Array): Promise<string | null>;
  /** 세션 한 줄을 잠그지 않고 읽는다(읽기만 하는 확인, GetVerificationStatus, BOT-025가 넘긴 것) */
  sessionOf(id: string): Promise<SessionRow | null>;
  /** 가입 마무리 상태를 잠그지 않고 읽는다(계정 요약, ADR-0235 결정 3) */
  signupStateOf(accountId: string): Promise<SignupState | null>;
  /** 그 닉네임 키를 쓰는 계정이 있는가(닉네임 확인. 참고일 뿐이고 확정은 가입 마무리의 잠금이다) */
  nicknameKeyTaken(key: string): Promise<boolean>;
  /** 그 계정의 살아 있는 세션(끝나지 않았고 만료 전)을 잠그지 않고 읽는다. 로그인한 기기 목록(GET /v1/identity/sessions, ADR-0209) */
  liveSessionsOf(accountId: string, now: number): Promise<LiveSession[]>;
  /** 절대 만료가 지났는데 화면용 기기 이름이 남은 세션의 그 칸을 비우고 비운 줄 수(정비 session-label-expired, ADR-0209 결정 1) */
  clearEndedDeviceLabels(now: number, signal?: AbortSignal): Promise<number>;
  /**
   * 조사 적재가 읽는 연결 값(BatchGetInvestigationRefs, identity §9.1). 있는 계정만, 받은 순서대로. 탈퇴한 계정은 빈 값이다.
   * identityConflicts는 since 뒤의 같은 본인확인 시도 기록(본인확인 컨텍스트의 표를 읽는다. 표를 보지 못하는 저장소는 빈 목록)
   */
  investigationRefsOf(accountIds: readonly string[], since: number): Promise<InvestigationRefsRow[]>;
  /** 이메일은 있는데 EMAIL 연락처 가명 행이 없는 ACTIVE 계정을 ID 순으로 after 뒤부터 최대 limit개(정비 contact-ref-backfill) */
  accountsMissingEmailRef(after: string, limit: number): Promise<{ accountId: string; email: string }[]>;
  /** 새 판(writePrefix, 예 'k2.')이 아닌 EMAIL 행을 가진 ACTIVE 계정과 그 이메일·지금 값을 ID 순으로 after 뒤부터 최대 limit개(정비 contact-ref-rotate, BOT-046) */
  contactRefsToRotate(after: string, writePrefix: string, limit: number): Promise<{ accountId: string; email: string; ref: string }[]>;
  /**
   * 이음 기간이 끝난 라벨의 옛 판 값을 지운다(정비 inv-ref-bridge-close, BOT-046). device: device_ref_prev를 비우고 옛 판(prevPrefix)으로 남은 기기 행을 지운다.
   * contact: ref_prev를 비운다. 지운·비운 수
   */
  closeInvRefBridge(label: 'device' | 'contact', prevPrefix: string, chunk?: number): Promise<{ cleared: number; removed: number }>;
}

export type ContactKind = 'PHONE' | 'EMAIL';
export interface InvestigationRefsRow {
  accountId: string;
  contactRefs: { kind: ContactKind; ref: string }[];
  deviceRefs: string[];
  identityConflicts: { otherAccountId: string; attemptedAt: number }[];
}

/** 키 회전의 이음(옛 판, 이음 끝, 설정에서 읽은 지금 판). 라벨 키 링이나 키 없는 설정(bridgesFromEnv)이 준다 */
export interface InvRefBridge {
  prevVersion: number;
  until: number;
  writeVersion?: number;
}
export interface InvRefBridges {
  bridgeOf(label: InvRefLabel): InvRefBridge | null;
}

export const INV_REFS = Symbol('identity.InvRefs');
/** 조사용 가명 invRef(라벨, 값)(docs/security/secrets-and-keys.md). 라벨 키가 없으면 undefined(칸을 비운다, 세는 일은 구현이 한다) */
export interface InvRefs {
  ref(label: InvRefLabel, value: string): string | undefined;
  /** 키 회전의 이음 기간에만: 옛 판의 값(대응을 남긴다). 이음이 아니면 undefined */
  prevRef?(label: InvRefLabel, value: string): string | undefined;
}

export interface SignedToken {
  token: string;
  expiresAt: number;
}

export const TOKEN_SIGNER = Symbol('identity.TokenSigner');
/** 팬 토큰 키 서명(identity §3). 키 셋·회전·공개키 배포는 BUILD_ORDER PRF-030 */
export interface TokenSigner {
  /** 발급자(iss). 재인증 토큰을 확인할 때 같은 값을 본다 */
  readonly issuer: string;
  access(c: { accountId: string; sessionId: string; scopes?: string[]; pid?: string; pidPrev?: string }, now: number): Promise<SignedToken>;
  reauth(c: { accountId: string; sessionId: string; provider: Provider; strength: ReauthStrength; purpose: ReauthPurpose }, now: number): Promise<SignedToken>;
}

export const DEVICE_REFS = Symbol('identity.DeviceRefs');
/** 기기 가명 invRef("device", deviceId)(docs/security/secrets-and-keys.md). 라벨 키가 없으면 undefined(기기 행을 쓰지 않는다, identity §10) */
export interface DeviceRefs {
  ref(deviceId: string): string | undefined;
  /** 키 회전의 이음 기간에만: 옛 판의 기기 가명(BOT-046) */
  prevRef?(deviceId: string): string | undefined;
}

export const SESSION_SIGNALS = Symbol('identity.SessionSignals');
/** 운영 확인 신호(identity §10.1) */
export interface SessionSignals {
  created(provider: Provider, newAccount: boolean): void;
  replayed(provider: Provider): void;
  terminated(reason: TerminationReason, count: number): void;
  reauthIssued(provider: Provider, strength: ReauthStrength): void;
  reauthMismatch(provider: Provider): void;
  reverifyRequired(provider: Provider): void;
  refreshed(aud: 'fan', result: 'rotated' | 'retried' | 'reused' | 'invalid'): void;
  /** 조사용 가명을 계산해야 하는데 라벨 키가 없었다(inv_ref_missing_total, SEV3, identity §9.1) */
  invRefMissing(label: InvRefLabel, reason: 'THROTTLED' | 'KMS_ERROR'): void;
  /** 병합 불변식 위반: 흡수 계정에 티켓·후기가 있다(SEV3, I-T32, BOT-042) */
  mergeInvariantViolated(): void;
  /** 다른 기기의 세션을 끝냈다: 원격 로그아웃, 로그인 수단을 바꾼 뒤(identity_other_sessions_ended_total, ADR-0209 결정 6) */
  othersEnded(cause: 'remote_logout' | 'login_method_changed', count: number): void;
  /** 가입 마무리를 끝냈다(identity_signup_completed_total, ADR-0235) */
  signupCompleted(marketing: boolean): void;
  /** 닉네임 확인이 요청 한도에 걸렸다(identity_nickname_check_limited_total, ADR-0235) */
  nicknameCheckLimited(): void;
}

export const STAFF_ASSIGNMENTS = Symbol('identity.StaffAssignments');
/** 지금 ASSIGNED인 현장 스태프 배정이 있는가(계정 요약, ADR-0235 결정 3). 배정 표를 만드는 단계(BUILD_ORDER GAT-210)가 채운다 */
export interface StaffAssignments {
  hasAssigned(accountId: string): Promise<boolean>;
}
/** 배정 표가 생기기 전의 값: 늘 없음 */
export const noStaffAssignments: StaffAssignments = { hasAssigned: async () => false };

export const NICKNAME_CHECK_LIMITS = Symbol('identity.NicknameCheckLimits');
/** 닉네임 확인의 세션별 요청 수(세션·캐시 Redis id:nick, 1분 [가정], ADR-0235 결정 5). 저장소에 닿지 못하면 통과시킨다 */
export interface NicknameCheckLimits {
  /** 이번 요청을 받아도 되는가. 넘었으면 다시 보낼 때까지의 밀리초 */
  allow(sessionId: string): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }>;
}

export const PUBLIC_KEYS = Symbol('identity.PublicKeys');
/** 공개키 묶음(JWKS)을 내는 쪽(identity §3 '토큰 수명주기 구현' 공개키 배포). 키 셋은 fan·admin·staff */
export interface PublicKeys {
  jwks(set: 'fan' | 'admin' | 'staff', now: number): { keys: object[] };
}

export const ACCOUNT_CLAIMS = Symbol('identity.AccountClaims');
/** 액세스 토큰에 실을 계정 값(identity §3): 본인확인을 마친 계정의 scope(ticket:buy)·pid·pid_prev. 본인확인 컨텍스트가 채운다 */
export interface AccountClaims {
  of(accountId: string): Promise<{ scopes: string[]; pid?: string; pidPrev?: string }>;
}

export const REVERIFICATIONS = Symbol('identity.Reverifications');
/** 본인확인 재통과 기록(본인확인 컨텍스트가 내준다, identity §5 '키 판·만 14세…'·§7.1 ③) */
export interface Reverifications {
  /** 그 세션에서 목적 REVERIFY 건이 since 뒤에 VERIFIED로 확정됐는가 */
  recentlyReverified(accountId: string, sessionId: string, since: number): Promise<boolean>;
}
/** 재통과 기록이 없는 경우(시험) */
export const noReverifications: Reverifications = { recentlyReverified: async () => false };

export const ACCOUNT_CLOSURE = Symbol('identity.AccountClosure');
/** 계정 정리 시작(세션 컨텍스트가 내준다). 본인확인이 만 14세 미만을 찾으면 부른다. 멱등이다 */
export interface AccountClosure {
  start(accountId: string, reason: 'UNDER_14'): Promise<void>;
  /** 정리 중(WITHDRAWAL_PENDING)이면 그 사유, 아니면 null. 정리 중인 계정은 다시 본인확인하지 못한다(새 맥락 리뷰 중간 2) */
  closureReasonOf(accountId: string): Promise<'UNDER_14' | null>;
  /** 구매·본인확인을 할 수 없는 계정인가(ACTIVE가 아님: 정리·탈퇴 유예 중, 탈퇴, 병합). 그 계정의 토큰에는 ticket:buy·pid를 싣지 않는다(identity §8 '탈퇴의 첫 구현') */
  isClosing(accountId: string): Promise<boolean>;
}

export const ACCOUNT_ERASER = Symbol('identity.AccountEraser');
/** 탈퇴한 계정의 본인확인 기록 파기(본인확인 컨텍스트가 채운다, identity §8 '탈퇴의 첫 구현'). 여러 번 불러도 된다 */
export interface AccountEraser {
  /** 지운 것이 있으면 true */
  erase(accountId: string, now: number): Promise<boolean>;
  /**
   * 지우기 전 본인확인 기록의 pid(지금 pid가 먼저, 전환 기간이면 옛 pid가 뒤). 본인확인 전이면 빈 목록.
   * 탈퇴 트랜잭션을 열기 전에 부른다(잠근 채 연결을 하나 더 빌리지 않게). 그 사이 끝난 첫 본인확인의 pid는 아직 토큰·대기열 키가 없다(BOT-037)
   */
  pidsOf(accountId: string): Promise<string[]>;
}

export const REAUTH_VERIFIER = Symbol('identity.ReauthVerifier');
/** 재인증 토큰 확인(typ reauth+jwt, 팬 토큰 키, 세션·작업 묶음). 맞지 않으면 ReauthRejected를 던진다 */
export interface ReauthVerifier {
  verify(token: string, o: { sessionId: string; act: string }): Promise<{ jti: string; accountId: string; expiresAt: number }>;
}

/** 재인증 토큰이 없거나 맞지 않는다(403 reauth-required, docs/api/guidelines.md 재인증 토큰) */
export class ReauthRejected extends Error {
  constructor(readonly why: string) {
    super(`재인증 토큰이 맞지 않는다: ${why}`);
    this.name = 'ReauthRejected';
  }
}

export const FRAUD_HOLDS = Symbol('identity.FraudHolds');
/** 탈퇴 전 대조값 보관 안내(본인확인 컨텍스트가 채운다, identity §8 '대조값 보관의 첫 구현'). 그 계정이 남겼거나 이은 끝나지 않은 행 하나 */
export interface FraudHolds {
  activeHold(accountId: string, now: number): Promise<{ state: 'CASE_OPEN' | 'RESTRICTED'; until: number } | null>;
}

export const LINK_PROPOSALS = Symbol('identity.LinkProposals');
/** 가입 때 연결 제안(세션·캐시 Redis id:link, 10분, identity §2.1 '가입 때 연결 제안의 첫 구현') */
export interface StoredLinkProposal {
  id: string;
  /** 브라우저 묶음 값의 SHA-256(base64url). 원문은 두지 않는다 */
  bindingHash: string;
  newProvider: Provider;
  newProviderUserId: string;
  email: string;
  targetAccountId: string;
  existingProvider: Provider;
  attempts: number;
  createdAt: number;
  expiresAt: number;
  /** 새 계정 만들기에 쓴 멱등 키(쓴 뒤에만). 쓴 제안은 그 키의 다시 보내기만 받고, 연결·조회·다른 키에는 없는 제안이다(identity §2.1, BOT-040이 넘긴 것) */
  usedKey?: string;
}

/** 모든 메서드: @throws LinkStoreUnavailable 저장소에 닿지 못함 */
export interface LinkProposals {
  save(p: StoredLinkProposal): Promise<void>;
  /** 없거나 만료면 null */
  get(id: string): Promise<StoredLinkProposal | null>;
  /** 실패 횟수를 하나 올린다. LINK_MAX_ATTEMPTS에 닿으면 지운다. 올린 뒤 횟수(제안이 없으면 null) */
  fail(id: string): Promise<number | null>;
  remove(id: string): Promise<void>;
  /** 새 계정 만들기에 쓴 것으로 적는다. 남은 수명은 그대로이고, 없거나 만료된 제안이면 아무것도 하지 않는다 */
  markUsed(id: string, idempotencyKey: string): Promise<void>;
}

/** 제안 저장소(세션·캐시 Redis)에 닿지 못했다 */
export class LinkStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('연결 제안 저장소에 닿지 못했다', { cause });
    this.name = 'LinkStoreUnavailable';
  }
}

export const MERGE_CHECKERS = Symbol('identity.MergeCheckers');
/** 세 서비스의 CheckAccountMerge(purchase·ticket·core, identity §2.1 '계정 병합의 첫 구현'). 답하지 않으면 MergeCheckUnavailable */
export interface MergeChecker {
  readonly service: 'purchase' | 'ticket' | 'core';
  check(i: { primaryAccountId: string; absorbedAccountId: string }): Promise<import('./merge.js').CheckResult>;
}

/** CheckAccountMerge가 기한 안에 답하지 않았다(503, Retry-After) */
export class MergeCheckUnavailable extends Error {
  constructor(
    readonly service: string,
    cause?: unknown,
  ) {
    super(`${service} CheckAccountMerge가 답하지 않았다`, { cause });
    this.name = 'MergeCheckUnavailable';
  }
}

export const MERGE_PROPOSALS = Symbol('identity.MergeProposals');
/** 병합 제안(세션·캐시 Redis id:merge, 10분). 모든 메서드: @throws LinkStoreUnavailable 저장소에 닿지 못함 */
export interface MergeProposals {
  save(p: import('./merge.js').StoredMergeProposal): Promise<void>;
  /** 없거나 만료면 null */
  get(id: string): Promise<import('./merge.js').StoredMergeProposal | null>;
  remove(id: string): Promise<void>;
}
