# 작업 계획: W12-tools(tools-check의 데모 시드 권한·선행 없는 all의 kubectl 호출)

- **무엇**: `develop` CI `tools-check / tools`의 `node --test "tools/local/*.test.mjs"`가 BAT-086·087 뒤로 매번 두 시험에서 실패한다(실행 44910775075: 259개 중 257 통과·2 실패, 감독 훅 커밋 실행 44910838349도 같음). tools를 건드리는 모든 PR이 빨갛다. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane4-tools`(가지 `feature/lane4-W12-tools`, 출발점 `origin/develop` `dd9f08485`).
- **등급·차례**: 버그 고침이라 재현 시험부터 쓴다(§8.6의 5). 계획 → 시험 → 구현 → 리뷰·검증, ADR 없음.
- **정본**: `docs/infra.md` '로컬 데모의 비밀', `docs/verification.md` §7 '재현 스크립트', BAT-087 계획 §6 DS-12, BAT-086 계획 B4·V-T7 ②. 빈칸 둘을 이 계획 커밋에서 추천안으로 채웠다(아래 1의 1·2 '바른 동작').

## 감독에게

1. **문제 설명 바로잡기(SWC)**: `ERR_SWC_NATIVE_CACHE`는 web/seats 잡에만 있고 node 잡에는 없다(node 잡은 컨테이너가 아니라 `/home/runner`에서 돌고, `@swc/core postinstall: Done`만 있다). node 잡의 실패는 `@peaket/partner#test`의 `konva는 CMP-051 폴더 밖에서 가져오지 않는다` 시험이고, 이 묶음 밖이다(주인 갈래에 알릴 거리).
2. **참고**: Windows 통과는 거짓 통과였다. 같은 꼴이 V-T7 ②에도 있어 기록 장치를 함께 바꾼다(아래 1의 2). 방향 결정은 없다.

## 계획

### 1. 범위와 바른 동작

1. **DS-12 권한 단언 — 시험이 틀렸다(시험 담당 몫).**
   - 원인: `tools/local/demo-seed.test.mjs:532-543`이 저장소 파일 여섯(시드 `base.yaml`, `demo-auth`·`demo-seed`·`demo-objects.mjs`, 두 `scripts/seed-demo.mjs`)에 `mode & 0o077 === 0`을 요구한다. git은 권한을 100644·100755만 담아(여섯 모두 100644) 우분투 체크아웃은 늘 644다. Windows는 `win32` 조건으로 건너뛰어 통과한다.
   - 정본 판정: DS-12(BAT-087 계획 §6)는 "`.cache` 밖에 비밀 파일이 없고, 저장소에 새 비밀 파일이 없다"이고, 0600은 `infra.md`·B9가 `.cache/peaket-tools/demo-secrets/`에만 건다. 여섯 파일은 비밀 없는 원본이라 체크아웃 뒤 `chmod`로 600을 주는 쪽은 틀리다.
   - 바른 동작: 저장소 파일 권한 단언을 지우고, 권한은 `prepareDemoSecrets`가 만드는 `.cache` 비밀 파일에서 본다(POSIX만, Windows는 건너뜀 표시. `tools/local/v0-token.test.mjs:112` 꼴).
   - 코드 빈틈(작음, 구현 몫): `writeFileSync(..., { mode: 0o600 })`의 `mode`는 새 파일에만 듣는다. `tools/local/demo-auth.mjs:122`(있던 비밀 파일에 키를 채워 다시 씀)와 `:502`(`sessions.json` 다시 씀)는 있던 파일이 넓으면 그대로 둔다. 추천안으로 정본에 "새로 만들 때와 다시 쓸 때 모두 0600"을 적었다(`infra.md` '로컬 데모의 비밀', 추천 적용 2026-11-21).
