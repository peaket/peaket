# 작업 계획: W12-golden-report(검색 정답률 보고서 이름이 ASVS 요약과 겹침)

- **무엇**: 검색 골든 세트(기대 결과를 미리 정해 둔 검색어 100개 묶음) 시험이 남기는 정답률 보고서의 이름이 CI의 ASVS 요약 단계가 모으는 이름 꼴과 겹쳐, 그 단계가 끝 코드 2로 끝나고 요약이 통째로 빠진다. 보고서 이름만 바꾼다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-b171`(가지 `feature/lane2-W12-golden-report`, 출발점 `origin/develop` `d0a72e8a2`).
- **등급·차례**: C 묶음(ADR-0331 결정 4: 틀린 구현 검사와 구현 전 실패 확인을 하지 않는다). 정방향(구현 먼저, 아래 4): 계획 → 구현 → 시험 → 리뷰·검증. ADR 없음, 정본 고침 없음.
- **정본**: NFR-028(`docs/planning/02-requirements.md:189`), SR-T12(`docs/features/search.md:306`), ASVS 태그 리포트(`docs/architecture.md` §8.2 4번, BOT-162). 정본 어디에도 보고서 파일 이름은 없다(`docs/architecture.md:1004`·`docs/quality/quality-requirements.md:32`는 'CI 골든 세트 보고'라고만 쓴다). 그래서 정본은 고치지 않는다.

## 감독에게

1. **문제 설명 바로잡기**: ASVS 요약 단계는 `continue-on-error: true`(`.github/workflows/ci-node.yml:156`)라 그 단계의 끝 코드 2만으로 node 잡이 빨개지지는 않는다. 해는 둘이다. ① ASVS 요약 표가 작업 요약에서 통째로 빠진다. ② 그 단계에 `##[error] … exit code 2` 표시가 남아 진짜 실패 원인 찾기를 흐린다.
2. 실제로 node 잡을 빨갛게 한 것은 다른 시험이다(이 묶음 밖, 주인 갈래 몫).
   - develop `d0a72e8a2`(실행 44939357283): purchase-svc 통합.
   - `feature/lane1-BAT-215`(실행 44941441729): core-svc 단위 `test/search-bat166-page.test.ts` 'SR-T13 ①'.
   - `feature/lane2-W12-core-idem`(실행 44941146374): core-svc 통합 `idempotency-migration.int.test.ts` 'AZ-T17 ⑦'.
   - 세 실행 모두 ASVS 단계에 같은 `asvs-report: vitest JSON 보고서가 아니다(testResults 없음): services/core-svc/test-report-search-golden.json`이 찍혔다.

## 계획

### 1. 원인

- `services/core-svc/test/search-golden.test.ts:81`이 정답률 보고서(`{ cases, top1, top3, target, misses }`)를 `services/core-svc/test-report-search-golden.json`에 쓴다(BAT-165, `c4b0f4cf4` 2026-11-16부터).
- ASVS 요약 단계(`ci-node.yml:158`)는 `find services packages apps tools … -name 'test-report*.json' -o -name 'test-report*.xml'`로 시험 보고서를 모아 `tools/ci/asvs-report.mjs --report …`에 넘긴다. 읽개 `tools/ci/test-reports.mjs:25`는 `{`로 시작하는 파일을 vitest JSON으로 보고, `testResults`가 없으면 '보고서가 틀렸다'(끝 코드 2)로 멈춘다.
- 그 파일은 core-svc 단위 시험이 실제로 돌 때만 생긴다. turbo 캐시가 맞으면 되살리는 것이 `test-report.json`·`test-report.xml`뿐(`turbo.json` test `outputs`)이라 생기지 않는다. 그래서 core-svc를 건드린 실행에서만 드러났다.
- 지금 `.gitignore:2`의 `test-report*.json`이 이 파일을 무시해 줘 커밋에는 섞이지 않았다.
- **재현(계획 담당, 2026-11-22 이 폴더)**: 남아 있던 `services/core-svc/test-report-search-golden.json` 하나로 위 `find`가 그 파일만 찾았다. `node tools/ci/asvs-report.mjs --report services/core-svc/test-report-search-golden.json --scan services --scan packages --scan apps --scan tools --scan loadtest --summary <임시>` → exit 2, 같은 문구. 보고서 없이 같은 명령 → exit 0.

### 2. 고른 꼴과 까닭

