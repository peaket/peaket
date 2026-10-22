# ADR-0079: 프론트엔드를 RADIO 틀로 상세 설계한다 — 대기실 경량 페이지, 브라우저 저장소 규칙, 구매 세션 키 보관, 결제창 이동 통일, 실시간 채널 계약, 관제 원격 위젯 계약, 화면 묶음별 보안 헤더, 브라우저 지표 경로(2026-10-21)

- **상태**: 채택 (2026-10-21. 소유자의 요청을 받은 세션이 맡긴 작업 "PEAKET 프론트엔드를 RADIO 프레임워크 기반으로 최고 수준으로 상세 설계해 주세요"를 했다. GreatFrontEnd의 RADIO 원문을 먼저 읽고, 정본(planning·design·docs/api·docs/features·docs/security·observability·devops·infra·prototype)을 모두 대조한 뒤 [docs/frontend.md](../frontend.md)를 R·A·D·I·O 순서로 썼다. 정본에 없던 프론트엔드 세부를 아래처럼 정했고 모두 추천 적용이다. 결정 하나하나가 소유자 검토 대상이다. 외부 사실은 2026-10-21에 원문으로 확인했다.) 2026-10-21(같은 날): 결과의 '디자인 캔버스는 고치지 않았다'는 캔버스 v56 반영으로 바뀌었다(SCR-011 결제창 복귀 두 상태와 포트원 칸 문구, SCR-012 '확인이 길어짐', SCR-013 모바일 '저장소 유실 · 입장 시작 전', SCR-017 '로그아웃 확인', SCR-029 메모. 원격 위젯 적재 실패는 기존 '위젯 오류' 카드를 쓴다. 렌더 확인은 하지 않음). design/d5 §3.1·§5.11·§5.12·§7.2에 같은 상태를 적었다. 2026-10-21(ADR-0080): 결정 21의 공용 패키지에 `packages/seatmap`(좌석맵 열 배열·격자 색인·그리기 Worker)을 더해 포렌식 리플레이 데모(`apps/forensics`)와 같이 쓴다. 헤더 묶음에 G(포렌식 데모)를 더했다(docs/frontend.md §2.2·§5.14.1·§5.19).
- **관련**: ADR-0003(적응형 폴링), ADR-0005(첫 예매 요청으로 입장 확정), ADR-0008(클라이언트별 게이트웨이), ADR-0011(토큰 수명주기), ADR-0020(RHF + Zod), ADR-0024(상태 소유권), ADR-0025(회전 QR 기기 키), ADR-0027(클라이언트별 실시간 전송), ADR-0040(SEED Design), ADR-0043(자동 배정), ADR-0044(결제사 선택·전환), ADR-0050(암호 정정, 구매 세션 소지 증명), ADR-0051(현장 입장), ADR-0054(변경 동결), ADR-0058(CDN 배포 셋), ADR-0059~0061(화면 청사진·셸·기기 범위), ADR-0063(화면 개편), ADR-0065(웹 프런트엔드 보안), ADR-0067(관제 콘솔과 관측 도구), ADR-0070(프로브 규칙), ADR-0076(브라우저 지표 경로), ADR-0078(SCR-048 수요 예측), NFR-002·004·006·007·012·019·020·024·025, docs/security/asvs/frontend.md

## 맥락

- **RADIO 원문이 요구하는 것**(GreatFrontEnd 'Front End System Design Playbook'의 The RADIO Framework, 2026-10-21 열람)
  - R 요구사항(약 10%): 주요 사용 사례, 기능·비기능, 핵심과 있으면 좋은 것, 기기·플랫폼, 주 사용자, 오프라인, 성능.
  - A 아키텍처(약 20%): 구성 요소와 관계, 서버는 검은 상자, 뷰·저장소·데이터 접근 층, 관심사 분리, 계산을 어디서 할지.
  - D 데이터 모델(약 10%): 서버 출처와 클라이언트 출처(보존할 것·잃어도 되는 것), 필드와 소유 구성 요소.
  - I 인터페이스(약 20%): 서버-클라이언트 통신의 이름·매개변수·반환값, 클라이언트 안 통신, 컴포넌트 API.
  - O 최적화와 깊이 파기(약 40%): 성능·네트워크·UX·접근성·SEO·다국어·다기기·보안 가운데 제품에 고유한 곳. 렌더링 전략과 엣지 캐시처럼 아키텍처를 바꾸는 주제는 다룬다.
  - 이 저장소는 면접 시간 비중을 문서 분량 비중으로 옮겼다. 순서는 고정이 아니라 빠뜨리지 않기 위한 목록이다.
- **정본에 흩어져 있던 것과 비어 있던 것**(대조 결과, 자세한 목록은 docs/frontend.md §6.2)
  - 프론트엔드 정본은 architecture §6(요약 표)뿐이고, 화면은 design/d5, 계약은 docs/api, 동작은 기능 설계서에 흩어져 있었다.
  - 대기실 번들 예산(JS 50KB gzip, NFR-012)과 'SWR(대기실 전용)'이 함께 적혀 있었으나, 아래 실측처럼 React 런타임만으로 예산을 넘는다.
  - 구매 세션 요청 인증 키를 '페이지 메모리'에 둔다고 적었으나(secrets-and-keys), 결제창에서 돌아오면 페이지가 새로 열려 키를 잃는다.
  - 로비·진입·입장 확정의 303은 브라우저 스크립트가 응답을 읽을 수 없다(아래 확인한 사실).
  - 좌석 델타 WebSocket은 입장 토큰을 싣는 방법, 바이트 형식, 하트비트, 닫힘 코드, 재연결이 비어 있었다. 파트너 SSE와 관제 Socket.IO도 이벤트 형식이 없었다.
  - 브라우저 저장소에 무엇을 얼마나 두는지(기기 식별값, 대기표, 입장 토큰, 희망 조건) 정한 표가 없었다.
  - 스캐너의 `/_t/*`가 CloudFront를 거쳐 gw-scanner로 간다고 적었으나 gw-scanner는 CloudFront를 거치지 않는 mTLS 게이트웨이다. 관제·스캐너 CSP의 `connect-src`에는 같은 출처 `/_t/*`가 빠져 있었다.
  - 관제 원격 위젯을 어느 저장소가 빌드하고 호스트가 어떻게 무결성을 확인하는지, 공유 의존성과 대체 동작이 없었다.
  - 로그아웃 때 `Clear-Site-Data`에 `"storage"`를 넣는다는 판정(asvs/auth)과 월렛 입장 키를 기본 유지한다는 결정(ADR-0051 결정 10)이 부딪쳤다.
