# BAT-610(LCH-050·LCH-060) heavy gate 보고서

- **무엇**: 파트너 상품·배송·내보내기 화면의 웨이브 끝 비싼 검사 결과다(2026-11-14, R-556).
- **가지**: `wave/lane2-BAT-610`, 출발점 `origin/develop` `ef30bbc6`(R-552). rebase 뒤 R-556 커밋(해시는 amend 때 바뀐다).
- **환경**: Windows, Docker 없음. 파트너 운영 빌드 4201, 가짜 API 4012, Playwright Chromium.
- **브라우저 확인 기록**: `docs/review/browser-check/BAT-610.md`.

## 1. rebase

- `origin/develop` `ef30bbc6`(R-552) 위로 `wave/lane2-BAT-610`(`c2e5ab69`)을 rebase했다.
- 충돌 둘: `docs/00-summary.md`, `docs/review/consistency-review.md`.
- 두 파일 모두 **R-557과 R-556을 함께 남겨** 해결했다. 코드 충돌은 없었다.
- R-556 유지. rebase 뒤 해시는 amend 전 `2666d5ea`였다.

## 2. 브라우저 확인

운영 빌드에서 16단계를 눌렀다. 자세한 표는 `docs/review/browser-check/BAT-610.md`.

- 상품 만들기→목록, 초안 상품 고치기(초안 유지).
- 웹훅 등록→비밀 1회→확인→재발급, 웹훅 둘 이상 선택.
- 송장 등록→반품 도착 확인→반품 거절.
- 배송 명단 재인증→403 `reauth-required` 표시→성공 다운로드.
- 예매자 명단 회차 선택→재인증→403 표시→성공 다운로드→다운로드 이력.
- 상품 정산 정상 목록→404 준비 중 상태.

**브라우저 확인이 찾은 결함 2개**:
1. `text/csv` 응답이 문자열이라 `URL.createObjectURL`이 실패해 다운로드가 시작되지 않았다. `asBlob`으로 고쳤다.
2. 웹훅 비밀 1회 표시 화면에서 재발급 버튼이 숨겨져 새로고침 없이는 재발급할 수 없었다. [비밀을 확인했습니다]를 넣어 고쳤다.

## 3. 변이(등급 B) 30개

대상 시험: 파트너 단위 시험 181개(상품·웹훅·배송·정산·명단·API 요청 모양).

| ID | 넣은 결함 | 결과 |
| --- | --- | --- |
| P-01 | 택배 없는 상품 가격에 배송비를 더함 | 잡음 |
| P-02 | 택배+현장 수령 상품의 표시 가격을 총액으로 | 잡음 |
| P-03 | 택배인데 배송비 없음을 허용 | 잡음 |
| P-04 | 택배인데 반품 주소 없음을 허용 | 잡음 |
| P-05 | 티켓 연동인데 연결 회차 없음을 허용 | 잡음 |
| P-06 | 상품명 100자 경계를 101자로 | 잡음 |
| P-07 | 한정 없음 재고를 `0 / 0`으로 | 잡음 |
| P-08 | 표시 가격의 택배 판정을 PICKUP으로 | 잡음 |
| W-01 | 웹훅 http 주소 허용 | 잡음 |
| W-02 | 웹훅 443 아닌 포트 허용 | 잡음 |
| W-03 | 웹훅 주소 사용자 정보 허용 | 잡음 |
| W-04 | 웹훅 IP literal 허용 | 잡음 |
| W-05 | 웹훅 사설·루프백 호스트 허용 | 잡음 |
| W-06 | 구독 이벤트를 끌 수 없게 | 잡음 |
| S-01 | 배송 완료 항목에 송장 등록 허용 | 잡음 |
| S-02 | 부가 상품 반품 도착 확인 허용 | 잡음 |
| S-03 | 송장 번호 1자 허용 | 잡음 |
| S-04 | 반품 거절 근거의 연락처 차단 제거 | 잡음 |
| S-05 | 배송 명단 사유 빈 칸 허용 | 잡음 |
| T-01 | 확정·이의 중 정산서에 이의 제기 허용 | 잡음 |
| T-02 | 정산 404를 준비 중으로 매핑하지 않음 | 잡음 |
| T-03 | 지급 보류 사유를 숨김 | 잡음 |
| T-04 | 정산 금액에서 쉼표 제거 | 잡음 |
| R-01 | 예매자 명단 사유 빈 칸 허용 | 잡음 |
| R-02 | 403 reauth-required를 다른 오류로 | 잡음 |
| R-03 | 410 retention-ended를 다른 오류로 | 잡음 |
| A-01 | 송장 등록 If-Match 제거 | 잡음 |
| A-02 | 반품 도착 확인 멱등 키 제거 | 잡음 |
| A-03 | 예매자 명단 내려받기 X-Reauth-Token 제거 | 잡음 |
| A-04 | BOOKER_EXPORT 재인증 withPasskey 끔 | 잡음 |

