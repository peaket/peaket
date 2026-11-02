# ADR-0119: 로그인 구현을 다시 정한다 — 파트너 로그인은 게이트웨이를 거쳐 identity로, 소셜 로그인은 얇은 OIDC 클라이언트를 기본안으로 두고 Auth.js와 PoC로 견준다(2026-10-28)

- **상태**: 채택 (2026-10-28. 기술 검토(review/tech-review.md)의 중간-019 'Auth.js가 맡는 일(코드 교환·ID 토큰 검증)에 비해 무겁고, 파트너 Credentials를 쓸 이유가 약하다'에 소유자가 "나머지 건수들은 모두 추천안에 동의합니다. 그렇게 모두 수정해주세요."라고 정했다. 방향(파트너 로그인을 게이트웨이 경로로, 얇은 OIDC 클라이언트를 PoC 비교에 넣고 결정을 ADR로 남기기)은 소유자 결정(추천안 승인)이고, 쿠키 모양·판정 기준·일정 같은 세부는 추천 적용이다. ADR-0011 결정 5를 보완한다. 외부 사실은 2026-10-28에 npm 레지스트리, GitHub 원문, 제공자 발견 문서로 확인했다) I-T51 결과(2026-11-03, BUILD_ORDER PRF-010): 결정 3대로 C로 확정하고, C 안에서는 결정 2대로 코드가 적은 `openid-client` 6을 골랐다(165줄, `oauth4webapi` 직접은 170줄. 차이는 작다). Auth.js는 둘로 쟀다. 기본 사용법(A1)은 ①(Auth.js 세션 쿠키)·④(ID 토큰 서명을 보지 않음)가 미달이고, 문서 기능만으로 고친 판(A2: signIn 콜백이 주소를 돌려줘 세션을 만들지 않고, `skipCSRFCheck`와 Origin 대조, profile 콜백에서 jose로 서명 확인)은 ①·④·⑤를 통과하며 코드가 가장 적다(133줄, 모의 제공자 모양에 맞춘 주소 기준). A를 가른 것은 ②(next-auth v5 베타, @auth/core 0.x)다. 세 라이브러리 모두 TLS로 받은 ID 토큰의 서명을 기본으로 보지 않아 C는 `enableNonRepudiationChecks`를 켠다(ASVS v5.0.0-6.8.2). ⑤는 모의 제공자 기준이다. 표는 `tools/poc/login-compare/RESULT.md`.
- **관련**: ADR-0001, ADR-0011(결정 4·5), ADR-0038, ADR-0053(결정 8), ADR-0065(결정 2·5·11), ADR-0079(결정 22), FR-001, FR-021, FR-048, POL-019, POL-020, SCR-004, SCR-005, SCR-020, SCR-039, I-T51, I-T52, [docs/features/identity.md](../features/identity.md) §2·§3·§6·§12, [docs/frontend.md](../frontend.md) §2·§5.14.5·§5.14.6·§6.3·§6.4, [docs/security/asvs/auth.md](../security/asvs/auth.md) V3·V6.8·V7.1.3·V10·V13.3.1, [docs/security/secrets-and-keys.md](../security/secrets-and-keys.md), docs/api/openapi.yaml(`/v1/partner/auth/sessions`), docs/api/guidelines.md §7·§8, docs/architecture.md §1·§3, wbs 2.1, [review/tech-review.md](../review/tech-review.md)(중간-019)

## 맥락

- **세션이 두 층이다.** identity-svc가 계정·세션·액세스 토큰·리프레시 토큰을 모두 가진다(ADR-0011). 소비자 웹의 Auth.js가 할 일은 소셜 제공자와 인가 코드를 바꾸고 ID 토큰을 확인하는 것뿐이다. 그런데 Auth.js는 자기 세션 쿠키(`__Host-authjs.session-token`, JWE로 암호화)를 따로 둔다.
  - 그 쿠키의 수명은 'Auth.js 설정값을 따른다'로 비어 있다(docs/features/identity.md §3).
  - 로그아웃·강제 종료·계정 병합 때 identity 세션과 Auth.js 세션을 둘 다 맞춰야 한다.
  - 앱마다 Auth.js 비밀을 따로 두고 180일마다 바꾸는 규칙(ADR-0053 결정 8)도 이 층 때문에 생겼다.