- **로컬 실측(PC, 2026-10-21)**
  - rolldown 1.2.13(최소화) + React 19.3, `createRoot`와 `useState` 버튼 하나: gzip 66.0 KiB, brotli 56.8 KiB.
  - 같은 방식의 프레임워크 없는 대기실 모형(상태표·폴링·지터·`Retry-After`·실패 대기·시계 차·`text/plain` 진입·텔레메트리·인앱 감지, 145줄): gzip 2.73 KiB.
  - `@seed-design/css` 3.0.2 `all.min.css`: gzip 42.2 KiB, `base.min.css` 7.8 KiB.
- **확인한 사실**(2026-10-21 원문)
  - **Fetch**: `redirect: 'manual'`은 가린 응답을 돌려주고 기본 `follow`는 따라가므로, 스크립트가 303의 본문과 `Location`을 읽을 수 없다(MDN RequestInit). 교차 출처에서 스크립트가 읽는 응답 헤더는 `Cache-Control`·`Content-Language`·`Content-Length`·`Content-Type`·`Expires`·`Last-Modified`·`Pragma`와 노출 목록뿐이라 `Date`는 노출해야 읽힌다(Fetch 표준).
  - **WebSocket**: 브라우저 생성자는 주소와 하위 프로토콜 목록만 받는다(MDN). 하위 프로토콜 값은 U+0021~U+007E의 토큰 문자열이다(RFC 6455).
  - **CSP**: `connect-src`는 `fetch`·`sendBeacon`·WebSocket·EventSource를 막는다(MDN). nonce는 동적 렌더링이 필요해 ISR·CDN 캐시와 맞지 않고, 해시 방식(SRI)은 실험 기능이며 Turbopack도 16.2부터 지원한다(Next.js 문서·블로그).
  - **CloudFront 원본 사용자 지정 헤더**: 시청자 요청에 같은 이름 헤더가 있으면 CloudFront가 값을 덮어써 원본에 보낸다(AWS 개발자 안내서).
  - **브라우저 지원**(web-features 3.43.0, @mdn/browser-compat-data 8.1.6): OffscreenCanvas 2D·Worker 안 `requestAnimationFrame` Safari 16.4, Web Locks·BroadcastChannel Safari 15.4, `StorageManager.persist()` Safari 15.2, Screen Wake Lock iOS 18.4, Trusted Types Baseline 2026-02(Safari 26·Firefox 148), CLS(LayoutShift)는 Chromium만, INP Safari 26.2, `scheduler.yield()`는 Safari 없음, BarcodeDetector는 Android Chrome만, Battery Status API는 Chromium만(Safari 없음, Firefox 52에서 제거), WebCrypto Ed25519·X25519는 Safari 17부터라 iOS 16.4를 지원하려면 P-256.
  - **WebKit**: 스크립트로 쓴 저장소(IndexedDB·localStorage·서비스 워커)는 Safari 사용일 7일 동안 그 사이트와 상호작용이 없으면 지운다. 홈 화면 웹 앱은 자기 사용일을 센다. `persist()`는 홈 화면 앱 여부 같은 휴리스틱으로 승인한다(WebKit 블로그).
  - **결제사 SDK**: 토스페이먼츠 SDK v2(`js.tosspayments.com/v2/standard`, npm `@tosspayments/tosspayments-sdk` 2.10.0), 포트원 V2 브라우저 SDK(`@portone/browser-sdk` 0.1.13, `requestPayment`의 `redirectUrl`·`forceRedirect: true`면 결과를 늘 리디렉션으로 받음).
  - **라이브러리**: Next.js 16.4.2, React 19.3.1, Jotai 3.0.1(`atomFamily`는 `jotai-family`로 옮김), redux-observable은 3.0.0-rc.3만 있고 안정판 3.0이 없음, `@lhci/cli` 0.15.1(2025-06 뒤 게시 없음), next-auth는 v5가 베타(5.0.0-beta.32)이고 authjs.dev는 Better Auth로 합쳐졌다고 알림, Module Federation 런타임 훅(`createScript` 기본 시간 초과 20,000ms, `errorLoadRemote`, `loadEntryError`).
  - **pnpm 설정**: `minimumReleaseAge`, `trustPolicy: no-downgrade`, `blockExoticSubdeps`(기본 true), `strictDepBuilds`(기본 true), `allowBuilds`.
  - 나머지 출처와 판 번호는 docs/frontend.md §6.4에 모았다.

## 결정

1. **프론트엔드 정본을 둘로 둔다(추천 적용)**
   - docs/frontend.md가 프론트엔드 구조, 경로별 렌더링·캐시·헤더 표, 클라이언트 상태 모델, 브라우저 저장소 규칙, 클라이언트 인터페이스, 성능 예산, 프론트엔드 시험·빌드·배포의 정본이다. architecture §6은 요약으로 두고 이 문서를 가리킨다.
   - 웹 클라이언트 공통 보안 판정은 docs/security/asvs/frontend.md다(architecture §8.2대로 먼저 썼다). 기능별 판정은 기능 표가 맡는다.
   - 기능 동작은 기능 설계서가 정본이다. docs/frontend.md는 브라우저가 맡는 몫만 적고, 빈칸을 메운 곳은 그렇다고 적는다.
