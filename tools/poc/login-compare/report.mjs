// I-T51 결과 정리(ADR-0119 결정 3의 기준 다섯, docs/features/identity.md §12.1). 시험 보고서(junit.xml)·쿠키 수와 막힌 이유
// (cookie-counts.json)·코드 줄 수를 읽어 RESULT.md를 쓴다. 판정도 여기서 결정 2·3의 규칙대로 계산한다(손으로 적지 않는다).
// 실행: node --test --test-reporter=junit --test-reporter-destination=junit.xml && node report.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const here = (f) => new URL(`./${f}`, import.meta.url);
const read = (f) => readFileSync(here(f), 'utf8');

// 기준 ②: 시험 날짜(2026-11-03)의 npm 기록
const AUTHJS = 'next-auth 5.0.0-beta.32의 엔진 @auth/core 0.41.3';
const VERSIONS = {
  A1: { pkg: `${AUTHJS}(기본 사용)`, stable: false },
  A2: { pkg: `${AUTHJS}(문서 기능만으로 고친 판)`, stable: false },
  C1: { pkg: 'openid-client 6.8.8(oauth4webapi 3.8.8 위)', stable: true },
  C2: { pkg: 'oauth4webapi 3.8.8', stable: true },
};
const NOTE = {
  A: 'next-auth v5는 베타(`latest`는 4.24.15)이고, PoC가 부른 @auth/core도 0.x다. 둘 다 2026-07-20 뒤 릴리스가 없고, next-auth README가 새 프로젝트에 Better Auth를 권한다',
  C1: '6.x 안정판. 6.8.8 2026-09-05(6.8.9가 2026-11-02에 나왔지만 3일 대기로 아직 받지 않음)',
  C2: '3.x 안정판, 의존성 없음. 3.8.8 2026-09-05',
};
// 기준 ③: 우리가 쓰는 코드(빈 줄·주석 제외). 공용 대역(harness.mjs)과 시험은 빼고, 네 구현이 함께 쓰는 앱 서버 코드는 모두에 센다
const FILES = {
  A1: ['a-authjs.mjs', 'app-common.mjs'],
  A2: ['a-authjs-hardened.mjs', 'app-common.mjs'],
  C1: ['c-openid-client.mjs', 'app-common.mjs', 'c-progress.mjs'],
  C2: ['c-oauth4webapi.mjs', 'app-common.mjs', 'c-progress.mjs'],
};
const codeLines = (f) => read(f).split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;

const xml = read('junit.xml');
/** XML 글자 참조를 한 번에 푼다(차례로 바꾸면 &amp;lt;가 두 번 풀려 <가 된다, CodeQL js/double-escaping) */
const XML_ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
const unxml = (s) => s.replace(/&(quot|amp|lt|gt|apos);/g, (_m, e) => XML_ENTITIES[e]);
const cases = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => ({
  name: unxml(m[1]),
  ok: !/<(failure|error)\b/.test(m[3] ?? ''),
}));
const counts = JSON.parse(read('cookie-counts.json'));
const impl = (n) => /^I-T51 \S+ (A1|A2|C1|C2)[ :]/.exec(n)?.[1];

const rows = {};
for (const k of Object.keys(FILES)) {
  const mine = cases.filter((c) => impl(c.name) === k);
  const c = counts[k] ?? {};
  const asvs = mine.filter((x) => x.name.includes('[ASVS'));
  rows[k] = {
    tests: `${mine.filter((x) => x.ok).length}/${mine.length}`,
    failedTests: mine.filter((x) => !x.ok).map((x) => x.name),
    sessions: c.sessionCookies ?? ['?'],
    extra: c.afterLogin ?? ['?'],
    leftover: c.afterLogout ?? ['?'],
    // ①: identity 세션 밖에 남는 세션 쿠키·저장소 수(ADR-0119 결정 3의 정의)
    c1: (c.sessionCookies ?? ['?']).length === 0,
    c2: VERSIONS[k].stable,
    c3: FILES[k].reduce((s, f) => s + codeLines(f), 0),
    // ④: ASVS 10.x·6.8.2 표시 시험이 모두 통과하고, 잘못 서명한 ID 토큰을 막았다
    c4: asvs.length > 0 && asvs.every((x) => x.ok) && c.badSignatureRejected === true,
    // ⑤: 세 제공자 정상 로그인과 네이버(이메일·id 대조). 모의 제공자 기준
    c5: mine.filter((x) => / (kakao|naver|google):/.test(x.name) || x.name.includes(' ⑥ ')).every((x) => x.ok),
    badSig: c.badSignatureRejected,
    reasons: c.blockedReasons ?? {},
  };
}

