# W7-audit 웨이브 7 갈래 3 끝 리뷰: 정확성

- 날짜: 2026-11-16
- 리뷰 담당: `l3w7-rev-correct`(계획·시험·구현에 관여하지 않음, 코드를 고치지 않음)
- 대상: `853758eb..3087ad85`(drizzle `meta/*_snapshot.json` 제외, 단 0021 스냅숏에 `source_ip` CHECK가 있는지만 찾아봤다). 파일은 모두 `git show 3087ad85:<경로>`로 읽었다(작업 트리는 검증 담당이 일부러 바꾸는 중이라 보지 않았다). 계획은 `## 계획` 절만 읽었다.
- 관점: 업무 규칙·계산·상태 전이, 커서와 페이지 끝 판정(목록을 나눠 읽을 때 '다음 쪽 표시'인 커서로 어디서 멈추는지), 경계값(0, 빈 목록, 상한, 같은 커서 되풀이), 오류 응답 코드와 Problem 형식(RFC 9457 오류 본문), 정본 값과 코드 값의 일치, 바뀐 포트(모듈 사이 약속한 함수 모양)를 기존 호출자가 모두 따라왔는지, 마이그레이션이 기존 데이터에서 실패하지 않는지, 시험이 판정 기준을 실제로 단언하는지.
- 지적 수: 높음 0, 중간 1, 낮음 3.

## 지적

### C1 중간: 같은 커서를 되풀이할 때의 503이 오류 계약(openapi·guidelines §2)과 어긋난다

- 위치: `services/core-svc/src/modules/export/application/attendee-exports.ts:186`(새 503), `services/core-svc/src/modules/export/export.module.ts:51-57`(이미 있던 원천 없음 503), `docs/api/openapi.yaml:5153`(`createPartnerEventAttendeeExport` 응답), `docs/api/openapi.yaml:6359-6383`(`listPartnerEventAttendees` 응답)
- 틀린 점: 이번에 새로 생긴 오류 길 `ExportProblem('dependency-unavailable', 503, '예매자 명단 원천이 같은 페이지를 되풀이했습니다')`가 세 가지에서 정본과 다르다.
  1. `title`이 오류 목록의 값과 다르다. `docs/api/guidelines.md:52`는 "한 `type`은 언제나 같은 상태 코드와 같은 `title`로 낸다"이고, 목록 `x-peaket-problem-types`(openapi.yaml:82)의 `dependency-unavailable` 제목은 '의존 서비스를 잠시 쓸 수 없습니다'다. 플랫폼 `ProblemError`는 받은 제목을 그대로 싣는다(`packages/platform/src/problem.ts:37-52`). 사정 설명은 `detail` 자리다.
  2. `Retry-After`(다시 해 볼 때까지 기다릴 초)가 없다. openapi의 503 응답 꼴 `ServiceUnavailable`(openapi.yaml:4055)은 "Retry-After를 싣는다"이고, 플랫폼 오류 처리기는 `retryAfterSeconds`를 줄 때만 머리를 붙인다(`packages/platform/src/problem-filter.ts:85`).
  3. openapi의 내려받기 응답 목록에 503이 없다(200·403·410뿐). 명단 보기도 원천이 없으면 503인데(export.module.ts:51-57, 이번 묶음 전부터) 목록에 없다. 정본 설명서(docs/features/settlement.md §9 '내려받기')에는 503을 적었으나 API 정본인 openapi에는 옮기지 않았다.
- 근거: 정본 `docs/api/guidelines.md` §2, openapi `ServiceUnavailable`·`x-peaket-problem-types`. 이 모듈의 다른 `ExportProblem`도 제목을 따로 쓰는 버릇이 있으나(이번 묶음 전부터), 503 되풀이 길은 이번에 새로 생겼다.
- 고칠 쪽: impl(제목을 목록 값으로, 지금 문구는 `detail`로) + plan(openapi 두 연산의 응답 목록에 503을 적고, 되풀이 503에 `Retry-After`를 줄지 정한다)
- 확인 필요: 예. 원천이 같은 커서를 되풀이하는 것은 원천 결함이라 다시 해도 낫지 않을 수 있다. 그래도 503(+`Retry-After`)으로 둘지, 다른 이름의 오류로 둘지는 계획 담당이 정본에 정해야 한다.

