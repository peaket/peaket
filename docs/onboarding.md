# 처음 일을 익히는 안내(온보딩)

- **독자와 용도**: 새로 온 엔지니어가 첫날 저장소를 받아 빌드·시험·데모를 돌리고, 문서 지도와 기능 하나를 끝내는 절차(계획 → 시험 → 구현 → 검수 → 기록)를 찾게 한다. WBS 7.6.1의 '처음 일을 익히는 안내'다.
- **규범이 아니다**: 이 문서는 길잡이다. 명령·값·절차의 정본은 각 문서이고, 둘이 다르면 정본이 이긴다. 정본 값을 여기에 옮겨 적지 않고 **어디를 보면 되는지**만 가리킨다(docs/planning/03-policies-glossary.md §5, ADR-0256 결정 10).
- **언제 고치나**: 명령·경로·도구가 바뀌어 이 안내대로 따라 했을 때 막히면 고친다. 고친 뒤 `python -I -X utf8 tools/doc-check/check_all.py`를 돌린다.

## 1. 첫날 한 줄기

아래 차례대로 하면 된다. 각 단계의 기대 결과가 다르면 그 자리에서 멈추고, 먼저 버전과 잠금 파일을 확인한다.

| # | 무엇 | 명령 | 기대 결과 | 더 읽을 곳 |
| --- | --- | --- | --- | --- |
| 0 | 준비물 확인 | `node -v`, `corepack pnpm -v`, `docker info` | Node·pnpm 판이 저장소가 정한 판과 같고 Docker가 응답한다 | `.nvmrc`, 루트 `package.json`의 `packageManager`, `../tools/local/README.md` |
| 1 | 저장소 받기 | `git clone <저장소 주소>`, `cd peaket` | 작업 폴더가 생긴다 | `../README.md` |
| 2 | 설치 | `corepack pnpm install --frozen-lockfile` | 잠금 파일대로 설치되고, `pnpm-lock.yaml`이 바뀌지 않는다 | `devops.md` §4.4 |
| 3 | 빌드 | `pnpm build` | 모든 작업 공간이 빌드된다. `packages/platform`을 고쳤다면 특히 다시 빌드한다 | `architecture.md` §3.3 |
| 4 | 타입 검사 | `pnpm typecheck` | 오류 0. 의존 패키지를 먼저 빌드한다 | 루트 `package.json` scripts |
| 5 | 단위 시험 | `pnpm test` | 모든 작업 공간의 단위 시험이 통과한다 | `verification.md` §2 |
| 6 | 린트 | `pnpm lint` | 오류 0. 층 의존 방향·보안 규칙·브라우저 지원을 본다 | `architecture.md` §8.3 |
| 7 | 화면 또는 데모 | `apps/README.md`의 개발 서버, 또는 아래 §3의 데모 명령 | 화면이 뜨거나 데모 시나리오가 재생된다 | `../apps/README.md`, `../tools/local/README.md` |
| 8 | 문서 지도 | 아래 §2를 읽고 역할별 첫 문서를 고른다 | 내 역할의 정본 세 개를 찾았다 | `00-summary.md` §2 |
| 9 | 첫 커밋 | 짧은 가지를 따고 문서 한 줄을 고쳐 본다 | 커밋 메시지와 꼬리말이 규칙과 같다 | `architecture.md` §8.5, `devops.md` §2.2 |

- **한 번에 하나만**: 저장소는 여러 세션이 같이 고친다. `pnpm`·Docker·kind를 쓰는 명령은 다른 작업과 부딪히지 않는지 먼저 확인한다. Docker 잠금은 §5에 있다.
- **오래 걸리는 명령**: 첫 `pnpm install`·`pnpm build`·데모 이미지 빌드는 몇 분 걸릴 수 있다. 실패하면 출력의 첫 오류 한 줄을 읽고, 버전 문제인지 잠금 파일 문제인지 먼저 가른다.
- **작은 시험 하나만**: 전체 시험이 오래 걸리면 작업 공간 하나만 돌린다. 예: `pnpm --filter @peaket/queue-svc test test/admission-jwks.test.ts`. 통합 시험(`test-int/`)은 Docker가 필요하고, Docker가 없으면 건너뛰지 않고 실패한다(`CLAUDE.md` '자주 쓰는 명령').

