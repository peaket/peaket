# BAT-450A 계획·기록 — GAT-220 기기 승인 로그인 마감

- 묶음: BAT-450A, 갈래 3, 구간 3, 등급 B(보안 통제·세션 권한). 단계 `GAT-220`(wbs 5.5.2). WBS 일 1.25 [가정].
- 장부 범위: `I-T23, I-T24, I-T25, I-T37, I-T38, I-T39`. 2026-11-22 `ledger --scope` 실측에서 여섯 항목이 모두 빈칸이었다.
- 기준: `origin/develop` `452e5d714`. 작업 폴더 `D:/ticketpass-lane3`, 가지 `feature/lane3-BAT-450A`.
- 출처: 이전 조사 초안 `docs/review/plans/BAT-450-scope.md`(같은 계획 커밋에 보존). `docs/BUILD_ORDER.md` BAT-450 줄, `docs/features/identity.md` §6.1, `docs/security/asvs/offline-gate.md` 6.5.1·6.6.3·10.3.5, `docs/review/measurements/BAT-450-gat220.md`·`BAT-450-gat220-remainder.md`, `docs/review/audit/reports/C2.md` C2-06·C2-07·C2-09, `docs/wbs/wbs.md`·`wbs.csv` 5.5.2.
- 차례: 시험 먼저(계획 → 시험 → 구현 → 리뷰 → 검증). 정방향 꼬리말은 달지 않는다.
- 이 파일은 역할마다 자기 절만 쓴다: 계획(아래), 실패 확인(시험), 리뷰(리뷰), 검증(검증), 담당 표(각 역할이 자기 줄).

## 계획

계획 담당 `lane3-bat450a-plan`(deepseek-v4.1-flash), 2026-11-22. 제품 코드·시험은 쓰지 않았다.

### 1. 정본과 이 묶음이 고치는 것

GAT-220의 기능(기기 승인·`cnf.jkt` 토큰·세션 1개·교대·대리 승인·SCR-036)은 R-566·R-582·R-586·R-600·R-619에서 끝났다. 이 묶음은 감사 C2-06·C2-07·C2-09와 같은 기기 동시 승인 경합을 닫고, 장부 여섯 빈칸에 실제 시험 이름을 붙인다.

| 정본 | 지금 적힌 것 | 이 묶음이 맞추는 것 |
| --- | --- | --- |
| `docs/features/identity.md` §6.1 | 확인 코드 8자·5분·1회용, 승인 뒤 토큰, 세션 1개·교대 | 확인 코드 색인의 원자성, 첫 토큰 발급 때 기기 코드·색인 파기, 공개 출처로 `htu` 구성, 같은 기기 동시 승인의 409 |
| `docs/security/asvs/offline-gate.md` 6.5.1(90줄) | "확인 코드·기기 승인 코드는 토큰을 받으면 지운다(Redis `id:devauth`)" | 코드가 실제로 첫 발급 때 지우는지, 두 번째 폴링이 `expired_token`인지 시험으로 확인 |
| 같은 문서 6.6.3(97줄) | 시도 제한으로 무차별 대입을 막는다 | 사용자 코드 색인을 `SET NX`로 잡고 충돌하면 새 코드를 뽑는다 |
| 같은 문서 10.3.5(280줄) | `cnf.jkt`·`htu`가 맞는지 본다 | `htu`를 게이트웨이 공개 출처로 만들고 forwarded 머리는 설정이 없을 때만 쓴다 |
| `docs/api/openapi.yaml` 문제 유형 | 기기 승인 문제 네 종류 | `user-code-unavailable`(409)·`device-approval-conflict`(409)를 더한다 |
| `docs/wbs/wbs.md`·`wbs.csv` 5.5.2 | `SCR-036·037` | `SCR-036`만 두고 `SCR-037은 GAT-360·BAT-405`라고 적는다(BUILD_ORDER 589와 맞춤) |

### 2. C2-06: 사용자 확인 코드 색인을 원자적으로 잡는다

