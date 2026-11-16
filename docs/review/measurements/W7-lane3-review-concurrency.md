# W7-audit 웨이브 7 갈래 3 끝 리뷰: 동시 실행·장애

- 날짜: 2026-11-16
- 리뷰 담당: `l3w7-rev-concurrency`(계획·시험·구현에 관여하지 않음, 코드를 고치지 않음)
- 대상: `853758eb..3087ad85`(drizzle `meta/*_snapshot.json` 제외). 파일은 모두 `git show 3087ad85:<경로>`로 읽었다(작업 트리는 검증 담당이 바꾸는 중이라 보지 않았다). 줄 번호는 3087ad85 기준이다.
- 관점: 트랜잭션 범위, 같은 사건이 두 번·순서가 바뀌어 올 때의 멱등(같은 일을 여러 번 해도 결과가 같음), 소비자 오프셋(어디까지 읽었는지 적어 두는 위치) 커밋 시점, 브로커(Kafka 서버)·DB 끊김 때 닫힌 쪽으로 실패하기(fail-closed)와 시작 차단, 긴 내려받기, 동시 내려받기, 정비 일과 0022 권한의 경쟁, 시작 파일 조립.
- 지적 수: 높음 0, 중간 3, 낮음 6.

## 지적

### K1 중간: 0021의 `source_ip` CHECK가 이전 판(N-1) 코드의 내려받기를 막는다

- 파일:줄: `services/core-svc/migrations/0021_attendee_access_audit_list.sql:13`
- 틀린 점: `CHECK ("source_ip" IS NOT NULL) NOT VALID`는 옛 행만 검사하지 않을 뿐, 마이그레이션 뒤에 들어오는 모든 새 행에는 바로 걸린다. 이전 판 코드(853758eb)는 `source_ip` 칸을 모르므로, 마이그레이션이 끝난 뒤 아직 떠 있는 이전 판 파드의 내려받기는 접속기록 넣기에서 23514로 실패한다. 이전 판은 이력과 접속기록을 트랜잭션 둘로 나눠 쓰므로(계획 §2 '무엇이 틀렸나'), 이력 행만 남고 접속기록이 없는 A2-19 결함이 배포 창 동안 그대로 다시 생긴다. 배포를 되돌리면(이전 다이제스트로 롤링) 앞으로 고칠 때까지 모든 내려받기가 실패한다.
- 근거: docs/devops.md 577~579줄 §7.1 원칙 2('모든 스키마 변경은 실행 중인 버전(N-1)과 새 버전(N)에 함께 맞아야 한다')·원칙 3('스키마 변경과 그 변경에 기대는 코드 변경은 같은 배포에 넣지 않는다'), 589줄(마이그레이션 잡은 ArgoCD PreSync로 롤아웃보다 먼저 돈다). 계획 R2 보충은 옛 '행'만 생각했고 옛 '코드'는 다루지 않았다.
- 고칠 쪽: plan(나누기 결정) → impl. 예: 이번 배포는 칸만 더하고(NULL 허용), 새 판이 모두 뜬 다음 배포에서 CHECK를 `NOT VALID`로 더한다. 또는 이번 0021에서 CHECK를 빼고 다음 마이그레이션으로 옮긴다. 시험은 docs/devops.md 610줄 '적용 시험 ③(N-1 앱의 통합 시험을 새 스키마에서)'에 해당한다.
- 확인 필요: 아니오(칸이 없던 코드는 그 칸을 쓸 수 없다).

### K2 중간: 탈퇴 익명화가 후기 표 전체를 훑고, 소비자가 API와 같은 연결 풀(10개)을 최대 128개 동시 처리로 나눠 쓴다

