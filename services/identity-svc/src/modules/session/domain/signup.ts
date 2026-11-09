// 가입 마무리의 업무 규칙(docs/features/identity.md §2·§8 '팬 계정 요약·세션 종료 사유·가입 마무리의 첫 구현', ADR-0203 결정 2·3, ADR-0235).
// 닉네임 규칙은 화면(apps/web _pages/signup-consent/model/signup.ts)과 같다. 값을 바꿀 때는 ADR-0203과 화면을 함께 고친다.

const MIN = 2;
const MAX = 12;
/** 계약 maxLength(FanAccountSummary·SignupCompletionInput의 nickname)와 같다 */
export const NICKNAME_MAX_UNITS = 64;
const MAX_MARKS = 3;
/**
 * 받지 않는 글자: 키캡·그림 문자와, 화면에 보이지 않는 글자 전부(유니코드 Default_Ignorable: 제로폭, 변형 선택자, 결합 자리 표시, 한글 채움 문자).
 * 글자로 분류되는 것이 섞여 있어 ALLOWED만으로는 막지 못한다. 막지 않으면 보이는 모양이 같은 닉네임이 중복 검사를 지나간다(ADR-0203 결정 2)
 */
const FORBIDDEN_PARTS = /⃣|\p{Default_Ignorable_Code_Point}|\p{Extended_Pictographic}/u;
const ALLOWED = /^[\p{L}\p{M}\p{N}_.-]+(?: [\p{L}\p{M}\p{N}_.-]+)*$/u;

export const normalizeNickname = (raw: string): string => raw.normalize('NFC').trim();

const graphemes = (s: string): string[] => Array.from(new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s), (x) => x.segment);

/** 닉네임 꼴의 문제(없으면 null). 중복은 키로 따로 본다 */
export function nicknameProblem(raw: string): 'empty' | 'length' | 'chars' | null {
  const v = normalizeNickname(raw);
  if (v === '') return 'empty';
  if (v.length > NICKNAME_MAX_UNITS) return 'length';
  if (!ALLOWED.test(v) || FORBIDDEN_PARTS.test(v)) return 'chars';
  const gs = graphemes(v);
  if (gs.some((g) => (g.match(/\p{M}/gu)?.length ?? 0) > MAX_MARKS)) return 'chars';
  return gs.length < MIN || gs.length > MAX ? 'length' : null;
}

/** 닉네임 중복을 보는 키: 전각·반각처럼 모양만 다른 글자를 한 모양으로 맞추고(NFKC) 대소문자를 없앤다(ADR-0203 결정 2). 저장은 account.nickname_key */
export const nicknameKey = (nickname: string): string => normalizeNickname(nickname).normalize('NFKC').toLowerCase();

export type ConsentKind = 'TERMS' | 'PRIVACY_REQUIRED' | 'PRIVACY_PHONE' | 'MARKETING';

/** 필수 동의 둘(ADR-0202 결정 1 signupCompleted) */
const REQUIRED: readonly ConsentKind[] = ['TERMS', 'PRIVACY_REQUIRED'];

export function signupCompleted(ageVerified: boolean, consentKinds: readonly string[]): boolean {
  return ageVerified && REQUIRED.every((k) => consentKinds.includes(k));
}

/**
 * 동의마다 지금 보이는 고지 문안의 판: 그 문안이 있는 문서의 시행일이다(docs/features/identity.md §8 '가입 마무리', data.md consent.notice_version, ADR-0235 결정 4).
 * 이용약관은 /policy/terms, 개인정보 동의 둘은 /policy/privacy다. 마케팅은 가입 화면 문구라 문서가 없어 약관과 같은 날로 둔다 [가정]. 문서 시행일(apps/web entities/policy-doc)을 바꾸면 함께 올린다
 */
export const CONSENT_NOTICE_VERSIONS: Readonly<Record<ConsentKind, string>> = Object.freeze({ TERMS: '2026-11-01', PRIVACY_REQUIRED: '2026-11-01', PRIVACY_PHONE: '2026-11-01', MARKETING: '2026-11-01' });
/** 마케팅 수신 채널 기본값 [가정](docs/planning/03 §1.2, ADR-0203 결정 1) */
export const MARKETING_CHANNELS = 'EMAIL,PUSH';

/** 닉네임 확인의 세션별 요청 한도와 창 [가정](ADR-0235 결정 5) */
export const NICKNAME_CHECK_LIMIT = 30;
export const NICKNAME_CHECK_WINDOW_MS = 60_000;

/** 가입을 마치지 않은 계정을 치우는 기준 시간 [가정](ADR-0235 결정 7). 세션의 절대 만료와 같다 */
export const INCOMPLETE_SIGNUP_PURGE_MS = 30 * 86_400_000;

/** 회원 코드 7자(0과 O, 1과 I·L처럼 헷갈리는 글자를 뺀 32글자 표기 Crockford base32, `XXX-XXXX`) [가정](ADR-0235 결정 4, d5 SCR-017 예시와 같은 꼴) */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function memberCodeFrom(bytes: Uint8Array): string {
  const chars = Array.from(bytes.subarray(0, 7), (b) => CROCKFORD[b & 0x1f] as string);
  return `${chars.slice(0, 3).join('')}-${chars.slice(3).join('')}`;
}