- 지금 `RedisDeviceAuthorizations.save`의 Lua는 `id:devcode:{userCode}`를 조건 없이 `SET`한다. 같은 코드가 겹치면 뒤 요청이 색인을 덮어써 앞 기기의 승인 화면이 다른 기기 이름·코드를 보여 준다.
- `save`의 Lua를 `SET ... PXAT ... NX`로 바꾼다. 색인을 먼저 잡고 실패하면 레코드를 쓰지 않고 `false`를 돌려준다. 성공했을 때만 `HSET`·`PEXPIREAT`를 한다(스크립트 하나라 원자적이다).
- `DeviceAuthorizationStore.save`의 반환을 `Promise<boolean>`으로 바꾸고 메모리 저장소도 같은 규칙을 지킨다.
- `StartDeviceAuthorization`은 기기 코드는 한 번 만들고 사용자 코드만 새로 뽑아 최대 다섯 번 저장을 시도한다. 다 실패하면 `USER_CODE_UNAVAILABLE`로 닫고 컨트롤러가 409 `user-code-unavailable`로 답한다. 스캐너는 기기 승인 시작을 다시 부르면 된다.
- 시험: 같은 코드를 두 번 저장하면 두 번째가 `false`이고 첫 레코드·색인이 그대로다. 한 번 충돌한 뒤에는 새 코드로 저장된다. 다섯 번 모두 충돌하면 `USER_CODE_UNAVAILABLE`이고 HTTP는 409다.

### 3. C2-07: 첫 토큰 발급 때 기기 코드와 색인을 지운다

- 지금 `POLL`은 `APPROVED`를 계속 돌려주어 5분 동안 같은 기기 코드로 여러 토큰이 나온다. ASVS 6.5.1의 "토큰을 받으면 지운다"와 어긋난다.
- `POLL`이 처음 `APPROVED`를 돌려줄 때 레코드(`id:devauth:{hash}`)와 색인(`id:devcode:{userCode}`)을 함께 지우고 그 승인 값을 돌려준다. 이후 폴링은 `expired_token`이다.
- 메모리 저장소도 `APPROVED`를 돌려줄 때 두 맵에서 지운다. 만료 때도 색인을 함께 지운다.
- 동시 폴링 둘이 겹치면 Lua 하나가 먼저 지우므로 토큰은 하나만 나온다. 시험은 승인 뒤 폴링 둘을 동시에 보내 하나만 성공하고 하나는 `expired_token`인지 본다.
- 토큰 서명이 실패하면 그 기기 코드는 이미 지워져 다시 받을 수 없다. 5분짜리 일회용 코드라 서명 실패는 서버 오류이고, 스캐너는 새 승인을 시작하는 쪽이 안전하다. 이 판단을 `poll-scanner-token.ts` 머리 주석에 남긴다.

### 4. C2-09: `htu`를 공개 출처로 만든다

- 지금 `packages/platform/src/auth.ts`의 `requestUrlOf`와 identity·ticket의 같은 함수가 `x-forwarded-proto`·`x-forwarded-host`를 먼저 쓴다. 서비스에 직접 닿는 호출자가 그 머리를 바꾸면 DPoP 증명의 주소 결속이 게이트웨이 설정에만 기댄다.
- `@peaket/platform`에 `requestUrlOf(request, publicOrigin?)`와 `publicOriginFromEnv(env?)`를 둔다. `PEAKET_PUBLIC_ORIGIN`이 있으면 `그 출처 + 경로`로 `htu`를 만들고 forwarded 머리는 보지 않는다. 없으면 지금처럼 forwarded→Host로 내려간다(개발·시험).
- `publicOriginFromEnv`는 `http`·`https` 절대 출처만 받고 경로·질의·조각·사용자 정보가 있으면 시작 때 오류를 낸다.
- `ScannerAuthWiring`에 `publicOrigin?: string`을 더해 ticket-svc `ScannerGuard`가 쓴다. identity 기기 승인·ticket 기기 등록 컨트롤러의 지역 함수는 공용 함수로 바꾼다.
- 로컬 데모 `deploy/envs/local/demo/identity-svc.yaml`·`ticket-svc.yaml`에 `PEAKET_PUBLIC_ORIGIN: https://scanner-api.peaket.example:18445`를 넣는다.
- 시험: 공개 출처가 있으면 `x-forwarded-host: evil.example`을 보내도 `htu`가 공개 출처인 증명은 통과하고, `htu`가 `evil.example`인 증명은 401/400이다. 공개 출처가 없으면 지금처럼 forwarded를 쓴다.

### 5. 같은 기기 동시 승인을 409로 닫는다

- `DrizzleStaffAssignmentStore.createScannerSession`은 `scanner_session_device_active_key`(0032)·`scanner_session_account_active_key`(0033) 위반(`23505`)을 잡지 않아 500이 될 수 있다.
- 두 유일 인덱스 위반을 `ScannerSessionConflict`로 바꾸고, `DeviceApprovals.decide`가 `APPROVAL_CONFLICT`로 사상한다. 컨트롤러는 409 `device-approval-conflict`다. 이미 처리된 같은 기기 코드는 지금처럼 `ALREADY_HANDLED`(멱등 결과)다.
- 시험: 저장소가 `23505`를 던지는 단위 시험에서 `APPROVAL_CONFLICT`가 나오고, 실제 PostgreSQL에서 같은 기기·다른 계정의 동시 승인이 500 없이 하나만 남는지 본다.

