# loadtest/poc — 기반 PoC 측정(wbs 0.5.1)

본 개발 전에 위험한 부분을 먼저 재는 측정 틀입니다(docs/architecture.md §9.4, openspec 변경 `add-foundation-poc`). 결과와 판정은 [ADR-0176](../../docs/adr/0176-foundation-poc-results.md)과 성능 장부(`docs/perf-ledger/runs/`)에 있습니다.

PC의 Docker 엔진에 측정용 망 `peaket-poc` 하나를 만들고, 그 안에 측정 대상과 측정 도구를 함께 띄웁니다. 측정 도구가 같은 망 안에 있어 Docker Desktop의 포트 전달을 거치지 않습니다. 성능 장부의 프로파일 이름은 `local-poc`입니다(docs/perf-ledger.md §4). 계정·인증 토큰·클라우드 비용이 드는 것은 없습니다.

## 쓰는 법

저장소 뿌리에서 실행합니다. Node 24와 Docker 엔진, `openssl`이 있어야 합니다.

```bash
node loadtest/poc/run.mjs                 # 모든 측정을 차례로(약 3시간 반). 묶음 이름을 주면 그것만: incr clients behaviors vt41 kafka seat number
                                          # number·numberbatch(2026-11-03 더함)는 기본 묶음에 들지 않는다: queue-svc 진입 ② 묶음 Lua 원문(services/queue-svc/.../entry-lua.ts)을
                                          # 측정 전에 bench/lua/entry-number-batch.lua로 옮겨(커밋하지 않음) 한 키 20만/s로 잰다. number는 요청마다 1건, numberbatch는 진입 서버마다 2ms 묶음(Q-T5, ADR-0179)
node loadtest/poc/run.mjs st27            # S-T27 다시 재기(운영 홀드·만료 Lua, PRF-135): st27-plan.json의 7번(약 1시간 30분). 상태 파일로 이어 돈다
node loadtest/poc/run.mjs st27smoke       # S-T27 연기 실행(예열 5초 + 20초, 장부에 넣지 않음). 만료 원문이 빈 글이면 홀드 경로만
node loadtest/poc/record.mjs              # 결과를 성능 장부로 옮기고 장부 표를 다시 만든다
node loadtest/poc/record.mjs --only <측정 ID> [--note <글>]   # 그 측정만 옮긴다(이미 장부에 있는 측정은 건드리지 않는다). --note는 notes 앞에 붙인다
node loadtest/poc/stack.mjs down          # 컨테이너와 망을 지운다
```

결과 원본은 `.cache/peaket-poc/out/`(커밋하지 않음)에 남습니다. 측정은 한 번에 하나씩 돌고, 측정 중에는 다른 시험을 돌리지 않습니다.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `stack.mjs` | 측정 무대: TLS 인증서(`openssl`, 30일), Valkey 8.1 클러스터(주 노드 셋 CPU 2개씩·복제 셋 1개씩, TLS 켬·끔, `latency-tracking`, SLOWLOG 10ms), Kafka 3.9.2 셋(KRaft, 복제 3, min.insync 2), 측정 도구 컨테이너 하나 돌리기 |
| `run.mjs` | 측정을 차례로 돈다. Redis 측정은 TLS 켬 3회·끔 1회(판정은 켬, docs/verification.md §3.5 7번) |
| `record.mjs` | `plan.jsonl`을 읽어 `tools/perf-ledger/collect.py`로 장부에 옮긴다. 측정 환경 사양 `infra.txt`를 만든다 |
| `seat-lua.mjs` | 운영 좌석 Lua 원문(purchase-svc `hold-lua.ts`·`expire-lua.ts`)을 `bench/lua/seat-*.lua`로 글자 그대로 내보낸다(커밋하지 않음). `run.mjs`가 이미지를 만들기 전에 부른다 |
| `st27-plan.json`·`st27-plan.mjs` | S-T27 다시 재기의 정식 측정 계획(7번의 입력·기준·결과를 남길 곳)과, 상태 파일 `.cache/peaket-poc/out/st27-state.json`로 이어 돌게 하는 도움 함수 |
| `bench/` | Node 측정 도구(뿌리 작업 공간 밖의 작은 작업 공간. Valkey GLIDE가 Windows 실행 파일을 내지 않아 Linux 컨테이너에서만 돈다). `rate.mjs`(한 키 INCR·클라이언트 셋 처리량), `behaviors.mjs`(V-T33 ②~⑤), `seat-shard.mjs`(S-T27, 운영 홀드·만료 Lua), `seat-contract.mjs`(운영 KEYS·ARGV와 같은 규칙), `sweep-rules.mjs`(운영 만료 반복 규칙: 상한에 닿으면 바로 다음 틱·회차 4개 동시), `oversell.mjs`(오버셀 검사), `kafka-perf.mjs`(Kafka 기본 클라이언트), `lua/`(PoC 홀드·만료·스냅샷 Lua 대역. `release.lua`는 2026-11-01 측정 때의 것이다) |
| `http/vt41.js` | V-T41 k6 시나리오. 대상 앱은 `packages/platform/bench/vt41`(세 구성: Express + Zod 파이프, Fastify + Zod 파이프, Fastify + 경로 스키마) |

