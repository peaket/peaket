# 설계: 계약 깨짐 검사와 CI 계약 잡

## Context

- 정본: PR의 계약을 대상 가지의 계약과, 마지막 출시 태그의 계약과 둘 다 견준다. OpenAPI는 `oasdiff breaking --fail-on ERR`(1.34.1, WARN은 PR에 남기기만), AsyncAPI는 `asyncapi diff <옛> <새> -t breaking`(CLI 6.2.2)이다. 의도해서 깨는 변경은 `breaking-approved` 라벨과 도구의 예외 목록(oasdiff `--err-ignore`)에 이유를 적어야 통과한다(guidelines §1). '깨짐'은 경로·메서드·응답 필드·열거 값·응답 상태 코드를 지우거나 이름을 바꾸기, 선택 입력을 필수로 바꾸기, 요청·응답 필드의 타입·형식 바꾸기, 오류 `type`의 이름이나 상태 코드 바꾸기, 이벤트 메시지의 필드·열거 기호 지우기다.
- 2026-11-01 실험(공식 이미지, 다이제스트 고정):
  - oasdiff 1.34.1은 선택 응답 칸 지우기(`response-optional-property-removed`), 응답 열거 값 지우기(`response-property-enum-value-removed`), 오류 응답 상태 코드 지우기(`response-non-success-status-removed`)를 INFO로 둔다. `--severity-levels` 파일로 ERR로 올리면 잡는다. `--err-ignore` 파일의 줄 끝에 `# 이유: …`를 붙여도 그 변경을 지운다.
  - AsyncAPI CLI 6.2.2의 diff는 AsyncAPI 3.0에서 채널 지우기, 채널 주소·작업 방향 바꾸기, 작업 지우기를 breaking으로 잡지만, 메시지 본문의 필드·열거 기호 지우기는 모두 unclassified로 둔다. 또 실행 기록을 외부로 보낸다고 알린다(`--network none`이면 보내지 못하고 건너뛴다).
- 출시 태그 규칙(`vX.Y.Z`, SemVer 최대)은 `release-plan.mjs` 안에 있다. 서비스(`services/`)는 아직 없다.

## Goals / Non-Goals

**Goals:** D-T48의 OpenAPI·AsyncAPI 부분, 깨짐 예외 목록과 라벨 규칙, D-T38의 자리, CI 계약 잡(생성물 차이·계약 패키지 시험·깨짐 검사).

**Non-Goals:** `buf lint`·`buf breaking`(proto), Avro 호환·열거 규칙·필수 여부 검사, Pact(그 계약을 쓰는 코드가 생기는 단계), 서비스 OpenAPI 비교 본체(서비스 템플릿 FND-050), WARN을 PR 댓글로 다는 일(원격이 생긴 뒤. 지금은 CI 화면의 경고 표시 `::warning`으로 남긴다), 오류 `type` 이름·형식(`format`) 바꾸기 탐지(아래 위험).

## Decisions