2. **대기실은 프레임워크 없는 경량 페이지로 낸다(추천 적용)**
   - 대상: `/queue/[eventId]`와 로케일 접두 경로(SCR-007 로비·SCR-008 대기열·SCR-018 매진), 같은 상태 기계를 쓰는 굿즈 인기 MD 대기열 `/shop/[productId]/queue`. 추가 검증 SCR-009(`/queue/[eventId]/verify`)는 사람 확인 심층 챌린지와 본인확인을 써서 Next.js에 남긴다.
   - 구성: TypeScript, 손으로 쓴 상태표, DOM 직접 갱신(`textContent`만), 디자인 토큰 부분집합 CSS. React·Next.js 런타임·SWR·TanStack Query·오류 도구 SDK를 싣지 않는다.
   - 예산: 직접 만든 JS gzip 50KB 이하(NFR-012)를 지키고 내부 목표는 15KB [가정], CSS gzip 10KB 미만. 사람 확인(Turnstile)은 제3자라 예산 밖이고 로비에서 사람 확인이 필요할 때만 늦게 싣는다.
   - 빌드: `apps/web/queue-room/` 별도 진입점, Vite(rolldown) 빌드, 로케일마다 문구를 넣은 셸 넷. www 배포의 S3 원본 `/_q/`에 올리고 CloudFront Function이 대상 경로를 `/_q/shell.{locale}.html`로 바꿔 읽는다 [가정, PoC wbs 2.10.6].
   - 입장 확정이 `ADMITTED`면 입장 토큰을 탭 세션 저장소에 두고 좌석 화면으로 전체 이동한다. 오류는 최소 사건만 `/_t/rum`으로 보낸다.
   - architecture §6.2·§6.4의 'SWR(대기실 전용)'을 고친다(결정 31).
3. **대기실 폴링·재시도·시계 세부를 정한다(추천 적용)**
   - 정본 주기(1·5·20초, ±20% 지터, `Retry-After` 하한, Degraded 2배)는 그대로다.
   - 실패: 네트워크 오류·5xx·형식 오류면 다음 주기를 2배씩 늘린다(상한 60초 [가정]). 연속 3회 [가정] 실패하거나 마지막 성공 뒤 30초 [가정]가 지나면 마지막 값을 둔 채 '연결 확인 중'을 보인다.
   - 숨긴 탭은 같은 주기를 쓰되 최소 5초 [가정]로 둔다. 다시 보이거나 `online`이 되면 즉시 한 번 묻는다. 화면 꺼짐 방지(Wake Lock)는 쓰지 않는다(배터리, iOS 18.4부터).
   - 시계: 응답 `Date` 헤더와 왕복 시간으로 서버 시각 차를 잰다. 그래서 `queue`·`queue-files`·`api`·`scanner-api` 응답의 `Access-Control-Expose-Headers`에 `Date`를 더한다.
   - 차례 1분 전 [가정]에 액세스 토큰을 미리 갱신한다. 그래도 401이면 한 번 갱신하고 다시 보내며, 또 401이면 '로그인 만료'로 로그인 뒤 같은 주소로 돌아온다(대기표는 그대로).
   - `SOON`은 본문 `retryAfterSeconds`를 먼저, 없으면 `Retry-After` 헤더, 둘 다 없으면 2초 [가정]. 410은 `application/problem+json`의 `sale-ended`면 판매 종료, 그 밖은 매진(SCR-018)으로 본다.
   - 셔플·묶음 결과 파일을 고르는 규칙(해시 함수·앞자리·키 표기·지연 계산)은 docs/frontend.md §4.2의 초안 [가정]이고 서버와 함께 wbs 0.2.3에서 확정한다.
4. **303 대신 2xx 본문으로 추가 검증을 알린다(계약 변경, 추천 적용)**
   - 로비 입장은 201 참가 토큰에 `verification: "REQUIRED"`, 진입은 201 대기표에 `verification: "REQUIRED"`, 입장 확정은 200 `status: "VERIFYING"`으로 바꾼다. 화면은 SCR-009로 간다.
   - openapi 세 작업, queue-admission.md, asvs/bot-defense.md, design/d5의 303 서술을 고치고, ADR-0062 결정 29는 상태 줄에 적는다.
5. **브라우저 저장소 규칙을 정한다(추천 적용)**
   - docs/frontend.md §3.12 표가 정본이다. 표에 없는 값은 저장하지 않는다.
   - 기기 식별값 `deviceId`는 처음 쓸 때 `crypto.getRandomValues`로 만든 128비트 값(base64url)을 localStorage에 둔다. 기기 지문을 모으지 않는다. 로그아웃에도 지우지 않는다(대기표의 기기 묶음).
   - 참가 토큰·대기표·사전 검증 토큰은 회차별 localStorage(창을 닫아도 이어 감), 처음 앞 인원은 sessionStorage(정본), 입장 토큰과 서버 ECDH 공개키는 sessionStorage(같은 탭 이동과 결제 복귀 유지), 재인증 토큰은 메모리만, 자동 배정 희망 조건은 회차별 localStorage에 둔다.
   - 결제 화면 초안은 개인정보를 뺀 sessionStorage, 최근 검색어는 localStorage, 스태프 초대·승인 조각 값은 sessionStorage다.
   - 개인정보가 드는 행은 docs/security/data-classification.md에 함께 올린다.
