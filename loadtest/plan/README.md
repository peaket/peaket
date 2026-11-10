# BAT-025 측정 계획·상태(loadtest/plan)

BAT-025(PRF-220) 측정 창 1을 한 실행씩 이어 돌기 위한 계획과 상태 도구다. 정본은 [docs/review/plans/BAT-025.md](../../docs/review/plans/BAT-025.md) §2.3·§6.2이고, 이 파일은 그 실행 목록을 기계가 읽는 꼴로 옮긴 것이다.

- **계획**: `bat025-plan.json`. A/A 두 쌍, Q-T5 `numberbatch`, K2 인기 좌석 TLS 켬 3·끔 1, K1 1천·1만(3회씩), K7 ② 3회(OPEN[34] 결정 (가) 뒤 포함), 규칙 검사. 실행마다 명령·조건·판정·장부에 남길 것·예상 시간·산출물이 있다.
- **상태**: `.cache/peaket-bat025/state.json`(커밋하지 않음). 실행마다 `status`(pending·running·done·failed·skipped)와 `result`(pass·fail·invalid·skipped)를 적는다. **통과는 `done`+`pass`만이다.** 실패·무효·SKIPPED는 통과로 세지 않는다.
- **도구**: `bat025-plan.mjs`는 명령을 실행하지 않는다. 다음 실행의 명령을 보여 주고, 사람이 끝낸 결과를 적는다. 측정은 감독의 '측정 시작' 뒤에만 한다.

## 쓰는 법(저장소 뿌리)

```bash
node loadtest/plan/bat025-plan.mjs init --day 2026-11-11   # 상태 파일 만들기(처음 한 번. --suffix b는 같은 날 다시 돌 때)
node loadtest/plan/bat025-plan.mjs status                  # 전체 진행
node loadtest/plan/bat025-plan.mjs next                    # 다음 실행의 명령·조건·판정
node loadtest/plan/bat025-plan.mjs show k2-tls-r1          # 한 실행 자세히
node loadtest/plan/bat025-plan.mjs unblock LANE-LOAD       # 감독이 갈래 2·3 시험을 확인했을 때
node loadtest/plan/bat025-plan.mjs done k2-tls-r1 --result pass --note "p99 42ms, 201 1건"
node loadtest/plan/bat025-plan.mjs done k2-tls-r2 --result invalid --note "발생기 놓침 3건"
node loadtest/plan/bat025-plan.mjs fail k2-tls-r3 --reason "k6 실행 실패"
node loadtest/plan/bat025-plan.mjs retry k2-tls-r3          # 실패를 다시 돌 대상으로
node loadtest/plan/bat025-plan.mjs aa                       # A/A 네 실행의 p99 비율과 판정을 aa-summary.json에 적는다
```

- `init`은 계획의 실행을 모두 pending으로 둔다. 같은 날 다시 재면 `init --force --suffix b`로 ID·산출물 폴더가 겹치지 않게 한다.
- `next`는 게이트가 막힌 실행을 건너뛰고 다음 실행을 보여 준다. 게이트는 `unblock <이름>`으로 푼다. 남은 게이트는 `LANE-LOAD`(A/A 다른 갈래 함께 쌍) 하나다.
- `done`은 `--result pass|fail|invalid`가 꼭 필요하고, fail·invalid는 `--note`로 까닭을 적는다. 게이트가 막힌 실행은 `done`할 수 없다.
- 실행 전에 `loadtest/README.md`의 공통 준비(새 클러스터·Prometheus·불변식 검사기)를 따른다. K7 ②는 회마다 새 클러스터다.

## 판정에서 지키는 것

- 실패·무효·SKIPPED는 통과가 아니다. SKIPPED가 정본 기대 목록(S3·P5·M1~M5)과 다르면 그 실행은 invalid다.
- A/A는 장부에 넣지 않는다. `aa`가 quiet 쌍과 noisy 쌍의 p99 비율을 내고, 이 PC의 A/A 잡음 폭(±9.6%, 2026-11-03 D-T40)과 견준다. 결과는 ADR-0190 '확인'에 글로 남긴다.
- P3은 시작 시각(결제사 승인과 결과 모름 해소 가운데 늦은 쪽) 뒤 60초 기준이다(2026-11-11, ADR-0266).