### C2 낮음: 보류 감싸기가 처리기와 다른 해독기(JSON 고정)를 쓴다

- 위치: `services/core-svc/src/consumers/index.ts:44-54`(`pidFreeValue`가 `JSON.parse`), `services/core-svc/src/modules/review/inbound/account-withdrawn.handler.ts:4,24-26,44,54`(처리기는 바꿔 끼우는 `AccountWithdrawnCodec`, 주석에 'Avro는 BAS-030')
- 틀린 점: 처리기는 값 해독을 `codec`으로 받아 바꿀 수 있게 했지만, 보류 기록에서 pid를 빼는 감싸기는 늘 JSON으로 읽는다. BAS-030에서 처리기에 Avro 해독기를 끼우면, 처리기는 사건을 읽는데 감싸기는 모든 탈퇴 사건 값을 '읽지 못함'으로 보고 `held_event.value`를 null로 넣는다. 그러면 저장소 장애 등으로 보류된 정상 사건도 값이 사라져 다시 처리(RB-11)할 수 없고, 법정 파기 의무인 후기 익명화를 소리 없이 놓친다. pid는 새지 않는 쪽(fail-closed)이라 지금 동작은 맞다.
- 근거: 계획 §4 공개 인터페이스(`pidFreeHeldEventStore`는 "읽지 못한 값은 null"), docs/streaming.md §2.6 'core-svc 소비자'(보류 사건은 `eventKey`·`accountId`·`withdrawnAt` JSON으로 바꿔 넣는다). 지금은 identity가 JSON으로 내므로 실제 결함은 아니다.
- 고칠 쪽: impl(감싸기가 처리기와 같은 해독기를 받게) 또는 plan(BAS-030 할 일에 "보류 감싸기도 같은 해독기로 바꾼다"를 적는다)
- 확인 필요: 아니오

### C3 낮음: 0019 때 넣은 행이 있는 DB에 0021을 적용하는 시험이 없다

- 위치: `services/core-svc/test-int/export-audit.int.test.ts:84-90`(빈 DB에 마이그레이션을 한 번에 적용), `services/core-svc/test/export-audit.test.ts:414-449`(0021 SQL 원문 시험)
- 틀린 점: `NOT VALID`(이미 있는 행은 검사하지 않고 새 행만 검사하는 CHECK)를 둔 까닭이 '0019로 이미 들어간 행'인데, 그런 행이 있는 상태에서 0021을 돌려 보는 시험이 없다. 원문 시험은 필요한 문장이 있는지만 보고 다른 문장을 막지 않아, 예를 들어 `ALTER COLUMN "source_ip" SET NOT NULL`이나 `VALIDATE CONSTRAINT`가 더해지면 운영의 기존 행에서 마이그레이션이 실패하는데도 모든 시험이 통과한다.
- 근거: 지금 SQL은 맞다(직접 대조): 0019 행은 `export_id`·`reason`·`format`이 NOT NULL이었고 `action`은 기본값 `DOWNLOAD`로 채워지므로 모양 CHECK(곧바로 검사됨)를 통과하고, `format` CHECK는 NULL을 통과시키며, `source_ip` CHECK는 `NOT VALID`다. 0022는 권한만 바꿔 기존 데이터와 무관하다.
- 고칠 쪽: test(0020까지 적용한 DB에 0019 모양 행을 넣고 0021·0022를 적용해 성공과 옛 행의 `action = 'DOWNLOAD'`·`filter = '{}'`를 보는 통합 시험, 또는 원문 시험에 '`source_ip`에 NOT NULL·VALIDATE 없음'을 더한다)
- 확인 필요: 아니오

