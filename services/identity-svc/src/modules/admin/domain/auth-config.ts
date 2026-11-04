// 관리 계정 인증 통제의 설정값과 시작 범위 검사(docs/security/auth-controls.md §5, AC-T10, BUILD_ORDER BOT-110).
// 설정은 배포 설정(GitOps)에만 두고 운영 중 명령으로 바꾸지 않는다. 범위를 벗어나면 어느 설정인지 알리고 시작하지 않는다.

export interface AdminAuthConfig {
  captchaAfterFailures: number;
  lockAfterFailures: number;
  timedLockFirstMs: number;
  timedLockRepeatMs: number;
  timedLockRepeatWindowMs: number;
  pairLockAfterFailures: number;
  protectAfterSecondFactorFailures: number;
  passwordFailureCap: number;
  passwordFailureNotice: number;
  multiSourceIpsPerHour: number;
  sourceAccountsPerHour: number;
  sourceCaptchaDurationMs: number;
  globalCaptchaDurationMs: number;
  passwordOnlyNoticeAfterMs: number;
  knownSourceWindowMs: number;
  unlockLinkTtlMs: number;
  unlockLinkCodeAttempts: number;
  unlockLinkResendPerHour: number;
  passwordMinLength: number;
  passwordMaxLength: number;
  contextMinRemainingLetters: number;
  breachRecheckIntervalMs: number;
  breachTimeoutMs: number;
}

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

type Spec = { key: string; field: keyof AdminAuthConfig; kind: 'int' | 'duration'; def: number; min: number; max: number | ((c: AdminAuthConfig) => number) };

/** auth-controls §5 표(이름·값·허용 범위) */
const SPECS: readonly Spec[] = [
  { key: 'admin_login.captcha_after_failures', field: 'captchaAfterFailures', kind: 'int', def: 3, min: 1, max: 5 },
  { key: 'admin_login.lock_after_failures', field: 'lockAfterFailures', kind: 'int', def: 5, min: 1, max: 10 },
  { key: 'admin_login.timed_lock_first', field: 'timedLockFirstMs', kind: 'duration', def: 15 * M, min: 1 * M, max: 1 * H },
  { key: 'admin_login.timed_lock_repeat', field: 'timedLockRepeatMs', kind: 'duration', def: 1 * H, min: 15 * M, max: 24 * H },
  { key: 'admin_login.timed_lock_repeat_window', field: 'timedLockRepeatWindowMs', kind: 'duration', def: 24 * H, min: 1 * H, max: 7 * D },
  { key: 'admin_login.pair_lock_after_failures', field: 'pairLockAfterFailures', kind: 'int', def: 5, min: 1, max: 10 },
  { key: 'admin_login.protect_after_second_factor_failures', field: 'protectAfterSecondFactorFailures', kind: 'int', def: 5, min: 1, max: 10 },
  { key: 'admin_login.password_failure_cap', field: 'passwordFailureCap', kind: 'int', def: 100, min: 1, max: 100 },
  { key: 'admin_login.password_failure_notice', field: 'passwordFailureNotice', kind: 'int', def: 50, min: 1, max: (c) => c.passwordFailureCap },
  { key: 'admin_login.multi_source_ips_per_hour', field: 'multiSourceIpsPerHour', kind: 'int', def: 5, min: 2, max: 50 },
  { key: 'admin_login.source_accounts_per_hour', field: 'sourceAccountsPerHour', kind: 'int', def: 5, min: 2, max: 50 },
  { key: 'admin_login.source_captcha_duration', field: 'sourceCaptchaDurationMs', kind: 'duration', def: 1 * H, min: 15 * M, max: 24 * H },
  { key: 'admin_login.global_captcha_duration', field: 'globalCaptchaDurationMs', kind: 'duration', def: 1 * H, min: 15 * M, max: 24 * H },
  { key: 'admin_login.password_only_notice_after', field: 'passwordOnlyNoticeAfterMs', kind: 'duration', def: 10 * M, min: 1 * M, max: 1 * H },
  { key: 'admin_login.known_source_window', field: 'knownSourceWindowMs', kind: 'duration', def: 30 * D, min: 1 * D, max: 90 * D },
  { key: 'unlock_link.ttl', field: 'unlockLinkTtlMs', kind: 'duration', def: 30 * M, min: 5 * M, max: 24 * H },
  { key: 'unlock_link.code_attempts', field: 'unlockLinkCodeAttempts', kind: 'int', def: 3, min: 1, max: 5 },
  { key: 'unlock_link.resend_per_hour', field: 'unlockLinkResendPerHour', kind: 'int', def: 3, min: 1, max: 10 },
  // 최소 길이는 15 이상(NIST §3.1.1.2, ASVS 6.2.1), 최대 길이는 64 이상(ASVS 6.2.9). 위 끝은 [가정]
  { key: 'password.min_length', field: 'passwordMinLength', kind: 'int', def: 15, min: 15, max: 64 },
  { key: 'password.max_length', field: 'passwordMaxLength', kind: 'int', def: 256, min: 64, max: 1_024 },
  { key: 'password.context_min_remaining_letters', field: 'contextMinRemainingLetters', kind: 'int', def: 4, min: 2, max: 8 },
  { key: 'password.breach_recheck_interval', field: 'breachRecheckIntervalMs', kind: 'duration', def: 30 * D, min: 1 * D, max: 90 * D },
  { key: 'password.breach_timeout', field: 'breachTimeoutMs', kind: 'duration', def: 2 * S, min: 500, max: 5 * S },
];

