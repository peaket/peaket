# apps/

화면 앱이 들어갈 자리다. 팬 웹(`web`), 파트너 콘솔(`partner`), 현장 스캐너(`scanner`), 관제 콘솔 호스트(`console-host`), 포렌식 리플레이 데모(`forensics`)와 관제 원격 위젯(`widgets/queue`, `widgets/purchase`)을 둔다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 앱 구조: [docs/frontend.md](../docs/frontend.md) §2
- 지금 있는 것(2026-10-31, ADR-0170): 앱 여섯과 위젯 둘의 골격, 디자인 캔버스를 옮긴 69개 화면(목업 데이터). 데이터 연결은 각 화면의 wbs 단계에서 한다.

## 띄워 보기

뿌리에서 `pnpm install` 뒤 앱 하나씩 띄운다. 앱마다 `/preview`에 화면·상태 목록이 있다(개발 서버에서만). 상태는 주소의 `?state=`(디자인 캔버스 보드의 상태 이름), 다크는 `?theme=dark`, 콘솔 역할은 `?role=`로 고른다.

| 앱 | 명령 | 주소 |
| --- | --- | --- |
| 소비자 웹 | `pnpm --filter @peaket/web dev` | http://localhost:3000/preview |
| 파트너 콘솔 | `pnpm --filter @peaket/partner dev` | http://localhost:3001/preview |
| 관제 콘솔 | `pnpm --filter @peaket/console-host dev` | http://localhost:3002/preview |
| 스캐너 | `pnpm --filter @peaket/scanner dev` | http://localhost:3003/preview |
| 대기실 경량 페이지 | `pnpm --filter @peaket/queue-room dev` | http://localhost:3004/preview |
| 포렌식 데모 | `pnpm --filter @peaket/forensics dev` | http://localhost:3005/ |

## 계약 모양 가짜 API로 화면 띄워 보기(ADR-0199, BUILD_ORDER HOT-300)

서버가 아직 없는 화면(홈 등)은 고정 자료를 내는 가짜 API로 띄운다. 운영·CI에서는 쓰지 않는다.

1. 가짜 API: `PEAKET_WEB_ORIGIN=http://localhost:3000 pnpm --filter @peaket/web mock-api`(127.0.0.1:4010).
2. 소비자 웹: `PEAKET_API_ORIGIN=http://127.0.0.1:4010 NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:4010 PEAKET_DEV_STATIC_ORIGIN=http://127.0.0.1:4010 PEAKET_CSP_ORIGINS='{"api":"http://127.0.0.1:4010","img":"http://127.0.0.1:4010"}' pnpm --filter @peaket/web dev`.
3. 화면 상태 바꾸기: `http://127.0.0.1:4010/__mock/state?home=empty|normal&ranking=normal|stale|old|missing&fan=member|unverified|pending|closing|guest&detail=normal|suspended&verify=popup|redirect|down`. `fan`은 팬 계정 요약(`GET /v1/identity/me`, ADR-0202)과 팬 경로를 바꾼다: member 본인확인 완료, unverified 본인확인 전, pending 가입 완료 화면 전, guest 비로그인(401). 셸 머리와 공연 상세 예매 버튼이 이것을 따른다. 홈 피드는 서버 캐시(60초) 뒤에 바뀐다. 공연 상세(`/v1/events/{eventId}`)는 고정 자료 카드의 모든 회차를 답하고, `detail=suspended`면 410 `event-suspended`다(ADR-0200). 찜 목록은 `productionIds`로 고를 수 있고 찜 저장·해제가 띄운 동안 남는다. 후기 요약(`…/review-summary`)도 낸다(HOT-311). 공연 상세 화면은 `http://localhost:3000/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01`처럼 고정 자료의 회차 ID로 연다. 개발 서버는 앞 서버가 없어 404·410 화면도 200으로 나간다(ADR-0201 결정 4).
4. 휴대폰 본인확인 기관 창(SCR-006): 정본의 모의 기관을 `PEAKET_ENV=local PEAKET_TEST_VERIFICATION_RETURN_URL=http://localhost:3000/verify/return node services/identity-svc/scripts/mock-idv.mjs 4020`으로 띄운다. 가짜 API의 본인확인 경로(`/v1/identity/verifications*`)가 그 창 주소(`PEAKET_TEST_VERIFICATION_URL`, 기본 `http://127.0.0.1:4020/verify`)를 주고, 돌아온 결과 값을 identity-svc 시험 어댑터와 같은 규칙(서명·건 ID·10분)으로 읽어 계정 요약을 바꾼다. `verify=popup|redirect`는 기관 창 방식, `down`은 시작부터 기관 장애(503)다. 모의 기관에서 이름표를 `duplicate`로 하면 '다른 계정의 본인'(409)이다(가짜 API만의 흉내). 나머지는 identity-svc와 같다: 생년월일이 만 14세 미만이면 403 `under-14`이고 계정은 정리 중(`fan=closing`, 세션은 살아 있고 다시 시작하면 403)이 된다. `fan=member`의 기록 이름표는 `tester-1`이라 다시 본인확인(REVERIFY)은 그 이름표일 때만 VERIFIED다. 확정한 건은 1일 동안 같은 결과를 준다. 개발 서버 CSP는 보고 모드라 `PEAKET_CSP_ORIGINS`에 `"identity":"http://127.0.0.1:4020"`을 더하면 기관 양식 보고가 쌓이지 않는다.
5. 고정 자료(`apps/web/scripts/mock-api/cards.json`)가 계약 Zod를 지나는지는 `pnpm --filter @peaket/web test`가 본다. 계약을 바꾸면 고정 자료도 고친다.

