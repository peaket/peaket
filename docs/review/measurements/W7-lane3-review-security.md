# 웨이브 7 갈래 3 끝 리뷰: 보안 (W7-audit)

- 리뷰 담당: `l3w7-rev-security`(관점: 보안). 계획·시험·구현에 관여하지 않았고 코드를 고치지 않았다.
- 기준: 가지 `wave/lane3-w7`의 `3087ad85`. 바뀐 부분은 `853758eb..3087ad85`(drizzle `meta/*_snapshot.json`은 건너뜀). 파일은 모두 `git show 3087ad85:<경로>`로 읽었다.
- 묶음: W7-audit(A2-17 예매자 명단 짧은 페이지, A2-19 명단 접속기록, R-628 내부 토큰 회귀 시험, COV2-06 탈퇴 뒤 후기 익명화). 계획은 `docs/review/plans/W7-audit.md`의 `## 계획` 절만 읽었다.
- 날짜: 2026-11-16.

이 문서의 말 풀이(처음 나올 때만):

- **접속기록**: 직원이 개인정보를 언제, 어디서(접속지 IP), 누가, 누구의 정보로, 무엇을 했는지 남기는 법정 기록이다(개인정보의 안전성 확보조치 기준 고시 제2조 제3호, 제8조).
- **해시 체인**: 앞 기록의 지문(해시)을 다음 기록에 넣어, 중간 기록을 몰래 고치면 지문이 맞지 않아 드러나게 하는 저장 방식이다.
- **`x-forwarded-for`**: 입구(게이트웨이)가 원래 손님의 IP를 적어 서비스로 넘기는 요청 머리다. 입구가 다시 쓰지 않으면 손님이 마음대로 꾸밀 수 있다.
- **상수 시간 비교**: 두 비밀 값을 비교할 때 어디서 틀렸든 걸리는 시간이 같게 해서, 응답 시간으로 비밀을 한 글자씩 알아내지 못하게 하는 비교다.
- **최소 권한**: DB 역할에 코드가 실제로 쓰는 표·칸·동작만 주는 것이다.
- **보류(held_event)**: Kafka 소비자가 같은 실패를 되풀이한 사건을 따로 옮겨 두는 표다.

## 요약

| 번호 | 심각도 | ASVS 항목 | 한 줄 | 고칠 쪽 | 확인 필요 |
| --- | --- | --- | --- | --- | --- |
| S1 | 중간 | v5.0.0-16.4.2, v5.0.0-16.2.1 | 파트너 명단 접속기록은 위·변조를 찾아낼 장치와 월 점검이 없는데 ASVS 행은 '적용'으로 읽힌다 | plan | 예 |
| S2 | 중간 | v5.0.0-14.2.7 | 탈퇴 뒤 후기 본문·별점·사진은 남는데(정본은 파기) ASVS 행은 '적용' | plan | 예 |
| S3 | 낮음 | v5.0.0-15.3.4, v5.0.0-16.2.1 | 접속지를 못 정하면 막는 검사가 운영에서는 거의 걸리지 않고 입구 파드 주소로 조용히 대신한다 | plan | 예 |
| S4 | 낮음 | v5.0.0-2.2.1 | 받은 커서를 길이·모양 검사 없이 2년 접속기록에 남긴다 | plan → impl | 예 |
| S5 | 낮음 | v5.0.0-11.2.4 | 내부 토큰 비교가 길이가 다르면 바로 끝나 토큰 길이가 시간으로 새고, 정본·시험이 그것을 규칙으로 굳혔다 | impl 또는 plan | 아니오 |
| S6 | 낮음 | v5.0.0-13.2.2, v5.0.0-16.4.2 | 0022가 팬 경로와 같은 역할에 후기 작성자 바꾸기와 법정 조치 증적의 해제 시각 덮어쓰기를 준다 | plan | 예 |
| S7 | 낮음 | v5.0.0-14.2.7 | core에 보류된 탈퇴 사건은 다시 처리할 길도 지울 기한도 없다 | plan | 예 |
| S8 | 낮음 | v5.0.0-1.2.10 | CSV 첫 글자 정화에 널 문자가 빠졌고 ASVS 행이 말하는 공용 함수가 아니다(바뀐 부분 밖) | test → impl | 아니오 |
| S9 | 낮음 | v5.0.0-8.2.2, v5.0.0-8.4.1 | 명단 원천 내부 경로가 파트너를 받지 않아 회차 소유 대조가 core 한 곳뿐이다(바뀐 부분 밖) | plan | 아니오 |