## 2. 문서 지도는 여기서 시작한다

문서 전체의 역할별 읽기 순서는 `00-summary.md` §2가 정본이다. 여기서는 첫날 필요한 세 갈래만 짧게 가리킨다. **표를 복사하지 말고 원문을 따라간다.**

| 내가 맡은 일 | 첫 문서 | 그다음 |
| --- | --- | --- |
| 백엔드(서비스·API·DB) | `architecture.md` | `data.md` → `api/guidelines.md` → `features/README.md` → 내 기능의 `features/*.md` → `adr/` |
| 프론트엔드(팬·파트너·관제·스캐너) | `frontend.md` | `design/d2`·`design/d3`·`design/d5` → `planning/04` → `security/asvs/frontend.md` → `api/openapi.yaml` |
| 운영·플랫폼·배포 | `devops.md` | `verification.md` → `observability.md` → `streaming.md` → `features/control-tower.md` → `infra.md` |

- **정본과 해설서**: `docs/` 아래 문서가 정본이다. `specs/`(규칙 명세)와 `docs/walkthrough/`(해설서)는 정본이 아니다. 해설서가 편해도 값은 정본에서 확인한다(ADR-0097·0098).
- **기획이 먼저**: 왜 이 기능이 있는지, 어떤 정책과 상태를 지켜야 하는지는 `docs/planning/01-overview.md`·`docs/planning/02-requirements.md`·`docs/planning/03-policies-glossary.md`·`docs/planning/04-ia-flows-screens.md`에 있다.
- **용어가 낯설 때**: `docs/planning/03-policies-glossary.md` §4(용어 사전)·§5(쉬운 말과 용어 풀이)를 먼저 본다. 이 저장소는 처음 나오는 전문 용어를 풀어 쓰는 규칙을 따른다.
- **문서을 찾는 다른 길**: `00-summary.md` §2.1은 arc42 칸과 C4 그림으로 정본 위치를 찾는 표다. "이 질문은 어느 문서에 있나"로 찾을 때 쓴다.

## 3. 데모를 돌려 본다

데모는 저장소를 받은 사람이 같은 화면을 다시 만드는 재현 무대다. 상시 데모 서버는 두지 않는다(`verification.md` §7). 명령과 옵션의 정본은 `../tools/local/README.md`와 `tools/local/demo.mjs`의 `쓰는 법`이다.

```bash
node tools/local/demo.mjs doctor     # 선행 점검(도구·이미지·포트). 0이면 다음으로
node tools/local/demo.mjs all        # 무대 → 시드 → S1~S9 → 측정 → 정리
```

- **한 명령으로**: `all`은 위 차례를 한 번에 한다. 중간을 눈으로 보고 싶으면 `up` → `seed` → `play --scenarios S1,S9 --video` → `down`처럼 나눠도 된다.
- **영상**: `play`에 `--video`를 붙이면 브라우저 맥락마다 webm이 생긴다. 위치·이름은 실행 결과의 산출물 폴더 아래 `video/`다. 영상 파일은 저장소에 커밋하지 않는다(ADR-0325, F-08-7 감독 결정 4).
- **시나리오 순서**: 정본은 `docs/design/d5-screen-blueprint.md` §10.6이고, `node tools/local/demo.mjs plan --check`가 정의와 대조한다. 시나리오를 고칠 때는 정본 표를 먼저 고친다.
- **지금 알려진 실패**: 2026-11-25 기준 데모 S1은 대기실 화면과 월렛 QR에서 막혀 있다. 촬영 전 상태와 남은 일은 `docs/review/measurements/F-08-7-demo-script.md`에 적었다. 실패를 통과로 세지 않는다.
- **Docker 잠금**: 데모는 Docker·kind를 쓴다. 다른 갈래가 측정 중이면 잠금을 잡고, 끝나면 놓는다. §5를 먼저 읽는다.

## 4. 기능 하나를 끝내는 길

작업 단위는 '기능 묶음'이다. 기능 목록은 `BUILD_ORDER.md`의 '기능 묶음' 표, 진행 상태는 `PROGRESS.md`, 절차의 정본은 `architecture.md` §8.6이다. 아래는 그 절차를 처음 보는 사람이 따라갈 수 있게 줄인 것이다.

