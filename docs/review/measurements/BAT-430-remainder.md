# BAT-430 GAT-135 잔여 측정 기록(우선 구매 보류 홀드 셈·회차 빼기, R-771)

- **날짜**: 2026-11-22
- **가지**: `feature/lane3-BAT-430`, 기준 `origin/develop` `b918960c6`. 작업 폴더 `D:/ticketpass-lane3-b430`.
- **범위**: GAT-135 A10(판매 상태 `held`에 `s:{event:E}:prio` 더하기)·A11(우선 구매 보류가 남은 회차의 `retire-seat-events` 미루기), S-T37 ⑧⑨.
- **범위 밖**: GAT-135 A12(PRIORITY→FAN 변환)·A13(`q:prio` 대조)·A14(DB 실패 재시도), GAT-140 B5·B7·B8·B9(스캐너 앱 판정·업로드·POLICY 변경분·앱 판 갱신). 계획 `docs/review/plans/BAT-430.md` §6.

## 게이트

| 검사 | 결과 |
| --- | --- |
| purchase 단위 `sale-state-judge.test.ts` | **119 통과**(S-T37 ⑧ 둘 포함) |
| purchase 단위 `retire-memory.test.ts` | **2 통과**(S-T37 ⑨ prio·pin) |
| purchase 전체 단위 | 최종 **4,377/4,377 통과**. 앞선 실행에서 `test/grpc-payment-checkout.test.ts` 1건이 `PG_UNAVAILABLE`로 흔들렸고, 그 파일만 다시 돌려 **56/56 통과**(기존 흔들림, 이번 변경과 닿지 않음) |
| queue 단위 `priority-grant.test.ts`·`priority-grant-http.test.ts` | **13 통과**(Q-T62) |
| purchase 통합 `sale-state.int.test.ts`·`seat-retire.int.test.ts` | **58 통과**(실제 Valkey 8.1, S-T37 ⑧⑨ 포함) |
| typecheck `turbo run typecheck --filter=@peaket/purchase-svc` | 통과(의존 패키지 build 포함 9/9) |
| build `turbo run build --filter=@peaket/purchase-svc` | 통과(5/5) |
| lint(루트) | 통과(오류 0) |
| doc-check | 측정 파일을 더한 뒤 다시 본다(계획의 없는 경로 하나가 이 파일로 채워진다) |
| contracts `gen:check` | 생성물이 계약과 같다 |
| `gateway-routes.mjs --check` | 생성 파일 5개가 openapi·원천과 같다 |
| `trace-check --ids "Q-T62,S-T37"` | Q-T62 11·S-T37 21 통과(시험 480개를 봄) |
| `ledger --batch BAT-430 --require` | 범위 13항목, 자동 시험 13, 빈칸·ID만·미검증·다른 단계 0 → **통과** |
| Docker 잠금 | `lane3-BAT-430` 19:34에 잡고 19:41에 놓았으며, 끝나고 `docker ps`에 peaket 컨테이너가 없었다 |
| 브라우저 확인 | 화면 변경이 없어 생략한다(이 묶음은 purchase-svc Lua·저장소만 바꿨다). 스택을 띄우지 않았다 |

## 틀린 구현 표본

10개를 넣었고 **10개 모두 잡혔다**. 표본마다 관련 시험만 돌리고 `git checkout -- <파일>`로 되돌렸으며, 끝나고 제품 파일 차이가 0이었다.

| 번호 | 넣은 틀린 구현 | 잡은 시험(결과) |
| --- | --- | --- |
| M1 | `RedisSaleCounts.read`가 `prio` 키를 넘기지 않는다 | `sale-state-judge.test.ts` S-T37 ⑧ (1 실패/118 통과) |
| M2 | `RedisSaleCounts.holdIndexes`가 `prio` 키를 넘기지 않는다 | `sale-state-judge.test.ts` S-T37 ⑧ (1 실패/118 통과) |
| M3 | `HOLD_PAGE_LUA`가 prio 대신 paused를 한 번 더 읽는다 | `sale-state.int.test.ts` S-T37 ⑧ (1 실패/43 통과) |
| M4 | `SALE_COUNT_LUA`가 prio 대신 paused를 한 번 더 센다 | `sale-state.int.test.ts` S-T37 ⑧ (1 실패/43 통과) |
| M5 | 메모리 `retireEvent`가 prio를 보지 않는다 | `retire-memory.test.ts` S-T37 ⑨ (1 실패/1 통과) |
| M6 | 메모리 `retireEvent`가 pin을 보지 않는다 | `retire-memory.test.ts` S-T37 ⑨ (1 실패/1 통과) |
| M7 | `RedisSaleCounts.read`가 held를 비트맵 칸에서 읽는다 | `sale-state-judge.test.ts` S-T37 ⑧ (1 실패/118 통과) |
| M8 | `retireEvent`의 Redis prio 검사를 지운다 | `seat-retire.int.test.ts` S-T37 ⑨ (1 실패/13 통과) |
| M9 | `SALE_COUNT_LUA`가 prio를 두 번 센다 | `sale-state.int.test.ts` S-T37 ⑧ (1 실패/43 통과) |
| M10 | 메모리 `retireEvent`의 prio 조건을 `>= 0`으로 둔다(늘 참) | `retire-memory.test.ts` S-T37 ⑨ (2 실패/0 통과) |

## 수용 기준 판정

- **GAT-135**: A1~A11을 코드·시험으로 확인했다. A10·A11은 이 묶음이 닫았고, A1~A9는 R-561·R-575·R-587의 시험이 그대로 있다. A12·A13·A14는 열어 두었다.
- **GAT-140**: B1~B4·B6은 R-544·R-561·R-582·R-610이 끝냈고, B5(판정 10단계)·B7(즉시 업로드)·B8(POLICY 변경분)·B9(앱 판 갱신)는 스캐너 앱 작업이라 열어 두었다. B10은 GAT-190·GAT-020 몫이다.
- **단계 줄**: GAT-135·GAT-140 둘 다 **체크하지 않는다.** GAT-135는 A12~A14가, GAT-140은 B5·B7·B8·B9가 남았다.

## 남은 위험

- R-01: GAT-135 A12(PRIORITY→FAN 변환)는 정본과 R-587 메모가 다르다. 홀드 종류를 바꾸면 결제 실패 복귀·회수·만료의 이중 해제를 다시 설계해야 해 소유자 결정이 필요하다.
- R-02: GAT-135 A13(`q:prio` 대조)은 purchase-svc→queue-svc 권리 상태 알림 계약(Outbox 사건 또는 내부 gRPC)이 먼저다.
- R-03: GAT-135 A14(회수·만료 DB 실패 재시도)는 지금 경고 로그 한 줄이다. Redis를 먼저 풀어 권리가 OFFERED로 남을 수 있다.
- R-04: GAT-140 B5·B7·B8·B9는 스캐너 앱 화면·서비스 워커 작업이다. 서버 계약은 대부분 끝났고 앱이 아직 고정 데이터다.
- R-05: 메모리 저장소의 `paused` parity는 RV-01 고침으로 pin을 보게 했지만, `paused` 집합 자체를 모델하지는 않는다(시험용).
- R-06: 전체 단위 실행에서 `grpc-payment-checkout.test.ts`가 한 번 흔들렸다(기존 흔들림, 단독 56/56).