높음 0, 중간 2, 낮음 7.

## 지적

### S1. 파트너 명단 접속기록의 위·변조 방지와 월 점검이 비어 있는데 ASVS 행은 다 된 것처럼 읽힌다

- 심각도: 중간
- ASVS 항목: v5.0.0-16.4.2(로그를 권한 없는 수정에서 보호), v5.0.0-16.2.1(언제·어디서·누가·무엇을)
- 파일:줄: `services/core-svc/migrations/0019_attendee_export_audit.sql:21-27`, `services/core-svc/migrations/0021_attendee_access_audit_list.sql:1-13`, `docs/security/asvs/settlement.md:225`(16.2.1), `docs/security/asvs/settlement.md:235`(16.4.2), `docs/security/data-classification.md:104`
- 틀린 점: 명단 보기·내려받기 접속기록은 core 논리 DB의 보통 표 `attendee_export_audit`다. 앱 역할 `core_partner`에 고치기·지우기 권한이 없는 것은 맞다(0019 21줄). 그러나 표 주인(마이그레이션 역할)과 DB 관리자는 행을 고치거나 지울 수 있고, 고친 것을 찾아낼 장치(해시 체인)가 없다. 매일·매월 이상 점검(FR-064)도 이 표를 읽지 않는다. 그런데 16.4.2 행은 "감사 로그는 바꿀 수 없게 저장한다(공통)"로 '적용'이고, 이번에 고친 16.2.1 행 비고는 "(2년, 고치기·지우기 권한 없음)"이라 적어 법정 보호가 끝난 것처럼 읽힌다.
- 근거: 고시 제8조는 접속기록의 월 1회 이상 점검과 위·변조·도난·분실 방지 조치를 요구한다. 정본 `data-classification.md:104` '관리자 시스템 접속기록' 행의 보호 방법은 "변조를 찾아내는(키를 건 해시 체인·앵커) 이벤트 소싱 불변 감사 저장소"이고, 같은 행이 이번에 "그 저장소로 옮기기 전까지 core 논리 DB에 남긴다"로 예외를 스스로 적었다. 계획 §5 OPEN 후보 2도 같은 빈칸(해시 체인, FR-064 점검이 읽는 곳)을 소유자 결정으로 남겼다. 코드가 틀린 것이 아니라, 결정이 나기 전까지 ASVS 표가 예외를 숨긴다.
- 고칠 쪽: plan. 소유자 결정 전까지 `asvs/settlement.md`의 16.4.2·16.2.1 행 비고에 "core `attendee_export_audit`는 예외: 앱 역할만 못 고치고 해시 체인·FR-064 점검은 없다(W7-audit OPEN 후보 2)"를 적는다. 상태 값을 바꿀지는 ASVS 표 규칙대로 정한다.
- 확인 필요: 예(OPEN 후보 2의 소유자 결정. 저장소를 옮기지 않는다면 월 점검을 어디서 할지도).

### S2. 탈퇴한 회원의 후기 본문·별점·사진이 남는데 14.2.7 행은 '적용'이다

- 심각도: 중간
- ASVS 항목: v5.0.0-14.2.7(쓸모없어진 민감 정보를 정한 상황에 자동으로 지움)
- 파일:줄: `docs/security/asvs/catalog-review.md:193`, `services/core-svc/src/modules/review/inbound/account-withdrawn.handler.ts:75-78`, `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:254-259`(R-617 코드, 이번 묶음이 사건에 이었다)
- 틀린 점: 탈퇴 사건 소비자가 부르는 `anonymizeByAccount`는 `account_id`·`basis_order_id`·`author_display`·`updated_at`만 바꾸고 본문·별점·사진 키·내용 지문(`content_fingerprint`)은 그대로 둔다. 14.2.7 행은 이번 고침으로 "회원이 탈퇴하면 … 계정·주문 참조를 바로 끊는다"를 더했고 상태는 '적용' 그대로다.
- 근거: 정본 `docs/data.md:2903`(§6 '관람 후기')과 `docs/security/data-classification.md:82`('관람 후기')는 회원 탈퇴 때 파기(행은 DELETED, 본문·별점·사진 키·계정 ID를 바로 비움)다. 후기 본문에는 작성자나 다른 사람의 개인정보가 섞여 들 수 있다. 계획 §5 OPEN 후보 1이 같은 어긋남을 적고 결정 전까지 배선만 하기로 했다. 그 판단은 맞지만, ASVS 행은 남는 부분을 적지 않아 다 된 것처럼 읽힌다.
- 고칠 쪽: plan. 결정 전까지 14.2.7 행 비고에 "탈퇴 때 본문·별점·사진은 아직 남는다(W7-audit OPEN 후보 1)"를 적는다. 파기 쪽으로 정해지면 그때 test → impl.
- 확인 필요: 예(OPEN 후보 1의 소유자 결정).