6. **구매 세션 키를 추출 불가 키로 IndexedDB에 둔다(추천 적용)**
   - 좌석 화면이 ECDH P-256 임시 키 쌍을 만들고 서버 공개키(JWK `{kty, crv, x, y, kid}`)와 합의한다. 그 비밀로 `HKDF-SHA256(salt = 입장 토큰 jti, info = "PEAKET-purchase-v1")` HMAC-SHA256 키를 `extractable=false`로 만들고 임시 개인키는 버린다.
   - 키와 일련번호는 IndexedDB `peaket-purchase`에 jti별로 둔다. Web Locks `ps:{jti}`를 잡은 채 일련번호를 올리고 요청을 보내 응답을 받을 때까지 놓지 않는다. 그래서 결제창에서 돌아오거나 새로고침해도 이어 쓰고, 복제한 탭이 겹쳐 보내도 번호가 뒤집히지 않는다.
   - MAC 입력은 `메서드 "\n" 경로와 쿼리 "\n" 일련번호(10진수) "\n" base64url(SHA-256(본문))`의 UTF-8 바이트, 결과는 채움 없는 base64url이다. 클라이언트 임시 공개키는 비압축 점 base64url이다. 서버와 wbs 0.2.3·2.10.7에서 맞춘다.
   - 구매 세션이 끝나면(`COMPLETED`·`LEFT`·`IDLE`·`MAX_STAY`, 401), 로그아웃·만료 때 지운다. secrets-and-keys의 '페이지 메모리'와 asvs/queue-admission·payment의 같은 서술을 고친다.
7. **두 결제사의 결제창을 페이지 이동으로 통일한다(추천 적용)**
   - 토스페이먼츠는 SDK v2 주문서형 결제에 서버가 준 성공·실패 URL로, 포트원은 `redirectUrl`과 `forceRedirect: true`로 결과를 받는다. 결제창 창 메시지에 기대지 않는다.
   - 복귀 화면 `/booking/[eventId]/checkout/return` 하나가 두 결제사의 성공·실패를 받는다. 주소의 결제 값은 읽는 즉시 지우고 서명한 결제 접수를 보낸다. 복귀 주소에는 주문 ID를 `order` 쿼리로 싣는다.
   - 결제 화면 CSP는 nonce와 `'strict-dynamic'`, CSP2용으로 두 SDK 호스트를 둔다. 결제창 하위 출처(`frame-src`·`connect-src`·`form-action`)는 스테이징의 보고 모드로 모아 정한다 [가정, wbs 2.10.2]. asvs/payment 3.4.3을 고친다.
8. **결제 결과 확인 규칙을 정한다(추천 적용)**
   - 결제 결과 롱 폴링(최대 30초)이 확정이 아닌 값으로 끝나면 0.5~1.5초 [가정] 뒤 다시 묻는다. 접수부터 120초 [가정](Degraded 확정 p99 60초보다 길게) 안에 확정되지 않으면 '결과 확인 중'과 알림 안내, 주문 내역 링크를 보이고, 화면이 보이는 동안 30초 [가정]마다 10분 [가정]까지 확인한다.
   - 결제 상태 8가지와 화면 대응은 docs/frontend.md §3.6 표다.
9. **좌석맵은 Worker가 상태와 그리기를 맡는다(추천 적용)**
   - Worker: 좌석 상태 `Uint8Array`, 좌석 좌표·구역 범위, 스냅샷·델타 해독, WebSocket, OffscreenCanvas 그리기, 누른 좌석 찾기, 카메라 행렬.
   - 메인 스레드: 입력, 접근성 목록(SeatList), 선택 상태(Zustand), 흐름(XState).
   - 좌석 라우트가 교차 출처 격리면 상태를 SharedArrayBuffer로 함께 읽고, 아니면 바뀐 구역만 메시지로 받는다. OffscreenCanvas가 없으면 같은 그리기 모듈을 메인 스레드에서 돌린다.
   - 버전 갭이면 `GET …/snapshot?section=`(정본에 있음)으로 그 구역만 다시 받는다. 좌석맵 파일과 좌석 화면 묶음은 예상 대기 60초 [가정] 안에서 낮은 우선순위로 미리 받는다. WebGL은 K5 측정이 2D로 부족하다고 보일 때 새 ADR로 정한다.
10. **좌석 델타 WebSocket 계약을 정한다(추천 적용, PoC wbs 2.6.4)**
    - 인증: `new WebSocket(url, ["peaket.seats.v1", "peaket.auth." + 입장 토큰])`. 서버는 `peaket.seats.v1`을 고르고, 게이트웨이가 핸드셰이크에서 토큰 서명·만료와 `Origin`을 확인한다. 이 헤더는 접근 로그에서 가린다. Envoy가 이 값을 읽어 검증하지 못하면 연결 뒤 2초 안 첫 메시지 인증으로 바꾼다.
    - 하트비트 15초 [가정](서버 시각 실음), 35초 [가정] 동안 아무것도 오지 않으면 끊고 다시 연결한다.
    - 닫힘 코드: 1012는 0~5초 무작위 뒤(정본), 4401 토큰 무효·만료는 다시 붙지 않고 구매 세션 끝 처리, 4403은 멈춤, 4429는 10초 이상 기다림, 그 밖은 0.5초에서 10초까지 전체 지터 [가정].
    - 바이트 형식(리틀 엔디언)과 스냅샷 형식은 docs/frontend.md §4.4의 초안 [가정, wbs 2.6.1·2.6.4]이다. asyncapi에 싣는다.
