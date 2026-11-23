# 작업 계획: FIX-problem-types — F-07-5가 들인 오류 이름 셋을 오류 유형 목록에 올린다

- **무엇**: `develop`에서 `pnpm --filter @peaket/platform test test/problem-types.test.ts`의 PRF192('서비스 코드의 이름 붙은 오류는 모두 목록에 있고 상태 코드와 제목이 같다')가 실패한다. 오류 유형 목록(`docs/api/openapi.yaml`의 `x-peaket-problem-types`, RFC 9457 오류 응답의 `type` 이름과 그 상태 코드·제목을 적은 표)에 없는 이름 셋 때문이다: `ops-svc approval-conflict`, `ops-svc settlement-adjustment-already-applied`, `ops-svc settlement-dependency-unavailable`. 이 묶음은 셋을 목록에 올리고, 같은 결함이 CI 캐시(앞 실행 결과를 다시 쓰는 저장소) 때문에 조용히 지나갈 수 있는 틈을 막는다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane5-FIX-problem-types`, 가지 `feature/lane5-FIX-problem-types`, 출발점 `origin/develop` `b20bdd44f`. 감독 요청. 세 이름은 F-07-5(`429a7ed61` 구현, `7216713c2` 리뷰 반영, 계획 `docs/review/plans/F-07-5.md` RV-04)에서 들어왔다.
- **정본**: 오류 이름 규칙 `docs/api/guidelines.md` §2('한 type은 언제나 같은 상태 코드와 같은 title', 목록에 없는 이름은 내지 않는다), 외부 호출 실패 표 §8.1의 'payment-svc 정산 이의 기각·수기 조정 등록·적용' 줄(ops가 503을 돌려준다, payment의 4xx는 그대로 전한다), 수기 조정 승인·반려 `docs/features/settlement.md` §4.3 '승인'(RV-04: 이미 적용된 조정의 반려는 409), 화면 문구 표 `docs/frontend.md` §5.12. 이 문서는 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **등급·차례**: C(오류 목록 세 줄과 생성물·빌드 설정 한 파일). 정방향(`Batch-Order: impl-first`): 계획 → 구현 → 시험 → 리뷰 → 검증 → 기록. 목록 세 줄은 정본이라 **이 계획 커밋에 넣었다**. 생성물(`packages/api-client/src/gen/problem-types.ts`)과 빌드 설정은 구현 몫이다. 서비스 코드는 고치지 않는다.

## 원인

**정본 목록이 코드를 따라가지 못한 문서 누락이다.** F-07-5가 ops-svc에 세 오류를 `ProblemError({ type, status, title })` 꼴로 더했는데 `docs/api/openapi.yaml` 오류 유형 목록에 올리지 않았다. 코드의 상태 코드·제목은 정본과 어긋나지 않는다(아래 '세 오류의 판단').

**CI가 못 잡은 것이 아니라, 잡은 빨간불이 가려졌다.** 감독 요청의 '범위 고르기 때문에 platform 단위 시험이 안 돌았다'는 사실과 다르다. `ci-node.yml`은 범위를 고른 실행에서도 `pnpm exec turbo run test --filter=@peaket/platform`을 늘 돈다(61~64줄).

| # | 사실 | 근거 |
| --- | --- | --- |
| ⑴ | F-07-5를 처음 담은 `develop` 실행이 PRF192로 빨갛다 | CI `45075864638`(`f0c0206da`, 푸시) `node / node` 실패, `Failed: @peaket/platform#test`, PRF192 × |
| ⑵ | 바로 다음 실행은 문서만 바뀐 커밋이라 `node` 잡을 건너뛰고 초록이다. 그래서 `develop` 최신 실행이 초록으로 보였다 | CI `45076136461`(`b433278c9`) `node` skipped, 실행 결과 success |
| ⑶ | 지금 머리도 같은 실패다 | CI `45084553792`(`b20bdd44f`) `node / node` 실패, PRF192 × |
| ⑷ | F-07-5 묶음의 게이트(묶음마다 도는 싼 검사)가 payment-svc·ops-svc 패키지만 돌고 platform 단위 시험을 돌리지 않았다 | `docs/review/plans/F-07-5.md` 검증 절의 명령 목록 |
| ⑸ | **숨은 틈**: 뿌리 `turbo.json`의 `test` 입력(캐시 열쇠를 만드는 파일 목록)은 패키지 자기 파일·`docs/api/**`·`tools/ci/service-openapi.mjs` 등이고 `services/*/src/**`가 없다. PRF192는 서비스 원본을 읽는데, 서비스 원본만 바뀌면 platform 시험의 캐시 열쇠가 그대로라 Turborepo가 앞 통과 결과를 되풀이해 보여 준다. 이번에는 F-07-5가 `docs/api/guidelines.md`도 고쳐 열쇠가 바뀌었기 때문에 시험이 실제로 돌아 ⑴에서 잡혔다 | `turbo.json` `tasks.test.inputs`, `git diff --stat 39785d9ec f0c0206da -- docs/api` = `guidelines.md` 3줄 |

