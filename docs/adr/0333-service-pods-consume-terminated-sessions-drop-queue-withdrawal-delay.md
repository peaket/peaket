# ADR-0333: 신원을 받는 업무 서비스 일곱은 시작 때 플랫폼 도우미 하나로 종료 세션 목록을 채우고, 대기열은 탈퇴 15분 미루기를 뺀다(2026-11-21)

- **상태**: 채택(추천 적용, 2026-11-21, BUILD_ORDER BAT-059 계획 `bat059-plan-e47a4ddc`). HOT-401 줄(BOT-044와 HOT-010이 넘긴 것)을 구현하기 전에 정한 세부다(docs/architecture.md §8.6 4의 2). [ADR-0103](0103-control-as-state-startup-sync-broadcast-topics-compacted-settings.md) 결정 2·3(시작 작업과 방송형 소비)을 서비스에 잇고, [ADR-0214](0214-queue-sale-state-consumers-redis-held.md) 결정 7을 그 끝 줄('종료 세션 목록이 생기면 뺀다')대로 닫는다.
- **관련**: [ADR-0011](0011-token-lifecycle-and-login-responsibilities.md)(토큰 수명과 종료 목록), [ADR-0143](0143-settings-commands-pg-switch-over-grpc-applied-version-outbox.md) 결정 3(identity Outbox로 내는 세션 종료 사건), [ADR-0296](0296-realtime-gw-first-build-own-token-check-section-count-from-layout-file.md)(realtime-gw는 입장 토큰만 확인), [docs/features/identity.md](../features/identity.md) §3 '세션 즉시 무효화 전파'·§12 I-T3·I-T48, [docs/features/queue-admission.md](../features/queue-admission.md) §3 '탈퇴 계정의 사람 키'·§4 '탈퇴 사건 미루기', [docs/security/asvs/auth.md](../security/asvs/auth.md) 7.4.1, [docs/observability.md](../observability.md) §5
- **관련 ID**: I-T3, I-T48, I-T27, HOT-401, FR-017, ASVS v5.0.0-7.4.1

## 맥락

- 액세스 토큰(로그인한 사람이 요청마다 내는 15분짜리 서명된 표)은 게이트웨이가 서명만 보고 통과시킨다. 세션을 끝내도 토큰은 수명까지 살아 있으므로, 서비스 파드(쿠버네티스에서 앱이 도는 가장 작은 단위)마다 메모리에 '끝난 세션 목록'을 두고 그 세션 ID(`sid`)의 요청을 401로 막는다(docs/features/identity.md §3).
- 막는 쪽은 이미 있다. `packages/platform`의 공용 인증 가드가 목록에 든 세션을 401로 거절하고, `startControlSync`가 `control.sessions-terminated`를 '지금 − 15분'부터 읽어 목록을 채우며 다 읽어야 준비 상태(트래픽을 받아도 된다는 표시)가 된다. identity-svc는 로그아웃·원격 로그아웃·탈퇴 등에서 그 사건을 Outbox(보낼 사건을 DB 표에 먼저 적는 방식)로 낸다(BOT-044, PRF-030).
- 그런데 `startControlSync`를 부르는 서비스가 하나도 없다. 그래서 끝난 세션의 토큰이 identity 자신의 경로 밖에서는 최대 15분 통한다(FR-017 '몇 초 이내에 거부'를 지키지 못한다).
- 값의 모양도 어긋난다. identity는 asyncapi대로 JSON에 종료 시각을 ISO 시각 글로 싣는데, 플랫폼 형은 밀리초 수를 기대한다. 운영용 해독기가 없고 시험용 JSON 해독기만 있으며, 종료 시각을 읽지 못하면 그 레코드를 건너뛴다(그 세션은 막히지 않는 쪽으로 실패한다).
- queue-svc는 이 목록이 없어서 탈퇴 사건을 `withdrawnAt` + 15분까지 미뤘다. 만료를 당긴 뒤 탈퇴 전 토큰의 요청이 사람 키의 만료를 판매 종료로 다시 늘리지 못하게 하려는 것이다(ADR-0214 결정 7). 미루기는 처리할 때 집합(`q:{wdr}:…`)·반복·지표 셋을 쓰고, 대기열 Redis 장애 전환으로 그 집합을 잃으면 사건을 다시 받지 못하는 위험을 안는다.

## 결정

