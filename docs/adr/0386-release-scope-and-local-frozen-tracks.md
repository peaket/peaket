# ADR-0386: v1 릴리스 범위는 manifest로 고정하고 동결 기능은 로컬 트랙에서만 개발한다(2026-11-24)

- **상태**: 채택(2026-11-24, 릴리스 범위 분류). [ADR-0373](0373-seven-day-completion-scope-and-light-process.md)의 `동결`을 출시 계약과 로컬 트랙으로 나눈다. git flow의 릴리스·핫픽스 절차([ADR-0074](0074-git-flow-branching-release-and-hotfix.md))와 완성 기간의 가벼운 절차(ADR-0373), 새 A 기능의 구현 리뷰([ADR-0381](0381-agrade-post-impl-review.md))는 그대로다. 결정 3의 Argo CD 소스 변경은 배포 설정 변경이라 소유자 확인 사항으로 남긴다.
- **관련**: [docs/release/v1-scope.md](../release/v1-scope.md), [docs/release/v1-scope.json](../release/v1-scope.json), [docs/BUILD_ORDER.md](../BUILD_ORDER.md) '기능 단위 계획', [docs/architecture.md](../architecture.md) §8.6, [docs/devops.md](../devops.md) §2.2·§5.4, `tools/ci/release-scope.mjs`
- **관련 ID**: REL-010

## 맥락

- 2026-11-23 ADR-0373이 7일 완성 범위를 정하며 기능 표에 `동결`을 더했다. 그런데 동결은 "이번에 시작하지 않는다"는 진행 표시이고, 출시에 무엇이 들어가는지는 한 곳에 적혀 있지 않았다. 기능 표의 상태도 섞여 있다. F-01-6·F-01-7·F-03-1·F-03-2·F-05-4는 기능 가지가 `develop`에 합쳐졌는데 표에는 `진행`으로 남아 있고, F-05-2는 `일부 구현 있음`인데 reflow까지 닫혀 출시 몫이 끝났다.
- 동결 기능을 로컬에서 계속 만들면 그 마이그레이션·플래그가 `develop`을 거쳐 릴리스 가지로 새기 쉽다. 릴리스 플래그 배포 기구(F-09-2)도 동결이라 v1에는 기능을 끄고 켜는 릴리스 플래그가 없다. 동결 몫이 출시 환경에 섞이면 되돌리기 어렵다.
- 지금 Argo CD는 `develop`의 `deploy/`를 읽는다(`docs/devops.md` §2.2.5·§5.2). 릴리스 태그를 만들어도 배포가 `develop`을 따라가면 "출시 태그의 배포 상태"와 "클러스터의 원하는 상태"가 두 벌이 된다. 이 변경은 배포 설정을 바꾸는 일이라 AI가 혼자 정하지 않는다(§8.6 '맡기기').

## 결정

### 1. v1 출시 계약은 manifest다

- `docs/release/v1-scope.json`이 기계가 읽는 v1 출시 계약이다. `docs/release/v1-scope.md`는 같은 내용을 사람이 읽는 표로 둔다.
- 기능 105개를 `release`(출시 포함 32), `gate`(출시 보류 6), `frozen-local`(동결·로컬 전용 67) 가운데 하나로 정확히 한 번 분류한다. 외부 계정·법정 의무·동결 선행 때문에 v1에 넣을 수 없는 기능도 분류는 `frozen-local`로 두고 사유만 적는다. 별도 상태를 만들지 않는다.
- manifest의 모양은 `{version:"v1", features:{ID:{class, reason}}, gates:[...], frozen:[...]}`이다. `class`는 `release`·`gate`·`frozen-local` 셋뿐이고, `gates`는 `class: gate`인 ID, `frozen`은 `class: frozen-local`인 ID와 정확히 같다.
- 분류를 바꾸면 표·manifest·`docs/BUILD_ORDER.md` 상태를 같은 커밋에서 고친다. 한 곳만 고친 변경은 검사기가 막는다.

### 2. 측정·검증 gate가 끝난 뒤 `release/1.0.0`을 자르고 `main` 태그로 배포한다