- **CI 범위 판단**: ⑸는 파일 하나(`packages/platform/turbo.json`)로 막히므로 **이 묶음에서 함께 고친다**(고칠 곳 3). ⑵·⑷는 작업 절차 문제라 넘긴다('넘기는 것').

## 세 오류의 판단

`grep -rn` 결과(코드 `b20bdd44f`)와 정본·목록의 비슷한 항목을 견줬다. **셋 다 코드 그대로 목록에 올린다. 코드는 고치지 않는다.**

| 이름 | 코드가 던지는 곳 | status·title(코드 = 올린 값) | 판단 근거 |
| --- | --- | --- | --- |
| `approval-conflict` | `services/ops-svc/src/modules/approvals/application/settlement-adjustment-approvals.ts` 67줄 `CONFLICT()`(승인 `EXECUTING` 저장이 판 충돌로 실패, 반려 저장 충돌) | 409, '다른 사람이 먼저 처리했습니다' | 공통 승인 경로(`/v1/ops/approval-requests/{approvalId}/approvals`·`…/rejections`)의 오류다. 목록의 공통 승인 이름들(`approval-reason-required`·`approval-scope-invalid`·`approval-role-required`·`approval-self-not-allowed`)과 같은 `approval-` 꼴이고, 종류별 짝 `contract-approval-conflict`·`payout-approval-conflict`와 상태·제목이 같다. 정본(settlement §4.3)은 이름을 정하지 않고 '먼저 저장된 쪽만 남는다'만 정한다 |
| `settlement-adjustment-already-applied` | 같은 파일 210줄(`FAILED`·`EXECUTING` 승인 반려 때 payment `void`가 409 `settlement-adjustment-applied`를 주면 승인 업무를 `DONE`으로 맞춘 뒤) | 409, '조정이 이미 적용되어 반려할 수 없습니다' | settlement §4.3 '승인'의 '반려하지 않고 승인 업무를 `DONE`으로 맞춘 뒤 409를 돌려주고'와 같다. payment 쪽 `settlement-adjustment-applied`('이미 적용한 조정입니다', 적용·무효 요청이 거절됨)와 뜻이 달라(반려가 거절됨) 이름을 따로 둔다(PRF192 주석 '뜻이 다르면 이름을 따로 짓는다') |
| `settlement-dependency-unavailable` | `services/ops-svc/src/modules/payouts/adapters/payment-http.ts` 9줄(정산 이의 기각·수기 조정 경로에서 payment 5xx·시간 초과·연결 실패), `payouts/application/payout-approvals.ts` 275줄(정산 클라이언트가 조립되지 않음, `PayoutApprovalProblem` 꼴) | 503, '정산 서비스에 연결하지 못했습니다' | guidelines §8.1 'payment-svc 정산 이의 기각·수기 조정' 줄(ops가 503)과 같다. §8.1 머리 규칙('더 알맞은 오류가 있으면 서비스가 그것으로 바꾼다')대로 의존성별 이름을 쓰고, 같은 클라이언트의 지급 경로 이름 `payout-dependency-unavailable`('지급 서비스에 연결하지 못했습니다')과 같은 꼴이다. 두 자리의 상태·제목이 같다 |