**30/30 잡음.** 처음에는 P-01(배송비 null이라 변이가 같은 값), T-01(기본 이의 기한이 이미 지나 상태 변이가 가려짐), A-02(`[\s\S]*`가 뒤의 거절 멱등 키까지 먹음)를 놓쳤다. 시험 값을 배송비 3,000원·미래 기한으로 바꾸고 정규식을 80자 안으로 좁혀 30/30으로 만들었다.

## 4. 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 내용 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 0 | 2 | 재인증 토큰 `factors`에 passkey가 없으면 화면이 거절하게 했다. 남은 낮음: 실무자 역할 가드는 화면 표시일 뿐 서버가 다시 본다. 재인증 비밀번호·TOTP는 오류 뒤에도 입력 칸에 남는다 |
| 정합 | 0 | 0 | 5 | 브라우저 확인·리뷰에서 CSV 문자열 다운로드, 비밀 1회 뒤 재발급 막힘, 웹훅 둘 이상 무시, 초안·숨김 상품 게시, 실무자 송장·반품 제한, 회차 ID 대신 공연 ID 사용, 유형별 attributes 유실, DISPUTED 재이의를 고쳤다. 남은 낮음: 주소 원문 보기, 현장 수령 QR, 송장 CSV 묶음, 목록 페이지 넘김, 상품 판매 기간 입력 |
| 시험 | 0 | 0 | 1 | 변이 30/30, 단위 181, 브라우저 16단계. 낮음: 브라우저 확인 스크립트는 저장소 밖 임시 파일이라 재실행하려면 다시 만들어야 한다 |
| 운영 | 0 | 0 | 2 | 가짜 API는 메모리라 다시 띄우면 초기화된다. 실제 core-svc shop·notify·export와 payment-svc 정산 모듈이 없어 운영 저장·발송·계산은 아직 안 된다 |

- 높음·중간은 0이다. 리뷰에서 찾은 중간은 모두 이번 웨이브에서 고쳤다.
- 낮음은 후속 목록에 남긴다.

## 5. CI 로컬 등가

- `apps/partner` `node --test`: **181개 통과**
- `apps/partner` `tsc --noEmit`: **0**
- 뿌리 lint(`apps/partner`): **0**
- `apps/partner` `next build`: **성공**(운영 기본 출처로 마지막 빌드)
- doc-check: **오류 0, 경고 4**(기존 openapi 3·mermaid 건너뜀 1)
- `ledger --batch BAT-610 --require`: **자동 10, ID만 0, 빈칸 0**
- `trace-check --ids "I-T53,J-T18,J-T26,N-T15"`: **4 ID 통과 / 보고 181개**
- `records --check`: **통과**(기존 중복 번호 경고만)
- `contracts gen:check`: **생성물이 계약과 같다**
- `api-client` test: **113개 통과**

## 6. 남은 문제

- core-svc shop·notify·export 모듈과 payment-svc 정산 모듈·정산서 표·지급대행 어댑터가 없다. 화면은 계약대로 부르지만 운영 저장·발송·계산은 후속이다.
- SCR-027의 회차 정산서·판매 요약·부정 예매 조치 탭은 목업이다. 이번에는 예매자 명단·다운로드 이력만 실제 계약에 이었다.
- 주소 원문 보기(`GET /v1/partner/merch-orders/{orderId}/delivery`), 현장 수령 QR(`merch-pickups`), 송장 CSV 묶음(`merch-shipment-imports`)은 화면에 아직 붙이지 않았다. 계약은 있다.
- 상품 유형별 Zod 스키마가 없어 `attributes`는 화면이 아는 설명·옵션만 고치고 나머지는 보존한다.
- 목록·발송 기록·정산서·명단의 페이지 넘김은 100건까지만 그린다.

## 7. 정리

- 파트너 운영 빌드 4201, 가짜 API 4012, Chromium을 끝냈다.
- Docker 컨테이너는 만들지 않았다.