// 결정 3: "①이 0이고 ④·⑤를 통과한 안 가운데 ②가 안정판인 안을 고른다. 둘 다 그렇다면 ③이 작은 안. C가 ④·⑤를 통과하면 C로 확정"
// 결정 2: C 안에서는 oauth4webapi가 기본이고 "openid-client가 코드를 더 줄이면 그쪽"
const general = Object.entries(rows).filter(([, r]) => r.c1 && r.c4 && r.c5 && r.c2).sort((a, b) => a[1].c3 - b[1].c3).map(([k]) => k);
const cPass = ['C1', 'C2'].filter((k) => rows[k].c4 && rows[k].c5);
let pick;
let why;
if (cPass.length) {
  pick = cPass.length === 2 ? (rows.C1.c3 < rows.C2.c3 ? 'C1' : 'C2') : cPass[0];
  why = `C가 ④·⑤를 통과해 결정 3대로 C로 확정한다. C 안에서는 결정 2대로 openid-client가 oauth4webapi보다 코드가 적으면(${rows.C1.c3}줄 대 ${rows.C2.c3}줄) openid-client, 아니면 oauth4webapi다`;
} else {
  pick = general[0];
  why = pick ? '조건을 채운 안정판 가운데 ③이 가장 작은 안' : '조건을 채운 안이 없다. 결정 3대로 C를 고칠 수 있는지 먼저 본다';
}
const ok = (b) => (b ? '통과' : '미달');
const list = (a) => (a.length ? a.join(', ') : '없음');
const col = (f) => Object.keys(FILES).map((k) => f(k, rows[k])).join(' | ');
const NOTE_OF = (k) => (k.startsWith('A') ? NOTE.A : NOTE[k]);

