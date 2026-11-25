# v1 릴리스 범위와 동결 로컬 트랙

- **독자와 용도**: v1 출시를 자르기 전에, 기능 105개가 출시에 들어가는지(gate 포함), 동결되어 로컬에서만 개발하는지 한 표로 확인한다. 릴리스 담당·감독·CI가 같은 표를 본다.
- **정본**: 이 문서와 기계가 읽는 `docs/release/v1-scope.json`이 v1 출시 범위의 계약이다(ADR-0386). 기능의 설명·완료 정의·장부 범위는 `docs/BUILD_ORDER.md` '기능 단위 계획' 표가 정본이고, 이 문서는 그 상태를 출시 관점으로 분류만 한다.
- **요약**: 출시 포함 **37개**, 출시 보류(gate) **1개**, 동결·로컬 전용 **67개**. 합계 105개.
- **검사**: `node tools/ci/release-scope.mjs --check`가 이 표·manifest·`docs/BUILD_ORDER.md`를 대조한다. `--release`는 릴리스 가지에서 동결 기능의 플래그·마이그레이션이 섞였는지 볼 수 있는 만큼만 본다(한계는 도구 주석에 적었다).

## 1. 분류 넷

| 분류 | 뜻 | v1 출시에 들어가나 |
| --- | --- | --- |
| `release` | v1 출시 계약에 포함한다. 기능의 출시 몫이 끝났거나, 남은 몫이 출시를 막지 않는다. | 들어간다 |
| `gate` | v1에 넣되, 아래 게이트 표의 측정·검증이 끝나야 출시 후보에 넣는다. 게이트가 실패하면 v1에서 빼거나 범위를 줄인다. | 게이트 통과 뒤 들어간다 |
| `frozen-local` | ADR-0373으로 동결했다. `freeze/<ID>` 가지·워크트리에서만 개발하고 release에 체리픽하지 않는다. | 들어가지 않는다 |
| (`frozen-local` 가운데) v1 제외 | 외부 계정·법정 의무·동결 선행 때문에 v1에 넣을 수 없다. 분류는 `frozen-local` 그대로 두고 사유만 적는다. 별도 상태를 만들지 않는다. | 들어가지 않는다 |

- **release 37개**: F-01-1~7, F-02-1·2, F-03-1~4, F-04-1~8·20, F-05-1~7, F-06-2·7, F-07-5~8, F-08-2·8.
- **gate 1개**: F-08-7.
- **frozen-local 67개**: `docs/BUILD_ORDER.md` 상태가 `동결`인 59개와, 상태가 `대기`·`막힘`이지만 v1 범위 밖인 F-05-10, F-07-13, F-09-8, F-06-6, F-09-1, F-09-9, F-11-1, F-11-3.
- **BUILD_ORDER 상태와 분류가 다른 줄**: F-01-6·F-01-7·F-03-1·F-03-2·F-05-4는 표 상태가 아직 `진행`이지만 기능 가지가 `develop`에 합쳐졌고 기록 커밋이 있다. F-05-2는 `일부 구현 있음`이지만 reflow까지 닫혀 출시 몫이 끝났고, 남은 몫은 F-05-11(동결)로 넘겼다. 이 여섯 줄의 근거는 아래 표의 '출시 근거·게이트'에 커밋·R 번호로 적었다. F-03-4는 `일부 완료`라 gate로 둔다.

## 2. 기능 분류 표(105개)

- 표 순서는 `docs/BUILD_ORDER.md`의 기능 표 순서다. 번호가 뛰는 곳(F-05-10, F-06-6, F-09-8 등)은 나중에 더한 기능이라 원천 표에서도 뒤에 있다.