## 8. 서버 잔여 cheap gate(2026-11-14, R-567)

`origin/develop` `0adc8057`(R-565)에서 `wave/lane2-BAT-610-server` 가지로 core-svc shop·notify를 넣은 뒤의 싼 검사다. Docker·브라우저·변이·4관점 리뷰는 돌리지 않았다.

- `services/core-svc` vitest: **329개 통과**(새 상품·웹훅·마이그레이션 시험 27개 포함).
- `services/core-svc` `tsc --noEmit`: **0**.
- 뿌리 eslint(`services/core-svc`): **0**.
- `contracts gen:check`: **생성물이 계약과 같다**.
- `api-client` test: **113개 통과**.
- doc-check: **오류 0, 경고 4**(기존 openapi 3·mermaid 건너뜀 1).
- `records --check`: **통과**(기존 중복 번호 경고만).
- `ledger --batch BAT-610 --require`: **자동 10, ID만 0, 빈칸 0**.
- `trace-check --ids "I-T53,J-T18,J-T26,N-T15"`: **4 ID 통과 / 파트너 181 + core 329 보고 510개**(N-T15 14).

**heavy gate에서 돌릴 것**:
- Docker test-int: core-svc 0014·0015 마이그레이션 사슬, RLS·core_partner 권한, 상품·웹훅 Drizzle 저장소.
- 상품·웹훅 HTTP를 실제 PostgreSQL·게이트웨이로 확인.
- 웹훅 발송기·재시도·DLQ를 넣은 뒤 SSRF·서명·재시도 시험.
- 파트너 화면 브라우저 확인(서버 경로가 생긴 상품·웹훅).
- 변이·4관점 리뷰.

## 9. 서버 잔여 heavy gate(2026-11-14, R-567)

`wave/lane2-BAT-610-server`(`35434510`, 기준 `origin/develop` `0adc8057`)에서 웨이브 끝 비싼 검사를 돌렸다.

### 9.1 Docker test-int(실제 PostgreSQL 18)

- `services/core-svc` 전체 test-int: **235 통과, 1 건너뜀**(19 파일). 새 `test-int/shop-notify.int.test.ts`는 **10/10 통과**.
- `0014_shop`·`0015_notify`를 적용한 뒤 `migrateCore`를 다시 불러 재적용이 안전한 것을 확인했다.
- `product`·`product_stock`·`webhook_endpoint`·`webhook_delivery`의 RLS 켜짐과 `core_partner` 권한을 실제 `pg_tables`·`information_schema.role_table_grants`로 확인했다. `product_stock`은 한정을 풀 때 행을 지우므로 `DELETE` 권한을 더했다.
- Drizzle 저장소가 트랜잭션마다 `app.tenant_id`를 걸도록 고쳤다. 고치기 전에는 `core_partner` RLS가 모든 행을 0건으로 보아 실제 DB에서 상품·웹훅이 동작하지 않았다. 상품·웹훅 읽기/쓰기, 테넌트 없이 0건, 다른 테넌트 쓰기 42501을 확인했다.
- 상품 만들기·목록·상세·고치기(If-Match/ETag), 재고·한정 수량, 품절·판매 전·판매 끝 상태, 티켓 연동 회차→공연 이름, 판매 기간 저장을 확인했다.
- 웹훅 등록·목록·고치기·비밀 재발급(1분 제한·24시간 옛 비밀)·발송 기록·다시 보내기(DEAD만 202, PENDING 409, 다른 테넌트 404)·주소 검사(https·443·사용자 정보·IP literal·IPv6·10진 IP·사설 호스트)를 확인했다.
- 웹훅 발송기·재시도·DLQ는 구현하지 않았으므로 시험하지 않았다. 발송 기록은 관리 API가 읽는 저장·상태 전이까지만 본다.

### 9.2 변이(등급 A)

18개를 넣어 **18/18 잡았다**.