| 꼴 | 판정 | 까닭 |
| --- | --- | --- |
| (가) 보고서 이름을 `search-golden-report.json`으로 바꾸고 `.gitignore`에 그 이름 한 줄 | **고름** | 고칠 곳이 시험 파일 한 줄·주석 한 줄과 `.gitignore` 한 줄이다. `test-report*` 이름 꼴은 'CI 보고서 설정이 남기는 vitest JSON·JUnit XML'이라는 약속(`ci-node.yml:5`, `packages/config/vitest/report.mjs`)으로 남고, 정답률 보고서는 그 약속 밖에 선다 |
| (나) 요약 단계 `find`를 좁힘(이름을 하나하나 적거나 골든 파일만 뺌) | 버림 | `.github/workflows/`를 바꾸면 그 몫만 따로 합쳐야 한다(ADR-0169 결정 4, 가지 규칙 검사). 이름을 하나하나 적으면 앞으로 더하는 보고서 이름(`test-report-build.xml` 같은)이 소리 없이 빠진다 |
| (다) `test-reports.mjs`가 `testResults` 없는 JSON을 건너뜀 | 버림 | 같은 읽개를 `trace-check.mjs`(§8.6 대조)가 쓴다. 틀린 보고서에서 끝 코드 2로 멈추는 것은 지킴 장치다. 건너뛰면 vitest 보고서가 깨져도 '미실행'으로만 보여 대조가 거짓으로 통과할 수 있다 |
| (라) 이미 무시되는 자리(`.cache/`·`dist/`·`node_modules/`)에 둠 | 버림 | `.gitignore` 없이 시험만 바꾸면 되지만 자리 뜻이 틀린다. `.cache/`는 로컬 클러스터 도구 자리(`.gitignore` 주석), `dist/`는 빌드 산출물이라 이미지·turbo 빌드 캐시에 시험 보고서가 섞일 수 있고, `node_modules/`는 설치가 지운다 |
| (마) 운영체제 임시 폴더에 씀 | 버림 | 로컬에서 정답률 보고를 찾기 어렵다. 정본이 'CI 골든 세트 보고'를 남기라고 한다 |

- 새 이름도 git이 무시해야 한다. 무시하지 않으면 시험을 돌린 뒤 추적 안 된 파일로 남아 남의 커밋에 섞일 수 있다. 또 turbo는 기본 입력(`$TURBO_DEFAULT$`)을 셀 때 `.gitignore`가 가린 파일을 빼므로, 무시해 두면 시험이 남긴 파일이 다음 실행의 캐시 열쇠에 들지 않는다.
- `.gitignore` 줄은 이름 하나만 적는다(`search-golden-report.json`). `*-report.json` 같은 넓은 꼴은 앞으로 커밋할 파일을 가릴 수 있어 쓰지 않는다. 지금 git이 추적하는 `*report*.json`은 없다(`git ls-files` 확인).

### 3. 손댈 파일과 담당

| 파일 | 할 일 | 담당 |
| --- | --- | --- |
| `.gitignore` | 시험 보고서 묶음(`:1-3`) 아래에 주석 한 줄과 `search-golden-report.json` 한 줄. 주석은 '검색 골든 세트 정답률 보고서(SR-T12). ASVS 태그 리포트가 모으는 `test-report*` 꼴과 겹치지 않게 따로 둔다' 뜻 | 구현 |
| `services/core-svc/test/search-golden.test.ts` | `:81` 쓰는 경로를 `../search-golden-report.json`으로. `:3` 주석의 파일 이름도 같이 바꾼다. 단언·계산은 바꾸지 않는다 | 시험 |

- 손대지 않는 것: 워크플로, `tools/ci/*`, `turbo.json`, 정본 문서. 시험 파일 밖에서 그 이름을 읽는 곳은 없다(저장소 찾기: 시험 파일 `:3`·`:81`과 `docs/review/plans/W12-core-rls.md:250` 기록 한 줄뿐, 기록은 고치지 않는다).
- 로컬 폴더의 묵은 파일: 이름을 바꾼 뒤에도 각 작업 폴더에 `services/core-svc/test-report-search-golden.json`이 남아 있으면 로컬에서 같은 요약 명령이 또 exit 2다. 시험 담당은 자기 폴더에서 `rm -f`로 지운다(git이 무시하는 파일이라 커밋 변화 없음). CI는 새로 받아 오고 turbo 캐시가 그 파일을 되살리지 않으므로 할 일이 없다.