| ID | 영역 | 기능 | BUILD_ORDER 상태 | 분류 | 출시 근거·게이트 | 배포 단위 | 플래그 | 마이그레이션 | 남은 일 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-01-1 | 관측·경보 | 증거 수집기·14일 보존·운영 시간 기록 | 완료 | release | 기록 9b0cb8900, 계획 docs/review/plans/F-01-1.md | evidence-collector, platform(관측) | 없음 | - | 없음(출시 범위 완료) |
| F-01-2 | 관측·경보 | 대시보드 코드화·Sentry 오류 수집·마스킹 | 완료 | release | R-786, fbfa9cd49, 계획 docs/review/plans/F-01-2.md | platform(관측·Grafana) | 없음 | - | V-T39 ② 브라우저 SDK는 맡을 기능 미정 |
| F-01-3 | 관측·경보 | 수집기 2단 설정·꼬리 표본·2차 마스킹 | 완료 | release | 기록 1814fb236, 계획 docs/review/plans/F-01-3.md | platform(관측 수집기) | 없음 | - | V-T30 ③은 F-09-8 동결 |
| F-01-4 | 관측·경보 | Loki·Tempo·Mimir·exporter·서비스 그래프 | 완료 | release | 기록 da2a69564, 계획 docs/review/plans/F-01-4.md | platform(관측 저장소·otel) | 없음 | - | 뒤 몫은 F-01-9 동결 |
| F-01-5 | 관측·경보 | SLO 기록 규칙·burn-rate·28일 예산 경보 | 완료 | release | 기록 bd537ea58, ADR-0382, 계획 docs/review/plans/F-01-5.md | platform(관측 규칙) | 없음 | - | 뒤 몫 OPS-100은 F-01-10 동결 |
| F-01-6 | 관측·경보 | 경보 전달(IRM·Slack·Issues)·데드맨·DORA 주간 | 진행 | release | R-806, a03e64747, 기록 c62578dec. BUILD_ORDER는 진행이나 develop에 합쳐짐 | alert-issue-relay, platform(관측 Alertmanager) | 없음 | - | BUILD_ORDER 체크만 남음(합쳐짐) |
| F-01-7 | 관측·경보 | 경보 규칙 검사·Alertmanager 묶음·런북 없음 | 진행 | release | R-807, a5471bf23, 기록 c62578dec. BUILD_ORDER는 진행이나 develop에 합쳐짐 | platform(관측 Alertmanager), tools/ci | 없음 | - | BUILD_ORDER 체크만 남음(합쳐짐) |
| F-01-8 | 관측·경보 | 법정 접속기록 전용 갈래 | 동결 | frozen-local | v1 제외(법정): 법정 접속기록 전용 저장소·보존. ADR-0373 동결. | - | - | - | 법정 요구 확정 뒤 |
| F-01-9 | 관측·경보 | exemplar·Loki 라벨·Loki↔Tempo 연결 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-01-10 | 관측·경보 | 나머지 경보 규칙·예산 50% SEV2 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-02-1 | 관제 명령·감사 | ApplyControl 제어 gRPC·ack·판 번호 | 완료 | release | R-779, 76f31ce6c, 계획 docs/review/plans/F-02-1.md | ops-svc, admission-ctrl, purchase-svc | 없음 | ops 0021·0025, purchase 0033 | 설정형 명령은 F-02-5 동결 |
| F-02-2 | 관제 명령·감사 | 명령 6 결제사 전환·해제·채널 상한 | 완료 | release | R-790, 5a06f93c2, 계획 docs/review/plans/F-02-2.md | ops-svc, payment-svc, admission-ctrl, purchase-svc | 없음 | - | 명령 4·WAF는 F-02-6 동결 |
| F-02-3 | 관제 명령·감사 | 변경 동결 달력·승격 게이트 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-02-4 | 관제 명령·감사 | 접속기록 전용 저장소·보존 만료 파기 | 동결 | frozen-local | v1 제외(법정): 접속기록 전용 저장소·보존 만료 파기. ADR-0373 동결. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-02-5 | 관제 명령·감사 | 설정형 명령 5·7·8·9·PreviewControl | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-02-6 | 관제 명령·감사 | 명령 4 WAF·Degraded 진입·S3/매진 정적 응답 | 동결 | frozen-local | v1 제외(외부 계정): AWS WAF·S3 실제 연결. 포트·가짜만 로컬 트랙. | - | - | - | AWS 계정·WAF/S3 연결 승인 뒤 |
| F-02-7 | 관제 명령·감사 | 런북 CLI KMS 2인 서명 | 동결 | frozen-local | v1 제외(외부 계정): KMS 2인 서명 런북 CLI. | - | - | - | KMS 키·2인 서명 승인 뒤 |
| F-03-1 | 관제 콘솔 | 콘솔 MF 호스트·팀 위젯·CSP | 진행 | release | R-788, 52d465c5b, 계획 docs/review/plans/F-03-1.md. BUILD_ORDER는 진행이나 합쳐짐 | console-host, widgets, ops-svc | 없음 | ops 0028 | BUILD_ORDER 체크만 남음(합쳐짐) |
| F-03-2 | 관제 콘솔 | 원격 위젯 계약·sha384·대체 카드·성능 상한 | 진행 | release | R-789, 0e7bd6360, 계획 docs/review/plans/F-03-2.md. BUILD_ORDER는 진행이나 합쳐짐 | console-host, widgets | 없음 | - | BUILD_ORDER 체크만 남음(합쳐짐) |
| F-03-3 | 관제 콘솔 | 대시보드 4단계·Go/No-Go·경보 패널 | 완료 | release | R-798, fdb210c44, ADR-0371, 계획 docs/review/plans/F-03-3.md | console-host, widgets, ops-svc | 없음 | ops 0029 | 없음 |
| F-03-4 | 관제 콘솔 | 콘솔 명령 1·3·6 보내기·재인증·ack | 완료 | release | R-799, 3bfeeaa9c·5a6a92240, 계획 docs/review/plans/F-03-4.md. gate 통과: T13~T16 5/5(c1e372255·a5ef8b251), 브라우저 확인 OPS-390(ce291b990), ops Outbox 일 파티션 고침(05137b903) | console-host, ops-svc | 없음 | - | 없음(출시 몫 완료). T15 ② 예측 값 줄은 BAT-365(OPS-300·310)로 미룸 |
| F-03-5 | 관제 콘솔 | 공지·홈 구성·휴대폰/태블릿 배치 | 동결 | frozen-local | 동결(범위): F-03-4 gate 뒤 공지·홈 구성. | - | - | - | F-03-4 gate 뒤 |
| F-03-6 | 관제 콘솔 | MF 기준선 비교 측정 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-03-7 | 관제 콘솔 | 감사·리플레이·법정 조치·나머지 명령 화면 | 동결 | frozen-local | v1 제외(법정): 감사·리플레이·법정 조치 화면. F-03-4 gate 뒤. | - | - | - | F-03-4 gate·법정 재개 뒤 |
| F-04-1 | 분석·포렌식 | 관제 실시간 표 ops-rt·KPI 패널 | 완료 | release | R-791, 3f29786e7, 계획 docs/review/plans/F-04-1.md | ops-rt, rt-pulse, ops-svc, ClickHouse | 없음 | ClickHouse(rt) | RV220-3·8은 정리 목록 |
| F-04-2 | 분석·포렌식 | 공용 Avro 인코더·계약 판 바이트 | 완료 | release | 기록 16f5e13a6, ADR-0357, 계획 docs/review/plans/F-04-2.md | platform(avro), purchase-svc, trust-svc | 없음 | - | queue 대기 기록은 F-04-7 범위에서 정함 |
| F-04-3 | 분석·포렌식 | analytics-ingest 가명·금지 칸·오프셋 대조 | 완료 | release | R-792, 511160d18, 계획 docs/review/plans/F-04-3.md | analytics-ingest, ClickHouse | 없음 | ClickHouse(bronze) | 포렌식 몫은 동결 |
| F-04-4 | 분석·포렌식 | dbt staging/silver/gold 사실·차원 | 완료 | release | R-801, abcde71c1, 계획 docs/review/plans/F-04-4.md | dbt(analytics), ClickHouse | 없음 | dbt staging·silver | 없음 |
| F-04-5 | 분석·포렌식 | 지표 사전 31·품질 검사·매진 시각 | 완료 | release | R-802, 4e612257e, 계획 docs/review/plans/F-04-5.md | dbt(analytics), ClickHouse | 없음 | dbt metrics | 장르 랭킹·32번은 동결 |
| F-04-6 | 분석·포렌식 | 마감 실행기 R0~R3·동결·정산 대조 | 완료 | release | R-805, 2551627bd, 계획 docs/review/plans/F-04-6.md | close-runner, dbt(analytics), ClickHouse | 없음 | dbt macros·gold | 장부 빈칸 36은 B, 막지 않음 |
| F-04-7 | 분석·포렌식 | 공연 리포트·결정 규칙·파트너 판매 요약 | 완료 | release | R-808, 994c1ab2d, 계획 docs/review/plans/F-04-7.md | dbt(analytics), ClickHouse | 없음 | dbt metrics | 장부 빈칸 24는 B, 막지 않음 |
| F-04-8 | 분석·포렌식 | 초당 3만 건 신선도·누락률 측정 | 일부 완료 | release | 계획 docs/review/plans/F-04-8.md §10. 2026-11-25 측정: 30k 불가, hash 10분 안정 한계 5k(신선도 p95 3,744ms·누락 0). 병목 ops-rt 단일 핫 파티션. V-T19 ①②③ 미통과, v1 30k 수치 주장 제외. | loadtest/analytics, ClickHouse | 없음 | - | 30k 미달·5k 한계. v1은 30k 수치 주장 제외(위험 수용) |
| F-04-9 | 분석·포렌식 | 포렌식 합성 시나리오·사건 v2·체크포인트 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-10 | 분석·포렌식 | ClickHouse inv 표·inv-ingest·권한 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-11 | 분석·포렌식 | 기록 고정·해시 사슬·후보 R1~R6 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-12 | 분석·포렌식 | FRAUD_INVESTIGATOR 권한·조사 API | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-13 | 분석·포렌식 | FRAUD_ACTION 승인·제재·이의·사건 닫기 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-14 | 분석·포렌식 | 증거 묶음·Object Lock·보존/파기·내보내기 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-15 | 분석·포렌식 | /investigations·SCR-070/071·소명 제출 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-16 | 분석·포렌식 | /forensics 운영 빌드·COEP·replay-export | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-17 | 분석·포렌식 | SCR-069 리플레이 화면·타임라인 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-18 | 분석·포렌식 | CMP-079 봇 후보 산점도·2D 대체 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-19 | 분석·포렌식 | 연구 내보내기·fraud summary·용량 외삽 | 동결 | frozen-local | v1 제외(포렌식): 소유자가 포렌식 플랫폼을 v1에서 뺐다(ADR-0373). 로컬 트랙. | - | - | - | 포렌식 재개 결정 뒤 |
| F-04-20 | 분석·포렌식 | queue-svc 1초 대기 집계 QueueAggregate | 완료 | release | R-797, 8d0b58848, 계획 docs/review/plans/F-04-20.md | queue-svc | 없음 | - | QueueEntryRecord 몫은 F-04-7 범위 |
| F-05-1 | 현장 입장 | 월렛·부스 재발급·홈 화면 추가·SW 정리 | 일부 완료 | release | R-787, 계획 docs/review/plans/F-05-1.md. GAT-020 Android 월렛 QR·새로고침·PWA 설치 통과(9914e4718), PC 키 증명 측정 af63e511b. 키 증명 v1 미채택, 기존 QR·부스 재발급 유지. iPhone Safari·홈 화면·실제 스캐너는 소유자 보류로 v1 위험 수용 | ticket-svc, web, partner | 없음 | ticket 0012 | iPhone Safari·홈 화면·실제 스캐너 확인은 보류(위험 수용). 키 증명은 v1 미채택(기존 QR·부스 재발급 유지) |
| F-05-2 | 현장 입장 | 양도 요청·수락·결제자 돌려주기 | 일부 구현 있음 | release | R-810, ba4c523da, reflow c3175c7b5(닫힘), ADR-0383, 계획 docs/review/plans/F-05-2.md | ticket-svc, web | 없음 | ticket 0018 | 출시 몫 끝(거절 화면·알림은 F-05-11 동결) |
| F-05-3 | 현장 입장 | 우선 구매 권리·PRIORITY 보류·만료 | 완료 | release | R-812, 9440db38d, ADR-0385, 계획 docs/review/plans/F-05-3.md | purchase-svc, queue-svc | 없음 | - | IR-04~10은 정리 목록 |
| F-05-4 | 현장 입장 | 스캐너 오프라인 판정·즉시 업로드·재입장 | 완료 | release | R-809, 994c1ab2d, 계획 docs/review/plans/F-05-4.md. GAT-140 브라우저 확인(2026-11-24, f8dddf7be): ?live=1 결함 재현·고침, scanner-scan 20/20·scanner 159/159. 실제 카메라·휴대폰 QR·실서비스 조합은 남은 위험 | scanner, ticket-svc | 없음 | ticket 0013 | 없음(브라우저 확인 완료, 실제 카메라·휴대폰 QR은 남은 위험) |
| F-05-5 | 현장 입장 | 기기 등록/배정/폐기·DPoP·세션 확인 | 완료 | release | R-800, 55d562471, 계획 docs/review/plans/F-05-5.md | scanner, ticket-svc, identity-svc, platform | 없음 | - | 없음 |
| F-05-6 | 현장 입장 | 입장 기록 마감·미보고 스캐너 CS·중복 입장 | 완료 | release | R-811, a752f1456, 계획 docs/review/plans/F-05-6.md | ticket-svc, core-svc, purchase-svc, scanner | 없음 | ticket 0019·0020, core 0047 | IR-03·06·12는 정리 목록 |
| F-05-7 | 현장 입장 | 초대 수락·스캐너 승인·스태프 세션 | 완료 | release | R-782, b20bdd44f, 계획 docs/review/plans/F-05-7.md | identity-svc, scanner, web | 없음 | identity 0038 | 없음 |
| F-05-8 | 현장 입장 | 찜 목록·CS 모바일·공연 당일 입장 탭 | 동결 | frozen-local | 동결(범위): 찜 목록·CS 모바일·당일 입장 탭. F-05-7 뒤. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-05-9 | 현장 입장 | K10 시나리오·처리량 측정·블로그 | 동결 | frozen-local | 동결(범위): K10 측정·블로그. 측정 창 밖. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-05-11 | 현장 입장 | 양도 거절·알림·탈퇴 참여자·휴대폰 찾기 | 동결 | frozen-local | v1 제외(동결 선행): F-05-2 뒤 양도 거절·알림, F-06-1 동결에 종속. | - | - | - | F-05-2·F-06-1 뒤 |
| F-05-12 | 현장 입장 | 부스 재발급·SCR-052 실제 연결·큐 보고 | 동결 | frozen-local | 동결(범위): F-05-6·F-05-4 뒤 부스 재발급·SCR-052. | - | - | - | F-05-6·F-05-4 뒤 |
| F-05-10 | 현장 입장 | 스캐너 서비스 워커·판정 Worker·동기화 예비 | 대기 | frozen-local | 동결(범위): 스캐너 워커·앱 판. F-05-4 계획에서 분리. | - | - | - | F-05-4 뒤 로컬 트랙 |
| F-06-1 | 고객·CS·법정 | 이메일·웹 푸시·문자 발송·구독·수신 거부 | 동결 | frozen-local | v1 제외(CS·법정): 알림 발송은 대행사 계약·VAPID 운영 키가 필요(F-06-6). | - | - | - | F-06-6 계약 뒤 |
| F-06-2 | 고객·CS·법정 | CS 처리함·자동 등록·영업일 기한 | 완료 | release | R-783, d2c11542e, ADR-0364, 계획 docs/review/plans/F-06-2.md | ops-svc, console-host | 없음 | ops 0030 | 없음 |
| F-06-3 | 고객·CS·법정 | 1/2인 승인·철회·만료·예외 환불·미성년자 | 동결 | frozen-local | v1 제외(CS·법정): 1/2인 승인·예외 환불·미성년자 취소. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-06-4 | 고객·CS·법정 | 예매 제한·FRAUD_CASE·소명·화면 사본 | 동결 | frozen-local | v1 제외(CS·법정): 예매 제한·FRAUD_CASE 소명. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-06-5 | 고객·CS·법정 | 팬 조회·문의·계좌번호 탐지·담당자 가림 | 동결 | frozen-local | v1 제외(CS·법정): 팬 조회·문의·계좌번호 탐지. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-06-7 | 고객·CS·법정 | 추가 검증 이의 인정·기각·후속 반영 | 완료 | release | R-793, c8dcd468d, ADR-0364, 계획 docs/review/plans/F-06-7.md | ops-svc, queue-svc, trust-svc, core-svc | 없음 | ops 0031 | 없음 |
| F-06-6 | 고객·CS·법정 | 운영 메일·문자 대행사·VAPID 운영 키 | 막힘 | frozen-local | v1 제외(외부 계정): 운영 메일·문자 대행사·VAPID 운영 키. 소유자 몫(막힘). | - | - | - | 대행사 키·VAPID 운영 키가 비밀 값에 들어온 뒤 |
| F-07-2 | 정산·커머스·파트너 | 주문 내역·파트너 계약·수수료/보증 승인 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-07-3 | 정산·커머스·파트너 | 판매 승인 요청·SCR-021/048 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-07-4 | 정산·커머스·파트너 | 수요 예측·규모 올리기·휠체어석·판매 중지 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-07-5 | 정산·커머스·파트너 | 정산서 계산/통지/이의/확정·지급 2인 승인 | 완료 | release | R-781, f0c0206da, ADR-0368, 계획 docs/review/plans/F-07-5.md | payment-svc, ops-svc, partner | 없음 | payment 0025·0027 | 없음 |
| F-07-6 | 정산·커머스·파트너 | 토스 지급대행·KYC 보류·재요청·잔액 대사 | 완료 | release | R-796, 5b97be5d6, ADR-0369, 계획 docs/review/plans/F-07-6.md | payment-svc, ops-svc, partner | 없음 | payment 0029 | 없음 |
| F-07-7 | 정산·커머스·파트너 | 포트원 지급대행·계좌 변경·예약지급 취소·대사 | 완료 | release | R-803, 8254a83fc, ADR-0370, 계획 docs/review/plans/F-07-7.md | payment-svc, partner, web | 없음 | payment 0030·0032 | 옛 이름 호환 경로는 출시 태그 뒤 정리 |
| F-07-8 | 정산·커머스·파트너 | 일괄 환불·배상·미수금·재계산 | 완료 | release | R-804, 82ba112c8, ADR-0380, 계획 docs/review/plans/F-07-8.md | purchase-svc, payment-svc, core-svc | 없음 | payment 0033, purchase 0038 | 없음(ADR-0380) |
| F-07-9 | 정산·커머스·파트너 | 파트너 콘솔 모바일·중개자 고지·판매자 정보 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-07-10 | 정산·커머스·파트너 | 후기·사진·신고·운영자 조치 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-07-11 | 정산·커머스·파트너 | 신고 누리집·통보 차단/복구·중복 글 차단 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-07-12 | 정산·커머스·파트너 | 파트너 홈·공연 목록 SCR-062/063 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-07-13 | 정산·커머스·파트너 | SCR-020 인증 앱 재등록·복구 코드·기기 끊기 | 대기 | frozen-local | v1 제외(동결 선행): F-09-6 관리 TOTP·세션 동결에 종속. | - | - | - | F-09-6 뒤 |
| F-07-15 | 정산·커머스·파트너 | 청구·회수·손실 수동 전이·SCR-043/060/047 | 동결 | frozen-local | 동결(범위): F-07-8 뒤 화면·문구. F-08-7 데모에 필요하면 그 행만. | - | - | - | F-07-8 뒤 |
| F-08-1 | 출시·측정 | 경로별 번들 예산·좌석맵 랩·web-vitals | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-2 | 출시·측정 | 100만 외삽·진입 서버 비례·외부 한도 | 일부 완료 | release | 계획 docs/review/plans/F-08-2.md. 창 1·2 측정: X₁=800, N=1 무효, E(N) 0.25(기준 0.9), 외삽 31.25배, V-T4 판정 못 함, V-T5 표 대조 완료. v1 100만 수치 주장 제외. | loadtest, docs | 없음 | - | 100만 외삽·비례 미확인. v1 수치 주장 제외(위험 수용) |
| F-08-3 | 출시·측정 | M6 블로그·용량 산정서·비용·DORA 추세 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-4 | 출시·측정 | 정렬 설정 켬/끔 10만 비교 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-5 | 출시·측정 | 5종 6시간 장시간 시험·누수 주입 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-6 | 출시·측정 | Game Day 전체·포스트모템·SLO/KPI ADR | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-7 | 출시·측정 | 관제 데모 영상·안내·RFC·블로그 목차 | 대기 | gate | 대기, 계획 docs/review/plans/F-08-7.md. 게이트: 데모 영상·안내·RFC·블로그 목차 | docs | 없음 | - | 데모 영상·안내·RFC·블로그 목차 |
| F-08-8 | 출시·측정 | K1·K2·K7 After·장애 주입 1만 건 | 일부 완료 | release | 계획 docs/review/plans/F-08-8.md. 창 1·2: K7 ② 불변식 3회 PASS(이중 결제·좌석 누수 0), K1/K2/K7 ① 유효 실행 부족. v1 K 수치 제한, V-T19 미통과. | loadtest | 없음 | - | K7 ② 불변식만 확인. v1 K 수치 제한(위험 수용) |
| F-08-9 | 출시·측정 | 장애 주입 기록 검사·검색 측정·NFR-028 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-10 | 출시·측정 | 서비스 분리 효과·M2 블로그 3편 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-11 | 출시·측정 | 런북 41종·인시던트 기준·색인 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-12 | 출시·측정 | Game Day 로컬 ①·② | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-13 | 출시·측정 | Game Day 모의 진행·복원 연습 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-14 | 출시·측정 | K8/K9·관측 백엔드 비교 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-08-15 | 출시·측정 | 보내기 비교·Sentry 판정·M4 블로그 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-09-1 | 기반·보안 | 스테이징 Terraform·MSK/NLB/CloudFront | 막힘 | frozen-local | v1 제외(외부 계정): 클라우드 스테이징 Terraform·providers lock 소유자 결정(막힘). | - | - | - | 소유자 결정(도구 이미지·providers lock) 뒤 |
| F-09-2 | 기반·보안 | 마이그레이션 도구·Squawk·릴리스 플래그 | 동결 | frozen-local | v1 제외(외부 계정): 마이그레이션 도구·릴리스 플래그는 배포 환경이 있어야 한다. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-09-3 | 기반·보안 | Redis/Aurora/MSK/Schema Registry/PgBouncer | 동결 | frozen-local | v1 제외(외부 계정): Aurora·MSK·Redis 관리형 설정. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-09-4 | 기반·보안 | TLS/KMS/MSK 역할·비밀 교체·CloudFront/WAF | 동결 | frozen-local | v1 제외(외부 계정): TLS·KMS·CloudFront·WAF 실제 연결. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-09-6 | 기반·보안 | gw-ops IP/VPN·재인증·관리 계정·DAST | 동결 | frozen-local | v1 제외(외부 계정): gw-ops IP/VPN·DAST·관리 계정. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-09-8 | 기반·보안 | kind 재가동·야간 실행 복구 | 대기 | frozen-local | 동결(범위): 구간 5 인프라. 측정에 kind가 필요하면 클러스터 재가동 몫만. | - | - | - | 측정에 kind가 필요할 때 클러스터 재가동만 |
| F-09-9 | 기반·보안 | 엣지 KVS·KMS 키·WS 게이트웨이 PoC | 막힘 | frozen-local | v1 제외(외부 계정): 엣지 KVS·KMS 키·WS PoC(막힘, ADR-0234). | - | - | - | 클라우드 계정·KMS 키 뒤 |
| F-09-10 | 기반·보안 | KEDA/Karpenter/Argo Rollouts | 동결 | frozen-local | v1 제외(외부 계정): KEDA·Karpenter·Argo Rollouts 클러스터 설정. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-09-11 | 기반·보안 | 카나리 분석·리더 인지 롤링·그림자 계산 | 동결 | frozen-local | v1 제외(외부 계정): 카나리 분석·그림자 계산 클러스터 설정. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-10-1 | 탐색·콘텐츠 | 홈 피드·검색 읽기 모델·순위·골든 세트 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-10-2 | 탐색·콘텐츠 | image-worker·파생본·모의 검사기 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 동결 해제 뒤 freeze/<ID>에서 시작 |
| F-11-1 | 봇 방어·계정 | K6 혼동 행렬·적응 라운드·경제성 | 막힘 | frozen-local | v1 제외(외부 계정): 봇 시뮬레이터 소유자 결정 대기(OPEN[23], 막힘). | - | - | - | OPEN[23] 결정 뒤 |
| F-11-2 | 봇 방어·계정 | 표본 검토 마감·봇 블로그 | 동결 | frozen-local | 동결(범위): ADR-0373 7일 완성 범위 밖. 로컬 트랙에서만 개발. | - | - | - | 측정 창 2 재개 뒤 |
| F-11-3 | 봇 방어·계정 | 봇 시뮬레이터 12칸·사람 확인 대역 | 막힘 | frozen-local | v1 제외(외부 계정): 봇 시뮬레이터 12칸 소유자 결정 대기(OPEN[23], 막힘). | - | - | - | OPEN[23] 결정 뒤 |