const md = `# I-T51 로그인 구현 비교 결과

- **날짜**: 2026-11-03. **방법**: docs/features/identity.md §12.1(모의 OIDC 제공자 셋, identity 세션 대역, 쿠키 모음을 가진 브라우저 흉내). 기준은 ADR-0119 결정 3이다.
- **만드는 법**: \`node --test --test-reporter=junit --test-reporter-destination=junit.xml && node report.mjs\`(이 파일은 report.mjs가 시험 보고서·쿠키 수·막힌 이유·코드 줄 수에서 만든다).
- **A를 둘로 잰 까닭**: A1은 Auth.js 문서의 기본 사용법(Auth.js 세션, CSRF 이중 제출 쿠키)이다. A2는 같은 판을 문서에 있는 기능으로 고쳤다: signIn 콜백이 주소를 돌려주면 Auth.js 세션을 만들지 않고, CSRF 대신 Origin 대조와 \`skipCSRFCheck\`를 쓰며, profile 콜백에서 jose로 ID 토큰 서명을 확인한다(새 맥락 리뷰가 A1만으로는 Auth.js가 불리하게 잰다고 짚었다). 단서: \`skipCSRFCheck\`는 Auth.js가 '위험, 프레임워크 작성자용'으로 표시한 기능이고, signIn이 주소를 돌려주는 것은 본래 거절·다른 곳 보내기용이다. 운영에서 next-auth 표준 처리기(GET·POST)를 그대로 달면 로그인·로그아웃 POST가 CSRF 보호 없이 열린다. A의 JWKS·네이버 사용자 정보 주소는 모의 제공자 모양(\`<issuer>/jwks\`·\`<issuer>/userinfo\`)에 맞춰 적었다. 실제 제공자는 주소가 달라(구글 JWKS는 \`www.googleapis.com\`, 네이버 사용자 정보는 다른 호스트) A2의 ④·⑤와 줄 수는 모의 제공자에서만 그대로다. C는 발견 문서에서 주소를 읽는다.

| 기준 | ${col((k) => `${k}: ${VERSIONS[k].pkg}`)} |
| --- | --- | --- | --- | --- |
| 시험(통과/전체) | ${col((k, r) => r.tests)} |
| ① 세션 층(identity 밖 세션 쿠키) | ${col((k, r) => `${ok(r.c1)}: ${list(r.sessions)}`)} |
| 로그인 뒤 identity 밖 쿠키 전부 | ${col((k, r) => list(r.extra))} |
| 로그아웃 뒤 남은 identity 밖 쿠키(I-T51 ⑤) | ${col((k, r) => list(r.leftover))} |
| ② 판 유지 상태 | ${col((k, r) => `${ok(r.c2)}: ${NOTE_OF(k)}`)} |
| ③ 코드 양(우리 코드, 빈 줄·주석 제외) | ${col((k, r) => `${r.c3}줄`)} |
| ④ ASVS 10.1.1·10.1.2·10.2.1·10.2.2·10.5.1~10.5.4·6.8.2 | ${col((k, r) => `${ok(r.c4)}: 잘못 서명한 ID 토큰을 ${r.badSig ? '막음' : '받아들임'}`)} |
| ⑤ 제공자 설정(모의 제공자 기준: 셋 모두 OIDC, 네이버 이메일, sub와 사용자 정보 id) | ${col((k, r) => ok(r.c5))} |

- **B(Better Auth 1.7.15, 문서 판정)**: 무상태 모드도 세션 자료를 서명·암호화한 자기 세션 쿠키와 제공자 계정 자료를 담은 \`account_data\` 쿠키를 둔다(ADR-0119 '확인한 사실'). 그래서 ①을 넘지 못해 만들지 않았다.
- **판정**: **${pick ?? '없음'}**${pick ? `(${VERSIONS[pick].pkg})` : ''}. ${why}. 결정 3의 일반 규칙(①·④·⑤ 통과한 안정판 가운데 ③이 가장 작은 안)으로 세면 ${general.length ? general.map((k) => `${k}(${rows[k].c3}줄)`).join(', ') : '없음'} 순이다.
- **찾은 것**
  - 세 라이브러리 모두 토큰 끝점에서 TLS로 받은 ID 토큰의 서명을 기본으로 보지 않는다(OIDC Core 3.1.3.7이 허용). ASVS 6.8.2(이 저장소의 판정은 '수신 즉시 무조건 검증')를 지키려면 openid-client는 \`enableNonRepudiationChecks\`, oauth4webapi는 \`validateApplicationLevelSignature\`를 불러야 한다. Auth.js에는 이것을 켤 설정이 없고, A2처럼 profile 콜백에서 직접 확인하는 코드를 더해야 한다.
  - Auth.js(@auth/core 0.41.3)는 제공자 호출에 http 주소도 늘 허용한다(\`allowInsecureRequests\`를 조건 없이 켠다). 운영 제공자는 https라 당장 해는 없지만, 설정 실수를 막지 못한다.
  - Auth.js는 문서 기능으로 세션 쿠키와 CSRF 쿠키를 없애도 돌아갈 주소 쿠키(\`authjs.callback-url\`)는 남긴다(세션 쿠키는 아니다).
  - 코드가 가장 적은 안은 ${Object.entries(rows).sort((a, b) => a[1].c3 - b[1].c3)[0][0]}(${Math.min(...Object.values(rows).map((r) => r.c3))}줄)이다. C1·C2의 차이(${Math.abs(rows.C1.c3 - rows.C2.c3)}줄)는 의미 있는 차이가 아니고, 결정 2의 규칙대로 적은 쪽을 고른다. A를 가른 것은 ②(베타·0.x)이고, 기본 사용법(A1)에서는 ①·④도 미달이다.
- **남는 것(소유자 몫, [확인 필요])**: ⑤는 모의 제공자 기준이다. 실제 카카오·네이버·구글의 \`sub\`와 사용자 정보 \`id\`의 관계와 네이버 이메일은 제공자 앱을 등록해야 볼 수 있다. 우리 코드는 둘을 대조하고 다르면 막으므로, 실제 네이버에서 둘이 다르면 네이버 로그인이 전부 막힌다(어느 안이든 같다).

## 막힌 이유(${pick ?? 'C1'}, 구현이 서버 쪽에만 남긴 오류)

| 시나리오 | 이유 |
| --- | --- |
${Object.entries(rows[pick ?? 'C1'].reasons).map(([l, r]) => `| ${l} | ${r.join(' ; ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/^callback: /, '') || '(없음)'} |`).join('\n')}
${Object.values(rows).some((r) => r.failedTests.length) ? `\n## 실패한 시험\n\n${Object.entries(rows).flatMap(([k, r]) => r.failedTests.map((t) => `- ${k}: ${t}`)).join('\n')}\n` : ''}`;
writeFileSync(here('RESULT.md'), md);
console.log(md);
