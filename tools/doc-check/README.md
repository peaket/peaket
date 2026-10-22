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
| `--coverage` | archive/의 원문 설계서와 링크·영문 용어 대조도 한다(원문을 옮겨 쓰는 작업 뒤에만) |
| `--markers-out FILE` | [가정]·[충돌]·[보완]이 있는 줄 목록을 파일로 쓴다(00-summary §6을 고칠 때) |

종료 코드: 0 = 오류 없음, 1 = 오류 있음, 2 = 실행 실패.

## 검사 항목

| 검사 | 오류로 보는 것 | 경고로 보는 것 |
| --- | --- | --- |
| ids | FR·NFR·POL·SCR·CMP·ADR 참조가 정의에 없음, 같은 ID를 두 번 정의 | — |
| tables | 한 표 안에서 행마다 열 수가 다름(코드 스팬·`\|` 제외) | — |
| fences | 파일의 코드 펜스 수가 홀수 | — |
| paths | 저장소 안 경로(docs·planning·design·review·wbs·runbooks·tools)가 없음 | 같은 줄에 '예정'이 있으면 경고만 |
| api | openapi 경로가 URI 규칙(docs/api/guidelines.md §10)에 어긋남: 동사로 읽히는 단어, ID 앞의 단수 이름, ID 자리의 고정 단어, 3단계 이상, 대문자·밑줄, 끝 슬래시·빈 단계. 문서가 `GET /v1/…`처럼 이름을 댄 경로가 openapi에 없음(ADR 본문·review는 이력이라 제외하고, 같은 줄에 '예전'·'옛 경로'가 있으면 바뀌기 전 경로를 일부러 보인 줄로 보고 건너뜀, ADR-0081) | 프로토타입 문서(prototype/)의 경로가 openapi에 없음(프로토타입 전용 읽기 경로) |
| secrefs | '문서 §N' 참조의 절 제목이 그 문서에 없음 | — |
| artifacts | 줄 첫머리의 작업용 '다음:', planning·design·docs에 남은 `[충돌 C-n]` 표시 | TODO·TBD |
| asvs | docs/security/asvs/ 추적 표에서 같은 ASVS ID의 '요구사항 요약' 문장이 표마다 다름(ID마다 ASVS 5.0.0 원문 기준 한 문장, 00-summary 질문 45-5 (가), 2026-10-23) | — |
| wbs | wbs.csv의 상위 추정이 하위 합계와 다름, wbs.md와 wbs.csv의 레벨 3 작업 ID·추정이 다름 | — |
| versions | 기획 버전 줄이 없음 | 문서의 '기준 기획 버전'이 planning/01의 기획 버전과 다름 |
| coverage(선택) | — | 원문 링크·영문 용어가 새 문서에 없음 |

마커 수(`markers_all`, `markers_excl_summary_review`)와 ID 정의 수, WBS 합계는 정보로만 출력한다. 요약 문서에 숫자를 적을 때는 이 출력을 그대로 옮긴다(손으로 세지 않는다).

## 예외

- 외부 URL 안의 경로 문자열처럼 오탐이 확실한 경로는 `check_all.py`의 `ALLOW_PATHS`에 이유와 함께 넣는다. 지금은 `docs/software-architecture.md` 하나다(AWS 저장소 URL, review R-10).
- archive/와 tools/는 점검 대상에서 뺀다. archive/는 동결 원문이고 tools/는 예시 문자열이 많다.
- `api` 검사의 예외는 `check_all.py`에 이유와 함께 둔다. 경로 규칙 예외 `API_EXCEPTIONS`(`/graphql`, RFC 8628 토큰 엔드포인트 `/v1/scanner/token`, 전역 검색 `/v1/search`·`/v1/search/suggestions`), 집합 명사 `API_PLURAL_EXEMPT`(`staff`), 문서가 이름을 대도 openapi에 없어도 되는 경로 `API_REF_ALLOW`(토스페이먼츠 외부 API `/v1/payments/`·`/v1/transactions`, 프로토타입 전용 `/v1/proto/`, ADR-0080 2단계 초안 `/v1/forensics/`)다. openapi의 경로·작업 수(`api` 정보 줄)는 요약 문서의 REST 수치로 그대로 옮긴다.

## 유지보수 규칙

- 새 ID 종류나 새 문서 폴더를 만들면 이 스크립트의 정의 위치·`ALIAS`를 함께 고친다.
- CI 연결은 wbs 0.1.3 작업이다. 문서 리포의 PR마다 `python tools/doc-check/check_all.py`를 돌리고 실패하면 병합을 막는다.
