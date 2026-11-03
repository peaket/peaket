# I-T51 로그인 구현 비교 결과

- **날짜**: 2026-11-03. **방법**: docs/features/identity.md §12.1(모의 OIDC 제공자 셋, identity 세션 대역, 쿠키 모음을 가진 브라우저 흉내). 기준은 ADR-0119 결정 3이다.
- **만드는 법**: `node --test --test-reporter=junit --test-reporter-destination=junit.xml && node report.mjs`(이 파일은 report.mjs가 시험 보고서·쿠키 수·막힌 이유·코드 줄 수에서 만든다).
- **A를 둘로 잰 까닭**: A1은 Auth.js 문서의 기본 사용법(Auth.js 세션, CSRF 이중 제출 쿠키)이다. A2는 같은 판을 문서에 있는 기능으로 고쳤다: signIn 콜백이 주소를 돌려주면 Auth.js 세션을 만들지 않고, CSRF 대신 Origin 대조와 `skipCSRFCheck`를 쓰며, profile 콜백에서 jose로 ID 토큰 서명을 확인한다(새 맥락 리뷰가 A1만으로는 Auth.js가 불리하게 잰다고 짚었다). 단서: `skipCSRFCheck`는 Auth.js가 '위험, 프레임워크 작성자용'으로 표시한 기능이고, signIn이 주소를 돌려주는 것은 본래 거절·다른 곳 보내기용이다. 운영에서 next-auth 표준 처리기(GET·POST)를 그대로 달면 로그인·로그아웃 POST가 CSRF 보호 없이 열린다. A의 JWKS·네이버 사용자 정보 주소는 모의 제공자 모양(`<issuer>/jwks`·`<issuer>/userinfo`)에 맞춰 적었다. 실제 제공자는 주소가 달라(구글 JWKS는 `www.googleapis.com`, 네이버 사용자 정보는 다른 호스트) A2의 ④·⑤와 줄 수는 모의 제공자에서만 그대로다. C는 발견 문서에서 주소를 읽는다.

| 기준 | A1: next-auth 5.0.0-beta.32의 엔진 @auth/core 0.41.3(기본 사용) | A2: next-auth 5.0.0-beta.32의 엔진 @auth/core 0.41.3(문서 기능만으로 고친 판) | C1: openid-client 6.8.8(oauth4webapi 3.8.8 위) | C2: oauth4webapi 3.8.8 |
| --- | --- | --- | --- | --- |
| 시험(통과/전체) | 18/18 | 18/18 | 18/18 | 18/18 |
| ① 세션 층(identity 밖 세션 쿠키) | 미달: authjs.session-token | 통과: 없음 | 통과: 없음 | 통과: 없음 |
| 로그인 뒤 identity 밖 쿠키 전부 | authjs.callback-url, authjs.csrf-token, authjs.session-token | authjs.callback-url | 없음 | 없음 |
| 로그아웃 뒤 남은 identity 밖 쿠키(I-T51 ⑤) | authjs.callback-url, authjs.csrf-token | authjs.callback-url | 없음 | 없음 |
| ② 판 유지 상태 | 미달: next-auth v5는 베타(`latest`는 4.24.15)이고, PoC가 부른 @auth/core도 0.x다. 둘 다 2026-07-20 뒤 릴리스가 없고, next-auth README가 새 프로젝트에 Better Auth를 권한다 | 미달: next-auth v5는 베타(`latest`는 4.24.15)이고, PoC가 부른 @auth/core도 0.x다. 둘 다 2026-07-20 뒤 릴리스가 없고, next-auth README가 새 프로젝트에 Better Auth를 권한다 | 통과: 6.x 안정판. 6.8.8 2026-09-05(6.8.9가 2026-11-02에 나왔지만 3일 대기로 아직 받지 않음) | 통과: 3.x 안정판, 의존성 없음. 3.8.8 2026-09-05 |
| ③ 코드 양(우리 코드, 빈 줄·주석 제외) | 148줄 | 133줄 | 165줄 | 170줄 |
| ④ ASVS 10.1.1·10.1.2·10.2.1·10.2.2·10.5.1~10.5.4·6.8.2 | 미달: 잘못 서명한 ID 토큰을 받아들임 | 통과: 잘못 서명한 ID 토큰을 막음 | 통과: 잘못 서명한 ID 토큰을 막음 | 통과: 잘못 서명한 ID 토큰을 막음 |
| ⑤ 제공자 설정(모의 제공자 기준: 셋 모두 OIDC, 네이버 이메일, sub와 사용자 정보 id) | 통과 | 통과 | 통과 | 통과 |