### 6. 시험 계획(시험 담당이 구현 전 트리에서 실패를 본다)

| ID | 시험(새 이름 또는 바꿀 이름) | 잡는 것 |
| --- | --- | --- |
| I-T23 | identity `I-T23 ①` 역할 유효 시작 전·끝 뒤 승인 거절, 경계는 통과 / apps/scanner `I-T23 ③` 만료 타이머 | 근무 시간 밖 로그인 차단, 오프라인 즉시 종료 |
| I-T24 | identity `I-T24 ①` 배정 REVOKED 뒤 16분 뒤 확인도 무효 / ticket `I-T24 ②` 세션 밖 기록 `OUT_OF_SESSION` / apps/scanner `I-T24 ③` `SESSION_TERMINATED`로 로그아웃 | 해제 즉시 반영, 해제 뒤 기록 표시 |
| I-T25 | ticket `I-T25 ①` `gate_staff`·대리·기기 단독 403·기록 없음 / `I-T25 ②` `gate_lead` 본인만 통과, `scan_event.staff_account_id`에 승인 계정 기록 | 권한 통제와 감사 기록 |
| I-T37 | identity `I-T37 ①` 기기당 시간당 10회 / `I-T37 ②` 계정당 10분 5회 | 무차별 대입 제한 |
| I-T38 | identity `I-T38` 같은 기기 다른 스태프 교대, 같은 계정 둘째 기기 교대, 같은 기기 동시 승인은 하나만 | 세션 1개 |
| I-T39 | platform `I-T39 ①` `cnf.jkt` 불일치 401 / identity `I-T39 ②` 토큰 `cnf.jkt` 결속 / `I-T39 ③` 다른 키 지문 폴링 거절 | 토큰-기기 결속 |
| C2-06 | identity `C2-06 ①~③` | 색인 충돌·재시도·409 |
| C2-07 | identity `C2-07 ①~③` | 첫 발급 뒤 삭제·재폴링·동시 폴링 |
| C2-09 | platform·identity `C2-09 ①~③` | forwarded 위조 |
| 경합 | identity `I-T38 ④`·`C2-05/경합` | 같은 기기 동시 승인 409 |

- 단위 시험은 메모리 저장소·가짜 기기 원장·`createService` HTTP로 돌린다.
- Redis/Valkey 실제가 필요한 시험(색인 `SET NX`·첫 발급 삭제·동시 폴링·동시 승인)은 Docker 잠금을 잡고 `test-int/device-approval.int.test.ts`에 더한다. PostgreSQL 동시 승인도 같은 파일이다.
- I-T24의 파트너 콘솔 해제 **경로**(`DELETE /v1/partner/staff/{assignmentId}`)는 BAT-450B 몫이라 이 묶음에 없다. 배정이 REVOKED가 된 뒤의 서버 판정·세션 밖 기록·스캐너 로그아웃까지를 이 묶음 시험으로 둔다. 이 한계를 `## 검증`에 적는다.

### 7. GAT-220 단계 줄 판정

아래가 모두 끝났을 때만 `docs/BUILD_ORDER.md` 589줄, `docs/wbs/wbs.md` 287줄, `docs/wbs/wbs.csv` 226줄을 체크한다.

1. C2-06·C2-07·C2-09와 같은 기기 동시 승인 경합이 고쳐지고 시험이 통과한다.
2. 장부 여섯 빈칸이 `자동 시험`이 되고 `ledger --batch BAT-450A --require`가 통과한다.
3. wbs 5.5.2의 `SCR-037` 불일치를 고친다.
4. mTLS `cnf.x5t#S256` 발급은 GAT-170 관리형 기기 PoC 뒤, 휴대폰 카메라 승인 흐름은 GAT-230·관리형 기기 PoC 뒤라는 막힘을 단계 줄에 그대로 남긴다. 이 둘은 GAT-220 단계 문구 밖이 아니다(단계 줄에 이미 적혀 있다).
5. 역할별 커밋·리뷰·검증·기록 절차를 지킨다.

### 8. 넘기는 것(이 묶음이 하지 않는다)

