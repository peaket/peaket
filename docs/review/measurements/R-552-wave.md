# R-552 ops-svc 최소 골격 웨이브 보고서

- 날짜: 2026-11-14
- 가지: `wave/lane3-ops-svc`
- 기준: `origin/develop` `98c0febd`, R-553 `a963c75e` 위로 rebase
- 범위: platform 템플릿 기반 `services/ops-svc` 골격, 운영 명령 접수·목록·상세·2인 승인·거부, `ops_command`·`command_event`·`command_approval`, SHA-256 감사 해시 체인(`audit_chain`·`audit_chain_head`), `support.cases-requested`의 `REFUND_FAILED` CS 건 계약, Dockerfile·배포 값·CI 이미지 행/범위.

## Docker test-int

- 실제 PostgreSQL 18 컨테이너에서 13건 통과(2파일).
- `0000_ops_command_audit.sql` 적용·재적용(마이그레이션 기록 1개, 표 그대로), `ops_command`·`command_event`·`command_approval`·`audit_chain` 저장소, 2인 승인·요청자≠승인자, 10분 승인 기한, 감사 해시 체인(직전 해시·머리·seq·leaf salt), 동시 접수 직렬화, CS `REFUND_FAILED` 열린 건 멱등과 `RESOLVED` 뒤 새 건, 실제 DB 위 HTTP 역할 가드·접수·상세·승인·거부를 확인했다.
- test-int가 **높음 1**을 잡았다: Drizzle 원시 SQL이 timestamptz를 문자열로 돌려주는데 저장소가 `Date.getTime()`을 불러 모든 명령·CS 조회가 깨졌다. `new Date(...)`로 고쳤다.

## 변이

- 30개 표본: 명령 상태 전이·2인 승인·기한·감사 체인·CS 멱등·권한·목록 필터·DB 저장소.
- 결과: **30/30 잡음**. 처음에 기한 시험이 코드 상수를 그대로 써서 5분 변이를 놓쳤고(정본 값 10분 리터럴로 고침), 목록 params 변이는 응답 스키마가 지워 등가 변이여서 상세 params 누락 변이로 바꿨다.

## 4관점 리뷰

- 보안: 높음 0, 중간 2(감사 정규화 JSON 키 순서, 거부 사유 제어 문자) → 고침.
- 정합: 중간 1(응답 type·state가 문자열) → `COMMAND_TYPES`·`COMMAND_STATES` enum으로 고침.
- 시험: 중간 1(승인 기한 시험이 코드 상수 사용) → 정본 리터럴로 고침.
- 운영: 중간 2(Dockerfile 런타임에 test-int·통합 설정 포함·CA 인증서 누락, `.dockerignore`가 ops-svc를 빼 이미지 빌드 실패) → 고침.
- 합계: **높음 0, 중간 6(모두 고침)**. 아래 알려진 후속은 이 골격의 범위 밖으로 문서에 남겼다.

## CI 로컬 등가

- typecheck·build·lint 통과.
- ops-svc 단위 23건, core-svc 301건, platform 528건, contracts 41건, api-client 113건 통과.
- doc-check 오류 0(경고 4, 기존), ledger·records·contracts `gen:check` 통과.
- trace-check `GAT-110` 36건(단위 23 + test-int 13) 통과.
- changes 이미지 범위 시험(BSL050) 통과.
- `docker build -f services/ops-svc/Dockerfile` 통과. 이미지에 `src`·`test`·`test-int`·vitest 설정이 없고 `dist`·`migrations`·`scripts`만 있다.
- 워크플로 19개·CODEOWNERS 검사 통과.

## 브라우저 확인

- ops-svc 자체 화면이 없어 생략했다. 사유는 `docs/review/browser-check/R-552.md`에 남겼다. 갈래 2가 SCR-016·SCR-053을 확인한다.

## 남은 문제

- `X-Reauth-Token` 재인증과 `Idempotency-Key` 멱등 키 미적용.
- `requestedBy.displayName` identity 조회, 행위자 가명화(`command_actor`, ADR-0149), `command_approval.requester_ref` 미적용.
- CS 건 기한·담당자·판 번호·상태 전이, Kafka 소비자 조립 미적용.
- 감사 체인 HMAC `mac` 작업자 미적용.
- 제어 gRPC 전달·ack·되돌리기·사후 검토·SSE 미적용.
- GAT-110 회차 취소 요청·일괄 환불, BAT-425/465/470 나머지.
- DB 역할 확인·마이그레이션 잠금은 배포 단계 몫이다.