11. **파트너 콘솔의 통신 경계를 정한다(추천 적용)**
    - 브라우저 → 파트너 콘솔 앱 서버(같은 출처)의 tRPC가 gw-partner REST를 부른다. 프로시저는 REST 작업과 1:1인 얇은 껍질이고, 여러 호출을 묶는 화면 조합만 더한다. 업무 규칙은 두지 않는다.
    - SSE·파일 내려받기·이미지와 좌석맵 올리기·토큰 갱신은 브라우저가 `partner-api`로 직접 부른다.
    - SSE 형식: `event: live`, `id: 집계 시각(밀리초)`, `data: LiveSnapshot JSON 한 줄`, `retry: 10000`, 15초 [가정]마다 주석 줄, 메시지마다 전체 상태. 화면은 '마지막 갱신 n초 전'을 보인다.
    - 토큰 갱신은 지난 갱신 뒤 사람 입력이 있을 때만 한다. 폴링·구독은 활동으로 치지 않는다(유휴 1시간을 지키기 위함, 서버 쪽은 wbs 3.5.1).
12. **관제 콘솔의 실시간 계약을 정한다(추천 적용)**
    - Socket.IO: 네임스페이스 `/ops`, 경로 `/socket.io/`, WebSocket 전송만(롱 폴링 끔), 쿠키와 `Origin`으로 인증, JSON. 클라이언트 → 서버 `room:join`·`room:leave`·`presence:hello`, 서버 → 클라이언트 `command:ack`·`alert`·`presence`.
    - GraphQL: HTTP는 영속 쿼리 ID만, 구독은 `wss://ops-api.peaket.example/graphql`의 `graphql-transport-ws`.
    - 명령 생성·승인은 REST이고 Socket.IO는 ack·경보 푸시만 맡는다(architecture §6.2의 '제어 명령 통신: Socket.IO'를 고침). 토큰 갱신은 결정 11과 같다.
13. **브라우저 지표 수집 입구를 하나로 둔다(추천 적용)**
    - 화면 배포 넷 모두 `/_t/*`(POST만)를 gw-fan의 텔레메트리 경로로 보낸다. CloudFront가 원본 확인 헤더와 함께 `X-Peaket-App: web|partner|console|scanner`를 붙이고, 게이트웨이는 원본 확인 헤더가 맞을 때만 이 값을 앱 라벨로 쓴다.
    - 이유: gw-scanner는 CloudFront를 거치지 않는 mTLS 게이트웨이이고 gw-ops는 허용 IP만 받는다. 앱마다 게이트웨이로 보내는 서술(observability §11)을 고치고 ADR-0076 상태 줄에 적는다.
14. **화면 묶음별 보안 헤더 값을 정한다(추천 적용)**
    - 묶음: 캐시 화면(ISR·정적 셸·대기실 경량 페이지·복귀 화면·스태프 화면·월렛 셸), 요청마다 그리는 화면(소비자 웹 동적 화면·파트너 콘솔), 결제 화면, 좌석 화면, 관제 콘솔, 스캐너. 전체 CSP 문자열은 docs/frontend.md §5.14다.
    - 경로 묶음: 굿즈 목록·상세(`/shop`, `/shop/[productId]`)는 ISR(300초)로 캐시 화면 묶음에 넣는다(design/d5의 제안을 채택). 결제 결과 화면과 월렛 셸을 뺀 `/my/*`는 요청마다 그리는 셸이고, 알림·외부 링크로 들어와도 서버가 쿠키로 로그인 여부를 정하지 않는다(ADR-0065 결정 8). 셔플 검증 화면은 정적 셸이다. 공연 이미지 파생본은 www 같은 출처 경로를 기본으로 한다 [가정]. 전체 경로 표는 docs/frontend.md §2.5다.
    - 모든 화면의 `connect-src`에 `'self'`를 넣는다(같은 출처 `/_t/*`).
    - 월렛 `/my/tickets*`는 서비스 워커가 저장한 셸을 다시 쓰므로 캐시 화면 묶음(해시 방식과 `'self'`)으로 옮긴다. 티켓 데이터는 HTML이 아니라 API와 IndexedDB에서 받는다(architecture §6.3의 미정을 닫음).
    - Trusted Types는 보고 모드로 관제 콘솔부터 시작하고 30일 [가정] 위반이 없으면 파트너 콘솔, 소비자 웹 순으로 넓힌다. 강제는 새 결정으로 한다.
    - COEP `require-corp`는 좌석 라우트와 그 Worker 스크립트에만 둔다. Permissions-Policy는 스캐너만 `camera=(self)`이고 나머지 앱은 카메라·마이크·위치를 끈다.
15. **브라우저 지표 묶음 판 2와 오류 수집을 정한다(추천 적용)**
    - asyncapi `RumSample`을 판 2로 넓힌다: 앱, 경로 템플릿, 기기 종류, 탐색 종류, 배포 식별자, 표본 비율, INP·LCP·CLS·FCP·TTFB(지원될 때), 긴 작업 수·합, 오류 수, API 실패 수, 흐름 표시값(대기 반영·좌석 델타 종단·좌석맵 준비·결제 확정·재연결 수·스캔 판정). 사용자 식별값과 전체 주소는 싣지 않는다.
    - 오류 도구 SDK는 대기실 경량 페이지를 뺀 앱에만 싣고 같은 출처 터널 `/_t/err` [가정]로 보낸다. 화면 녹화는 운영에서 쓰지 않는다. 릴리스 이름은 배포 식별자다.