### S3. 접속지를 정하지 못하면 막는 검사가 운영에서는 거의 걸리지 않는다

- 심각도: 낮음
- ASVS 항목: v5.0.0-15.3.4(원래 IP를 사용자가 조작할 수 없는 신뢰 필드로 넘김), v5.0.0-16.2.1('어디서')
- 파일:줄: `services/core-svc/src/modules/export/inbound/client-ip.ts:9-12`, `services/core-svc/src/modules/export/application/attendee-exports.ts:57-62`
- 틀린 점: `clientIpOf`는 `x-forwarded-for`가 없거나 IP 하나가 아니면(쉼표 목록 포함) 연결 상대 주소 `socket.remoteAddress`를 쓴다. 운영에서 연결 상대는 늘 입구(게이트웨이) 파드라 값이 언제나 IP 모양이다. 그래서 `requireActor`의 "접속지를 정하지 못하면 원천을 읽지 않고 실패"는 운영에서 사실상 걸리지 않는다. 입구가 머리를 다시 쓰지 않는 길(배포 설정 실수, 앞단 프록시가 붙인 쉼표 목록)이 생기면 법정 항목 '접속지'가 입구 파드 주소로 조용히 쌓이고, 경고·지표도 없다.
- 근거: 꾸밀 수 있는지는 입구에 달렸다. `docs/infra.md:285`(입구 규칙 2)는 입구가 `x-forwarded-for`를 클라이언트 IP 하나로 다시 쓴다고 정했으니, 그 규칙이 지켜지면 손님이 꾸밀 수 없다. 다만 그 규칙의 클라이언트 IP 정하기(`docs/infra.md:288`, 앞단 프록시 수 기본 0)는 v0 입구 규칙이라, 앞에 CDN·부하 분산기가 있는 운영에서 값이 맞는지는 배포 설정을 봐야 한다. 정본 settlement.md §9 '접속지'가 identity 관리 계정 로그인과 같은 규칙을 따르기로 했으므로(계획 R2 보충) 같은 한계가 identity에도 있다.
- 고칠 쪽: plan. local·ci 밖에서는 머리가 없거나 IP 하나가 아니면 실패로 볼지, 아니면 연결 주소로 대신한 횟수를 지표·경고로 남길지를 identity와 함께 정한다. 정하면 test → impl.
- 확인 필요: 예(운영 입구 `gw-partner`가 `x-forwarded-for`를 실제 손님 IP 하나로 다시 쓰는지, 배포 설정에서).

### S4. 받은 커서를 길이·모양 검사 없이 2년 접속기록에 남긴다

- 심각도: 낮음
- ASVS 항목: v5.0.0-2.2.1(입력을 기대한 모양으로 검증)
- 파일:줄: `services/core-svc/src/modules/export/application/attendee-exports.ts:108`, `packages/contracts/src/gen/openapi/partner.ts:3648`, `docs/data.md:2431`
- 틀린 점: 명단 보기의 `cursor`는 계약이 `zod.string().optional()`이라 길이 상한과 글자 모양 검사가 없다. 받은 값은 그대로 `filter.cursor`로 2년 보존 접속기록에 들어간다. 정본 `data.md:2431`은 "`filter`에 개인정보 원문은 넣지 않는다"인데, 이를 지키는 것은 원천(purchase-svc)이 이상한 커서를 거절해 기록 전에 실패하는지에 달려 있다(원천 읽기가 기록보다 먼저다, 96·100줄).
- 근거: 접속기록은 법정 증거라 남는 값의 모양이 정해져 있어야 점검 도구가 믿고 읽는다. 커서는 불투명 값이지만 길이 상한과 base64url 글자 모양은 계약에 적을 수 있다(`docs/api/guidelines.md` §3).
- 고칠 쪽: plan(openapi의 `cursor`에 길이 상한·글자 모양을 적는다) → impl(계약 생성물 다시 만들기).
- 확인 필요: 예(purchase-svc `GET /internal/v1/events/{eventId}/attendees`가 모양이 틀린 커서를 400으로 거절하는지).