### C4 낮음: 원천의 빈 문자열 커서를 '다음 있음'으로 받는다

- 위치: `services/core-svc/src/modules/export/adapters/http-attendee-source.ts:22`(`nextCursor: z.string().nullable()`), 같은 파일 42줄(`cursor ? { cursor } : {}`), `services/core-svc/src/modules/export/inbound/partner-attendee-export.controller.ts:42`
- 틀린 점: 응답 모양 검사가 `nextCursor: ''`를 통과시킨다. core는 ''를 '다음이 있다'로 보지만, 다음 요청에서는 빈 커서를 빼고 보내 첫 쪽을 다시 읽는다. 내려받기는 둘째 바퀴에 되풀이 검사로 503이 되어 결과는 막히지만(잘린 파일은 안 나간다), 명단 보기는 ''를 화면에 그대로 넘기고 화면이 `cursor=`로 다시 부르면 컨트롤러도 빈 커서를 빼서 첫 쪽이 되풀이된다. purchase 쪽 입력 검사는 커서를 `min(1)`로 받으므로(`services/purchase-svc/src/modules/booking/inbound/attendee-export.controller.ts:8`) 같은 약속을 응답에도 거는 것이 맞다.
- 근거: 계획 §1 "응답 모양이 틀리면 … 조용히 끝으로 보지 않는다", docs/api/guidelines.md §3 '끝은 `nextCursor`가 null일 때뿐'. 지금 purchase 원천은 ''를 내지 않아 실제로 일어나지는 않는다.
- 고칠 쪽: impl(`z.string().min(1).nullable()`) + test(`nextCursor: ''` 거절을 응답 모양 시험에 더한다)
- 확인 필요: 아니오

## 지적하지 않은 것(정본끼리의 어긋남, 이미 OPEN 후보)

- 탈퇴한 계정의 후기 본문·별점을 남기는 지금 동작은 docs/data.md §6 '관람 후기' 행(탈퇴 때 파기)과 다르다. 계획 §5 OPEN 후보 1이 이미 소유자 결정으로 올렸고, 시험 ①⑪은 '계정·주문 참조를 끊는다'만 굳게 보고 본문·별점은 '지금 그대로'로만 적었으므로 지적 수에 넣지 않았다.

## 본 범위

맞다고 확인한 것과 읽은 곳이다.

