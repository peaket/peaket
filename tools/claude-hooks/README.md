# tools/claude-hooks — 에이전트 훅

AI 에이전트(Claude Code)가 도구를 쓰기 바로 전이나 바로 뒤에 Claude Code가 대신 돌리는 검사입니다. 문지기처럼 도구 호출을 막거나, 사용자에게 묻거나, 모델에게 할 일을 알립니다. 결정과 판정 표는 [ADR-0330](../../docs/adr/0330-agent-hooks-enforce-repo-rules.md)에 있고, 여기서는 파일과 고치는 법만 적습니다.

| 파일 | 언제 | 하는 일 |
| --- | --- | --- |
| `guard-shell.mjs` | Bash·PowerShell 도구 실행 전·뒤 | 실행 파일. 규칙은 `shell-rules.mjs` |
| `shell-rules.mjs` | — | git·npm·yarn 명령 판정(ADR-0330 결정 3). 커밋 제목은 `tools/ci/conventional.mjs`로 본다 |
| `shell.mjs` | — | 명령 글을 명령 하나씩 낱말로 가른다. heredoc·here-string 본문은 따로 뺀다 |
| `guard-edit.mjs` | Write·Edit·MultiEdit·NotebookEdit 실행 전 | 생성 파일·다른 잠금 파일 편집을 막는다. 규칙은 `edit-rules.mjs` |
| `post-edit.mjs` | Write·Edit·MultiEdit 실행 뒤 | 원천을 고쳤으면 돌릴 생성기·빌드·타입 검사를 세션마다 한 번 알린다 |
| `lib.mjs` | — | 입력 읽기, 판정(막기·묻기·허용·알리기), 저장소 기준 경로, 세션마다 한 번 표시, 무인 모드 상태 |
| `unattended.mjs` | 소유자가 손으로 | 무인 모드 켜기·끄기·상태(ADR-0330 결정 9) |

- 잇는 곳은 공유 설정 [`.claude/settings.json`](../../.claude/settings.json)의 `hooks`입니다. 개인 설정의 훅과 함께 돕니다.
- 훅이 스스로 고장 나면(입력이 깨짐, 규칙이 예외를 던짐) 막지 않고 통과합니다. 실수를 막는 난간이지 보안 경계가 아닙니다.
- 규칙을 고치거나 더하면 [`tools/ci/claude-hooks.test.mjs`](../ci/claude-hooks.test.mjs)에 경우를 더합니다. 시험 입력은 시험 파일 안에 둡니다. 셸 명령줄로 넘기면 시험하려는 명령을 훅이 먼저 막습니다.

```bash
node --test tools/ci/claude-hooks.test.mjs
```

- 새 생성기를 만들면 생성 파일 첫 줄에 `# 생성 파일이다. 손으로 고치지 않는다(원천 …에서 …가 만든다)` 꼴의 주석을 답니다. 그러면 따로 등록하지 않아도 편집이 막힙니다. 주석을 달 수 없는 형식(JSON 등)은 `edit-rules.mjs`의 `GENERATED`에 경로와 명령을 더합니다.

## 무인 모드(자리를 비울 때)

소유자가 자는 동안처럼 권한 물음에 답할 사람이 없을 때 켭니다. 켜 두면 훅의 '묻기'를 묻지 않고 허용하고, 허용한 명령을 기록합니다. '막기'(강제 푸시·`reset --hard` 등)와 `main` 푸시는 그대로 막습니다. 시간을 주지 않으면 `off`로 끌 때까지 켜져 있고(소유자 결정 2026-11-22), 시간을 주면 그만큼 뒤 저절로 꺼집니다.

```bash
node tools/claude-hooks/unattended.mjs on        # 켜기(off로 끌 때까지 시간 제한 없음)
node tools/claude-hooks/unattended.mjs on 9      # 9시간만 켜기(많아야 24, 지나면 저절로 꺼짐)
node tools/claude-hooks/unattended.mjs status    # 상태와 최근 허용 기록
node tools/claude-hooks/unattended.mjs off       # 끄기. 켜 둔 동안 허용한 명령 수를 보여 줌
```

- 상태와 기록은 저장소 뿌리의 `.claude/unattended/`(`on.json`, `allowed.jsonl`)에 있고 git에 올리지 않습니다.
- 세션 권한 모드(auto)는 바꾸지 않습니다. 모드가 다르면 세션 사이 메시지가 승인 대기로 묶입니다.
- 갈래 작업 폴더(링크된 worktree) 안의 가지 만들기·바꾸기와 `feature/*` 푸시는 무인 모드와 상관없이 늘 묻지 않습니다.