- **ADR-0011의 기각 이유가 순환한다.** 대안 1('identity-svc가 OAuth 콜백까지 처리')을 "Next.js가 어차피 Auth.js로 콜백을 받으므로"라는 이유로 버렸다. Auth.js를 쓴다는 전제로 Auth.js를 고른 셈이다.
- **관리 로그인 방식이 둘이다.** 파트너 콘솔은 Auth.js Credentials로 이메일·비밀번호·TOTP를 받아 identity에 검증을 맡긴다. 관제 콘솔은 같은 일을 앱 서버 없이 gw-ops로 identity의 관리 계정 로그인 API를 바로 부른다. 파트너 쪽은 Auth.js의 주된 기능(OAuth 흐름, PKCE, state)을 하나도 쓰지 않으면서 Auth.js 세션과 PEAKET 토큰 쿠키라는 두 상태를 둔다.
- **판 상태가 바뀌었다.** frontend.md는 'Better Auth로 옮겨 보는 PoC'만 계획했다(§6.3). 그런데 Better Auth도 자기 세션을 두는 더 큰 프레임워크라, identity가 세션을 가진다는 원칙과 겹친다.
- **확인한 사실**(2026-10-28 원문)
  - npm `next-auth`: `latest`는 4.24.15(2026-07-20), `beta`는 5.0.0-beta.32(2026-07-20)다. v5는 아직 베타다.
  - next-auth 저장소 README: "Auth js is now part of Better Auth. We recommend new projects to start with Better Auth unless there are some very specific feature gaps (most notably stateless session management without a database)."
  - `@auth/core` 0.41.3(2026-07-20)은 `oauth4webapi` ^3.3.0에 기대어 OAuth·OIDC를 처리한다.
  - `oauth4webapi` 3.8.8(2026-09-05)은 의존성이 없는 MIT 라이브러리다. 같은 저자의 `openid-client` 6.8.8(2026-09-05, MIT)은 `oauth4webapi` ^3.8.8과 `jose` 위에 만든 한 단계 높은 클라이언트다.
  - Auth.js Credentials 공급자 소스 주석: "The functionality provided for credentials-based authentication is intentionally limited to discourage the use of passwords due to the inherent security risks of the username-password model."
  - Better Auth 1.7.14(2026-10-26, MIT)는 기본으로 세션을 자기 DB에 둔다. DB를 주지 않으면 무상태 모드가 되어, 세션 자료를 서명·암호화한 쿠키에 두고 OAuth 흐름 뒤 제공자 계정 자료(OAuth 토큰 포함)를 암호화한 `account_data` 쿠키에 둔다(Better Auth 문서 '세션 관리'). 어느 쪽이든 identity 밖에 세션 층이 하나 더 생긴다.
  - 세 제공자의 OIDC 발견 문서(제공자가 공개하는 OIDC 설정 문서): 카카오 issuer `https://kauth.kakao.com`, 네이버 issuer `https://nid.naver.com`(인가 주소 `/oauth2/authorize`), 구글 issuer `https://accounts.google.com`. 셋 모두 PKCE `S256`과 RS256 ID 토큰 서명을 알린다. 카카오와 네이버의 클레임 목록에는 `nonce`가 있다. 네이버 클레임 목록에는 이메일이 없다.

## 결정

