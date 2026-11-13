# BAT-450 GAT-210 heavy gate (2026-11-14, R-548)

## 1. rebase

- 가지: `wave/lane1-BAT-450`
- 기준: `origin/develop` `98c0febd`(BAT-420 R-547 merge)
- `daab3d5d`를 `98c0febd` 위로 rebase했다. `docs/review/ledger/README.md` 충돌은 현재 develop 장부 수를 택한 뒤 ledger를 다시 생성해 풀었다. R-548 유지.
- 최종 커밋 해시는 완료 보고에 적는다. 합치기·푸시 없음.

## 2. Docker test-int

`services/identity-svc/test-int/staff-invitations.int.test.ts`를 더해 실제 PostgreSQL 18에서 다음을 봤다.

- `0001~0031` 마이그레이션 적용·재적용, `staff_assignment` 표.
- 초대 조회·만료 410, 수락의 이메일 불일치 403·동의 누락/판 불일치 422, 성공 시 `ASSIGNED`·`accepted_at`·`consent_version` 기록과 초대 이메일/토큰 해시 파기.
- 같은 회차 중복 배정 409, 같은 토큰 재수락 410, 거절 시 `EXPIRED`·초대 파기·재요청 204.
- `ASSIGNED`·`ENDED`·`REVOKED` 내 배정 목록, 유효 시작 늦은 순, 커서 페이지.
- `hasStaffAssignment`가 ASSIGNED 배정으로 true가 되는지.

**결과: 1파일 4건 통과.** 컨테이너는 `afterAll`에서 정리했고 `docker ps -a`에 남은 PostgreSQL 컨테이너가 없다.

## 3. 변이(등급 B)

변이 25개를 소스에 잠시 넣고 관련 시험을 돌린 뒤 원문으로 되돌렸다. 결과는 **25/25 잡힘, 놓침 0, 건너뜀 0**이다. 전체 표는 `.cache/bat450-mutations.md`(커밋하지 않음)에 있다.

- 초대 토큰 SHA-256·만료·1회 사용
- 이메일 검증·이메일 대조
- 수집/제공 동의·동의 판
- 중복 배정·상태 전이
- 내 배정 목록 상태 필터·순서·커서
- `hasStaffAssignment`
- 가린 이메일·수락 응답 상태
- Drizzle 초대 파기·중복 오류·목록 순서·커서
- 0031 마이그레이션 장부
- 목록 limit 상한

## 4. 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 처리 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 2 | 2 | **중간: 초대 이메일이 빈 배정도 수락될 수 있었다.** 수락 전에 초대 이메일이 있어야 하고 계정 이메일과 같아야 하도록 고쳤다. 중간: 파트너 초대 생성은 회차 소유 확인·메일 발송이 없어 후속. 낮음: 초대 조회·수락 시도 제한, 감사 로그는 후속 |
| 정합 | 1 | 1 | 1 | **높음: `0031_staff_assignment_and_scanner_session`이 `migrations/meta/_journal.json`에 없어 실제 마이그레이션에서 `staff_assignment`가 만들어지지 않았다.** 장부에 넣고 test-int로 확인했다. 중간: GAT-220은 선행 부재로 보류. 낮음: 초대 재발송·파트너 명단은 후속 |
| 시험 | 0 | 1 | 1 | test-int의 초기 UUID·중복 키·마이그레이션 반환값 가정을 고쳤다. 낮음: HTTP 경로 시험은 후속 |
| 운영 | 0 | 0 | 2 | 초대 메일 발송·재발송과 초대 시도 지표는 후속 |

**높음 1(고침), 중간 3(1 고침, 2 문서화·후속), 낮음 6(0 고침, 6 후속).**

## 5. CI 로컬 등가

- typecheck: identity-svc·contracts·api-client 통과.
- lint: identity-svc·platform 통과.
- 단위: identity-svc 533건, contracts 41건, api-client 113건.
- test-int: staff 초대 4건(실제 PostgreSQL 18).
- doc-check: 오류 0, 기존 경고 4.
- ledger: `--batch BAT-450 --require` 통과(자동 시험 1·빈칸 0).
- trace-check: I-T21 통과.
- records `--check`: 통과(기존 경고 R-374·R-473).
- contracts `check-generated`: 통과.

## 6. 브라우저 확인

화면 변경이 없다. GAT-210 서버 경로와 저장소만 바뀌었고 SCR-050·061 화면은 후속이므로 브라우저 확인을 생략했다. HTTP 계약은 contracts `check-generated`와 단위·test-int로 확인했다.

## 7. GAT-220 보류 기록

GAT-220은 다음 선행이 없어 구현하지 않았다.

- ticket-svc `ScannerDeviceLookupService.GetScannerDeviceByCredential` gRPC 서버
- identity-svc staff 액세스 토큰 서명(`cnf.jkt`, staff 키 셋)
- 기기 인증만 하는 DPoP 경로(platform `ScannerAuth`의 선택 토큰)
- 기기 승인 코드 저장소·승인 화면(SCR-036·037), 기기 승인 시 세션 1개·교대·대리 승인·세션 종료
- GAT-140 기기 배치

## 8. 남은 문제

- 파트너 초대 생성(회차 소유 확인, 여러 명 초대), 초대 메일 발송·재발송.
- 초대 조회·수락 시도 제한, 감사 로그.
- GAT-220 전체와 SCR-036·037.
- 초대 수락·거절 HTTP 경로 시험과 내 배정 목록의 `activeScannerDeviceName`(ticket-svc 기기 이름) 연결.
