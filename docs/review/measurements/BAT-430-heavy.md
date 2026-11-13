# BAT-430 R-561 heavy gate

- 날짜: 2026-11-14
- 가지: `wave/lane1-BAT-430` (기준 `origin/develop` `62f48e7c`, R-563 위로 rebase)
- 범위: GAT-140 기기 키, GAT-135 queue-svc 우선 구매 사본·입장
- Docker 사용: ticket-svc test-int(PostgreSQL 18), queue-svc test-int(Valkey 8.1). 끝난 뒤 컨테이너를 정리했다.

## 1. test-int

| 서비스 | 파일 | 결과 |
| --- | --- | --- |
| ticket-svc | `test-int/device-key.int.test.ts` 포함 4파일 | **31 통과** |
| queue-svc | `test-int/priority-grant.int.test.ts` 포함 17파일 | **332 통과** |

- ticket: `0003_device_key.sql` 적용·재적용, 등록·재발급 24시간·폐기·취소 폐기, package `keys`/`revokedKeyIds`, 스캔 keyId(유효·폐기·모름·INVALID_QR), 입장 시작 뒤 REISSUE, TRANSFER 결제자 거절·보유자 허용.
- queue: 실제 Valkey에서 `SetPriorityGrant` 판 번호·TTL, `priorityGrantId` 입장(같은 계정·OFFERED·만료 전), 반복 입장 새 여정, 판매 종료 뒤 ADMITTED, 없음/남의 것/만료 404.
- S-T37 우선 홀드·주문 시험은 purchase-svc `priority_grant` 표·PRIORITY 홀드 선행이 없어 **막힘**으로 기록했다.

## 2. 변이

- 23개 변이: **잡힘 23, 놓침 0, 무효 0**
- 단위 변이 19개 + test-int 변이 4개(등록 변경 기록, Redis 판 번호, Redis TTL, 취소 폐기).
- 결과 파일: `.cache/bat430-mutations.md`(작업 기록, 커밋하지 않음).

## 3. 4관점 리뷰

### 높음(고침)

1. **입장 시작 뒤 REISSUE가 재인증만 있으면 통과했다.** 소유권 동결 규칙 위반이라 `ENTRY_STARTED`로 막았다.
2. **TRANSFER를 결제자가 그대로 써서 키를 교체할 수 있었다.** 양도 수락 전 우회라 `TRANSFER_NOT_ALLOWED`(403)로 막았다.
3. **입장 시작 뒤 TRANSFER가 통과했다.** 소유권 동결에 맞춰 `ENTRY_STARTED`로 막았다.
4. **키가 있는데 다시 ISSUE를 보내 재인증·24시간 한도를 우회할 수 있었다.** 유효 키가 있으면 ISSUE도 재인증이 필요하고, 첫 등록 뒤의 키 교체는 ISSUE/REISSUE 모두 24시간 1회로 센다.

### 중간(문서화·후속)

1. `DrizzleScannerGateStore.acceptScans`가 스캔마다 keyId 상태를 조회한다. 500건 묶음이면 DB 왕복이 최대 500회다. 묶음 단위 선조회로 줄이는 후속이 필요하다.
2. 우선 구매 입장에 예매 제한(GAT-310 `q:rst`) 확인이 없다. GAT-310 선행 뒤 붙인다.
3. TRANSFER는 보유자≠결제자 휴리스틱만 본다. 양도 수락·회수 감사와 연결하는 후속이 필요하다.
4. 재인증 토큰 확인 어댑터가 없어 REISSUE·BOOTH·입장 시작 뒤 ISSUE·키가 있는데 ISSUE는 403이다. identity 재인증 서명 확인이 선행이다.
5. `ticket.event_starts_at`이 비어 있으면 입장 시작 판정을 건너뛴다. purchase-svc 발권 경로가 항상 채우는지 확인·강제하는 후속이 필요하다.
6. 부스 허용(`booth_authorization`)과 `GET /v1/scanner/shift`·기기 배치가 없어 BOOTH·배치는 계속 403/미구현이다.

## 4. CI 로컬 등가

- ticket-svc 단위 **57**, queue-svc 단위 **678**, web 단위 **833**
- ticket-svc·queue-svc·web typecheck
- 루트 lint
- doc-check 오류 0(기존 경고 4)
- `ledger --batch BAT-430`
- `trace-check --ids "Q-T62"` (7개 시험)
- `records --check`
- `contracts gen:check`, api-client **113**
- 브라우저 확인: BAT-430은 서버 계약만 바꿔 화면 변경이 없다. R-563의 월렛 화면 확인은 `develop`에서 이미 했다. 그래서 생략 사유를 여기에 남긴다.

## 5. 남은 문제

- S-T37 우선 홀드·주문 시험은 purchase-svc 선행이 없다.
- 재인증·부스 허용·기기 배치·core 재입장 정책은 후속이다.
- `ledger --batch BAT-430 --require`는 위 미구현 ASVS 행 때문에 아직 빈칸/ID만 항목이 남는다.