- **BAT-450B**: 파트너 초대 생성(여러 명·회차 소유 확인·24시간 토큰·URL 조각), 초대 메일, 파트너 명단·해제·재발송, `gw-partner` 라우트 이동. I-T24의 해제 경로도 여기다.
- **BAT-450C**: 배정 만료 정비(`INVITED`→`EXPIRED`, `ASSIGNED`→`ENDED`), `hasStaffAssignment`·`listSelf` 시간 필터(C2-11), `promoter_id` 백필(C2-10), ASVS GAT-210 행 재판정, I-T21 보강.
- **BAT-450D**: 스태프 초대·해제·승인 실패의 불변 감사 기록(표 또는 ops 감사 접수). 이 묶음의 I-T25 감사는 기존 `scan_event.staff_account_id`까지다.
- GAT-360(BAT-405)의 SCR-037, GAT-230·GAT-240(BAT-400)의 SCR-050·051·061 화면, GAT-250(BAT-455)의 실제 메일 대행사, GAT-170 mTLS 운영 PoC.

### 9. 자주 놓친 결함을 이 묶음에 대 본 것

| 항목 | 이 묶음 |
| --- | --- |
| Lua·저장소 응답은 정확한 값까지 단언 | `save`의 `true/false`, 첫 폴링의 승인 JSON, 두 번째 폴링의 `expired_token`을 값으로 본다 |
| 경계값은 양쪽 | 근무 시작 정확히 같은 시각·1ms 전, 유효 끝 정확히 같은 시각·1ms 뒤, 폴링 간격 경계 |
| 지우거나 옮기는 연산은 건드린 키를 모두 확인 | `id:devauth`와 `id:devcode` 둘 다 지웠는지, 다른 기기 코드는 남았는지 |
| 판정 함수만 말고 부르는 쪽 | HTTP 409·401, `DeviceApprovals.decide`, 실제 Valkey·PostgreSQL |
| 같은 규칙 두 곳에서 겹쳐 지킴 | 메모리 저장소와 Redis 저장소의 `save`·`notePoll` 규칙을 같은 시험 이름으로 본다 |
| 시험 값이 상수와 같으면 숨음 | 사용자 코드·기기 ID·시각은 코드 상수와 다른 고정 값을 쓴다 |
| 장애 주입이 커밋 뒤까지 닿는가 | Redis 오류·DB `23505` 경로를 시험한다 |
| 시간 한도·간격 상수 | 발급 10회/시간, 승인 5회/10분, 코드 5분을 경계로 본다 |
| 시작 파일 조립 | identity `main.ts`·ticket `start.ts`에 `PEAKET_PUBLIC_ORIGIN`이 닿는지 typecheck·단위로 본다 |

### 10. 게이트

```bash
pnpm --filter @peaket/identity-svc typecheck
pnpm --filter @peaket/ticket-svc typecheck
pnpm --filter @peaket/platform typecheck
pnpm --filter @peaket/identity-svc test
pnpm --filter @peaket/ticket-svc test
pnpm --filter @peaket/platform test
pnpm --filter @peaket/scanner test
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
pnpm --filter @peaket/contracts gen:check
pnpm --filter @peaket/api-client test
node tools/ci/trace-check.mjs --ids "I-T23,I-T24,I-T25,I-T37,I-T38,I-T39" --report <vitest JSON>
node tools/ci/ledger.mjs --batch BAT-450A --require
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
node tools/ci/records.mjs --check
```

Docker 시험은 `test-int/device-approval.int.test.ts`, `ticket-svc/test-int/scanner-gate.int.test.ts`·`scanner-shift.int.test.ts`를 잠금 안에서 돌린다. 끝나면 `docker ps`에 peaket 컨테이너 0을 확인한다.

## 실패 확인

시험 담당 `lane3-bat450a-test`(deepseek-v4.1-flash), 2026-11-22 12:05~12:08 KST. 기준 트리 `aa66c0d2`(계획 커밋)에서 구현 없이 시험만 더해 돌렸다. Docker 잠금은 `lane3-BAT-450A`를 12:07:38에 잡고 12:07:55에 놓았고, 시험 컨테이너가 남지 않았음을 `docker ps`로 확인했다(peaket 0).

### 단위·HTTP(구현 전)