### S5. 내부 토큰 비교가 길이가 다르면 바로 끝나고, 정본과 시험이 그것을 규칙으로 굳혔다

- 심각도: 낮음
- ASVS 항목: v5.0.0-11.2.4(비교에서 조기 종료하지 않음)
- 파일:줄: `packages/platform/src/auth.ts:89-94`(92줄 `if (left.length !== right.length) return false;`), `docs/security/asvs/settlement.md:246`, `docs/architecture.md` §3.2 'REST' 행, `packages/platform/test/internal-token-constant-time.test.ts:36-39`, `services/core-svc/test/internal-sale-config-token-boot.test.ts:142-143`
- 틀린 점: 11.2.4 원문은 "비교·계산·반환에서 조기 종료하지 않아 정보가 새지 않게"인데 `sameSecret`은 길이가 다르면 비교 없이 곧바로 거절한다. 응답 시간으로 토큰 길이를 알 수 있다. 이번 묶음은 이 동작을 정본(architecture.md §3.2, 11.2.4 행 "길이가 다르면 비교 없이 거절")에 규칙으로 적었고, 시험 SEC-06R ④⑤는 "길이가 다르면 `timingSafeEqual` 호출 0"을 단언한다. 그래서 더 나은 구현(양쪽을 같은 길이로 바꿔 늘 비교)으로 고치면 시험이 깨진다.
- 근거: 공유 토큰이 고정 길이 무작위 값이면 길이는 사실상 비밀이 아니어서 실제 위험은 작다. 그 전제가 정본에 없다. 운영 무토큰 시작 거절(`onModuleInit`), 401 계약, 상수 시간 비교 사용 자체는 코드와 시험이 맞다(본 범위 참고).
- 고칠 쪽: impl(양쪽을 SHA-256 같은 같은 길이 지문으로 바꾼 뒤 늘 `timingSafeEqual`로 비교하고, 시험 ④⑤의 '호출 0' 단언을 '늘 한 번'으로 바꾼다) 또는 plan(토큰은 고정 길이 무작위 값이라 길이가 비밀이 아니라는 전제를 11.2.4 행에 예외로 적는다).
- 확인 필요: 아니오.

### S6. 0022가 팬 경로와 같은 역할에 후기 작성자 바꾸기와 법정 조치 증적의 해제 시각 덮어쓰기를 준다

- 심각도: 낮음
- ASVS 항목: v5.0.0-13.2.2(구성요소 사이 통신에 최소 권한 계정), v5.0.0-16.4.2(조치 기록을 수정에서 보호)
- 파일:줄: `services/core-svc/migrations/0022_review_role_grants.sql:7`, `:13`, `:24`, `services/core-svc/src/modules/review/adapters/db/drizzle-review-store.ts:272`·`:311`, `docs/security/asvs/catalog-review.md:178`
- 틀린 점: 칸 목록 자체는 계획 §4의 0022 표와 같고, `review`·`content_report`·`takedown_action`의 행 지우기와 `review.id`·`event_id`·`created_at` 고치기는 막혀 있다(맞음). 남는 것은 둘이다. (가) `review.account_id`·`basis_order_id` 고치기는 탈퇴 익명화에만 필요한데, 팬 화면 요청을 받는 같은 `core_app` 연결에 준다. 팬 경로의 결함(잘못된 조건의 UPDATE 등)이 남의 후기 작성자를 바꿀 수 있다. (나) `takedown_action.restored_at`은 코드가 `restored_at is null`일 때만 한 번 쓰지만(272·311줄), DB 권한은 이미 채운 해제 시각도 다시 덮어쓰게 한다(`core_app` 13줄, `core_maintenance` 24줄). 법정 차단 조치 증적의 해제 시각을 DB가 지키지 않는다.
- 근거: ADR-0241 결정 4는 '코드가 쓰는 만큼만'이고, 칸 단위로는 지켰다. 하지만 catalog-review 16.4.2 행은 "통보 차단·신고 처리 조치 감사 로그는 바꿀 수 없게 저장한다"이다.
- 고칠 쪽: plan. `restored_at`을 한 번만 쓰게 DB에서 강제할지(트리거 등), 익명화를 따로 역할이나 함수로 뺄지 정한다. 이번 묶음을 막을 정도는 아니다.
- 확인 필요: 예(`takedown_action`이 16.4.2의 '바꿀 수 없게 저장하는 조치 감사 로그'에 드는지, 아니면 ops 해시 체인 감사 기록만 그런지).

