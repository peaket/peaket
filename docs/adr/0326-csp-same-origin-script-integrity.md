# ADR-0326: ASVS 3.6.1 같은 출처 스크립트 무결성 — 우리가 싣는 스크립트는 빌드 SRI, Next.js 덩어리는 빌드 SRI 표·바이트 대조(2026-11-20)

- **상태**: 채택(2026-11-20, 추천 적용. 소유자 결정 OPEN[51] (가)를 감독이 좁혀 승인했다: 우리 문서가 직접 싣는 같은 출처 스크립트는 `integrity` 필수, Next.js `/_next/static/` 덩어리는 같은 빌드 SRI 표와 받은 바이트 SHA-256 대조로 본다. 모든 HTML 태그에 브라우저 `integrity`를 강제하는 안은 별도 묶음으로 미룬다. [ADR-0193](0193-cached-screen-csp-response-time-inline-hashes.md) 결정 6(SRI를 켜 둔다)을 보충한다)
- **관련**: [docs/frontend.md](../frontend.md) §5.14.1·§5.14.2·§6.3, [docs/security/asvs/frontend.md](../security/asvs/frontend.md) 3.6.1, [docs/BUILD_ORDER.md](../BUILD_ORDER.md) BAT-172·HOT-391, [docs/review/plans/BAT-172.md](../review/plans/BAT-172.md), [ADR-0065](0065-web-frontend-security-after-asvs-v3.md) 결정 4, [ADR-0193](0193-cached-screen-csp-response-time-inline-hashes.md) 결정 6, [ADR-0283](0283-cut-batch-overhead-keep-high-yield-checks.md)
- **관련 ID**: frontend:v5.0.0-3.6.1, HOT-391, BAT-170·BAT-171·BAT-172, CSP 시험 `[ASVS v5.0.0-3.6.1]`

## 맥락

- ASVS v5.0.0 3.6.1은 "외부에 둔 클라이언트 자산은 정적이고 버전이 붙은 자원을 SRI(하위 자원 무결성, 스크립트 태그에 적은 파일 지문과 받은 파일이 다르면 브라우저가 실행하지 않는 장치)로 검증할 때만 쓰고, 안 되면 자원마다 보안 결정으로 문서에 남긴다"고 요구한다. 외부에 둔 자산(다른 출처·따로 배포하는 자산)이 대상이다.
- 2026-11-04 PoC(HOT-290, ADR-0193)에서 Next.js의 해시 방식(SRI, `experimental.sri`)이 외부 스크립트에는 `integrity`를 달지만 App Router 인라인 스크립트는 덮지 못함을 확인했다. 그 뒤 2026-11-16 BAT-170의 CSP 시험이 같은 출처 `script[src]`에도 `integrity`가 없는 것을 찾았다.
- BAT-171 2차 CI(실행 44361082574)에서 세 화면(공연 상세 24·추가 검증 16·결제 14건)의 같은 출처 스크립트에 `integrity`가 없어 `[ASVS v5.0.0-3.6.1]` 시험이 실패했다. 세 화면 공통 10건은 `/seed-color-mode.js` 1건과 `/_next/static/chunks/*.js` 9건이다. 시험은 까닭 `BAT-172(OPEN[51], HOT-391)`의 건너뛰기로 두었다.
- 원인은 Next.js의 태그를 만드는 자리마다 다르다. 시작 덩어리(`rootMainFiles`)에는 SRI 표(`server/subresource-integrity-manifest.json`)의 `integrity`를 달지만, 클라이언트 참조·화면 데이터가 넣는 `/_next/static/chunks/*.js` 태그에는 달지 않는다. 실행 중 `import()`가 넣는 덩어리도 같다. 그 덩어리들은 같은 빌드가 만든 내용 주소(파일 이름에 해시가 든 주소)이고 SRI 표에는 그 해시가 있다.
- 우리가 직접 싣는 `/seed-color-mode.js`(`apps/web/public/seed-color-mode.js`)는 주소가 고정이고 빌드 전에 글이 정해진다. 그래서 브라우저 `integrity`를 달 수 있다.

