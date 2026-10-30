# 문서 점검 도구(doc-check)

- **독자와 용도**: 문서를 고친 사람이 커밋하기 전에, 그리고 CI가 PR마다 문서 묶음의 정합성을 기계적으로 확인할 때 쓴다. 2026-10-08 재구성 때 세션 임시 폴더에서 쓰던 점검 스크립트 3개를 합쳐 저장소에 넣었다(00-summary §7 질문 15).
- **실행 환경**: Python 3.10 이상, 표준 라이브러리만. `mermaid` 검사만 node 22 이상과 tools/doc-check/mermaid의 의존성(mermaid·jsdom, 판 고정)을 쓴다. 없으면 경고 하나를 내고 그 검사만 건너뛴다(ADR-0138).

## 실행

처음 한 번(또는 tools/doc-check/mermaid/package-lock.json이 바뀌었을 때) mermaid 검사 의존성을 받는다. 설치 스크립트는 돌리지 않는다.

```bash
npm ci --ignore-scripts --prefix tools/doc-check/mermaid
```

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
| yaml | 저장소의 .yaml(openapi·asyncapi·docs/api/proto/buf.yaml)에서 같은 매핑에 같은 키가 두 번 있음(블록·흐름 매핑 모두), 읽을 수 없는 줄(들여쓰기 어긋남, 일반 글자 안의 `: `, 닫히지 않은 따옴표·괄호). 읽기는 표준 라이브러리로 만든 작은 읽개(`YamlReader`)이고 이 저장소 파일이 쓰는 부분만 읽는다(앵커·별칭·태그는 오류). 기술 검토 낮음-027. pnpm이 만드는 `pnpm-lock.yaml`은 어느 검사에서도 읽지 않는다(문서가 아니고 YAML 문서 여럿을 이어 붙인 형식이다. 검사는 pnpm의 공급망 검사가 한다, ADR-0167) | — |
| ids | FR·NFR·POL·SCR·CMP·ADR 참조가 정의에 없음, 같은 ID를 두 번 정의 | — |
| frtrace | docs/planning/02의 FR 가운데, 시험 표 행(첫 칸이 `Q-T12`·`**SR-T1**` 같은 시험 ID인 표 행) 어디에서도 가리키지 않는 FR이 있음. 행 안의 `FR-005~008`(범위), `FR-026·028~034`, `FR-001, 002` 같은 묶음은 펼쳐서 센다. docs/review/·docs/adr/·tools/와 코드 펜스 안은 보지 않는다(docs/planning/02 §2 '인수 조건마다 자동화 시험 하나 이상', 기술 검토 중간-005). 연결된 FR 수는 `frtrace` 정보 줄에 나온다 | — |
| tables | 한 표 안에서 행마다 열 수가 다름(코드 스팬·`\|` 제외) | — |
| fences | 파일의 코드 펜스 수가 홀수 | — |
| paths | 저장소 안 경로(docs·planning·design·review·wbs·runbooks·tools)가 없음. 링크(소유자 결정 2026-10-30, docs/review/open-items.md 32번): ① 이 컴퓨터에서만 열리는 절대 경로 링크(`file:` 주소, `D:/…` 같은 드라이브 경로. 코드 표시 안에서 말로 가리킨 것은 뺀다) ② 마크다운 링크 `[글](대상)`·참조 정의 `[이름]: 대상`의 대상 파일·폴더가 없음(링크가 있는 문서 기준 상대 경로, 대소문자까지 같아야 한다), 저장소 밖을 가리킴 ③ 위치 표시(`문서.md#제목`, 같은 문서의 `#제목`)가 대상 문서의 제목에 없음. 제목은 GitHub 방식으로 바꿔 견준다: 화면 글자(강조 표시·링크 주소·HTML 태그를 빼고 코드 표시 안 글자는 남김)를 소문자로 하고, 문자·결합 부호·십진 숫자·밑줄·하이픈·빈칸만 남기고(한국어 글자는 남는다. `§`·`·`·괄호·`②`·`²`는 지운다), 빈칸 하나를 `-` 하나로 바꾼다. 같은 표시가 또 나오면 `-1`, `-2`를 붙인다. 이 변환은 저장소 제목 2,041개(겹치지 않는 것)를 GitHub Markdown API로 그려 받은 id와 모두 같았다(2026-10-30). `<a id="…">`도 위치 표시로 받는다. 바깥 주소(https·mailto)와 대상이 파일 꼴이 아닌 것(화면 설계의 버튼 표기 `[ 승인 ](재인증)`), 코드 펜스·코드 표시 안, 마크다운이 아닌 파일의 위치 표시(openapi의 `#/components/…` 등)는 보지 않는다. 마크다운 문서를 가리키는 `#L1` 같은 줄 번호 표시는 GitHub가 그린 문서에서 그 줄로 움직이지 않으므로 오류다 | 같은 줄에 '예정'이 있으면 경고만(경로 글자와 링크 대상 모두) |
| api | openapi 경로가 URI 규칙(docs/api/guidelines.md §10)에 어긋남: 동사로 읽히는 단어, ID 앞의 단수 이름, ID 자리의 고정 단어, 3단계 이상, 대문자·밑줄, 끝 슬래시·빈 단계. 문서가 `GET /v1/…`처럼 이름을 댄 경로가 openapi에 없음(ADR 본문·review는 이력이라 제외하고, 같은 줄에 '예전'·'옛 경로'가 있으면 바뀌기 전 경로를 일부러 보인 줄로 보고 건너뜀, ADR-0081). openapi 계약(guidelines §10·§12, 기술 검토 낮음-030·031): 작업이 `x-peaket-gateways` 규칙(위에서 처음 맞는 접두사)이나 경로 `servers`로 호스트 하나에 정해지지 않음, `security`가 가리키는 이름이 `securitySchemes`에 없음, `security`를 적지 않은 작업이 있는데 전역 `security`가 없음, 4xx·5xx 응답이 Problem(`application/problem+json` 또는 `Problem` 스키마)을 선언하지 않음(예외: 기기 승인 토큰 엔드포인트의 OAuth 400, 확장자가 붙은 정적 파일 경로의 404), PUT·PATCH에 `IfMatch`가 없음(예외 셋: 내 찜, 근무 준비, 내 후기), `IfMatch`를 받는데 412·428을 선언하지 않음 | 프로토타입 문서(prototype/)의 경로가 openapi에 없음(프로토타입 전용 읽기 경로) |
| roles | openapi 작업의 허용 역할 칸 `x-peaket-roles`(소유자 결정 2026-10-30, docs/review/open-items.md 71번, 값과 규칙의 정본은 docs/security/authz-matrix.md §5.5): ① 칸이 없는 작업(공개 작업도 `[public]`을 단다) ② 값이 하나 이상인 목록이 아님 ③ 같은 값이 두 번 ④ §5.5 표에 없는 값 ⑤ 작업의 `security` 요구(대안) 가운데 받을 값이 목록에 없는 것 ⑥ 목록의 값 가운데 어느 `security` 요구와도 맞지 않는 것(값은 §5.5 표의 '알아보는 자격'이 요구에 들고 요구의 나머지 자격이 그 값의 '함께 오는 자격'일 때 맞는다. 빈 요구 `{}`는 `public`과만 맞는다) ⑦ `securitySchemes`의 인증 방식 가운데 §5.5 표 어느 행에도 없는 것 ⑧ §5.5 표를 찾지 못함. 표는 그 절에서 첫 칸이 코드 표시 값(`` `fan` ``)인 행만 읽고, 자격 칸의 코드 표시 가운데 `securitySchemes`에 있는 이름과 `{}`만 쓴다. 작업 수와 값마다 단 작업 수는 `roles` 정보 줄에 나온다. 작업의 본인·테넌트·상태 같은 대상 조건은 보지 않는다(서비스가 본다) | — |
| secrefs | '문서 §N' 참조의 절 제목이 그 문서에 없음 | — |
| artifacts | 줄 첫머리의 작업용 '다음:', planning·design·docs에 남은 `[충돌 C-n]` 표시 | TODO·TBD |
| public | 공개 문서에 실제 운영 값으로 읽히는 것(소유자 결정 2026-10-29, ADR-0153, docs/devops.md §2.1): 12자리 계정 번호가 든 ARN, 쉼표 없는 12자리 숫자, `peaket.example`이 아닌 PEAKET 도메인(`peaket.com`·`peaket.co.kr`·`peaket.io` 같은 주소. 쿠버네티스 레이블·주석 키 접두사 `peaket.io/…`는 이름이라 뺀다), 사설·공유·링크 로컬·루프백·문서용(RFC 5737) 밖의 IPv4 대역(`0.0.0.0/0`은 허용). 대역 표기(`/숫자`)가 없는 점 넷 숫자는 ASVS 항목 번호와 구분되지 않아 보지 않는다 | — |
| asvs | docs/security/asvs/ 추적 표에서 같은 ASVS ID의 '요구사항 요약' 문장이 표마다 다름(ID마다 ASVS 5.0.0 원문 기준 한 문장, 00-summary 질문 45-5 (가), 2026-10-23), 레벨 칸이 `L1`·`L2`·`L3`이 아님(`L3(채택)` 같은 덧붙임 금지, 기술 검토 낮음-089). 시험 결과 칸은 보지 않는다('설계 검사'도 막지 않는다) | — |
| blockers | 대조할 자리(절 또는 그 절의 줄)나 API 기준(스키마 열거값, 작업의 409 응답)을 찾지 못함. 문서 제목이나 openapi 경로가 바뀌면 `check_all.py`의 `BLOCKER_LISTS`를 함께 고친다 | 같은 차단 조건 목록이 정책·상태도·화면·API에 흩어진 것(소유자 결정 2026-10-30, docs/review/open-items.md 51번): API에 적힌 차단 사유 코드(대문자와 밑줄, 예: `ENTRY_STARTED`)를 기준으로, 각 자리에 적힌 코드 묶음에 빠진 코드나 API에 없는 코드가 있음. 지금 두 묶음이다. ① 계정 병합 차단 사유: openapi `MergeProposal.blockers` 열거값 일곱을 POL-034 행, docs/planning/03 §2.8 T9 행, docs/planning/04 F-11 절 전체(그림과 그 아래 문장), SCR-040 행, docs/features/identity.md §2.1의 '계정 병합 차단 사유' 줄, docs/design/d5 §5.22(SCR-040)의 `blocked` 상태 행과 견준다(뒤의 둘은 2026-10-30에 더했다) ② 입장 중 소유권 동결: 양도 수락(`POST /v1/transfers/{offerId}/acceptance`)·돌려주기(`POST /v1/tickets/{ticketId}/returns`)의 409 응답 설명에 적힌 코드(`ENTRY_STARTED`)를 POL-017 행, docs/planning/03 §2.5 T8·T9 행, SCR-013·SCR-041 행과 견준다. 자리마다 코드를 조건 옆 괄호나 코드 표시로 적어 둔다. 코드가 없는 말만으로 적힌 조건은 보지 못한다 |
| adr | — | 결정이 10개를 넘고(`## 결정` 절의 번호 항목 11개 이상) 상태 줄이 1,000자를 넘는 ADR인데 docs/architecture.md §11.1에 그 ADR의 결정별 현재 판 표(`ADR-NNNN(` 머리 줄)가 없음(docs/architecture.md §11, 기술 검토 낮음-150) |
| wbs | wbs.csv의 상위 추정이 하위 합계와 다름, wbs.md와 wbs.csv의 레벨 3 작업 ID·추정이 다름 | — |
| versions | 기획 버전 줄이 없음 | 문서의 '기준 기획 버전'이 docs/planning/01의 기획 버전과 다름 |
| mermaid | 문서의 mermaid 그림을 리더기와 같은 판(tools/doc-check/mermaid/package.json, 지금 12.2.0)으로 읽어 문법 오류가 남. 그림 하나의 원문이 50,000자(mermaid 기본 `maxTextSize`)를 넘음(읽기는 되지만 그릴 때 멈춘다). 흐름도·상태도의 선 라벨 앞 번호(`T1`·`E2`·`F1`처럼 영문 대문자 하나와 숫자)가 그림 아래(다음 제목 전) 표의 첫 칸에 없음(docs/planning/03 §5.5) | 흐름도·상태도의 선이 25개를 넘는데 그림 안에 `%% 선 수 예외: <이유>` 주석이 없음, 40자를 넘는 선 라벨, C4 문법(`C4Context` 등. 자동 배치가 없어 흐름도로 그린다), node나 의존성이 없어 검사를 건너뜀. 상태도 메모를 상태보다 앞에 두어 그려지지 않는 경우처럼 그릴 때만 드러나는 문제는 잡지 못한다(리더기에서 확인) |
| coverage(선택) | — | 원문 링크·영문 용어가 새 문서에 없음 |

