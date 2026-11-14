# BAT-450 GAT-220 잔여 heavy gate 기록 (R-586, 2026-11-15)

가지 `wave/lane1-BAT-450-gat220-remainder`, 기준 `origin/develop` `19457dc5`(R-585).

## 1. cheap gate

| 항목 | 결과 |
| --- | --- |
| ticket-svc 단위 | 97 통과(17파일, 새 gRPC·신선도·SESSION_TERMINATED·기기 인증 스캔·request_id 교차 8건 포함) |
| identity-svc 단위 | 550 통과(45파일) |
| scanner 단위 | 30 통과(7파일, 새 기기 승인 로그인 4·SESSION_TERMINATED 1·토큰 만료 2 포함) |
| web 단위 | 833 통과 |
| ops-svc 단위 | 85 통과(20파일, 새 관제 기기 HTTP 3·경보 해제 1·gRPC 오류 사상 2 포함) |
| platform 단위 | 535 통과(43파일, 새 mTLS 확인 3 포함) |
| contracts 단위 | 41 통과(11파일) |
| api-client 단위 | 113 통과(8파일) |
| console-host 단위 | 57 통과 |
| typecheck | ticket·identity·scanner·web·ops·platform·contracts·api-client·console-host 통과 |
| lint | 바뀐 `services/ticket-svc/src`·`services/ops-svc/src`·`packages/platform/src`·`apps/scanner/src` 통과 |
| contracts `gen:check` | 생성물이 계약과 같다 |
| records `--check` | 통과 |
| ledger BAT-450 | 통과(I-T21 자동 시험, 빈칸 0) |
| trace-check I-T21·I-T22 | identity 단위 보고서로 통과(I-T21 1·I-T22 10) |
| doc-check | 오류 0, 기존 경고 4 |

## 2. heavy gate

### Docker test-int

| 서비스 | 결과 |
| --- | --- |
| ticket-svc | **44 통과**(8파일). 0006 적용·재적용, `scanner-device-command.int.test.ts`의 request_id 멱등·SESSION_TERMINATED·`last_changes_at`, 기존 scanner int 회귀 |
| identity-svc | **169 통과**(29파일). 기기 승인·세션 종료 회귀 |
| ops-svc | **37 통과**(8파일). 0007 적용·재적용, `ops-alert-resolution.int.test.ts` 해제·재개, 마이그레이션 수 8, 기존 0000·0002·0003·0004~0006 회귀 |

- Docker 엔진 `29.8.1` ready. 실패 1건(0003 시험의 `ops_alert` 기대 칸에 0007 칸 누락)을 웨이브 안에서 고쳐 재실행했고, 그 뒤 전부 통과했다.
- 시험 컨테이너는 각 `afterAll`에서 정리됐고, `docker ps`에 남은 시험 컨테이너가 없다.

### 변이(등급 B, 30개)

- **30/30 잡힘, 놓침 0, 무효 0.** 한 변이씩 적용하고 관련 단위 시험을 돌린 뒤 원본으로 되돌렸다.
- 범위: ticket 기기 명령 멱등·2분/입장 경계·SESSION_TERMINATED·last_changes_at, ops 경보 해제/재개·gRPC 오류 사상·viewer 권한, platform mTLS claim/해시/누락 인증서/사설 CA 막힘, scanner 기기 승인 시작·토큰 폴링·410 매핑.
- 첫 실행에서 2개(M09 한 번도 받은 적 없는 기기, M22 gRPC NOT_FOUND 사상)가 놓여 각각 시험을 보강한 뒤 30/30이 됐다. 결과 표는 `.cache/bat450-heavy-mutations.md`(커밋하지 않음).

### 브라우저 확인(소유자 Chrome, browse)

- browse 세션은 연결돼 있었다. 백엔드는 화면이 부르는 계약 모양을 흉내 낸 mock API(3001·8080)로 돌렸고, 실제 ops-svc·ticket-svc 경계는 단위·test-int로 확인했다. 로컬 게이트웨이·identity 전체 스택이 없어 실제 서비스로 화면을 붙이지 못한 것이 이 확인의 한계다.
- **SCR-036 `/login?live=1`**: 실제 기기 승인 코드 `BCDF-GHJK` 표시, `device-authorizations`→`token` 폴링(첫 pending 뒤 승인), "로그인했습니다"와 함께 IndexedDB `session/staff-token`에 `{token, expiresAtMs}` 저장 확인.
- **토큰 사용·재로그인**: `/setup?live=1`이 저장 토큰으로 `shift`를 받아 "준비 완료: 목록 2"를 표시. 만료 토큰(`expiresAtMs: 1`)을 넣고 새로고침하면 "스태프 로그인이 필요합니다"로 돌아가고, `/login?live=1`에서 다시 승인하면 토큰이 새 값으로 저장됐다.
- **`/enroll?live=1`**: 등록 코드를 넣고 `POST /v1/scanner/device-enrollments`가 나간 뒤 `/login?live=1`로 이동.
- **SCR-053 `/scanner-devices`**: 목록 1대 로드, `동문-04` 등록(코드 `BCDF-GHJK-LMNQ`), 새 코드 만들기(코드 `BCDF-GHJK-LMNP`로 바뀜), 사유를 넣은 즉시 폐기(상태 `폐기됨`, 안내 문구) 확인. 화면이 부른 경로는 `/v1/ops/scanner-devices`·`/v1/ops/promoters`·`.../enrollment-code`·`.../revocation`이다.
- 스크린샷: `.cache/browser-scr036.png`·`.cache/browser-scr053.png`(작업 기록, 커밋하지 않음).