## 측정 규칙

- **오픈 모델**: 정해진 도착률로 보내고 지연을 '보내기로 한 시각'부터 잽니다(1ms마다 밀린 만큼 냅니다). 동시에 기다리는 요청이 상한을 넘으면 보내지 않고 '못 보낸 요청'으로 세며, 하나라도 있으면 그 측정은 무효입니다. 최대 처리량만 닫힌 모델로 재고 장부에 닫힌 모델로 표시합니다.
- **예열 제외**: 예열 구간의 지연은 세지 않고, 엔진 통계(`CONFIG RESETSTAT`, `SLOWLOG RESET`)와 앱 CPU 통계도 예열이 끝날 때 비웁니다.
- **엔진 쪽 지연**: 홀드 Lua만 EVALSHA로 보내고 스냅샷은 EVAL_RO, 만료 작업은 EVAL로 보내 `INFO latencystats`에서 명령 이름으로 나눕니다.
- **PoC 홀드 Lua는 대역입니다**: 정본 실행 계약(docs/features/seat-hold.md §3)의 키를 같은 횟수로 만지지만 운영 스크립트가 아닙니다(`rate.mjs`·`behaviors.mjs`가 씁니다). S-T27(`seat-shard.mjs`)은 2026-11-04부터 운영 홀드·만료 Lua와 운영 KEYS·ARGV로 잽니다(seat-hold §8 'S-T27 다시 재기'). 같은지는 `loadtest/test/poc-seat.test.mjs`가 봅니다.
- **결과 표기**: 모두 '실측(PC)'입니다(docs/perf-ledger.md §7).

## 알아 둘 것(2026-11-01 측정 중 찾음)

- node-redis 6.3.0 클러스터 연결의 명령 시간 초과는 클러스터 설정 맨 위(`createCluster({ commandOptions: { timeout } })`)에만 듣습니다. `defaults` 안의 값은 클러스터가 명령마다 넘기는 기본 5초에 덮입니다. 그리고 그 시간 초과는 명령을 소켓에 쓰기 전까지만 듣습니다(`client/commands-queue.js`). 그래서 응답 없이 사라진 노드에는 100ms에 실패하지 않습니다(V-T33 ⑤). 처리는 ADR-0176을 봅니다.
- 같은 프로세스에서 Confluent Kafka 소비자가 도는 동안 관리 연결로 `fetchOffsets`를 거듭 부르면 Windows에서 프로세스가 네이티브 오류(0xC0000005)로 죽었습니다. Linux 측정 컨테이너에서는 30초 동안 110번 불러도 죽지 않았습니다(`kafka-perf.mjs --case admin`).