| 파일 | 결과 | 실패한 시험(까닭) |
| --- | --- | --- |
| `services/identity-svc/test/device-approval.test.ts` | 17개 중 4 실패 | `C2-06 ①` 저장 반환이 `undefined`(지금은 `save`가 `void`) · `C2-06 ②` 저장 호출 1회(색인 충돌을 보지 않음) · `C2-07 ①` 첫 발급 뒤 레코드·색인이 남음 · `C2-07 ②` 둘째 폴링이 `expired_token`이 아니라 `slow_down` |
| `services/identity-svc/test/scanner-authorization-http.test.ts` | 5개 중 2 실패 | `C2-09` forwarded-host를 위조하니 400(공개 출처를 보지 않음) · `C2-06 ③` 저장 실패가 200(409가 아님) |
| `packages/platform/test/scanner-auth.test.ts` | 29개 중 1 실패 | `C2-09` forwarded-host를 위조하니 401(공개 출처를 보지 않음) |
| `services/ticket-svc/test/scanner-gate-regression.test.ts` | 15개 통과 | `I-T25 ①·②`는 기존 동작에 ID와 감사 기록 단언을 더한 것이라 구현 전에도 통과한다(뒤 변이로 잡히는지 본다) |
| `apps/scanner/test/live.test.ts` | 15개 통과 | `I-T23 ③`·`I-T24 ③`도 기존 동작에 ID만 더했다 |

### 통합(구현 전, 실제 PostgreSQL 18·Valkey 8.1)

`test-int/device-approval.int.test.ts` **14개 중 4 실패, 10 통과**.

| 시험 | 결과(까닭) |
| --- | --- |
| `C2-06 ①` | 실패: `save`가 `undefined`를 돌려주고 색인이 덮어써짐 |
| `C2-07 ①` | 실패: 첫 발급 뒤에도 `id:devauth`·`id:devcode`가 남음 |
| `C2-07 ②` | 실패: 동시 폴링 둘 다 토큰을 받음 |
| `I-T38 ④` | 실패: `DrizzleQueryError`의 `cause.code=23505`(`scanner_session_device_active_key`)가 그대로 올라옴. 500이 될 경로를 재현했고 시험이 기대하는 `APPROVAL_CONFLICT`가 아니다 |
| `I-T23`·`I-T24`·`I-T37`·`I-T38 ①~③` | 통과: 기존 동작에 ID를 붙였거나 기존 동작을 그대로 본다 |

### 판정

- 새 동작(C2-06·C2-07·C2-09·같은 기기 동시 승인)은 구현 전 트리에서 **값 단언으로 실패**했다(가져오기·문법 오류 아님).
- ID만 더한 시험은 구현 전에도 통과한다. 그 시험이 판정 기준을 실제로 잡는지는 `## 검증`의 틀린 구현 표본으로 본다.
- I-T24의 파트너 콘솔 해제 경로는 BAT-450B 몫이라 이 시험은 "배정이 REVOKED가 된 뒤"부터 본다.
- 구현 뒤 시험 두 곳의 기대값을 바로잡았다(역할 test 두 번째 커밋): `C2-07 ①`은 `clock.advance` 때문에 토큰 만료가 `NOW + 24시간`이 아니라 세션 행의 `expires_at`이고, `I-T38 ④`는 어댑터의 `ScannerSessionConflict`가 유스케이스에서 `APPROVAL_CONFLICT`로 사상된 값을 본다. 두 시험 모두 구현 전 트리에서 값 단언으로 실패하는 성질은 그대로다.

## 리뷰

리뷰 담당 `lane3-bat450a-review`(deepseek-v4.1-flash), 2026-11-22 12:21 KST. 받은 것은 `git diff aa66c0d2..16ef6a41`(계획·시험·구현)과 이 계획 파일이다. 코드·시험·계약·정본을 대조했고, 시험·Docker는 돌리지 않았다. 코드는 고치지 않았다.

결과: **높음 0, 중간 1(고침), 낮음 6(고침 1, 남은 위험 5)**. 보안 통제를 깨는 결함은 없고, C2-06·C2-07·C2-09와 동시 승인 경합의 고침 방향은 맞다.