- 목록에 넣은 자리: `approval-conflict`는 `approval-reason-required` 앞, 나머지 둘은 `settlement-commission-rate-invalid` 앞뒤(정산 이름 묶음 안). 이 커밋 뒤 PRF192는 통과한다(작성자가 `pnpm --filter @peaket/platform test test/problem-types.test.ts`로 2 통과를 봤다).

### F-07-5가 들인 다른 이름(확인만, 넘김)

PRF192는 `{ type: '…', status: …, title: '…' }` 객체 글자만 읽는다. payment-svc `SettlementProblem('이름', 상태, '제목')`, ops-svc `PayoutApprovalProblem`·`ContractApprovalProblem` 같은 **자리 인자 꼴은 읽지 않는다.** 그래서 감독이 물은 `settlement-adjustment-not-allowed`·`settlement-state-conflict` 등은 시험에 잡히지 않는다. 자리 인자 꼴을 일회용 스크립트로 모아 목록과 견준 결과(코드 `b20bdd44f`, v0-monolith 뺌):

| 묶음 | 결과 |
| --- | --- |
| F-07-5가 더한 이름(`450ab6cd7..b20bdd44f` 차이의 더한 줄) 중 목록에 있고 맞는 것 | `settlement-dispute-window-closed`(409 '이의 기간이 끝났습니다')·`settlement-not-disputable`(409) 둘 |
| F-07-5가 더한 이름 중 **목록에 없는 것** 13개 | `approval-not-pending`, `settlement-adjustment-applied`·`-approval-missing`·`-approval-reused`·`-dispute-mismatch`·`-not-allowed`·`-pending`·`-void`, `settlement-dispute-adjustment-required`, `settlement-dispute-not-open`, `settlement-not-disputed`, `settlement-not-reconfirmable`, `settlement-state-conflict` |
| 한 이름에 상태 코드 둘(guidelines §2 위반) | `settlement-adjustment-dispute-mismatch`가 요청 검사에서 422(정본 §4.3과 같음), 적용 때(`settlements.ts` '그 이의가 이미 닫혔거나 정산서가 이의 중이 아닙니다')에서 409다 |
| 한 이름에 제목 여럿 | `settlement-adjustment-not-allowed` 둘, `settlement-adjustment-dispute-mismatch` 일곱, `approval-role-required`(목록 'commander만 승인할 수 있습니다')에 'cs_lead만 정산서 조정을 요청할 수 있습니다' 등 셋, `dependency-unavailable`(목록 '의존 서비스를 잠시 쓸 수 없습니다')에 '조정 승인 기록을 확인할 수 없습니다' 등 둘 |
| 목록과 상태가 다른 것 | `invalid-query`를 422로 던지는 곳이 여럿(목록 400). F-07-5 몫은 조정 금액·근거 메모·판단 이유 넷이고 BAT-610 이전 것도 많다 |
| 저장소 전체(core-svc·ops-svc·payment-svc) | 자리 인자 꼴 166개 조합이 목록과 다르다(목록에 없는 이름 62개 조합 포함) |

- 이 이름들은 밖으로 나간다. ops-svc HTTP 클라이언트(`payment-http.ts` `#json`)가 payment의 4xx 종류를 그대로 관제 콘솔로 전하므로 guidelines §2대로 목록에 있어야 한다.
- **넘기는 까닭**: 166개 조합을 맞추려면 이름마다 '제목을 하나로 줄이고 사정은 `detail`로 옮길지', '`invalid-query` 422를 400으로 고칠지 다른 이름을 지을지'를 정본에 대어 정해야 하고, core-svc·payment-svc·ops-svc 코드와 화면 문구를 함께 고친다. 작은 고침 하나의 크기를 넘는다. 새 묶음(이름 예 `FIX-problem-ctor`)에서 ① PRF192가 자리 인자 꼴(`new XxxProblem('이름', 상태, '제목')`)도 읽게 하고 ② 위 표를 정본대로 맞춘다.