2. **V-T7 ⑦ kubectl 호출 — 코드가 틀렸다(구현 몫), 시험 장치도 고친다(시험 담당 몫).**
   - 원인: `runAll`의 선행 없음 갈래(`tools/local/demo.mjs:377-384`)가 `write(report)` → `measurementOf`(`:314-324`) → `toolVersion`(`:202`)으로 docker `--version`·kind `version`·kubectl `version --client --output=json`을 실행한다. 정본(`verification.md` 재현 스크립트, B4, 시험 머리 주석 "클러스터 명령 기록 0")은 선행이 없으면 계속하지 않는다.
   - 왜 우분투에서만 실패하나: PATH의 진짜 kubectl 때문이 아니다(가짜 뿌리 `demo.test.mjs:89-99`가 PATH를 가짜 `bin` 하나로 바꾼다). 우분투의 가짜 `kubectl`은 0755 셸 스크립트라 실행되어 기록이 남는다. Windows의 가짜는 `kubectl.cmd`인데, Node 24는 `.cmd`를 셸 없이 `spawnSync`하면 EINVAL로 거절한다(CVE-2024-27980 고침, 이 PC Node 24.18.0에서 확인). 가짜가 돌지 않아 기록이 비고 거짓 통과한다. 이 PC에서 `node:child_process` 가로채기로 돌리면 docker·kind·kubectl 판 확인 셋이 기록된다(손 확인).
   - 바른 동작(정본에 추천안으로 적음, `verification.md` 재현 스크립트): 선행이 없으면 kubectl·docker·kind·helm을 판 확인까지 하나도 실행하지 않는다. 측정의 도구 판 칸은 찾은 도구 '판 확인 안 함', 못 찾은 도구 '없음'. 선행이 모두 있으면(무대가 나중에 실패해도) 지금처럼 판을 잰다.
   - 시험 장치: V-T7 ②·⑦의 "명령 기록 0"은 OS와 상관없이 기록이 남는 `node:child_process` 가로채기(`fakeKubectlHook` 꼴, `:107-158`)로 본다. 가짜 kubectl 파일은 doctor가 찾는 데만 쓴다.
3. **SWC 판정: 노이즈다.** 근거(실행 44910775075 web/seats 잡): 13:50:27.50 `ERR_SWC_NATIVE_CACHE`(cache root `/github/home/.cache`) → 13:50:28.09 wasm 대체 설치 실패 문구 → 같은 줄 차례로 `@swc/core postinstall: Done`(설치 계속) → 실패 단계는 13:50:31.81 tsc `TS2307 Cannot find module '@peaket/search-normalize/refine'`·`TS7006`(SWC를 쓰지 않는 타입 검사, 갈래 2 몫). node 잡에는 그 경고가 없다(감독에게 1). 이 묶음은 고치지 않는다.

### 2. 손댈 파일(구현 몫, 시험 파일 제외)

| 파일 | 할 일 | 영역 |
| --- | --- | --- |
| `tools/local/demo.mjs` | `measurementOf`가 도구를 실행할지 받는다. `runAll`은 `issues.ok`일 때만 실행하고, 아니면 `doctorChecks().tools`로 '판 확인 안 함'·'없음'을 적는다 | 갈래 4 |
| `tools/local/demo-auth.mjs` | 비밀 JSON 쓰기 도우미 하나(내보냄): 폴더 만들기 → `writeFileSync(mode 0o600)` → `chmodSync(0o600)`. `:122`·`:162`·`:502` 세 자리를 그리로 모은다 | 갈래 4 |

시험 담당 몫: `tools/local/demo-seed.test.mjs`(DS-12 권한 루프 지움), `tools/local/demo.test.mjs`(V-T7 ②·⑦ 기록 장치, W12T-02), `tools/local/demo-auth.test.mjs`(W12T-01 ②~④).

### 3. 시험 목록

- 시험 담당은 먼저 `peaket-test-antipatterns` 스킬을 읽는다. 이름은 `W12T-0n ①` 꼴. ★는 지금 트리(`dd9f08485`)에서 실패해야 한다. Docker·클러스터는 쓰지 않는다.
- POSIX 권한 세부(W12T-01 ②③)는 Windows에서 건너뛴다(건너뜀 표시). 재현은 초안 PR CI(우분투) `tools-check / tools`가 맡는다. 손으로 보려면 Linux 컨테이너에서 `git archive` 사본에 `corepack pnpm install --frozen-lockfile` 뒤 그 파일을 돌린다(Docker 잠금 `bash D:/ticketpass-locks/lock.sh take docker lane4-W12-tools` … `drop`).

