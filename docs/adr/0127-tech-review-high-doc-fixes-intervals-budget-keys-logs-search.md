# ADR-0127: 기술 검토 높음 항목의 문서 수정 묶음 — 관측 간격·28일 버짓·결제사 대기·pid 키·금액 칸·법정 접속기록·날짜별 판매·검색 정규화·MSK IAM·WCAG(2026-10-28)

- **상태**: 채택 (2026-10-28. 기술 검토(review/tech-review.md)의 높음 항목(영역: 다. 안전·정합성 결함, 라. 요구사항과 설계의 충돌, 사실 오류)에 소유자가 "나머지 건수들은 모두 추천안에 동의합니다. 그렇게 모두 수정해주세요."라고 정했다. 방향은 소유자 결정(추천안 승인)이고, 검토가 안을 고르지 않은 곳의 선택과 값 같은 세부는 추천 적용이다. 측정 전 값은 [가정]으로 표시했다) 2026-10-29(문서 불일치 정리, R-165): 높음-26 결정의 'Debezium이 도는 Kafka Connect'는 ADR-0116으로 빠졌다. MSK IAM 대상은 서비스·스트림 작업자·서비스별 Outbox 릴레이(JavaScript 서명 도구)와 Schema Registry·관측 전용 Kafka 수집기·Tempo다.
- **관련**: review/tech-review.md(높음-12·높음-13·높음-16·높음-18·높음-20·높음-21·높음-23·높음-25·높음-26·높음-28), review/consistency-review.md R-145, 00-summary.md §6·질문 61, 같은 날 새 ADR-0100~0126(새 결정이 필요한 항목)

## 맥락

2026-10-27 기술 검토 2판은 설계의 모든 기술·기법을 시니어 개발자 관점에서 따져 높음·중간·낮음 항목으로 냈다. 2026-10-28 소유자가 남은 항목을 모두 추천안대로 고치라고 정했다. 새 결정이 필요한 항목은 따로 ADR(0100~0126)을 썼고, 이 ADR은 정본 문서를 고쳐 반영한 높음 항목 10건의 문제와 결정을 한곳에 모은다. 검토 문서에서는 이 항목들의 본문을 지우고 이 ADR을 가리키는 한 줄만 남겼다(지운 본문은 git 이력에 있다).

## 결정

항목마다 검토의 추천 수정을 따랐다(소유자 승인). 검토가 안을 여럿 내고 고르지 않은 곳은 고른 안과 이유를 적었고 '추천 적용'으로 표시했다. 정본에는 `(추천 적용 2026-10-28, 기술 검토 <번호>)`로 표시했다.

### 다. 안전·정합성 결함

