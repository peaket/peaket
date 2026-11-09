// 검색어 정규화와 비교 값(docs/features/search.md §3, ADR-0094 결정 6, ADR-0127, ADR-0242). 브라우저와 서버가 같은 코드를 쓴다.
// 낱자·초성은 es-hangul을 쓴다. NFD로 풀면 받침 ㅁ과 첫소리 ㅁ이 다른 문자라 조합 중인 글자가 맞지 않는다(§3.1).
import { canBeChoseong, convertQwertyToHangul, disassemble, getChoseong } from 'es-hangul';

/** 호환 자모 94자(U+3131~U+318E)를 NFKC로 바꾼 값 → 호환 자모(§3.1 1단계) */
const JAMO_BACK = new Map<string, string>();
for (let cp = 0x3131; cp <= 0x318e; cp++) {
  const ch = String.fromCodePoint(cp);
  const nfkc = ch.normalize('NFKC');
  if (nfkc !== ch) JAMO_BACK.set(nfkc, ch);
}

// 제로폭 문자와 보이지 않는 한글 채움 문자(§3.1 3단계)
const INVISIBLE = /[​-‍⁠﻿ᅟᅠㅤ]/g;

function pass(input: string): string {
  const nfkc = input.normalize('NFKC');
  let back = '';
  for (const ch of nfkc) back += JAMO_BACK.get(ch) ?? ch;
  return back.toLowerCase().replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** 검색어·이름을 비교의 출발점으로 바꾼다. 두 번 해도 같다(제로폭 문자를 지우면 자음·모음이 붙어 다시 합쳐질 수 있어 두 번 돈다) */
export function normalize(input: string): string {
  return pass(pass(input));
}

const noSpace = (s: string): string => s.replaceAll(' ', '');

/** 음절마다 첫소리. 한글 밖의 글자는 그대로 둔다(getChoseong은 지워서 'G드래곤'의 앞부분이 'ㄷㄹㄱ'이 된다) */
const chosungOf = (s: string): string => [...s].map((c) => (/[가-힣]/.test(c) ? getChoseong(c) : c)).join('');

export interface NameKeys {
  norm: string;
  nospace: string;
  jamo: string;
  chosung: string;
  /** 낱말마다 그 낱말부터 이름 끝까지의 값(낱말 앞부분 일치. 입력이 띄어쓰기를 넘어도 맞는다) */
  words: Array<{ tail: string; jamo: string; chosung: string }>;
}

/** 이름 하나의 비교 값 */
export function nameKeys(name: string): NameKeys {
  const norm = normalize(name);
  const nospace = noSpace(norm);
  const parts = norm.split(' ').filter(Boolean);
  return {
    norm,
    nospace,
    jamo: disassemble(nospace),
    chosung: chosungOf(nospace),
    words: parts.map((_, i) => {
      const tail = parts.slice(i).join('');
      return { tail, jamo: disassemble(tail), chosung: chosungOf(tail) };
    }),
  };
}

export interface QueryKeys {
  norm: string;
  nospace: string;
  jamo: string;
  /** 입력이 초성만일 때의 초성(§3.2 ③). 겹자음은 풀어 둔다. 아니면 null */
  chosung: string | null;
}

/** 입력 하나의 비교 값 */
export function queryKeys(q: string): QueryKeys {
  const norm = normalize(q);
  const nospace = noSpace(norm);
  const jamo = disassemble(nospace);
  const only = jamo.length > 0 && [...jamo].every((c) => canBeChoseong(c));
  return { norm, nospace, jamo, chosung: only ? jamo : null };
}

/** 일치 등급(작을수록 높다, §4.1). NONE은 맞지 않음 */
export const GRADE = { EXACT: 0, PREFIX: 1, WORD: 2, MIDDLE: 3, NONE: 4 } as const;
export type Grade = (typeof GRADE)[keyof typeof GRADE];

/** 입력 하나와 이름 하나의 일치 등급 */
export function matchGrade(q: QueryKeys, name: NameKeys): Grade {
  if (q.nospace === '') return GRADE.NONE;
  if (name.norm === q.norm || name.nospace === q.nospace) return GRADE.EXACT;
  if (name.nospace.startsWith(q.nospace) || name.jamo.startsWith(q.jamo)) return GRADE.PREFIX;
  if (q.chosung !== null && name.chosung.startsWith(q.chosung)) return GRADE.PREFIX;
  for (const w of name.words) {
    if (w.tail.startsWith(q.nospace) || w.jamo.startsWith(q.jamo)) return GRADE.WORD;
    if (q.chosung !== null && w.chosung.startsWith(q.chosung)) return GRADE.WORD;
  }
  // 중간 일치는 두 글자(한글은 두 음절) 이상일 때만 본다. 초성·낱자만의 입력은 앞부분으로만 본다
  if ([...q.nospace].length >= 2 && q.chosung === null && name.nospace.includes(q.nospace)) return GRADE.MIDDLE;
  return GRADE.NONE;
}

export interface NameItem {
  id: string;
  name: string;
  aliases: readonly string[];
}

export interface IndexedName<T extends NameItem> {
  item: T;
  keys: NameKeys[];
}

export interface NameMatch<T extends NameItem> {
  item: T;
  grade: Grade;
}

/** 이름 하나의 비교 값(큰 목록을 나눠 만들 때) */
export function indexName<T extends NameItem>(item: T): IndexedName<T> {
  return { item, keys: [item.name, ...item.aliases].map(nameKeys) };
}

const collator = new Intl.Collator('ko');

const byName = (a: { name: string; id: string }, b: { name: string; id: string }): number => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 찾기 차례(등급 → 가나다 → ID)에서 a가 b보다 앞이면 음수. 커서와 견줄 때 쓴다 */
export function compareMatch(a: { grade: number; name: string; id: string }, b: { grade: number; name: string; id: string }): number {
  return a.grade - b.grade || byName(a, b);
}

/** 가나다 → ID 차례로 둔다. 찾을 때마다 정렬하지 않게 한다 */
export function sortIndex<T extends NameItem>(index: Array<IndexedName<T>>): Array<IndexedName<T>> {
  return index.sort((a, b) => byName(a.item, b.item));
}

/** 이름 목록의 비교 값을 미리 만든다(요청마다 만들지 않게) */
export function indexNames<T extends NameItem>(items: readonly T[]): Array<IndexedName<T>> {
  return sortIndex(items.map(indexName));
}

/** index는 sortIndex를 거친 차례여야 한다. 등급마다 모아 그 차례를 지키므로 다시 정렬하지 않는다 */
function run<T extends NameItem>(index: ReadonlyArray<IndexedName<T>>, q: QueryKeys): Array<NameMatch<T>> {
  const buckets: Array<Array<NameMatch<T>>> = [[], [], [], []];
  for (const { item, keys } of index) {
    // 한 대상의 이름과 다른 이름이 함께 맞으면 더 높은 등급으로 한 번만(§4.1)
    let best: Grade = GRADE.NONE;
    for (const k of keys) {
      const g = matchGrade(q, k);
      if (g < best) best = g;
    }
    if (best !== GRADE.NONE) buckets[best]!.push({ item, grade: best });
  }
  return buckets.flat();
}

/** 미리 만든 비교 값에서 찾는다. 로마자만 쳤고 0건이면 한/영 변환 값으로 다시 찾는다(§3.2 ④) */
export function searchIndexed<T extends NameItem>(index: ReadonlyArray<IndexedName<T>>, input: string): Array<NameMatch<T>> {
  const q = queryKeys(input);
  const found = run(index, q);
  if (found.length > 0) return found;
  // 변환에는 소문자로 바꾸기 전 값을 쓴다(Shift로 친 쌍자음·겹모음이 사라지지 않게)
  const raw = input.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!/^[a-zA-Z ]+$/.test(raw)) return found;
  const exact = run(index, queryKeys(convertQwertyToHangul(raw)));
  if (exact.length > 0 || raw === q.norm) return exact;
  return run(index, queryKeys(convertQwertyToHangul(q.norm)));
}

/** 이름 목록에서 찾는다: 등급 → 가나다 → ID 차례 */
export function searchNames<T extends NameItem>(items: readonly T[], input: string): Array<NameMatch<T>> {
  return searchIndexed(indexNames(items), input);
}
