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

시험 담당(`lane5-fixpt-test`)이 2026-11-23 09:08~09:15에 계획의 확인 명령대로 돌렸다. 시험 파일은 새로 쓰지 않았다(PRF192 시험이 이미 있고, 고칠 곳 3은 `--dry=json` 대조로 본다는 것이 계획의 요구다).

| # | 검사 | 트리 | 결과 |
| --- | --- | --- | --- |
| ① | `pnpm --filter @peaket/platform test test/problem-types.test.ts` | 바탕 `b20bdd44f`(작업 트리를 건드리지 않게 `git worktree add --detach D:/l5ptpre b20bdd44f` 뒤 `corepack pnpm install --frozen-lockfile`) | **1 실패·1 통과**. PRF192 `missing`이 정확히 `ops-svc approval-conflict`·`ops-svc settlement-adjustment-already-applied`·`ops-svc settlement-dependency-unavailable` 셋(`problem-types.test.ts:180`, `expect(missing).toEqual([])`). 바탕과 구현 트리는 PRF192가 읽는 파일 중 `docs/api/openapi.yaml`만 다르다(`git diff --stat b20bdd44f 43117aeac`) |
| ② | 같은 명령 | 구현 `43117aeac` | 2 통과 |
| ② | `pnpm --filter @peaket/platform test`(전체) | 구현 | 65 파일·773 시험 통과, 실패 0 |
| ② | `pnpm --filter @peaket/contracts gen:check` | 구현 | '생성물이 계약과 같다' |
| ② | `pnpm --filter @peaket/api-client gen:check` | 구현 | '생성물이 계약과 같다' |
| ② | `pnpm --filter @peaket/api-client test` | 구현 | 9 파일·116 시험 통과 |
| ③ | `pnpm exec turbo run test --filter=@peaket/platform --dry=json`의 `@peaket/platform#test` `hash`, `services/ops-svc/src/modules/payouts/adapters/payment-http.ts` 끝에 주석 한 줄을 더하기 전·후(복사본으로 되돌림, `git status` 깨끗함) | 구현 | `53573b99dd6947aa` → `ea786cbff6e8da30` **바뀜**. 입력 목록에 `../../services/ops-svc/src/**` 파일이 들어 있다 |
| ③ | 같은 대조 | 바탕(`packages/platform/turbo.json` 없음) | `c50a5f3fff1544c0` → `c50a5f3fff1544c0` **그대로**. 입력 목록에 서비스 원본이 없다 |
| ③ | 같은 대조, `docs/api/openapi.yaml` 끝에 주석 한 줄(뿌리 입력을 물려받는지, 표본 S6) | 구현 | `53573b99dd6947aa` → `e79e2715a13e2bf9` 바뀜 |

- 판정: 바탕에서 세 이름으로 실패하고 구현 뒤 통과한다. 고칠 곳 3 뒤 서비스 원본만 바꿔도 platform 시험의 캐시 열쇠가 바뀌고, 고치기 전에는 그대로다. `$TURBO_EXTENDS$`로 뿌리 입력도 남아 있다.
- 임시 작업 폴더는 `git worktree remove --force`로 등록을 지웠다. `D:/l5ptpre` 폴더에 설치 찌꺼기(`node_modules` 등)가 남았는데 지우는 명령이 안전 검사에 막혔다. 소유자가 손으로 지운다.

## 리뷰

리뷰 담당(`lane5-fixpt-review`)이 2026-11-23 09:17~09:25에 `git diff b20bdd44f..f74ea124a`와 정본을 대조했다. 코드·시험은 고치지 않았다. **높음·중간 지적은 없다.**

### 지적

| # | 등급 | 자리 | 내용 | 제안 |
| --- | --- | --- | --- | --- |
| RV-01 | 낮음 | 계획 `be0ac7ab5`·구현 `43117aeac` 커밋 제목 끝 괄호, 이 문서 '고칠 곳' 셋째 줄 아래 문장 | 끝 괄호 ID가 `PRF192`(붙임표 없음)다. 시험 `f74ea124a`와 이 리뷰 커밋은 `PRF-192`라 한 가지 안에서 꼴이 갈린다. 장부·대조 스크립트는 요구사항 ID 꼴(`PRF-192`)로 찾고, `PRF192`는 시험 이름 머리(`PRF192_…`)다 | 이미 쌓인 커밋은 고치지 않는다(강제 푸시 금지). 검증·기록 커밋과 변경 요약 줄은 `PRF-192`로 적는다 |
| RV-02 | 정보 | `packages/platform/turbo.json` | 새 파일이 `@peaket/platform#build`의 입력(`turbo.json`, `--dry=json`으로 확인)이 되어 이 커밋 뒤 첫 실행에서 platform build와 그에 기대는 모든 작업 공간의 캐시가 한 번 빗나간다. 또 `services/*/src/**`라 v0-monolith·bundle을 포함한 어느 서비스 원본이 바뀌어도 platform 시험 전체가 실제로 돈다 | 한 번뿐이고 의도한 값이라 고칠 것 없다. 덤으로 서비스 원본을 읽는 `metric-rules.test.ts`·`grpc-server.test.ts`의 같은 캐시 틈도 함께 막혔다 |
| RV-03 | 정보 | `services/ops-svc/src/modules/payouts/adapters/payment-http.ts` 9줄 | `settlement-dependency-unavailable` 503은 `Retry-After`를 싣지 않는다. guidelines §2의 `Retry-After` 필수는 차단기가 열렸거나 게이트웨이 과부하일 때라 이 5xx·시간 초과 전달에는 걸리지 않고, 같은 클라이언트의 `payout-dependency-unavailable`도 같다 | 이 묶음 밖. '넘기는 것'의 `FIX-problem-ctor` 묶음이 의존성 503을 정리할 때 함께 본다 |