16. **관제 원격 위젯 계약을 정한다(추천 적용)**
    - 계약 패키지 `@peaket/console-contract`(위젯 정보·속성·`ConsoleServices`·권한·계약 판)를 `peaket-frontend`가 낸다.
    - 원격은 소유 서비스 저장소(peaket-queue·peaket-purchase)가 공용 워크플로로 빌드해 관제 콘솔 버킷 `/remotes/<원격>/<SHA>/`에 올린다. 호스트는 GitOps `remotes.json`의 `{name, sha, entry, integrity(sha384), contractMajor}`를 읽는다.
    - 런타임 플러그인의 `createScript`가 `integrity`·`crossorigin`을 붙이고 시간 초과를 5초 [가정]로 줄인다. `loadEntryError`는 한 번 다시 시도하고, `errorLoadRemote`는 그 칸만 대체 카드로 바꾼다. 계약 판이 다르면 싣지 않는다.
    - 공유 싱글턴: react, react-dom, react-redux, @reduxjs/toolkit, rxjs, @peaket/ds, @peaket/telemetry, @peaket/console-contract.
    - 원격은 자기 네트워크 클라이언트나 토큰을 갖지 않고 `ConsoleServices`만 쓴다. 상태는 RTK `combineSlices().inject`로 넣고, 스트림 결합은 `createListenerMiddleware` 위 RxJS 얇은 어댑터로 한다(redux-observable은 안정판이 없어 쓰지 않음).
17. **로그아웃 정리 규칙을 정한다(추천 적용)**
    - 소비자 웹 로그아웃 응답은 `Clear-Site-Data: "cache", "cookies"`다(`"storage"` 없음). 서버 응답을 기다리지 않는 클라이언트 정리 루틴이 결정 5 표의 저장물을 지우고, 다른 탭에는 `BroadcastChannel`로 알린다.
    - 월렛 입장 키와 오프라인 티켓은 기본으로 남긴다(ADR-0051 결정 10). 로그아웃 대화상자에서 '이 기기의 입장 키도 지우기'를 고르면 월렛 DB와 서비스 워커 캐시도 지운다.
    - 파트너·관제 콘솔은 `"cache", "cookies", "storage"`, 스캐너는 업로드 대기를 비운 뒤 세션 토큰만 지운다. asvs/auth 14.3.1을 고친다.
18. **월렛 서비스 워커의 범위와 갱신을 정한다(추천 적용)**
    - 범위는 `/my/tickets/`만이다. 대기실·좌석·결제 화면을 가로채지 않는다.
    - 월렛 셸(HTML·JS·CSS·글꼴)만 미리 저장하고 API 응답은 저장하지 않는다. `no-store` 응답은 어떤 경우에도 넣지 않는다.
    - 새 워커는 QR을 보이는 월렛 화면이 열려 있는 동안 기다리게 한다. 문제가 생기면 스스로 등록을 풀고 캐시를 지우는 킬 스위치 워커를 같은 주소로 낸다.
19. **iOS 7일 삭제에 대비한다(추천 적용)**
    - 정본(홈 화면 추가 권고, 영속 저장소 요청, 전일·당일 동기화 안내)에 더해, 월렛을 열 때마다 `persist()`를 요청하고, 서버가 키를 등록했다고 하는데 이 기기에 키가 없으면 design/d5 §5.13의 '저장소 유실' 상태(입장 시작 전은 다시 받기, 입장 시작 뒤는 부스 재발급)를 보인다.
    - 전일·당일 알림 문구는 '티켓 화면을 한 번 열어 주세요'로 한다. 여는 것이 사용일 계수를 되돌리기 때문이다.
20. **스캐너의 디코딩·저장·화면 유지를 정한다(추천 적용, PoC wbs 5.4.7)**
    - 카메라 프레임을 `createImageBitmap`으로 Worker에 넘기고, Worker에 `BarcodeDetector`가 있으면 쓰고 없으면 zxing-wasm으로 읽는다. WebAssembly 때문에 스캐너 CSP에만 `'wasm-unsafe-eval'`을 둔다.
    - 판정(WebCrypto ECDSA P-256 검증과 로컬 목록 조회)도 같은 Worker가 한다.
    - Dexie DB `peaket-scanner`의 표는 docs/frontend.md §3.8이다. 근무 준비 때 `persist()`와 남은 용량을 확인한다.
    - 화면 꺼짐 방지는 스캔 화면에서 잡고 화면이 다시 보이면 다시 잡는다. 판정 지연·오류는 Dexie에 모았다가 온라인일 때 `/_t/rum`으로 보낸다.
21. **공용 패키지와 api-client 정책을 정한다(추천 적용)**
    - 패키지: `@peaket/api-client`(orval 생성물 + 실행 정책), `@peaket/telemetry`(대기실용 가벼운 판과 전체 판), `@peaket/validation`(Zod 4 + 판매 정책 DSL AST), `@peaket/ds`(토큰 빌드·컴포넌트·대기실용 토큰 부분집합), `@peaket/console-contract`, `@peaket/config`(ESLint·TypeScript·Steiger 설정).
    - 실행 정책: 호출 종류별 시간 초과, 재시도는 읽기와 멱등키가 있는 쓰기만, `Retry-After` ±20% 지터, Problem `type`으로 오류 구분, `traceparent`는 같은 출처 요청에만, T=0 두 호출은 `text/plain`과 사용자 헤더 없음. 숫자는 docs/frontend.md §4.1이다.
22. **공급망과 위험 구성 요소를 정한다(추천 적용)**
    - pnpm에 `trustPolicy: no-downgrade`, `blockExoticSubdeps: true`, `strictDepBuilds: true`와 `allowBuilds`, `trustLockfile: false`를 둔다(`minimumReleaseAge` 3일은 정본).
    - 위험 구성 요소 표(docs/frontend.md §5.14): redux-observable(쓰지 않음), next-auth v5 베타(고정하고 인증 구현 착수 전 Better Auth 이전 PoC), `@lhci/cli`(갱신 없음, 대안 준비), `@hello-pangea/dnd`(갱신 없음, 키보드 대안 필수), comlink(쓰지 않음), QR 생성 라이브러리(wbs 5.1.3에서 고름), `@opentelemetry/sdk-trace-web`(지원 중단 표시, 후속 패키지로).
    - 앱마다 정적 자산 묶음의 SBOM도 만든다(devops §4의 '앱 서버 이미지만' 서술을 고침).