| 환경값 | 뜻 |
| --- | --- |
| `PEAKET_API_ORIGIN` | 앱 서버가 공개 API(홈 피드 등)를 빌드·ISR 때 부르는 주소. 없으면 부르지 않고 빈 피드로 그린다 |
| `NEXT_PUBLIC_API_ORIGIN` | 브라우저가 개인 값(로그인·본인확인 상태, 찜·알림)을 부르는 팬 API 주소. 개발 서버에서 없으면 비로그인처럼 둔다 |
| `PEAKET_DEV_STATIC_ORIGIN` | 개발 서버에서만: 같은 출처 정적 파일(랭킹 파일)을 넘길 곳 |
| `NEXT_PUBLIC_QUEUE_ORIGIN`·`NEXT_PUBLIC_QUEUE_FILES_ORIGIN` | 브라우저 api-client가 함께 담는 대기열 API·파일 출처(개발 서버에서 없으면 비워 둔다) |
| `PEAKET_CSP_ORIGINS` | CSP 자리 출처 바꾸기(JSON). 이미지 파생본 출처는 `img`(운영 기본 `https://img.peaket.example` [가정]) |

## 소셜 로그인을 로컬에서 돌려 보기(BUILD_ORDER PRF-020)

실제 제공자 앱 등록 없이 모의 OIDC 제공자로 한다(docs/features/identity.md §2 '웹 앱 서버 경로', §12.1 '대역').

1. identity DB(PostgreSQL 18)를 띄우고 `PEAKET_DATABASE_URL=… pnpm --filter @peaket/identity-svc migrate`.
2. 팬 토큰 키(ES256 JWK, `kid` 포함)를 하나 만들어 identity-svc에 개인 JWK를 `PEAKET_FAN_TOKEN_KEY`로 준다. 웹은 identity-svc의 공개키 묶음 주소를 읽는다(아래 표). 두 쪽의 `PEAKET_TOKEN_ISSUER`는 같은 값이다.
3. identity-svc: `PEAKET_ENV=local PEAKET_DATABASE_URL=… PEAKET_FAN_TOKEN_KEY=… PEAKET_TOKEN_ISSUER=… pnpm --filter @peaket/identity-svc start`(업무 gRPC 포트 `PEAKET_GRPC_PORT`, 기본 50051).
4. 모의 제공자: `node apps/web/scripts/mock-oidc.mjs 18900` → 제공자마다 발급자 주소와 시험 클라이언트 ID·시크릿을 출력한다.
5. 소비자 웹(`next build` 뒤 `next start`, 또는 `dev`)에 넣는 값:

| 환경 변수 | 값 |
| --- | --- |
| `PEAKET_ENV` | `local`(모의 제공자 주소와 http를 이때만 받는다) |
| `PEAKET_WEB_ORIGIN` | 브라우저가 여는 출처(예: `http://localhost:3000`) |
| `PEAKET_WEB_AUTH_SECRET` | 32바이트 난수 base64(진행 쿠키·멱등 키·재인증 결과 쿠키 키를 여기서 나눈다) |
| `PEAKET_WEB_AUTH_SECRET_PREVIOUS` | 비밀을 바꾼 직후에만: 옛 비밀(쿠키 수명 10분 동안 옛 쿠키를 여는 데만 쓴다) |
| `PEAKET_OIDC_KAKAO_CLIENT_ID`·`_CLIENT_SECRET`·`_ISSUER` | 모의 제공자가 출력한 값. 네이버·구글은 `NAVER`·`GOOGLE`. 설정한 제공자만 로그인할 수 있다 |
| `PEAKET_IDENTITY_GRPC` | identity-svc 업무 gRPC 주소(예: `127.0.0.1:50051`) |
| `PEAKET_FAN_TOKEN_JWKS_URL`·`PEAKET_TOKEN_ISSUER` | identity-svc 공개키 묶음 주소(`http://<identity 앱 포트>/internal/jwks/fan.json`)와 발급자. 주소 대신 2번의 공개 JWKS를 `PEAKET_FAN_TOKEN_JWKS`로 줄 수도 있다 |
| `PEAKET_COOKIE_DOMAIN` | 비운다(운영은 `peaket.example`) |

로그인 화면은 `/login`(SCR-004)이다. 기본 상태(`?state=` 없음)에서 버튼이 로그인 시작 폼이다.

## 휴대폰 본인확인을 로컬에서 돌려 보기(BUILD_ORDER BOT-010)

실제 본인확인기관 없이 모의 기관으로 기관 창 흐름 전체(팝업·페이지 이동·POST 본문 복귀·쿼리 복귀)를 돌린다(docs/features/identity.md §5 '모의 기관과 기관 창 흐름', I-T45). 위 '소셜 로그인을 로컬에서 돌려 보기'의 스택에 셋을 더한다.

1. 모의 기관: `PEAKET_ENV=local PEAKET_TEST_VERIFICATION_RETURN_URL=<웹 출처>/verify/return node services/identity-svc/scripts/mock-idv.mjs 18920`. 비밀은 identity-svc와 같은 `PEAKET_TEST_VERIFICATION_SECRET`(base64)이고, 없으면 둘 다 개발용 값을 쓴다. demo(로컬 kind 데모 오버레이)도 같은 모의 기관을 `PEAKET_ENV=demo`로 띄운다. demo는 비밀이 없으면 둘 다 시작하지 않는다(2026-11-05, BOT-010이 넘긴 것).
2. identity-svc에 더하는 값: `PEAKET_VERIFICATION_PROVIDER=test`, `PEAKET_TEST_VERIFICATION_URL=http://127.0.0.1:18920/verify`, `PEAKET_CI_HMAC_KEY`(판 1, 판이 여럿이면 `PEAKET_CI_HMAC_KEYS`에 JSON `{"판": base64}`)·`PEAKET_PID_HMAC_KEY`(base64 32바이트. KMS로 하려면 `PEAKET_CI_HMAC_KMS_KEYS`·`PEAKET_PID_HMAC_KMS_KEY`와 moto 주소 `PEAKET_KMS_ENDPOINT`), 페이지 이동 방식 기관을 흉내 내려면 `PEAKET_TEST_VERIFICATION_MODE=REDIRECT`.
3. 게이트웨이 대역(로컬에는 gw-fan이 없다): `PEAKET_ENV=local PEAKET_IDENTITY_HTTP=http://127.0.0.1:<identity 앱 포트> PEAKET_WEB_ORIGIN=<웹 출처> PEAKET_FAN_TOKEN_JWKS_URL=http://127.0.0.1:<identity 앱 포트>/internal/jwks/fan.json PEAKET_TOKEN_ISSUER=<발급자> node apps/web/scripts/local-fan-gateway.mjs 18930`.
4. 소비자 웹은 빌드할 때 `NEXT_PUBLIC_API_ORIGIN=http://localhost:18930`을 준다. 쿠키가 `localhost` 이름에 붙으므로 `127.0.0.1`이 아니라 `localhost`로 적는다. 이 값이 없으면 개발 서버의 본인확인 버튼은 퍼블리싱용 시험 창을 연다.

로그인한 뒤 공연 상세(`/events/evt-lumen-1025`)에서 [휴대폰 본인확인]을 누르면 모의 기관 창이 열린다. 이름표가 같으면 같은 사람이라, 다른 계정에서 같은 이름표로 하면 '다른 계정의 본인'이 나온다.
