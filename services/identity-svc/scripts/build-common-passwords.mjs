// 관리 계정 비밀번호 L1 흔한 비밀번호 목록 만들기(docs/security/auth-controls.md §4.1 L1, ASVS v5.0.0-6.2.4, 소유자 결정 2026-11-05 OPEN[19]).
// 고정한 판의 공개 목록 파일을 손으로 받아 경로로 넘기면, SHA-256을 견주고 15자 이상만 흔한 순서 그대로 남겨 data/common-passwords.txt를 쓴다.
// 이 스크립트는 내려받지 않는다(파일 내려받기는 소유자 허락이 필요하다). 판을 올릴 때는 아래 셋을 함께 고치고 같은 PR에서 목록 파일을 다시 만든다.
//   node services/identity-svc/scripts/build-common-passwords.mjs <받은 파일>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'danielmiessler/SecLists';
const PATH = 'Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt';
const COMMIT = '00f80ec9cc39bed63ee40cf6805a6b1b77e87644';
const SHA256 = '424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51';
/** 관리 계정 비밀번호의 가장 짧은 길이(NFC 글자 수, auth-controls §4). 원본 전체에서 이 길이를 채우는 것은 모두 넣는다 */
const MIN_LENGTH = 15;
/**
 * 길이와 상관없이 넣는 가장 흔한 것의 수 [가정]. 대조는 기본 사본(소문자, 공백·-·_·. 지움)으로 하므로
 * 짧은 흔한 비밀번호에 구분 글자를 끼워 15자를 채운 것(`p.a.s.s.w.o.r.d`, `i love you baby`)도 막으려고 짧은 것도 넣는다(새 맥락 리뷰 2026-11-05)
 */
const TOP_ANY_LENGTH = 100_000;
const OUT = new URL('../data/common-passwords.txt', import.meta.url);
/** MIT 사용 허가는 저작권 표시와 허가 문구를 사본에 함께 두게 한다 */
const LICENSE = [
  'MIT License',
  '',
  'Copyright (c) 2018 Daniel Miessler',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
];

const src = process.argv[2];
if (!src) {
  console.error('받은 목록 파일의 경로를 넘긴다');
  process.exit(2);
}
const bytes = readFileSync(src);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== SHA256) {
  console.error(`SHA-256이 고정한 판과 다르다: ${sha}`);
  process.exit(1);
}
const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const seen = new Set();
const kept = [];
let long = 0;
const rows = text.split(/\r?\n/);
for (const [rank, raw] of rows.entries()) {
  const s = raw.normalize('NFC');
  // 앞뒤 공백·제어 문자가 든 줄과 # 줄(목록 파일의 설명 줄과 헷갈린다)은 뺀다
  if (s === '' || s !== s.trim() || s.startsWith('#') || /\p{C}/u.test(s)) continue;
  const isLong = [...s].length >= MIN_LENGTH;
  if ((!isLong && rank >= TOP_ANY_LENGTH) || seen.has(s)) continue;
  seen.add(s);
  kept.push(s);
  if (isLong) long++;
}
const header = [
  '# 관리 계정 비밀번호 L1 흔한 비밀번호 목록(docs/security/auth-controls.md §4.1, ASVS v5.0.0-6.2.4, 소유자 결정 2026-11-05 OPEN[19]).',
  `# 출처: https://github.com/${REPO} 의 ${PATH}(흔한 것부터 정렬, SecLists는 MIT 사용 허가)`,
  `# 고정한 판: 커밋 ${COMMIT}, 받은 파일 sha256 ${SHA256}`,
  `# 거른 규칙: NFC로 맞춘 뒤 원본 전체에서 ${MIN_LENGTH}자 이상인 것과 가장 흔한 ${TOP_ANY_LENGTH.toLocaleString('en-US')}줄 안의 것(길이 상관없음. 대조는 구분 글자를 지운 사본으로 하므로), 앞뒤 공백·제어 문자·# 줄 빼기, 같은 줄 하나만, 순서는 원본 그대로.`,
  `# 개수: 모두 ${kept.length}개(${MIN_LENGTH}자 이상 ${long}개).`,
  '# 다시 만들기: node services/identity-svc/scripts/build-common-passwords.mjs <받은 파일>. 꼴 규칙(키보드 한 줄 연속·같은 글자 반복·연속 숫자)은 이 목록 없이도 막는다.',
  '#',
  '# SecLists의 사용 허가 문구(MIT, 그 판의 LICENSE 파일 그대로):',
  ...LICENSE.map((l) => (l === '' ? '#' : `# ${l}`)),
];
writeFileSync(OUT, `${header.join('\n')}\n${kept.join('\n')}\n`);
console.log(`${kept.length}개를 썼다`);
