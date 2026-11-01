# Tasks

## 1. 정본 먼저

- [x] 1.1 ASVS 추적 표(docs/security/asvs/delivery.md 13.1.1·13.2.2·13.4.1)와 운영 확인 표(docs/observability.md §3 Outbox 릴레이 줄)를 구현 전에 읽고, 이 설계대로 고친다. 확인: 문서 점검 오류 0. 표를 고친 것은 구현과 함께였다(읽기는 먼저, 고치기는 같은 변경 안).

## 2. 도구 받기(결정 2)

- [x] 2.1 시험을 먼저 쓴다(`tools/local/tools.test.mjs`): 세 도구·다섯 플랫폼의 주소와 해시, 지원하지 않는 플랫폼 거절, 해시가 다르면 쓰지 않음, 받아 둔 것 다시 쓰기, 받아 둔 파일이 바뀌면 다시 받기, https만. 확인: 실패한다(모듈 없음).
- [x] 2.2 구현한다. 확인: 6개 통과, 실제 공식 주소에서 kind v0.33.0·kubectl v1.35.8·helm v3.22.1을 받아 해시가 맞고 실행된다. Windows에서 Git Bash의 GNU tar가 zip을 못 풀어 시스템 tar를 쓰게 고쳤다.

## 3. 릴레이 프로세스(결정 6~8)와 생존 프로브(결정 10)

- [x] 3.1 시험을 먼저 쓴다(`test/relay-process.test.ts`): 설정 넷과 Lease 이름, 빠진 이름 모두 대기, 브로커 꼴, 두 복제 중 리더 하나와 리더 지표, `/ready`, 정비는 리더만, 끝내면 Lease를 놓아 대기 복제가 바로 잡고 리더 바뀜을 로그에 남김. 확인: 7개 모두 실패한다(함수 없음).
- [x] 3.2 구현한다. 확인: 6개 통과, '정비는 리더만'이 실패했다. 정비 반복이 시작할 때 리더가 아니면 10분을 쉬어 새 리더가 정비를 하지 않았다(결정 7). 정비 실행기의 깨우기 시험(`maintenance.test.ts`)을 먼저 써 실패를 본 뒤 구현하고, 리더가 되면 깨우게 했다. 확인: 14개 통과.
- [x] 3.3 실제 PostgreSQL 통합 시험(`test-int/relay-process.int.test.ts`): 두 복제·메모리 Lease로 리더만 보내고, 리더를 끝내면 다른 복제가 이어 보내며 빠짐·중복·키 순서 뒤집힘이 없다. 확인: 처음에 같은 키의 순서가 뒤집혀 실패했다(결정 13의 결함). 재현 시험(`outbox.int.test.ts`의 `FND110_V-T28_자릿수가다른seq가…`)을 먼저 써 실패를 본 뒤 정렬을 고쳤다. 확인: 두 시험 통과.
- [x] 3.4 시험을 먼저 쓴다: 서비스(`control.test.ts`)·릴레이 관리 포트의 `/livez`는 준비 전에도 200. 확인: 404로 실패 → 구현 → 통과.
- [x] 3.5 서비스 뼈대 시작 파일 `template/src/relay.ts`와 이미지 파일(`template/Dockerfile`·`tsconfig.build.json`, 뿌리 `.dockerignore`). 확인: 이미지가 만들어지고, 실행 이미지에 원본·시험·`.git`이 없으며(`/app`에 `dist`·`node_modules`·`template/dist`·`template/migrations`만), 설정이 빠지면 이름을 대며 시작하지 않는다. 깨끗한 타입 검사(빌드 산출물 없음)에서 `@peaket/platform/stream-worker`를 못 찾아 tsconfig 경로를 더했다.

## 4. 공용 차트(결정 9·10)

- [x] 4.1 차트 `deploy/charts/peaket-service`(서비스 Deployment·Service·서비스 계정, 릴레이 Deployment·서비스 계정·Role·RoleBinding)와 렌더 시험(`tools/local/chart.test.mjs` 4개). 차트는 설정이라 시험을 뒤에 붙였고, 차트를 일부러 망가뜨린 세 판(Lease 이름 제한 지움, 준비 경로 바꿈, 서비스 토큰 붙임)에서 시험이 실패하는 것을 보았다. 확인: `helm lint` 통과, 4개 통과.

## 5. 로컬 클러스터(결정 1·3·4·5)

