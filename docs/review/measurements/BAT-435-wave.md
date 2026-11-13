# BAT-435 GAT-170 heavy gate (2026-11-13, R-537)

## 1. 기준과 rebase

- 작업 가지: `wave/lane1-BAT-435-device`
- 기준: `origin/develop` `19566da8`(R-541 bundle validation hotfix)
- rebase: `eba8389`를 `19566da8` 위로 rebase했다. `docs/00-summary.md`·`docs/review/consistency-review.md`에서 R-541과 R-537 줄이 겹쳐 두 줄을 모두 남기는 것으로 풀었다. R 번호는 R-537 그대로다.
- 결과 커밋: R-537 amend 커밋(최종 해시는 완료 보고에 적는다, 합치기·푸시 없음).

## 2. Docker test-int

`services/ticket-svc/test-int/scanner.int.test.ts`를 더해 실제 PostgreSQL 18과 Valkey 8.1에서 다음을 봤다.

- `0000_ticket.sql`·`0001_scanner_device.sql` 적용, 재적용 시 빈 목록, `scanner_device` 표·상태 CHECK·지문 유일 인덱스.
- Drizzle 기기 원장: 등록·커서 목록·ACTIVE 지문 묶기·폐기, 같은 지문을 두 기기에 묶을 때 `23505`를 도메인 `ScannerDeviceKeyConflict`로 바꾸는지.
- 등록 코드: Redis `scanner:enroll:{SHA-256}`에 기기 ID만 두고 `GETDEL`로 1회, TTL 10분, 코드 원문이 키에 없는지.
- DPoP `jti`: Redis `scanner:dpop:{jti}` `SET NX PX` 10분, 두 번째 사용 거절.
- HTTP: 관제 등록(201·1회용 코드) → 공개 `POST /v1/scanner/device-enrollments`(DPoP jkt, 201) → 목록 → 폐기(200), 사용한 코드·폐기 기기 코드 410.
- platform `ScannerGuard`: 실제 ticket-svc 원장의 ACTIVE와 identity `CheckScannerSession`(staff_assignment·scanner_session 실제 행)을 보고 `gate_staff` 역할·기기 ID·파트너를 넘기는지, 폐기 기기 403·종료 세션 401·역할 불일치 403·같은 jti 재사용 401.
- 결과: **2파일 15건 통과**(기존 ticket 9건 + 스캐너 6건). 컨테이너는 `afterAll`에서 정리했고 `docker ps`에 남은 컨테이너가 없다.

## 3. 변이(등급 B)

변이 30개를 소스에 잠시 넣고 관련 시험을 돌린 뒤 원문으로 되돌렸다. 결과는 **30/30 잡힘, 놓침 0, 건너뜀 0**이다. 전체 표는 `.cache/bat435-mutations.md`(커밋하지 않음)에 있다.

| ID | 변이 | 잡은 시험 |
| --- | --- | --- |
| M01 | jkt 43자 → 42자 | ticket-svc scanner-device |
| M02 | 등록 코드 TTL 10분 → 9분 | ticket-svc scanner-device |
| M03 | 코드 정규화 대문자 → 소문자 | ticket-svc scanner-device |
| M04 | 코드 해시 SHA-256 → SHA-1 | ticket-svc scanner-device |
| M05 | 코드 12자 → 11자 | ticket-svc scanner-device |
| M06 | 없는 코드를 성공으로 | ticket-svc scanner-device |
| M07 | 없는 기기 폐기를 진행 | ticket-svc scanner-device |
| M08 | 목록 커서 무시 | ticket-svc scanner-device |
| M09 | 코드 만료 시각을 지금으로 | ticket-svc scanner-device |
| M10 | 메모리 코드 저장소가 삭제 안 함 | ticket-svc scanner-device |
| M11 | 메모리 원장이 폐기 기기에 지문 묶음 | ticket-svc scanner-device |
| M12 | 메모리 원장이 지문으로 못 찾음 | ticket-svc scanner-device |
| M13 | Redis 코드 SET에서 PX 제거 | ticket-svc scanner-device |
| M14 | GETDEL → GET | ticket-svc scanner-device |
| M15 | DPoP jti SET에서 NX 제거 | ticket-svc scanner-device |
| M16 | DPoP jti SET에서 PX 제거 | ticket-svc scanner-device |
| M17 | jti 재사용 통과 | platform scanner-auth |
| M18 | iat 창 5분 → 6분 | platform scanner-auth |
| M19 | htm 검사 끔 | platform scanner-auth |
| M20 | 토큰 없는 등록 증명에 ath 요구 | ticket-svc scanner-http |
| M21 | 가드가 폐기 기기 통과 | platform scanner-auth |
| M22 | 가드가 무효 세션 통과 | platform scanner-auth |
| M23 | 가드가 역할 불일치 통과 | platform scanner-auth |
| M24 | 종료 세션 통과 | identity check-scanner-session |
| M25 | 해제 배정 통과 | identity check-scanner-session |
| M26 | Drizzle 폐기가 ACTIVE 조건 무시 | ticket-svc test-int |
| M27 | Drizzle 지문 묶기가 ACTIVE 조건 무시 | ticket-svc test-int |
| M28 | 지문 유일 인덱스 → 일반 인덱스 | ticket-svc test-int |
| M29 | 관제 기기 등록을 viewer에게 개방 | ticket-svc scanner-http |
| M30 | 기기 등록 증명에 ath 요구 | ticket-svc scanner-http |