- 파일:줄: `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:254-260`(`update review … where account_id = $1`), `services/core-svc/src/modules/review/adapters/db/schema.ts:36-39`(색인), `services/core-svc/src/consumers/start.ts:35-50`(`maxKeys` 넘기지 않음), `services/core-svc/src/main.ts:71`·`122`(소비자가 API의 `database`를 씀), `packages/platform/src/keyed-consumer.ts:10`(파티션마다 키 32개), `packages/platform/src/stream-worker.ts:344`(파티션 4개 동시), `packages/platform/src/database.ts:89-90`(풀 기본 10개, 기다림 1초)
- 틀린 점: `review`에는 `account_id`로 시작하는 색인이 없다. 있는 것은 `(event_id, account_id) WHERE status <> 'DELETED'` 부분 유일 색인인데 앞 칸이 `event_id`이고 조건도 맞지 않아, 익명화 UPDATE는 사건 하나마다 후기 표를 처음부터 끝까지 읽는다. 이 문장은 R-617부터 있었지만 부르는 곳이 없었고, 이번에 소비자가 붙어 실제로 돈다. 소비자는 파드 하나에서 키 32개 × 파티션 4개까지 동시에 `handle`을 부르고, 그 DB는 팬·관제 HTTP 경로와 같은 `core_app` 풀(최대 10개, 연결 기다림 1초)이다. 처음 켤 때(커밋이 없어 EARLIEST, 토픽 보관 3일치)나 소비가 멈췄다 풀릴 때 사건이 몰리면, 긴 UPDATE가 풀을 차지해 같은 파드의 API 요청이 429(server-busy)로 거절될 수 있다.
- 근거: docs/devops.md 609줄 §7.3 '실행 계획 검사'(새로 쓰거나 바뀐 쿼리는 docs/data.md §5.1 표에 한 줄과 실행 계획을 붙인다). docs/streaming.md 127줄은 소비자를 API 파드에 둔다고 정했지만 풀·동시 처리 수는 정하지 않았다.
- 고칠 쪽: impl(마이그레이션으로 `review(account_id)` 색인, `startCoreConsumers`에 작은 `maxKeys`, 또는 소비자 전용 작은 풀) + plan(data.md §5.1 쿼리 행).
- 확인 필요: 예. 운영 규모의 후기 행 수와 `identity.accounts-withdrawn` 파티션 수로 실제 몰림 크기를 재 봐야 한다.

### K3 중간: 탈퇴 사건을 바로 처리해, 그 뒤 15분 안에 쓴 후기는 계정 ID가 영영 남는다(같은 저장소에 더 싼 막음이 있다)

- 파일:줄: `services/core-svc/src/modules/review/inbound/account-withdrawn.handler.ts:75-78`
- 틀린 점: 처리기는 사건을 받자마자 익명화한다. 탈퇴 전에 받은 액세스 토큰(최대 15분)으로 사건 처리 뒤에 후기를 쓰면, 그 계정의 사건은 다시 오지 않으므로 그 후기는 계정·주문 참조를 가진 채 남는다(사건과 쓰기의 순서가 뒤바뀐 경우). 계획과 정본은 이것을 '남는 한계'로 적고 HOT-400(끝난 세션 토큰 막기)을 기다린다. 그런데 같은 사건을 읽는 queue-svc는 바로 이 15분 때문에 `withdrawnAt + 15분`이 지난 뒤 처리한다.
- 근거: docs/features/identity.md 551줄('남는 한계'), docs/streaming.md 126줄(queue-svc: '탈퇴 사건은 때(`withdrawnAt` + 15분)가 안 되면 … 처리할 때 집합에 넣고 바로 커밋한다'), docs/data.md §6 '관람 후기' 행(탈퇴하면 파기).
- 고칠 쪽: plan(소유자 결정). 안: `withdrawnAt + 15분` 뒤에 한 번 더 익명화(정비 일이나 늦춘 처리), 또는 HOT-400 전까지 지금 한계를 받아들인다.
- 확인 필요: 예. 후기 쓰기 경로가 탈퇴한 계정의 세션을 따로 막는지(막는다면 이 지적은 없어진다).

### K4 낮음: Kafka에 닿지 못하면 core API 새 파드가 뜨지 못한다(또는 반대로 조용히 소비자 없이 뜬다)

