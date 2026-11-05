// 관리 계정 비밀번호 정책 판정(docs/security/auth-controls.md §4.1~§4.3, identity §6 '비밀번호 보안 정책', BUILD_ORDER BOT-110, I-T14·AC-T6).
// 원문은 NFC로만 맞추고(저장·확인용), 대조는 사본 셋(기본·바꿈·자판)으로 한다. 유출 목록(L2)은 밖을 불러야 해서 여기서 보지 않는다(application이 본다).
import type { AdminAuthConfig } from './auth-config.js';

export type PolicyReason = 'TOO_SHORT' | 'TOO_LONG' | 'COMMON' | 'CONTEXT';
export type PolicyVerdict = { ok: true } | { ok: false; reason: PolicyReason };

/** L4·L5 맥락(파트너 상호·번호와 계정 이메일·표시 이름). 대조할 때 만들고 저장하지 않는다. 이메일·표시 이름은 admin_account 행에서 온다 */
export interface PasswordContext {
  email: string;
  displayName?: string | null;
  partner?: { names: readonly string[]; numbers: readonly string[] };
}

/** 대조 목록: L1 흔한 비밀번호(기본·바꿈 사본으로 담은 것)와 L3 서비스 맥락 말(auth-controls §4.2 표). 파일은 어댑터가 읽는다 */
export interface PolicyLists {
  common: ReadonlySet<string>;
  serviceWords: readonly string[];
}

/** L1 목록 줄을 대조용으로 담는다: 기본 사본과 그 바꿈 사본(비밀번호도 두 사본으로 견주므로 짝을 맞춘다) */
export function commonPasswordSet(entries: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const b = baseCopy(e);
    if (b === '') continue;
    out.add(b);
    out.add(leetCopy(b));
  }
  return out;
}

// ── 사본 셋(auth-controls §4.3 2) ──
/** ① 기본 사본: NFKC, 소문자, 공백·-·_·. 지우기 */
export const baseCopy = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[\s\-_.]/g, '');
const LEET: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
/** ② 바꿈 사본 */
export const leetCopy = (base: string): string => base.replace(/[013457@$]/g, (c) => LEET[c]!);

// 두벌식 자판: 호환 자모 → 영문 키
const KEY: Record<string, string> = {
  ㅂ: 'q', ㅈ: 'w', ㄷ: 'e', ㄱ: 'r', ㅅ: 't', ㅛ: 'y', ㅕ: 'u', ㅑ: 'i', ㅐ: 'o', ㅔ: 'p',
  ㅁ: 'a', ㄴ: 's', ㅇ: 'd', ㄹ: 'f', ㅎ: 'g', ㅗ: 'h', ㅓ: 'j', ㅏ: 'k', ㅣ: 'l',
  ㅋ: 'z', ㅌ: 'x', ㅊ: 'c', ㅍ: 'v', ㅠ: 'b', ㅜ: 'n', ㅡ: 'm',
  ㅃ: 'q', ㅉ: 'w', ㄸ: 'e', ㄲ: 'r', ㅆ: 't', ㅒ: 'o', ㅖ: 'p',
  ㅘ: 'hk', ㅙ: 'ho', ㅚ: 'hl', ㅝ: 'nj', ㅞ: 'np', ㅟ: 'nl', ㅢ: 'ml',
  ㄳ: 'rt', ㄵ: 'sw', ㄶ: 'sg', ㄺ: 'fr', ㄻ: 'fa', ㄼ: 'fq', ㄽ: 'ft', ㄾ: 'fx', ㄿ: 'fv', ㅀ: 'fg', ㅄ: 'qt',
};
// 기본 사본은 NFKC라 따로 쓴 호환 자모(ㅂ U+3142)가 조합용 자모(U+1107)로 바뀐다: 그 꼴도 같은 키로 본다
for (const [k, v] of Object.entries({ ...KEY })) {
  const n = k.normalize('NFKC');
  if (n !== k && !(n in KEY)) KEY[n] = v;
}
const INITIAL = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const MEDIAL = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const FINAL = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
/** ③ 자판 사본: 한글을 두벌식에서 누르는 영문 키로('피켓' → vlzpt) */
export function keyboardCopy(base: string): string {
  let out = '';
  for (const ch of base) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xac00 && c <= 0xd7a3) {
      const i = c - 0xac00;
      out += KEY[INITIAL[Math.floor(i / 588)]!]! + KEY[MEDIAL[Math.floor((i % 588) / 28)]!]! + (FINAL[i % 28] ? KEY[FINAL[i % 28]!]! : '');
    } else out += KEY[ch] ?? ch;
  }
  return out;
}

