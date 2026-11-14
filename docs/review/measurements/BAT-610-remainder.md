# BAT-610 잔여 측정·게이트 기록

- 가지: `wave/lane3-BAT-610-remainder`(기준 `origin/develop` `7a076b5c`, R-586·R-587 merge 뒤 rebase)
- 커밋: R-588
- 범위: core-svc export(BOOKER_EXPORT·명단·다운로드 이력), notify 발송기·DLQ, payment-svc 상품 정산·미수금 상계, ops-svc 2인 지급 승인, 토스/포트원 지급대행 어댑터 경계

## 1. cheap gate (2026-11-15, rebase 뒤)

| 검사 | 결과 |
| --- | --- |
| core-svc 단위 | 346 통과(43 파일) |
| payment-svc 단위 | 2936 통과(39 파일) |
| ops-svc 단위 | 91 통과(21 파일) |
| partner 단위 | 181 통과 |
| purchase-svc 단위 | 3856 통과(110 파일) |
| platform 단위 | 535 통과(43 파일) |
| contracts 단위 | 41 통과(11 파일) |
| api-client 단위 | 113 통과(8 파일) |
| typecheck | 42 작업 통과 |
| lint | 오류 0 |
| doc-check | 오류 0, 경고 4(기존 openapi 410/504 설명·mermaid 도구) |
| ledger `--batch BAT-610 --require` | 통과(자동 시험 10) |
| trace-check I-T53/J-T18/J-T26/N-T15 | 통과(시험 3551개 대조) |
| records `--check` | 통과(기존 R 번호 중복 경고만) |
| contracts `gen:check` | 통과 |

## 2. Docker test-int (PostgreSQL 18)

- core-svc: **239 통과·1 건너뜀**(19 파일). 0016 적용·재적용, merch_order/merch_order_item/attendee_export RLS·core_partner/core_app 권한, 상품 정산 원천 HTTP, 웹훅 사건 내부 입구, export 403을 실제 DB로 확인.
- payment-svc: **476 통과·2 건너뜀**(21 파일, `--maxWorkers=2`). 0016 적용·재적용, 상품 정산서 계산·목록, 미수금 상계·이동 기록, 내부 정산 HTTP를 확인.
- ops-svc: **40 통과**(9 파일). 0009 적용, 2인 지급 승인·실행·반려를 확인.
- core test-int 1건은 기존 sale-eligibility 50만 행 시험의 건너뜀이다.

### 2.1 test-int에서 고친 결함
- **높음: core AppModule의 review 배선** — `review: o.review`로 한 겹 더 감싸 `eligibility`가 `UnavailableReviewEligibility`로 떨어져 후기 HTTP가 503이었다. `...o.review`로 고쳤고 review test-int 5/5가 통과했다.
- **높음: Drizzle `saveStatement`가 `offset_amount`를 저장하지 않음** — 미수금 상계 뒤 지급액만 줄고 상계 칸이 0으로 남았다. `offsetAmount`를 저장하게 고쳤고 settlement test-int가 통과했다.
- **중간: 실행 실패 뒤 같은 승인 업무로 재승인** — payment-svc `approveBatch`가 같은 `approvalId`의 APPROVED/SUBMITTED/COMPLETED를 멱등으로 돌려주게 고쳤다. 실행만 다시 한다.
- **낮음: 승인 업무 `dueAt`가 null** — 지급일 전 영업일 15시(KST)를 계산해 싣게 고쳤다.

## 3. 변이(26개)

| 묶음 | 변이 | 결과 |
| --- | --- | --- |
| export 사유·보유 기간·마스킹·CSV | M-01~M-09(보유 기간, 사유 검사, 이름·휴대폰 가림, 택배 기준일, 반품 제외, 수식 주입, 재인증 계정 대조, 건수) | 9/9 잡음 |
| 웹훅 서명·재시도·DLQ·FAILING | M-10~M-18(재시도 간격, 서명 문자열, 옛 비밀, FAILING 문턱, 3xx, 재시도 색인, 비활성화, 구독 필터, 꺼진 endpoint) | 9/9 잡음 |
| 상품 정산·미수금 | M-19~M-22(항목별 수수료, +4영업일, 상계 차감, KYC HELD) | 4/4 잡음 |
| ops 2인 승인 | M-23~M-26(요청자 승인, commander 역할, 재인증, 반려 사유) | 4/4 잡음 |

