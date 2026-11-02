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

## 소셜 로그인을 로컬에서 돌려 보기(BUILD_ORDER PRF-020)

실제 제공자 앱 등록 없이 모의 OIDC 제공자로 한다(docs/features/identity.md §2 '웹 앱 서버 경로', §12.1 '대역').

1. identity DB(PostgreSQL 18)를 띄우고 `PEAKET_DATABASE_URL=… pnpm --filter @peaket/identity-svc migrate`.
2. 팬 토큰 키(ES256 JWK, `kid` 포함)를 하나 만들어 identity-svc에는 개인 JWK를 `PEAKET_FAN_TOKEN_KEY`로, 웹에는 공개 JWKS를 `PEAKET_FAN_TOKEN_JWKS`로 준다. 두 쪽의 `PEAKET_TOKEN_ISSUER`는 같은 값이다.
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
| `PEAKET_FAN_TOKEN_JWKS`·`PEAKET_TOKEN_ISSUER` | 2번의 공개 JWKS와 발급자 |
| `PEAKET_COOKIE_DOMAIN` | 비운다(운영은 `peaket.example`) |

로그인 화면은 `/login`(SCR-004)이다. 기본 상태(`?state=` 없음)에서 버튼이 로그인 시작 폼이다.