#### 높음-12 지표 긁기·규칙 평가·알림 묶음 간격이 없어, AIMD 제어와 온세일 짧은 창 경보가 성립하는지 판단할 수 없다
- **문제**: ① AIMD는 증액의 크기·간격과 비율 하한이 없다. 200ms마다 늘리면 Prometheus 표본이 바뀌기 전에 수십 번 늘어 되먹임보다 앞서 넘친다. ② 제어 입력과 SLI 지표의 긁기 간격이 문서 어디에도 없다. Prometheus 기본값(1분)이면 '30초보다 낡은 표본 = 입력 없음' 규칙이 평소에도 켜지고, 1분 창 p99 때문에 감축 확인 시간이 끝난 뒤 감축 전 표본으로 한 번 더 줄인다. ③ 온세일 경보의 짧은 창은 10초(SEV1)·25초(SEV2)인데, 흔한 긁기 간격(15·30초)이면 10초 범위에 표본이 둘 이상 없어 `rate()`가 비고, 'A와 B 동시 충족'인 SEV1과 자동 50% 감축이 조용히 울리지 않는다. 경보 단위 시험은 입력 간격을 짧게 주면 통과해 이 문제를 잡지 못한다. ④ K8 '탐지 60초'는 Alertmanager `group_wait`(기본 30초)와 평가 간격을 빼고 계산했다(소진 20배 장애가 2분 창 10배를 넘는 때가 정확히 60초다).
- **근거**: docs/features/queue-admission.md §5, docs/observability.md §3·§4·§5·§8, docs/perf-ledger.md §8, Prometheus 설정 문서(`scrape_interval` 기본 1m)·함수 문서(`rate()`). 문서 전체에서 긁기·평가 간격·`group_wait`를 찾지 못했다.
- **결정**: 제어 입력·온세일 SLI 긁기 작업을 따로 두어 5초, 그 밖은 15초로 하고, 온세일·K8 대상 경보와 그 기록 규칙은 한 묶음으로 5초마다, 그 밖은 30초마다 평가하며, Alertmanager SEV1·SEV2 경로는 `group_wait` 5초·`group_interval` 1분으로 둔다(방향은 소유자 승인 '추천안 동의', 값은 추천 적용 [가정, Phase 2·4에서 확정]). '짧은 창 ≥ 긁기 간격 × 4'에 따라 SEV1 짧은 창을 10초에서 20초로 바꾼다(경보가 울리는 때는 긴 창이 정해 경보 시점 예산 소모 29%는 그대로). AIMD는 30초 창을 읽고 새 창마다 한 번 초기 목표의 2%씩 늘리며, 감축 확인 시간은 '인원이 새 목표 아래 + 감축 뒤 35초, 또는 2분'이다. 입력 없음 30초 ≥ 긁기 × 3과 시험 간격 = 운영 간격은 설정 검사(V-T20)가 본다. K8 탐지 시간은 '120초 × 10 ÷ k + 약 15초'로 적고, 60초 안은 소진 약 27배 이상이다(추천 적용).
- **바꾼 문서**: docs/observability.md §3·§4·§5·§8·§12·§13·§14, docs/features/queue-admission.md §5·§11·§12, docs/verification.md §2.7·§9, docs/perf-ledger.md §5·§8, docs/architecture.md §5, docs/features/control-tower.md §6·§15, planning/03 POL-010·§4, planning/01 §5.2, guide/03·10, ADR-0049·0069 상태 줄.
- **남는 한계**: planning/01 §5.2 '경보 탐지 시간과 장애 크기의 남는 한계' — 소진 27배 미만 장애는 60초 안에 못 잡고(20배 약 75초), 저유량 때 더 늦을 수 있으며, 짧은 창 20초로 경보가 멈추는 것도 몇 초 늦다. K8은 주입 세기를 함께 적어 판정한다.

#### 높음-13 28일 에러 버짓을 보존 15일인 클러스터 Prometheus에서 계산하게 적혀 있다
- **문제**: 지표 출처 표는 '에러 버짓'의 출처를 클러스터 안 Prometheus로 두고, 그 Prometheus는 15일만 보존한다. 그런데 일상 SLO는 28일 롤링 창이고, 28일 예산 소진이 배포 파이프라인을 자동으로 잠그고 푼다. Prometheus는 범위 안에 데이터가 일부만 있어도 오류 없이 있는 만큼으로 계산하므로, 28일 예산이 소리 없이 15일 값이 된다.
- **근거**: docs/observability.md §8 지표 출처 표(294줄)·§9(304줄 '15일 보존')·§4(28일 롤링), docs/architecture.md §5 '28일 예산 소진 배포 잠금'. 이 검토에서 직접 확인했다.
- **결정**: 지표 출처 표를 나눈다. 온세일 70분 예산과 28일 예산의 1시간·6시간·3일 번 레이트는 클러스터 Prometheus, 28일 남은 예산·28일 SLO 보고·배포 잠금 판정·사고별 28일 예산 사용은 Mimir `raw`(90일)에서 Mimir 규칙 평가기가 5분마다 5분 증가량의 28일 합계의 비로 계산한 값 하나(`slo:error_budget_remaining:ratio28d`)다(방향은 소유자 승인 '추천안 동의', 세부는 추천 적용). 그 값을 읽지 못하거나 15분 [가정]보다 낡으면 배포 잠금은 지금 상태를 유지한다. 배포 잠금은 빠른 제어 루프가 아니라 ADR-0068 결정 2와 어긋나지 않는다. 로컬 보존 35일 안은 쓰지 않는다.
- **바꾼 문서**: docs/observability.md §4·§8·§9·§14, docs/architecture.md §5, docs/devops.md §5.3, docs/infra.md §7, docs/features/control-tower.md C-T44 ④, guide/10, ADR-0068·0071·0078 상태 줄.