**26/26 잡음.** 처음 M-13은 시험이 코드 상수를 그대로 써서 살아남았고, 시험 값을 49로 고정해 다시 잡았다. M-14는 3xx를 300 이하로 바꾸는 약한 변이여서 400 미만으로 바꿔 다시 잡았다. M-24·M-26은 HTTP 가드가 먼저 막아 애플리케이션 검사를 지나지 않아 살아남았고, 유스케이스를 직접 부르는 시험을 더해 잡았다.

## 4. 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 내용 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 2 | 2 | 중간: 웹훅 발송의 DNS 재해석 창(공인 IP 검사 뒤 fetch가 다시 해석, 발송 파드 443 제한으로 완화·문서화), 승인 업무 감사 체인 미연결(승인 행만 남고 ops 감사 체인에는 안 들어감). 낮음: 내부 토큰이 비면 통과(로컬·CI 규약), PDF 503. |
| 정합 | 0 | 2 | 1 | 중간: 미수금 상계가 트랜잭션·행 잠금 밖이라 동시 묶음에서 이중 상계 가능, 상품 정산서에 기간 유일 제약이 없어 동시 계산 시 중복 가능. 낮음: 반려가 요청 사유를 반려 사유로 덮는다. |
| 시험 | 0 | 1 | 1 | 중간: 웹훅 워커가 모든 파드에서 돌아 중복 발송 가능(리더 Lease 없음). 낮음: worker 지표 없음. |
| 운영 | 0 | 1 | 2 | 중간: 승인 업무 EXECUTING에서 프로세스가 죽으면 고착(재개 작업 없음). 낮음: SCR-049 지급 실행 화면 없음, 토스/포트원 실계정 어댑터 없음. |

- 높음 0. 중간 6은 2건 고침(위 test-int 결함)·4건 문서화/후속. 낮음은 정리 목록으로 넘긴다.

## 5. 브라우저 확인(소유자 Chrome, browse)

- 환경: `apps/partner` 운영 빌드(`next start -p 4201`, `NEXT_PUBLIC_PARTNER_API_ORIGIN=http://127.0.0.1:4012`), 가짜 API 4012.
- SCR-027 [예매자 명단]: 4건·9매, `김*수`·`010-****-1234` 가림 값, 좌석·매수 표시 확인.
- [명단 내려받기] CSV: 사유·비밀번호·TOTP 입력 → 재인증 토큰(`x-reauth-token`)으로 POST, `200 text/csv`, 파일 이름 `예매자명단.csv`, 성공 배너.
- [명단 내려받기] XLSX: 같은 흐름으로 `200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, 파일 이름 `예매자명단.xlsx`, 성공 배너.
- [다운로드 이력]: 사유·건수·형식(XLSX)·결과(완료) 표시.
- ops 지급 승인: console-host에 SCR-049 화면이 없어 브라우저 대신 `services/ops-svc/test/payout-approval.test.ts`의 HTTP·유스케이스 시험(operator 요청→commander 재인증 승인→DONE, 반려, 실행 실패 뒤 재승인)으로 대체 기록했다.
- 콘솔 오류는 비밀번호 입력 칸의 DOM 안내 한 줄뿐이고 화면을 막는 오류는 없었다.

## 6. 남은 막힘

- Secrets Manager/KMS 웹훅 비밀, 파트너 콘솔 알림함·이메일, Kafka `outbox` 소비자.
- 토스 지급대행 실제 JWE·API 키·계정, 포트원 콘솔 권한·출금 원장 API 실계정.
- KYC 사업자·대표자 확인 원천(토스 셀러 조회), 예금주 이름 대조의 실제 조회.
- ops 지급 실행 화면(SCR-049), PDF 형식(한글 폰트), 웹훅 워커 리더 Lease, 미수금 상계 트랜잭션·행 잠금, 승인 감사 체인.
