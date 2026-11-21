# ADR-0330: 에이전트 훅으로 저장소 절대 규칙을 막는다(셸 명령·생성 파일·원천 고친 뒤 할 일) (2026-11-21)

- **상태**: 채택(2026-11-21, 소유자 결정 '1단계 만들기'). 턴 끝 점검(결정 7)은 2단계로 미룬다.
  - 보충(2026-11-21, 소유자 결정: 자는 동안 세션이 권한 물음에 멈추지 않게 '무인 모드'를 켜고 끄기, 그때 남은 묻기는 '자동 허용'): 결정 9를 더하고 결정 3의 두 줄과 결정 6의 마지막 문장을 바꿨다.
  - 바꿈(2026-11-22, 소유자 결정 "따로 다시 잠그기 전까지 시간 제한 없이"): 결정 9의 무인 모드는 시간을 주지 않으면 끌 때까지 켜져 있다.
- **관련**: [CLAUDE.md](../../CLAUDE.md) '절대 규칙', [docs/architecture.md](../architecture.md) §8.6 '맡기기', [docs/devops.md](../devops.md) §2.2.5·§2.2.6 '강제 장치'·§4.4, ADR-0286(합치기 줄), `.claude/settings.json`, `tools/claude-hooks/`, `tools/ci/claude-hooks.test.mjs`
- **관련 ID**: 시험 CH-01~CH-13

## 맥락

- 에이전트 훅은 Claude Code가 도구를 쓰기 바로 전이나 바로 뒤에 대신 돌리는 스크립트다. 문지기처럼 도구 호출을 막거나(deny), 사용자에게 묻거나(ask), 모델에게 할 일을 알린다. CLAUDE.md는 에이전트에게 하는 부탁이라 놓칠 수 있지만, 훅은 매번 돈다.
- 이 저장소는 여러 세션이 같은 작업 트리를 함께 고친다. `git add -A`·`git commit -a`·`git reset --hard`·`git stash` 한 번이면 다른 세션의 미완 변경이 내 커밋에 섞이거나 사라진다. CLAUDE.md에 '내가 고친 파일만 골라 스테이징한다'는 규칙이 있지만 기계가 막지 않았다.
- 강제 푸시 금지는 `.claude/settings.json`의 권한 거절(`permissions.deny`) 목록에 `Bash(...)` 꼴로만 있었다. 이 환경의 주 셸인 PowerShell 도구로 내린 `git push --force`는 막지 않았다(2026-11-21 확인).
- 생성 파일(계약 생성물 `src/gen/`, 디자인 토큰, 게이트웨이 라우트, 메시·Kyverno 정책, 로컬 대시보드)은 생성기로만 고친다는 규칙이 있다. 손으로 고치면 CI의 생성 대조(`gen:check`·`--check`)가 커밋 뒤에야 잡는다.
- 원천(`docs/api/`, `packages/platform` 등)을 고친 뒤 돌려야 할 생성기·빌드·타입 검사는 CLAUDE.md 여러 곳에 흩어져 있고, 빠뜨리면 CI나 다른 세션이 늦게 알아챈다.
- 외부 예시(공개 저장소 `joshephan/claude-code-master-class`의 `scripts/hooks`)를 읽었다. 판정 함수 묶음, 커밋 메시지·heredoc 본문을 검사에서 빼는 처리, 시험 입력을 셸 명령줄이 아니라 시험 파일 안에 두는 방식은 쓸 만했다. 규칙 내용은 다른 프로젝트(Prisma·gcloud) 것이었다. 셸 검사는 Bash 도구에만 걸었고, 경고하면서 권한 확인을 건너뛰게 하는(`allow`) 함수가 있었고, 턴 끝 점검이 작업 트리 전체를 봐서 다른 세션의 변경에 걸린다. 그래서 그대로 들이지 않는다.

## 결정