1. **범위와 계획**: 기능 표에서 내 기능의 ID·등급·장부 범위를 확인한다. 장부로 범위를 뽑고(`node tools/ci/ledger.mjs --batch <기능>`), `docs/review/plans/<기능>.md`에 작업 목록을 쓴다. 정본 값을 옮겨 적지 않고 위치만 가리킨다.
2. **정본 빈칸 먼저**: 구현 중에 정해야 할 세부가 나오면 코드보다 정본을 먼저 고친다. 방향을 바꾸는 결정은 멈추고 소유자·감독에게 묻는다.
3. **시험 먼저**: 시험 담당이 구현 전에 시험을 쓰고, 기준 트리에서 새 동작이 실패하는 것을 계획 파일 '실패 확인'에 남긴다. C등급(문구·배치·문서)은 화면 비교와 문서 점검으로 증명하고, 틀린 구현 검사는 하지 않는다(ADR-0331).
4. **구현**: 구현 담당은 고정된 시험을 통과할 때까지 구현하고, 시험은 고치지 못한다. 시험이 정본과 어긋나 보이면 '시험 이의'에 적고 멈춘다.
5. **리뷰와 게이트**: A등급은 시험 리뷰와 구현 리뷰를 한다. B·C등급은 시험 리뷰만 한다. 게이트에서 그 기능이 닿는 CI 잡·린트·문서 점검·시험 ID 대조(`node tools/ci/trace-check.mjs`)·장부 `--require`를 확인한다.
6. **기록**: 역할별 커밋, 단계 줄 체크, 갈래 진행 로그 한 줄, 계획 파일의 '시험 결과'·'검수'를 남긴다. 기록 파일이 너무 커지면 지난 줄을 `progress-archive.md`로 옮긴다(ADR-0283).

- **역할 넷**: 계획·시험·시험 리뷰·구현은 서로 다른 에이전트가 맡는다. 한 에이전트가 두 역할을 맡지 않는다(ADR-0270, ADR-0372). 감독은 지휘·합치기·기록만 한다.
- **C등급**: 이 저장소에는 화면 문구·배치·문서만 고치는 기능도 있다. 그런 기능은 자동 시험 대신 **화면 비교(시각 회귀)·문서 점검·대조표**로 증명한다. 제품 브라우저 확인은 화면이 바뀌는 기능만 웨이브 끝에 모아서 한다(ADR-0331 결정 6).
- **커밋 꼬리말**: `Batch:`, `Feature:`, `Role:`, `Agent-Session:`, `Agent-Model:`을 붙인다. 정확한 형식은 `architecture.md` §8.5와 `devops.md` §2.2, 최근 커밋 메시지를 본다.

## 5. 자주 막히는 곳

| 막히는 곳 | 먼저 확인할 것 | 하지 말 것 |
| --- | --- | --- |
| Docker·kind가 안 뜬다 | 다른 세션이 잠금을 잡았는지(`lock.sh who docker-all`), 멈춤 파일 `pause`가 있는지, 포트가 겹치는지 | 잠금 없이 컨테이너를 띄우거나 남의 클러스터를 지우기 |
| `pnpm install`이 잠금 파일과 다르다고 한다 | Node·pnpm 판, `pnpm-lock.yaml`을 고친 사람이 있는지 | `--no-frozen-lockfile`로 우회해 잠금 파일을 바꾸기 |
| 시험이 갑자기 빨개진다 | 내 변경과 닿는지, 날짜 고정 시험인지, 다른 갈래의 미완 변경이 섞였는지 | 무관한 시험을 고치거나 건너뛰기 표시를 넣기 |
| 생성 파일을 고치라는 안내가 나온다 | 원천이 `docs/api/`인지, `docs/design/tokens.json`인지, `deploy/gateways/routes/`인지 | `src/gen/`, 디자인 토큰, 게이트웨이 라우트를 손으로 고치기 |
| 비밀·개인정보가 보인다 | 합성 계정·가상 티켓만 쓰는지, 토큰·쿠키·내부 주소가 화면·로그·측정 파일에 없는지 | 실제 값으로 시험하거나, 가린 값을 편집으로 지우기 |
| 다른 세션의 변경이 보인다 | `git status`로 내 파일만 골랐는지 | 남의 미완 변경을 스테이징하거나 되돌리기 |
| 방향을 바꾸는 결정이 필요하다 | 정본에 있는지, ADR로 남길 결정인지 | 혼자 정하고 코드부터 고치기 |