| 시험 | 파일 | 단언 | 지금 실패 까닭 |
| --- | --- | --- | --- |
| W12T-01 ① ★ | demo-seed.test.mjs | DS-12 `--check` 시험이 저장소 파일 권한을 보지 않고, 시드 폴더 비밀 파일 없음·출력 비밀 없음은 그대로 | 실행 44910775075에서 `base.yaml … (644)`(새 시험 코드 없음, '실패 확인'에 그 실행을 적는다) |
| W12T-01 ② | demo-auth.test.mjs | 임시 `secretsFile`로 `prepareDemoSecrets` → 새 파일 `mode & 0o777 === 0o600`(POSIX) | 지금 통과(지킴) |
| W12T-01 ③ ★ | demo-auth.test.mjs | 키 하나(`serverActionsKey`)를 뺀 0644 비밀 파일 → `prepareDemoSecrets` → 0600으로 좁혀짐(POSIX) | 644가 남는다 |
| W12T-01 ④ ★ | demo-auth.test.mjs | 도우미를 가져와 0644 파일에 쓰면 0600(POSIX). `demo-auth.mjs` 안 `writeFileSync(`는 도우미 안 한 곳뿐(모든 OS) | 도우미가 없고 `writeFileSync(` 셋 |
| W12T-02 ① ★ | demo.test.mjs | 선행 없는 `all`을 가로채기로 돌리면 `spawnSync` 기록에 kubectl·docker·kind·helm이 0, exit 1, 결과 '실패(선행 없음)', 시나리오 모두 미실행 | 판 확인 셋이 기록된다(Windows에서도 실패) |
| W12T-02 ② ★ | demo.test.mjs | ①의 측정 파일 도구 판 칸: 가짜 뿌리에 있는 kubectl은 '판 확인 안 함', 뺀 도구(`tool:helm`)는 '없음' | 지금 '있음'·'없음' |
| W12T-02 ③ | demo.test.mjs | 선행이 모두 있고 가로채기가 `cluster.mjs demo`를 exit 1로 돌려주면 측정에 '실패(무대 exit 1)'이고 기록에 kubectl `version --client --output=json`이 있다(판을 잰다. 기록 장치 자기 확인도 겸함) | 지금 통과(지킴) |
| W12T-02 ④ | demo.test.mjs | V-T7 ② doctor도 가로채기로 돌려 `spawnSync` 기록 0 | 지금 통과(Windows 거짓 통과를 막는 장치 바꿈) |

### 4. 틀린 구현 표본(검증 담당용)

| # | 틀린 구현 | 잡을 것 |
| --- | --- | --- |
| M1 | 선행 없음 갈래가 도구 판을 그대로 잰다(지금 코드) | W12T-02 ① |
| M2 | kubectl만 건너뛰고 docker·kind 판은 실행 | W12T-02 ① |
| M3 | 도구 판을 늘 '판 확인 안 함'(선행이 있어도 안 잼) | W12T-02 ③ |
| M4 | 선행 없음이면 측정 파일을 아예 쓰지 않는다 | 기존 V-T7 ⑦·W12T-02 ① |
| M5 | 도우미가 `mode`만 주고 `chmodSync`를 하지 않거나, `sessions.json` 쓰기를 도우미 밖에 남김 | W12T-01 ③·④(POSIX 세부는 CI) |

### 5. 범위 밖

- web/seats 잡(갈래 2)·node 잡 partner 시험·SWC 경고. `.cache` 폴더 권한(0700)은 정본에 없어 하지 않는다.

### 6. 게이트

- 로컬(Docker 없음): `node --test tools/local/demo-seed.test.mjs tools/local/demo.test.mjs tools/local/demo-auth.test.mjs`, 이어 `node --test "tools/local/*.test.mjs"`(실패 0, 건너뜀은 Windows POSIX 권한·openssl 부재만), `pnpm lint`, `python tools/doc-check/check_all.py`(오류 0), `node tools/ci/roles-check.mjs`.
- 초안 PR CI `tools-check / tools` 성공(우분투에서 W12T-01 ②③④ 실제 실행, 실패 0). 다른 잡의 빨강은 위 5와 견줘 이 묶음 몫이 아님을 적는다.

## 실패 확인