1. **훅은 `tools/claude-hooks/`에 두고 공유 설정 `.claude/settings.json`으로 잇는다.** 규칙 모듈(`shell-rules.mjs`·`edit-rules.mjs`)과 얇은 실행 파일(`guard-shell.mjs`·`guard-edit.mjs`·`post-edit.mjs`)로 나눈다. 의존성 없는 Node 스크립트이고, 커밋 제목 규칙은 `tools/ci/conventional.mjs`를 그대로 가져다 쓴다(같은 규칙을 두 곳에 두지 않는다). 시험은 `tools/ci/claude-hooks.test.mjs`이고 `tools-check`가 돌린다(`tools/` 아래가 바뀌면 `tools` 범위, 워크플로는 고치지 않는다).
2. **셸 검사는 Bash와 PowerShell 도구 둘 다 건다.** 명령 글을 구분자(`;`·`&&`·`|`·줄바꿈·`$(` 등)로 갈라 맨 앞 낱말이 `git`·`npm`·`yarn`인 명령만 본다. heredoc과 PowerShell here-string 본문, 따옴표 안 글은 명령으로 보지 않는다. 그래서 `echo "git add -A"`나 커밋 메시지 속 명령 이름에는 걸리지 않는다.
3. **셸 검사의 판정**:

   | 명령 | 판정 | 근거 |
   | --- | --- | --- |
   | `git add -A`·`--all`·`-u`·`.`·`:/`(경로 없이), `git commit -a` | 막기 | CLAUDE.md '내가 고친 파일만 스테이징' |
   | 폴더나 글롭을 통째로 `git add` | 묻기 | 같은 규칙. 폴더 안에 다른 세션의 파일이 섞일 수 있다 |
   | `git reset --hard`, `git clean -f`, 작업 트리 전체 `git checkout`·`git restore` | 막기 | 다른 세션의 미완 변경을 버린다 |
   | 경로를 준 `git checkout -- <경로>`·`git restore <경로>`, 메인 작업 트리의 `git switch`·`checkout -b`, `git stash`(목록·보기 밖) | 묻기 | 내 파일이면 쓸 수 있다. 공유 작업 트리에서 가지를 바꾸면 다른 세션 파일이 섞인다(docs/devops.md §2.2.5) |
   | 링크된 worktree(갈래 작업 폴더) 안의 `git switch`·`checkout -b`. 같은 명령줄의 `cd`·`Set-Location`과 `git -C`를 따라 가린다 | 통과 | 작업 폴더는 한 세션만 쓴다(결정 9) |
   | 강제 푸시(`--force`·`-f`·`+refspec`), develop·main으로 `--force-with-lease` | 막기 | §8.6 '맡기기', ADR-0286 |
   | develop·`feature/*` 밖 원격 가지·태그 푸시, `--tags`·`--all`, `feature/*` 밖 원격 지우기, `git update-ref` | 묻기 | §8.6 '맡기기'(소유자에게 묻는 일), ADR-0286 |
   | `git push origin develop`·`HEAD:develop`, 로컬 `git push . …` | 통과 | 합치기 줄(ADR-0286) |
   | `feature/*` 가지 올리기, 그 가지만의 `--force-with-lease`, 그 가지 지우기 | 통과 | 소유자 허락 2026-11-16(docs/PROGRESS.md 턴 규칙 '원격 올리기': 초안 PR CI용으로 올리고, 자기 가지는 lease로 다시 올리고, 합친 뒤 지운다) |
   | `npm`·`yarn` 설치 명령 | 막기 | docs/devops.md §4.4(pnpm 작업 공간 전용) |
   | 커밋 제목이 Conventional Commits 꼴이 아니거나 허용 종류 밖, 본문 `BREAKING CHANGE`인데 제목에 `!` 없음 | 막기 | docs/devops.md §2.2.5·§2.2.6 |
   | 커밋 뒤 제목 끝에 ID 괄호(예 `(LCH-080)`)가 없음 | 알리기(실행 뒤) | CLAUDE.md. ID가 딸리지 않는 정리 커밋도 있어 막지 않는다 |

   한 명령에 막기와 묻기가 섞이면 막기가 이긴다.
