# Tasks

## 1. 패키지 뼈대와 시험 도구

- [x] 1.1 `packages/contracts`의 `package.json`(`@peaket/contracts`, 게시하지 않음, 실행 의존성 `zod`), `tsconfig.json`, `vitest.config.mjs`를 만들고 의존성을 설치한다(design.md 결정 5·7). 확인: `pnpm install`이 공급망 설정을 바꾸지 않고 끝나고, 빈 시험 묶음으로 `pnpm --filter @peaket/contracts test`가 돈다.
- [x] 1.2 Turborepo `test` 작업과 뿌리 `pnpm test`를 둔다. 확인: `pnpm test`가 지금 있는 패키지의 시험을 모두 돌리고 통과한다.

## 2. AsyncAPI 변환기(결정 3)

- [x] 2.1 변환기 시험을 먼저 쓴다(결정 8의 경우). 확인: 변환기가 없어 시험이 실패한다.
- [x] 2.2 변환기를 만든다. 확인: 같은 시험이 통과한다.

## 3. 차이 검사(결정 4)

- [x] 3.1 차이 검사 시험을 먼저 쓴다. 확인: 검사 모듈이 없어 실패한다.
- [x] 3.2 차이 검사를 만든다. 확인: 같은 시험이 통과한다.

## 4. 생성과 계약 고침

- [x] 4.1 생성 스키마 시험과 '생성물이 계약과 같다' 시험을 먼저 쓴다. 확인: 생성물이 없어 실패한다.
- [x] 4.2 생성 스크립트(`gen`, `gen:check`)를 만들고 계약 원본으로 돌린다. 확인: orval이 계약의 규격 위반 셋으로 생성을 거부한다(결정 6의 재현).
- [x] 4.3 `docs/api/openapi.yaml`의 규격 위반 셋을 고친다(뜻은 설명으로 옮김). 확인: `gen`이 끝나고 4.1의 시험이 통과한다. 생성물 한 파일을 손으로 고치면 `gen:check`와 시험이 그 파일 이름으로 실패한다.
- [x] 4.4 타입 검사: `pnpm --filter @peaket/contracts typecheck`. 확인: 오류 없음.

## 4b. 구현 중 찾은 것(결정 6·9)

- [x] 4b.1 orval `generate()`가 검증 오류를 로그로만 남기고 정상 종료하는 것을 재현 시험(`generate-fails.test.ts`)으로 먼저 실패시킨 뒤(약속이 거절되지 않음), `throwOnError`·`failOnWarnings`를 켠다. 확인: 같은 시험이 통과하고, 고치기 전 계약으로 `gen`이 1로 끝난다.
- [x] 4b.2 생성된 `BehaviorSummary`가 정의 밖 칸을 버리고 통과시키는 것을 생성 스키마 시험으로 먼저 본 뒤(`expected true to be false`), `additionalProperties: false` 바꾸기 시험(`close-additional-properties.test.ts`)을 먼저 써서 실패를 보고 변환을 만든다. 확인: 두 시험이 통과하고 생성물의 `.catchall(zod.never())`가 220곳이다.

## 4c. 코드 리뷰 반영(결정 9·10·11)

- [x] 4c.1 닫힌 스키마의 입력 타입에 정상 값을 넣는 타입 시험(`types.test.ts`)을 먼저 써서 타입 검사 실패(TS2322)를 보고, 생성 뒤 `.catchall(zod.never())`를 `.strict()`로 바꾼다. 확인: 타입 검사 오류 0, 정의 밖 칸 거절 시험 통과.
- [x] 4c.2 계약만 바뀌어도 모든 패키지의 시험 캐시가 깨지게 뿌리 `test` 작업의 입력에 `docs/api/**`를 둔다. 확인: openapi에 한 줄을 더하면 `--dry=json`의 시험 해시 11개가 모두 바뀐다(되돌린 뒤 같은 파일인지 `cmp`로 확인).
- [x] 4c.3 생성기가 옮기지 않는 제약의 시험(`untranslated-constraints.test.ts`)을 먼저 써서 실패를 보고, `schemaExtension`과 위치 찾기를 만든다. 확인: 중복·칸 수·칸 이름 길이를 거르고, 못 옮기는 위치가 적어 둔 셋뿐이다.
- [x] 4c.4 `gen`이 임시 폴더에 다 만든 뒤에만 `src/gen`을 바꿔 넣고, 진입점을 `import.meta.main`으로 본다. 확인: `gen`·`gen:check` 통과.
- [x] 4c.5 넘길 것을 BUILD_ORDER에 적는다: 쿼리·경로·머리 값 바꾸기(FND-070), 닫히지 않은 요청 본문 70개와 응답에서만 쓰는 닫힌 스키마 넷(BAS-040). 확인: 문서 점검 오류 0.
- [x] 4c.6 다시 본 리뷰의 것: `type`이 없거나 `allOf` 갈래·`format`이 있는 자리의 셋을 못 옮긴 것으로 세는 시험과 키 순서만 다른 중복 시험을 먼저 써서 실패(2건)를 보고 고친다. 생성물에 옮겨지는 중복 검사 함수가 타입 오류(암묵적 any 90건)를 내 매개변수 타입이 문맥에서 정해지는 꼴로 다시 쓴다. 확인: 시험 30개 통과, 타입 오류 0, `gen:check` 통과.