1. **파트너 로그인을 관제와 같은 길로 바꾼다(소유자 승인).**
   - 파트너 로그인 화면(SCR-020)은 `partner-api`의 `POST /v1/partner/auth/sessions`를 두 단계(이메일·비밀번호 → TOTP)로 부른다. gw-partner가 identity의 관리 계정 로그인 API로 넘긴다. 관제의 gw-ops와 같은 모양이다.
   - 파트너 액세스 토큰 쿠키(`__Secure-peaket_partner_at`)와 리프레시 토큰 쿠키(`__Secure-peaket_partner_rt`)는 로그인과 갱신 모두 gw-partner 응답이 준다. 응답 본문에는 토큰이 없다. 쿠키 이름·속성·`Domain`은 지금 그대로다(파트너 앱 서버의 서버 컴포넌트도 액세스 토큰을 읽어 gw-partner를 부르기 때문이다).
   - 파트너 앱 서버에서 Auth.js(Credentials)를 뺀다. 앱 서버는 로그인 상태를 따로 갖지 않는다.
   - 로그인 요청은 JSON 본문이라 다른 출처에서 부르면 브라우저가 사전 요청(OPTIONS)을 보낸다. gw-partner는 `Origin`을 파트너 콘솔 출처와 대조한다(ADR-0065 결정 5). 연속 실패 잠금과 사람 확인(Turnstile)은 지금처럼 identity가 한다(docs/features/identity.md §6).
   - 시험은 I-T52다.
2. **소셜 로그인의 기본안은 앱 서버의 얇은 OIDC 클라이언트다(방향은 소유자 승인, 세부는 추천 적용).** 아래를 '대안 C'라 부른다.
   - 소비자 웹 앱 서버(BFF, 화면 쪽 앱 서버)가 `oauth4webapi` 3으로 인가 코드 흐름을 직접 한다. 같은 저자의 `openid-client` 6이 코드를 더 줄이면 그쪽을 쓴다. 둘 가운데 무엇을 쓸지는 결정 3의 PoC에서 고른다.
   - 카카오·네이버·구글을 모두 발견 문서의 issuer로 둔 OIDC 제공자로 설정한다. PKCE(`S256`)·state·nonce를 모두 검사하고, ID 토큰의 서명(제공자 JWKS의 RS256)·`iss`·`aud`·`exp`·`nonce`를 확인한다.
   - 네이버 ID 토큰에는 이메일이 없다. 그래서 이메일은 네이버 사용자 정보 API로 받는다. 이메일 검증 여부를 주지 않으므로 가입 때 연결 제안 대상에서 빼는 지금 규칙(docs/features/identity.md §2.1)은 그대로다.
   - 계정 키 `(provider, provider_user_id)`의 `provider_user_id`는 ID 토큰의 `sub`로 정하고 처음부터 바꾸지 않는다. 사용자 정보 API의 `id`와 같은 값인지는 I-T51에서 확인한다 [확인 필요]. I-T51(2026-11-03)은 모의 제공자로 우리 코드가 둘을 대조하고 다르면 막는지까지만 확인했다. 실제 제공자의 관계는 제공자 앱을 등록해야 볼 수 있어 소유자 몫으로 남는다.
   - 로그인 진행 상태는 쿠키 하나 `__Host-peaket_oidc`에 둔다. 제공자, state, nonce, PKCE 코드 베리파이어, 돌아갈 주소를 앱 서버 전용 키로 암호화(AES-256-GCM)해 담는다. `HttpOnly`·`Secure`·`SameSite=Lax`(제공자에서 돌아오는 최상위 이동에 실려야 한다)이고 수명은 10분 [가정]이다. 콜백에서 한 번 쓰고 바로 지운다.
   - 콜백이 성공하면 앱 서버는 지금과 같은 메시 mTLS 내부 경로로 identity의 세션 생성을 부르고, PEAKET 액세스·리프레시 쿠키만 준다. 앱 서버 자체의 세션 쿠키는 두지 않는다. 그래서 세션은 identity 한 층이다.
   - 로그인 시작과 로그아웃은 앱 서버의 POST 경로다. `Origin`을 소비자 웹 출처와 대조한다(ADR-0065 결정 5와 같은 규칙). 로그아웃은 identity 세션을 끝내고(세션 종료 이벤트) 쿠키를 지운다.
   - 계정 연결 제안 임시 쿠키 `__Host-peaket_link`와 연결·병합 흐름(ADR-0038)은 그대로다.