## 실패 확인

| 검사 | 결과 | 까닭 |
| --- | --- | --- |
| CI `45075864638`(`f0c0206da`)·`45084553792`(`b20bdd44f`) `node / node` | 실패, `Failed: @peaket/platform#test`(PRF192 ×) | 원인 ⑴·⑶ |
| 계획 작성자 로컬, `b20bdd44f` 트리(목록 고치기 전) `pnpm --filter @peaket/platform test test/problem-types.test.ts` | **1 실패·1 통과**, `missing`이 정확히 `ops-svc approval-conflict`·`ops-svc settlement-adjustment-already-applied`·`ops-svc settlement-dependency-unavailable` 셋 | 위 '세 오류' |
| 같은 명령, 목록 세 줄을 더한 트리 | 2 통과 | 이 계획 커밋이 PRF192를 닫는다 |
| `pnpm --filter @peaket/contracts gen:check`(목록 고친 뒤) | '생성물이 계약과 같다' | contracts 생성기는 오류 유형 목록을 읽지 않는다. **contracts gen 필요 없음** |
| `pnpm --filter @peaket/api-client gen:check`(목록 고친 뒤) | 실패, '다름: problem-types.ts' 1건 | api-client 생성기(`scripts/generate.mjs` 102줄)가 목록으로 `src/gen/problem-types.ts`를 만든다. **api-client gen 필요**(고칠 곳 1) |

시험 담당은 '시험 결과' 절에 ① 계획 커밋 앞 트리(`b20bdd44f`)의 PRF192 실패, ② 구현 뒤 통과, ③ 고칠 곳 3의 캐시 열쇠 확인을 적는다.

## 고칠 곳

| # | 파일 | 바꿀 것 | 담당 |
| --- | --- | --- | --- |
| 1 | `docs/api/openapi.yaml` `x-peaket-problem-types.types` | 세 줄 더함(위 '세 오류' 표의 값) | **계획(이 커밋, 끝남)** |
| 2 | `packages/api-client/src/gen/problem-types.ts` | `pnpm --filter @peaket/api-client gen`으로만 다시 만든다(손으로 고치지 않는다). 차이는 세 이름 줄뿐이어야 한다 | 구현 |
| 3 | `packages/platform/turbo.json`(새 파일) | `"extends": ["//"]`, `tasks.test.inputs`를 `["$TURBO_EXTENDS$", "$TURBO_ROOT$/services/*/src/**"]`로 둔다. `$TURBO_EXTENDS$`(배열 첫 칸에 두면 뿌리 값을 물려받은 채 뒤 값을 더하는 표시, 설치된 Turborepo 2.11.10의 패키지 설정 설명서 83~99줄)를 써서 뿌리 `turbo.json`의 입력 여덟 줄을 옮겨 적지 않는다. 같은 문제를 푼 앞 사례는 `services/purchase-svc/turbo.json`(의존 선언 밖 원본을 `typecheck` 입력에 더함)이다. `outputs`·`env`·`dependsOn`은 적지 않는다(물려받는다) | 구현 |

- 시험 이름(`PRF192_…`)과 시험 파일은 바꾸지 않는다. 서비스 코드·화면 코드는 고치지 않는다.
- 고칠 곳 3의 커밋은 `fix(ci): …` 또는 `build(platform): …`이고 끝 괄호에 `PRF192`를 단다.

## 확인 명령