### 4. 차례

- **정방향(`Batch-Order: impl-first`)**: 구현(`.gitignore`) 커밋이 먼저, 시험(이름 바꿈) 커밋이 뒤다.
- 까닭: 구현을 먼저 하면 어느 커밋에서든 시험이 남기는 파일을 git이 무시한다(옛 이름은 `test-report*.json`, 새 이름은 새 줄). 시험을 먼저 하면 그 사이 커밋에서 시험을 돌린 사람에게 추적 안 된 파일이 생긴다. C 묶음이라 구현 전 실패를 볼 일도 없다.
- 시험 쪽 커밋은 시험 파일과 문서만 바꾼다(정방향 규칙, `tools/ci/roles-check.mjs`). `.gitignore`는 구현 담당만 고친다.

### 5. 확인 명령

Git Bash, 저장소 뿌리에서. Docker는 쓰지 않는다.

```bash
# 0. 묵은 파일 지우기(git이 무시하는 파일)
rm -f services/core-svc/test-report-search-golden.json
# 1. 그 시험만, CI처럼 vitest JSON 보고서를 남기며
PEAKET_TEST_REPORT=test-report.json pnpm --filter @peaket/core-svc test test/search-golden.test.ts
# 2. 새 이름이 생기고 옛 이름은 없고, git이 새 이름을 무시한다
test -s services/core-svc/search-golden-report.json && test ! -e services/core-svc/test-report-search-golden.json && echo ok
git check-ignore -v services/core-svc/search-golden-report.json   # .gitignore의 새 줄이 나와야 한다
git status --porcelain -- services/core-svc | grep '^??'          # 빈 출력(추적 안 된 파일 없음)
# 3. ASVS 요약 단계 흉내(ci-node.yml:158과 같은 find)
set -- $(find services packages apps tools -path '*/node_modules' -prune -o \( -name 'test-report*.json' -o -name 'test-report*.xml' \) -print | sed 's/^/--report /')
echo "$@"   # --report services/core-svc/test-report.json 하나(골든 보고서 없음)
node tools/ci/asvs-report.mjs "$@" --scan services --scan packages --scan apps --scan tools --scan loadtest --summary "$(mktemp -d)/asvs-summary.md"; echo "exit=$?"   # 0. 2면 이 고침이 틀렸다
rm -f services/core-svc/test-report.json
# 4. 묶음 점검
pnpm exec eslint services/core-svc/test/search-golden.test.ts
pnpm exec turbo run typecheck --filter=@peaket/core-svc
python tools/doc-check/check_all.py   # 오류 0
node tools/ci/roles-check.mjs         # 묶음 W12-golden-report: 코드(정방향)
```

- **초안 PR CI 한 번**: 이 가지의 PR은 core-svc 시험 파일을 바꾸므로 core-svc 단위 시험이 캐시 없이 돌아 새 보고서가 실제로 생긴다. `node / node` 잡의 ASVS 태그 리포트 단계에 `asvs-report: … 보고서가 아니다` 줄과 `exit code 2`가 없고, 작업 요약에 ASVS 표가 나오는지 본다. 잡이 다른 시험(감독에게 2의 셋)으로 빨가면 그 시험 이름을 '검증'에 적고 이 묶음 몫이 아님을 밝힌다.

### 6. 틀린 구현 표본(리뷰가 볼 자리)

C 묶음이라 검증의 필수 검사는 아니다(ADR-0331 결정 4). 위 5의 명령이 셋 모두 잡는다.

| # | 틀린 구현 | 잡을 것 |
| --- | --- | --- |
| M1 | 주석(`:3`)만 바꾸고 쓰는 경로(`:81`)는 옛 이름 그대로 | 5의 2(옛 이름이 생김)·5의 3(exit 2) |
| M2 | 새 이름이 여전히 `test-report*.json` 꼴(예 `test-report.search-golden.json`) | 5의 3(`find`가 찾고 exit 2) |
| M3 | 이름은 바꿨으나 `.gitignore` 줄이 없거나 다른 이름(오타) | 5의 2(`git check-ignore` 실패, `git status`에 추적 안 된 파일) |

### 7. 범위 밖

- 골든 보고서를 CI 산출물로 올리기(워크플로 고침, ADR-0169 결정 4라 따로). 지금도 CI 기록에 `SR-T12 골든 세트: 1위 …% · 3위 안 …%` 한 줄이 찍힌다.
- 감독에게 2의 실패 시험 셋.