3. **인증 구현을 시작하기 전에 PoC로 견주고, 정해 둔 기준으로 고른다(추천 적용).**
   - 후보: A는 next-auth v5(Auth.js) 고정 판, B는 Better Auth 무상태 모드, C는 결정 2다. PoC는 A와 C를 만든다. B는 문서로 판정한다. 무상태 모드도 Better Auth 세션 쿠키를 두어 아래 기준 ①을 넘지 못하기 때문이다.
   - 기준(측정 전에 고정한다)

     | 기준 | 보는 것 | 통과 |
     | --- | --- | --- |
     | ① 세션 층 수 | identity 세션 밖에 남는 세션 쿠키·저장소 수 | 0 |
     | ② 판 유지 상태 | 안정판인지, 최근 12개월 릴리스와 보안 공지 대응 | 안정판 |
     | ③ 코드 양 | 우리가 쓰는 코드와 설정 줄 수(제공자 셋, 콜백, 오류 처리 포함) | 적을수록 좋다(비교만) |
     | ④ ASVS 10.x 충족 | 10.1.1·10.1.2·10.2.1·10.2.2·10.5.1~10.5.4와 6.8.2를 시험으로 확인(docs/security/asvs/auth.md) | 모두 통과 |
     | ⑤ 제공자 설정 | 세 제공자가 OIDC로 되는지, 네이버 이메일, `sub`와 사용자 정보 `id`의 관계 | 모두 됨 |

   - 판정: ①이 0이고 ④·⑤를 통과한 안 가운데 ②가 안정판인 안을 고른다. 둘 다 그렇다면 ③이 작은 안을 고른다. C가 ④·⑤를 통과하면 C로 확정한다. C가 실패하면 고칠 수 있는지 먼저 보고, 고칠 수 없으면 A(고정 판)로 간다. 그때 A의 Auth.js 쿠키 규칙(`__Host-authjs.*`)과 앱별 비밀(ADR-0053 결정 8)을 되살린다.
   - 시험: I-T51(로그인 구현 비교)과 I-T52(파트너 로그인 경로). 결과는 이 ADR 상태 줄과 `tools/poc/login-compare/RESULT.md`에 남긴다(성능 숫자가 없어 성능 장부에는 남기지 않는다, 추천 적용 2026-11-03, docs/features/identity.md §12.1).
4. **문서 반영(추천 적용)**
   - docs/features/identity.md §2(순서도, OIDC 설정)·§3(쿠키 표와 이름 규칙)·§6(콘솔별 로그인)·§12(I-T51·I-T52)
   - docs/frontend.md(스택 표, 경로 표의 로그인, 위험 구성 요소 표, 서버 비밀, PoC 표, 확인한 사실), docs/security/asvs/auth.md(V3 쿠키·CSRF 행, 6.8.2·6.8.4, 7.1.3, V10 행, 13.3.1), docs/security/secrets-and-keys.md(제공자 비밀 행, Auth.js 비밀 행을 로그인 진행 쿠키 키로)
   - docs/api/openapi.yaml `/v1/partner/auth/sessions`, docs/api/guidelines.md(인증 흐름), docs/architecture.md(C4 그림과 통신 표의 'Auth.js' 표기), docs/infra-handover.md(앱 서버 표기)
   - ADR-0011은 상태 줄에만 적는다.
5. **일정(추천 적용)**: wbs 2.1에 새 작업 '로그인 구현 비교 PoC(I-T51)' 1일 [가정]을 2.1.1 앞에 둔다. 2.1.1은 '얇은 OIDC 클라이언트 → 내부 세션 생성'으로, 2.1.2의 'Auth.js 쿠키 설정'은 '로그인 진행 쿠키'로 읽는다(일수 그대로). 파트너 로그인 경로(I-T52)는 3.5.1 안에서 한다. 관제와 같은 모양이라 Auth.js Credentials를 짜는 일이 빠져 일수는 그대로다.

## 검토한 대안

