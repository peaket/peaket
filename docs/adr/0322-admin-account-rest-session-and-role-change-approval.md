# ADR-0322: 관제 관리 계정 REST·세션 강제 종료·commander 역할 변경 승인·위험 명령 재인증(2026-11-20)

- **상태**: 채택(2026-11-20, 감독 승인). 갈래 3 BAT-045 계획 담당이 감독에게 1·5·7을 올렸고, 감독이 BOT-152의 서버 몫과 권한 변경 승인을 이 묶음에 두며, 초대 수락·SCR-064 화면은 BAT-046으로 나누는 것을 승인했다.
- **관련**: [docs/features/identity.md](../features/identity.md) §6·§12·§13, [docs/features/control-tower.md](../features/control-tower.md) §3·§4·§7·§12·§13, [docs/security/authz-matrix.md](../security/authz-matrix.md) §6·§6.1, [docs/data.md](../data.md) `approval_request`·`approval_vote`, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/ops/admin-accounts*`·`/v1/ops/approval-requests*`·`/v1/ops/commands*`, [docs/api/proto/peaket/identity/v1/identity.proto](../api/proto/peaket/identity/v1/identity.proto) `AdminAccountService`·`AdminSessionService`, [ADR-0062](0062-open-items-delegated-decisions.md), [ADR-0065](0065-web-frontend-security-after-asvs-v3.md), [ADR-0095](0095-sale-pause-single-commander-and-two-person-approval-demo.md), [ADR-0143](0143-settings-commands-pg-switch-over-grpc-applied-version-outbox.md), [ADR-0171](0171-post-sale-forensics-in-launch-scope.md), [ADR-0172](0172-judge-roles-per-request-not-in-tokens.md), [ADR-0206](0206-admin-passkey-step-up.md)
- **관련 ID**: I-T53 ②③⑤, I-T61 ①~④, AZ-T14 ①~⑥, C-T69, ASVS v5.0.0-7.4.5·7.5.1·8.2.1·8.2.2·8.2.3·9.2.2, BUILD_ORDER BOT-152·BOT-140

## 맥락

- identity에는 관리 계정 관리 gRPC(`AdminAccountService`·`AdminDesignationService`)와 세션 강제 종료 proto(`AdminSessionService`)가 있으나, ops-svc에는 관리 계정 REST·승인 업무 모듈·세션 강제 종료 받는 층이 없었다. `GET /v1/ops/auth/sessions/me`도 계약·라우트만 있었다.
- identity 관리 계정 초대 수락 경로(비밀번호·TOTP·패스키 등록)와 SCR-064 화면은 아직 없다. 이 묶음에 넣으면 1일 이상 더 들고, 화면은 갈래 2 몫이다.
- ops-svc 명령 컨트롤러는 `X-Reauth-Token`을 받지 않았다. 2인 승인 명령과 멈추는 쪽 명령이 재인증 없이 만들어질 수 있었다.
- 지급 승인은 이미 `/v1/ops/approval-requests*` 경로를 썼다. 같은 경로에 두 번째 컨트롤러를 두면 Fastify가 라우트 충돌로 시작하지 않는다.

## 결정

1. **서버 REST만 이 묶음에서 끝낸다**: `GET·POST /v1/ops/admin-accounts`, `GET …/{id}`(ETag), `PUT …/{id}/role`(If-Match, 202 승인), `POST …/{id}/invitation`, `POST …/{id}/removal`, `POST·DELETE …/{id}/designations*`, `DELETE …/{id}/sessions`·`…/sessions/{sessionId}`, `GET …/{id}/permission-changes`, `GET /v1/ops/auth/sessions/me`를 ops-svc에 둔다. 역할·대상 조건·Problem type은 openapi와 authz-matrix §6.1 그대로이고 새 경로·type을 만들지 않는다. 초대 수락과 SCR-064는 BAT-046 후보로 남기고 BOT-152 줄은 '끝'으로 체크하지 않는다.
2. **재인증**: 초대·역할 변경·재초대·삭제·지정·지정 거두기는 `X-Reauth-Token`(관리 키 셋, `aud=ops`, 그 세션 `sid`, `act=PERMISSION_CHANGE`, `factors`에 `passkey`)이 필요하다. 세션 강제 종료는 끊는 쪽의 안전 조치라 재인증 없이 받는다. 위험 명령(2인 승인 명령, `KILL_SWITCH`·`AUTOMATION_STOP`)의 접수·승인·재시도는 `act=OPS_COMMAND` 토큰이 필요하다. 토큰이 없거나 틀리면 403 `reauth-required`, 확인기·jti 저장소 장애는 503 `reauth-unavailable`(Retry-After 5초 [가정])이고 명령·승인·감사 기록을 쓰지 않는다. `jti`는 한 번만 쓴다.
3. **commander 역할 변경의 2인 승인**: commander가 되거나 commander에서 내려가는 변경은 ops-svc가 `COMMANDER_ROLE_CHANGE` 승인 업무를 만들고 202와 `ApprovalRequest`를 준다. 요청자가 아닌 commander가 `POST /v1/ops/approval-requests/{approvalId}/approvals`를 `act=APPROVAL`·패스키 재인증으로 승인하면 그때 identity `ChangeAdminRole`을 `approval_id`와 함께 부르고, 승인 뒤에도 저장한 판(If-Match)을 다시 본다. 요청자 본인 승인 403, commander가 아닌 승인 403, 요청 뒤 5영업일 [가정] 만료 409다. 다른 승인 업무 종류는 이 묶음에서 만들지 않는다.
4. **세션 강제 종료**: identity `AdminSessionService.TerminateAdminSessions`가 `request_id`(ops 감사 요청 ID)로 멱등이고, 계정의 모든 세션 또는 하나를 끝내며, 끝낸 세션마다 `control.sessions-terminated(reason ADMIN_FORCE)`를 낸다. 다른 계정의 세션 ID·없는 세션은 404, 이미 끝난 세션은 `already_done`·204다. 계정 상태는 바꾸지 않는다. identity `admin_account_request.kind`에 `TERMINATE_SESSIONS`를 더한다(마이그레이션 identity 0035).
5. **감사와 권한 변경 내역**: 초대·재초대·역할 변경·지정·지정 거두기·삭제·세션 강제 종료를 ops 감사 체인에 `ADMIN_ACCOUNT_*` 기록으로 남긴다. 요청 전 `REQUESTED`, identity 성공 뒤 `SUCCEEDED`, 실패 뒤 `FAILED`를 남기고, 권한 변경 내역은 `SUCCEEDED`만 최근 순으로 준다. 요청자·승인자는 관리 계정 ID·역할로 싣고 이메일 원문은 싣지 않는다. 3년 보관을 전제로 한다. 같은 `Idempotency-Key`의 두 번째 요청은 감사 기록을 두 번 남기지 않는다.
6. **저장소**: ops 마이그레이션 0019에 `approval_request`(kind CHECK는 `COMMANDER_ROLE_CHANGE`만), `approval_vote`, `audit_chain(record_id, seq desc)` 색인을 둔다. `due_at`은 5영업일 [가정]을 ops-svc가 계산해 넣는다. 승인 때 다시 볼 `target_version`과 권한 변경 내역의 `from_role`은 구현에 필요한 칸으로 더한다.
7. **통합 승인함**: `/v1/ops/approval-requests*`는 지급 묶음(`PAYOUT_BATCH`)과 관리 계정 역할 변경(`COMMANDER_ROLE_CHANGE`)을 같은 경로에서 보여 주고, 승인·반려는 종류에 따라 알맞은 유스케이스로 넘긴다. PayoutsModule은 `PayoutApprovals`를 전역으로 내보내고, 새 승인 컨트롤러가 두 종류를 합친다.
8. **시작 조립**: ops-svc는 기존 identity gRPC 주소로 관리 계정·지정·세션 클라이언트를 만든다. `PEAKET_IDENTITY_JWKS_URL`이 없으면 재인증이 필요한 쓰기는 503이고, local·ci는 메모리 저장소, 그 밖에 Redis가 없으면 닫힌 jti 저장소다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 이 묶음은 서버 REST·세션·승인·감사, 초대 수락·SCR-064는 BAT-046(이 결정) | 4.5일 안에 끝나고 계약·시험이 이미 있다 | BOT-152가 한 묶음으로 끝나지 않는다 | 고른다 |
| B. 초대 수락·화면까지 한 묶음에 넣는다 | 한 번에 끝난다 | identity 받는 층과 화면이 없어 1일 이상 더 들고, 화면은 갈래 2 몫이다 | BAT-046 |
| C. 승인 업무를 지급 승인 모듈에 합친다 | 새 모듈이 없다 | 지급 저장소·상태와 섞이고 data.md의 `approval_request`와 다른 표가 된다 | 쓰지 않는다 |
| D. 관리 계정 쓰기에 재인증을 걸지 않는다 | 호출이 단순하다 | 권한을 넓히는 쓰기가 탈취된 세션 하나로 가능하다(ASVS 7.5.1·9.2.2) | 쓰지 않는다 |
| E. 공통 승인함을 두지 않고 역할 변경 전용 경로를 만든다 | 라우트 충돌이 없다 | openapi에 없는 새 경로·type이 생긴다 | 쓰지 않는다. 기존 경로에 종류를 더한다 |

## 결과

- 관리 계정 화면(SCR-064)이 기대는 서버 경로가 모두 있고, commander 역할 변경은 2인 승인과 감사 기록을 거친다. 위험 명령은 재인증 없이 만들어지지 않는다.
- 대가: ops 마이그레이션 0019, identity 0035, ops-svc 관리 계정·승인 모듈, identity 세션 종료 받는 층, 명령 컨트롤러 재인증 검사가 는다.
- 남는 한계: 관리 계정 초대 수락 경로, SCR-064 화면, 일반 승인 업무(환불·지급·수사기관 자료 등), OPS-260의 dry-run 비교, AWS 자원은 다른 묶음·소유자 몫이다.

## 되돌릴 조건

- 역할 변경 승인이 운영에서 병목이 되면 `COMMANDER_ROLE_CHANGE`의 승인자 조건(다른 commander 1인)과 기한을 다시 본다.
- 통합 승인함이 종류별 화면 요구를 감당하지 못하면 `/v1/ops/approval-requests`에 `kind` 필터를 더한다(새 경로는 만들지 않는다).
- 세션 강제 종료가 잦아 감사 체인 부하가 문제가 되면 기록 묶음(한 요청에 세션 여럿)을 한 기록으로 줄인다.