### S7. core에 보류된 탈퇴 사건은 다시 처리할 길도 지울 기한도 없다

- 심각도: 낮음
- ASVS 항목: v5.0.0-14.2.7
- 파일:줄: `services/core-svc/src/consumers/index.ts:60-67`, `services/core-svc/migrations/0022_review_role_grants.sql:19`·`:27`, `docs/security/data-classification.md:114`
- 틀린 점: 같은 실패를 5번 되풀이한 탈퇴 사건은 `held_event`로 가고 같은 계정의 뒤 사건도 보류된다(`packages/platform/src/keyed-consumer.ts:4`). core에는 다시 처리(RB-11)가 없고(계획 §4 범위 밖), 정비 일 `held-events-delete`는 다시 처리한 행만 지운다. 그래서 (가) 한 번 보류되면 그 계정 후기의 계정 참조가 누가 손으로 내부 익명화 경로를 부르기 전까지 남는다. 소비자가 없으면 운영이 뜨지 않게 한 '법정 파기 의무를 조용히 놓치지 않는다'(index.ts 21줄)는 목표가 보류 쪽에서 다시 열린다. (나) pid를 뺀 보류 행(계정 ID·탈퇴 시각)은 기한 없이 남는다. `data-classification.md:114`에는 queue-svc 보류의 기한(탈퇴 + 5일)만 있고 core 보류의 기한은 없다.
- 근거: pid를 빼는 것 자체는 맞게 했다(본 범위 참고). 빈 곳은 보류 뒤의 처리 기한과 경보다.
- 고칠 쪽: plan. core 보류 탈퇴 사건의 처리 기한, 경보, 손으로 다시 하는 절차(내부 경로 부르기)를 정본에 적는다.
- 확인 필요: 예(core-svc 보류 수 지표에 경보가 걸리는지).

### S8. CSV 첫 글자 정화에 널 문자가 빠졌고, ASVS 행이 말하는 공용 함수가 아니다

- 심각도: 낮음
- ASVS 항목: v5.0.0-1.2.10(CSV·수식 삽입 막기)
- 파일:줄: `services/core-svc/src/modules/export/domain/export.ts:99`, `docs/security/asvs/settlement.md:249`
- 틀린 점: core 예매자 명단의 `safeCell`은 `/^[=+\-@\t\r]/`라 널 문자로 시작하는 칸에 작은따옴표를 붙이지 않는다. 1.2.10 행은 "예매자 명단 내려받기(J-T26)는 공용 내보내기 함수 하나로 만든다", "ASVS 원문의 널 문자면 작은따옴표를 붙인다"로 '적용'인데, core는 자기 복사본을 쓰고 널 문자를 빠뜨렸다. 이번 바뀐 부분 밖(R-588·R-606 코드)이지만 이 묶음이 고친 파일이고 지시서가 CSV 수식을 보라고 했다.
- 근거: 예매자 이름은 팬이 넣은 값이라 첫 글자를 꾸밀 수 있다. 큰따옴표 감싸기와 `=`·`+`·`-`·`@`·탭·CR 정화는 맞다.
- 고칠 쪽: test(널 문자로 시작하는 이름이 `'`로 시작하는 칸이 되는 시험) → impl(정규식에 `\0` 추가, 또는 공용 함수로 바꾸기).
- 확인 필요: 아니오.

### S9. 명단 원천 내부 경로가 파트너를 받지 않아 회차 소유 대조가 core 한 곳뿐이다

