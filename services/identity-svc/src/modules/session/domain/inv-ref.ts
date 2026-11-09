// 부정 예매 조사용 가명의 계산식과 값 맞추기(docs/features/identity.md §9.1, docs/security/secrets-and-keys.md '조사용 가명 키', ADR-0171 결정 4, BUILD_ORDER BOT-045).
// invRef(라벨, 값) = "k" + 판 + "." + base64url(HMAC-SHA256(라벨 키, 값)). 라벨 키는 KMS GenerateMac(그 라벨의 키, "PEAKET-inv-ref-v1|" + 라벨)이다.
import { createHmac } from 'node:crypto';

/** identity-svc가 받는 라벨(pay는 payment-svc만) */
export const INV_REF_LABELS = ['device', 'contact'] as const;
export type InvRefLabel = (typeof INV_REF_LABELS)[number];
/** 라벨 키를 믿는 시간 [가정]. 받은 지 이만큼 지나면 쓰지 않는다 */
export const INV_REF_KEY_TTL_MS = 10 * 60_000;
/** 같은 본인확인 시도 기록을 돌려주는 기간 [가정](docs/data.md identity_conflict_attempt) */
export const IDENTITY_CONFLICT_WINDOW_MS = 365 * 86_400_000;
/** BatchGetInvestigationRefs 한 번의 계정 수 상한 [가정] */
export const INV_REF_BATCH_MAX = 500;

/** 라벨 키를 받을 때 KMS에 MAC할 글 */
export const labelKeyMessage = (label: InvRefLabel): Uint8Array => Buffer.from(`PEAKET-inv-ref-v1|${label}`, 'utf8');

export function invRef(labelKey: Uint8Array, version: number, value: string): string {
  return `k${version}.${createHmac('sha256', labelKey).update(value, 'utf8').digest('base64url')}`;
}

/** 로그인 이메일: 앞뒤 빈칸을 빼고 소문자로. 비면 null */
export function contactEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '' ? null : v;
}

/** E.164 모양(+ 뒤 숫자 8~15자리, 첫 숫자는 0이 아님). +82 뒤에 국내 앞자리 0이 남은 값은 E.164가 아니다(같은 번호가 다른 가명이 되지 않게) */
export const isE164 = (v: string): boolean => /^\+[1-9]\d{7,14}$/.test(v) && !v.startsWith('+820');

/**
 * 휴대폰 번호를 E.164로 맞춘다. 빈칸·하이픈·괄호·점은 뺀다. +로 시작하면 그대로, 0으로 시작하면 국내 번호로 보고 +82와 앞 0을 뺀 나머지다.
 * 숫자가 아닌 글자가 남거나 모양이 아니면 null
 */
export function toE164(raw: string | null | undefined): string | null {
  const stripped = (raw ?? '').replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(stripped)) return null;
  // 국제전화 앞자리 00은 +로 본다(0082…)
  const s = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
  // 국제 표기에 국내 앞자리 0이 남은 모양(+82 010…)은 0을 뺀다(국내 번호와 같은 값이 되게)
  const v = s.startsWith('+820') ? `+82${s.slice(4)}` : s.startsWith('+') ? s : s.startsWith('0') ? `+82${s.slice(1)}` : null;
  return v !== null && isE164(v) ? v : null;
}

/** 키 판 접두어(예 'k2.'). 값마다 붙어 판을 가른다 */
export const invRefPrefix = (version: number): string => `k${version}.`;

/**
 * 연락처 행을 다시 쓸 때 남길 옛 판 값(키 회전의 이음, BOT-046). given: 문자열이면 그 값, null이면 지금 남은 옛 판 값을 그대로,
 * undefined면 지금 값의 판이 새 값과 다를 때 지금 값을 옛 판으로(같으면 지금 남은 옛 판 값)
 */
export function nextRefPrev(cur: { ref: string; refPrev: string | null } | undefined, ref: string, given: string | null | undefined): string | null {
  if (typeof given === 'string') return given;
  if (!cur) return null;
  if (given === null) return cur.refPrev;
  return cur.ref.split('.')[0] !== ref.split('.')[0] ? cur.ref : cur.refPrev;
}