| 번호 | 심각도 | 위치 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간 | `docs/api/openapi.yaml` 5929·4703 | 컨트롤러가 409 `user-code-unavailable`·409 `device-approval-conflict`를 내는데 두 경로의 `responses`에 409가 없다. 문제 유형 목록에만 있어 소비자가 이 응답을 계약으로 알 수 없다 | 두 경로에 `'409'` Problem 응답과 설명을 더하고 생성물을 다시 만든다 |
| RV-02 | 낮음 | `packages/platform/test/scanner-auth.test.ts` 324 | I-T25의 "gate_staff 토큰으로 gate_lead 전용 처리기를 부르면 403" 경로 시험이 ID 없이 있다. 이 묶음의 I-T25 ②는 OVERRIDE 한 작업만 본다 | 그 시험 이름에 `I-T25 ③`을 붙여 장부 범위의 근거를 넓힌다 |
| RV-03 | 낮음 | `apps/scanner/src/api/device-login.ts` 60~65 | 409 `user-code-unavailable`를 일반 `http` 오류로 내보낸다. 화면은 서버 제목("확인 코드를 새로 받아 주세요")을 보이고 다시 시작은 사용자가 한다. 충돌 확률(20^8)과 서버 5회 재시도를 생각하면 급하지 않다 | 후속: `code_unavailable` 코드를 두고 `useDeviceLogin`이 곧바로 새 승인을 시작하게 한다 |
| RV-04 | 낮음 | 이 파일 §6 I-T24, BUILD_ORDER 589 | I-T24의 "파트너 콘솔에서 배정 해제" 경로(`DELETE /v1/partner/staff/{assignmentId}`)는 BAT-450B 몫이다. 이 묶음은 배정이 REVOKED가 된 뒤의 서버 확인·세션 밖 기록·스캐너 종료를 본다 | GAT-220 단계 줄을 체크할 때 "해제 경로는 BAT-450B, 이 단계는 해제의 서버 확인"이라고 적는다. 체크하지 않는다면 그 이유로 적는다 |
| RV-05 | 낮음 | `services/identity-svc/src/modules/session/adapters/db/drizzle-staff-assignment-store.ts` 234~238 | `23505`를 모두 `ScannerSessionConflict`로 바꾼다. 지금은 두 활성 세션 유일 인덱스가 원인이지만, 기본키 중복 같은 다른 23505도 409로 숨는다 | `cause.constraint`가 `scanner_session_device_active_key`·`scanner_session_account_active_key`일 때만 409로 바꾸고 나머지는 그대로 던진다 |
| RV-06 | 낮음(남은 위험) | `packages/platform/src/request-url.ts`, `deploy/envs/local/demo/*` | `PEAKET_PUBLIC_ORIGIN`이 없으면 forwarded로 내려간다. 운영 배포 값에 이 값이 빠지면 C2-09의 방어가 꺼진다 | 운영 차트·환경 값에 값을 넣고, 비어 있으면 시작을 막는지는 BAT-450C/배포 묶음에서 정한다. 지금은 local 데모에만 넣었다 |
| RV-07 | 낮음(남은 위험) | `redis-device-authorizations.ts` POLL | 승인 레코드를 토큰 서명 전에 지운다. 서명기가 실패하면 그 기기 코드로는 다시 받을 수 없다 | 서명 실패는 서버 오류이고 5분짜리 일회용 코드라 새 승인이 안전하다. 정본 §6.1과 이 파일 §3에 적었다. 서명 전에 지우지 않고 '소비 중' 상태를 두는 안은 후속 |
| RV-08 | 낮음(남은 위험) | `memory-device-authorizations.ts` save | 메모리 저장소는 같은 기기 코드·같은 사용자 코드를 다시 저장하면 성공하지만 Redis는 `SET NX` 때문에 실패한다. 시작 경로는 항상 새 사용자 코드를 뽑아 차이가 드러나지 않는다 | 시험·로컬 전용 차이로 둔다. 운영은 Redis만 쓴다 |

### 확인한 것(지적 아님)

- C2-06: `SAVE`가 `SET NX`를 먼저 하고 실패하면 `HSET`을 하지 않는다. `StartDeviceAuthorization`은 기기 코드를 한 번 만들고 사용자 코드만 다섯 번까지 새로 뽑는다. 409 `user-code-unavailable`이 컨트롤러에 연결됐다.
- C2-07: `POLL`의 `APPROVED` 분기가 레코드와 `id:devcode:{userCode}`를 함께 지운다. 지운 뒤 같은 기기 코드는 `EXPIRED`다. 동시 폴링은 Lua 하나가 먼저 지우므로 토큰이 하나만 나온다.
- C2-09: 공개 출처가 있으면 `requestUrlOf`가 forwarded를 보지 않는다. identity 기기 승인·등록과 ticket `ScannerGuard`·기기 등록이 같은 공용 함수를 쓴다. `publicOriginFromEnv`는 경로·질의·조각·사용자 정보를 거절한다.
- 동시 승인: `createScannerSession`의 23505를 `ScannerSessionConflict`로 바꾸고 `DeviceApprovals`가 `APPROVAL_CONFLICT`로 사상한다. 실제 PostgreSQL 강제 충돌 시험이 409 사상을 본다.
- 시험이 약해지지 않았다: C2-06은 저장 반환·첫 레코드 보존·새 코드 재시도·409를, C2-07은 두 키 삭제·재폴링·동시 폴링을 값으로 본다. C2-09는 공개 출처가 forwarded를 이기는 경우와 지는 경우를 함께 본다.
- I-T23·I-T24·I-T25·I-T37·I-T38·I-T39는 이름만 붙인 시험과 새 시험이 섞여 있다. 새 동작이 아닌 항목은 `## 검증`의 틀린 구현 표본으로 판정 능력을 본다.