- [x] 5.1 시험을 먼저 쓴다(`tools/local/cluster.test.mjs`): Strimzi 설치 파일의 네임스페이스·운영자 메모리·이미지 다이제스트 고치기, 고칠 자리가 없으면 실패, 고정 판·다이제스트. 확인: 실패한다(모듈 없음) → 구현 → 3개 통과.
- [x] 5.2 `deploy/local/`(kind·Kafka·PostgreSQL·AWS 흉내 서버)과 `tools/local/cluster.mjs`. 확인: `up`이 3분 26초에 끝나 Kafka Ready·두 롤아웃 완료. 처음 손으로 띄울 때 Strimzi 운영자가 384Mi에서 메모리 초과로 죽어 512Mi로 올렸다.
- [x] 5.3 AWS 흉내 서버 확인(`tools/local/e2e/aws-emulator.e2e.mjs`). 확인: 처음에 둘이 실패했다. moto 5.2.5는 보존 기한 읽기(GetObjectRetention)를 구현하지 않고 객체를 돌려주며, 틀린 서명 검증에 예외 대신 `SignatureValid: false`로 답한다. 보존 값은 객체 머리로 보고, 검증 실패는 두 답을 모두 받게 고쳤다(정본 infra §3에 한계로 적음). 4개 통과.

## 6. kind 이어받기(결정 11)

- [x] 6.1 `tools/local/e2e/relay-takeover.e2e.mjs`(V-T28 ①의 kind 부분). 확인: 통과(두 번). 리더가 바뀌는 데 13.5초·11.1초, 600행 모두 도착(다시 보낸 것 0), 순서 뒤집힘 0, 깨어난 옛 리더는 리더 지표 0. 릴레이는 Outbox 읽기·`sent_at` 고치기만 받은 역할로 돌았다. 차트 Role에서 권한을 뺀 판(처음에는 만들기, 리뷰 반영 뒤에는 고치기)에서 시험이 실패하는 것을 보았다.

## 7. CI(결정 12)

- [x] 7.1 시험을 먼저 쓴다: 바뀐 범위 `kind`(`changes.test.mjs`), 포크 PR 건너뛰기 표시(`fork-guard.test.mjs` 5개). 확인: 실패한다 → 구현 → CI 도구 170개 통과.
- [x] 7.2 `ci-kind.yml`과 `ci.yml`의 `kind` 잡(`ci-summary`에 들어감). 확인: 워크플로 규칙 검사 통과(10개). 원격이 없어 GitHub에서는 아직 돌리지 못했다.

## 8. 검증

- [x] 8.1 작업 공간 typecheck·test·build·lint, 플랫폼 통합 시험, CI 도구 시험, `tools/local` 시험, kind 시험 둘, 문서 점검, `openspec validate`.
- [x] 8.2 새 맥락의 코드 리뷰를 받고 실제 결함을 고친다. 확인: 리뷰가 결함 9건(중간 2·낮음 7)을 찾았다. 모두 고쳤고, 시험으로 재현할 수 있는 것은 시험을 먼저 써 실패를 보았다(되돌린 판으로 실패 확인 포함).
  - 중간: 끝낼 때 정비 일이 끝날 때까지 Lease를 붙잡아 아무도 보내지 않음 → 정비 일에 멈춤 신호, 나눠 지우는 두 일은 묶음 사이에 멈춤, 기다림 10초 [가정] 한도, 멈춘 뒤 끝난 일은 성공으로 적지 않음(`relay-process.test.ts`·`maintenance.test.ts` 시험 다섯).
  - 중간(기존 FND-090 코드): 보존 지우기 정렬이 글자로 바꾼 별칭을 따라 인덱스를 쓰지 않음 → 표의 열로 콕 집음(결과는 같고 실행 계획만 바뀌어 시험은 더하지 않았다).
  - 확인 리뷰(두 번째)가 고침 아홉이 맞다고 하고 새 결함 셋을 찾았다. 중간: 차트가 Lease를 미리 만들게 되자, 릴레이의 고치기(PUT)가 차트·ArgoCD가 붙인 라벨·주석을 지움 → 마지막으로 읽은 판의 메타데이터를 실어 보냄(`lease.test.ts` 재현 시험, kind 시험에 라벨·주석 단정). 낮음: 정비 한도를 넘긴 뒤 풀 닫기가 끝없이 기다릴 수 있음(3초 [가정] 한도), `kind` 범위에서 이미지 시작 경로가 빠짐(플랫폼 패키지·공용 설정 전부로 넓힘, `changes.test.mjs`).
  - 낮음: 시험 도우미의 같은 정렬 버그와 재현 시험이 앞 시험의 실행 순서에 기댐(시작 번호를 9로), `.dockerignore`가 뿌리에만 걸려 이미지에 `.turbo` 기록이 들어감, Strimzi 엔티티 운영자 이미지가 태그로 돎(`cluster.test.mjs`), 압축 도구의 받아 둔 실행 파일을 옆 파일과 견줌(`tools.test.mjs`), Lease 만들기를 이름으로 좁히지 못함(차트가 미리 만들고 만들기 권한을 뺌, `chart.test.mjs`), CI `kind` 범위에서 마이그레이션·서비스 시작·작업 공간 파일이 빠짐(`changes.test.mjs`), 릴레이 시작 파일의 시작 중 실패·신호 처리 순서, kind 시험의 헛통과 가능성(프로세스 번호 0, 다시 뜬 컨테이너, 깨우기를 `finally`에서).