## 실패 확인

C 묶음이라 구현 전 실패 확인을 하지 않는다(ADR-0331 결정 2·4). 고치기 전 상태의 재현은 계획 담당이 위 1 '재현'에 적었다(요약 명령 exit 2).

## 구현

- `.gitignore` 시험 보고서 묶음(`:1-3`) 아래 `:4`에 주석 한 줄, `:5`에 `search-golden-report.json` 한 줄을 더했다(위 3 그대로). 다른 파일은 손대지 않았다.
- 확인(이 폴더): `git check-ignore -v services/core-svc/search-golden-report.json` → `.gitignore:5:search-golden-report.json`. `git ls-files`에 그 이름 없음. `python -I -X utf8 tools/doc-check/check_all.py` 오류 0.

## 시험 결과

- **바꾼 것**: `services/core-svc/test/search-golden.test.ts` `:81` 쓰는 경로를 `../search-golden-report.json`으로, `:3` 주석의 파일 이름도 같은 이름으로(위 3 그대로). 단언·계산·시험 이름은 그대로다. 이 폴더에 남아 있던 `services/core-svc/test-report-search-golden.json`은 `rm -f`로 지웠다(git이 무시하는 파일이라 커밋 변화 없음).
- **증명(위 5 차례대로, 이 폴더, 2026-11-22)**:
  - 5의 1: `PEAKET_TEST_REPORT=test-report.json pnpm --filter @peaket/core-svc test test/search-golden.test.ts` → 1개 통과, 기록 줄 `SR-T12 골든 세트: 1위 100% · 3위 안 100% (100개)`.
  - 5의 2: `services/core-svc/search-golden-report.json`이 생겼고(`cases` 100, `target` 0.9·0.98, `misses` 빈 목록) 옛 이름은 없다. `git check-ignore -v` → `.gitignore:5:search-golden-report.json`. `git status --porcelain -- services/core-svc`에 추적 안 된 파일 없음.
  - 5의 3: `ci-node.yml:158`과 같은 `find`가 찾은 것은 `--report services/core-svc/test-report.json` 하나다(골든 보고서 없음). `node tools/ci/asvs-report.mjs … --summary <임시>` → `exit=0`, 요약 '시험 보고서 1개를 읽었다'. 그 뒤 `test-report.json`은 지웠다.
  - 5의 4 일부: `pnpm exec turbo run typecheck --filter=@peaket/core-svc` 9개 성공, `pnpm lint` 끝 코드 0, `python -I -X utf8 tools/doc-check/check_all.py` 오류 0.
- **초안 PR**: 이 커밋을 올린 뒤 연다. CI 결과는 검증 담당이 '검증' 절에 적는다.

## 리뷰

- 담당 `lane2-w12golden-review`(claude-opus-5-5). 범위는 `dcdd806ab..3d7f09246`(구현 `b0a6b091b`, 시험 `3d7f09246`)이다. 코드·시험은 고치지 않았고 Docker도 쓰지 않았다.
- **막는 지적(높음·통과 기준)은 없다.** 대조한 것:
  1. **요약 단계와 겹침**: `ci-node.yml:158`의 `find -name`은 파일 이름이 `test-report`로 시작하는 것만 고른다. `search-golden-report.json`은 그 꼴이 아니다. 이 폴더에서 위 5의 1~3을 다시 돌렸다. 시험 1개 통과, 새 이름이 생기고 옛 이름은 없다. `find`는 `--report services/core-svc/test-report.json` 하나만 찾았고 `asvs-report.mjs`는 exit 0이다. 위 6의 M1~M3은 이 명령들이 잡는다.
  2. **`.gitignore` 새 줄**: 빗금이 없어 어느 폴더에서든 그 이름을 가린다(`git check-ignore -v`로 `apps/web/`·`docs/`·`services/core-svc/test/` 아래 같은 이름도 `.gitignore:5`에 걸리는 것을 봤다). 바로 위 `test-report*` 두 줄과 같은 꼴이다. git이 추적하는 같은 이름 파일은 없고, 무시된 같은 이름 파일은 시험이 만든 `services/core-svc/` 것뿐이다. 이름이 좁아 다른 파일을 숨길 걱정은 작다.
  3. **그 이름을 읽는 다른 곳**: `git grep`으로 찾은 새 이름은 `.gitignore:5`, 시험 `:3`·`:81`, 이 계획뿐이다. 워크플로·`tools/ci`·`turbo.json`(test `outputs`는 `test-report.json`·`.xml`만)에는 없다. 옛 이름은 기록에만 남는다(RG-01).
  4. **단언**: 시험 커밋은 `:3` 주석과 `:81` 쓰는 경로만 바꿨다. 문턱(`TOP1`·`TOP3`), 정답률 계산, `toHaveLength(CASES)`, 판정 `toEqual`, 시험 이름은 그대로다. 그래서 NFR-028 판정은 약해지지 않았다.
  5. **역할 경계·꼬리말**: 구현 `b0a6b091b`은 `.gitignore`와 이 파일만, 시험 `3d7f09246`은 시험 파일과 이 파일만 바꿨다. 세 커밋 모두 꼬리말 덩이를 갖췄고 세션 ID가 담당 표와 같다. 계획 커밋에 `Batch-Order: impl-first`가 있다. `node tools/ci/roles-check.mjs`의 실패는 'review·verify 커밋이 없다' 하나뿐이다(이 커밋과 검증이 채운다).