- **Docker 잠금 도우미**: `"C:\Program Files\Git\bin\bash.exe" D:/ticketpass-locks/lock.sh take docker-all <태그>`로 잡고, 끝나면 `drop`한다. 멈춤 파일은 감독이 만든다. 규칙의 정본은 `docs/lanes/handoff-2026-11-23.md`와 `docs/architecture.md` §8.6 '맡기기'다.
- **멈추고 물어야 하는 일**: `develop` 밖 원격 가지·태그 푸시, 강제 푸시, 비용이 드는 일, 계정·저장소 만들기, 보안 규칙에 걸리는 일, 정본에 없고 방향을 바꾸는 결정이다(`architecture.md` §8.6 '맡기기').
- **비밀·개인정보**: 합성 데이터만 쓴다. 토큰·쿠키·API 키·내부 주소를 출력·측정·영상에 싣지 않는다(`verification.md` §7, POL-023). 데모 영상의 금지 목록은 `docs/review/measurements/F-08-7-demo-script.md` §6에 있다.

## 6. ADR 읽는 길

ADR(Architecture Decision Record)은 "무엇을 왜 그렇게 정했나"를 한 건씩 남긴 결정 기록이다. 정본 문서가 "지금 규칙"이라면 ADR은 "그 규칙을 고른 이유와 버린 대안"이다.

- **어디에 있나**: `docs/adr/` 아래 `NNNN-<요약>.md`다. 번호순으로 쌓인다. 전체 목록과 결정별 현재 판은 `architecture.md` §11에 있다.
- **어떻게 읽나**: ① 첫 줄 제목과 `상태` 줄(채택·보류·대체)을 본다. ② `맥락`에서 어떤 문제가 있었는지 본다. ③ `결정`에서 지금 지켜야 할 규칙을 찾는다. ④ `검토한 대안`에서 왜 다른 안을 버렸는지 본다. ⑤ `결과·되돌릴 조건`에서 무엇을 잃었고 언제 다시 볼지 확인한다. 모든 ADR에 다섯 칸이 다 있지는 않으므로, 없으면 정본 문서의 같은 주제 절을 함께 본다.
- **어떻게 찾나**: 주제어로 `docs/adr/`를 검색하거나 `architecture.md` §11의 표에서 기능·주제로 찾는다. 최근 결정은 파일 이름의 번호가 큰 것부터 본다. 기능 계획서와 커밋 본문에 근거 ADR 번호가 적혀 있으니, 그 번호로 바로 들어가도 된다.
- **읽을 때 주의**: ADR은 결정 당시의 기록이라 지금 코드와 다를 수 있다. 뒤에 나온 ADR이 앞의 결정을 바꾸면 `상태` 줄에 그 사실이 적혀 있다. 또 ADR 본문은 원칙적으로 고치지 않고, 바뀐 결정은 새 ADR로 남긴다(`00-summary.md` §1). 그래서 "ADR에 이렇게 적혀 있으니 지금도 이렇다"라고 단정하지 말고, 정본 문서와 최신 ADR을 함께 본다.
- **처음 읽을 만한 예**: 검증 전략은 ADR-0057, 완성 기간의 범위·동결은 ADR-0373, 기능 단위와 역할 나누기는 ADR-0256·0270·0372·0373이다. 이 다섯을 읽으면 "왜 이 저장소가 이렇게 일하나"가 잡힌다.
- **새 ADR을 쓸 때**: 번호는 감독에게 받는다(`docs/lanes/coord.md`). 정본에 없는 방향 결정·대안·되돌릴 조건을 적고, `architecture.md` §11의 목록과 기능 계획에 연결한다. 새 ADR은 기존 ADR을 고치는 대신 대체 관계를 적는다.

## 7. 검사 명령