23. **소스 맵은 오류 도구에만 올린다(추천 적용)**
    - 빌드는 숨김 소스 맵을 만들고 배포 식별자를 릴리스로 오류 도구에 올린다. 공개 버킷에는 올리지 않는다.
    - 정적 업로드는 허용 확장자 목록만 올린다(ASVS 13.4.7 채택).
24. **경로별 성능 예산 표를 둔다(추천 적용)**
    - docs/frontend.md §5.8 표의 숫자는 모두 [가정]이고 wbs 7.5.2 측정 캠페인에서 바꾼다. size-limit(PR), Lighthouse CI(PR 차단), Playwright 성능 추적(좌석맵 INP·긴 작업), memlab(좌석맵 힙)으로 지킨다.
25. **프론트엔드 시험 ID를 FE-T로 둔다(추천 적용)**: 목록과 배치는 docs/frontend.md §5.17이다.
26. **배포와 동결을 정한다(추천 적용)**
    - 대기실 경량 셸, 웹 정적 자산 목록, 월렛 서비스 워커, 경로를 바꿔 읽는 엣지 함수는 소형 온세일 동결 묶음에 넣는다(devops §8).
    - 관제 원격 위젯은 규모와 상관없이 온세일 윈도우(T-10분~T+60분) 동안 바꾸지 않는다 [가정].
    - 구매 흐름(대기실 → 좌석 → 결제)은 화면 사이를 전체 이동으로 오가 Next.js 배포 식별자 차이로 새로고침되어도 상태를 잃지 않게 한다.
27. **Next.js 앱 서버의 실행 자리를 정한다(추천 적용)**: 네임스페이스 `web`에 웹(최소 3) [가정]과 파트너(최소 2) [가정] 앱 서버를 둔다. `output: 'standalone'` 이미지, HPA, PDB, ADR-0070 프로브 규칙을 따른다. CloudFront 화면 배포는 정적 파일을 S3에서, 동적 화면을 그 앱 게이트웨이의 앱 서버 경로에서 받는다.
28. **접근성 세부를 정한다(추천 적용)**: 경로가 바뀌면 h1로 초점을 옮기고 알린다. 고정 머리·하단 막대에는 `scroll-padding`을 둔다(2.4.11). 좌석은 고를 수 있는 배율에서 24×24 CSS px 이상이고, 작으면 접근성 목록으로 간다(2.5.8). 끌기는 모두 버튼·숫자 입력 대안이 있다(2.5.7). 로그인은 붙여넣기와 비밀번호 관리자를 허용한다(3.3.8). `ariaNotify`는 쓰지 않는다.
29. **다국어 범위를 정한다(추천 적용)**: 소비자 웹은 4개 언어(정본)다. 파트너·관제·스캐너는 v1에서 한국어만 내되 문구 키 구조는 같게 둔다. 대기실 경량 페이지는 로케일마다 따로 빌드한다. 오류 `type` → 문구 키 표를 docs/frontend.md §5.12에 둔다.
30. **여러 탭을 조정한다(추천 적용)**: 같은 회차 대기실을 여러 탭에서 열면 Web Locks `queue-poll:{eventId}`를 잡은 탭만 폴링하고 `BroadcastChannel`로 나눈다. 로그아웃·세션 만료는 `peaket.session` 채널로 알린다. 재인증 토큰은 탭끼리 나누지 않는다.
31. **상태 관리 표를 고친다(추천 적용)**: 대기실은 라이브러리 없이 손으로 쓴 상태표, 파트너 에디터는 Jotai 3 + `jotai-family`, 관제는 RTK + listener 미들웨어 + RxJS(redux-observable 뺌), 파트너 서버 통신은 tRPC BFF(결정 11). architecture §6.2·§6.4와 ADR-0024 상태 줄에 적는다.
32. **화면이 쓰는 API 계약을 먼저 보강한다(추천 적용, wbs 0.2.3)**: 180개 작업의 `operationId`, 모든 4xx·5xx의 Problem 선언과 `type` 목록, 429·503의 `Retry-After`, `Date` 노출, 결정 4·6·10·11·12의 형식, 화면이 쓰는데 없는 읽기 경로의 초안(공연 상세, 주문 내역, 파트너 공연 목록, 관제 목록 등), 401의 `type` 구분, 대기 상태 파일의 더할 칸(좌석맵 파일 경로, 구매 어려움 판정 재료, 입장 일시정지), 사전 검증 토큰 만료 시각, 입장 토큰 최대 체류 시각, 굿즈 결제 경로를 정한다. 프론트엔드 코드는 계약에서 만들고 경로를 손으로 쓰지 않는다.

## 검토한 대안