#### 높음-16 결제사 승인 호출을 2초에 끊어, 두 결제사의 권장(읽기 시간 초과 60초)과 어긋나고 결과 모름·재시도·한도 초과를 스스로 만든다
- **문제**: 승인 호출을 2초에 끊어도 결제사는 빨라지지 않고, 끊긴 요청은 결제사 안에서 계속 처리된다. 같은 멱등키로 다시 보내 '처리 중(409)'을 받고, 기다렸다 또 보내고, 풀리지 않으면 결과 모름(UNKNOWN) 조회로 간다. 결제사가 몰리는 오픈 직후일수록 이런 호출이 늘어 추정 한도(토스 300·포트원 50 TPS)를 재시도가 깎아 먹고, 429 한 번에 '그 회차 동안 상한 낮추기'와 입장 상한이 함께 내려가 판매가 스스로 느려진다. 토스페이먼츠와 포트원 모두 결제 API의 읽기 시간 초과를 60초로 권한다. ADR-0070은 '2초 그대로'라고만 했고 결제사 권장은 보지 않았다.
- **근거**: docs/features/payment.md §2·§9, docs/architecture.md §7 NFR-006, 토스페이먼츠 개발자센터 용어집 '타임아웃'(결제 API의 읽기 시간 초과를 60초로 권한다, docs.tosspayments.com/resources/glossary/timeout.md), 포트원 V2 문서(읽기 시간 초과를 60초 이상으로 권한다).
- **결정**: payment-svc의 결제사 HTTP 읽기 시간 초과를 두 결제사 권장값 60초 [가정, 계약 때 확인](토스페이먼츠 용어집 '타임아웃'·포트원 V2 '요청 타임아웃 정책', 2026-10-28 원문 확인)로, 연결 시간 초과를 3초 [가정]로 둔다(소유자 승인). 자원은 채널별 동시 승인 호출 상한(채널 추정 상한 × 2초 [가정], 토스 600·포트원 100)과 서킷 브레이커가 지키고, 상한이 차면 승인 기한 안에서 재시도 큐가 받는다(추천 적용). 2초는 끊는 값이 아니라 '임박' SEV2와 NFR-006 측정의 기준이다(소유자 승인). purchase-svc·core-svc shop → payment-svc `ConfirmPayment`는 명령 접수만 기다리고(데드라인 200ms [가정]) 결과는 `trade.payments`로 받는다(소유자 승인, 값은 추천 적용). 429에 따른 채널 상한 낮추기와 한도 사용률은 첫 승인 호출 기준으로 판단하고, 다시 보낸 호출의 429는 그 호출만 늦춘다(소유자 승인). 시험 P-T40, 확인할 값은 open-items 44.
- **바꾼 문서**: docs/features/payment.md §2·§2.1·§4·§4.2·§9·§11·§12, docs/architecture.md §5·§7, docs/observability.md, docs/api/guidelines.md §5·§8, docs/api/proto(README, payment.proto), docs/infra.md RB-07, docs/verification.md, docs/features/control-tower.md, docs/security/asvs/payment.md, planning/03 POL-013·022·§4, planning/04 F-03·SCR-029, design/d5, guide/05·10, planning/01 §5.2, review/open-items 44, ADR-0070·0069·0015 상태 줄
- **남는 한계**: planning/01 §5.2 '결제사 승인 읽기 시간 초과 60초의 남는 한계'(결제사가 오래 느리면 벌크헤드가 차 확정이 3초 예산을 넘음, 결과 전달이 Outbox·Kafka를 한 번 더 거침, 실제 값은 계약 때 확인)

