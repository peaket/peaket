# 문서 점검 도구(doc-check)

- **독자와 용도**: 문서를 고친 사람이 커밋하기 전에, 그리고 CI가 PR마다 문서 묶음의 정합성을 기계적으로 확인할 때 쓴다. 2026-10-08 재구성 때 세션 임시 폴더에서 쓰던 점검 스크립트 3개를 합쳐 저장소에 넣었다(00-summary §7 질문 15).
- **실행 환경**: Python 3.10 이상, 표준 라이브러리만.

## 실행

```bash
python tools/doc-check/check_all.py
```

| 옵션 | 뜻 |
| --- | --- |
| `--strict` | 경고도 실패로 본다(릴리스 전 점검용) |
| `--json` | 결과를 JSON으로 출력(CI 주석용) |
| `--coverage` | 원문 설계서와 링크·영문 용어 대조도 한다(원문을 옮겨 쓰는 작업 뒤에만). 원문은 2026-10-27에 archive/에서 지웠으므로 git 태그 `archive-original`에서 읽는다(ADR-0098). 태그가 없는 복제본에서는 '원문 없음' 경고만 낸다 |
| `--markers-out FILE` | [가정]·[충돌]·[보완]이 있는 줄 목록을 파일로 쓴다(00-summary §6을 고칠 때) |

종료 코드: 0 = 오류 없음, 1 = 오류 있음, 2 = 실행 실패.

## 검사 항목

| 검사 | 오류로 보는 것 | 경고로 보는 것 |
| --- | --- | --- |
| yaml | 저장소의 .yaml(openapi·asyncapi·docs/api/proto/buf.yaml)에서 같은 매핑에 같은 키가 두 번 있음(블록·흐름 매핑 모두), 읽을 수 없는 줄(들여쓰기 어긋남, 일반 글자 안의 `: `, 닫히지 않은 따옴표·괄호). 읽기는 표준 라이브러리로 만든 작은 읽개(`YamlReader`)이고 이 저장소 파일이 쓰는 부분만 읽는다(앵커·별칭·태그는 오류). 기술 검토 낮음-027 | — |
| ids | FR·NFR·POL·SCR·CMP·ADR 참조가 정의에 없음, 같은 ID를 두 번 정의 | — |
| frtrace | planning/02의 FR 가운데, 시험 표 행(첫 칸이 `Q-T12`·`**SR-T1**` 같은 시험 ID인 표 행) 어디에서도 가리키지 않는 FR이 있음. 행 안의 `FR-005~008`(범위), `FR-026·028~034`, `FR-001, 002` 같은 묶음은 펼쳐서 센다. review/·docs/adr/·tools/와 코드 펜스 안은 보지 않는다(planning/02 §2 '인수 조건마다 자동화 시험 하나 이상', 기술 검토 중간-005). 연결된 FR 수는 `frtrace` 정보 줄에 나온다 | — |
| tables | 한 표 안에서 행마다 열 수가 다름(코드 스팬·`\|` 제외) | — |
| fences | 파일의 코드 펜스 수가 홀수 | — |
| paths | 저장소 안 경로(docs·planning·design·review·wbs·runbooks·tools)가 없음 | 같은 줄에 '예정'이 있으면 경고만 |
| api | openapi 경로가 URI 규칙(docs/api/guidelines.md §10)에 어긋남: 동사로 읽히는 단어, ID 앞의 단수 이름, ID 자리의 고정 단어, 3단계 이상, 대문자·밑줄, 끝 슬래시·빈 단계. 문서가 `GET /v1/…`처럼 이름을 댄 경로가 openapi에 없음(ADR 본문·review는 이력이라 제외하고, 같은 줄에 '예전'·'옛 경로'가 있으면 바뀌기 전 경로를 일부러 보인 줄로 보고 건너뜀, ADR-0081). openapi 계약(guidelines §10·§12, 기술 검토 낮음-030·031): 작업이 `x-peaket-gateways` 규칙(위에서 처음 맞는 접두사)이나 경로 `servers`로 호스트 하나에 정해지지 않음, `security`가 가리키는 이름이 `securitySchemes`에 없음, `security`를 적지 않은 작업이 있는데 전역 `security`가 없음, 4xx·5xx 응답이 Problem(`application/problem+json` 또는 `Problem` 스키마)을 선언하지 않음(예외: 기기 승인 토큰 엔드포인트의 OAuth 400, 확장자가 붙은 정적 파일 경로의 404), PUT·PATCH에 `IfMatch`가 없음(예외 셋: 내 찜, 근무 준비, 내 후기), `IfMatch`를 받는데 412·428을 선언하지 않음 | 프로토타입 문서(prototype/)의 경로가 openapi에 없음(프로토타입 전용 읽기 경로) |
| secrefs | '문서 §N' 참조의 절 제목이 그 문서에 없음 | — |
| artifacts | 줄 첫머리의 작업용 '다음:', planning·design·docs에 남은 `[충돌 C-n]` 표시 | TODO·TBD |
| asvs | docs/security/asvs/ 추적 표에서 같은 ASVS ID의 '요구사항 요약' 문장이 표마다 다름(ID마다 ASVS 5.0.0 원문 기준 한 문장, 00-summary 질문 45-5 (가), 2026-10-23), 레벨 칸이 `L1`·`L2`·`L3`이 아님(`L3(채택)` 같은 덧붙임 금지, 기술 검토 낮음-089). 시험 결과 칸은 보지 않는다('설계 검사'도 막지 않는다) | — |
| adr | — | 결정이 10개를 넘고(`## 결정` 절의 번호 항목 11개 이상) 상태 줄이 1,000자를 넘는 ADR인데 docs/architecture.md §11.1에 그 ADR의 결정별 현재 판 표(`ADR-NNNN(` 머리 줄)가 없음(docs/architecture.md §11, 기술 검토 낮음-150) |
| wbs | wbs.csv의 상위 추정이 하위 합계와 다름, wbs.md와 wbs.csv의 레벨 3 작업 ID·추정이 다름 | — |
| versions | 기획 버전 줄이 없음 | 문서의 '기준 기획 버전'이 planning/01의 기획 버전과 다름 |
| coverage(선택) | — | 원문 링크·영문 용어가 새 문서에 없음 |

