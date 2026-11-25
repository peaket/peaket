# 갈래 6 — 구간 끝 정리 목록

- 2026-11-24 F-04-9 구현 리뷰(동결 로컬)의 중간·낮음 가운데 이번 freeze 가지에서 고치지 않는 것을 옮겼다. 보안·통과 기준(IR-01~IR-06)은 `docs/review/plans/F-04-9.md` '구현 리뷰'에 남아 동결 가지에서 고친다.
- F-04-9 IR-07(중간): 봇 등급 12칸 가운데 행동이 갈리는 것은 VOLUME(여러 좌석·기기 묶음)뿐이고 SPEED·ACCOUNT·QUEUE는 이름만 다르다. 파일 `bot_tier`도 1~3단계만 실어 클래스가 열에 없고 정답 `truth`에만 있다. F-04-18 산점도·정밀도·재현율 데모 전에 12칸 행동을 정본 §5.2대로 나누고, 클래스를 열에 실을지 정한다(`apps/forensics/src/lib/forensics/scenario.ts`)
- F-04-9 IR-08(중간): 판매·결제 실패 경로가 `HOLD_END`를 내지 않고 `PAY_TRY`로 바로 간다. 정본 §4.1의 HOLD_END는 '만료, 풀기, 결제로 넘어가기'를 포함하므로, 홀드가 끝나는 시각에 HOLD_END를 내야 한다. F-04-11 후보 규칙·F-04-17 사건 종류 필터에서 홀드 끝 수가 줄어드는지 함께 본다(`scenario.ts` generateScenario)
- F-04-9 IR-09(낮음): `deviceGroup = 1 + (i>>1)`이라 사람·봇 할 것 없이 두 세션마다 같은 기기 묶음이 된다. 물량형은 `i>>3`로 8세션씩이다. 합성 정답의 기기 신호가 실제보다 넓게 묶이므로, 사람은 고유 묶음(또는 0)으로 두고 물량형·계정형만 묶는 모형을 F-04-18에서 다시 정한다(`scenario.ts:298`)
- F-04-9 IR-10(낮음): 시험 공백. ① `FX-T1 ②` 이름의 '생성기 판' 경우가 없다(판 3은 `validateParams`가 거절하고 판 오류는 ③이 본다. 이름을 고치거나 판 거절 시험을 더한다). ② FX-T2 ③이 `-600000`·`MAX_WINDOW`의 정확한 경계와 `seatCount-1`·`sectionCount-1`을 보지 않는다. ③ FX-T2 ④가 RESEARCH의 net_type·asn·device_group·member·post_seat와 INVESTIGATION의 bot_tier≠0을 하나씩 보지 않는다. ④ 공유 주소 소수 매개변수, 체크포인트 671초·10만 석, 홀드 없는 `PAY_TRY`의 기준 구현 차이를 보지 않는다. ⑤ `nextInt(2^32)`·0 시드 대체·CDF 4095칸 경계가 없다(`apps/forensics/src/lib/forensics/*.test.mjs`)
- F-04-9 IR-11(낮음): `validateMeta`가 SYNTHETIC의 `seed` 패턴(1~64자 `[A-Za-z0-9._-]`)과 `generatorVersion=2`를 보지 않아 `seed='bad seed'`·`generatorVersion=3` 파일이 통과한다. 메타데이터 시드로 다시 생성하는 F-04-10·F-04-17 경로에서 `generateScenario`가 거절해 '같은 시드→같은 시나리오'가 끊긴다. `eventId`·`caseId` 길이 제한도 함께 정한다(`events.ts:259-292`)

- 새 맥락 리뷰의 중간·낮은 지적 가운데 그 단계에서 고치지 않은 것을 '단계 ID: 지적 한 줄(파일)' 꼴로 적는다. 이 구간의 자기 단계를 다 끝낸 뒤 한 번에 고친다(ADR-0190 결정 2).
- F-04-12 TR-19(낮음): 계획 §9 게이트 표가 "시험 36개 전부 실패(도메인 14·HTTP 22)"라고 적지만 §7·실제는 38개(도메인 16·HTTP 22)이고 마이그레이션 1개를 더하면 39개다. 세 숫자를 맞춘다(`docs/review/plans/F-04-12.md:280`, `:297`).
- F-04-12 TR-20(낮음): `investigation-http.test.ts`가 공유 `clock`을 1일 앞당겼다가 마지막에 되돌리는데 `try/finally`가 없어, 중간 단언이 실패하면 시계가 앞당겨진 채 뒤 시험이 돌아 실패가 연쇄한다. 시험별 시계나 `try/finally`로 되돌린다(`services/ops-svc/test/investigation-http.test.ts:583-599`).
