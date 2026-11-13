# 완성 장부: control-tower

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/control-tower.md`, `docs/security/asvs/control-tower.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B | 2 | 106 | 0 | 0 | 1 | 3 | 0 | 24 | 156 | 292 |
| 합계 | 2 | 106 | 0 | 0 | 1 | 3 | 0 | 24 | 156 | 292 |

## docs/features/control-tower.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| C-T1 | — | 제어 명령 접수 SLO 검증 | 운영자 10명이 동시에 접속한 부하(SLO 계측 표준 조건)에서 접수 p95 ≤ 500ms(NFR-008·§4, 2026-11-01 정합 점검)와 성공률… | 빈칸 | B | — |
| C-T2 | — | 명령 전파 신뢰성 검증 | 최종 승인이 끝난 때부터 받는 쪽의 ack(집행하는 모든 곳이 판 N 이상을 적용, ADR-0103)가 끝날 때까지 종단 p99 ≤ 3초와 성공률 99.9%를… | 빈칸 | B | — |
| C-T3 | — | 시스템 안전 한계 강제 통제 | 허용 기준값을 벗어난 동시 입장 목표 수치를 설정하려 하면 422 Unprocessable Entity로 바로 거절되고, 시스템 반영이 0건임을 입증한다. | 빈칸 | B | — |
| C-T4 | — | 2인 상호 승인 무결성 | 명령 요청자와 승인자가 같은 계정이면 승인이 거부되고, 10분 대기 시간 초과 시 자동으로 만료된다. | 빈칸 | B | — |
| C-T5 | — | 위험 명령 재인증 강제 | 킬스위치 같은 중대 명령을 낼 때 5분 이내의 유효한 재인증 토큰이 없으면 403 Forbidden으로 차단된다. | 빈칸 | B | — |
| C-T6 | — | 명령 사전 실행 모의(dry-run) | 명령 집행 전, 센 값은 같은 시각의 원천(대기열 Redis·purchase DB·게이트웨이 집계)에서 직접 센 값과 같고, 예측 값은 식과 넣은 값·가정이… | 빈칸 | B | — |
| C-T7 | — | 파드 ack 시간 초과 예외 처리 | 대상 파드의 수신 확인이 시간 초과되면 FAILED 상태로 바뀌고, 수동 재시도([ 다시 시도 ])와 채운 런북 CLI 명령 한 줄 안내가 바로 나온다. | 빈칸 | B | — |
| C-T8 | — | 제어 명령 긴급 원복(Revert) | 직전 정상 설정값을 복원했다는 ack를 정상으로 받고, 1차 명령과 롤백 명령이 감사 로그에 총 2건으로 무결하게 남는다. | 빈칸 | B | — |
| C-T9 | — | 자동 제어와 수동 제어의 경합 | 운영자가 수동 명령으로 개입한 직후 15분간 AIMD 자동 조정이 멈추고, 만료 후 확인을 거쳐 자동 조정으로 돌아옴을 입증한다. 자동 조절 멈춤 중 지정 뒤… | 빈칸 | B | — |
| C-T10 | — | 자동화 제어 긴급 정지 스위치 | commander 1인이 긴급 정지를 실행하면 입장 제어 자동화(AIMD 조정·에러 버짓 연동 감축·Degraded 후보 추천)가 바로 멈추고, 오토스케일링은… | 빈칸 | B | — |
| C-T11 | — | 시스템 자동 조치 감사 기록 | 에러 버짓 50% 소진에 따른 목표치 자동 감축이 행위자 '시스템(SYSTEM)'으로 감사 로그에 온전히 기록되고, 같은 때 콘솔 SEV2 '예산 50% 감축… | 빈칸 | B | — |
| C-T12 | — | Degraded Mode 전이 감사 기록 | 자동이든 수동이든 모든 Degraded Mode 활성화 이력이 감사 로그에 빠짐없이 기록된다. | 빈칸 | B | — |
| C-T13 | — | ops-svc 장애 시 런북 구동 | ops-svc가 멈춘 상태에서 비상 Job으로 런북을 돌려 전파 p99 ≤ 10초를 달성한다. 두 사람의 서명이 필요한 묶음에 KMS 서명이 없거나 하나뿐이면… | 빈칸 | B | — |
| C-T14 | — | 대규모 관제 지표 반영 지연시간 | 초당 3만 건의 원천 텔레메트리(시스템이 내보내는 지표·로그·요청 기록 같은 운영 신호) 이벤트가 들어오는 환경에서 신선도 두 길(누적 길: 심장 박동 발행 →… | 빈칸 | B | — |
| C-T15 | — | 관측 스택 전체 정지 시 생존성 | 메트릭 수집 스택이 마비되면 데드맨 스위치가 바로 작동한다. 관측 스택과 함께 멈춘 Grafana 대신 외부 합성 점검과 콘솔의 Prometheus 밖… | 빈칸 | B | — |
| C-T16 | — | 법정 24시간 조치 기한 준수 | 신고기관·수사기관 공문 등록 후 22시간이 지난 시점까지 미처리면 SEV2 보안 경보가 자동으로 발령되고, 조치 결과서가 정상으로 출력된다. | 빈칸 | B | — |
| C-T17 | — | 수사기관 자료 요청 적법성 검증 | 법원 영장이 없는 통신사실확인자료 요청이 오면 시스템이 거부 사유를 밝혀 차단하고, 적법한 요청은 법정 대장에 정상으로 저장된다. 적법한 요청의 제출 파일에는… | 빈칸 | B | — |
| C-T18 | — | 인시던트 타임라인 리플레이·Game Day 탐지와 반영 시간 | Game Day 모의 훈련 타임라인이 장애 주입 → 경보 발령 → 명령 집행 → 시스템 정상화 순으로 오차 없이 재현된다. 같은 실행의… | 빈칸 | B | — |
| C-T19 | — | 관리자 개인정보 접속기록 보존 | 파트너용 예매자 명단을 내려받은 사유와 대상 건수가 불변 접속기록 저장소에 최소 2년 이상 온전히 보존된다. | 빈칸 | B | — |
| C-T20 | — | 파트너 판매 현황 조회의 복구력(2026-10-28 SSE에서 바꿈… | 네트워크를 3분 끊었다 되살리면 다음 조회가 지금의 전체 상태(누적 판매 수가 관제 누적 뷰와 같음)를 받고, 끊긴 동안 연결 표시등이 경고였다가 돌아온다. 탭… | 빈칸 | B | — |
| C-T21 | — | 비인가 IP 대역 접근 통제 | 허용 IP 대역 밖에서 관제 콘솔·`ops-api`에 접속하려 하면 관제 배포의 웹 ACL에서 막힌다. 원본 확인 머리가 없거나 시청자… | 빈칸 | B | — |
| C-T22 | — | 같은 내용 게시물 자동 차단 | 명령 10으로 차단한 게시물과 공백·문장부호·전각 차이만 있는 본문으로 새 관람 후기를 저장하면 즉시 숨김 상태가 되고, 조치 결과서에 '같은 내용 차단'으로… | 자동 시험 | B | 시험: services/core-svc/test/review.http.test.ts |
| C-T23 | — | 보안 사고 신고·통지 기한 | 인지 시각 10:00으로 침해사고를 등록하면 SEV1이 뜨고 다음 날 10:00 신고 기한이 생긴다. 22시간이 지난 때(다음 날 08:00) SEV2가 다시… | 빈칸 | B | — |
| C-T24 | — | 접속기록 점검 | 파트너 계정이 같은 명단을 24시간에 3회 내려받으면 다음 날 점검 목록에 '반복 다운로드'로 올라오고, 사유 확인과 사후조치를 기록할 때까지 미조치로 남는다… | 빈칸 | B | — |
| C-T25 | — | Go/No-Go 필수 항목 실패 | 노드 시계 오프셋을 30ms로 만든 상태로 T-30분 점검을 하면 No-Go가 된다. 오픈 시각에는 입장 일시정지와 대기실 공지가 걸린 채로 로비 셔플은… | 빈칸 | B | — |
| C-T26 | — | 진행 중 배포가 남은 T-30분 점검 | 대형 회차 T-100분에 시작해 표본 부족으로 판정 불가에 멈춘 카나리(devops §6.2)를 두고, 그 카나리의 `freeze-guard` 자동… | 빈칸 | B | — |
| C-T27 | — | 감사 기록 변조 탐지 | 앵커가 찍힌 감사 기록 한 줄의 사유를 DB에서 고친다. 다른 시험에서는 마지막 앵커 뒤의 맨 끝 기록을 지운다. 그 뒤 검증 잡을 돌리면, 고친 기록은 다음… | 빈칸 | B | — |
| C-T28 | — | 런북 서명과 연결 신원 | 서명이 하나뿐인 묶음(명령 3 정지 묶음 제외), 같은 운영자가 두 번 서명한 묶음, 5분 지난 묶음, 이미 쓴 commandId의 묶음, operator 한… | 빈칸 | B | — |
| C-T29 | — | 홈 구성 저장 | operator가 판매 승인 전 공연을 배너에 넣고, 대체 텍스트 없이 저장하고, 두 운영자가 같은 판으로 거의 동시에 저장하고, viewer가 저장을… | 빈칸 | B | — |
| C-T30 | — | 판단 위젯 요약과 원인 분석 링크 | 판매 진행 중 탭에서 Redis 메모리를 주의 기준 [가정] 위로 올리면 포화도 요약이 '주의'로 바뀐다. 시험 서비스가 새 종류의 오류를 내면 1분 [가정]… | 빈칸 | B | — |
| C-T31 | — | 제어 입력 없음 표시 | purchase-svc 지표 수집을 끊으면 30초 [가정] 안에 위 상태 바가 <입력 없음>이 되고, 경보 패널 '이 회차 판단'에 SEV2가… | 빈칸 | B | — |
| C-T32 | — | 경보 묶기·억제와 패널 두 갈래 | 같은 회차·여정에 예산 SEV1과 SEV2를 함께 울리면 SEV2는 Slack·온콜로 가지 않고, 콘솔에서 SEV1 아래 접힌 줄로 보인다. 다른 회차의 경보와… | 빈칸 | B | — |
| C-T33 | — | 명령 4·5 효과 줄 | 명령 4를 실행하고 시험용 사람 세션을 그 대역에서 보내면, 10분 안에 효과 줄에 차단 비율 상승과 추가 검증 통과율 하락이 보인다. 통과율이 10%p… | 빈칸 | B | — |
| C-T34 | — | 인시던트 선언과 탐지 경로 | 명령 3을 실행하면 인시던트 선언 할 일과 포스트모템 초안이 생기고, 초안에 첫 경보 시각이 채워진다. 명령 1만 실행한 회차는 선언 대상이 아니다. 경보가… | 빈칸 | B | — |
| C-T35 | — | 처리량 급감 표시 | 판매 중 회차에서 결제 시뮬레이터의 SDK 스크립트를 막아 결제 접수가 줄면, 서버 오류가 없어 SLO 경보는 울리지 않는다. 그 대신 6분 [가정] 안에 '이… | 빈칸 | B | — |
| C-T36 | — | 실시간 표 신선도와 Degraded 전환 | 판매 중 회차에서 로컬 `ops-rt` 작업자의 삽입을 늦춰(ClickHouse 응답 지연 주입) 심장 박동 반영을 늦추면, 판매 중 탭 머리의 신선도가 5초를… | 빈칸 | B | — |
| C-T37 | — | 거래 사건 끊김 표시 | 판매 중 회차에서 로컬 거래 토픽(`trade.*`) 생산을 60초 넘게 멈추면, 심장 박동 신선도는 정상인 채 판매 누적·잔여석 옆에 '거래 사건 끊김'이… | 빈칸 | B | — |
| C-T38 | — | 감사 체크포인트와 공개 타임스탬프 | 로컬 kind에서 감사 기록 100건을 쓴 뒤 일 체크포인트를 실행하면 체크포인트(직전 해시·seq 범위·머클 루트), 서명, '대기' 증명이 감사 앵커 버킷과… | 빈칸 | B | — |
| C-T39 | — | 검증 묶음으로 기록 하나 확인 | SCR-031에서 내보낸 검증 묶음은 검증 도구를 통과한다. 기록 정규화 값의 한 글자를 바꾸거나 다른 기록의 잎 솔트를 넣으면 포함 증명이 실패한다… | 빈칸 | B | — |
| C-T40 | — | 체크포인트 사슬의 빈틈과 바꿔치기 | 공개 목록에서 체크포인트 하나를 빼거나 같은 번호의 다른 체크포인트(다른 루트)를 넣으면, 검증 도구가 번호 빈틈이나 직전 해시 불일치로 실패한다. 같은 번호에… | 빈칸 | B | — |
| C-T41 | — | 공개 캘린더 장애 | 캘린더 주소를 모두 막아도 체크포인트·서명·내부 앵커는 남고, 다음 실행에서 다시 찍는다. 6시간 넘게 밀리면 SEV3이고, 거래·온세일 경로의 지표는 변하지… | 빈칸 | B | — |
| C-T42 | — | 기록 파기 뒤 공개 루트 | 법정 보존 기간이 지난 감사 기록과 그 잎 솔트를 파기한 뒤에도 공개 체크포인트의 사슬·서명·공개 타임스탬프 검증은 통과한다. 공개 값만으로는 파기한 기록을… | 빈칸 | B | — |
| C-T43 | — | 수요 예측과 규모 올리기 | 구독 수와 지난 회차를 넣은 시험 데이터에서 예상 진입 인원(중앙·상단)과 제안 등급이 식과 같다. 구독 수가 0.5~2배인 지난 회차가 10개 미만이면 기본… | 미검증 | B | BAT-620 · 수요 예측식·기본 비율·규모 올리기·T-30분·LARGE 간격·commander 예외는 core-svc 시험으로 확인했다. 화면의 '규모 올리기 검토'·SEV3 알림(24시간 뒤 SEV2)·감사… |
| C-T44 | ① | 자동 조치의 끝내는 조건 | ① 실시간 표 신선도를 5초 넘게 3분 늦췄다 되돌리면 대체 표시가 5분 뒤 실시간 표로 돌아온다. … 의 걸림·풀림을 조치마다 보여 준다. 시간 조건이 있는… | 빈칸 | B | — |
| C-T44 | ② | 자동 조치의 끝내는 조건 | ② 결제사 시뮬레이터를 승인 기한(10분)보다 길게 멈춰 재시도 큐가 다 빈 뒤 되살리면, 확인 호출이 3분 정상인 뒤 시험 재개(새 결제 시도의 5%)로… | 빈칸 | B | — |
| C-T44 | ③ | 자동 조치의 끝내는 조건 | ③ 429를 받은 채널 상한은 그 회차 끝까지 낮은 값을 유지한다. … 의 걸림·풀림을 조치마다 보여 준다. 시간 조건이 있는 자동 해제는 조건을 채운 시간만큼… | 빈칸 | B | — |
| C-T44 | ④ | 자동 조치의 끝내는 조건 | ④ 시험용 Mimir에 넣은 28일 값으로 예산을 소진했다가 회복시키면 배포 잠금이 걸렸다 풀린다. 클러스터 Prometheus에 15일 넘는 값이 없어도… | 빈칸 | B | — |
| C-T44 | ⑤ | 자동 조치의 끝내는 조건 | ⑤ 보류 표 `held_event`(처리하지 못한 사건을 Kafka 데드 레터 토픽 대신 그 서비스 DB에 옮겨 두는 표, ADR-0142)의 사건을… | 빈칸 | B | — |
| C-T44 | ⑥ | 자동 조치의 끝내는 조건 | ⑥ CloudFront 설정 검사에서 대기열 파일 배포가 원본 그룹(500·502·503·504, 연결 시간 초과 2초·시도 1회)을 쓰고, 명령 6의 S3… | 빈칸 | B | — |
| C-T44 | ⑦ | 자동 조치의 끝내는 조건 | ⑦ 관제 콘솔의 '걸린 자동 조치' 위젯과 상태 바 수가 | 빈칸 | B | — |
| C-T45 | — | 운영 명령 주석과 서비스 지도 | 시험 환경에서 명령 2(입장 일시정지)를 요청·승인하고 10분 만료까지 두면 ops-svc 로그에 `ops_event` 줄이 단계마다 하나씩 표본 추출 없이… | 빈칸 | B | — |
| C-T46 | — | 판매 일시정지 1인 실행과 2인 재개 | commander 1인이 재인증 뒤 명령 3을 내면 승인 대기 없이 전파되어 ack p99 3초 안에 ACKED가 되고, 사후 검토 보고서 할 일(작성… | 빈칸 | B | — |
| C-T47 | — | 2인 승인 시연(데모) | 데모 환경에서 2인 명령을 요청한 뒤 데모 막대의 '요청자 본인으로 승인 시도'를 누르면 403이고, '데모 승인자로 승인'을 누르면 데모 도우미가 데모 승인자… | 빈칸 | B | — |
| C-T48 | — | 받는 쪽 과부하 중 제어 명령 | purchase-svc에 이벤트 루프 지연 p99 200ms [가정]가 나는 부하를 건 채 명령 3을 내면, 제어 gRPC(데드라인 1초 [가정], 같은 명령… | 빈칸 | B | — |
| C-T49 | — | KMS 정지 중 명령 커밋 | KMS 호출을 막은 채 명령 2를 내면 접수 p95 500ms 안에 커밋·전파된다. mac이 빈 감사 행이 1분 [가정]을 넘으면 SEV2가 뜨고, KMS를… | 빈칸 | B | — |
| C-T50 | — | 킬스위치 중 확장·재시작 | 명령 3이 ACKED인 회차에서 purchase-svc를 둘에서 여섯으로 늘리고, 다른 시험에서는 파드 하나를 강제로 다시 시작한다. 새 파드의 홀드·결제… | 빈칸 | B | — |
| C-T51 | — | 오래 끈 기능 플래그 | 관람 후기 기능 플래그를 명령 9로 끄고 시계를 8일 넘긴 뒤 core-svc를 다시 시작하면 새 파드에서도 꺼져 있다. 만료가 지난 로그 레벨 값은 새 파드가… | 빈칸 | B | — |
| C-T52 | — | 에러 버짓 100% 소진과 Degraded 후보 추천(추천 적용… | 온세일 윈도우 안에서 결제 확정 여정의 에러 버짓을 100% 소진시키면, 시스템이 Degraded Mode 후보를 추천하고 긴급 알림을 보낸다. 운영자 한 명의… | 빈칸 | B | — |
| C-T53 | — | Kafka 장애 중 대체 결제사 전환(추천 적용 2026-10-29… | 로컬 거래·제어 Kafka(Strimzi)를 막은 채 명령 6 대체 결제사 전환을 내면, 제어 gRPC로 payment-svc 모든 파드와… | 빈칸 | B | — |
| C-T54 | — | 설정형 명령의 적용 확인(추천 적용 2026-10-29… | 명령 8(로그 레벨)을 내고 받는 서비스 파드 하나가 설정 사건을 받지 못하게 하면, 30초 [가정] 안에 명령 카드가 '적용 확인 중'에서 '적용 확인 안… | 빈칸 | B | — |
| C-T55 | ① | 경보 링크 허용 목록(추천 적용 2026-10-30, §8… | ①만 콘솔 경보 배너와 패널에 새 탭 링크(`rel="noopener"`)로 보이고 | 빈칸 | B | — |
| C-T55 | ② | 경보 링크 허용 목록(추천 적용 2026-10-30, §8… | ②는 글자로만 보인다. 어느 경우든 ops-svc에서 경보 주소로 나간 연결이 0번이다(시험 서버 접속 기록). `runbookUrl`이 빈 경보는… | 빈칸 | B | — |
| C-T55 | ③ | 경보 링크 허용 목록(추천 적용 2026-10-30, §8… | ③는 글자로만 보인다. 어느 경우든 ops-svc에서 경보 주소로 나간 연결이 0번이다(시험 서버 접속 기록). `runbookUrl`이 빈 경보는… | 빈칸 | B | — |
| C-T55 | ④ | 경보 링크 허용 목록(추천 적용 2026-10-30, §8… | ④는 글자로만 보인다. 어느 경우든 ops-svc에서 경보 주소로 나간 연결이 0번이다(시험 서버 접속 기록). `runbookUrl`이 빈 경보는… | 빈칸 | B | — |
| C-T55 | ⑤ | 경보 링크 허용 목록(추천 적용 2026-10-30, §8… | ⑤는 글자로만 보인다. 어느 경우든 ops-svc에서 경보 주소로 나간 연결이 0번이다(시험 서버 접속 기록). `runbookUrl`이 빈 경보는… | 빈칸 | B | — |
| C-T56 | ① | 기관 요청서 PDF 받기(추천 적용 2026-10-30, §9 '자료… | ①은 검사 결과 '위협 없음' 뒤에만 내려받기가 되고, 그 전에는 내려받을 수 없다 | 빈칸 | B | — |
| C-T56 | ② | 기관 요청서 PDF 받기(추천 적용 2026-10-30, §9 '자료… | ②는 415, | 빈칸 | B | — |
| C-T56 | ③ | 기관 요청서 PDF 받기(추천 적용 2026-10-30, §9 '자료… | ③는 415, | 빈칸 | B | — |
| C-T56 | ④ | 기관 요청서 PDF 받기(추천 적용 2026-10-30, §9 '자료… | ④는 413이다 | 빈칸 | B | — |
| C-T56 | ⑤ | 기관 요청서 PDF 받기(추천 적용 2026-10-30, §9 '자료… | ⑤는 415, | 빈칸 | B | — |
| C-T56 | ⑥ | 기관 요청서 PDF 받기(추천 적용 2026-10-30, §9 '자료… | ⑥은 내려받기가 막히고 SEV2가 뜨며 감사 저장소로 옮겨지지 않는다. 내려받기 응답은 `Content-Disposition: attachment`이고 이름은… | 빈칸 | B | — |
| C-T57 | ① | 조회 역할의 칸 가림(추천 적용 2026-10-30, §9 '접근 권한… | ①의 응답에는 건 요약(기관, 종류, 기한, 상태)만 있고 요청 대상자 식별값·제출 파일·통지 대상 목록이 0건이다. 붙인 매개변수는 무시되고, 제출 파일… | 빈칸 | B | — |
| C-T57 | ② | 조회 역할의 칸 가림(추천 적용 2026-10-30, §9 '접근 권한… | ②의 응답에는 건 요약(기관, 종류, 기한, 상태)만 있고 요청 대상자 식별값·제출 파일·통지 대상 목록이 0건이다. 붙인 매개변수는 무시되고, 제출 파일… | 빈칸 | B | — |
| C-T57 | ③ | 조회 역할의 칸 가림(추천 적용 2026-10-30, §9 '접근 권한… | ③에는 원문 칸이 보이고 열람이 접속기록에 남는다 | 빈칸 | B | — |
| C-T58 | ① | ops-svc AWS 권한 범위(운영 설계만, 추천 적용… | ①만 허용이고 | 빈칸 | B | — |
| C-T58 | ② | ops-svc AWS 권한 범위(운영 설계만, 추천 적용… | ②만 허용이고 | 빈칸 | B | — |
| C-T58 | ③ | ops-svc AWS 권한 범위(운영 설계만, 추천 적용… | ③은 거부다. 정책에 와일드카드 자원(`*`)이 없다. 결과는 '설계 검사'로 적는다(docs/architecture.md §8.2 4). 포트폴리오 로컬에는… | 빈칸 | B | — |
| C-T58 | ④ | ops-svc AWS 권한 범위(운영 설계만, 추천 적용… | ④은 거부다. 정책에 와일드카드 자원(`*`)이 없다. 결과는 '설계 검사'로 적는다(docs/architecture.md §8.2 4). 포트폴리오 로컬에는… | 빈칸 | B | — |
| C-T58 | ⑤ | ops-svc AWS 권한 범위(운영 설계만, 추천 적용… | ⑤은 거부다. 정책에 와일드카드 자원(`*`)이 없다. 결과는 '설계 검사'로 적는다(docs/architecture.md §8.2 4). 포트폴리오 로컬에는… | 빈칸 | B | — |
| C-T58 | ⑥ | ops-svc AWS 권한 범위(운영 설계만, 추천 적용… | ⑥은 거부다. 정책에 와일드카드 자원(`*`)이 없다. 결과는 '설계 검사'로 적는다(docs/architecture.md §8.2 4). 포트폴리오 로컬에는… | 빈칸 | B | — |
| C-T59 | ① | 수사기관 제공 자료의 commander 승인(추천 적용… | ①은 409이고 승인 전 상세에는 제출 파일이 없다 | 빈칸 | B | — |
| C-T59 | ② | 수사기관 제공 자료의 commander 승인(추천 적용… | ②는 403(요청자 본인) | 빈칸 | B | — |
| C-T59 | ③ | 수사기관 제공 자료의 commander 승인(추천 적용… | ③은 403(commander 아님) | 빈칸 | B | — |
| C-T59 | ④ | 수사기관 제공 자료의 commander 승인(추천 적용… | ④는 403 `reauth-required` | 빈칸 | B | — |
| C-T59 | ⑤ | 수사기관 제공 자료의 commander 승인(추천 적용… | ⑤는 RECEIVED → PENDING_APPROVAL → RECEIVED → PENDING_APPROVAL → APPROVED → EXTRACTED이고, 제출… | 빈칸 | B | — |
| C-T59 | ⑥ | 수사기관 제공 자료의 commander 승인(추천 적용… | ⑥은 422이고 대장에 행이 생기지 않는다 | 빈칸 | B | — |
| C-T59 | ⑦ | 수사기관 제공 자료의 commander 승인(추천 적용… | ⑦은 RECEIVED로 돌아가고 행위자 SYSTEM의 만료 기록이 남는다. 승인·거부·만료는 모두 감사 로그와 `data_request_approval`에 남는다 | 빈칸 | B | — |
| C-T60 | — | 접속기록 자기 점검(시연)(추천 적용 2026-10-30, §9… | 데모 환경은 200이고 종결 기록에 '자기 점검(시연)'이 남으며, SCR-032 이상 건 줄과 점검 보고 요약에 그 표시가 보인다. 운영 설정은… | 빈칸 | B | — |
| C-T61 | ① | 만료된 WAF 차단 거두기(추천 적용 2026-10-30, §5… | ①만 빠지고 … 의 명령이 AUTO_EXPIRED(행위자 SYSTEM)가 된다. 작업이 5분 [가정] 넘게 성공하지 못하면 SEV2가 뜬다. 작업 역할이 그… | 빈칸 | B | — |
| C-T61 | ② | 만료된 WAF 차단 거두기(추천 적용 2026-10-30, §5… | ②는 남는다. 충돌 때는 다시 읽어 한 번 더 바꾸고, 그사이 들어온 변경을 지우지 않는다. ops-svc를 다시 올리면 | 빈칸 | B | — |
| C-T61 | ③ | 만료된 WAF 차단 거두기(추천 적용 2026-10-30, §5… | ③는 남는다. 충돌 때는 다시 읽어 한 번 더 바꾸고, 그사이 들어온 변경을 지우지 않는다. ops-svc를 다시 올리면 | 빈칸 | B | — |
| C-T61 | ④ | 만료된 WAF 차단 거두기(추천 적용 2026-10-30, §5… | ④는 남는다. 충돌 때는 다시 읽어 한 번 더 바꾸고, 그사이 들어온 변경을 지우지 않는다. ops-svc를 다시 올리면 | 빈칸 | B | — |
| C-T62 | ① | 법정 조치 목록·상세 조회(추천 적용 2026-10-30, §9… | ①은 두 페이지 합이 150건이고 빠지거나 겹친 건이 0건이며, 기본 순서가 기한이 가까운 순이다 | 빈칸 | B | — |
| C-T62 | ② | 법정 조치 목록·상세 조회(추천 적용 2026-10-30, §9… | ②는 400이다 | 빈칸 | B | — |
| C-T62 | ③ | 법정 조치 목록·상세 조회(추천 적용 2026-10-30, §9… | ③은 통보·자료 요청이 403이고 보안 사고는 `view` SUMMARY만 온다 | 빈칸 | B | — |
| C-T62 | ④ | 법정 조치 목록·상세 조회(추천 적용 2026-10-30, §9… | ④는 모두 SUMMARY이고 원문 칸이 0건이다(C-T57) | 빈칸 | B | — |
| C-T62 | ⑤ | 법정 조치 목록·상세 조회(추천 적용 2026-10-30, §9… | ⑤는 모두 `Cache-Control: private, no-store`다 | 빈칸 | B | — |
| C-T62 | ⑥ | 법정 조치 목록·상세 조회(추천 적용 2026-10-30, §9… | ⑥은 404다. operator가 자료 요청 상세를 연 것은 접속기록에 남는다 | 빈칸 | B | — |
| C-T63 | ① | 지정 없는 운영자의 조사 경로(추천 적용 2026-10-31, §9.2… | ①은 ops-svc가 403 `investigator-required`를 돌려주고, 감사 기록과 `admin_data_access`에 권한 밖 조회 시도가 남아… | 빈칸 | B | — |
| C-T63 | ② | 지정 없는 운영자의 조사 경로(추천 적용 2026-10-31, §9.2… | ②는 ops-svc의 `RolesGuard`가 요청마다 판정한 역할로 403이다(ADR-0172). … 의 콘솔에는 '부정 거래 조사' 메뉴와 대시보드 종료 후… | 빈칸 | B | — |
| C-T63 | ③ | 지정 없는 운영자의 조사 경로(추천 적용 2026-10-31, §9.2… | ③은 200이고 로그 줄에 `invAccess`·`caseRef`·`rows`가 있으며 원문 IP는 없다 | 빈칸 | B | — |
| C-T63 | ④ | 지정 없는 운영자의 조사 경로(추천 적용 2026-10-31, §9.2… | ④는 403이다(지정이 없는 것으로 본다) | 빈칸 | B | — |
| C-T63 | ⑤ | 지정 없는 운영자의 조사 경로(추천 적용 2026-10-31, §9.2… | ⑤는 5초 [가정] 안에 403이 된다 | 빈칸 | B | — |
| C-T63 | ⑥ | 지정 없는 운영자의 조사 경로(추천 적용 2026-10-31, §9.2… | ⑥은 `Sec-Fetch-Mode: navigate`라 403이다 | 빈칸 | B | — |
| C-T64 | — | 요청자 자기 승인(추천 적용 2026-10-31, §9.2 '조치… | 둘 다 403이고 표·계정·예매 제한이 바뀌지 않는다. 승인 업무는 승인 대기(PENDING_APPROVAL)로 남고 사건은 결정… | 빈칸 | B | — |
| C-T65 | — | 가명정보 취급자 commander의 승인(추천 적용… | 둘 다 403 `fraud-approver-ineligible`이고 SCR-046에 승인 단추가 없다. 지정이 없는 다른 commander는 승인할 수 있다 | 빈칸 | B | — |
| C-T66 | — | 승인자가 보는 범위(추천 적용 2026-10-31, §9.2 '승인자가… | `GET /v1/ops/approval-requests/{approvalId}`가 `fraudCaseSummary`(묶음 요약·근거 신호·소명 결과·조사관… | 빈칸 | B | — |
| C-T67 | — | 일반 승인 요청 경로로 만들기(추천 적용 2026-10-31… | 422이고 승인 업무가 생기지 않으며 사건 상태가 바뀌지 않는다 | 빈칸 | B | — |
| C-T68 | ① | 취소 마감 만료(데모 시계, 추천 적용 2026-10-31, §9.2… | ①에 SEV3, | 빈칸 | B | — |
| C-T68 | ② | 취소 마감 만료(데모 시계, 추천 적용 2026-10-31, §9.2… | ②에 SEV2 경보(`kind` legal, 회차와 사건 수만)가 뜬다 | 빈칸 | B | — |
| C-T68 | ③ | 취소 마감 만료(데모 시계, 추천 적용 2026-10-31, §9.2… | ③에 표 취소 요청이 만료되고(행위자 SYSTEM) 요청자·승인자에게 알림이 간다 | 빈칸 | B | — |
| C-T68 | ④ | 취소 마감 만료(데모 시계, 추천 적용 2026-10-31, §9.2… | ④는 승인해도 실행하지 않는다 | 빈칸 | B | — |
| C-T68 | ⑤ | 취소 마감 만료(데모 시계, 추천 적용 2026-10-31, §9.2… | ⑤는 409 `cancel-deadline-passed`다. `RESTRICT` 요청은 5영업일 [가정]에 만료되고, 양도 잠금은 입장 시작에 풀린다 | 빈칸 | B | — |
| C-T69 | — | 조사관 지정의 대상과 충돌(추천 적용 2026-10-31, §9.2… | F의 두 번째 지정은 두 순서 모두 409 `designation-conflict`, G·H는 422… | 빈칸 | B | — |
| C-T70 | — | 소명 요청과 양도 잠금(추천 적용 2026-10-31, §9.2… | 소명 요청 때 표들이 잠기고 진행 중인 양도 요청은 시스템이 철회한다. 소명 요청 응답에 `lockExpiresAt`(소명 요청 + 14일)이 있다. 새 양도는… | 빈칸 | B | — |
| C-T71 | ① | 증거 묶음 내보내기와 대량 조회(추천 적용 2026-10-31… | ①은 거절된다 | 빈칸 | B | — |
| C-T71 | ② | 증거 묶음 내보내기와 대량 조회(추천 적용 2026-10-31… | ②는 그 요청 범위의 행만 든 제출 파일이 그 기관 요청에 붙고, 제출 기록은 §9 절차로 남는다 | 빈칸 | B | — |
| C-T71 | ③ | 증거 묶음 내보내기와 대량 조회(추천 적용 2026-10-31… | ③은 CSV에 회차 집계만 있고 5건 미만 칸이 합쳐진다 | 빈칸 | B | — |
| C-T71 | ④ | 증거 묶음 내보내기와 대량 조회(추천 적용 2026-10-31… | ④는 `ComplaintPacket` JSON이고 계정 ID·실명·연락처·IP·결제 정보·연계정보·다른 계정이 없다. 내보낼 때마다 사유가 관리 연속성 기록에… | 빈칸 | B | — |
| C-T72 | — | 이의 인정과 되돌림(추천 적용 2026-10-31, ADR-0171… | 이용 제한은 `LIFT_RESTRICTION` 승인 업무(요청자가 아니고 가명정보 취급자 지정이 없는 commander, 재인증)로만 풀린다. 풀기 요청 중… | 빈칸 | B | — |
| C-T73 | ① | 승인자의 실질 관여(추천 적용 2026-10-31, §9.2 '조치… | ①는 409 `fraud-summary-not-viewed`(연 기록 `approval_summary_view`는 사람마다다) | 빈칸 | B | — |
| C-T73 | ② | 승인자의 실질 관여(추천 적용 2026-10-31, §9.2 '조치… | ②는 409 `fraud-summary-not-viewed`(연 기록 `approval_summary_view`는 사람마다다) | 빈칸 | B | — |
| C-T73 | ③ | 승인자의 실질 관여(추천 적용 2026-10-31, §9.2 '조치… | ③은 422 `approval-reason-required` | 빈칸 | B | — |
| C-T73 | ④ | 승인자의 실질 관여(추천 적용 2026-10-31, §9.2 '조치… | ④는 422 `approval-scope-invalid` | 빈칸 | B | — |
| C-T73 | ⑤ | 승인자의 실질 관여(추천 적용 2026-10-31, §9.2 '조치… | ⑤는 남은 계정의 표만 취소되고, 뺀 계정은 다른 열린 조치 요청이 없어 양도 잠금이 풀린다. 이유·뺀 범위·E가 처음 연 시각이 사건 기록과 감사 기록에 남는다 | 빈칸 | B | — |
| C-T73 | ⑥ | 승인자의 실질 관여(추천 적용 2026-10-31, §9.2 '조치… | ⑥ 그런 경로와 화면 단추가 없다(openapi·화면 검사) | 빈칸 | B | — |
| C-T74 | ① | 자료 요청 점검표에 더한 넷(추천 적용 2026-10-31, §9… | ①은 점검표 실패로 REFUSED(422, 거부 사유 기록) | 빈칸 | B | — |
| C-T74 | ② | 자료 요청 점검표에 더한 넷(추천 적용 2026-10-31, §9… | ②는 제215조 제2항으로 고치라는 실패 항목이 남는다 | 빈칸 | B | — |
| C-T74 | ③ | 자료 요청 점검표에 더한 넷(추천 적용 2026-10-31, §9… | ③은 점검표 실패로 REFUSED(422, 거부 사유 기록) | 빈칸 | B | — |
| C-T74 | ④ | 자료 요청 점검표에 더한 넷(추천 적용 2026-10-31, §9… | ④는 그 항목이 점검표에서 '영장 없이 내지 않음'으로 빠지고 법이 정한 항목만 추출 범위로 고를 수 있다 | 빈칸 | B | — |
| C-T74 | ⑤ | 자료 요청 점검표에 더한 넷(추천 적용 2026-10-31, §9… | ⑤는 제출 파일에 연결 그래프·행동 요약·TLS 지문·봇 라벨·조사관 의견이 없고, 제출 기록에 받는 쪽에 이용 제한·안전조치를 요청하는 문구가 붙는다 | 빈칸 | B | — |

## docs/security/asvs/control-tower.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-1.1.1 | — | L2 | 입력은 그 형식으로 인코딩된 데이터가 기대될 때만 정규 형식으로 한 번만 디코딩(이스케이프 해제 포함)하고, 검증·정화 같은 다음 처리보다 먼저 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 (영역:… |
| v5.0.0-1.1.2 | — | L2 | 출력 인코딩·이스케이프는 그 값을 쓰는 해석기 바로 앞의 마지막 단계에서 하거나 해석기가 직접 한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, tools/web-checks/rich-text/seatmap-editor.spec.mj… |
| v5.0.0-1.2.1 | — | L1 | HTTP 응답·HTML·XML 출력은 문맥(HTML 요소·속성·주석, CSS, HTTP 헤더)에 맞게 인코딩해 메시지·문서 구조가 바뀌지 않게 한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs… |
| v5.0.0-1.2.2 | — | L1 | URL을 동적으로 만들 때 신뢰하지 않는 값을 문맥에 맞게 인코딩하고 안전한 프로토콜만 허용한다(`javascript:`·`data:` 금지). | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/preload.test.mjs, packages/api-client/test/policy.test.ts (영역: apps/console-host… |
| v5.0.0-1.2.3 | — | L1 | JavaScript·JSON을 동적으로 만들 때 인코딩·이스케이프해 구조가 바뀌지 않게 한다. | ID만 | B | 다른 곳 시험: apps/web/src/_pages/event-detail/model/detail.test.mjs, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-1.2.4 | — | L1 | 데이터 조회·DB 쿼리는 파라미터 쿼리, ORM 등으로 SQL 등 DB 주입을 막는다(저장 프로시저 포함). | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts, services/purchase-svc/test-int/booking-restrictions.int.test.ts 외… |
| v5.0.0-1.2.5 | — | L1 | OS 명령 주입을 막고 OS 호출은 파라미터화하거나 명령줄 인코딩을 쓴다. | 해당 없음 | B | 해당 없음(`ops-svc`는 OS 명령을 부르지 않는다. AWS·Kubernetes는 SDK로 부른다. 런북 Job은 서명을 확인한 고정 이미지의 CLI가 서명 묶음 파일만 읽는다) |
| v5.0.0-1.2.6 | — | L2 | LDAP 주입을 막는다. | 해당 없음 | B | 해당 없음(LDAP을 쓰지 않는다) |
| v5.0.0-1.2.7 | — | L2 | XPath 주입을 쿼리 파라미터화·사전 컴파일로 막는다. | 해당 없음 | B | 해당 없음(XPath를 쓰지 않는다) |
| v5.0.0-1.2.8 | — | L2 | LaTeX 처리기를 안전하게 설정하고(`--shell-escape` 금지) 명령 허용 목록을 쓴다. | 해당 없음 | B | 해당 없음(LaTeX을 쓰지 않는다) |
| v5.0.0-1.2.9 | — | L2 | 정규식의 특수 문자를 이스케이프해 메타 문자로 해석되지 않게 한다. | 해당 없음 | B | 해당 없음(사용자 값을 정규식에 넣지 않는다. 명령 4의 대역은 IP 주소 해석기로 읽는다) |
| v5.0.0-1.3.1 | — | L1 | WYSIWYG 편집기 등에서 오는 신뢰하지 않는 HTML 입력은 모두 잘 알려진 안전한 HTML 정화 라이브러리나 프레임워크 기능으로 정화한다. | 해당 없음 | B | 해당 없음(HTML 입력을 받지 않는다. 사유·요약·보고서는 평문이다) |
| v5.0.0-1.3.2 | — | L1 | `eval()` 같은 동적 코드 실행을 피하고, 불가피하면 사용자 입력을 실행 전에 정화한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs (영역: apps/console-host, services/ops-svc) |
| v5.0.0-1.3.3 | — | L2 | 위험할 수 있는 문맥에 넘기는 데이터는 그 문맥에 안전한 문자만 허용하고 너무 긴 입력을 자르는 등 미리 정화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/review.test.ts, services/core-svc/test/search.http.test.ts 외 4곳 (영역: services/ops-svc) |
| v5.0.0-1.3.4 | — | L2 | 사용자가 준 SVG는 애플리케이션에 안전한 태그·속성만 담도록 검증하거나 정화한다(`script`·`foreignObject` 제외). | 해당 없음 | B | 해당 없음(SVG를 받지 않는다. 요청서 원본은 PDF만 받는다, V5) |
| v5.0.0-1.3.5 | — | L2 | 사용자가 넣은 Markdown·CSS·XSL·BBCode 같은 스크립트·표현식 템플릿 내용을 정화하거나 끈다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test/seatmap-parse.test.ts 외 1곳 (영역:… |
| v5.0.0-1.3.6 | — | L2 | 다른 서비스를 부르는 데 쓰기 전에 신뢰하지 않는 값을 프로토콜·도메인·경로·포트 허용 목록과 대조하고 위험할 수 있는 문자를 정화해 SSRF를 막는다. | 자동 시험 | B | 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts |
| v5.0.0-1.3.7 | — | L2 | 신뢰하지 않는 입력으로 템플릿을 만들지 않아 템플릿 주입을 막고, 불가피하면 템플릿에 넣는 신뢰하지 않는 입력을 정화하거나 엄격히 검증한다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-1.3.8 | — | L2 | JNDI 조회에 넣기 전에 입력을 정화하고 JNDI를 안전하게 설정한다. | 해당 없음 | B | 해당 없음(JNDI를 쓰지 않는다) |
| v5.0.0-1.3.9 | — | L2 | memcache로 보내기 전에 내용을 정화한다. | 해당 없음 | B | 해당 없음(memcache를 쓰지 않는다. `ops-svc`는 공유 Redis(메모리에 데이터를 두는 빠른 저장소)도 쓰지 않는다, ADR-0102) |
| v5.0.0-1.3.10 | — | L2 | 예상과 다르거나 악의적으로 해석될 수 있는 형식 문자열은 처리 전에 정화한다. | ID만 | B | 다른 곳 시험: apps/web/src/shared/i18n/catalog.test.mjs (영역: apps/console-host, apps/widgets) |
| v5.0.0-1.3.11 | — | L2 | 메일 시스템에 넘기기 전에 사용자 입력을 정화해 SMTP·IMAP 주입을 막는다. | 빈칸 | B | 영역: services/core-svc |
| v5.0.0-1.4.1 | — | L2 | 메모리 안전한 문자열·메모리 복사·포인터 연산으로 스택·버퍼·힙 오버플로를 찾아내거나 막는다. | 해당 없음 | B | 해당 없음(메모리 관리 언어(TypeScript)만 쓴다) |
| v5.0.0-1.4.2 | — | L2 | 부호·범위·입력 검증으로 정수 오버플로를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test/media-rules.test.ts 외 3곳 (영역:… |
| v5.0.0-1.4.3 | — | L2 | 할당한 메모리와 자원을 해제하고 해제된 참조를 지워 use-after-free를 막는다. | 해당 없음 | B | 해당 없음(메모리 관리 언어만 쓴다) |
| v5.0.0-1.5.1 | — | L1 | XML 파서를 제한적으로 설정하고 외부 엔터티 해석 같은 위험 기능을 꺼 XXE를 막는다. | 해당 없음 | B | 해당 없음(XML을 처리하지 않는다. 요청서 PDF는 해석하지 않고 저장만 한다) |
| v5.0.0-1.5.2 | — | L2 | 신뢰하지 않는 데이터의 역직렬화는 허용 객체 타입 목록 등으로 안전하게 처리하고, 안전하지 않다고 알려진 방식은 쓰지 않는다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, packages/validation/test/sale-policy.test.ts 외… |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test/sale-eligibility.http.test.ts 외 8곳 (영역:… |
| v5.0.0-2.1.2 | — | L2 | 여러 데이터 항목을 함께 볼 때의 논리적·문맥적 일관성을 검증하는 방법을 문서에 정의한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 5곳… |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/args090.test.mjs 외 79곳 (영역: services/ops-svc) |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/save-answer.test.mjs… |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/core-svc/test-int/catalog.int.test.ts 외 39곳 (영역:… |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-deposit.int.t… |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | ID만 | B | 다른 곳 시험: packages/validation/test/sale-policy.test.ts, services/admission-ctrl/test/admission-leader.test.ts 외 41곳 (영역:… |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/review.test.ts, services/payment-svc/test-int/payment-confirm-runner.int.test.ts 외 43곳… |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | 해당 없음 | B | 해당 없음(관제 업무에 한정 수량 자원이 없다. 같은 범위·종류의 명령이 겹치면 판 번호가 큰 쪽이 이기고, 승인 대기·전파 중 겹침은 콘솔이 표시한다, control-tower §4) |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | ID만 | B | 다른 곳 시험: services/core-svc/test/review.http.test.ts, services/core-svc/test/wish.http.test.ts 외 25곳 (영역:… |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/result-files.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/import-check.test.mjs… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs… |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/src/features/social-login/server/login-routes.test.mjs, services/identity-svc/test/http.test.ts 외 2곳… |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/security.test.mjs, apps/web/server/csp-hash-server.test.mjs 외 5곳 (영역:… |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/console-host, apps/widgets) |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | ID만 | B | 다른 곳 시험: apps/web/src/_app/security/page-headers.test.mjs, packages/config/headers/headers.test.mjs 외 1곳 (영역:… |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | ID만 | B | 다른 곳 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs 외… |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, apps/partner/src/_pages/seatmap-editor/model/save… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | B | 다른 곳 시험: services/core-svc/test/seatmap-templates.http.test.ts, services/queue-svc/test/leave-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/partner |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 해당 없음 | B | 해당 없음(관제 콘솔은 창 메시지를 받지 않는다. 원격 위젯과는 모듈 호출과 Zod로 검사한 사건으로만 주고받는다, asvs/frontend.md 1.5.2) |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/verify-return.test.mjs, apps/web/src/_pages/login/model/state.test.mjs 외 8곳 (영역:… |
| v5.0.0-4.1.1 | — | L1 | 본문이 있는 모든 HTTP 응답에 실제 내용과 맞는 `Content-Type`을 두고, 텍스트·XML처럼 IANA 미디어 타입이 정하는 경우 안전한 문자… | ID만 | B | 다른 곳 시험: services/purchase-svc/test/http.test.ts, services/v0-monolith/test-int/queue.int.test.ts (영역:… |
| v5.0.0-4.1.2 | — | L2 | 브라우저로 직접 여는 사용자 화면만 HTTP에서 HTTPS로 자동 리디렉션하고, 그 밖의 서비스·엔드포인트는 리디렉션하지 않는다. | 빈칸 | B | 영역: apps/console-host |
| v5.0.0-4.1.3 | — | L2 | 로드밸런서·프록시·BFF 같은 중간 계층이 넣어 애플리케이션이 쓰는 헤더(`X-Real-IP`·`X-Forwarded-*`·`X-User-ID` 등)는 최종… | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 4곳… |
| v5.0.0-4.2.1 | — | L2 | 로드밸런서·방화벽 등 모든 구성요소가 HTTP 버전에 맞게 메시지 경계를 정해 요청 밀반입을 막는다(HTTP/1.x는 `Transfer-Encoding`이… | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-4.3.1 | — | L2 | 허용 쿼리 목록, 깊이·개수 제한, 쿼리 비용 분석 가운데 하나 이상으로 비싼 중첩 쿼리에 의한 GraphQL·데이터 계층 표현식 서비스 거부를 막는다. | 해당 없음 | B | 해당 없음(관제는 REST와 SSE이고 GraphQL을 쓰지 않는다, ADR-0100. 위젯 조회는 위젯 키별 경로라 임의 질의를 받지 않는다) |
| v5.0.0-4.3.2 | — | L2 | GraphQL을 외부에 공개하는 경우가 아니면 운영 환경에서 인트로스펙션을 끈다. | 해당 없음 | B | 해당 없음(위와 같다) |
| v5.0.0-4.4.1 | — | L1 | 모든 WebSocket 연결에 WSS를 쓴다. | 해당 없음 | B | 해당 없음(관제 콘솔은 WebSocket(연결을 열어 둔 채 서버와 브라우저가 주고받는 통신 방식)을 쓰지 않는다. 실시간은 HTTPS 위의 SSE다, ADR-0100) |
| v5.0.0-4.4.2 | — | L2 | WebSocket 첫 HTTP 핸드셰이크에서 `Origin`을 허용 출처 목록과 대조한다. | 해당 없음 | B | 해당 없음(WebSocket을 쓰지 않는다. SSE 흐름은 `gw-ops`가 `Origin`을 관제 콘솔과 대조한다, asvs/frontend.md 4.4.2) |
| v5.0.0-4.4.3 | — | L2 | 표준 세션 관리를 쓸 수 없으면 세션 관리 요구사항을 따르는 전용 토큰을 쓴다. | 해당 없음 | B | 해당 없음(WebSocket을 쓰지 않는다. SSE 흐름은 표준 관리 계정 쿠키를 쓴다) |
| v5.0.0-4.4.4 | — | L2 | 전용 WebSocket 세션 토큰은 인증된 HTTPS 세션으로 처음 받거나 검증한다. | 해당 없음 | B | 해당 없음(WebSocket을 쓰지 않는다) |
| v5.0.0-5.1.1 | — | L2 | 업로드 기능마다 허용 파일 형식·확장자·최대 크기(풀린 크기 포함)와, 최종 사용자가 내려받아 처리해도 안전하게 만드는 방법(악성 파일을 찾았을 때의 동작… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-5.2.1 | — | L1 | 성능 저하나 서비스 거부 없이 처리할 수 있는 크기의 파일만 받는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test/sale-eligibility.http.test.ts… |
| v5.0.0-5.2.2 | — | L1 | 단독이든 zip 같은 압축 파일 안이든 받는 파일의 확장자가 기대한 것인지와 내용이 그 형식과 맞는지(매직 바이트, 이미지 다시 쓰기 등) 검증하고, L1은… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-5.2.3 | — | L2 | 압축 파일은 풀기 전에 풀린 크기와 파일 수 상한을 확인한다. | 해당 없음 | B | 해당 없음(압축 파일을 받지 않는다, 5.1.1) |
| v5.0.0-5.3.1 | — | L1 | 신뢰하지 않는 입력으로 올라오거나 만들어져 공개 폴더에 저장된 파일은 HTTP 요청으로 직접 열어도 서버 쪽 코드로 실행되지 않게 한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외… |
| v5.0.0-5.3.2 | — | L1 | 파일 작업 경로는 사용자가 보낸 파일 이름 대신 내부에서 만들거나 믿을 수 있는 값으로 만들고, 사용자 파일 이름·메타데이터를 써야 하면 엄격히 검증·정화해… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts… |
| v5.0.0-5.4.1 | — | L2 | JSON·JSONP·URL 파라미터에 담긴 것을 포함해 사용자가 보낸 파일 이름은 검증하거나 무시하고, 응답의 `Content-Disposition`에 파일… | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/export.test.mjs, apps/partner/src/_pages/seatmap-editor/model/gold… |
| v5.0.0-5.4.2 | — | L2 | 내주는 파일 이름을 인코딩·정화해 문서 구조를 지키고 주입을 막는다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-5.4.3 | — | L2 | 신뢰하지 않는 출처의 파일은 백신으로 검사해 알려진 악성 파일을 내려주지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-8.1.1 | — | L1 | 인가 문서에 호출자 권한과 자원 속성에 따라 기능 수준·데이터 수준 접근을 제한하는 규칙을 정한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/event-summary.http.test.ts, services/core-svc/test/partner-production.http.test.ts 외 3곳… |
| v5.0.0-8.1.2 | — | L2 | 인가 문서에 호출자 권한과 자원 속성(상태 등)에 따라 필드 수준 읽기·쓰기 접근을 제한하는 규칙을 정한다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, packages/platform/test/auth-guard.test.ts 외 28곳… |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/rls.int.test.ts 외 39곳 (영역:… |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | ID만 | B | 다른 곳 시험: packages/contracts/test/close-additional-properties.test.ts, packages/contracts/test/types.test.ts 외 6곳 (영역:… |
| v5.0.0-8.3.1 | — | L1 | 인가 규칙을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 쪽 제어에 기대지 않는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: services/ops-svc) |
| v5.0.0-8.4.1 | — | L2 | 다중 테넌트 애플리케이션은 테넌트 사이 통제로 호출자의 작업이 상호작용 권한이 없는 테넌트에 영향을 주지 않게 한다. | 해당 없음 | B | 해당 없음(관제 콘솔은 플랫폼 운영자만 쓰고 파트너 테넌트가 들어오지 않는다. 파트너 실시간 판매 현황(§11)은 이 표 범위 밖이다) |
| v5.0.0-11.1.1 | — | L2 | NIST SP 800-57 같은 키 관리 표준을 따르는 키 관리 정책과 키 수명 주기를 문서로 두고, 키를 필요 이상의 주체와 공유하지 않는다(공유 비밀은 두… | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-11.1.2 | — | L2 | 애플리케이션이 쓰는 모든 암호 키·알고리즘·인증서의 암호 목록을 만들어 정기적으로 갱신하고, 키마다 쓸 수 있는 곳과 없는 곳, 보호할 수 있는 데이터와 없는… | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test/quicknet-verifier.test.ts 외 1곳… |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/payment-svc/test/portone-gateway.test.ts (영역:… |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/virtual-account-deposit.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | ID만 | B | 다른 곳 시험: packages/shuffle/test/drand-seal.test.ts, services/admission-ctrl/test/kms-seed-opener.test.ts 외 3곳 (영역:… |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.te… |
| v5.0.0-11.4.1 | — | L1 | 서명·HMAC·KDF·난수 생성 등 일반 암호 용도에는 승인된 해시 함수만 쓰고 MD5 같은 금지 함수는 쓰지 않는다. | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역:… |
| v5.0.0-11.4.2 | — | L2 | 비밀번호는 현재 권고 파라미터를 적용한 승인된 비밀번호 해시 함수로 저장한다. | 해당 없음 | B | 해당 없음(이 기능에는 비밀번호가 없다. 관리 계정 비밀번호는 auth.md 11.4.2가 판정한다) |
| v5.0.0-11.4.3 | — | L2 | 서명·데이터 인증·무결성에 쓰는 해시는 충돌 저항성과 알맞은 출력 길이를 갖추고, 출력은 충돌 저항이 필요하면 256비트 이상, 제2 역상 저항만 필요하면… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, packages/shuffle/test/shuffle.test.ts (영역:… |
| v5.0.0-11.4.4 | — | L2 | 비밀번호에서 비밀 키를 만들 때 키 스트레칭 파라미터가 있는 승인된 KDF를 쓰고, 그 파라미터는 무차별 대입으로 키가 뚫리지 않게 보안과 성능을 맞춰 정한다. | 해당 없음 | B | 해당 없음(비밀번호에서 키를 만들지 않는다) |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | ID만 | B | 다른 곳 시험: services/payment-svc/test/pg-selection.test.ts, services/payment-svc/test/simulator-gateway.test.ts 외 5곳 (영역:… |
| v5.0.0-11.6.1 | — | L2 | 키 생성·시드 생성과 디지털 서명 생성·검증에는 승인된 알고리즘과 운용 모드만 쓰고, 알려진 공격에 약한 키(페르마 인수분해에 약한 RSA 키 등)를 만들지… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts, services/admission-ctrl/test-int/kms-seed.int.test.ts 외 4곳… |
| v5.0.0-12.1.1 | — | L1 | TLS 1.2와 1.3처럼 권장되는 최신 버전만 켜고 가장 최신 버전을 우선한다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-server.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-12.1.2 | — | L2 | 권장 암호 스위트만 켜고 가장 강한 스위트를 우선하며, L3는 순방향 비밀성을 주는 스위트만 지원한다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-12.1.3 | — | L2 | mTLS 클라이언트 인증서가 신뢰된 것인지 확인한 뒤에만 그 신원으로 인증·인가한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역:… |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | 빈칸 | B | 영역: services/ops-svc |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 다른 단계 | B | 운영 확인 · 구현 위치가 '(운영 설계만)'이다 |
| v5.0.0-13.1.1 | — | L2 | 애플리케이션의 통신 필요(의존하는 외부 서비스, 사용자가 외부 위치를 줄 수 있는 경우 포함)를 모두 문서화한다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/consumers.test.ts (영역: services/core-svc, services/ops-svc) |
| v5.0.0-13.2.1 | — | L2 | 표준 사용자 세션을 쓰지 않는 백엔드 구성 요소 사이 통신을 개별 서비스 계정·단기 토큰·인증서로 인증하고, 바뀌지 않는 비밀번호·API 키를 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/portone-gateway.int.test.ts, services/payment-svc/test-int/toss-gateway.int.test… |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | ID만 | B | 다른 곳 시험: loadtest/test/manifests090.test.mjs, loadtest/test/review060.test.mjs 외 9곳 (영역: services/ops-svc) |
| v5.0.0-13.2.3 | — | L2 | 서비스 인증에 기본 자격 증명을 쓰지 않는다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts (영역:… |
| v5.0.0-13.2.4 | — | L2 | 애플리케이션이 통신할 수 있는 외부 자원의 허용 목록을 정의한다. | ID만 | B | 다른 곳 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts 외 1곳 (영역:… |
| v5.0.0-13.2.5 | — | L2 | 서버가 요청을 보내거나 자원을 불러올 수 있는 대상의 허용 목록을 설정한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts, services/payment-svc/test/portone-config.test.ts 외 2곳… |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, loadtest/test/runner.test.mjs 외 13곳 (영역: apps/console-host, apps/widgets) |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/kms-seed-opener.test.ts, services/admission-ctrl/test/seed-reveal.test.ts 외 5곳… |
| v5.0.0-13.4.1 | — | L1 | 배포물에 `.git`·`.svn` 같은 소스 관리 메타데이터가 없거나, 있어도 외부와 애플리케이션 모두 접근할 수 없다. | ID만 | B | 다른 곳 시험: apps/web/server/deployment-id.test.mjs, apps/web/server/standalone.test.mjs 외 2곳 (영역: apps/console-host… |
| v5.0.0-13.4.2 | — | L2 | 운영 환경의 모든 구성요소에서 디버그 모드를 끈다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts, services/pg-simulator/test/simulator.test.ts (영역: apps/console-host… |
| v5.0.0-13.4.3 | — | L2 | 의도한 경우가 아니면 웹 서버가 디렉터리 목록을 보여 주지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-13.4.4 | — | L2 | 운영 환경에서 HTTP TRACE 메서드를 지원하지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-13.4.5 | — | L2 | 내부 API 문서와 모니터링 엔드포인트는 의도한 경우가 아니면 노출하지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/metrics.test.ts, services/pg-simulator/test/simulator.test.ts 외 2곳 (영역:… |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/v0-monolith/test-int/gate.int.test.ts 외 4곳… |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | ID만 | B | 다른 곳 시험: apps/web/src/features/identity-verify/flow.test.mjs, apps/web/src/features/identity-verify/server/return-post.t… |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts (영역:… |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/telemetry.test.ts, services/payment-svc/test/portone-gateway.test.ts 외 1곳 (영역:… |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | ID만 | B | 다른 곳 시험: loadtest/e2e/v0-rehearsal.e2e.mjs, packages/platform/test-int/held-events.int.test.ts 외 15곳 (영역:… |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/logout.test.mjs (영역: apps/console-host) |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | ID만 | B | 다른 곳 시험: services/identity-svc/test-int/fan-account.int.test.ts, services/identity-svc/test/fan-account-http.test.ts 외… |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/autoassign.test.mjs, apps/web/src/_pages/seats/model/storage.test.mjs (영역:… |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | ID만 | B | 다른 곳 시험: tools/ci/vuln-deadline.test.mjs (영역: apps/console-host, apps/widgets) |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | ID만 | B | 다른 곳 시험: tools/ci/sbom-find.test.mjs, tools/web-checks/static/assets.test.mjs (영역: apps/console-host, apps/widgets) |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/review.test.mjs, apps/partner/src/_pages/seatmap-editor/model/work… |
| v5.0.0-15.2.1 | — | L1 | 문서에 정한 갱신·조치 기한을 넘긴 구성요소가 없다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-15.2.2 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능에 문서대로 가용성 방어를 구현한다. | ID만 | B | 다른 곳 시험: packages/platform/test-int/maintenance.int.test.ts, packages/platform/test/circuit-breaker.test.ts 외 6곳 (영역:… |
| v5.0.0-15.2.3 | — | L2 | 운영 환경에는 필요한 기능만 두고 시험 코드·예제·개발 기능을 노출하지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | ID만 | B | 다른 곳 시험: packages/config/eslint/service-security.test.mjs, services/payment-svc/test-int/payment-new-pause.int.test.ts… |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | ID만 | B | 다른 곳 시험: packages/config/eslint/service-security.test.mjs, packages/platform/test/telemetry.test.ts 외 2곳 (영역:… |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/core-svc/test-int/seatmap-save.int.test.ts 외 3곳 (영역:… |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | ID만 | B | 다른 곳 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts (영역: apps/console-host… |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | ID만 | B | 다른 곳 시험: packages/api-client/test/policy.test.ts, packages/config/eslint/js-security.test.mjs 외 4곳 (영역: function… |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-checks.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 1곳 (영역:… |
| v5.0.0-16.1.1 | — | L2 | 기술 스택의 계층마다 어떤 이벤트를 어떤 형식으로 기록하는지, 로그를 어디에 두고 어디에 쓰는지, 접근을 어떻게 통제하는지, 얼마나 보관하는지를 적은 로그… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-import.int.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/production-image.int.test.ts (영역:… |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | ID만 | B | 다른 곳 시험: loadtest/test/before090.test.mjs, loadtest/test/lib.test.mjs 외 78곳 (영역: apps/console-host, apps/widgets) |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-webhook.test.ts 외… |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.t… |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/production-image.int.test.ts, services/core-svc/test-int/sale-eligibility.int.test.t… |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | ID만 | B | 다른 곳 시험: packages/platform/test/redis.test.ts, packages/platform/test/request-log.test.ts 외 54곳 (영역: apps/console-host… |
| v5.0.0-16.4.1 | — | L2 | 모든 로그 구성요소가 로그 주입을 막도록 데이터를 인코딩한다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/seatmap-import.int.test.ts 외 1곳 (영역:… |
| v5.0.0-16.4.2 | — | L2 | 로그를 권한 없는 접근과 수정에서 보호한다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-16.4.3 | — | L2 | 로그를 분석·탐지·경보용으로 논리적으로 분리된 시스템에 안전하게 보낸다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts (영역: apps/console-host, apps/widgets) |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | ID만 | B | 다른 곳 시험: apps/web/queue-room/test/lobby.test.mjs, packages/platform/test-int/kafka.int.test.ts 외 88곳 (영역:… |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | ID만 | B | 다른 곳 시험: packages/platform/test/circuit-breaker.test.ts, services/core-svc/test-int/production-image.int.test.ts 외 71곳… |
| v5.0.0-2.3.5 | — | L3 | 고가치 업무 흐름에는 여러 사람의 승인을 요구한다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-4.1.5 | — | L3 | 아주 민감하거나 여러 시스템을 거치는 요청·거래에는 전송 보호 위에 메시지마다 디지털 서명을 더한다. | 빈칸 | B | 영역: services/ops-svc |
| v5.0.0-8.4.2 | — | L3 | 관리 화면 접근에는 지속적인 신원 확인, 기기 보안 상태 평가, 맥락 위험 분석 같은 여러 겹의 보안을 두고, 네트워크 위치나 신뢰 단말만으로 인가하지 않는다. | 빈칸 | B | 영역: apps/console-host, apps/widgets |
| v5.0.0-14.2.7 | — | L3 | 민감 정보에 보존 등급을 매기고, 쓸모없어진 데이터를 정한 일정이나 상황에 따라 자동으로 지운다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/payment-svc/test-int/payment-confirm-runner.i… |
