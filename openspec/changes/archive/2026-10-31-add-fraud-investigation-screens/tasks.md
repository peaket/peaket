# Tasks

## 1. 화면 설계 문서

- [x] 1.1 d5에 SCR-070(§7.18)·SCR-071(§7.19)의 세 크기 배치·상태 표·고정 문구를 그리고, SCR-069(§7.17)를 세 원천으로 다시 쓰고, §2 인벤토리(71개)·§3.3 메뉴 표·§3.9 휴대폰 범위·§4.4 흐름·§5.24 SCR-042 부정 예매 변형·§7.7 SCR-046 사건 요약·§9.1 알림 한 줄·§1.2·§1.7을 고친다(design.md 결정 1·2·7~10). 확인: `python -I tools/doc-check/check_all.py` 오류 0·경고 0, 고정 문구가 docs/planning/04 행과 글자까지 같다.
- [x] 1.2 d2에 CMP-080~083을 더하고 CMP-021·040·060·063·079와 §1.1 대응표를 고친다(결정 6). 확인: doc-check `ids` 오류 0(새 CMP 정의, 정의 없는 참조 없음).
- [x] 1.3 d3에 SCR-070·071 행을 더하고 SCR-042·046·069 행을 고친다. docs/frontend.md §2.5 관제 경로 줄에 070·071을, 리플레이 줄의 '출시 뒤 선택'을 고친다. 확인: doc-check `tables` 오류 0.
- [x] 1.4 ASVS 추적 표(docs/security/asvs/forensic-replay.md)에 화면 쪽 줄(연 IP 원문은 화면 메모리에만, 퍼블리싱 위치)을 보탠다(architecture §8.2). 확인: doc-check `asvs` 오류 0.

## 2. 계산과 이름표(시험 먼저)

- [x] 2.1 관제 `entities/fraud-case`의 시험을 먼저 써서 실패를 본 뒤 `model.ts`·`fixtures.ts`를 만든다: 취소 마감, 소명 기한 기본값, 취소 마감까지 남은 시간 글과 단계, '구매 27 / 한도 4', 사건 상태·계정 소명 결과·점수 범주·사유 범주·근거 신호·공유 속성 이름표(openapi 열거값 전부), 목업 IP가 가린 값뿐인지 `[ASVS v5.0.0-14.2.6]`(결정 4·12). 확인: `pnpm --filter @peaket/console-host test` 통과(처음 실행은 실패).
- [x] 2.2 포렌식 원천 모델(`?source=` 읽기, 원천별 배지·고정 문구·보일 자리)의 시험을 먼저 쓰고 만든다(결정 7). 확인: `pnpm --filter @peaket/forensics test` 통과.
- [x] 2.3 소비자 웹 부정 예매 소명 모델(사유 범주 이름표, 잠긴 티켓 안내 글)의 시험을 먼저 쓰고 만든다(결정 9). 확인: `pnpm --filter @peaket/web test` 통과.

## 3. 화면 퍼블리싱

- [x] 3.1 화면 확인 스크립트(Playwright, 저장소 밖)를 먼저 써서 새 주소·문구가 없어 실패하는 것을 본다(결정 12). 확인: 스크립트가 새 시나리오에서 실패를 낸다.
- [x] 3.2 관제 호스트 상태에 지정(`designations`, `?designation=`)과 목업 사람 셋을 더하고, '부정 거래 조사' 메뉴를 법정 조치 아래에 지정 조사관에게만 그린다(결정 3). 확인: `/dashboard?role=cs_lead&designation=investigator`에 메뉴가 있고 `/dashboard`에는 없다.
- [x] 3.3 `@peaket/ds`에 CMP-081 CaseStatusBadge·CMP-082 ReplaySourceBadge를 만든다(결정 6). 확인: `pnpm --filter @peaket/ds typecheck` 통과.
- [x] 3.4 SCR-070 `/investigations`(d5 §7.18 상태 전부, 세 배치, 휴대폰 범위 안내 카드)를 만들고 `/preview`에 등록한다. 확인: 확인 스크립트의 SCR-070 시나리오 통과.
- [x] 3.5 SCR-071 `/investigations/:caseId`(d5 §7.19 상태 전부, 연결 그래프 목업 그림과 표로 보기, IP 가림·원문 열기 흐름, 리플레이 새 탭 링크)를 만들고 `/preview`에 등록한다. 확인: 확인 스크립트의 SCR-071 시나리오 통과, 기본 상태 본문에 원문 IP 없음.
- [x] 3.6 SCR-046 부정 예매 조치 상태 넷(사건 요약 칸, 결정 8)을 세 배치 보드에 더한다. 확인: 확인 스크립트의 SCR-046 시나리오 통과.
- [x] 3.7 SCR-069 원천 배지와 원천별 머리·필터·후보 패널·고정 문구, 더한 상태(받는 중·원천 만료·권한 없음(지정 없음))를 세 배치에 더한다(결정 7). 확인: 확인 스크립트의 SCR-069 시나리오 통과.
- [x] 3.8 SCR-042 부정 예매 소명 상태 넷과 CMP-063 `fraud` 변형을 만든다(결정 9). 확인: 확인 스크립트의 SCR-042 시나리오 통과.

## 4. 통합 확인

- [x] 4.1 바꾼 앱과 ds의 `typecheck`·`build`, 세 앱의 `test`, `python -I tools/doc-check/check_all.py`(오류 0·경고 0), `pnpm exec openspec validate add-fraud-investigation-screens`, 바꾼 파일의 줄바꿈 LF. 확인: 모두 통과하고 잠금 파일이 바뀌지 않았다(`git diff --stat pnpm-lock.yaml` 비어 있음).

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 대조 뒤 peaket-browser-check 스킬(Claude in Chrome, 연결이 없으면 OPEN[06] 기본값대로 적고 Playwright로 대신). SCR-070·071·046·069·042의 상태를 폭 360·768·1280·1440에서. 결과는 `browser-check.md`.
- 코드 리뷰: 소유자가 따로 돌리고 결과를 보낸다(이번 지시). 나온 것은 이 사이클에서 고친다.
- 보관과 커밋: 이번 지시로 하지 않는다. 리뷰를 고친 뒤 `pnpm exec openspec archive add-fraud-investigation-screens --yes`와 커밋을 소유자 지시로 한다.