- 까닭: 버그 고침이라 고치기 전 트리(계획 `843b50dfb` 위에 시험만 더함)에서 ★ 시험이 실패하는지 본다(§8.6의 5, ADR-0281).
- W12T-01 ①: 실행 44910775075 `tools-check / tools`에서 `…/deploy/envs/demo/seed/base.yaml의 권한이 너무 넓다(644)`. 이 PC(win32)는 옛 단언을 건너뛰어 통과했다. 새 시험은 저장소 파일 권한 루프를 지웠다.
- 명령: `node --test tools/local/demo-seed.test.mjs tools/local/demo.test.mjs tools/local/demo-auth.test.mjs` → 시험 60, 실패 3, 건너뜀 3(W12T-01 ②③④ POSIX 세부. Windows라 건너뛰고 우분투 CI `tools-check / tools`가 본다). `node --test "tools/local/*.test.mjs"` → 시험 265, 실패 3(같은 셋), 건너뜀 4(위 셋 + BSL050 0600). demo-seed DS-05·06은 identity-svc `dist`가 없으면 모듈 없음으로 실행조차 안 돼 `pnpm exec turbo run build --filter=@peaket/identity-svc` 뒤에 쟀다.
- 실패 까닭: W12T-01 ④(모든 OS) `demo-auth.mjs`가 `writeSecretJson`을 내보내지 않음 / W12T-02 ① 시드가 빠진 `all`에서 판 확인 셋(`docker --version`·`kind version`·`kubectl version --client --output=json`)이 기록됨(Windows에서도) / W12T-02 ② 도구 판 칸이 docker·kind·kubectl '있음'이고 helm 칸이 없음. 통과(★ 아님): W12T-02 ③(판을 잼, 기록 장치 자기 확인)·④(doctor 기록 0). W12T-01 ③④ POSIX 세부(있던 파일에 `mode`가 듣지 않아 644가 남음, 도우미 없음)는 CI에서 실패해야 하고, ②는 지금도 맞다.

## 구현 메모

- `tools/local/demo-auth.mjs`: `writeSecretJson(file, value)`를 내보낸다(폴더 만들기 → `writeFileSync(mode 0o600)` → `chmodSync(0o600)`, 있던 넓은 파일도 좁힌다). 빠진 키 채우기·새 비밀 파일·`sessions.json` 세 자리를 이리로 모아, 주석 밖 `writeFileSync(`는 이 함수 안 한 곳뿐이다.
- `tools/local/demo.mjs`: `measurementOf`가 `probeTools`를 받고 `runAll`은 `issues.ok`를 넘긴다. 선행이 없으면 docker·kind·kubectl·helm을 판 확인까지 실행하지 않고, 찾은 도구는 '판 확인 안 함', 못 찾은 도구는 '없음'이다. 도구 판 칸에 helm(`version --short`)을 더했다.
- 게이트웨이 라우트 생성물: W12-prf192가 `docs/api/openapi.yaml`을 고친 뒤 `--write`를 빠뜨려 `deploy/gateways/*.routes.yaml` 다섯의 계약 sha256 줄이 옛 값이었다(재현 시험 `tools/ci/gateway-routes.test.mjs` D-T42 ①② 실패). `node tools/ci/gateway-routes.mjs --write`로 다시 만들었고 `git diff`는 다섯 파일의 sha256 줄(줄 2)뿐이다. 따로 커밋한다.
- 게이트(win32, Docker 없음): 세 시험 파일 시험 60·통과 57·실패 0·건너뜀 3(W12T-01 ②③④ POSIX). `node --test "tools/local/*.test.mjs"` 265·통과 261·실패 0·건너뜀 4(위 셋 + BSL050 0600). `gateway-routes.mjs --check` exit 0(고치기 전 5건 다름). `gateway-routes.test.mjs` 41·실패 0(고치기 전 D-T42 ①② 실패 1). 바꾼 두 파일 `pnpm exec eslint` 0. `check_all.py` 오류 0·경고 4(이 묶음 밖).

## 시험 결과

- 구현 트리(`f1858a8c2`, win32, Docker 없음): `node --test "tools/local/*.test.mjs"` → 시험 265, 실패 0, 건너뜀 4(W12T-01 ②③④ POSIX 세부 + BSL050 0600). `node --test tools/ci/gateway-routes.test.mjs` → 시험 41, 실패 0, 건너뜀 0.
- POSIX 세부 W12T-01 ②③④는 초안 PR CI `tools-check / tools`(우분투)로 본다.

## 리뷰