#### 높음-18 pid 키 정기 교체가 판매 종료까지 사는 1인 1순번 확인 키와 부딪쳐, 교체하는 순간 1인 1순번이 깨진다
- **문제**: pid(사람 식별 해시) 키는 '2년마다 온세일 윈도우 밖에서' 바꾸고 다음 토큰부터 새 값을 싣는다(ADR-0050). 그런데 하루 뒤 정한 ADR-0063 결정 11은 `q:dup`·`q:adm` 키가 온세일 윈도우가 아니라 판매 종료까지 산다고 했다. 판매 기간이 몇 주인 회차는 늘 있으므로 어느 때 바꿔도, 이미 줄을 선 사람의 토큰이 15분 안에 새 pid로 바뀌면 `q:dup:{새 pid}:E`가 비어 두 번째 순번을 받고, 입장 확정 때 `q:adm:{새 pid}:E`도 비어 재확인이 통과한다. 판매 중인 모든 회차에서 1인 1순번(POL-002)이 깨진다(계정당 매수 한도는 account_id 기준이라 좌석 수는 막힌다). 연계정보 HMAC 키는 바로 이런 이유로 정기 교체를 하지 않는데 pid 키만 정기 교체해 두 판단이 어긋난다.
- **근거**: docs/security/secrets-and-keys.md pid 행, docs/data.md §3 `q:dup` 행(ADR-0063 결정 11), 같은 문서 CI 행 '정기 교체는 없다'.
- **결정**: pid 키는 정기 교체를 없애고 노출이 의심될 때만 바꾼다(소유자 승인). 바꿀 때는 전환 기간(교체 시작 때 로비·대기열이 열린 회차의 가장 늦은 판매 종료 + 1일, 길어야 가장 긴 판매 기간 + 1일) 동안 토큰에 옛·새 pid를 싣고, 진입·입장 확정은 두 pid의 `q:dup`·`q:adm`에 같은 Lua를 옛 pid부터 차례로 부른다(추천 적용). 넘기는 사람 식별값과 분석 가명은 옛 pid, 주문 때 본인확인 재확인은 `previous_pid`도 받고, pid는 첫 본인확인 때만 계산한다(추천 적용). 연계정보 HMAC 키와 같은 판단이며, 판매가 판매 종료까지 이어진다는 ADR-0063 결정 11과 맞춘다.
- **바꾼 문서**: secrets-and-keys.md 관리 규칙 6·연계정보 행·pid 행, identity.md §3·§5·§8·I-T49, queue-admission.md §3·§6·Q-T45, data.md `identity_verification`·§3, analytics.md §3.3, identity.proto, planning/03 POL-028, guide/08·09, ADR-0050 상태 줄
- **남는 한계**: planning/01 §5.2에는 더하지 않았다(노출 의심 때만 생기는 드문 일). identity §5에 '전환 기간 사람 키 호출 두 배, 전환이 끝나는 때 그 끝을 넘는 회차의 분석 가명이 둘로 나뉨', analytics §3.3에 같은 가명 한계, identity §8에 '연계정보 키 새 버전 뒤 탈퇴·재가입은 pid가 달라짐'을 적었다. identity §8의 [보완] 마커 1개가 없어졌다(해결됨).

#### 높음-20 승인 업무의 금액 칸이 int라 큰 지급 묶음을 담지 못한다
- **문제**: 정산 표(`settlement_statement`·`payout_batch`·`payout`·`partner_receivable`)는 금액을 bigint로 두었지만, 지급 묶음 승인을 담는 `approval_request.amount`는 int(약 21억 4,748만 원까지)다. 큰 공연 하나의 정산서만으로도 넘는다(시험 J-T4가 25억 원 정산서를 예로 든다). 지급 묶음 확인 요청이 DB 범위 오류로 실패하거나, 앱이 32비트로 받으면 잘린 금액이 승인 화면에 보일 수 있다.
- **근거**: docs/data.md `approval_request`('int amount', 이 검토에서 직접 확인)·`payout_batch`('bigint'), docs/features/settlement.md §13 J-T4.
- **결정**: `approval_request.amount`를 bigint로 바꾸고, 금액 칸 자료형 규칙(한 건 결제 금액은 int, 모은 금액과 승인 업무 금액은 bigint, openapi `format: int64`, 앱은 Drizzle `mode: 'number'`)을 data.md 설계 규칙에 둔다(추천 적용). J-T3에 21억 4,748만 원을 넘는 25억 원 묶음 승인 사례를 더한다(추천 적용).
- **바꾼 문서**: docs/data.md(ER·설계 규칙), docs/api/openapi.yaml(ApprovalRequest·SettlementStatement·PayoutBatch·Receivable·조정·잔액 입력), docs/features/settlement.md §13 J-T3