1. **도구는 판·다이제스트를 고정한 공식 이미지로, 네트워크를 끊고 돌린다(추천 적용 2026-11-01).** AsyncAPI CLI 6.2.2는 설치 스크립트가 있고(`postinstall`) 의존성이 40개가 넘으며 그중 셋을 `*` 판으로 받아, 작업 공간 잠금 파일에 넣으면 공급망 설정(devops §4.4: 설치 스크립트 차단, 신뢰 하락 차단)과 부딪힌다. oasdiff는 Go 실행 파일이다. 둘 다 공식 이미지(`tufin/oasdiff`, `asyncapi/cli`)를 다이제스트로 고정해 `docker run --rm --network none`으로 부르면 잠금 파일이 그대로이고, CLI의 실행 기록 전송이 막히며, 개발 PC(Docker Desktop)와 CI(ubuntu 실행기)에서 같은 것이 돈다. 이미지 판은 정본이 정한 판(oasdiff 1.34.1, CLI 6.2.2)이고 둘 다 게시 뒤 3일이 지났다.
2. **견줄 기준**: ① 대상 가지(PR은 `origin/<대상>`, 푸시는 푸시 전 커밋)와 지금 커밋의 갈라진 점(`git merge-base`). 대상 가지가 그 뒤 앞서가면 거기 새로 생긴 경로·칸이 '지워졌다'로 보여 거짓 실패가 나기 때문이다(코드 리뷰가 찾음) ② 마지막 출시 태그(`vX.Y.Z` 가운데 SemVer 최대). 두 기준이 같은 커밋이면 한 번만 본다. 출시 태그가 없거나 그 기준에 계약 파일이 없으면 건너뛰고 까닭을 적는다(처음 출시 전, 새 계약). 기준의 계약은 `git show`로 임시 폴더에 꺼낸다.
3. **OpenAPI 판정**: `oasdiff breaking <기준> <지금> --fail-on ERR --severity-levels docs/api/breaking/openapi-levels.txt --err-ignore docs/api/breaking/openapi-ignore.txt`. 수준 파일은 위 셋을 ERR로 올리고 줄마다 정본 근거를 적는다. 그 밖의 기본 수준은 그대로 둔다(oasdiff가 ERR로 보는 응답 열거 값 더하기도 그대로다. 생성 Zod의 `zod.enum`으로 응답을 검사하는 옛 화면은 새 값을 거절하기 때문이다).
4. **AsyncAPI 판정은 둘이다(추천 적용 2026-11-01).** ① `asyncapi diff <기준> <지금> -t breaking --overrides <예외>`가 채널·작업·서버를 본다. ② 메시지 본문은 FND-030의 변환기(`packages/contracts/scripts/asyncapi-to-openapi.mjs`)로 구성 요소를 만들고, 메시지마다 `GET /messages/<이름>`의 200 응답으로 그 본문을 가리키는 작업을 붙인 OpenAPI 문서로 바꿔 oasdiff로 견준다. 소비자가 메시지를 읽는 것은 클라이언트가 응답을 읽는 것과 같은 방향이라 응답 규칙(칸·열거 값 지우기, 타입 바꾸기, 필수를 선택으로)이 그대로 맞는다. 메시지를 지우면 작업 지우기로 잡힌다. 메시지는 내용 형식별로 나눠 두 번 견준다(코드 리뷰가 찾음). JSON 메시지(`application/json`, 관제 SSE·화면 지표 등)는 화면이 생성 Zod(`zod.enum`)로 읽으므로 열거 기호 더하기도 oasdiff 기본(ERR) 그대로 깨짐이다(`asyncapi-levels.txt`). Avro 메시지(기본 형식)는 열거의 맨 앞 `UNRECOGNIZED` 규칙으로 기호 더하기를 받으므로 그것만 WARN으로 내린다(`asyncapi-avro-levels.txt`, devops §3.1 열거 규칙). 응답 스키마 자체가 열거인 경우의 값 지우기(`response-mediatype-enum-value-removed`, 기본 INFO)도 셋 모두 ERR로 올린다.
5. **깨짐 예외 목록**: `docs/api/breaking/openapi-ignore.txt`·`asyncapi-ignore.txt`(oasdiff `--err-ignore`, 줄 끝 `# 이유: …` 필수)와 `asyncapi-overrides.json`(`{ "<JSON 포인터>": { "reason": "…", "add|remove|edit": "non-breaking" } }`. 스크립트가 `reason`을 빼고 CLI에 넘긴다). 이유가 없는 예외는 실패다. 대상 가지(갈라진 점)의 예외 파일보다 예외가 늘었으면 PR 라벨에 `breaking-approved`가 있어야 통과한다. 덮어쓰기는 키와 값을 함께 견줘 값을 넓혀도 는 것으로 본다. 수준 파일을 낮추는 PR(기준에 있던 줄을 지우거나 낮춤, ERR 아닌 줄을 새로 둠)도 같은 라벨을 요구한다. 수준을 낮추면 그 종류의 깨짐이 예외 없이 통째로 빠지기 때문이다. 그래서 수준 파일을 처음 넣는 이 변경의 PR도 Avro의 WARN 한 줄 때문에 라벨이 있어야 한다. oasdiff는 예외 파일의 `#` 줄도 예외로 읽으므로, 스크립트가 읽은 예외 문장만 담은 사본(주석·이유를 뺀 것)을 넘긴다(코드 리뷰가 찾음, `#` 줄 하나로 라벨·이유 검사를 비켜 가던 결함). 라벨은 사용자가 고칠 수 있는 값이라 스크립트가 사건 파일(`GITHUB_EVENT_PATH`)에서 읽는다(워크플로 규칙 4).
6. **서비스 OpenAPI 차이(D-T38)의 자리**: `services/*/package.json`에 `openapi:emit` 스크립트가 있는 서비스를 찾는다. 하나도 없으면 통과하고 그렇게 적는다. 있으면 '비교가 아직 없다'로 실패한다. 서비스가 생겼는데 검사 없이 통과하는 일을 막으려는 것이다. 비교 본체(서비스가 맡는 경로만 견주는 방법 포함)는 서비스 템플릿 단계(FND-050)에서 만든다.
7. **CI**: `ci.yml`의 `changes` 잡이 `contracts` 범위를 내고, 그 범위나 범위 고르기 실패 때 `contract-check.yml`이 돈다. 단계: 체크아웃(태그·대상 가지가 필요해 `fetch-depth: 0`) → node·pnpm 설치(잠금 파일대로) → `gen:check` → 계약 패키지 시험 → 깨짐 검사. `ci-summary`가 결과를 모은다. 라벨은 스크립트가 사건 파일에서 읽고, PR에 라벨을 붙이거나 떼면(`labeled`·`unlabeled`) 다시 판정한다. 서비스(`services/`)와 계약 깨짐 검사 도구·이 워크플로가 바뀌어도 `contracts` 범위가 켜진다(서비스 OpenAPI 차이의 자리가 서비스 PR에서 돌게, 코드 리뷰가 찾음).
8. **시험(TDD)**: 도구 실행은 주입한 실행 함수로 바꿔 끼우고, 기준 고르기는 git 시험 저장소로 본다. 시험 이름에 `DT48_`·`DT38_`·`낮음019_`를 단다. 실제 이미지로 D-T48의 OpenAPI·AsyncAPI 경우를 돌린 결과는 tasks.md 확인 기록에 남긴다.

## Risks / Trade-offs

- oasdiff에는 형식(`format`) 바꾸기 검사가 없고, 오류 `type`은 설명 글과 Problem 본문 값이라 계약의 구조로 보이지 않는다. 이 둘은 이 검사로 잡지 못한다(PR 검토와 guidelines §2의 오류 type 목록 관리로 본다).
- `asyncapi/cli` 이미지는 받을 때 약 1.4GB(풀면 약 7GB)라 계약 잡이 돌 때마다 받는 시간이 든다. 실행기 캐시는 원격이 생긴 뒤 본다.
- Docker 이미지를 받아야 하므로 Docker Hub가 멈추면 계약 잡이 실패한다(닫힌 쪽으로 실패하므로 깨진 계약이 지나가지는 않는다).
- 메시지 본문을 응답처럼 보는 것은 근사다. 생산자 쪽 깨짐(소비자가 보내는 값은 없다)은 다루지 않는다.