- 범위: `git diff origin/develop...HEAD`(계획 8a2559ade, 시험 36fea8aec·fb509ac89, 구현 3983d07cb·f1858a8c2)와 정본 두 줄(`docs/infra.md` '로컬 데모의 비밀', `docs/verification.md` 재현 스크립트), `tools/ci/gateway-routes.mjs` 머리 주석·해시 계산.
- 대조 결과: 계획 §2의 두 파일과 §3의 시험 여덟이 모두 있다. 비밀 쓰기 세 자리(빠진 키 채우기·새 파일·`sessions.json`)가 `writeSecretJson`(0600으로 쓰기 → `chmodSync` 0600) 하나로 모였고, 저장소 파일 권한 단언은 지워져 git 권한 그대로다. 선행이 없으면 `runAll`이 `issues.ok`(거짓)를 넘겨 도구 넷을 판 확인까지 실행하지 않고, 도구 판 칸은 찾은 도구 '판 확인 안 함'·못 찾은 도구 '없음'이다(helm 칸 더함). 선행이 모두 있으면 지금처럼 판을 잰다. 정본과 어긋남 없음.
- 시험 장치: `childProcessRecorder`는 `node:child_process`를 통째로 바꿔 실제 실행을 막고, 훅이 실렸는지(`loaded() === 1`)를 매번 단언해 빈 기록이 통과로 새지 않는다. W12T-02 ③이 같은 장치로 kubectl 판 확인 기록을 잡아 기록 장치의 양성 대조를 겸한다. 이 PC(win32)에서 세 시험 파일 시험 60·통과 57·실패 0·건너뜀 3(W12T-01 ②③④ POSIX).
- 라우트 생성물: 다섯 파일의 줄 2(계약 sha256)만 바뀌었고, 브랜치 위 `docs/api/openapi.yaml`은 그대로다. `node tools/ci/gateway-routes.mjs --check` exit 0(생성기는 openapi의 정규화 JSON으로 해시를 잰다)이라 생성기 결과다.
- 커밋 나눔: 시험 커밋은 시험 파일 셋과 계획만, 구현 커밋은 `demo-auth.mjs`·`demo.mjs`와 계획('구현 메모')만, 라우트 커밋은 생성물 다섯만 건드렸다. 구현 커밋이 시험 파일을 바꾸지 않았다. 라우트 다시 만들기는 계획 §2 표 밖이지만 '구현 메모'에 까닭(W12-prf192가 `--write`를 빠뜨림, D-T42 ①② 실패)을 적었다.

| # | 등급 | 자리 | 근거 · 방향 |
| --- | --- | --- | --- |
| RV-01 | 중간 | `tools/local/demo-auth.mjs:110-111` | 있던 넓은(0644) 파일은 `writeFileSync`가 같은 inode(파일 본체)를 잘라 새 비밀을 다 쓴 뒤에야 `chmodSync`로 좁힌다. 그 틈에 열린 읽기와, 넓을 때 이미 열어 둔 읽기 핸들은 새 내용(채운 `serverActionsKey`·새 세션 쿠키)을 읽는다(권한은 열 때만 본다). 두 호출 모두 기호 연결(symlink)도 따라간다. 다만 이 틈은 파일이 이미 넓은 채 다른 비밀을 담고 있던 때만 생겨 더해지는 노출이 작고, 정본의 끝 상태(0600)는 맞아 막지 않는다. 방향: 같은 폴더의 임시 파일을 `{ flag: 'wx', mode: 0o600 }`으로 쓰고 `renameSync`로 바꿔 끼운다(새 inode라 옛 핸들이 새 비밀을 못 읽고, 기호 연결은 따라가지 않고 바꾸며, 쓰다 멈춰도 반쪽 파일이 남지 않는다). W12T-01 ④의 `writeFileSync(` 한 곳 단언과도 맞는다. |
| RV-02 | 낮음 | `tools/local/demo.test.mjs:135`·`:147`·`:173` | 가짜 `execSync`·`exec`는 셸 명령 글 전체를 `exe`로 적어(`kubectl version --client`), `toolCalls()`가 도구 넷으로 세지 않는다. 지금 코드는 `spawnSync`만 써 거짓 통과는 없지만, 판 확인을 `execSync('kubectl version …')`으로 바꾼 틀린 구현은 W12T-02 ①을 지난다. 방향: 두 가짜에서 명령 글의 첫 낱말을 `short`로 떼어 `exe`로 적는다. |

- 막는 지적(높음·보안·통과 기준): 0. RV-01·02는 이 묶음에서 고치지 않고 다음 tools 묶음 후보로 남긴다.

## 검증

- 방법: 구현 뒤 트리 `fb509ac89`를 분리 작업 폴더(`git worktree add --detach`)에 꺼내 `corepack pnpm install --frozen-lockfile`·`pnpm exec turbo run build --filter=@peaket/identity-svc...` 뒤, §4의 틀린 구현을 하나씩 넣고 계획이 가리킨 시험 파일만 `node --test`로 돌려 실패를 본 다음 그 파일만 `git checkout --`로 되돌렸다(win32, Docker 없음). 넣기 전 기준은 세 시험 파일 시험 60·통과 57·실패 0·건너뜀 3(W12T-01 ②③④ POSIX)으로 '시험 결과'와 같다.