- 심각도: 낮음
- ASVS 항목: v5.0.0-8.2.2(데이터 항목마다 권한), v5.0.0-8.4.1(테넌트 사이 통제)
- 파일:줄: `services/core-svc/src/modules/export/adapters/http-attendee-source.ts:51`·`:66-67`, `services/core-svc/src/modules/export/application/attendee-exports.ts:92`·`:135`
- 틀린 점: core는 `events.find(promoterId, eventId)`로 회차가 그 파트너 것인지 본 뒤(92·135줄) purchase-svc를 회차 ID만으로 부르고 `promoterId`는 버린다(51줄). 내부 토큰을 가진 호출자는 어느 회차 명단이든 읽는다. 지금 부르는 곳은 모두 소유 확인 뒤라 바로 새는 길은 없고, 겹 방어가 하나뿐이라는 뜻이다. 또 `count()`는 합계만 쓰려고 이름·휴대폰이 든 한 행(`limit` 1)을 받아 버린다(66-67줄). 이번 바뀐 부분 밖(A2-03)이다.
- 근거: 명단은 이 서비스에서 가장 민감한 개인정보 묶음이다.
- 고칠 쪽: plan(후속 묶음. 원천에 파트너 ID를 넘겨 purchase-svc도 대조하게 하고, 합계만 주는 길을 둔다).
- 확인 필요: 아니오.

## 본 범위

읽은 것:

- 지시서 `brief-W7-audit.md`, 계획 `## 계획` 절(§0~§6, R2 보충·R3 포함).
- 코드(`3087ad85`): `export/inbound/client-ip.ts`, `export/inbound/partner-attendee-export.controller.ts`, `export/application/attendee-exports.ts`, `export/adapters/http-attendee-source.ts`, `export/adapters/db/drizzle-export-store.ts`, `export/adapters/memory-export-store.ts`, `export/adapters/db/schema.ts`·`export.module.ts`(바뀐 부분), `export/domain/export.ts`(`safeCell`·`csvFile`·`xlsxFile` 줄), 마이그레이션 0004(권한 줄)·0019·0021·0022, `review/inbound/account-withdrawn.handler.ts`, `consumers/index.ts`, `consumers/start.ts`, `main.ts`(바뀐 부분), `review/adapters/db/drizzle-review-store.ts`(익명화·조치 해제 줄), `packages/platform/src/auth.ts`(내부 토큰 가드), `packages/platform/src/log.ts`(가림 키·오류 직렬화), `packages/platform/src/stream-worker.ts`·`keyed-consumer.ts`(로그·보류 규칙 줄), identity `account-withdrawn-message.ts`, `internal-sale-config.controller.ts`(401 가드).
- 시험: `packages/platform/test/internal-token-constant-time.test.ts`, `services/core-svc/test/internal-sale-config-token-boot.test.ts`(단언 줄).
- 정본: 바뀐 줄 전부(`docs/security/asvs/settlement.md`·`catalog-review.md`·`data-classification.md`·`internal-management-plan.md`, `docs/features/settlement.md`·`identity.md`, `docs/data.md`, `docs/streaming.md`, `docs/architecture.md` §3.2 'REST' 행), 그리고 `asvs/settlement.md`의 1.2.10·1.3.3·4.1.3·8.2.x·8.4.1·14.2.x·15.3.4·16.2.1·16.3.x·16.4.x 행, `asvs/catalog-review.md`의 8.2.x·16.2.1·16.4.2·14.2.7 행, `data-classification.md`의 '관람 후기'·'관리자 시스템 접속기록'·'탈퇴 사건의 pid 사본' 행, `data.md:2903`, `docs/infra.md:285`·`:288`.

보고 지적하지 않은 것(맞다고 본 것):

