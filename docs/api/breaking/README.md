# 계약 깨짐 검사의 수준·예외 파일

`tools/ci/contract-breaking.mjs`(CI의 `contract-check`)가 읽는다. PR의 계약을 대상 가지와 마지막 출시 태그의 계약과 견주고, '깨짐'(docs/api/guidelines.md §1)이 있으면 실패한다.

| 파일 | 뜻 |
| --- | --- |
| `openapi-levels.txt` | OpenAPI 판정의 oasdiff 수준 바꾸기. 정본의 깨짐인데 oasdiff 기본이 INFO인 검사를 ERR로 올린다 |
| `asyncapi-levels.txt`, `asyncapi-avro-levels.txt` | AsyncAPI 메시지 본문 판정의 oasdiff 수준 바꾸기(메시지를 응답처럼 본다). JSON 메시지는 앞의 것, Avro 메시지는 뒤의 것을 쓰고, 뒤의 것만 열거 기호 더하기를 WARN으로 둔다 |
| `openapi-ignore.txt`, `asyncapi-ignore.txt` | 의도해서 깨는 변경의 예외(oasdiff `--err-ignore`). 줄 끝에 `# 이유: …`가 있어야 한다 |
| `asyncapi-overrides.json` | `asyncapi diff`의 채널·작업 수준 예외(`--overrides`). `{ "<JSON 포인터>": { "reason": "…", "remove": "non-breaking" } }` 꼴이고 `reason`이 있어야 한다 |

- 예외가 대상 가지(지금 커밋과 갈라진 점)보다 늘어나거나 수준을 낮춘 PR에는 `breaking-approved` 라벨이 있어야 통과한다. 덮어쓰기는 값을 넓혀도 는 것으로 본다.
- `#`로 시작하는 줄과 줄 끝의 `# 이유: …`는 주석이다. oasdiff는 주석을 받지 않거나(수준 파일) `#` 줄도 예외로 읽으므로(예외 파일), 스크립트가 주석을 지우고 자기가 읽은 예외 문장만 담은 사본을 oasdiff에 넘긴다.
- 실행법과 설계는 tools/ci/README.md와 openspec 변경 `add-contract-breaking-check`의 design.md에 있다.