1. **받는 서비스**: 게이트웨이의 신원 머리(`X-Session-Id`)를 받는 처리기가 있는 업무 서비스 일곱, 곧 core-svc·identity-svc·ops-svc·payment-svc·purchase-svc·queue-svc·ticket-svc가 켠다. realtime-gw는 입장 토큰만 받고 `sid`가 없어(ADR-0296), admission-ctrl은 신원 처리기가 없어, trust-svc는 공개 처리기(미끼 경로)만 있어 켜지 않는다. 이 셋이 나중에 신원 처리기를 더하면 결정 3이 시작을 막아 함께 켜게 한다. v0-monolith·bundle은 운영에 배포하지 않는다(bundle은 브로커 주소를 지운다).
2. **플랫폼 도우미 하나**: 서비스마다 조립하지 않고 `@peaket/platform/stream-worker`의 도우미 하나(`startServiceControlSync`)를 시작 파일이 듣기(listen) 전에 부른다. 도우미는 `PEAKET_KAFKA_BROKERS`를 다른 소비자와 같은 규칙으로 읽고(없거나 빈칸뿐이면 local·ci만 경고 한 줄로 끄고 그 밖의 환경은 시작 실패, 틀린 조각은 몇 번째인지만 알린다), 운영 인증은 `kafkaAuthFromEnv`, 파드 이름은 `PEAKET_POD` → `HOSTNAME` → 호스트 이름(64자까지)이다. 방송형 읽기의 소비자 그룹은 지금 규칙(`<서비스>-<파드>.<토픽>`, 커밋하지 않음)이다. 끄기는 서비스를 닫은 뒤(처리 중인 요청이 끝난 뒤)이며 읽기 연결도 닫는다. 제어 상태(`controlState`, purchase-svc `sale_control` 등)는 이 결정에 넣지 않는다.
3. **빠뜨림 막기**: local·ci 밖에서 신원 역할(공개·내부 말고)이 붙은 처리기가 있는 서비스가 이 도우미 없이 듣기 시작하면 시작하지 않는다(설정 오류). 새 서비스가 소비를 잊고 배포되면 끝난 세션의 토큰이 조용히 통하기 때문이다.
4. **값 해독(BAS-030의 Avro 전까지 JSON)**: 운영 해독기를 플랫폼에 둔다.
   - 종료 사건은 `sessionId`(비지 않은 글)만 꼭 요구한다. `reason`·`accountId`는 보지 않는다. 이유 값이 새로 더해져도 거절이 빠지지 않게 하려는 것이다(계약 검사로 모르는 이유를 버리면 열린 쪽으로 실패한다).
   - `terminatedAt`은 ISO 시각 글(asyncapi)과 밀리초 수(Avro `timestamp-millis`)를 받는다. 읽지 못하면 받은 때를 종료 시각으로 둔다(닫힌 쪽 실패). 목록에 두는 시간은 지금 규칙(종료 시각 + 15분, 되감아 읽은 옛 사건은 남은 시간만)이다.
   - 설정 사건(`control.settings`)은 계약(asyncapi `SettingChanged`)대로 읽고 시각 칸을 밀리초로 바꾼다.
   - 읽지 못한 레코드는 지금처럼 건너뛰되 `control_sync_skipped_total{service,topic}`으로 센다. 1건 이상이면 SEV3(`kind` control)다. 보안 통제가 레코드 하나만큼 빠졌다는 뜻이다(ASVS v5.0.0-16.3.4).
5. **대기열 탈퇴 15분 미루기를 뺀다**: `AccountWithdrawnHandler`는 사건을 받자마자 진행 중인 회차의 두 키(`q:dup`·`q:adm`) 만료를 당긴다. 처리할 때 집합 `q:{wdr}:…`, `WithdrawnDueWorker`, 미루기·시계 허용 차이 상수, 지표 셋(`queue_withdrawn_due_lag_seconds`·`queue_withdrawn_due_failures_total`·`queue_withdrawn_due_expired_total`)과 그 경보를 없앤다. 지우는 기한을 지금 + 5일로 자르는 일과 `purgeBy`가 탈퇴 ~ 탈퇴 + 5일 밖이면 보류하는 일은 그대로다. 대기열 Redis 장애 전환으로 만료 당기기 쓰기를 잃으면 RB-05 뒤 이 토픽의 그룹 위치를 장애 전환 시각 − 20분 [가정]으로 되돌려 다시 읽는 길(ADR-0214 결정 7)은 그대로 쓴다(다시 해도 결과가 같다).
6. **이전 판이 남긴 처리할 때 집합**: 아직 운영 쪽 배포가 없어(구간 5, ADR-0332) 남은 항목을 옮기는 코드를 두지 않는다. 남은 키의 값(pid)은 수명(`purgeBy`)에 사라진다. 배포된 환경에서 같은 판 바꾸기를 하게 되면, 배포 시각 − 20분 [가정]으로 위 5의 그룹 위치 되돌리기를 한 번 한다.
7. **시험**: I-T3의 판정 기준을 ①~④로 나누고(docs/features/identity.md §12), I-T48은 실제 Kafka와 파드 이름이 다른 서비스 인스턴스로 본다. 쿠버네티스 위 여러 파드로 보는 확인은 kind 잡을 미룬 구간 5의 몫이다(ADR-0331 결정 7, ADR-0332).