- 권한: 명단 보기·내려받기·이력은 모두 `@Roles(['partner_admin'])`이고, 테넌트는 `tenantOf(me)`(로그인 주체)에서만 정한다. 다른 파트너 회차는 원천을 읽기 전에 404, 보유 기간 끝은 410이고 접속기록이 남지 않는다. 행위자가 없거나 계정 ID·역할이 비면 원천을 읽기 전에 거절한다(`attendee-exports.ts:57-62`). 내려받기는 재인증 토큰의 계정이 행위자와 같아야 한다(134줄).
- 접속기록 법정 항목: 계정(`actor_account_id`)·일시(`created_at`)·접속지(`source_ip`, inet)·정보주체를 다시 만들 조건(회차·`filter`·건수)·수행업무(`action`·사유)가 LIST·DOWNLOAD 둘 다에 있다. 기록을 남기지 못하면 명단·파일을 주지 않는다(fail-closed, 100·161줄). 내려받기 이력과 DOWNLOAD 기록은 한 트랜잭션이고 `core_partner`의 RLS(`app.tenant_id`) 아래에서 쓴다. 0021의 CHECK 셋(`action`, 모양, `source_ip IS NOT NULL NOT VALID`)은 새 행에 강제된다. 보존 끝은 달력 2년이고 지우는 작업이 없다.
- 접속지 가림: 접속지는 이력 행·이력 응답·`exportView`에 없고, 서비스 로그는 `clientIp`·`accountId`·`ip` 키를 가린다(`log.ts:40`). 오류는 이름·메시지·스택만 로그에 남아(`log.ts:129`) PostgreSQL 오류의 `detail`(실패한 행 값)이 새지 않는다. 접속지·행위자 검사 오류 글에 값을 싣지 않는다.
- 탈퇴 사건의 pid: 처리기는 계약 Zod에서 `eventKey`·`accountId`·`withdrawnAt`만 골라 쓰고 해독 실패의 원래 오류(값 조각)를 버린다. 보류 감싸기는 `hold`·`holdIfHeld` 둘 다에서 값을 세 칸 JSON으로 바꾸거나 null로 둔다. Kafka 키는 계정 ID라 pid가 아니다(identity `account-withdrawn-message.ts`). `eventKey`는 UUID라 로그의 `eventKey`가 계정 ID를 담지 않는다. 플랫폼 소비자 로그는 키·값을 싣지 않는다.
- 운영 시작 차단: `kafkaConsumersFromEnv`는 local·ci 밖에서 브로커가 없거나 빈칸이면 시작을 막고, 틀린 조각은 값 없이 순번만 알린다. `main.ts`는 `createService` 전에 읽는다.
- 내부 토큰 가드: `InternalToken401Guard`는 공용 가드를 상속해 `onModuleInit`(운영 무토큰 시작 거절)과 `sameSecret`(같은 길이면 `timingSafeEqual`)을 그대로 쓰고, 실패를 401로 바꾼다. 시험 SEC-06R ①은 prod·staging에서 토큰 없음·빈 값이 가드의 시작 차단 때문에 실패함을 보고(같은 환경 값으로 ③은 시작한다), ④⑤는 엿보기로 비교 함수 호출을 센다. 계획의 틀린 구현 표본 넷(빈 `onModuleInit`, `===` 비교, 하위 가드 직접 비교, `INTERNAL_TOKEN_REQUIRED` 빼기)은 이 시험들이 잡는 모양이다. 길이 문제는 S5.
- DB 최소 권한(0022): `review`·`content_report`·`takedown_action`에 DELETE·TRUNCATE·칸 없는 UPDATE가 없고, `review`의 `id`·`event_id`·`created_at` 고치기가 없다. `held_event`의 `core_app` 권한은 SELECT·INSERT뿐이다. 0004의 기본 권한은 SELECT뿐이라 0022가 넓히는 것은 위 칸만이다. 남는 폭은 S6.
- SQL 주입: 새 저장 코드는 Drizzle 값 넣기이고, 익명화 SQL은 매개변수(`${accountId}::uuid`)다. 원천 호출은 경로·쿼리 매개변수로 넘긴다.
- 파일 주입: CSV는 칸마다 큰따옴표로 감싸고 안의 큰따옴표를 두 번 쓴다. 파일 이름은 위험한 글자를 바꾸고 `content-disposition`에서 퍼센트 인코딩한다. XLSX는 인라인 문자열 칸이라 수식으로 읽히지 않는다. 남는 것은 S8.
- ASVS 상태: 16.2.1('어디서' 포함)·11.2.4(상수 시간 비교 사용)·14.2.7(소비자 배선)은 코드와 맞는 부분이 있고, 맞지 않는 부분은 S1·S2·S5·S8에 적었다.

보지 않은 것:

- 시험·통합 시험을 돌리지 않았다(리뷰는 읽기만). 작업 트리는 검증 담당이 바꾸는 중이라 보지 않았다.
- 운영 입구(`gw-partner`)의 `x-forwarded-for` 설정, NetworkPolicy, MSK 권한, 경보 규칙은 배포 설정을 보지 않았다(S3·S7의 확인 필요).
- purchase-svc의 명단 원천 쪽 코드(커서 검사, SOLD 거르기)는 보지 않았다(S4의 확인 필요).
- 계획의 `## 계획` 밖 절(실패 확인·시험 이의·리뷰·검증)은 지시대로 읽지 않았다.
- 다른 core 모듈의 운영 역할 권한 전수, 내부 익명화 경로가 게이트웨이 경로 목록에 없는지는 보지 않았다.
