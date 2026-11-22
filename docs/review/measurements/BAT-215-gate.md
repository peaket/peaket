# BAT-215 합치기 게이트 반영 검증 — 제어 설정 동기화의 시작 규칙

- **묶음**: BAT-215(OPS-010·OPS-020), 시험 ID C-T75 ②. 계획 `docs/review/plans/BAT-215.md`. 앞 검증은 665fca09a(틀린 구현 10/10 잡힘)다.
- **검증 담당**: `bat215-verify2-7c955021`(claude-opus-5-5). 구현·시험에 참여하지 않은 새 맥락이다(docs/architecture.md §8.6, ADR-0270 '검증').
- **시각**: 시작 2026-11-23T03:08+09:00, 끝 2026-11-23T03:20+09:00. 트리는 `feature/lane1-BAT-215`의 051c1797e.

## 무엇을 검증했나

앞 검증 뒤에 들어온 합치기 게이트 리뷰 반영 넷이다.

| 커밋 | 몫 | 내용 |
|---|---|---|
| fb76e4dd0·702c9d176 | 시험(RV215-3) | `test-int/main-boot.ts`가 운영 값(prod·staging)이고 브로커 주소가 없을 때만 `startServiceControlSync` 하나를 `vi.doMock`으로 바꾸고 호출을 적는다. `main-no-broker.int.test.ts`(진짜 도우미, 브로커 없으면 시작 실패), `main-start.int.test.ts`의 호출 모양 단언 |
| 8310ae35f | 시험(RV215-6) | `packages/platform/test/control-sync-required.test.ts`(판정 경계 4개), `main-kafka-module.int.test.ts` 경고 한 줄, `main-kafka-module-prod.int.test.ts`(운영 값 모듈 싣기 실패 → 시작 실패) |
| 051c1797e | 구현(RV215-6) | platform `config.ts`의 `CONTROL_SYNC_OPTIONAL_ENVS`·`controlSyncRequired`, `stream-worker.ts`의 `controlSyncConfigFromEnv`가 그 도우미를 쓴다, trust-svc `src/main.ts`가 stream-worker 싣기 실패를 `.catch`로 받는다 |

대조한 규칙(감독이 준 정본 요지): 브로커가 없으면 local·ci만 경고로 끄고 그 밖은 시작에 실패한다(ADR-0334, 제어 설정 소비). trust-svc는 Kafka 모듈을 싣지 못해도 뜬다(ADR-0249 결정 4). 다만 제어 설정 토픽 소비가 꼭 있어야 하는 환경에서는 싣지 못하면 시작에 실패한다.

## 시험 원칙 점검(peaket-test-antipatterns)

- **가짜가 '브로커 필수'를 덮는가**: 덮지 않는다. `vi.doMock`은 `realControlSync`를 주지 않은 운영 값 기동(main-start·main-evidence·main-no-key-metric)에만 걸린다. '브로커가 없으면 시작하지 않는다'는 `main-no-broker`가 진짜 도우미로 보고, `main-kafka-module-prod`도 진짜 싣기 경로를 둔다. 변이 M9~M11에서 `main-no-broker`가 가짜 쪽 시험과 함께 실패했다. 가짜만 남은 판정은 없다.
- **짝**: 가짜는 `vi.fn<typeof startServiceControlSync>`이고, 부분 모킹은 `importOriginal<typeof import('@peaket/platform/stream-worker')>()`라서 타입이 묶여 있다(TA-C07 없음). 돌려주는 `undefined`는 진짜가 꺼진 설정에서 돌려주는 값이다. 진짜 동작은 platform `test-int/control-sync.int.test.ts`가 실제 Kafka로 본다(행동 짝). 바꾸는 것은 Kafka 소비라는 경계 하나뿐이라 업무 로직을 모킹하지 않는다(TA-C08).
- **단언**: 모두 정확한 값이다(`toEqual` 호출 기록 한 줄, `rejects.toThrow(문구)`, `rejects.toMatchObject({ cause })`, 경고 줄 `toHaveLength(1)`과 문구). `toBeDefined`만으로 끝나는 단언, `if`·`try` 안 단언은 없다. 단위 판정 시험은 기대값을 상수 `CONTROL_SYNC_OPTIONAL_ENVS`에서 가져오지 않는다(TA-C02).
- **대기**: 고정 대기가 없다. 포트가 닫혔는지는 `fetch` 거부로 본다.
- **작은 흠(막지 않음)**:
  - `main-kafka-module.int.test.ts`는 `fs.writeSync`를 `(fs as { writeSync: unknown })`로 바꿔 끼운다. 이 저장소의 main-label 시험과 같은 꼴이고 `afterAll`에서 되돌리지만, 타입 탈출 예외 표기(`// type-escape:`)가 없다.
  - main-start의 '한 번 부른다' 단언은 호출 횟수를 본다(TA-V11 쪽). 가짜 경계의 계약 모양이라 받아들일 만하다.

## 틀린 구현 검사

넣은 잘못은 하나씩 src에 넣고 시험을 돌린 뒤 백업에서 되돌렸다. platform 단위 시험과 trust-svc 통합 시험은 platform 원본을 별칭으로 읽는다. 끝에 platform을 원래 코드로 다시 build했다.