## 검증

검증 담당 `lane3-bat450a-verify`(deepseek-v4.1-flash), 2026-11-22 12:30~12:40 KST. 구현·시험·리뷰에 관여하지 않았다. 기준 커밋은 리뷰 반영 `e586894b`이고, 틀린 구현은 이 작업 폴더에서 하나씩 넣고 관련 시험만 돌린 뒤 `git checkout -- <파일>`로 되돌렸다(제품 파일 차이 없음). Docker 잠금은 12:29부터 `lane5-W12-merch-replay`가 잡고 있어 60초를 기다렸지만 비지 않았고, 그 잠금을 지우지 않았다. 그래서 이번 검증에서 Docker 시험은 새로 돌리지 못했다(아래 'Docker').

### 게이트(기준 커밋)

| 검사 | 결과 |
| --- | --- |
| identity-svc 단위 | 56파일 **688 통과** |
| ticket-svc 단위 | 28파일 **199 통과** |
| platform 단위 | 59파일 **703 통과** |
| scanner 단위 | **46 통과**(node --test) |
| api-client 단위 | 8파일 **113 통과** |
| identity test-int(구현 직후, RV-05 시험 추가 전) | **14 통과**(`test-int/device-approval.int.test.ts`) |
| typecheck | identity·ticket·platform 통과 |
| lint | 루트 `pnpm lint` 통과 |
| doc-check | 오류 0, 경고 4(기존 3 + mermaid 검사 건너뜀) |
| contracts `gen:check` | 생성물이 계약과 같다 |
| `ledger --batch BAT-450A --require` | 범위 6항목, 자동 시험 6, 빈칸·ID만·미검증·다른 단계 0 → 통과 |
| `ledger --scope "I-T23,I-T24,I-T25,I-T37,I-T38,I-T39"` | 자동 시험 6, 빈칸 0 |
| `trace-check --ids ...` | identity 4파일 38개·ticket 1파일 15개 보고서에서 I-T23 2·I-T24 1·I-T25 2·I-T37 2·I-T38 2·I-T39 2 통과, 대조 통과 |
| `roles-check --base origin/develop --head HEAD` | 이 검증 커밋 전 기준으로 담당 표의 review-fix 줄과 verify 커밋이 없어 실패(아래에서 채운다). 그 밖의 차례·꼬리말·시험 파일 위반은 없었다 |

### 틀린 구현 표본

각 판정 항목에 최소 하나씩, 새 동작(C2-06·C2-07·C2-09)에도 하나씩 넣었다. 9개 모두 **잡힘**.

| 번호 | 넣은 틀린 구현 | 잡은 시험 |
| --- | --- | --- |
| M1 | 메모리 `save`에서 사용자 코드 색인 충돌 검사를 뺀다 | C2-06 ① (1 실패) |
| M2 | 메모리 `notePoll`의 APPROVED 분기에서 `byHash`·`byUserCode` 삭제를 뺀다 | C2-07 ①·② (2 실패) |
| M3 | platform `requestUrlOf`가 `publicOrigin`을 무시하고 forwarded를 쓴다 | C2-09 (1 실패) |
| M4 | `inWindow`가 `validFromMs`를 보지 않는다 | I-T23 ① (1 실패) |
| M5 | `CheckScannerSession`이 `assignmentStatus === 'ASSIGNED'`를 보지 않는다 | I-T24 ① (1 실패) |
| M6 | `ScannerGate.scans`의 OVERRIDE 역할·대리 승인 검사를 없앤다 | I-T25 ① (1 실패) |
| M7 | 메모리 승인 한도를 10분 5회에서 6회로 늘린다 | I-T37 ② (1 실패) |
| M8 | 메모리 `createScannerSession`이 같은 기기의 이전 세션을 끝내지 않는다 | I-T38 ② (1 실패) |
| M9 | 현장 스태프 토큰에서 `cnf.jkt`를 뺀다 | I-T39 ② (1 실패) |