| # | 넣은 결함 | 실패한 시험 |
| --- | --- | --- |
| M1 | `runAll`의 `write`가 `measurementOf`에 `issues.ok`를 넘기지 않는다(선행이 없어도 판을 잰다) | V-T7 ⑦·W12T-02 ①(판 확인 넷 `docker --version`·`kind version`·`kubectl version --client --output=json`·`helm version --short` 기록), W12T-02 ②(도구 판 칸이 모두 '있음') |
| M2 | 선행이 없을 때 kubectl·helm만 건너뛰고 docker·kind 판은 실행한다 | V-T7 ⑦·W12T-02 ①(`docker --version`·`kind version` 기록), W12T-02 ②(docker·kind '있음') |
| M3 | 도구 판을 늘 '판 확인 안 함'·'없음'으로 적는다(선행이 모두 있어도 안 잰다) | W12T-02 ③("선행이 모두 있는데 kubectl 판을 재지 않았다") |
| M4 | 선행이 없으면 측정 파일을 쓰지 않는다(`write(report)` 지움) | V-T7 ⑦·W12T-02 ①, W12T-02 ②(측정 파일 없음 ENOENT) |
| M5 | `writeSecretJson`이 `chmodSync`를 하지 않고, `sessions.json`은 도우미 밖 `writeFileSync`로 쓴다 | W12T-01 ④ 모든 OS("writeFileSync( 호출이 2곳이다")로 `sessions.json` 쪽이 잡힘. `chmodSync` 쪽은 아래 CI 줄 |

- 넣은 5·잡힌 5·놓친 0.
- M5의 `chmodSync` 쪽(POSIX 세부라 이 PC는 W12T-01 ②③④를 건너뜀): PR #50 CI 실행 44916859307 우분투 `tools-check / tools`에서 `tools/local` 시험 265·통과 265·건너뜀 0으로 W12T-01 ②③④가 실제로 돌았고 실패 목록에 없다. ③은 있던 0644 파일을 다시 쓴 뒤 0600을 보므로, `mode`가 새 파일에만 듣는 `chmodSync` 없는 구현은 거기서 실패한다. 그 잡의 실패는 이 묶음 밖 메시 정책 MS-09·10·19뿐이다(감독이 W12-mesh로 맡김).
- 판정 기준 대조(둘, 모두 정본과 맞음):
  1. `docs/verification.md` 재현 스크립트(선행이 없으면 exit 1, 확인 못 한 시나리오는 통과로 세지 않음, kubectl·docker·kind·helm은 판 확인까지 하나도 실행하지 않음, 찾은 도구 '판 확인 안 함'·못 찾은 도구 '없음') ↔ V-T7 ⑦·W12T-02 ①(exit 1·'실패(선행 없음)'·시나리오 모두 '미실행'·도구 기록 0)과 W12T-02 ②(docker·kind·kubectl '판 확인 안 함', helm '없음'). 문구와 판정이 같다.
  2. `docs/infra.md` '로컬 데모의 비밀'(0600은 새로 만들 때와 있던 파일을 다시 쓸 때 모두, 저장소 시드·도구 파일은 git 권한 그대로, 권한 검사는 `.cache`의 비밀 파일만) ↔ DS-12·W12T-01 ①(저장소 파일 권한을 보지 않고 시드 폴더 비밀 파일 없음·출력 비밀 없음만 본다)과 W12T-01 ③(있던 0644 비밀 파일을 다시 쓴 뒤 0600).

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | w12tools-plan-7f3b | claude-opus-5-5 | 2026-11-21T23:23+09:00 | 2026-11-21T23:34+09:00 |
| test | w12tools-test-1a8c | claude-opus-5-5 | 2026-11-21T23:34+09:00 | 2026-11-21T23:59+09:00 |
| impl | w12tools-impl-9c2e | claude-opus-5-5 | 2026-11-21T23:49+09:00 | 2026-11-21T23:56+09:00 |
| review | w12tools-review-4e1a | claude-opus-5-5 | 2026-11-22T00:00+09:00 | 2026-11-22T00:06+09:00 |
| verify | w12tools-verify-6b5d | claude-opus-5-5 | 2026-11-22T00:00+09:00 | 2026-11-22T00:08+09:00 |