| 무엇 | 명령 | 통과의 뜻 |
| --- | --- | --- |
| 문서 점검 | `python -I -X utf8 tools/doc-check/check_all.py` | 오류 0. 경고는 읽고 판단한다(없던 경고를 늘리지 않는다) |
| 린트 | `pnpm lint` | 오류 0 |
| 타입 검사 | `pnpm typecheck` | 오류 0 |
| 단위 시험 | `pnpm test` | 실패 0 |
| 완성 장부 | `node tools/ci/ledger.mjs --batch <기능> --require` | 그 기능 범위에 빈칸·'ID만' 0 |
| 시험 ID 대조 | `node tools/ci/trace-check.mjs --ids "<ID,…>" --report <보고서>` | 이름에 ID와 세부 번호가 붙은 시험이 있다 |
| 데모 장면 | `node tools/local/demo.mjs plan --check` | 시나리오 정의가 d5 §10.6과 같다 |
| 계약 생성물 | `pnpm --filter @peaket/contracts gen:check` | 생성물이 `docs/api/`와 같다 |
| 화면 생성물 | `pnpm --filter @peaket/api-client test` | 화면 클라이언트가 계약과 같다 |

- **무엇을 돌려야 하나**: 문서만 고쳤으면 문서 점검, 코드를 고쳤으면 그 작업 공간의 시험·타입 검사·린트, 계약을 고쳤으면 생성물 검사까지 돌린다. 전체 CI와 같은 실행은 `pnpm exec turbo run typecheck test build`다(`CLAUDE.md` '자주 쓰는 명령').
- **실패를 통과로 세지 않기**: 측정·데모·브라우저 확인이 실패했으면 '미확인'과 까닭을 기록한다. 기록이 없으면 통과가 아니다.

## 8. 어디에 무엇을 적나

| 남기는 것 | 자리 |
| --- | --- |
| 기능 계획·수용 기준·시험 결과·검수 | `docs/review/plans/<기능>.md` |
| 측정 결과 | `docs/review/measurements/` (측정 파일 이름과 형식은 그 측정의 계획을 따른다) |
| 브라우저 확인 | `docs/review/browser-check/<단계 ID>.md` |
| 성능 장부 | `docs/perf-ledger/runs/`와 장부 색인(`docs/perf-ledger.md`) |
| 결정 | `docs/adr/NNNN-<요약>.md` |
| 갈래 진행 로그 | `docs/lanes/lane<번호>.md` |
| 기능 묶음 진행 | `docs/PROGRESS.md`, 단계 체크는 `docs/BUILD_ORDER.md` |

- **계획 파일 크기**: 한 계획 파일의 크기 목표는 `docs/architecture.md` §8.6 4의 2번을 따른다. 출력을 붙여 넣지 말고 명령·시험 수·실패 수·까닭 한 줄만 적는다.
- **커밋 본문**: 게이트에서 돌린 명령 결과를 한 줄씩 적는다. 정합 점검 행과 요구사항·시험 ID를 잊지 않는다.

## 9. 더 읽을 것

- 전체 문서 지도: `00-summary.md` §2
- 품질·보안 절차: `architecture.md` §8
- 기능 절차·역할: `architecture.md` §8.6
- 가지·커밋: `architecture.md` §8.5, `devops.md` §2.2
- 검증·숫자 표시: `verification.md` §1.3·§7, `perf-ledger.md`
- API 규칙: `api/guidelines.md`
- 화면 앱 구조: `frontend.md` §2
- 데이터: `data.md`
- 보안: `security/`
- 기능 설계서: `features/README.md`
- 개발 서버·포트: `../apps/README.md`
- 로컬 클러스터·데모: `../tools/local/README.md`
- 지금의 작업 상태: `PROGRESS.md`, `BUILD_ORDER.md`, `lanes/lane<번호>.md`

## 10. 이 문서를 고칠 때

- 이 문서는 정본이 아니다. 값·명령·절차가 정본과 달라지면 **정본을 고치고** 이 문서는 정본을 가리키게 고친다. 여기에 정본 값을 복사하지 않는다.
- 링크가 살아 있는지, 명령이 실제로 도는지 확인한다. 확인하지 못한 명령은 "확인하지 못함"과 까닭을 적는다.
- 새로 막힌 곳을 찾으면 §5에 한 줄을 더한다. 같은 막힘이 두 번 나오면 문서의 차례를 바꾼다.