- gate 6개는 F-03-4(콘솔 명령 화면의 실제 서버 시험·브라우저 확인), F-04-8(3만 건/초 신선도·누락률), F-05-1(키 증명 PoC·소유자 실기기), F-08-2(100만 외삽), F-08-7(데모 영상·안내), F-08-8(K1·K2·K7 After)이다. 통과 조건과 결과를 남길 곳은 `docs/release/v1-scope.md` §3에 있다.
- gate 결과와 전체 CI·장부·불변식 검사를 통과한 뒤 `develop`에서 `release/1.0.0`을 자른다. 릴리스 가지에는 버그 수정과 출시 메타데이터만 넣는다(ADR-0074 §2.2.2).
- 데모에서 후보를 검증하고 `main`에 병합 커밋으로 넣은 뒤 `v1.0.0` 태그를 단다. 운영에는 그 태그가 가리키는 후보 다이제스트를 다시 빌드하지 않고 올린다.
- gate가 끝나지 않았거나 실패하면 그 기능을 v1 계약에서 빼고, 표·manifest에 같은 커밋으로 적는다. 측정 못 한 수치를 통과로 적지 않는다.

### 3. Argo CD는 `develop`이 아니라 릴리스 태그/main의 `deploy/`를 읽는다

- 릴리스 태그와 `main`의 `deploy/`가 출시 환경의 원하는 상태여야 한다. `develop`은 다음 출시를 모으는 곳이라, 출시 뒤에도 `develop`을 읽으면 태그 뒤의 미출시 변경이 운영에 닿는다.
- **지금은 Argo CD가 `develop`의 `deploy/`를 읽는다**(`docs/devops.md` §2.2.5). 이 소스를 `main`/릴리스 태그로 바꾸는 것은 ApplicationSet·값 파일·승격 PR 경로를 함께 바꾸는 배포 설정 변경이다. 소유자 확인 전에는 바꾸지 않고, 이 ADR의 '소유자 확인' 목록에 남긴다.
- 소유자 확인 전에 릴리스 태그를 만들면 "태그의 배포 상태"와 "Argo CD가 읽는 `develop`의 배포 상태"가 다를 수 있다. 그동안 릴리스 체크리스트에 이 차이를 적고, 운영 배포는 태그와 같은 다이제스트를 `develop`의 환경 값에 반영한 뒤에 한다.

### 4. 동결 기능은 `freeze/<ID>` 가지·워크트리에서만 개발하고 release에 체리픽하지 않는다

- 동결 기능은 `develop`에서 갈라진 `freeze/<ID>` 가지와 그 가지의 워크트리에서만 개발한다. `develop`·`release/1.0.0`에 합치지 않고, 릴리스 가지나 `main`에 체리픽하지 않는다.
- 동결을 풀려면 새 ADR이나 이 ADR의 개정으로 manifest의 분류를 바꾸고, `freeze/<ID>`의 변경을 `develop`에 정상 병합한 뒤 다음 릴리스에 넣는다. 동결을 푼 기능이 v1 계약에 자동으로 들어가지는 않는다.
- 동결 가지의 작업이 출시 뒤 `develop`의 같은 파일과 충돌하면, 출시 태그를 기준으로 다시 쌓는다. 출시된 코드를 동결 가지로 되돌리지 않는다.

### 5. 동결 마이그레이션·플래그는 로컬에만 두고 release manifest에 넣지 않는다

- 동결 기능의 DB 마이그레이션과 릴리스 플래그는 로컬·CI 무대에만 둔다. `deploy/`의 출시 환경 값과 `services/*/migrations/`의 출시 마이그레이션 목록에 넣지 않는다.
- v1에는 릴리스 플래그를 쓰지 않는다. 플래그 배포 기구(F-09-2)가 동결이고 `deploy/envs/<환경>/flags/`가 없다. 출시 기능은 플래그 없이 공개하고, 운영 중 바꿔야 하는 값은 관제 명령으로 만든다(`docs/devops.md` §5.4).
- 동결 기능의 스키마 변경이 꼭 필요하면 로컬 DB에만 적용하고, 출시 마이그레이션과 같은 번호를 쓰지 않는다. 번호가 겹치면 출시 뒤 `develop`에서 다시 번호를 매긴다.

### 6. CI `release-scope --check`가 표·manifest·BUILD_ORDER를 대조한다

- `node tools/ci/release-scope.mjs --check`는 다음을 막는다.
  - `docs/BUILD_ORDER.md`의 기능 ID와 manifest의 기능 ID가 다르거나, 한쪽에만 있거나, 두 번 나오는 경우
  - 분류 표에 없는 ID·중복 ID, 표의 분류가 manifest와 다른 경우, 표의 BUILD_ORDER 상태가 실제와 다른 경우
  - `gates`·`frozen` 배열이 `class: gate`·`class: frozen-local`과 다른 경우
  - `release`인데 BUILD_ORDER 상태가 `동결`·`막힘`·`대기`인 경우, `gate`인데 `완료`·`동결`·`막힘`인 경우, `frozen-local`인데 `완료`인 경우