마커 수(`markers_all`, `markers_excl_summary_review`)와 ID 정의 수, 링크 수(`links`: 본 링크·위치 표시 수, 마크다운이 아니라 건너뛴 위치 표시, 없는 대상, 맞지 않는 위치 표시, 절대 경로 수), 차단 조건 목록(`blockers`: 묶음마다 API 코드 수와 자리 수), FR→시험 연결 수(`frtrace`: FR 수·연결된 FR 수·시험 행 수), 허용 역할 보고(`roles`: 작업 수, 칸을 단 작업 수, 값마다 단 작업 수), openapi 보고(`api`: 경로·작업 수, 4xx·5xx 응답 수와 그중 Problem 선언 수, `operationId`·호스트·`security`가 빠진 작업 수, 공개 작업 수, If-Match를 받는 작업과 예외 수. `api_hosts`: 호스트별 작업 수. `api_problem_exempt`: Problem 예외 응답 목록. guidelines §12 '자기 서술성 점검', 기술 검토 낮음-032), §11.1 표가 있는 ADR(`adr_decision_tables`), WBS 합계는 정보로만 출력한다. 요약 문서에 숫자를 적을 때는 이 출력을 그대로 옮긴다(손으로 세지 않는다).

## 예외

- 외부 URL 안의 경로 문자열처럼 오탐이 확실한 경로와, 없앤 문서인데 고치지 않는 지난 기록(ADR 본문, review의 지난 행)이 가리키는 경로는 `check_all.py`의 `ALLOW_PATHS`에 이유와 함께 넣는다. 지금은 `docs/software-architecture.md`(AWS 저장소 URL, review R-10), `docs/arc42.md`(ADR-0090으로 없앤 문서, review R-105), `docs/appendix-learning-map.md`(ADR-0097로 없앤 부록, review R-115) 셋이다.
- 링크 검사(`paths`)도 같은 방식을 따른다. 링크 대상 파일은 `ALLOW_PATHS`에 있으면 없어도 된다. 고치지 않는 지난 기록(ADR 본문, review의 지난 행)의 위치 표시가 그 뒤 바뀐 제목을 가리키면 `ALLOW_ANCHORS`에 (링크가 있는 파일, 링크 대상 글자)와 이유를 넣는다. 지금은 비어 있다. 절대 경로 링크는 예외 없이 오류다(review의 지난 행은 `file:///`를 코드 표시 안이나 경로 없는 말로만 적어 걸리지 않는다).
- `blockers` 검사의 묶음과 자리는 `check_all.py`의 `BLOCKER_LISTS`에 둔다. 새 묶음을 더하려면 API 기준(스키마 열거값 또는 작업의 409 응답)과 자리(파일, 절의 첫 낱말, 줄 머리)를 적고, 자리마다 차단 사유 코드를 조건 옆에 적는다(docs/planning/03 POL-034와 §2.8 T9가 본보기다). 계정 병합 차단 사유를 적은 다른 문서 둘(docs/features/identity.md §2.1의 '계정 병합 차단 사유' 줄, docs/design/d5 §5.22의 SCR-040 `blocked` 상태 행)은 2026-10-30에 자리로 넣었다. 병합 확인(`POST /v1/identity/merge-proposals/{proposalId}/confirmation`)의 409 설명은 아직 자리에 넣지 않았다. openapi 응답 설명을 자리로 읽는 종류가 없어(지금 자리는 마크다운 절과 줄뿐이다) 자리 종류를 새로 만들어야 한다.
- `roles` 검사의 정본 위치는 `check_all.py`의 `ROLE_DOC`(docs/security/authz-matrix.md)과 `ROLE_SEC`(5.5)다. 그 절의 번호나 표 모양이 바뀌면 두 값을 함께 고친다. 예외 목록은 없다. 모든 작업이 칸을 가진다.
- tools/는 점검 대상에서 뺀다(예시 문자열이 많다). archive/도 빼는 목록에 남아 있지만, 원문 설계서는 2026-10-27에 지워 git 태그 `archive-original`에만 있다(ADR-0098).
- `api` 검사의 예외는 `check_all.py`에 이유와 함께 둔다. 경로 규칙 예외 `API_EXCEPTIONS`(`/graphql`, RFC 8628 토큰 엔드포인트 `/v1/scanner/token`, 전역 검색 `/v1/search`·`/v1/search/suggestions`), 집합 명사 `API_PLURAL_EXEMPT`(`staff`), 문서가 이름을 대도 openapi에 없어도 되는 경로 `API_REF_ALLOW`(토스페이먼츠 외부 API `/v1/payments/`·`/v1/transactions`·`/v1/settlements`, 프로토타입 전용 `/v1/proto/`, ADR-0080 2단계 초안 `/v1/forensics/`)다. openapi 계약 검사의 예외도 `check_all.py`에 이유와 함께 둔다: `PROBLEM_EXEMPT`(`POST /v1/scanner/token` 400, OAuth 오류)와 확장자 경로의 404, `IF_MATCH_EXEMPT`(`PUT /v1/productions/{productionId}/wish`, `PUT /v1/scanner/shift/readiness`, `PATCH /v1/reviews/{reviewId}`, guidelines §12). openapi의 경로·작업 수와 계약 보고 수(`api` 정보 줄)는 요약 문서의 REST 수치로 그대로 옮긴다.

## 유지보수 규칙

- 새 ID 종류나 새 문서 폴더를 만들면 이 스크립트의 정의 위치·`ALIAS`를 함께 고친다.
- CI 연결은 wbs 0.1.3 작업이다. 문서 리포의 PR마다 `python tools/doc-check/check_all.py`를 돌리고 실패하면 병합을 막는다.