## 5. 정본 반영과 통합 확인

- [x] 5.1 정본에 반영한다: docs/frontend.md §2.2(패키지 구조의 `contracts`·`validation`, '생성물' 행, '지금 있는 것')·§5.17(지금 있는 것), docs/devops.md §3.1('지금 있는 것'의 계약), packages/README.md, wbs 0.2.1(md·csv 상태 진행). 확인: 문서 점검 오류 0.
- [x] 5.2 전체를 한 번에 확인한다: `pnpm test`, `pnpm turbo run typecheck build`, `node --test tools/ci/*.test.mjs`, 저장소 규칙 검사(`check-workflows`·CODEOWNERS·`workspace:`), `gen:check`, 문서 점검, OpenSpec 검증, 새 파일의 줄바꿈 LF. 확인: 모두 통과한다.

## 확인 기록

- 2026-11-01 저장소 밖 실험(orval 8.45.0, 게시 3일 지남): 계약 원본은 규격 위반 셋으로 생성이 거부됐고, 고친 사본으로 1.2초에 만들어졌으며 두 번 만든 결과가 같았다. 설치는 공급망 설정을 바꾸지 않고 통과했다(orval 8.45.0, vitest 5.0.5, zod 4.6.7, yaml 2.9.1, 새 판 67개 모두 게시 3일 지남, 설치 스크립트 허용 목록 그대로).
- 시험을 먼저 쓰고 본 실패: 변환기·차이 검사·생성 스키마·생성물 같음(모듈·생성물 없음) → 각각 구현·생성 뒤 통과. 규격 위반 계약의 생성 실패 시험(약속이 거절되지 않음) → orval 엄격 옵션 뒤 통과. 행동 신호 요약의 정의 밖 칸(`expected true to be false`) → `additionalProperties` 바꾸기 뒤 통과. 닫힌 스키마 입력 타입(TS2322) → `.strict()` 바꾸기 뒤 통과. 옮기지 않는 제약(모듈 없음, 다시 본 리뷰 뒤 2건) → 확장·위치 찾기 뒤 통과.
- 생성물 한 파일 끝에 줄을 더하자 `gen:check`가 `다름: openapi/model/behaviorSummary.zod.ts`로 1로 끝났고, 같은 시험도 그 파일을 `changed`로 적고 실패했다. 되돌리자 둘 다 통과했다.
- 계약에 한 줄을 더하면 `pnpm turbo run test --dry=json`의 시험 해시가 모든 패키지에서 바뀐다(되돌린 뒤 `cmp`로 같음 확인).
- 마지막 확인: `pnpm test --force` 6묶음(계약 30, 웹 34, 관제 37, 파트너 13, 포렌식 29, ds 5) 통과, `pnpm turbo run typecheck build --force` 16/16, `node --test tools/ci/*.test.mjs` 102/102, `gen:check` 같음, `check-workflows`·CODEOWNERS·`workspace:` 통과, `pnpm install --frozen-lockfile` 통과, 문서 점검 오류 0·경고 0, OpenSpec 검증 통과, 새 파일 줄바꿈 LF.
- 코드 리뷰(새 맥락): 1차 결함 9건 → 6건 고침, 3건 넘김(FND-070·BAS-040). 다시 본 결과 고침 다섯이 맞고, 가벼운 것 넷을 더 고치거나 넘긴 줄에 적었다.

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: 새 맥락의 리뷰 에이전트, 나온 것은 이 사이클에서 고친다(사이클 단위로 맡기기, architecture §8.6).
- 보관: `pnpm exec openspec archive add-contracts-package --yes`, 그리고 `develop`에 커밋.
- FND-040: `gen:check`를 CI 계약 잡(`contract-check.yml`)에서 부른다.
