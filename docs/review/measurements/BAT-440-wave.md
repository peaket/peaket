# BAT-440 GAT-180·GAT-190 heavy gate (2026-11-13, R-544)

## 1. rebase

- 가지: `wave/lane1-BAT-440`
- 기준: `origin/develop` `718a31c3`(R-546 후기 오류 유형 hotfix)
- `d3ac7422`를 `718a31c3` 위로 rebase했다. `docs/review/ledger/README.md` 충돌은 현재 develop 쪽 장부 수를 택한 뒤 ledger를 다시 생성해 풀었다. R 번호는 R-544 그대로다.
- 최종 커밋 해시는 완료 보고에 적는다. 합치기·푸시 없음.

## 2. Docker test-int

`services/ticket-svc/test-int/scanner-gate.int.test.ts`를 더해 실제 PostgreSQL 18에서 다음을 봤다.

- `0000_ticket.sql`·`0001_scanner_device.sql`·`0002_scanner_gate.sql` 적용·재적용, `scanner_seq`·`scanner_change`·`scan_event`·`gate_flag`·`gate_flag_scan` 표와 `gate_flag` CHECK.
- **O-T38 스냅샷**: 두 연결로 REPEATABLE READ 트랜잭션을 열고, 다른 연결이 `scanner_change`·`scanner_seq`를 커밋해도 첫 트랜잭션의 `last_seq`·티켓 목록이 고정되는지, 스냅샷 뒤 변경이 `changes after`로 오는지.
- 변경 커서: `after` 다음부터 `limit`만큼, `hasMore`, `lastSeq`.
- 발권·취소 트랜잭션의 `TICKET_STATUS`·`KEY_REVOKED` 변경 기록.
- 스캔: 같은 `scanId` 동시 업로드가 한 행만 남기는지, **같은 티켓의 서로 다른 두 IN이 동시에 와도 하나만 PASS이고 하나는 DUPLICATE**인지, 취소 티켓 `AFTER_CANCEL`, 없는 티켓 `REJECT/UNKNOWN_TICKET`.
- 이상 표시: `gate_flag`·`gate_flag_scan` 행, `resolution`의 상태·메모·`resolved_by`.
- 권한: `gate_lead`만 목록·확인, `gate_staff`는 403.
- 결과: **3파일 26건 통과**(ticket 10 + scanner 6 + gate 10). `afterAll`에서 컨테이너를 정리했고 `docker ps -a`에 남은 PostgreSQL·Valkey 컨테이너가 없다.

## 3. 변이(등급 B)

변이 26개를 소스에 잠시 넣고 관련 시험을 돌린 뒤 원문으로 되돌렸다. 결과는 **26/26 잡힘, 놓침 0, 건너뜀 0**이다. 전체 표는 `.cache/bat440-mutations.md`(커밋하지 않음)에 있다.

- 패키지 `lastSeq`·구역, 변경 `after`·`hasMore`·`lastSeq`
- 메모리 저장소 스캔 멱등·중복 IN·취소·세션 밖·확인 결과
- 회차 대조(패키지·스캔·이상 표시), 변경 after
- 이상 표시 목록 권한·no-store·확인자
- 발권·취소 변경 기록, 변경 일련번호
- Drizzle 중복 IN·취소 판정
- ScannerGuard 회차 전달·역할 판정
- 같은 티켓 동시 IN 직렬화(advisory lock)

## 4. 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 처리 |
| --- | --- | --- | --- | --- |
| 보안 | 1 | 2 | 1 | **높음: 같은 티켓의 동시 IN 두 건이 둘 다 PASS가 될 수 있었다.** `pg_advisory_xact_lock`으로 티켓 단위 직렬화를 넣고 test-int로 확인했다. 중간: 기기 인증만 스캔 업로드 미지원(문서화), `entry_closed_at`·시각 불확실 미구현(후속). 낮음: override note 미저장(후속) |
| 정합 | 0 | 1 | 2 | `created_at`/`scanned_at_device`가 raw 조회에서 문자열로 와 500이 나던 것을 `iso()`로 고쳤다. `device_key`·정책 사본·좌석 이름·양도 변경분은 문서화된 후속 |
| 시험 | 0 | 1 | 1 | 테스트 순서 의존(중복 IN이 앞 시험의 PASS에 기대던 것)을 전용 티켓으로 고쳤고, 동시 다른 IN 시험을 더했다. 플래그 커서 페이지 시험은 후속 |
| 운영 | 0 | 0 | 2 | `scanner_change`·`scan_event` 보존 기간·정리 작업, 스캐너 인증/스캔 실패 지표는 후속 |

**높음 1(고침), 중간 4(2 고침, 2 문서화·후속), 낮음 6(0 고침, 6 후속).**

## 5. CI 로컬 등가

- typecheck: ticket-svc·platform·identity·contracts·api-client 통과.
- lint: 전체 통과.
- 단위: ticket-svc 45건, platform 528건, identity 528건, contracts 41건, api-client 113건 통과.
- test-int: 3파일 26건 통과(실제 PostgreSQL 18).
- doc-check: 오류 0, 기존 경고 4.
- ledger: `--batch BAT-440 --require` 통과(자동 시험 1·빈칸 0).
- trace-check: O-T37 통과 8, O-T38 통과 1.
- records `--check`: 통과(기존 경고 R-374·R-473).
- contracts `check-generated`: 통과. api-client 시험 113건 통과.
- `pnpm install --lockfile-only --frozen-lockfile --offline`: 통과.

## 6. 브라우저 확인

화면 변경이 없다. GAT-180은 서버 계약·저장소이고 SCR-052/053 화면은 후속이므로 브라우저 확인을 생략했다. 대신 HTTP 주입 시험과 실제 PostgreSQL test-int로 확인했다.

## 7. 남은 문제

- `device_key` 표가 없어 package `keys`·`revokedKeyIds`는 빈 배열, core-svc 정책 사본이 없어 `reentryAllowed`는 false, 좌석 이름이 없어 `seatLabel`은 seatId다.
- `entry_closed_at`·게이트 배치·양도 변경분·세션 종료 변경·기기 인증만 스캔 업로드·마감 뒤 도착·시각 불확실은 후속이다.
- GAT-190의 기기 배치·부스 재발급·예외 통과·확인 스캔은 후속이다.
- `scanner_change`·`scan_event` 보존 기간·정리 작업과 스캐너 인증/스캔 실패 지표는 후속이다.
- `flags` 목록의 기기 배치 구역 우선 정렬과 플래그 커서 페이지 시험은 후속이다.