## 결정

1. **ASVS 3.6.1의 대상은 외부에 둔 자산으로 읽는다.** 같은 빌드가 만들고 같은 빌드 산출물로 함께 배포하는 `/_next/static/` 덩어리 전체에 브라우저 `integrity`를 강제하지 않는다. 대신 3의 방법으로 변조를 잡는다. 외부 스크립트(Cloudflare Turnstile·토스페이먼츠·포트원)는 버전 없는 주소라 SRI를 걸 수 없다는 결정을 `docs/frontend.md` §5.14.2 표에 그대로 둔다.
2. **우리 문서가 직접 싣는 같은 출처 스크립트에는 빌드 SRI를 단다.**
   - 지금은 `/seed-color-mode.js` 하나다. `apps/web/scripts/build-color-mode.mjs`가 `public/seed-color-mode.js`를 만든 뒤 같은 UTF-8 바이트의 SHA-256을 `sha256-<base64>` 꼴로 계산해 생성 파일 `apps/web/src/_app/theme/seed-color-mode-sri.ts`의 `SEED_COLOR_MODE_SRI`에 쓴다.
   - 루트 문서(`apps/web/src/_app/layouts/RootDocument.tsx`)는 그 상수를 가져와 `<script src="/seed-color-mode.js" integrity={SEED_COLOR_MODE_SRI} nonce={nonce}>`로 싣는다. 실행할 때 파일을 읽지 않는다(standalone 산출물에 `public/`이 없을 수 있다).
   - `build-color-mode.mjs --check`는 public 파일이 지금 SEED 판과 같은지, 생성 상수가 public 파일 해시와 같은지 본다. 다르거나 생성 상수가 비었으면 종료 코드 1이다. 생성 상수가 비었거나 꼴이 틀리면 그 모듈을 가져오는 루트 문서가 빌드 때 멈춘다.
3. **`/_next/static/` 덩어리는 같은 빌드 SRI 표와 받은 바이트로 확인한다.**
   - CSP 시험 `tools/web-checks/csp/web.spec.mjs`의 `[ASVS v5.0.0-3.6.1]`이 세 화면을 세 엔진에서 연다. 응답 HTML과 `networkidle` 뒤 DOM의 같은 출처 `script[src]`를 나눠, `/_next/` 밖 태그는 `integrity` 값 형식과 받은 바이트 SHA-256을 맞춘다.
   - `/_next/` 태그는 `integrity`가 있으면 값이 SRI 표·바이트와 같아야 하고, 없어도 경로가 `/_next/static/…js`이며 SRI 표 키가 있고 받은 바이트 SHA-256이 표와 같아야 한다. 실행 중 `import()`·화면 데이터가 넣은 태그도 같은 규칙이다.
   - 같은 출처 태그가 0개이거나 본 `/_next/` 표 키가 0개이면 '검사할 것이 없다'가 아니라 실패다.
   - 바이트 대조는 `/_next/` 고유 URL마다 한 번 한다(2026-11-20 실측: 공연 상세 30·추가 검증 20·결제 18, 엔진에 따라 15~30개). 60초를 넘으면 SRI 표 키 대조만 남기고 그 한계를 기록한다. 그때는 바이트 변조(계획 V172-06)가 잡히지 않는다.