| 대안 | 고르지 않은 이유 |
| --- | --- |
| 대기실을 Next.js + SWR 그대로 | React 런타임만으로 gzip 66.0 KiB(실측)라 JS 50KB 예산을 넘는다. 예산을 바꾸면 T=0 100만 명의 첫 화면 비용이 그만큼 커진다. |
| 대기실을 Preact로 | 런타임이 작아 예산 안에 들 수 있으나(크기는 이번에 재지 않음) React 컴포넌트를 그대로 쓰지 못해 결국 두 벌이 되는 것은 같다. 화면 요소가 넷뿐이라 상태표와 DOM 갱신으로 충분하다. |
| 303을 그대로 두고 `redirect: 'manual'` | 스크립트가 받는 것은 가린 응답이라 상태와 `Location`을 읽을 수 없다. |
| 구매 세션 키를 sessionStorage 문자열로 | 키를 추출 가능한 바이트로 두게 되고, 같은 출처 스크립트가 키를 통째로 가져갈 수 있다. IndexedDB는 추출 불가 `CryptoKey`를 그대로 담는다. |
| 결제창을 팝업·창 메시지로 | 결제사마다 기기별 기본값이 다르고 모바일은 결국 이동이다. 이동 하나로 통일하면 복귀 화면 하나만 시험하면 된다. |
| WebSocket 인증을 주소 쿼리로 | 주소에 토큰을 두지 못한다는 규칙(guidelines)과 접근 로그 노출 때문에 쓰지 않는다. |
| WebSocket 인증을 첫 메시지로만 | 인증 전 연결이 자원을 잡고 게이트웨이가 핸드셰이크에서 거르지 못한다. PoC가 실패할 때의 대체로만 둔다. |
| `/_t/*`를 앱마다 그 앱 게이트웨이로 | 스캐너는 CloudFront를 거치지 않는 mTLS라 원본이 없고, 관제 게이트웨이는 허용 IP만 받아 CloudFront 원본 요청을 따로 열어야 한다. |
| 관제 원격 위젯을 호스트 저장소에서 빌드 | 위젯을 아는 서비스 팀이 함께 배포하지 못하고, 서비스 변경과 위젯 변경이 따로 놀게 된다. |
| 로그아웃 때 `"storage"`까지 지우기(소비자 웹) | 월렛 입장 키가 지워져 재발급 한도(티켓당 24시간 1회)에 걸리고 입장 시작 뒤에는 부스로 가야 한다(ADR-0051 결정 10). |

## 결과와 트레이드오프

- **남는 한계**
  - 대기실 경량 페이지는 React 컴포넌트를 쓰지 못해 소비자 웹과 화면 요소를 두 벌 관리한다. 디자인 토큰과 문구 키를 같이 쓰고 시각 회귀 시험으로 맞춘다.
  - 구매 세션 키와 월렛 키는 추출할 수 없어도 같은 출처의 XSS가 서명을 부를 수 있다(ADR-0065 남는 한계와 같음).
  - WebSocket 하위 프로토콜 인증은 게이트웨이가 값을 읽어 검증하는지 PoC 전이다.
  - Trusted Types는 보고 모드로 시작해 강제하기 전까지는 DOM XSS를 막지 않는다. iOS 26 전(16.4~18)은 Trusted Types를 무시한다.
  - CLS는 Chromium에서만, INP는 Safari 26.2부터 잴 수 있어 iOS의 체감 지표가 비어 있다.
  - Battery Status API가 Safari에 없어 '배터리 15% 이하면 효과 끔'은 Android Chrome에서만 동작한다. 다른 브라우저는 움직임 줄이기 설정만 따른다.
  - iOS 7일 삭제는 줄일 뿐 막지 못한다. 키가 사라지면 다시 등록하거나 부스로 간다.
  - 셔플 파일 규칙·바이트 형식·MAC 입력·SSE·Socket.IO 형식은 서버와 맞추기 전의 초안이다(wbs 0.2.3).
  - 이 한계들은 planning/01 §5.2와 guide/17에 적었다.
- **반영 수치(2026-10-21)**
  - ADR 78 → 79, 시험 FE-T1~FE-T24, 용어 2개(대기실 경량 페이지, 원격 위젯 계약), REST 경로·작업 수는 그대로(165·180, 응답 세 곳만 바꿈)
  - WBS 9개 작업 +16.5일(412.5 → 429일): 0.2.3 화면이 쓰는 API 계약 보강 2.5, 0.6.4 프론트엔드 저장소 골격·공용 패키지 3, 2.6.4 좌석 이진 형식·Worker 해독기·연결 상태 기계 1.5, 2.10.6 대기실 경량 페이지 빌드 체계 1.5, 2.10.7 구매 세션 서명기·결제 복귀 통일·결과 확인 상태 기계 1.5, 4.5.5 관제 원격 위젯 계약·무결성·대체·원격 배포 2, 5.1.4 월렛 서비스 워커·로그아웃 정리·iOS 7일 안내 1, 5.4.7 스캐너 저장소·디코더 PoC·화면 유지·텔레메트리 버퍼 1.5, 7.5.2 프론트엔드 성능·접근성 측정 캠페인 2
  - 검토 기록 R-88, 질문 37, 정본과 어긋난 곳 51곳(docs/frontend.md §6.2), 쉬운 설명 guide/17(16 → 17편)
  - 점검 도구 재집계(2026-10-21): 가정 표시 1,490 → 1,654곳, 보완 표시 187 → 188곳, 절 참조 3,362곳, 문서 157개, 오류 0
  - 디자인 캔버스는 고치지 않았다(문서만 바꿈).

## 되돌릴 조건

- wbs 7.5.2 측정에서 대기실 경량 페이지의 화면 두 벌 관리 비용이 크고 Preact나 React 서버 렌더링으로도 예산을 지킨다는 실측이 나오면 결정 2를 다시 본다.
- WebSocket 하위 프로토콜 인증 PoC가 실패하면 결정 10을 첫 메시지 인증으로 바꾸는 새 ADR을 낸다.
- Next.js 해시 방식 CSP PoC(wbs 2.10.1)가 실패하면 결정 14의 캐시 화면 묶음과 월렛을 ADR-0065 되돌릴 조건대로 다시 정한다.
- 결제사가 이동 방식을 막거나 특정 수단에서 창 메시지만 허용하면 결정 7을 그 수단에 한해 다시 본다.
- 원격 위젯 무결성 확인(`createScript` 훅)이 Module Federation 판 변경으로 동작하지 않으면 결정 16을 다시 본다.