- 파일:줄: `services/core-svc/src/main.ts:127-131`, `packages/platform/src/stream-worker.ts:340-343`·`384-401`
- 틀린 점: `started`가 거부되면 종료 코드 1로 끝낸다. 클라이언트의 `connect()`가 브로커에 닿지 못할 때 거부하는 것이라면, MSK 장애 중에는 팬 화면을 내주는 core API의 새 파드(HPA로 늘리기, 롤링 재시작)가 모두 시작에 실패한다. 후기 익명화라는 늦어도 되는 일 하나가 API 가용성을 Kafka에 묶는다. 반대로 `connect()`가 거부하지 않고 기다리기만 한다면, 소비자 없이 '준비됨'으로 떠서 정본의 '켜지 못하면 종료 코드 1'이 지켜지지 않는다. 또 시작에 실패한 소비자의 `stop()`은 `consumer.assignment()`에서 던질 수 있어 `disconnect()`(401줄)까지 가지 못할 수 있다.
- 근거: docs/streaming.md 127줄('소비자를 켜지 못하면 오류 한 줄 뒤 종료 코드 1로 나간다'). queue-svc·purchase-svc와 같은 규칙이지만, 그 둘은 Kafka가 본업이다.
- 고칠 쪽: plan(소비자를 relay 프로세스처럼 따로 둘지, API 파드에서는 시작 실패를 다시 시도로 바꿀지).
- 확인 필요: 예. `@confluentinc/kafka-javascript`의 KafkaJS 호환 `connect()`가 브로커에 닿지 못할 때 거부하는지, 얼마 뒤인지, 그리고 시작 실패 뒤 프로세스가 실제로 끝나는지.

### K5 낮음: 읽지 못한 탈퇴 사건의 보류 행은 영영 '보류 중'이라 그 계정 키가 계속 막히고 보류 수 지표가 0으로 돌아오지 않는다

- 파일:줄: `packages/platform/src/keyed-consumer.ts:350-361`(읽기 실패면 Kafka 키를 업무 키로), `services/core-svc/src/consumers/index.ts:44-54`(값을 null로), `services/core-svc/migrations/0022_review_role_grants.sql:19`(`reprocessed_at` 고치기 없음), `packages/platform/src/held-events.ts:133-135`(다시 처리한 행만 지움)
- 틀린 점: 읽지 못한 사건은 값 없이(null) 계정 ID 키로 보류된다. core에는 다시 처리(RB-11)가 없고 `core_app`은 `reprocessed_at`을 고칠 수 없어, 그 행은 지워지지도 닫히지도 않는다. 그래서 같은 계정의 고친 사건이 다시 와도 '앞 사건이 보류 중'으로 함께 보류되고, `consumer_held_events`는 늘 0보다 크다. 내부 경로로 손으로 익명화해도 보류 표시는 풀리지 않는다. 또 identity가 Avro(BAS-030)로 바꾸면 `pidFreeValue`는 JSON만 읽으므로, 처리기 해독기를 먼저 바꾸지 않은 동안의 모든 보류 값이 null이 된다.
- 근거: 계획 §4 '범위 밖(후속)'이 RB-11과 `reprocessed_at` 권한을 뒤로 미뤘다. 손으로 다시 하는 길(내부 경로)은 있으므로 법정 의무는 되살릴 수 있다.
- 고칠 쪽: plan(RB-11 후속에 '값 없는 보류 행을 손으로 닫는 절차'와 보류 지표 경보의 대응 절차를 넣는다).
- 확인 필요: 아니오.

### K6 낮음: 0021의 CHECK 둘이 `NOT VALID` 없이 표 전체를 잠그고 검사한다