// ── L1 꼴 규칙(키보드 한 줄 연속, 같은 글자 반복, 오르거나 내리는 연속 숫자) ──
const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
/** a 다음에 b가 오면 한 줄 연속(앞으로나 뒤로)인가 */
function rowStep(a: string, b: string): 1 | -1 | 0 {
  for (const r of ROWS) {
    const i = r.indexOf(a);
    if (i < 0) continue;
    if (r[i + 1] === b) return 1;
    if (r[i - 1] === b) return -1;
  }
  return 0;
}
const isDigit = (a: string) => /^[0-9]$/.test(a);
const digitStep = (a: string, b: string): 1 | -1 | 0 => (isDigit(a) && isDigit(b) ? (Number(b) - Number(a) === 1 ? 1 : Number(b) - Number(a) === -1 ? -1 : 0) : 0);
/** i에서 시작하는 꼴 조각(같은 글자 반복, 한 방향의 한 줄 연속, 한 방향의 연속 숫자)의 가장 긴 길이 */
function longestShapeAt(c: readonly string[], i: number): number {
  let best = 1;
  let j = i;
  while (j + 1 < c.length && c[j + 1] === c[i]) j++;
  best = Math.max(best, j - i + 1);
  for (const step of [rowStep, digitStep]) {
    const dir = i + 1 < c.length ? step(c[i]!, c[i + 1]!) : 0;
    if (dir === 0) continue;
    let k = i + 1;
    while (k + 1 < c.length && step(c[k]!, c[k + 1]!) === dir) k++;
    best = Math.max(best, k - i + 1);
  }
  return best;
}
/**
 * 문자열 전체가 꼴 규칙 조각(min자 이상)만 이어 붙인 것인가. 조각의 앞부분도 조각이므로, 모든 나눔을 뒤에서부터 따진다(동적 계획법)
 * (새 맥락 리뷰 2026-11-05: 앞에서 가장 긴 조각만 고르면 qwertyuiop|pp|asdf처럼 남은 2자에서 실패로 끝났다)
 */
export function onlyShapes(s: string, min = 3): boolean {
  const c = [...s];
  if (c.length === 0) return false;
  const can: boolean[] = new Array<boolean>(c.length + 1).fill(false);
  can[c.length] = true;
  for (let i = c.length - 1; i >= 0; i--) {
    const longest = longestShapeAt(c, i);
    for (let l = min; l <= longest && !can[i]; l++) if (can[i + l]) can[i] = true;
  }
  return can[0]!;
}

// ── 맥락 말(L3~L5) ──
const isHangul = (s: string) => /[가-힣]/.test(s);
/** 맥락 말 쓰는 길이: 영문 4자 이상, 한글 2자 이상, 숫자 4자 이상(§4.2) */
function usable(w: string): boolean {
  const b = baseCopy(w);
  return isHangul(b) ? [...b].length >= 2 : b.length >= 4;
}

function contextWords(ctx: PasswordContext, serviceWords: readonly string[]): string[] {
  const words = [...serviceWords];
  const email = ctx.email.trim().toLowerCase();
  const [local = '', domain = ''] = email.split('@');
  words.push(email, local, ...local.split(/[._-]/));
  if (ctx.displayName) words.push(ctx.displayName);
  if (ctx.partner) {
    words.push(...ctx.partner.names, ...ctx.partner.numbers.map((n) => n.replace(/\D/g, '')));
    // 업무 이메일 도메인의 앞 이름(kim@haeoreum.example의 haeoreum)
    if (domain) words.push(domain.split('.')[0] ?? '');
  }
  return [...new Set(words.filter(usable))];
}

/** 남은 부분이 '쉬운 덧붙임'인가: 숫자(모든 숫자 글자)·기호·공백을 뺀 글자가 (기준 - 1)자 이하이거나 꼴 규칙뿐 */
const lettersOf = (s: string) => s.replace(/[\p{N}\s\p{P}\p{S}]/gu, '');
function easyRest(rest: string, minRemaining: number, shapesToo?: string, letterCount?: number): boolean {
  const letters = lettersOf(rest);
  return (letterCount ?? [...letters].length) < minRemaining || onlyShapes(letters) || (shapesToo !== undefined && onlyShapes(lettersOf(shapesToo)));
}

const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });

/**
 * 기본 사본을 원문 글자(NFC의 문자소, 사람이 한 글자로 보는 단위)마다 만들어 잇고, 기본·키보드 사본의 UTF-16 자리마다 그 원문 글자의 순번과
 * 그 원문 글자에 문자(\p{L})가 있는지를 준다. 남은 글자 수를 원문 글자로 센다(㎏ → kg, 한 음절 → 자판 키 2~3자도 한 글자, 문자가 없는 ㎏·이모지·키캡 숫자는
 * 글자가 아니다, auth-controls §4.3 4, BOT-110이 넘긴 것). 글자마다 만들므로 따로 쓴 자모(ㄱㅏ)를 합치지 않아 자리가 늘 맞는다
 */