4. **CSP 정책·nonce·응답 때 인라인 해시는 바꾸지 않는다.** 외부 스크립트 SRI는 CSP의 허용 근거(nonce·응답 때 해시·`'self'`)와 별개다. `packages/config/headers/security-headers.mjs`·`apps/web/proxy.ts`·`apps/web/server/csp-hash-server.mjs`·`next.config.ts`의 `experimental.sri`를 그대로 둔다.
5. **모든 HTML 태그의 브라우저 SRI는 별도 묶음이다.** 요청 화면의 HTML을 앞 서버가 모아 `integrity`를 채우는 일은 스트리밍·TTFB·2MiB 상한·HTML 파싱 위험이 있어 성능 측정을 먼저 한다. Next.js 실행 코드를 고쳐 클라이언트 참조·실행 중 덩어리에 `integrity`를 다는 일도 Next.js 판 올림마다 깨질 수 있어 이 묶음에서 하지 않는다.
6. **브라우저 `integrity`를 붙일 수 있는 새 같은 출처 스크립트가 생기면 같은 방법을 쓴다.** 빌드 보조 스크립트가 해시를 만들고, 생성 상수를 문서가 가져오며, `--check`와 시험이 public 파일 해시와 맞춘다.

## 결과

- `[ASVS v5.0.0-3.6.1]` 시험의 건너뛰기를 지우고 세 화면 × 세 엔진에서 되살릴 수 있다. `/seed-color-mode.js`는 브라우저가 지문을 강제하고, `/_next/static/` 덩어리는 같은 빌드 SRI 표와 바이트 대조로 변조를 잡는다.
- 제품 변경은 작다: 빌드 보조 스크립트, 생성 상수 파일 하나, 루트 문서의 속성 하나. CSP 정책·nonce·응답 때 해시·첫 JS 예산은 바뀌지 않는다.
- 남는 한계: `/_next/static/` 덩어리는 브라우저가 `integrity`를 강제하지 않는다. 변조는 시험(빌드·배포 뒤 대조)이 잡고, 이미 받은 파일을 실행하는 순간을 막는 장치는 아니다. 외부 스크립트는 버전 없는 주소라 SRI를 걸 수 없다. 바이트 대조를 60초 안에 못 끝내 표 키 대조만 남기면 바이트 변조는 잡지 못한다.
- 되돌릴 조건:
  - 외부 감사나 소유자가 모든 HTML 태그의 브라우저 SRI를 요구하면, 앞 서버 HTML 재작성 묶음을 성능 측정과 함께 계획한다.
  - Next.js가 클라이언트 참조·실행 중 덩어리 태그에도 `integrity`를 달면, 표·바이트 대조 예외를 없애고 시험을 브라우저 `integrity` 단언으로 좁힌다.
  - `/seed-color-mode.js`를 인라인으로 바꾸거나 다른 출처로 옮기면 이 방법을 다시 정한다(인라인은 CSP 해시가, 다른 출처는 그 출처의 SRI 가능성이 맡는다).

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| (나) 모든 같은 출처 태그에 브라우저 `integrity`를 단다 | Next.js가 클라이언트 참조·화면 데이터 덩어리를 `integrity` 없이 `<script src async>`로 넣고, 실행 중 `import()`도 브라우저가 태그를 만든다. 요청 화면은 앞 서버가 HTML을 모아 다시 써야 해 0.25일이 아니라 0.5~1일+ 성능 측정이 든다 |
| (다) 건너뛰기를 그대로 둔다 | HOT-391을 체크할 수 없고 장부가 '다른 단계'로 남는다. ASVS 3.6.1의 판정 근거도 없다 |
| (라) 앞 서버가 모든 HTML을 모아 `integrity`를 채운다 | 요청 화면의 스트리밍·TTFB가 바뀌고 2MiB 상한·HTML 파싱 위험이 는다. 화면 데이터가 만든 태그는 여전히 못 채운다 |
| (마) `/seed-color-mode.js`를 인라인으로 바꾸고 CSP 해시로 막는다 | 모든 HTML에 3.2KB가 붙고 캐시 화면 CSP 틀에 해시를 더해야 한다. 지금 설계(같은 출처 파일)를 바꾸는 결정이다 |
| `experimental.sri`를 끈다 | 시작 덩어리의 브라우저 `integrity`까지 잃는다. ADR-0193 결정 6과 어긋난다 |
