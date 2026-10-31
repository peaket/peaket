# Tasks

## 1. 호스트·인증 검사의 시험(낮음-031)

- [x] 1.1 `tools/doc-check/test_api_contract.py`에 design.md 결정 4의 경우 ①~⑩을 시험으로 쓴다. 확인: `python -I -X utf8 -m unittest discover -s tools/doc-check -p "test_*.py"`가 돈다.
- [x] 1.2 실패를 본다(결정 6): 세션 임시 폴더에 호스트 검사·인증 이름 검사·전역 인증 검사를 하나씩 끈 `check_all.py` 변형을 만들고, 변형마다 그 검사의 시험이 실패하는지 본다. 확인: 변형마다 실패한 시험 이름을 아래 '확인 기록'에 적는다.
- [x] 1.3 저장소의 `check_all.py`로 같은 시험이 통과한다. 확인: 같은 명령.

## 2. 숫자 보고의 시험(낮음-032)

- [x] 2.1 같은 파일에 design.md 결정 5의 경우 ①~④를 시험으로 쓴다. 확인: 같은 명령이 돈다.
- [x] 2.2 실패를 본다: 보고 숫자 하나를 틀리게 세는 변형, Problem 예외 목록을 비우는 변형, 작업 수 대조를 끈 변형으로 그 시험이 실패하는지 본다. 확인: '확인 기록'에 적는다.
- [x] 2.3 저장소의 `check_all.py`로 모든 시험이 통과한다. 확인: 같은 명령.

## 3. CI와 문서

- [x] 3.1 `.github/workflows/docs-check.yml`의 문서 점검 앞에 시험 단계를 둔다(결정 7). 확인: `node tools/ci/check-workflows.mjs`가 통과하고 `node --test "tools/ci/*.test.mjs"`에 회귀가 없다.
- [x] 3.2 `tools/doc-check/README.md`에 시험 실행법을 적고 'CI 연결은 wbs 0.1.3 작업이다'라는 옛 문장을 고친다. docs/devops.md §3.1의 `docs-check.yml` 행에 시험을 적는다. 확인: 적은 명령이 그대로 돈다.
- [x] 3.3 wbs 0.1.3(md·csv)의 남았다는 문장과 상태 칸을 고친다(완료). 상위 0.1은 하위를 모으는 규칙대로 진행이다. 확인: `python -I tools/doc-check/check_all.py` 오류 0.

## 4. 통합 확인

- [x] 4.1 시험, 문서 점검, CI 도구 시험, 워크플로 규칙 검사, OpenSpec 검증, 새 파일의 줄바꿈 LF를 한 번에 본다. 확인: 모두 통과한다.

## 5. 코드 리뷰 반영(design.md 결정 8)

- [x] 5.1 리뷰가 찾은 빈틈 둘을 변형으로 재현한다: 전역 `security` 빈 목록을 '있음'으로 보는 변형, `Problem` 스키마 참조를 안 받는 변형. 확인: 지금 시험이 둘 다 통과한다(빈틈 확인).
- [x] 5.2 `security를안적은작업은_전역이있을때만_통과`에 전역 `security: []` 경우를, `보고숫자가_명세와같다`에 `application/json` 아래 `Problem` 스키마 참조 409를 더한다. 확인: 두 변형에서 그 시험이 실패하고, 저장소의 `check_all.py`로는 14개가 모두 통과하며, 변형 19개가 모두 잡힌다.

## 확인 기록

- 2026-11-01 시험 14개(낮음-031 10, 낮음-032 4)를 쓰고 저장소의 `check_all.py`로 돌려 모두 통과했다(`python -I -X utf8 -m unittest discover -s tools/doc-check -p "test_*.py"`). 처음 돌렸을 때 13개가 실패했는데, 시험 도우미가 경로 글의 들여쓰기를 모두 걷어 내 `paths:` 아래가 비어 읽혔기 때문이다(검사 결함이 아니라 시험 도우미 결함). 걷어 낸 뒤 두 칸을 다시 밀게 고쳤다.
- 실패 보기(결정 6): 세션 임시 폴더에 `check_all.py`를 복사해 한 곳씩 바꾼 변형 17개로 시험을 돌렸다. 변형마다 실패한 시험:
  - 호스트 오류 끔 → `servers에서버가둘이면_오류`, `맞는규칙도servers도없으면_오류`
  - 규칙을 아래부터 봄 → `처음맞는접두사의_서버로_호스트를정한다`, `보고숫자가_명세와같다`
  - 경로 `servers`가 작업 `servers`를 이김 → `작업servers가_경로servers를이긴다`
  - `servers` 무시 → `servers에서버가둘이면_오류`, `경로servers가_접두사규칙을이긴다`, `작업servers가_경로servers를이긴다`
  - 작업 `security` 이름 검사 끔 → `작업security의_없는인증방식은_오류`
  - 전역 `security` 이름 검사 끔 → `전역security의_없는인증방식은_오류`
  - 전역 없음 검사 끔 → `security를안적은작업은_전역이있을때만_통과`
  - 공개 수 안 셈 → `security빈목록은_공개작업`, `보고숫자가_명세와같다`
  - `operationId` 없음 안 셈, Problem 수 안 셈 → `보고숫자가_명세와같다`
  - 예외 목록 비움 → `Problem예외는_오류가아니고_목록에나온다`
  - Problem 오류 끔, 예외를 응답 코드 없이 받음 → `예외가아닌오류응답이Problem이아니면_오류`
  - 작업 수 대조 끔 → `줄규칙과YAML의작업수가다르면_오류`
  - 못 읽은 명세 오류 끔 → `명세를읽지못하면_계약검사실패`
  - `missing_security` 안 셈 → `security를안적은작업은_전역이있을때만_통과`, `보고숫자가_명세와같다`
  - `missing_host` 안 셈 → `servers에서버가둘이면_오류`, `맞는규칙도servers도없으면_오류`
- 리뷰 반영 뒤(작업 5) 같은 변형에 둘을 더한 19개로 다시 돌렸다. 전역 빈 목록 변형 → `security를안적은작업은_전역이있을때만_통과`, Problem 스키마 참조 변형 → `보고숫자가_명세와같다`. 나머지 17개도 그대로 잡힌다. 리뷰 에이전트가 따로 넣어 본 변형 다섯(`security: []`를 빈 값처럼 다룸, 대안 인증 중 첫째만 봄, 5xx 뺌, 접두사를 완전 일치로 봄, 404면 경로와 상관없이 예외)도 잡혔다.
- 격리 모드(`-I`)는 `PYTHONIOENCODING`을 읽지 않아 윈도우에서 실패 메시지가 깨진다. 그래서 명령에 `-X utf8`을 붙였다(CI와 README 같은 명령).
- `node tools/ci/check-workflows.mjs` 통과(워크플로 7개), `node --test tools/ci/*.test.mjs` 102/102, `python -I tools/doc-check/check_all.py` 오류 0·경고 0.

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: 새 맥락의 리뷰 에이전트, 나온 것은 이 사이클에서 고친다(사이클 단위로 맡기기, architecture §8.6). 2026-11-01에 시험 빈틈 2건(낮음)이 나왔고 작업 5로 고쳤다. 동작·보안 결함과 회귀는 없었다.
- 보관: `pnpm exec openspec archive add-doc-check-api-contract-tests --yes`, 그리고 `develop`에 커밋.