## 3. gate 1개의 통과 조건

| ID | 기능 | 지금 상태 | 통과 조건 | 결과를 남길 곳 | 막히면 |
| --- | --- | --- | --- | --- | --- |
| F-08-7 | 관제 데모 영상·안내·RFC·블로그 목차 | 대기 | 데모 영상·안내·RFC 정리·블로그 목차 | `docs/review/plans/F-08-7.md` | 데모 자료를 v1 산출물에서 뺀다 |

- gate는 **출시를 막는 조건**이 아니라 **출시 후보에 넣는 조건**이다. 측정이 끝나지 않은 gate는 v1 출시 계약에서 빼고, 빼었다는 사실을 이 표와 manifest에 같은 커밋으로 적는다.
- gate 결과는 계획 파일의 '측정 결과' 절과 `docs/review/measurements/`에 남긴다. 측정 파일 경로는 결과를 만들 때 정한다(아직 없는 파일을 이 문서가 가리키지 않는다).

## 4. 동결 로컬 트랙

- 동결 기능은 `freeze/<ID>` 가지와 그 가지의 워크트리에서만 개발한다. `develop`이나 `release/1.0.0`에 합치지 않고, release에 체리픽하지 않는다.
- 동결 기능의 마이그레이션·릴리스 플래그는 로컬에만 둔다. release manifest에 없고, 출시 환경에 적용하지 않는다.
- v1에는 릴리스 플래그를 쓰지 않는다. 플래그 배포 기구(F-09-2)가 동결이라 `deploy/envs/<환경>/flags/`가 없고, 출시 기능은 플래그 없이 공개한다. 이 표의 `플래그` 칸이 `없음`인 까닭이다.
- 동결을 풀려면 새 ADR이나 이 ADR의 개정으로 manifest의 분류를 바꾸고, `freeze/<ID>`의 변경을 `develop`에 정상 병합한 뒤 다음 릴리스에 넣는다. 동결을 푼 기능이 v1 출시 계약에 자동으로 들어가지는 않는다.