마커 수(`markers_all`, `markers_excl_summary_review`)와 ID 정의 수, FR→시험 연결 수(`frtrace`: FR 수·연결된 FR 수·시험 행 수), openapi 보고(`api`: 경로·작업 수, 4xx·5xx 응답 수와 그중 Problem 선언 수, `operationId`·호스트·`security`가 빠진 작업 수, 공개 작업 수, If-Match를 받는 작업과 예외 수. `api_hosts`: 호스트별 작업 수. `api_problem_exempt`: Problem 예외 응답 목록. guidelines §12 '자기 서술성 점검', 기술 검토 낮음-032), §11.1 표가 있는 ADR(`adr_decision_tables`), WBS 합계는 정보로만 출력한다. 요약 문서에 숫자를 적을 때는 이 출력을 그대로 옮긴다(손으로 세지 않는다).

## 예외

- 외부 URL 안의 경로 문자열처럼 오탐이 확실한 경로와, 없앤 문서인데 고치지 않는 지난 기록(ADR 본문, review의 지난 행)이 가리키는 경로는 `check_all.py`의 `ALLOW_PATHS`에 이유와 함께 넣는다. 지금은 `docs/software-architecture.md`(AWS 저장소 URL, review R-10), `docs/arc42.md`(ADR-0090으로 없앤 문서, review R-105), `docs/appendix-learning-map.md`(ADR-0097로 없앤 부록, review R-115) 셋이다.
- tools/는 점검 대상에서 뺀다(예시 문자열이 많다). archive/도 빼는 목록에 남아 있지만, 원문 설계서는 2026-10-27에 지워 git 태그 `archive-original`에만 있다(ADR-0098).
- `api` 검사의 예외는 `check_all.py`에 이유와 함께 둔다. 경로 규칙 예외 `API_EXCEPTIONS`(`/graphql`, RFC 8628 토큰 엔드포인트 `/v1/scanner/token`, 전역 검색 `/v1/search`·`/v1/search/suggestions`), 집합 명사 `API_PLURAL_EXEMPT`(`staff`), 문서가 이름을 대도 openapi에 없어도 되는 경로 `API_REF_ALLOW`(토스페이먼츠 외부 API `/v1/payments/`·`/v1/transactions`·`/v1/settlements`, 프로토타입 전용 `/v1/proto/`, ADR-0080 2단계 초안 `/v1/forensics/`)다. openapi 계약 검사의 예외도 `check_all.py`에 이유와 함께 둔다: `PROBLEM_EXEMPT`(`POST /v1/scanner/token` 400, OAuth 오류)와 확장자 경로의 404, `IF_MATCH_EXEMPT`(`PUT /v1/productions/{productionId}/wish`, `PUT /v1/scanner/shift/readiness`, `PATCH /v1/reviews/{reviewId}`, guidelines §12). openapi의 경로·작업 수와 계약 보고 수(`api` 정보 줄)는 요약 문서의 REST 수치로 그대로 옮긴다.

## 유지보수 규칙

- 새 ID 종류나 새 문서 폴더를 만들면 이 스크립트의 정의 위치·`ALIAS`를 함께 고친다.
- CI 연결은 wbs 0.1.3 작업이다. 문서 리포의 PR마다 `python tools/doc-check/check_all.py`를 돌리고 실패하면 병합을 막는다.