#### 높음-21 법정 접속기록의 수집 갈래에 유실 방지·건수 대조가 없고, 되살릴 수 있는 기간이 7일뿐이다
- **문제**: 법정 접속기록(로그인·진입·주문·결제의 일시·원문 IP·단말, 통신비밀보호법 3개월 보존)은 노드 에이전트 수집기가 Envoy 접근 로그와 컨테이너 표준 출력을 읽어 ClickHouse 내보내기(로그는 베타)로 전용 DB에 쓴다. 그런데 읽은 위치 저장(filelog `storage`), 디스크 기반 보내기 큐, 재시도를 그만두지 않는 설정, 유실 지표 경보, 원천 건수와의 대조가 모두 없다. OTel 수집기의 보내기 큐는 기본이 메모리이고 넣지 못하면 대개 버리며, 재시도는 기본 300초 뒤 그만둔다. kubelet은 컨테이너 로그를 기본 10Mi × 5개로 돌려 지우고, 노드가 회수되면 파일도 사라진다. 대기열 진입이 법정 사본에 들어가므로 초당 20만 건이 몰리는 T=0에 위험이 가장 크다. 게다가 ClickHouse 백업은 원시 IP 때문에 7일만 두어, 8일째 이후 발견한 삭제·손상(잘못된 TTL, 실수한 DROP)은 되살릴 수 없다. 일 해시 앵커는 변조를 드러낼 뿐 유실·복구를 막지 못한다.
- **근거**: ADR-0076 결정 7, ADR-0089 결정 7, ADR-0053('접속기록 DB를 백업에서 빼지 않는다'), docs/observability.md §7(272줄), docs/infra.md §6, OTel exporterhelper README·filelog README·쿠버네티스 로깅 문서(2026-10-27 확인).
- **결정**: 법정 사본 갈래만 '잃지 않는 갈래'로 정한다(소유자 승인 '추천안 동의'). 세부는 추천 적용이다: 읽은 위치 저장(filelog `storage`, `start_at: beginning`), 디스크 큐(`sending_queue.storage`, `block_on_overflow`)와 끝없는 재시도(`max_elapsed_time: 0`), 게이트웨이·identity 노드 풀의 kubelet 회전 100Mi × 10 [가정]과 노드 비울 때 큐 비우기, 5분 칸 대조(게이트웨이 요청 수 대비 0.1% [가정])와 identity 줄 `seq` 빈 번호 확인, 유실·큐 50%·보내기 실패 5분·하루 사본 지연 SEV2(`kind` legal, RB-38), 매일 하루 파티션 Parquet 사본을 S3 Object Lock 준수 모드 버킷에 3개월 + 7일 [가정](일 해시 앵커 대상), 지우기 권한은 마이그레이션 역할만·TTL CI 검사. 검토의 '게이트웨이 전용 파일'은 hostPath 금지 때문에 바꿀 조건으로만 두고, CloudFront·NLB 표준 로그(best-effort)와 Kafka·Data Firehose 경로는 비교해 지금은 쓰지 않는다. 시험은 V-T21~V-T23.
- **바꾼 문서**: docs/observability.md §1·§2·§5·§7·§9, docs/infra.md §6·§9·§10(RB-38), docs/infra-handover.md §3.2·§5.2·§6.1, docs/data.md §1·§6, docs/security/data-classification.md, docs/security/asvs/delivery.md(16.4.2·16.4.3), docs/features/identity.md(I-T17), docs/verification.md(V-T21~V-T23), docs/devops.md §7.5, planning/01 §5.2, planning/03(POL-022·POL-025·§4), guide/10, ADR-0053·0073·0076·0089 상태 줄
- **남는 한계**: planning/01 §5.2 '법정 접속기록 수집의 남는 한계'(노드 갑작 장애 때 그 노드 디스크 큐·미읽음 파일의 줄은 잃는다, 게이트웨이 줄 0.1% 아래 유실은 칸 대조로 놓칠 수 있다, 그날 안에 지운 줄은 되살리지 못한다)