## 4. 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 처리 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 2 | 2 | 중간 1 고침(중복 jkt 500→409), 중간 1 문서화(기기 파트너 대조는 GAT-140), 낮음 1 고침(Authorization 스킴 대소문자), 낮음 1 후속(IP 시도 제한·전체 실패 경보) |
| 정합 | 0 | 2 | 2 | ops-svc가 없어 ticket-svc가 관제 HTTP를 직접 받는 점을 문서화(후속 이관), OpenAPI `allOf`가 계약 스윕과 서비스 Zod 모양을 갈라 flat 스키마로 고침, 코드 재발급·`last_seen_at`은 후속 |
| 시험 | 0 | 0 | 2 | test-int의 UUID 커서 가정·Drizzle 오류 래핑을 결정적 ID·도메인 오류로 고침, prod 설정 시험 추가 |
| 운영 | 0 | 1 | 2 | staging·prod에서 Redis·identity 주소 없이 시작하지 않게 고침, DB+Redis 비원자성·스캐너 인증 지표는 후속 |

- **높음 0, 중간 5(3 고침, 2 문서화·후속)**.
- 중간으로 남긴 둘: (1) ops-svc가 아직 없어 관제 권한 확인·감사 기록이 ticket-svc에 있고, ops-svc가 생기면 내부 gRPC로 옮겨야 한다. (2) `CheckScannerSession`은 기기 ID·세션·배정 상태·유효 시간만 보고, 기기 파트너와 배정 파트너의 대조는 GAT-140 기기 승인 로그인 몫이다. 이번 배치의 스캐너 경로에는 아직 `@ScannerAuth()` 처리기가 없어 실제 노출은 없지만, GAT-140에서 붙일 때 반드시 확인해야 한다.

## 5. CI 로컬 등가

- typecheck: ticket-svc·platform·identity·contracts·api-client 통과.
- lint: 전체 통과.
- 단위: ticket-svc 30건, platform 528건, identity 528건, contracts 41건, api-client 113건 통과.
- doc-check: 오류 0, 기존 경고 4.
- ledger: `--batch BAT-435 --require` 통과(미실행 0·빈칸 0).
- trace-check: O-T37 통과 8.
- records: `--check` 통과(기존 경고 R-374·R-473).
- contracts `check-generated`: 통과. api-client 시험: 113건 통과.
- `pnpm install --lockfile-only --frozen-lockfile --offline`: 통과.

## 6. 브라우저 확인

SCR-053 화면이 아직 없다. 이번 배치는 서버 계약·시험까지이고 화면은 후속이므로 브라우저 확인을 생략했다. 대신 공개 기기 등록·관제 기기 경로를 HTTP 주입 시험과 실제 PostgreSQL·Valkey test-int로 확인했다.

## 7. 남은 문제

- SCR-053 화면, 등록 코드 재발급(`POST /v1/ops/scanner-devices/{deviceId}/enrollment-code`), 등록 시도 IP 제한·전체 실패 SEV3 경보, `last_seen_at` 갱신.
- ops-svc가 생기면 관제 권한 확인·감사 기록을 옮기고 ticket-svc 내부 gRPC(`ScannerDeviceService`)로 바꾼다.
- GAT-140 기기 승인 로그인에서 기기 파트너와 배정 파트너 대조를 붙인다.
- 등록 코드 발급은 DB insert와 Redis put이 한 트랜잭션이 아니다. Redis 장애 때 기기 행만 남을 수 있어 재발급 경로와 함께 정리한다.
- 스캐너 인증 실패·기기 폐기·등록 실패 지표/감사 로그는 후속이다.