## 검토한 대안

| 선택지 | 고르지 않은 까닭 |
| --- | --- |
| `createService`가 브로커 주소를 보고 스스로 켠다 | 서비스 시험과 bundle이 뜻하지 않게 Kafka에 붙고, 서비스마다 다른 시작 차례(준비 작업, 닫는 차례)를 플랫폼이 알 수 없다. 대신 결정 3으로 빠뜨림을 막는다 |
| 서비스마다 따로 조립한다 | 같은 조립이 일곱 벌이 되고 브로커 주소 규칙이 갈라진다 |
| 종료 사건을 계약(Zod) 전체로 검사한다 | 이유 값이 하나 더해지면 그 사건이 모두 버려져 끝난 세션이 통한다 |
| 미루기를 남긴다(또는 1분으로 줄인다) | 처리할 때 집합을 장애 전환으로 잃는 위험과 반복·지표 셋을 계속 안는다. 막으려던 일(탈퇴 전 토큰의 요청)은 종료 세션 목록이 막는다. ADR-0214 결정 7의 끝 줄과도 어긋난다 |
| 두 제어 토픽을 소비자 하나로 읽는다 | 파드당 연결이 준다. 그러나 `BroadcastSource`와 준비 작업이 토픽마다라 플랫폼을 다시 짜야 한다. 연결 한도 판정(아래 '되돌릴 조건')이 나오기 전에는 하지 않는다 |

## 결과

- 로그아웃·원격 로그아웃·탈퇴·관리자 강제 종료로 끝난 세션의 토큰이 신원을 받는 모든 업무 서비스에서 수 초 안에 401이다. 새로 뜬 파드도 15분 창을 다시 읽은 뒤 준비 상태가 된다.
- queue-svc의 탈퇴 사건 처리가 단순해진다(처리할 때 집합과 반복이 없다). 탈퇴한 사람의 두 키가 15분 일찍 짧아진다.
- 대가와 남는 한계
  - 파드마다 Kafka 연결이 셋(방송형 소비자 둘, 관리 연결 하나) 는다. 대기열처럼 T=0에 파드가 크게 느는 서비스는 브로커 연결 수와 연결을 새로 맺는 속도가 늘어난다(docs/verification.md §4.1, 판정은 MSK 연결 한도와 HPA 최대 파드 수가 정해지는 구간 5).
  - 두 토픽의 도착 차이: 탈퇴 사건이 먼저 처리되고 어떤 queue-svc 파드가 아직 종료 사건을 받지 못했거나, 이미 가드를 지난 요청의 Lua가 만료 당기기 뒤에 닿으면 그 사람 키의 만료를 판매 종료로 다시 건다. 보통 1초 안 [가정]이고, 소비 지연이 10초를 넘으면 SEV3로 보인다. Kafka에 닿지 못한 채 뜬 파드가 따라잡는 동안은 그 틈이 따라잡기 시간만큼 커진다(ADR-0103 남는 한계). 후기의 다시 정리(I-T83)는 같은 까닭으로 남긴다.
  - 파드 시작이 두 토픽 읽기만큼 늦다(ADR-0103 대가). 토픽이 없으면 30초 뒤 빈 목록으로 준비되고 SEV2(`control_sync_lagging`)가 그대로 남는다. 두 제어 토픽(`control.settings`는 압축 토픽) 만들기, 새로 Kafka에 닿는 서비스(identity 앱·payment·ticket)의 브로커 주소와 MSK 권한(파드마다 다른 그룹 이름)은 배포 쪽 일이라 구간 5다.

## 되돌릴 조건

- 연결 한도 판정에서 파드 수 × 연결 수가 브로커 한도의 80% [가정]에 닿거나 T=0 확장 때 연결 맺기가 한도에 걸리면, 두 제어 토픽을 소비자 하나로 읽고 관리 연결을 줄이도록 플랫폼을 바꾼다.
- 소비 지연 `control_consumer_lag_seconds`가 평소에도 1초 [가정]를 넘어 위 도착 차이가 커지면, queue-svc에 후기와 같은 '탈퇴 + 16분 다시 정리'를 더하는 안을 다시 본다.
- 종료 세션 15분 되감기가 파드 시작을 10초 [가정] 넘게 늦추면 ADR-0103의 되돌릴 조건대로 한다.