#### 높음-23 판매 기간이 긴 회차는 R2 동결 뒤 판매가 확정 숫자에 쌓이지 않아 '정산서와 0원 차이'(NFR-026)가 늘 실패한다
- **문제**: 판매 금액은 R1(다음 영업일)에 확정되고, 원시(브론즈·실버)는 적재 뒤 90일에 지워지므로 온세일 사실(F1~F7, 판매 포함)은 R2(오픈 + 7일)에 동결된다. 날짜별로 쌓는 사실은 환불·양도·CS·비용뿐이다. 매진되지 않은 회차가 R2 뒤에도 몇 주~몇 달 팔면, 그 판매를 R3 골드에 넣는 길이 없다. 오픈에서 R3까지가 약 97일을 넘으면 실버에도 앞부분이 없어 다시 계산할 수도 없다. 그 결과 R3의 '판매 대금 = 정산서(0원 차이)'가 매진되지 않은 회차마다 거짓으로 실패하고, 지표 7 '비매진 회차 판매율(공연 전날)'도 바르게 낼 수 없다. 관제 실시간 표의 누적 키도 판매 기간이 90일을 넘으면 0부터 다시 셀 수 있다(중간-090).
- **근거**: docs/features/analytics.md §4.3·§6.3 지표 7·§7, planning/02 NFR-026.
- **결정**: ADR-0052 결정 3의 사실 표에 날짜별 판매 사실 F15 `fct_sales_daily`(날짜 × 회차 × 등급 × 결제사: 판매 좌석·주문·판매 금액·되돌림·반환 좌석)를 더해 15개로 한다(소유자 승인). 마감 실행기가 장르별 랭킹 일 집계와 같은 매일 실행에서 전날 판매분을 넣는다(추천 적용). R3의 판매 대금(지표 26)과 공연 전날 판매율(지표 7)은 온세일 사실 F2가 아니라 F15의 합으로 구하고, F2는 R2 동결 그대로 온세일 분석에만 쓴다(소유자 승인). 실시간 표 쪽 문제는 ADR-0099의 원시 표 보존 400일로 이미 풀렸다. 시험 A-T18.
- **바꾼 문서**: docs/features/analytics.md §4.3·§4.4·§5.1·§5.2·§6.3·§7·§8.5·§13·§14, docs/streaming.md §4.6, docs/features/README.md, guide/15, ADR-0052 상태 줄
- **남는 한계**: docs/features/analytics.md §14 'R2 뒤의 판매는 날짜 단위로만 남는다'(구역·시간대로 못 나눔, 당일 판매는 하루 늦게 확정). planning/01 §5.2에는 더하지 않음


### 라. 요구사항과 설계의 충돌, 사실 오류

#### 높음-25 검색 정규화 첫 단계(NFKC)가 초성·낱자 비교를 깨뜨려, 문서대로 만들면 초성 검색이 동작하지 않는다
- **문제**: NFKC는 입력기가 만드는 호환 자모(ㄱ U+3131, ㅏ U+314F 등)를 첫소리·가운뎃소리용 자모(U+1100대)로 바꾼다. 문서는 낱자·초성 칸을 '호환 자모'로 만들고(es-hangul) 입력도 정규화한 값에서 비교 값을 만든다. 그래서 초성 검색 'ㄹㅁ'은 U+1105·U+1106이 되어 es-hangul `canBeChoseong`(호환 자모 목록만 본다)이 초성으로 보지 않고, 낱자만 친 입력('ㄹ', 'ㄳ')은 저장된 낱자 키와 앞부분이 맞지 않는다. 문서는 같은 함정을 NFD에서는 짚었지만 NFKC에서는 놓쳤다. 브라우저와 서버가 같은 함수를 써서 공유 시험(SR-T1)은 통과하고 초성 시험(SR-T3)만 실패한다.
- **근거**: docs/features/search.md §3.1·§12, ADR-0094 결정 6. 직접 계산: Python `unicodedata.normalize('NFKC','ㄹㅁ')` → U+1105·U+1106, Node.js v24.18.0도 같다. es-hangul 소스(`disassembleToGroups.ts`, `canBeChoseong.ts`).
- **결정**: ADR-0094 결정 6의 정규화 1단계를 'NFKC 뒤 첫소리·가운뎃소리·끝소리 자모(U+1100~U+11FF)를 호환 자모로 되돌리기(고정 표)'로 바로잡는다(추천 적용, 검토의 두 안 가운데 NFKC를 유지하는 안). 보이지 않는 한글 채움 문자를 지우고, '초성만'은 정규화한 입력을 낱자로 푼 값으로 판정한다(추천 적용). 정규화는 두 번 해도 같다(추천 적용). 검색 방향(결정 1~4, 소유자 결정)은 그대로다. 같은 내용 차단 지문(NFKC)은 바꾸지 않는다.
- **바꾼 문서**: docs/features/search.md §3.1·§3.2·§12·§15, docs/data.md §2, docs/api/openapi.yaml, docs/security/asvs/catalog-review.md 1.1.1, ADR-0094 상태 줄