| 대안 | 고르지 않은 이유 |
| --- | --- |
| A. Auth.js v5 고정 판을 그대로 쓴다(지금) | 세션이 두 층이다. 판은 베타이고, 저장소가 새 프로젝트에 Better Auth를 권한다. 우리가 쓰는 기능은 코드 교환과 ID 토큰 확인뿐이다. C가 PoC에서 실패하면 돌아갈 자리로 남긴다 |
| B. Better Auth로 옮긴다(frontend.md의 지금 계획) | 기본은 사용자·세션을 자기 DB에 둔다. DB 없는 무상태 모드도 자기 세션 쿠키와, 제공자 토큰을 담은 계정 쿠키를 둔다. identity가 세션과 토큰을 가진다는 원칙(ADR-0011)과 겹친다 |
| identity-svc가 OAuth 콜백까지 받는다(ADR-0011 대안 1) | ADR-0011의 기각 이유가 순환해 다시 봤다. 앱 서버에 제공자 비밀이 없어지는 이점은 있다. 그러나 ① 콜백이 `api` 호스트의 gw-fan을 지나야 해서, 토큰만 검증하는 게이트웨이에 인증 없는 리디렉션 경로가 생긴다. ② 로그인 바로 뒤의 화면 흐름(가입 동의 SCR-005, 연결 제안 SCR-039)이 소비자 웹에 있어 로그인 상태 쿠키가 두 호스트로 나뉜다. C는 같은 일을 앱 서버 한 곳에서 하고 identity의 내부 세션 생성 계약을 그대로 쓴다 |
| 파트너 콘솔만 그대로 Auth.js Credentials | Credentials는 비밀번호 방식을 권하지 않으려고 기능을 일부러 줄였다고 소스가 밝힌다. 관제와 방식이 둘로 남고, 파트너 쪽에만 세션 층이 하나 더 있다 |

## 결과와 트레이드오프

- 세션이 identity 한 층으로 준다. 로그아웃·강제 종료·병합 때 맞출 곳이 하나다. Auth.js 쿠키 묶음과 앱별 Auth.js 비밀(180일 교체)이, 로그인 중에만 있는 쿠키 하나와 그 암호화 키 하나로 준다.
- 베타 의존 하나가 빠진다. `oauth4webapi`는 의존성이 없는 라이브러리이고, Auth.js도 같은 라이브러리 위에서 돈다.
- 파트너와 관제의 관리 로그인이 같은 모양(게이트웨이 → identity)이 된다. 시험과 위협 검토도 한 벌이다.
- 대가
  - 인가 코드 흐름의 코드(로그인 시작, 콜백, 오류 처리, 제공자별 설정)를 우리가 짠다. 표준 검사는 라이브러리가 하지만, 검사를 빠뜨리면 우리 결함이다. I-T51과 ASVS 10.x 시험이 이것을 막는다.
  - 파트너 로그인은 다른 출처로 보내는 JSON 요청이라 사전 요청이 하나 더 생긴다. 로그인은 드물어 지연 영향은 작다.

## 되돌릴 조건

- I-T51에서 C가 ASVS 10.x나 제공자 설정(⑤)을 통과하지 못하고 고칠 수 없으면, A(Auth.js v5 고정 판)로 간다.
- next-auth v5가 안정판이 되고, C의 유지 부담(제공자 규격이 바뀔 때 고치는 시간)이 커지면 다시 견준다.
- 앱 서버의 제공자 비밀 관리가 문제가 되면, identity가 콜백을 받는 안을 다시 본다.

## 남는 한계

- 제공자 쪽 동작은 PoC 전에는 확인하지 못했다. 카카오·네이버 ID 토큰 `sub`와 사용자 정보 API `id`의 관계는 I-T51에서 본다 [확인 필요].
- 로그인 진행 쿠키가 하나라, 탭 두 개에서 동시에 로그인을 시작하면 먼저 시작한 탭의 콜백이 state 불일치로 실패한다. 다시 누르면 된다.
- 파트너 로그인의 사전 요청 하나는 없애지 못한다.