- 파일:줄: `services/core-svc/migrations/0021_attendee_access_audit_list.sql:10-11`
- 틀린 점: `attendee_export_audit_action_check`·`attendee_export_audit_shape_check`를 검증까지 한 번에 더해, 검사하는 동안 표 전체 잠금(ACCESS EXCLUSIVE)을 쥔다. 지금 표가 작아 실제 영향은 짧다.
- 근거: docs/devops.md 603줄('제약은 `NOT VALID`로 먼저 추가하고, 나중에 `VALIDATE CONSTRAINT`'), 608줄(Squawk가 '`NOT VALID` 없는 제약'을 막는다).
- 고칠 쪽: impl(`NOT VALID` 뒤 `VALIDATE CONSTRAINT`, 또는 Squawk 예외로 적고 까닭을 남긴다).
- 확인 필요: 예. Squawk 검사가 지금 CI에서 core-svc 마이그레이션에 실제로 도는지.

### K7 낮음: 긴 내려받기에 전체 시간 한도와 끊긴 요청 취소가 없고, 원천의 2xx 아닌 답은 500이 된다

- 파일:줄: `services/core-svc/src/modules/export/application/attendee-exports.ts:176-189`, `services/core-svc/src/modules/export/adapters/http-attendee-source.ts:33`·`45`
- 틀린 점: 페이지 하나는 5초 상한이 있지만 전체에는 한도가 없다(50만 행이면 500번 차례대로 부르고, 최악 2,500초). 요청한 쪽이 끊어도(입구 시간 초과, 창 닫기) 끝까지 읽고 COMPLETED 이력과 DOWNLOAD 접속기록을 남긴다. 파트너가 다시 누르면 같은 전체 읽기가 겹친다. 원천이 2xx가 아니게 답하면 평범한 `Error`라 500이 되고, 시간 초과는 공용 클라이언트의 오류 형태를 따르므로 같은 '원천 장애'의 답이 갈린다(settlement.md §9의 503 `dependency-unavailable`과도 다르다).
- 근거: 계획 §1이 J-T26 ② 스트리밍(첫 바이트 2초)을 범위 밖으로 두었다. 그때 같이 정할 일이다.
- 고칠 쪽: plan(J-T26 ② 후속에 전체 한도·취소 신호를 넣는다) + impl(원천 실패를 503으로 바꾸기).
- 확인 필요: 예. 파트너 API 입구 경로의 시간 초과 값, `createExternalHttpClient`가 시간 초과 때 던지는 오류.

### K8 낮음(범위 밖): purchase 명단 원천이 페이지마다 회차 전체 합계를 다시 센다

- 파일:줄: `services/purchase-svc/src/modules/booking/adapters/db/drizzle-attendee-reader.ts:70`
- 틀린 점: `list`가 페이지마다 `count(eventId)`(주문·좌석·판매 상태 조인의 전체 합계)를 부른다. core 내려받기는 1,000행씩 부르므로 50만 행이면 전체 합계를 500번 센다. 판매 경로와 같은 purchase DB의 부하다. 이번 바뀐 부분은 아니지만, A2-17로 끝까지 읽기가 확실해졌다.
- 근거: 코드 확인. 내려받기는 합계를 쓰지 않는다(`attendee-exports.ts:176-189`).
- 고칠 쪽: impl(purchase, 첫 페이지나 합계 요청 때만 센다).
- 확인 필요: 예. 운영 규모 회차의 합계 쿼리 실행 시간.

### K9 낮음: 운영 조립의 소비자 경로 일부가 시험되지 않는다

- 파일:줄: `services/core-svc/test-int/review-withdrawn-consumer.int.test.ts:98-106`, `services/core-svc/test/core-consumers.test.ts:140`
- 틀린 점: 통합 시험 ⑫는 `registry`를 넘기지 않아, main.ts가 켜는 보류 수 세기(`heldEventCounts`, `core_app`으로 `held_event` 읽기)와 소비자 지표 경로를 거치지 않는다. main.ts 조립은 글 차례 대조(⑩)뿐이라 `service.app.get(Reviews)`와 처리기 로거 연결은 실제로 돌려 보지 않았다.
- 근거: 계획 §4 ⑩ 비고('약한 검사라 ⑫가 실제 동작을 본다')인데 ⑫도 main.ts의 넘기는 값과 같지 않다.
- 고칠 쪽: test(⑫에 `registry`를 넘기고 `consumer_held_events` 값이 1이 되는지 본다).
- 확인 필요: 아니오.