#### 높음-26 Flink 잡의 MSK IAM 설정이 EKS Pod Identity에서 자격 갱신(재인증) 때 실패한다
- **문제**: docs/streaming.md §2.6의 JAAS 설정은 `IAMLoginModule required;`(기본 자격 사슬)뿐이고, §2.3은 AWS 권한을 EKS Pod Identity 역할로 준다. aws-msk-iam-auth README는 Pod Identity처럼 STS 세션 이름이 바뀌는 자격으로는 재인증 때 주체가 바뀌었다며 연결이 끊긴다고 적고 우회 설정을 안내한다. 문서는 이를 '확인 필요(wbs 4.3.1 PoC)'로 남겼는데, 원문으로 확인된 운영 장애다.
- **근거**: docs/streaming.md §2.3·§2.6·§15, aws-msk-iam-auth README 문제 해결 절(EKS Pod Identity처럼 세션 이름이 바뀌면 재인증이 실패한다고 적고 `awsRoleArn`·`awsRoleSessionName`을 안내한다), v2.3.9 릴리스 노트 `awsAddDefaultProviders`(2026-10-27 확인).
- **결정**: MSK에 IAM으로 붙는 모든 클라이언트(서비스·스트림 작업자의 JavaScript 서명 도구, Debezium이 도는 Kafka Connect와 직접 띄운 Schema Registry의 자바 aws-msk-iam-auth, 관측 전용 Kafka의 수집기·Tempo)는 Pod Identity 역할로 워크로드별 MSK 전용 역할을 고정 세션 이름 `<워크로드>-<환경>`으로 맡는다. 토픽·그룹 권한은 MSK 전용 역할에만 두고 Pod Identity 역할에는 주지 않는다. 역할을 못 맡으면 기본 자격으로 넘어가지 않고 실패한다(JS는 `generateAuthTokenFromRole`, 자바는 `awsAddDefaultProviders="false"`). 정적 검사 D-T30, 재인증 확인 ST-T14(실제 MSK 확인은 확인 필요, open-items 42), 그래도 끊기면 그 워크로드만 IRSA. 모두 추천 적용(ADR-0072 결정 4·6을 ADR-0053 결정 9·ADR-0099에 적용).
- **바꾼 문서**: docs/devops.md §9.4·§14, docs/streaming.md §2.1·§2.3·§2.6·§10·§15·§17, docs/data.md §4, docs/observability.md §1, docs/infra.md 보안 표, docs/security/secrets-and-keys.md, docs/security/asvs/analytics.md 13.2.1, docs/architecture.md §9.4, docs/infra-handover.md §3.2, planning/01 §5.2, review/open-items.md 42, ADR-0053·ADR-0099 상태 줄
- **남는 한계**: planning/01 §5.2 'MSK IAM 재인증의 남는 한계 [보완]'(JS·Go에서 실제로 이어지는지는 실제 MSK·EKS에서만 확인, Go 도구는 역할 설정 없음)