export const DEFAULT_ADMIN_AUTH_CONFIG: AdminAuthConfig = Object.freeze(Object.fromEntries(SPECS.map((s) => [s.field, s.def])) as unknown as AdminAuthConfig);

/** 'admin_login.lock_after_failures' → 'PEAKET_AUTH_ADMIN_LOGIN_LOCK_AFTER_FAILURES' */
export const envNameOf = (key: string): string => `PEAKET_AUTH_${key.toUpperCase().replace(/\./g, '_')}`;

const UNIT: Record<string, number> = { ms: 1, s: S, m: M, h: H, d: D };
function parseDuration(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(raw.trim());
  return m ? Math.round(Number(m[1]) * UNIT[m[2]!]!) : null;
}

/** PEAKET_AUTH_로 시작하지만 범위 검사 설정이 아닌 이름(목록 파일 경로) */
const OTHER_AUTH_ENVS = ['PEAKET_AUTH_CONTEXT_WORDS_FILE'];

/** 설정에서 읽고 범위를 검사한다. 범위 밖이거나 모르는 이름이면 그 설정 이름을 담아 던진다(시작하지 않는다) */
export function adminAuthConfigFromEnv(env: Record<string, string | undefined>): AdminAuthConfig {
  // 모르는 이름은 오타로 본다: 조용히 기본값으로 시작하면 바꾼 줄 아는 기준이 그대로다(새 맥락 리뷰 2026-11-05)
  const known = new Set([...SPECS.map((s) => envNameOf(s.key)), ...OTHER_AUTH_ENVS]);
  const unknown = Object.keys(env).filter((k) => k.startsWith('PEAKET_AUTH_') && !known.has(k));
  if (unknown.length > 0) throw new Error(`모르는 인증 통제 설정 이름이다: ${unknown.join(', ')}(docs/security/auth-controls.md §5)`);
  const out = { ...DEFAULT_ADMIN_AUTH_CONFIG } as AdminAuthConfig;
  for (const s of SPECS) {
    const raw = env[envNameOf(s.key)];
    if (raw === undefined || raw === '') continue;
    const v = s.kind === 'int' ? (/^\d+$/.test(raw.trim()) ? Number(raw) : null) : parseDuration(raw);
    if (v === null) throw new Error(`${s.key}(${envNameOf(s.key)}) 값의 꼴이 틀렸다: ${raw}`);
    (out as unknown as Record<string, number>)[s.field] = v;
  }
  for (const s of SPECS) {
    const v = out[s.field];
    const max = typeof s.max === 'function' ? s.max(out) : s.max;
    if (v < s.min || v > max) throw new Error(`${s.key} 값 ${v}이(가) 허용 범위 ${s.min}~${max} 밖이다(docs/security/auth-controls.md §5)`);
  }
  return out;
}