## 본 범위

- 내려받기 기록 트랜잭션: `DrizzleAttendeeExportStore.recordExport`(`drizzle-export-store.ts:28-65`)는 이력과 DOWNLOAD 접속기록을 테넌트 설정이 붙은 트랜잭션 하나에 넣고, 실패하면 둘 다 되돌린다. 파일은 기록 앞에 만들고 기록이 실패하면 주지 않는다(`attendee-exports.ts:141-162`). 통합 시험 ⑥이 실제 되돌림을 본다. 이력과 접속기록 사이 외래 키가 없어 이력 정리가 접속기록을 지우지 않는다.
- 명단 보기: 접속기록(`recordView`)을 기다린 뒤에만 명단을 돌려준다(fail-closed). 원천 HTTP를 읽는 동안 DB 연결을 쥐지 않는다.
- 페이지 반복: 원천 커서는 주문 ID 오름차순이라 늘 앞으로 간다. core는 보낸 적 있는 커서가 다시 오면 503으로 끝내 정본('방금 보낸 커서')보다 넓게 순환을 막는다. 0건 페이지가 이어져도 주문 수로 끝이 있다.
- 동시 내려받기: 재인증 토큰은 jti 한 번 쓰기(`sources.ts:39-42`)라 같은 토큰 둘은 하나만 지난다. 다른 토큰 둘은 서로 막지 않는다. 메모리 적재(J-T26 ②)는 계획대로 범위 밖이다.
- 탈퇴 처리기 멱등: 익명화는 UPDATE 문 하나이고 다시 하면 0건이다. 오프셋 커밋은 '끝나지 않은 가장 작은 오프셋'이고 보류는 저장이 끝난 뒤 끝난 것으로 친다. 커밋 전에 죽어 다시 받아도 결과가 같다. 같은 위치·같은 eventKey의 보류는 유일 색인과 `on conflict do nothing`으로 두 번 들어가지 않는다.
- 일시 실패: DB 끊김·시간 초과는 파티션을 멈추고 늘려 쉬며 기다린다. 권한 오류(42501)는 일시 실패가 아니라 다섯 번 뒤 보류된다(0022가 막는 경우).
- 시작 차단: `kafkaConsumersFromEnv`가 `createService`보다 앞이고(main.ts:17), local·ci 밖에서 브로커가 없거나 틀리면 시작하지 않는다. 소비자 DB는 `core_app`으로 확인한 `database`다.
- 종료 차례: 소비자 멈춤(넘기기 기다림 한도 30초) → 서비스 닫기 → DB 닫기. 플랫폼은 Nest 종료 신호 훅을 켜지 않아 main.ts의 SIGTERM 처리와 겨루지 않는다. 두 번 불러도 한 번만 한다.
- 정비 일과 0022: 임시조치 끝내기의 UPDATE·RETURNING이 쓰는 칸(`id·status·notice·notice_until`, `reason·restored_at·ends_at`)과 보류 표 지우기(`reprocessed_at`)는 모두 받은 칸 권한 안이다. 정비 일과 CS 조치는 둘 다 후기 → 조치 기록 차례로 잠가 교착이 생기지 않는다. 익명화와 정비 일은 `updated_at` 말고는 다른 칸을 고치고, 행 잠금 뒤 조건을 다시 보므로 덮어쓰기가 없다.
- 조립: core-svc는 한 프로세스 합본(`services/bundle`)에 들어가지 않아 main.ts만 소비자를 켜면 된다. 지표 이름이 다른 곳과 겹치지 않는다.
- 보지 않은 것: 플랫폼 키 단위 소비자의 자체 시험, Kafka 클라이언트의 실제 연결 동작(K4), 배포 값(core-svc 차트 값이 저장소에 없음), 후기 쓰기 경로의 탈퇴 세션 막기(K3), 통합 시험 실행(Docker 잠금을 받지 않았다).