| 번호 | 넣은 잘못 | 잡은 시험 | 잡힘/놓침 |
|---|---|---|---|
| M1 | `controlSyncRequired`: 브로커 값의 `trim()` 뺌(공백만 있어도 '있음') | control-sync-required C-T75 ② RV215-6 ① | 잡힘 |
| M2 | `controlSyncRequired`: `PEAKET_ENV` 없음을 열린 쪽(false)으로 | control-sync-required ④ | 잡힘 |
| M3 | `controlSyncRequired`: 환경 이름을 소문자로 바꿔 비교(`CI`도 선택) | control-sync-required ④ | 잡힘 |
| M4 | `CONTROL_SYNC_OPTIONAL_ENVS`에 `staging` 더함 | control-sync-required ③ | 잡힘 |
| M5 | `controlSyncRequired`: 브로커 주소 검사 뺌(local·ci면 주소가 있어도 false) | control-sync-required ② | 잡힘 |
| M6 | `controlSyncConfigFromEnv`: 도우미 대신 `PEAKET_ENV !== 'prod'`로 판정(staging은 브로커 없이 꺼짐) | platform service-control-sync I-T3 ②-1·②-5 | 잡힘 |
| M7 | main.ts `.catch`: 늘 다시 던짐 | main-kafka-module(ci 시작 실패, 파일 전체 실패) | 잡힘 |
| M8 | main.ts `.catch`: 늘 삼킴 | main-kafka-module-prod C-T75 ② RV215-6 ⑥ | 잡힘 |
| M9 | main.ts `sessions: false` → `sessions: true` | main-start C-T75 ②, main-no-broker C-T75 ② | 잡힘 |
| M10 | main.ts `startServiceControlSync` 호출 뺌 | main-start C-T75 ②, main-no-broker C-T75 ② | 잡힘 |
| M11 | main.ts 호출을 `service.listen()` 뒤로 옮김 | main-start C-T75 ②(`listening: true`), main-no-broker C-T75 ② | 잡힘 |
| M12 | main.ts `.catch`의 판정에 브로커 주소를 넘기지 않음(`controlSyncRequired({ PEAKET_ENV })`, 곧 local·ci면 주소를 줬어도 삼킴) | 없음 | **놓침** |

- 넣은 수 12, 잡힘 11, 놓침 1.
- **놓친 것 M12**: '브로커 주소를 줬는데 모듈을 싣지 못하면 조용히 끄지 않는다'는 단위 시험 ②가 도우미 하나로만 본다. 시작 파일이 그 도우미에 `env`를 그대로 넘기는지는 아무 시험도 보지 않는다. 통합 시험의 모듈 싣기 실패 경우는 'ci·브로커 없음'(main-kafka-module)과 'prod'(main-kafka-module-prod) 둘뿐이고, 'local·ci·브로커 있음 + 싣기 실패' 경우가 없다. 영향은 local·ci에서 설정 소비가 경고("브로커 없음"이라는 틀린 문구)와 함께 꺼지는 데 그친다. 운영 값은 M8처럼 잡힌다. 시험 담당 몫이다. 예를 들어 main-kafka-module 꼴로 `PEAKET_ENV: 'ci', PEAKET_KAFKA_BROKERS: '127.0.0.1:1'`을 주고 싣기 실패가 시작 실패로 이어지는지 보는 시험을 더하면 된다(이 검증에서는 시험을 고치지 않았다).

## 돌린 명령과 수

| 명령 | 결과 |
|---|---|
| `pnpm --filter @peaket/platform test` | 62파일 728개 통과(되돌린 뒤) |
| `pnpm --filter @peaket/platform build` | 통과(되돌린 원본으로 dist 다시 만듦) |
| `pnpm --filter @peaket/platform typecheck` | 통과 |
| `pnpm --filter @peaket/trust-svc test` | 17파일 216개 통과. 첫 실행에서 `test/block-list-source.test.ts` B-T9① 1건이 5,459ms로 기본 시간 한도(5초)를 넘겨 실패했고, 다시 돌린 전체 실행과 단독 3회는 모두 통과했다. 원본 파일을 훑는 시간 의존 시험이고 이 반영과 무관하다 |
| `pnpm --filter @peaket/trust-svc typecheck` | 통과 |
| `pnpm lint`(뿌리) | 통과(끝 코드 0) |
| `pnpm --filter @peaket/trust-svc test:integration` | 16파일 109개 통과(변이 전·되돌린 뒤 두 번). Kafka 네이티브 모듈을 싣는 시험(`telemetry-kafka.int`)도 이 PC에서 돌았다 |

- Docker 잠금은 `lane1-BAT-215-verify`로 잡고 끝에 놓았다. 남은 시험 컨테이너는 없었다.
- 되돌린 뒤 `git status`: src 변경 없음. 작업 트리의 미커밋 문서 일곱은 기록 담당 몫이라 건드리지 않았다.

## 판정

막는 결함은 없다. 리뷰 반영 넷은 규칙대로 동작하고, 운영 값에서 '브로커·모듈이 꼭 있어야 한다'를 빼는 잘못(M6·M8·M9·M10·M11)은 모두 진짜 도우미를 둔 시험이 잡는다. 놓친 M12(local·ci·브로커 있음 + 싣기 실패)는 운영 값에 닿지 않는 낮은 위험이고, 시험 담당이 시험 하나를 더하면 된다.