- 지적은 낮음 2이다. 이 묶음에서 고치지 않고 정리 목록으로 넘긴다(ADR-0283 결정 6, ADR-0331 결정 5).

| 번호 | 등급 | 자리 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RG-01 | 낮음 | `docs/review/measurements/W7-lane2-review-correctness.md:22`(W7L2-C8) | 위 3은 시험 파일 밖에서 옛 이름이 나오는 곳을 `W12-core-rls.md:250` 한 줄로 셌다. 그런데 W7L2-C8의 '고칠 방향' 칸도 `test-report-search-golden.json`의 `misses`를 나눠 세라고 적는다. 읽는 코드가 아니라 CI에는 해가 없지만, 그 지적을 이어받는 사람은 없는 파일을 찾게 된다 | 기록은 고치지 않는다. W7L2-C8을 맡는 묶음 계획에 새 이름 `search-golden-report.json`을 적는다 |
| RG-02 | 낮음 | 위 5의 4 첫 줄 `pnpm exec eslint services/core-svc/test/search-golden.test.ts` | 이 파일은 뿌리 ESLint 설정이 다루지 않아 '맞는 설정이 없어 무시함' 경고 하나만 내고 끝 코드 0이다(이 폴더에서 돌림). 그 줄은 아무것도 검사하지 않는데 점검 명령처럼 읽힌다 | 다음 계획부터 서비스 시험 파일의 점검은 typecheck 줄로 적고 이 eslint 줄은 뺀다 |

- **판정: 통과.** 막는 지적이 없으므로 검증으로 넘긴다. 초안 PR CI의 ASVS 단계(`exit code 2`가 없고 작업 요약에 표가 나오는지)는 검증 몫이다.

## 검증

(검증 담당이 채운다. 5의 명령 결과와 초안 PR CI 실행 번호)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane2-w12golden-plan | claude-opus-5-5 | 2026-11-22T04:55+09:00 | 2026-11-22T05:07+09:00 |
| impl | lane2-w12golden-impl | claude-opus-5-5 | 2026-11-22T05:06+09:00 | 2026-11-22T05:09+09:00 |
| test | lane2-w12golden-test | claude-opus-5-5 | 2026-11-22T05:08+09:00 | 2026-11-22T05:12+09:00 |
| review | lane2-w12golden-review | claude-opus-5-5 | 2026-11-22T05:12+09:00 | 2026-11-22T05:18+09:00 |

## 다음 단계

1. 구현 담당: `.gitignore` 한 줄(위 3) 커밋, 꼬리말 `Role: impl`·`Batch: W12-golden-report`. 담당 표에 impl 줄.
2. 시험 담당: 시험 파일 두 줄(위 3)과 묵은 로컬 파일 지우기, 5의 1~3을 돌려 '시험 결과'에 적고 커밋, `Role: test`. 담당 표에 test 줄.
3. 리뷰·검증 담당(서로 다른 세션): 5의 4와 초안 PR CI 한 번, 각자 '리뷰'·'검증' 절을 채워 커밋.
4. 감독: 초안 PR CI 확인 뒤 develop에 합친다.

- **다음 단계: 리뷰·검증 → 기록 → 합치기.** 구현(`b0a6b091b`, `.gitignore` 한 줄)과 시험(이름 바꿈, 위 '시험 결과')이 끝났다.