- A2-17 페이지 끝 판정: `AttendeeExports.#readAll`(attendee-exports.ts:176-189)은 `nextCursor`가 null일 때만 멈추고, 짧은 쪽·0건 쪽은 이어 읽으며, 보낸 커서를 다시 받으면(방금 것뿐 아니라 앞서 보낸 것도) 503으로 끝내고 이력·접속기록을 쓰지 않는다(기록은 다 읽은 뒤라 남지 않는다). 500,000행 초과 422는 null 검사보다 먼저라 마지막 쪽에서 넘어도 잡힌다. 명단 보기는 원천 `nextCursor`를 그대로 싣는다(122줄). 메모리 원천(`memory-merch-store.ts`)은 남은 것이 `limit`보다 많을 때만 커서를 준다(정확히 `limit`건이면 null). purchase 원천(`drizzle-attendee-reader.ts`)은 `limit + 1`로 읽고 마지막으로 '읽은' 주문으로 커서를 만들어, 거른 뒤 0건 쪽에도 커서를 준다. 응답 모양 검사(zod)는 purchase 컨트롤러의 응답 모양(`attendee-export.controller.ts:9-15`)과 칸·형이 같다.
- A2-17 바뀐 포트 모양: `AttendeeSource`·`AttendeeExportStore`의 구현과 가짜(HTTP·메모리·없음 원천, 메모리·Drizzle 저장소, 시험의 RecordingStore·FailableExportStore·scriptedSource 등)가 모두 새 모양을 따른다. `DrizzleMerchOrderStore`는 생성자 인자 하나로 바뀌었고 부르는 곳은 `shop.module.ts` 하나다. `listAttendees`·`countAttendees`를 부르는 곳은 메모리 조립의 `MerchAttendeeSource`와 시험뿐이다(서비스·앱·도구 전체를 찾아봄).
- A2-19: `listAttendees` 차례(행위자·접속지 → 회차 404 → 보유 기간 410 → 원천·합계 → 표시 이름 → `recordView` → 응답)가 계획과 같고, 기록 실패는 그대로 던진다. 건수는 그 쪽의 행 수(합계 아님), 조건은 받은 `cursor`가 없으면 키가 없다. 내려받기는 `recordExport` 한 번이고 Drizzle은 트랜잭션 하나에 두 행을 넣는다. 보존 끝 `accessLogRetainUntil`은 UTC 달력 2년(2월 29일 → 3월 1일)이고 시험 셋 값을 손으로 맞춰 봤다. 컨트롤러는 행위자를 로그인 주체로, 접속지를 identity의 `clientIpOf`와 같은 규칙으로 넘긴다(두 함수 본문이 같다). 0021의 CHECK 둘과 `source_ip` CHECK는 Drizzle 스키마·0021 스냅숏과 같은 뜻이다.
- COV2-06: 처리기 해독(값 없음·계약 모양 아님 거절, 계정 ID 소문자), 업무 키·중복 제거 키, 로그에 계정 ID·pid 없음, 보류 감싸기(탈퇴 토픽만 세 칸 JSON, 읽지 못하면 null), `kafkaConsumersFromEnv`(local·ci만 꺼짐, 틀린 조각은 몇 번째만), `main.ts`(서비스 만들기 전 설정 읽기, 듣기 뒤 소비자 시작, 종료 때 소비자 먼저 멈춤, 소비자 DB는 `core_app`으로 확인한 연결). 0022 권한은 `drizzle-review-store.ts`의 쓰기 문장 하나하나(쓰기·고치기·소프트 지우기·신고·통보 가림의 `FOR UPDATE`·익명화의 `RETURNING id`·지문 등록과 해제·임시조치 끝내기)와 플랫폼 `held-events.ts`(넣기 `ON CONFLICT DO NOTHING`, 정리 `delete … where reprocessed_at <`)에 대조해 빠진 권한이 없음을 봤다. `core_maintenance` 역할은 0008이 만든다.
- SEC-06R: 시험 ①이 빈 `onModuleInit` 변이를, ④⑤가 `===` 비교와 하위 가드의 직접 비교 변이를 가른다(플랫폼 `sameSecret`은 `node:crypto`의 `timingSafeEqual`을 써 엿보기가 닿는다).
- 시험이 판정 기준을 단언하는지: 계획 §1~§4 시험 목록의 단언 값(커서 차례 `[undefined, 'c1', 'c2']`, 같은 커서 503과 이력·기록 0, LIST 칸 값, `recordExport` 호출 1, 달력 2년 세 값, 0021·0022 원문, 운영 역할 42501, Kafka 그룹 이름과 보류 행의 pid 없음)이 시험 코드에 정본 값으로 적혀 있다.
- 읽은 정본 줄: docs/api/guidelines.md §2(50~62줄)·§3(66~70줄), docs/api/openapi.yaml 82·4055·5152~5154·6359~6383줄, docs/features/settlement.md §9 새 항목과 §13 J-T26 행, docs/data.md §2·§4의 15·§6 바뀐 줄, docs/streaming.md·docs/api/asyncapi.yaml·docs/features/identity.md·docs/security/ 바뀐 줄, docs/infra.md 285줄(입구 규칙 2).
- 보지 않은 것: 시험·게이트를 직접 돌리지 않았다(검증 담당 몫). 동시 실행·장애·보안 관점은 다른 리뷰 담당 몫이라 깊게 보지 않았다.