- `--release`는 `--check`에 더해 릴리스 가지(`release/*` 또는 `main`)에서 `deploy/envs/*/flags/`와 `services/*/migrations/*.sql`에 동결 기능 ID가 적혔는지 본다.
- **한계**: 마이그레이션 SQL은 기능 ID를 주석으로 달지 않으므로 파일 이름·주석만 보고 동결 기능의 표·칸 변경을 가려낼 수 없다. 릴리스 전에 `git diff <릴리스 기준>..release/1.0.0 -- services/*/migrations`를 사람이 동결 기능 계획과 대조한다. 플래그 배포 기구가 생기기 전에는 검사할 플래그가 0개이고, 플래그가 생긴 뒤에도 이름만 바꾼 동결 몫은 사람이 본다. 게이트 측정이 끝났는지와 Argo CD 소스는 git 파일만으로 알 수 없어 이 도구가 보지 않는다. 한계는 도구 머리 주석에도 적는다.
- 검사기는 저장소 루트에서 `node tools/ci/release-scope.mjs --check`로 돌린다. `.github/workflows/tools-check.yml`에 이 명령을 걸었고, 시험은 `node --test tools/ci/release-scope.test.mjs`다. `tools-check`는 `tools/ci/infra/js` 범위가 바뀔 때 불리므로, 문서만 바꾼 변경은 이 검사를 자동으로 돌지 않는다. 문서만 바꾼 변경은 같은 명령을 손으로 돌린다.

## 결과

- 좋아지는 점:
  - 출시에 무엇이 들어가는지 한 파일(manifest)로 확인하고 기계로 대조한다. 표·manifest·BUILD_ORDER가 어긋나면 합치기 전에 막힌다.
  - 동결 기능이 릴리스 가지·출시 환경에 섞이는 일을 줄인다. 동결 가지와 릴리스 가지의 경계가 이름(`freeze/<ID>`)으로 보인다.
  - gate가 끝나지 않은 기능을 통과로 세지 않고 계약에서 빼는 절차가 생긴다.
- 잃는 점:
  - 분류를 바꿀 때 표·manifest·BUILD_ORDER를 함께 고쳐야 한다. 한 곳만 고치는 빠른 수정이 막힌다.
  - `--release`가 마이그레이션의 동결 몫을 완전히 가려내지 못해 릴리스 전 사람 대조가 남는다.
  - Argo CD 소스를 바꾸기 전에는 태그와 배포 상태가 어긋날 수 있어 릴리스 체크리스트에 사람이 적어야 한다.
  - 동결 기능을 로컬에서 오래 유지하면 출시 코드와 충돌이 커진다. 동결을 풀 때 다시 쌓는 비용이 든다.

## 소유자 확인이 필요한 것

- Argo CD가 읽는 배포 상태 소스를 `develop`에서 `main`/릴리스 태그로 바꾸는 일(결정 3). 배포 설정 변경이라 소유자 확인 뒤에 한다.
- `release/1.0.0` 가지와 `v1.0.0` 태그를 원격에 푸시하는 일. `develop` 밖 원격 가지·태그 푸시는 소유자 몫이다(`docs/architecture.md` §8.6 '맡기기').
- 외부 계정·법정 의무가 필요한 동결 기능을 v1에 넣을지. 넣지 않는 것이 이 결정의 기본값이고, 넣으려면 새 ADR과 계정·계약이 필요하다.

## 고른 안과 버린 안

- (고름) manifest 한 파일을 출시 계약으로 두고, 표는 사람이 읽는 사본으로 두며, CI가 셋을 대조한다.
- (버림) `docs/BUILD_ORDER.md`의 상태만으로 출시 범위를 정한다: 상태가 `진행`인데 합쳐진 기능과 `일부 구현 있음`인데 출시 몫이 끝난 기능을 구분하지 못한다.
- (버림) 동결 기능도 `develop`에 두고 릴리스 플래그로 끈다: 플래그 배포 기구(F-09-2)가 동결이라 v1에 플래그가 없고, 동결 마이그레이션이 출시 DB에 들어갈 위험이 남는다.
- (버림) Argo CD 소스를 이번에 함께 바꾼다: 배포 설정 변경이라 소유자 확인이 필요하고, 릴리스 범위 분류와 섞으면 되돌리기 어렵다.
- (버림) `out-of-v1` 상태를 하나 더 만든다: 상태가 넷이 되면 표·manifest·BUILD_ORDER의 대조가 복잡해지고, 사유는 이미 `reason` 칸에 적을 수 있다.