4. **편집 전에 생성 파일과 다른 잠금 파일을 막는다.** 대상은 `packages/{contracts,api-client,ds}/src/gen/`, `deploy/local/dashboards/*.json`, 첫 줄(`#!` 줄 다음)이 주석 `생성 파일이다`로 시작하는 파일(게이트웨이 라우트·메시 정책·Kyverno 정책), `package-lock.json`·`npm-shrinkwrap.json`·`yarn.lock`, 손으로 고친 `pnpm-lock.yaml`이다. 막는 까닭에 원천과 돌릴 생성기를 적는다. 생성기는 Node로 파일을 쓰므로 막히지 않는다.
5. **편집 뒤에 원천을 고쳤으면 할 일을 세션마다 한 번 알린다.** `docs/api/openapi.yaml`이면 contracts·api-client 생성과 게이트웨이 라우트 생성, `asyncapi.yaml`·`proto/`이면 contracts 생성(proto는 메시 정책도), 라우트·메시·Kyverno 원천과 디자인 토큰이면 그 생성기, `packages/platform/src`이면 platform 빌드(지표 목록이면 대시보드도), `packages/seatmap/src`·`services/{payment-svc,pg-simulator}/src`이면 상대 경로로 가져다 쓰는 core-svc·purchase-svc 타입 검사다. 알림은 막지 않는다.
6. **훅이 스스로 고장 나면 막지 않고 통과시킨다.** 입력이 깨지거나 규칙이 예외를 던지면 출력 없이 끝 코드 0이다. 훅은 실수를 막는 난간이지 보안 경계가 아니다. 셸 글을 대충 읽으므로 마음먹고 돌아가는 길(변수에 담은 명령, `bash -c` 속 글 등)은 막지 못한다. 권한을 대신 허락하는(`allow`) 판정은 결정 9의 무인 모드에서 '묻기'를 바꿀 때만 쓴다.
7. **턴 끝 점검(Stop 훅)은 2단계로 미룬다.** 원천은 바뀌었는데 생성물이 그대로인 채 턴을 끝내는 일을 막으려면, 작업 트리 전체가 아니라 이 세션이 고친 파일만 봐야 한다(다른 세션의 미완 변경에 걸리지 않게). 그 기록 방식을 정한 뒤 더한다.
8. **강제 푸시 권한 거절 목록에 `PowerShell(...)` 꼴을 더한다.** 훅과 권한 거절이 같은 일을 두 겹으로 막는다. 권한 거절은 훅이 고장 나도 남는다.
9. **갈래 작업 폴더와 무인 모드(보충 2026-11-21).** 웨이브 12에서 갈래 세션이 묶음마다 새 가지를 만들고(`git switch -c`) 초안 PR용으로 `feature/*`를 올릴 때마다 물음에 걸려 멈췄다. 소유자가 자는 동안에는 답할 사람이 없다.
   - 링크된 worktree(뿌리의 `.git`이 파일) 안의 가지 만들기·바꾸기와 `feature/*` 푸시·lease·지우기는 묻지 않는다(결정 3 표). 메인 작업 트리는 그대로 묻는다.
   - 무인 모드: `node tools/claude-hooks/unattended.mjs on [시간]`으로 켜고 `off`로 끈다. 시간을 주지 않으면 `off`까지 켜져 있고(2026-11-22 바꿈, 처음에는 기본 12시간), 시간을 주면 그만큼(많아야 24시간) 뒤 저절로 꺼진다. 상태는 저장소 뿌리의 `.claude/unattended/`(기록하지 않음)에 있다.
   - 켜져 있으면 남은 '묻기'(폴더 통째 스테이징, 경로 되돌리기, 메인 작업 트리의 가지 바꾸기, `stash`, develop·`feature/*` 밖 푸시, 태그 푸시, 원격 지우기, `update-ref`)를 허용(`allow`)으로 바꾸고, 명령·세션·까닭을 `.claude/unattended/allowed.jsonl`에 한 줄씩 남긴다. 소유자가 `off`나 `status`로 아침에 본다.
   - `main` 푸시(출시)만은 무인 모드에서 허용하지 않고 막는다. 소유자가 정할 일이라 아침에 다시 한다. '막기'(결정 3)는 무인 모드에서도 그대로다.
   - 세션 권한 모드는 바꾸지 않는다(모두 auto). 모드가 다르면 세션 사이 메시지가 사용자 승인 대기로 묶여 밤새 조율이 멈추기 때문이다.

## 결과

- 이 저장소의 모든 세션과 갈래 worktree(합친 뒤)에서 위 명령·편집이 도구 단계에서 막히거나 물어진다. 2026-11-21에 이 세션에서 Bash·PowerShell 둘 다 잘못된 제목의 `git commit --dry-run`이 막히는 것을 보았다.
- 도구 호출마다 Node 프로세스가 하나씩 더 돈다(2026-11-21 이 Windows 기기에서 한 번에 0.2초 안팎).
- 개인 설정(`.claude/settings.local.json`)의 기록용 훅은 그대로 함께 돈다.
- 되돌릴 조건:
  - 오탐으로 묻기·막기가 잦으면(한 주에 정상 작업이 세 번 넘게 막히면 [가정]) 그 규칙을 묻기나 알리기로 낮추고 이 ADR에 적는다.
  - 작업 가지·PR로 바꾸면(사람이 늘어 1인 기간이 끝나면, §8.5) 'develop 밖 푸시 묻기'는 가지 규칙에 맞춰 다시 정한다.
  - Claude Code가 같은 일을 하는 기본 기능(예: 생성 파일 표시를 읽는 편집 보호)을 내면 그 기능으로 옮긴다.
  - 무인 모드(결정 9)에서 허용한 명령이 다른 세션의 변경을 날리거나 섞은 일이 한 번이라도 생기면, 그 종류는 무인 모드에서 막기로 바꾼다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| 외부 예시 훅을 그대로 들인다 | 규칙이 다른 프로젝트 것이고(Co-Authored-By 금지는 우리 커밋 규칙과 반대), PowerShell을 보지 않으며, 턴 끝 점검이 다른 세션의 변경에 걸린다 |
| 권한 거절 목록(`permissions.deny`)만 쓴다 | 명령 글의 앞머리 꼴만 맞춰 보므로 `cd x && git add -A`·`git -C x add .` 같은 꼴을 놓치고, 커밋 제목·생성 파일 머리줄처럼 내용을 보는 판정을 하지 못한다 |
| git 훅(pre-commit 등)으로 막는다 | 사람의 커밋까지 막고, `git add`·`reset`·`stash`처럼 커밋이 아닌 명령은 보지 못한다. 생성 파일 편집은 커밋 때가 아니라 편집 때 막아야 되돌릴 일이 적다 |
| CLAUDE.md에 규칙을 더 세게 적는다 | 이미 적혀 있는데도 놓친다. 반드시 지켜야 하는 규칙은 기계가 막는다 |