### 확인한 것

- **세 이름의 status·title이 던지는 자리 모두와 같다.** `grep -rnE "(approval-conflict|settlement-adjustment-already-applied|settlement-dependency-unavailable)['\"]"`(services·apps·packages·docs, 생성물·dist 뺌)로 원본 자리 넷: `approval-conflict` 409 `settlement-adjustment-approvals.ts:67`, `settlement-adjustment-already-applied` 409 같은 파일 210, `settlement-dependency-unavailable` 503 `payment-http.ts:9`·`payout-approvals.ts:275`(자리 인자 꼴, PRF192는 못 읽지만 값은 같다). ops-svc 시험의 가짜 오류 다섯 자리(`settlement-adjustment-approval.test.ts`·`settlement-dispute-dismissal.test.ts`·`settlement-flow-support.ts`)도 같은 값이다. 화면 코드는 셋 중 어느 이름도 아직 쓰지 않는다.
- **이름 꼴이 이웃과 같다.** `approval-conflict`는 공통 승인 경로 이름(`approval-reason-required` 등)과 같은 `approval-` 머리이고 종류별 짝(`contract-`·`payout-`·`device-approval-conflict`)과 상태·제목이 같다. `settlement-dependency-unavailable`은 `payout-dependency-unavailable`과 같은 '<의존성>-dependency-unavailable' 꼴이고 제목도 같은 틀이다. `settlement-adjustment-already-applied`는 payment의 `settlement-adjustment-applied`와 뜻이 달라(반려가 거절됨) 이름을 나눈 것이 guidelines §2 '한 type은 한 상태·한 제목'에 맞다. 목록 넣은 자리는 알파벳 차례를 지킨다(`approval-conflict` < `approval-reason-required`, `settlement-adjustment-already-applied` < `settlement-commission-rate-invalid` < `settlement-dependency-unavailable` < `settlement-dispute-window-closed`).
- **정본과 어긋나지 않는다.** guidelines §8.1 'payment-svc 정산 이의 기각·수기 조정 등록·적용' 줄(ops가 503, payment 4xx는 그대로)과 §2 '더 알맞은 오류가 있으면 그것으로 바꾼다'에 맞고, settlement §4.3 '승인'의 이미 적용된 조정 반려 409와 같다.
- **생성물은 생성기로만 바뀌었다.** `pnpm --filter @peaket/api-client gen:check` = '생성물이 계약과 같다'. 차이는 `ProblemType` 합 세 줄과 `PROBLEM_TYPES` 세 줄뿐이고 값이 openapi와 같다.
- **`packages/platform/turbo.json`은 뿌리 입력을 지우지 않고 더하기만 한다.** `--dry=json`의 `@peaket/platform#test` 풀린 입력이 뿌리의 일곱 경로 + `../../services/*/src/**`이고 패키지 자기 파일(`src/` 76·`test/` 68)도 그대로 들어 있다(`$TURBO_DEFAULT$` 물려받음). `outputs`·`env`·`dependsOn`도 뿌리 값 그대로다. 해시 `53573b99dd6947aa`가 시험 결과 ③과 같다. 모양은 앞 사례 `services/purchase-svc/turbo.json`과 같다.
- **다른 패키지 test 캐시의 정의는 바뀌지 않는다.** 패키지 `turbo.json`은 그 패키지 작업에만 붙는다(위 RV-02의 한 번 빗나감 말고는 영향 없음). `contract-sweep.test.ts`가 읽는 `packages/contracts/src/gen/`는 platform의 의존 선언(`@peaket/contracts`)으로 해시가 따라가 틈이 없다.
- **구현 커밋은 시험 파일을 건드리지 않았다.** `43117aeac`은 `packages/api-client/src/gen/problem-types.ts`·`packages/platform/turbo.json` 둘뿐이고, 시험 커밋 `f74ea124a`은 이 문서만 고쳤다. 서비스·화면 코드 변경은 없다.

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane5-fixpt-plan | claude-opus-5-5 | 2026-11-23T08:40:00+09:00 | 2026-11-23T09:10:00+09:00 |
| impl | | | | |
| test | lane5-fixpt-test | claude-opus-5-5 | 2026-11-23T09:08:00+09:00 | 2026-11-23T09:16:00+09:00 |
| review | lane5-fixpt-review | claude-opus-5-5 | 2026-11-23T09:17:00+09:00 | 2026-11-23T09:25:00+09:00 |
| verify | | | | |