| 묶음 | 변이 | 결과 |
| --- | --- | --- |
| 상품 상태·재고 | P-01 품절 조건 제거, P-02 재고 0 경계를 `< 0`으로, P-05 생성 때 재고를 null로, P-09 한정 수량 0을 거절 | 4/4 잡음 |
| If-Match·검증 | P-03 메모리 저장소 판 비교 제거, P-04 고치기 검증 제거, P-06 티켓 연동 검사 제거, P-08 판 증가를 +2로 | 4/4 잡음 |
| 테넌트/RLS | P-07 Drizzle `find`의 `tenantId` 제거 | 잡음 |
| 웹훅 비밀 | W-01 1분 재발급 제한 제거, W-02 옛 비밀 24시간을 1시간으로, W-07 저장소 판 비교 제거, W-08 다시 보내기 시도 횟수 증가 제거 | 4/4 잡음 |
| 다시 보내기 조건 | W-03 PENDING 재전송 허용 | 잡음 |
| SSRF | W-04 https 검사 제거, W-05 포트 검사 제거, W-09 443 경계를 8443으로 | 3/3 잡음 |
| 테넌트/RLS | W-06 Drizzle `findEndpoint`의 `tenantId` 제거 | 잡음 |

### 9.3 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 내용 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 2 | 2 | 높음 0. 중간: 웹훅 비밀이 DB text(Secrets Manager/KMS 후속), 발송기·보낼 때 SSRF 검사 부재(발송기와 함께 후속). 낮음: 비밀 응답 `no-store`를 넣었고, 주소 검사는 등록 때만 한다 |
| 정합 | 0 | 1 | 3 | 중간: `product_type` FK·유형별 Zod 검사가 없다. 낮음: 상태 필터를 DB 페이지 뒤에 적용해 빈 페이지가 날 수 있다, 발송 기록 커서 없음, 한정 수량을 바꾸면 재고를 새 값으로 되돌린다(주문 원천이 생기면 다시 설계) |
| 시험 | 0 | 0 | 1 | 변이 18/18, test-int 10/10, 단위 329. 낮음: 브라우저 확인은 가짜 API로 했고 실제 게이트웨이·세션 스택은 세우지 않았다 |
| 운영 | 0 | 0 | 1 | 낮음: 웹훅 발송기·재시도·DLQ·FAILING 자동 전환이 없어 관리 API만 운영할 수 있다 |

- 높음은 0이다. 중간 3은 선행(Secrets Manager/KMS·발송기·product_type 표)이 없어 문서화·후속으로 남겼다. 이번에 고친 것은 RLS 누락, `product_stock` DELETE 권한, 비밀 응답 `no-store`, 판매 기간 입력 계약이다.

### 9.4 브라우저 확인

- 파트너 dev 3001 + `tools/web-checks/partner-api` 가짜 API 4012로 확인했다. **실제 core-svc를 브라우저에 붙이지는 않았다**(게이트웨이·쿠키 세션 스택을 세우지 않음). 실제 서버 경로는 §9.1 test-int가 실제 PostgreSQL과 core-svc HTTP로 본다.
- 관찰한 호출: `GET /v1/partner/products?limit=100` 200, `POST /v1/partner/products` 201, `GET/PATCH /v1/partner/products/{id}` 200, `GET /v1/partner/webhooks?limit=100` 200, `GET /v1/partner/webhooks/{id}/deliveries?limit=50` 200, `POST /v1/partner/webhooks/{id}/secret-rotations` 201, `POST /v1/partner/webhook-deliveries/{id}/redeliveries` 202.
- 화면은 상품 목록·만들기·고치기, 웹훅 목록·발송 기록·비밀 재발급·다시 보내기를 실제 API 계약 모양으로 불렀다.

### 9.5 CI 로컬 등가와 정리

- core-svc 단위 **329**, test-int **235 통과·1 건너뜀**, typecheck **0**, lint **0**.
- doc-check **오류 0·경고 4**, `ledger --batch BAT-610 --require` **자동 10·ID만 0·빈칸 0**, `trace-check` **4 ID / 510 보고**, `records --check` **통과**, `contracts gen:check` **같음**, api-client **113**.
- test-int 컨테이너는 각 시험이 `docker rm -f -v`로 지웠고, 가짜 API·파트너 dev 서버도 확인 뒤 멈춘다.

### 9.6 남은 막힘

- **export**: 명단 원천·`BOOKER_EXPORT` 서버 검증 배선이 없다.
- **payment-svc 정산·지급·KYC**: 정산서 표·주문 항목 원천·지급대행 어댑터가 없다.
- **웹훅 발송기**: 서명·재시도·DLQ·FAILING 자동 전환·Secrets Manager/KMS 저장이 없다.
- **게이트웨이**: 파트너 API 라우팅·세션 스택은 이 가지 밖이다. 브라우저는 가짜 API로 계약 모양만 확인했다.