function unitsOf(nfc: string): { base: string; letter: boolean[]; baseAt: number[]; keysAt: number[] } {
  let base = '';
  const letter: boolean[] = [];
  const baseAt: number[] = [];
  const keysAt: number[] = [];
  let k = 0;
  for (const { segment } of GRAPHEMES.segment(nfc)) {
    const b = baseCopy(segment);
    base += b;
    letter.push(/\p{L}/u.test(segment));
    for (let j = 0; j < b.length; j++) baseAt.push(k);
    // 키보드 사본은 글자마다 바꾸므로(keyboardCopy) 조각의 길이로 자리를 잇는다
    for (let j = 0; j < keyboardCopy(b).length; j++) keysAt.push(k);
    k++;
  }
  return { base, letter, baseAt, keysAt };
}

/**
 * 그 사본에서 맥락 말(같은 사본 꼴)을 긴 것부터 모두 지운다. 지운 것이 있으면 남은 자리(사본의 UTF-16 위치)를, 없으면 null.
 * 지운 뒤 이어 붙은 글자 사이에서 다음 말을 찾는 것은 앞 판과 같다.
 */
function stripWords(copy: string, words: readonly string[]): number[] | null {
  let s = copy;
  let at = Array.from({ length: copy.length }, (_, i) => i);
  let removed = false;
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    if (w.length === 0 || !s.includes(w)) continue;
    const keepS: string[] = [];
    const keepAt: number[] = [];
    let i = 0;
    while (i < s.length) {
      if (s.startsWith(w, i)) {
        i += w.length;
        continue;
      }
      keepS.push(s[i]!);
      keepAt.push(at[i]!);
      i++;
    }
    s = keepS.join('');
    at = keepAt;
    removed = true;
  }
  return removed ? at : null;
}

/** 길이·L1·L3~L5 판정. 원문은 NFC 글자 수로 센다 */
export function judgePassword(raw: string, ctx: PasswordContext, lists: PolicyLists, cfg: Pick<AdminAuthConfig, 'passwordMinLength' | 'passwordMaxLength' | 'contextMinRemainingLetters'>): PolicyVerdict {
  const nfc = raw.normalize('NFC');
  const n = [...nfc].length;
  if (n < cfg.passwordMinLength) return { ok: false, reason: 'TOO_SHORT' };
  if (n > cfg.passwordMaxLength) return { ok: false, reason: 'TOO_LONG' };
  // 기본 사본은 원문 글자마다 만들어 잇는다(남은 글자를 원문 글자로 세려고. 보통 글은 한꺼번에 만든 것과 같다)
  const units = unitsOf(nfc);
  const base = units.base;
  const leet = leetCopy(base);
  const keys = keyboardCopy(base);
  // L1: 목록과 같거나 사본 전체가 꼴 규칙 조각뿐
  // 꼴 규칙은 사본 셋 모두에서 본다(바꿈 꼴로 숨긴 키보드 줄 qw3rty…도, 재리뷰 2026-11-05)
  if (lists.common.has(base) || lists.common.has(leet) || onlyShapes(base) || onlyShapes(leet) || onlyShapes(keys)) return { ok: false, reason: 'COMMON' };
  // L3~L5: 사본마다 같은 꼴의 맥락 말을 지우고 남은 것이 쉬운 덧붙임이면 막는다
  const words = contextWords(ctx, lists.serviceWords).map(baseCopy);
  // 바꿈 사본은 기본 사본과 한 글자씩 대응한다: 지울 자리는 바꿈 사본에서 찾고, 남은 글자 수는 기본 사본의 같은 자리에서 센다.
  // 꼴 규칙은 바꿈 사본 쪽 남은 글자로도 본다(qw3rty 같은 바꿈 꼴 키보드 줄)
  // (새 맥락 리뷰 2026-11-05: 바꿈 사본의 0·1·3·4·5·7이 글자로 세어져 덧붙인 날짜가 '글자 4자 이상'이 되었다)
  // 남은 글자 수는 원문 글자로 센다: 기본·바꿈 사본은 기본 사본의 자리, 키보드 사본은 그 사본의 자리에서 원문 글자를 찾는다
  const pairs: [copy: string, ws: string[], countOn: string, shapesToo: string | undefined, origin: number[]][] = [
    [base, words, base, undefined, units.baseAt],
    [leet, words.map(leetCopy), base, leet, units.baseAt],
    [keys, words.map(keyboardCopy), keys, undefined, units.keysAt],
  ];
  for (const [copy, ws, countOn, shapesToo, origin] of pairs) {
    const at = stripWords(copy, ws);
    if (at === null) continue;
    const rest = at.map((i) => countOn[i]!).join('');
    const alt = shapesToo === undefined ? undefined : at.map((i) => shapesToo[i]!).join('');
    const count = new Set(at.map((i) => origin[i]!).filter((u) => units.letter[u])).size;
    if (easyRest(rest, cfg.contextMinRemainingLetters, alt, count)) return { ok: false, reason: 'CONTEXT' };
  }
  return { ok: true };
}
