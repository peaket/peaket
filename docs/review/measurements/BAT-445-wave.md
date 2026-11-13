# 웨이브 보고서: 갈래 3 BAT-445

- 날짜: 2026-11-13
- 가지: `wave/lane3-BAT-445`(바탕 `origin/develop` `3d4c4943`, 합치기·푸시 안 함)
- 배치: BAT-445(GAT-200·GAT-150, B, R-523)
- 웨이브 규칙: ADR-0267(배치마다 싼 게이트, 웨이브 끝에 비싼 게이트 한 번)

## 1. 커밋

| R | 커밋 | 내용 |
| --- | --- | --- |
| R-523 | `1a418e33`(첫 구현, amend 전) | GAT-150 스캔 큐·BarcodeDetector 경계, GAT-200 태블릿 확인 목록·SCR-053 휴대폰 배치 시험 |
| R-523 | 이 보고서를 포함한 최종 커밋 | heavy gate에서 찾은 조용한 메모리 폴백·DB 연결 수명·문서 정합·시험 범위 보강 |

## 2. 게이트

| 게이트 | 결과 |
| --- | --- |
| scanner 전체 시험 | 11 통과(스캔 큐 8·디코더 3) |
| console-host 전체 시험 | 39 통과(SCR-053 휴대폰 보드 O-T27·O-T31 포함) |
| scanner·console-host typecheck | 통과 |
| scanner·console-host production build | 통과(Vite 8·webpack 5) |
| eslint(바뀐 src) | 통과 |
| doc-check | 오류 0·경고 4(기존 API 3·mermaid 건너뜀) |
| `ledger --batch BAT-445 --require` | 통과(자동 시험 2, 미검증 0) |
| `trace-check O-T27,O-T31` | 통과(시험 50개를 봄) |
| 변이 | 15개 넣어 15개 잡음, 놓침 0 |
| 4관점 리뷰 | 높음 1(고침), 중간 4(고침), 낮음 3(남김) |
| 브라우저 확인 | 생략(화면 렌더링 변경 없음: console-host는 시험만, scanner는 저장소·디코더 경계만) |
| CI | GitHub Actions는 푸시 금지로 돌리지 않았다. 위 로컬 등가 게이트와 production build로 대신했다 |

- 이 저장소의 scanner·console-host에는 Docker test-int 무대가 따로 없다. 두 패키지의 전체 시험 명령(`node --test`)이 스캔 큐·기기 보드까지 덮는다.

## 3. 변이 15개

- 스캔 큐 8: DB 이름, 표 이름, 색인 이름, strict→relaxed, put이 complete를 기다리지 않음, ack의 기본 내구성, DB 열기 실패를 메모리로 숨김, 브라우저 IndexedDB 부재를 메모리로 숨김.
- 디코더 3: QR 형식 빈 목록, 빈 원문 반환, BarcodeDetector 생성자 오류를 잡지 않음.
- 휴대폰 보드 4: 등록을 권하는 문구, 즉시 폐기 버튼 삭제, 폐기 확인 버튼 삭제, 배치 변경 문구 삽입.

## 4. 4관점 리뷰

- **높음 1(고침)**: `openScanQueue`가 IndexedDB를 열지 못하거나 브라우저에 IndexedDB가 없으면 조용히 `MemoryScanQueue`로 떨어져, 통과 화면의 strict 내구성 약속을 어겼다. 이제 Node 시험에서만 메모리를 쓰고, 브라우저에서는 오류를 내 통과를 막는다. 시험 2개를 더했다.
- **중간 4(고침)**:
  1. BarcodeDetector 생성자가 QR 형식 미지원으로 던지면 디코더 경계가 죽었다. try/catch로 `undefined`를 돌려 zxing-wasm 대체 경로로 넘긴다. 시험 1개를 더했다.
  2. DB 연결 수명: `onversionchange` close·`onblocked` 거절이 없고, 표가 이미 있으면 색인을 만들지 않았다. 셋 다 고쳤다.
  3. 문서 정합: `docs/frontend.md` §3.8 표의 색인 `uploaded`가 구현 `nextAttemptAtMs`와 달랐고, BAT-445 확인 목록이 "휴대폰은 보기 전용, 폐기는 큰 화면만"이라 O-T27·보드와 모순이었다. 둘 다 실제 동작에 맞췄다.
  4. 시험 범위: strict 시험이 put만 보고 ack/fail·DB 열기 실패·생성자 실패·폐기 확인 버튼을 덮지 않았다. 시험 4개와 변이 5개를 더했다.
- **낮음 3(남김)**:
  1. `due`에 임차(claim)가 없어 두 탭이 같은 묶음을 동시에 올릴 수 있다. 서버는 UUIDv7 멱등이라 중복은 버려진다. 업로더를 붙일 때 한 탭/임차를 정한다.
  2. 큐 본문은 IndexedDB에 평문으로 있다. 관람객 이름·연락처는 담지 않고 기기 안에만 둔다(offline-gate §9의 남는 위험).
  3. 재시도 횟수 상한·백오프 상한은 두지 않았다. offline-gate §6.5의 "업로드 확인까지 다시 보낸다"를 따른다. 업로더 단계에서 5초 묶음·500건과 함께 정한다.
- **보안**: 새 PII·권한 경로는 없다. 스캔 큐는 기기 로컬이고, 휴대폰 보드의 폐기는 기존 `useRo`·서버 역할 집행을 그대로 쓴다. 새 보안 지적은 위 폴백 하나였다.

## 5. 남은 문제

1. 실제 관리형 태블릿 실기(카메라·회전·전원 차단·네트워크 끊김)는 소유자 몫이다. `docs/review/plans/BAT-445-tablet-check.md` §3에 점검표만 있다.
2. strict 쓰기가 판정 지연 예산(p95 0.15초)에 주는 영향은 O-T39 실기 측정이다. 아직 재지 않았다.
3. zxing-wasm 대체 디코더는 의존성 설치가 가능할 때 붙인다. 지금은 BarcodeDetector가 없거나 QR을 지원하지 않으면 디코더를 만들지 않는다.
4. Dexie 4가 작업 트리에 없어 IndexedDB 어댑터로 구현했다. Dexie로 바꿀 때는 `ScanQueue` 포트 어댑터만 바꾼다.
5. 업로더(5초 묶음·500건·재시도·로그아웃 전 비우기)는 아직 화면·Worker에 연결하지 않았다. 이 배치는 저장소·디코더 경계까지다.
6. 브라우저 확인은 화면 렌더링 변경이 없어 생략했다. SCR-053 휴대폰 보드는 시험만 더했고 화면 코드는 바뀌지 않았다.

## 6. 컨테이너

- BAT-445에서는 Docker/kind test-int를 쓰지 않아 새 컨테이너를 만들지 않았다.
- 정리: 2026-11-04에 만들어진 갈래 3 시험용 PostgreSQL `lane3-idpg`(중지됨, 익명 볼륨)를 `docker rm -v`로 지웠다. `docker ps -a`에서 `lane3`·`bat445` 이름의 컨테이너가 남지 않았음을 확인했다.