- I-T23·I-T24·I-T25·I-T37·I-T38·I-T39는 이름을 붙인 기존 시험과 새 시험이 섞여 있지만, 위 표본이 각 항목의 판정 기준을 실제로 잡는 것을 확인했다.
- C2-06·C2-07은 구현 전 실제 Valkey 시험에서도 실패를 봤고, 구현 뒤 같은 시험이 통과했다(C2-06 ①·C2-07 ①·②).
- 같은 기기 동시 승인은 구현 전 실제 PostgreSQL에서 `23505`가 그대로 올라와 실패했고, 구현 뒤 `APPROVAL_CONFLICT`로 통과했다.
- RV-05(기본키 23505를 409로 숨기지 않음) 시험은 Docker 잠금이 풀리지 않아 **실행하지 못했다**. 코드 대조로는 `scanner_session_pkey`가 두 유일 인덱스 목록에 없어 그대로 던져지는 것을 확인했다. 합치는 쪽이 Docker 잠금을 잡고 `test-int/device-approval.int.test.ts`를 한 번 돌려야 한다.

### Docker·브라우저

- Docker 잠금 `lane3-BAT-450A`는 12:07:38~12:07:55(구현 전 실패 확인), 12:13:01~12:13:24(구현 뒤 14/14)에 잡고 놓았다. 그 뒤 12:29부터 `lane5-W12-merch-replay`가 잡고 있어 RV-05 시험과 ticket-svc test-int는 돌리지 못했다.
- ticket-svc `test-int/scanner-shift.int.test.ts`는 시험 이름에 `I-T24 ②`를 붙인 것뿐이라 동작 변화가 없다. 그래도 합치기 전 Docker에서 한 번 돌리는 편이 좋다.
- 화면 변경은 없다(스캐너 앱 코드를 고치지 않았다). 브라우저 확인은 해당 없음.

### GAT-220 단계 줄 판정

**체크한다.** wbs 5.5.2의 문구(기기 승인 로그인·8자 코드·시도 제한, `cnf.jkt` 토큰, 세션 1개·교대·대리 승인, 해제의 서버 확인, SCR-036)를 모두 시험으로 확인했고, 장부 6항목이 자동 시험이며 `--require`가 통과한다. `wbs 5.5.2`의 SCR-037 불일치도 이 묶음에서 고쳤다.

- 파트너 콘솔에서 배정을 해제하는 **경로**(`DELETE /v1/partner/staff/{assignmentId}`)는 BAT-450B 몫이다. 이 단계의 "해제의 서버 확인"은 배정이 REVOKED가 된 뒤 `CheckScannerSession`이 무효를 돌려주고, 세션 밖 기록이 `OUT_OF_SESSION`으로 남고, `SESSION_TERMINATED`에서 스캐너가 로그아웃하는 것까지를 본다(I-T24 ①②③).
- mTLS `cnf.x5t#S256` 발급은 GAT-170의 관리형 기기·사설 CA PoC 뒤 선택 작업이고, 이 단계의 토큰은 `cnf.jkt`다. 휴대폰 카메라 승인 화면(SCR-051)은 wbs 5.5.3(GAT-230) 몫이다. 둘 다 이 단계 문구 밖이다.
- 남은 위험: RV-03(스캐너 앱이 409 `user-code-unavailable`를 자동 재시도하지 않고 일반 오류로 보인다), RV-06(운영 배포 값에 `PEAKET_PUBLIC_ORIGIN`이 빠지면 forwarded로 내려간다), RV-07(토큰 서명 전에 기기 코드를 지운다), RV-08(메모리·Redis 저장소의 같은 코드 재저장 차이), I-T25의 감사 기록은 `scan_event.staff_account_id`까지이고 별도 불변 감사는 BAT-450D다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane3-bat450a-plan | deepseek-v4.1-flash | 2026-11-22T12:00:00+09:00 | 2026-11-22T12:04:00+09:00 |
| test | lane3-bat450a-test | deepseek-v4.1-flash | 2026-11-22T12:05:00+09:00 | 2026-11-22T12:08:00+09:00 |
| impl | lane3-bat450a-impl | deepseek-v4.1-flash | 2026-11-22T12:09:00+09:00 | 2026-11-22T12:20:00+09:00 |
| review | lane3-bat450a-review | deepseek-v4.1-flash | 2026-11-22T12:21:00+09:00 | 2026-11-22T12:24:00+09:00 |
| test | lane3-bat450a-rv02 | deepseek-v4.1-flash | 2026-11-22T12:25:00+09:00 | 2026-11-22T12:26:00+09:00 |
| test | lane3-bat450a-rvtest | deepseek-v4.1-flash | 2026-11-22T12:27:00+09:00 | 2026-11-22T12:30:00+09:00 |
| impl | lane3-bat450a-rvimpl | deepseek-v4.1-flash | 2026-11-22T12:30:00+09:00 | 2026-11-22T12:31:00+09:00 |
| verify | lane3-bat450a-verify | deepseek-v4.1-flash | 2026-11-22T12:32:00+09:00 | 2026-11-22T12:40:00+09:00 |
