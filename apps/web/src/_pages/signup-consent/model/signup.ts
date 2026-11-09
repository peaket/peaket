// SCR-005 가입 마무리 폼의 규칙(d5 §5.5 상태 표, ADR-0203 결정 1·2). 순수 함수라 node --test가 바로 돌린다.
// 닉네임 규칙 [가정]: NFC로 맞추고 앞뒤 공백을 지운 뒤 문자소 2~12개(UTF-16 64자 이하), 글자(\p{L}·결합 표시 \p{M})·숫자(\p{N})·
// 가운데 공백 한 칸·_·.·-만. 이모지·기호·제어 문자는 받지 않는다. 결합 표시로 숨어 드는 이모지 표시 문자(변형 선택자·키캡·ZWJ)와
// 그림 문자를 막고, 한 글자의 결합 표시는 셋까지다(문자소 수로는 보이지 않는 길이 늘이기를 막는다). 서버가 같은 규칙으로 다시 보고(400 nickname-invalid), 중복은 서버만 안다(409 nickname-taken).

/** idle 입력 전·입력 중 · length·chars 화면이 본 꼴 문제 · checking 서버 확인 중 · ok·taken·invalid 서버 답 · error 확인 못 함 */
export type NickCheck = 'idle' | 'length' | 'chars' | 'checking' | 'ok' | 'taken' | 'invalid' | 'error';

export interface SignupForm {
  age: boolean;
  terms: boolean;
  privacy: boolean;
  marketing: boolean;
  phoneConsent: boolean;
  phone: string;
  nickname: string;
  /** 닉네임 확인 결과(서버) */
  nick: NickCheck;
}

export const ERRORS = {
  age: '만 14세 이상인지 확인해 주세요',
  terms: '이용약관에 동의해 주세요',
  privacy: '개인정보 수집·이용에 동의해 주세요',
  nickEmpty: '닉네임을 입력해 주세요',
  nickLength: '닉네임은 2~12자로 정해 주세요',
  nickChars: '닉네임에는 글자·숫자와 공백 한 칸, _ . - 만 쓸 수 있습니다(이모지·기호는 쓸 수 없습니다)',
  nickTaken: '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요',
  phone: '휴대폰 번호를 확인해 주세요(예: 010-1234-5678)',
} as const;

const MIN = 2;
const MAX = 12;
/** 계약 maxLength(FanAccountSummary·SignupCompletionInput의 nickname)와 같다 */
const MAX_UNITS = 64;
const MAX_MARKS = 3;
/** \uD0A4\uCEA1\u00B7\uADF8\uB9BC \uBB38\uC790\uC640 \uD654\uBA74\uC5D0 \uBCF4\uC774\uC9C0 \uC54A\uB294 \uAE00\uC790 \uC804\uBD80(\uC81C\uB85C\uD3ED, \uBCC0\uD615 \uC120\uD0DD\uC790, \uACB0\uD569 \uC790\uB9AC \uD45C\uC2DC, \uD55C\uAE00 \uCC44\uC6C0 \uBB38\uC790). \uAE00\uC790\uB85C \uBD84\uB958\uB418\uB294 \uAC83\uC774 \uC11E\uC5EC \uC788\uC5B4 ALLOWED\uB9CC\uC73C\uB85C\uB294 \uB9C9\uC9C0 \uBABB\uD55C\uB2E4(\uC11C\uBC84 domain/signup.ts\uC640 \uAC19\uB2E4) */
const FORBIDDEN_PARTS = /\u20E3|\p{Default_Ignorable_Code_Point}|\p{Extended_Pictographic}/u;
const ALLOWED = /^[\p{L}\p{M}\p{N}_.\-]+(?: [\p{L}\p{M}\p{N}_.\-]+)*$/u;
const PHONE = /^(?:010[0-9]{8}|01[16789][0-9]{7,8})$/;

export function normalizeNickname(raw: string): string {
  return raw.normalize('NFC').trim();
}

const graphemes = (s: string): string[] => Array.from(new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s), (x) => x.segment);

/** 닉네임 꼴의 문제(없으면 null). 중복은 서버가 본다 */
export function nicknameProblem(raw: string): 'empty' | 'length' | 'chars' | null {
  const v = normalizeNickname(raw);
  if (v === '') return 'empty';
  if (v.length > MAX_UNITS) return 'length';
  if (!ALLOWED.test(v) || FORBIDDEN_PARTS.test(v)) return 'chars';
  const gs = graphemes(v);
  if (gs.some((g) => (g.match(/\p{M}/gu)?.length ?? 0) > MAX_MARKS)) return 'chars';
  return gs.length < MIN || gs.length > MAX ? 'length' : null;
}

export const phoneDigits = (raw: string): string => raw.replace(/\D/g, '');

/** 위에서부터(칸 차례) 오류 목록. 첫 칸으로 초점을 옮긴다(d5 §5.5 '입력 오류') */
export function validateSignup(f: SignupForm): { fieldId: string; message: string }[] {
  const errors: { fieldId: string; message: string }[] = [];
  if (!f.age) errors.push({ fieldId: 'c-age', message: ERRORS.age });
  if (!f.terms) errors.push({ fieldId: 'c-terms', message: ERRORS.terms });
  if (!f.privacy) errors.push({ fieldId: 'c-privacy', message: ERRORS.privacy });
  if (f.phoneConsent && !PHONE.test(phoneDigits(f.phone))) errors.push({ fieldId: 'f-phone', message: ERRORS.phone });
  const p = nicknameProblem(f.nickname);
  if (p === 'empty') errors.push({ fieldId: 'f-nick', message: ERRORS.nickEmpty });
  else if (p === 'length') errors.push({ fieldId: 'f-nick', message: ERRORS.nickLength });
  else if (p === 'chars' || f.nick === 'invalid') errors.push({ fieldId: 'f-nick', message: ERRORS.nickChars });
  else if (f.nick === 'taken') errors.push({ fieldId: 'f-nick', message: ERRORS.nickTaken });
  // 화면의 칸 차례(① 만 14세 → ② 필수 동의 → ③ 선택 동의(휴대폰) → ④ 닉네임)
  const order = ['c-age', 'c-terms', 'c-privacy', 'f-phone', 'f-nick'];
  return errors.sort((a, b) => order.indexOf(a.fieldId) - order.indexOf(b.fieldId));
}

/** 계약 SignupCompletionInput(휴대폰 번호는 동의했을 때만) */
export function toSignupInput(f: SignupForm): {
  ageOver14: true;
  consents: { terms: true; privacy: true; marketing: boolean; phone: boolean };
  nickname: string;
  phone?: string;
} {
  return {
    ageOver14: true,
    consents: { terms: true, privacy: true, marketing: f.marketing, phone: f.phoneConsent },
    nickname: normalizeNickname(f.nickname),
    ...(f.phoneConsent ? { phone: phoneDigits(f.phone) } : {}),
  };
}