- **B(Better Auth 1.7.15, 문서 판정)**: 무상태 모드도 세션 자료를 서명·암호화한 자기 세션 쿠키와 제공자 계정 자료를 담은 `account_data` 쿠키를 둔다(ADR-0119 '확인한 사실'). 그래서 ①을 넘지 못해 만들지 않았다.
- **판정**: **C1**(openid-client 6.8.8(oauth4webapi 3.8.8 위)). C가 ④·⑤를 통과해 결정 3대로 C로 확정한다. C 안에서는 결정 2대로 openid-client가 oauth4webapi보다 코드가 적으면(165줄 대 170줄) openid-client, 아니면 oauth4webapi다. 결정 3의 일반 규칙(①·④·⑤ 통과한 안정판 가운데 ③이 가장 작은 안)으로 세면 C1(165줄), C2(170줄) 순이다.
- **찾은 것**
  - 세 라이브러리 모두 토큰 끝점에서 TLS로 받은 ID 토큰의 서명을 기본으로 보지 않는다(OIDC Core 3.1.3.7이 허용). ASVS 6.8.2(이 저장소의 판정은 '수신 즉시 무조건 검증')를 지키려면 openid-client는 `enableNonRepudiationChecks`, oauth4webapi는 `validateApplicationLevelSignature`를 불러야 한다. Auth.js에는 이것을 켤 설정이 없고, A2처럼 profile 콜백에서 직접 확인하는 코드를 더해야 한다.
  - Auth.js(@auth/core 0.41.3)는 제공자 호출에 http 주소도 늘 허용한다(`allowInsecureRequests`를 조건 없이 켠다). 운영 제공자는 https라 당장 해는 없지만, 설정 실수를 막지 못한다.
  - Auth.js는 문서 기능으로 세션 쿠키와 CSRF 쿠키를 없애도 돌아갈 주소 쿠키(`authjs.callback-url`)는 남긴다(세션 쿠키는 아니다).
  - 코드가 가장 적은 안은 A2(133줄)이다. C1·C2의 차이(5줄)는 의미 있는 차이가 아니고, 결정 2의 규칙대로 적은 쪽을 고른다. A를 가른 것은 ②(베타·0.x)이고, 기본 사용법(A1)에서는 ①·④도 미달이다.
- **남는 것(소유자 몫, [확인 필요])**: ⑤는 모의 제공자 기준이다. 실제 카카오·네이버·구글의 `sub`와 사용자 정보 `id`의 관계와 네이버 이메일은 제공자 앱을 등록해야 볼 수 있다. 우리 코드는 둘을 대조하고 다르면 막으므로, 실제 네이버에서 둘이 다르면 네이버 로그인이 전부 막힌다(어느 안이든 같다).

## 막힌 이유(C1, 구현이 서버 쪽에만 남긴 오류)

| 시나리오 | 이유 |
| --- | --- |
| ② | 로그인 진행 상태가 없다 |
| ③ state | invalid response encountered / OAUTH_INVALID_RESPONSE / unexpected "state" response parameter value / OAUTH_INVALID_RESPONSE |
| ③ nonce | unexpected JWT claim value encountered / OAUTH_JWT_CLAIM_COMPARISON_FAILED / unexpected ID Token "nonce" claim value / OAUTH_JWT_CLAIM_COMPARISON_FAILED |
| ③ 코드 주입 | server responded with an error in the response body / OAUTH_RESPONSE_BODY_ERROR / invalid_grant / PKCE / invalid_grant / PKCE |
| ③ 쿠키 __Host-peaket_oidc | 로그인 진행 상태가 없다 |
| ③ 재사용 | server responded with an error in the response body / OAUTH_RESPONSE_BODY_ERROR / invalid_grant / invalid_grant |
| ③ 만료 | JWT timestamp claim value failed validation / OAUTH_JWT_TIMESTAMP_CHECK_FAILED / unexpected JWT "exp" (expiration time) claim value, expiration is past current timestamp / OAUTH_JWT_TIMESTAMP_CHECK_FAILED |
| ④ wrongIss | unexpected JWT claim value encountered / OAUTH_JWT_CLAIM_COMPARISON_FAILED / unexpected JWT "iss" (issuer) claim value / OAUTH_JWT_CLAIM_COMPARISON_FAILED |
| ④ wrongAud | unexpected JWT claim value encountered / OAUTH_JWT_CLAIM_COMPARISON_FAILED / unexpected JWT "aud" (audience) claim value / OAUTH_JWT_CLAIM_COMPARISON_FAILED |
| ④ 발견 문서 issuer | discovery: discovered metadata issuer does not match the expected issuer / OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED |
| ④ 서명 | invalid response encountered / OAUTH_INVALID_RESPONSE / JWT signature verification failed / OAUTH_INVALID_RESPONSE |
| ⑥ id 불일치 | 네이버 사용자 정보 id가 ID 토큰 sub와 다르다 |
