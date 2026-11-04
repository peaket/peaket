// 관리 계정 비밀번호 대조 목록 파일 읽기(docs/security/auth-controls.md §4.1·§4.2, identity §6 '관리 계정 비밀번호 저장과 정책의 첫 구현', BUILD_ORDER BOT-110).
// L1 흔한 비밀번호(data/common-passwords.txt, 출처·판은 대기 OPEN[19])와 L3 서비스 맥락 말(data/service-context-words.txt)을 시작할 때 한 번 읽는다.
// 운영 도메인 같은 공개하지 않는 L3 말은 배포가 넣은 파일(PEAKET_AUTH_CONTEXT_WORDS_FILE)에서 더한다(ADR-0153). 그 파일이 없으면 시작하지 않는다.
import { readFileSync } from 'node:fs';
import { commonPasswordSet, type PolicyLists } from '../domain/password-policy.js';

export const COMMON_PASSWORDS_FILE = new URL('../../../../data/common-passwords.txt', import.meta.url);
export const SERVICE_CONTEXT_WORDS_FILE = new URL('../../../../data/service-context-words.txt', import.meta.url);
export const CONTEXT_WORDS_FILE_ENV = 'PEAKET_AUTH_CONTEXT_WORDS_FILE';

/** 한 줄에 하나, 빈 줄과 # 줄은 뺀다 */
function lines(file: URL | string): string[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

export function loadPolicyLists(env: Record<string, string | undefined>, files: { common?: URL; serviceWords?: URL } = {}): PolicyLists {
  const serviceWords = lines(files.serviceWords ?? SERVICE_CONTEXT_WORDS_FILE);
  const extra = env[CONTEXT_WORDS_FILE_ENV];
  if (extra) {
    try {
      serviceWords.push(...lines(extra));
    } catch (e) {
      throw new Error(`${CONTEXT_WORDS_FILE_ENV}의 파일을 읽지 못했다(${(e as { code?: string }).code ?? 'error'})`);
    }
  }
  return { common: commonPasswordSet(lines(files.common ?? COMMON_PASSWORDS_FILE)), serviceWords };
}