#### 높음-28 WCAG 2.2 AA 목표(NFR-020)인데 점검 기준에 1.4.10(320px 재배치)·1.4.4·1.4.12·2.1.4·3.2.6·3.3.7이 빠졌다
- **문제**: 최소 기준선과 가로 스크롤 점검이 360px부터라, 1.4.10(320 CSS px에서 두 방향 스크롤 없이 사용, 데스크톱 400% 확대와 같은 폭)이 어디에도 없다. ADR-0061의 시험 기준 '확대 200% 때 가로 스크롤 없음'은 1.4.4(글자 200%)와 1.4.10을 섞었다. 글자 200% 확대(1.4.4)와 글자 간격 조정(1.4.12)이 없어 고정 높이 타일·배지·하단 고정 바가 글자를 자를 위험이 점검되지 않는다. 관제 콘솔의 한 글자 단축키·Space 재생에는 2.1.4(끄기·바꾸기·초점이 있을 때만) 조건이 없다. WCAG 2.2 새 기준 가운데 3.2.6(도움말 위치 일관)·3.3.7(같은 과정에서 다시 입력하지 않게)은 어느 문서에도 없다.
- **근거**: design/d1 §4·§5, design/d4 #17, design/d5 §0.3, docs/frontend.md §5.11·§5.13, ADR-0061 결정 7, design/d3 §0·SCR-031, WCAG 2.2 원문(w3c/wcag 저장소 reflow·character-key-shortcuts·redundant-entry·consistent-help).
- **결정**: 중단점 토큰은 그대로 두고 점검 기준을 고친다(추천 적용 2026-10-28). 재배치는 1280 폭 400% 확대(320 CSS px)에서 두 방향 스크롤 없음(표·좌석맵·좌석맵 에디터·그래프 예외), 글자 확대는 200%에서 잃는 것 없음(화면 전체 확대로 잼. SEED가 글자 크기 설정을 1.5배에서 멈춰 '글자만 키우기'는 open-items 43번), 글자 간격(줄 1.5·문단 2·자간 0.12·단어 0.16)에서 잘림 없음, 한 글자 단축키는 처음 꺼짐·`/me` 스위치로 켬·입력 칸 초점이면 동작 안 함, 리플레이 Space는 플레이어 초점일 때만, 고객센터 링크는 셸만 그려 같은 순서, 같은 과정에서 다시 입력하지 않게 함. d4 §1에 2.4.11·3.2.6·3.3.7·3.3.8 줄과 '자동 검사' 열을 두고, axe는 `wcag22aa`를 켜며, Playwright 시험 FE-T31을 더한다. ADR-0061 결정 7의 '확대 200% 때 가로 스크롤 없음'은 1.4.10과 1.4.4로 나눠 읽는다(상태 줄).
- **바꾼 문서**: planning/02 NFR-020, design/d1 §4·§5, design/d2 §1·§3.1, design/d3 §0·SCR-031, design/d4 §1·§3, design/d5 §0.3·§3.3·§7.1, docs/frontend.md §3.12·§5.11·§5.13·§5.17·§6.4, docs/quality/quality-requirements.md QR-IC-1, planning/01 §5.2, review/open-items.md 43, ADR-0061·ADR-0079 상태 줄
- **남는 한계**: planning/01 §5.2 새 행(높음-27과 한 행): 글자 확대는 화면 전체 확대로 재고 '글자만 키우기'는 SEED 상한으로 1.5배까지, 표·좌석맵·에디터·그래프는 320 폭에서도 두 방향 스크롤.


## 결과와 트레이드오프

- 검토가 짚은 높음 항목 10건이 정본에 반영됐다. 값은 정본 문서에 있고, 이 ADR은 문제와 결정을 기록한다.
- 새 시험·런북·Game Day·나중에 정할 것(open-items) 번호는 항목의 결정과 정본에 있다. 작업 계획 변화는 wbs/wbs.md의 추가 이력 표에 있다.
- 측정 전 값은 [가정]으로 두었고, 확인하지 못한 외부 사실은 '확인 필요'로 남겼다.

## 되돌릴 조건

- 항목의 결정이 실측(성능 장부, 시험)이나 원문 확인과 어긋나면 그 항목만 새 ADR로 다시 정한다.

## 남는 한계

- 항목별 남는 한계는 위 각 절과 planning/01 §5.2에 있다.