## 3. 이번에 넣은 것

- **ops-svc 이관 경계**: ticket-svc gRPC `ScannerDeviceService`(목록·등록·폐기·등록 코드 재발급, `request_id` 멱등 `scanner_device_command` 0006)와 ops-svc `/v1/ops/scanner-devices*`(operator 이상, `audit_chain` `scanner_device_command`, ticket gRPC 없으면 503 `scanner-auth-unavailable`). ticket-svc 직접 HTTP 경로는 호환용으로 남긴다.
- **SCR-036 실제 연결**: `?live=1`/`VITE_SCANNER_LIVE=1`에서 기기 키(DPoP)로 `device-authorizations`→`token` 폴링, 스태프 토큰 만료 시각 저장, 만료·401·`SESSION_TERMINATED` 재로그인, 기기 등록(`device-enrollments`).
- **O-T20**: `scanner_device.last_changes_at`, 입장 창 안 2분 초과 ACTIVE 기기만, 30초 감시, ops-svc `ops_alert` SEV2·해제, `scanner_freshness_alerts_total{result}`·`scanner_freshness_open_alerts`.
- **SESSION_TERMINATED**: 기기 폐기 때 배치된 회차마다 `scanner_change(SESSION_TERMINATED, {deviceId, reason: DEVICE_REVOKED})`, 스캐너 앱이 자기 기기 사건을 읽어 토큰을 지운다.
- **mTLS 계약·시험**: `ScannerShiftAuth.confirmation`(`jkt`·`x5t#S256`), `packages/platform/src/mtls.ts`의 `cnf.x5t#S256`·`mtls_authenticated` 판정과 PoC 막힘 목록.

## 4. 4관점 리뷰

| 관점 | 높음 | 중간 | 낮음 | 처리 |
| --- | --- | --- | --- | --- |
| 보안 | 0 | 2 | 0 | 중간: mTLS 선택지는 계약·판정 함수·시험만 있고 관리형 기기·사설 CA·게이트웨이 검증 PoC가 없어 기본 DPoP를 유지한다(문서화). 중간: `ScannerDeviceService` gRPC는 클러스터 내부망·네트워크 정책에 의존한다(기존 내부 gRPC와 같은 경계, 문서화). |
| 정합 | 0 | 2 | 0 | 중간: ops-svc 감사 기록이 gRPC 성공 뒤에 실패하면 HTTP는 500이고, 클라이언트가 새 request_id로 재시도하면 기기가 하나 더 생길 수 있다(후속: 감사·명령을 한 트랜잭션으로). 중간: 같은 request_id의 기기 등록과 명령 기록이 한 트랜잭션이 아니어서 동시 재시도에 중복 기기가 생길 수 있다(후속: command claim 트랜잭션). 같은 request_id를 다른 명령에 쓰는 경우는 `INVALID_ARGUMENT`로 막았다. |
| 시험 | 0 | 1 | 0 | 중간: `loadStaffSession`의 IndexedDB 경로는 Node 단위 시험이 없고, 만료 경계·옛 저장값 파싱은 순수 함수 시험으로 덮었다. IndexedDB 저장·삭제는 브라우저 확인에서 본다. |
| 운영 | 0 | 3 | 0 | 중간: O-T20 감시가 배치가 있는 모든 회차를 30초마다 훑고 core-svc 정책을 부른다. 회차가 많아지면 입장 창 안 회차만 고르는 색인이 필요하다(후속). 중간: `scanner_device_command` 보존 기한이 없다(후속: 정비 작업에서 오래된 행 지우기). 중간: 모든 파드가 감시를 돌리면 `ops_alert` upsert는 멱등이나 HTTP 호출이 중복된다(후속: 리더 한 파드만). |

높음 0, 중간 8(전부 문서화·후속), 낮음 0. 높음·보안 통과 기준에 걸리는 지적은 없었다.

## 5. 남은 막힘

- mTLS 선택지는 관리형 기기·사설 CA·게이트웨이 클라이언트 인증서 검증 PoC가 없어 켜지 않았다(기본 기기 키+DPoP 유지). 정확한 막힘: `managed-device`, `private-ca`, `gateway-client-cert-verification`.
- 브라우저 확인은 로컬 게이트웨이·identity 전체 스택이 없어 화면 계약 mock으로 했다. 실제 ops-svc 경유 경계는 HTTP 단위·test-int로 확인했지만, 실제 서비스 조합의 브라우저 확인은 후속이다.
- 4관점 리뷰 중간 8건은 모두 문서화·후속이다(위 §4). 높음은 0건이다.
- SCR-036 QR은 기존 퍼블리싱용 근사 무늬이고, 실제 로그인은 확인 코드와 `verificationUriComplete` 링크로 진행한다(실 QR 라이브러리는 wbs 5.1.3 PoC 몫).