## 5. 출시 자르기와 배포

1. gate 1개의 결과와 `node tools/ci/release-scope.mjs --check`, `node tools/ci/release-scope.mjs --release`, 전체 CI·장부·불변식 검사를 통과한다.
2. `develop`에서 `release/1.0.0`을 자른다. 릴리스 가지에는 버그 수정과 출시 메타데이터만 넣는다(ADR-0074).
3. 릴리스 후보를 데모에서 검증하고 `main`에 병합 커밋으로 넣은 뒤 `v1.0.0` 태그를 단다.
4. 운영 배포는 태그가 가리키는 후보 다이제스트로 한다. Argo CD가 지금은 `develop`의 `deploy/`를 읽으므로, `main`/릴리스 태그의 `deploy/`를 읽게 바꾸는 것은 배포 설정 변경이다. 소유자 확인 전에는 이 문서의 '소유자 확인' 목록에 남긴다.
5. 릴리스 가지를 `develop`으로 역병합하고, 다음 릴리스에서 이 표를 다시 쓴다.

## 6. 소유자 확인이 필요한 것

- **Argo CD 소스 변경**: 지금은 `develop`의 `deploy/`를 읽는다. `main`/릴리스 태그의 `deploy/`를 읽게 바꾸는 것은 배포 설정 변경이라 소유자 확인이 필요하다(ADR-0386 결정 3).
- **릴리스 가지·태그 푸시**: `develop` 밖 원격 가지와 태그 푸시는 소유자 몫이다(`docs/architecture.md` §8.6 '맡기기').
- **외부 계정이 필요한 동결 기능**: F-09-1·F-09-3·F-09-4·F-09-6·F-09-9·F-09-10·F-09-11(클라우드), F-02-6·F-02-7(AWS WAF/S3·KMS), F-06-6(메일·문자 대행사·VAPID), F-11-1·F-11-3(봇 시뮬레이터). 이 기능은 v1에 넣지 않는다.
- **법정 의무가 필요한 동결 기능**: F-01-8·F-02-4(접속기록), F-04-9~19(포렌식), F-06-1·F-06-3·F-06-4·F-06-5(CS·법정), F-03-7(법정 조치 화면). v1 출시 계약에 넣지 않았고, 넣으려면 소유자 결정이 필요하다.

## 7. 이 표를 고치는 법

- 분류를 바꾸면 `docs/release/v1-scope.md`의 같은 줄, `docs/release/v1-scope.json`의 `features`·`gates`·`frozen`, `docs/BUILD_ORDER.md`의 상태를 같은 커밋에서 고친다.
- `node tools/ci/release-scope.mjs --check`가 셋을 대조한다. 표에 없는 ID, manifest에 없는 ID, 두 번 나온 ID, 분류·상태가 어긋난 줄은 실패한다.
- `docs/BUILD_ORDER.md`의 기능을 더하거나 빼면 이 표와 manifest도 같은 커밋에서 고친다. 105개가 아니면 검사가 실패한다.