```bash
pnpm --filter @peaket/platform test test/problem-types.test.ts          # PRF192 포함 2 통과
pnpm --filter @peaket/contracts gen:check                                # 같다
pnpm --filter @peaket/api-client gen:check                               # 구현 뒤 같다
pnpm --filter @peaket/api-client test                                    # 화면 생성물이 계약과 같다
pnpm --filter @peaket/platform test                                      # platform 단위 시험 전체(회귀)
# 고칠 곳 3: 서비스 원본만 바꿨을 때 platform 시험의 캐시 열쇠가 바뀌는가(--dry=json은 아무것도 돌리지 않는다)
pnpm exec turbo run test --filter=@peaket/platform --dry=json > /tmp/a.json
#   services/ops-svc/src 아래 파일 끝에 주석 한 줄을 잠시 더한 뒤 같은 명령으로 b.json, 그다음 손으로 되돌린다
#   두 파일의 tasks[@peaket/platform#test].hash가 달라야 한다(고치기 전 트리에서는 같다)
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
```

- 통과 기준: PRF192 통과, 두 `gen:check` 같음, api-client·platform 단위 시험 실패 0, 고칠 곳 3 뒤 캐시 열쇠가 서비스 원본 변경으로 바뀜(고치기 전에는 그대로), lint 0, doc-check 오류 0, roles-check 통과. Docker는 필요 없다.

## 틀린 구현 표본(검증 담당용)

| # | 넣을 틀린 것 | 잡을 검사 |
| --- | --- | --- |
| S1 | 목록에서 `settlement-dependency-unavailable` 줄을 뺀다 | PRF192 `missing`에 `ops-svc settlement-dependency-unavailable`, api-client `gen:check` 다름 |
| S2 | 목록의 `approval-conflict` 상태를 422로 바꾼다 | PRF192 `status` 단언 실패(`409≠422`) |
| S3 | 목록의 `settlement-adjustment-already-applied` 제목을 한 글자 바꾼다 | PRF192 `titles` 단언 실패 |
| S4 | api-client 생성물에서 세 줄 중 하나를 손으로 지운다 | `pnpm --filter @peaket/api-client gen:check` 실패 |
| S5 | `packages/platform/turbo.json`의 `$TURBO_ROOT$/services/*/src/**` 줄을 뺀다 | 확인 명령의 `--dry=json` 두 번의 platform 시험 열쇠가 같아진다 |
| S6 | `packages/platform/turbo.json`의 `$TURBO_EXTENDS$`를 뺀다(뿌리 입력이 사라짐) | `docs/api/openapi.yaml`만 바꿨을 때 `--dry=json` 열쇠가 같아진다 |

## 넘기는 것

- **자리 인자 꼴 오류의 목록 대조**(위 'F-07-5가 들인 다른 이름'): PRF192 확장과 166개 조합 정리. 새 FIX 묶음. F-07-5 몫 13개 이름·`settlement-adjustment-dispute-mismatch` 상태 둘이 가장 급하다(정산 2인 승인 화면 문구가 이 이름으로 갈린다).
- **가려진 빨간불(원인 ⑵)**: 문서만 바뀐 푸시가 `node` 잡을 건너뛰어 최신 실행이 초록으로 보인다. 감독이 `develop` 상태를 볼 때 '코드를 바꾼 마지막 실행의 `node` 잡'을 보는 규칙이 필요하다. 절차 문서(`docs/architecture.md` §8.6) 몫이라 감독에게 넘긴다.
- **묶음 게이트(원인 ⑷)**: 서비스에 이름 붙은 오류를 더하는 묶음은 게이트에 `pnpm --filter @peaket/platform test test/problem-types.test.ts`를 넣는다. 같은 §8.6 몫.
- **다른 흔들림**: CI `45084553792`의 platform 시험에는 `test/control-log-sampling.test.ts` C-T75 ② 5초 시간 초과도 있었다. 로컬(한가한 기계)에서는 8 통과다. 이 묶음 밖이다.
- 새 시험 ID·BUILD_ORDER 단계·wbs 상태 변화는 없다.

## 시험 결과

(시험 담당이 채운다)

## 리뷰

(리뷰 담당이 채운다)

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane5-fixpt-plan | claude-opus-5-5 | 2026-11-23T08:40:00+09:00 | 2026-11-23T09:10:00+09:00 |
| impl | | | | |
| test | | | | |
| review | | | | |
| verify | | | | |
