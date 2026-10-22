# 데이터 설계

- **독자와 용도**: 백엔드 개발자가 도메인 엔티티, 소유 서비스, 트랜잭션 경계, 동시성 제어 지점, 암호화 정책 및 데이터 보존 기간을 파악할 때 참조하는 기준 문서이다. 실제 물리 스키마의 원본은 각 서비스의 마이그레이션 파일(Drizzle, ADR-0037)에 존재하며, 본 문서는 데이터 아키텍처의 구조와 설계 결정 맥락을 명문화한다.
- **원문 출처**: 설계서 §6(Redis 구성, 좌석 일관성 매트릭스, 결제, 굿즈, 오프라인 입장, 개인정보), §8(PostgreSQL·Kafka·ClickHouse 데이터 파이프라인), 21장(인덱스·잠금·파티셔닝 전략), 25장, docs/security/data-classification.md, docs/security/secrets-and-keys.md, ADR-0002·0013·0014·0028.
- **기준 기획 버전**: v1.0.
- **표시 규칙**: ERD의 엔티티 및 필드 명칭은 원문에 흩어져 있던 표현을 용어 사전의 표준 영문 표기로 일원화한 [보완]이다. 필드 세부 명세는 [가정]이 포함되어 있으므로 실제 서비스 마이그레이션 구현 시점에 최종 확정한다.

## 1. 저장소 지도

| 저장소 | 담는 것 | 소유 | 결정 |
| --- | --- | --- | --- |
| Redis 대기열 클러스터 | 순번 카운터, 1인 1순번 중복 확인 키(pid, 그 대기가 끝날 때나 그 회차의 판매 종료(공연 시작 24시간 전) 때 파기, ADR-0063·ADR-0064), 로비 참가자 목록(참가 토큰 해시, `q:{event:E}:lobby_members`), 셔플 결과(해시 → 순번 매핑), 동시 도착 묶음 수합(`q:{event:E}:batch_members:{batchNo}`), 도착 시각 쿠키 요청 ID(`q:arr:{reqId}:E`, 10분 [가정]), 빠진 번호 비트맵, 입장 자리(Sorted Set), 실시간 입장 인원 카운터, 추가 검증 격리 기록(`q:{event:E}:verify`), 판매 자격 명단 사본(`q:{event:E}:elig:{listKey}`, 판매 기간 끝 + 1일 파기, ADR-0062) | queue-svc, admission-ctrl (동일 장애 격리 컨텍스트) | 대기열 트래픽 폭주가 좌석 예매 등 타 핵심 기능의 응답 지연으로 전파되지 않도록 물리 인스턴스를 격리한다. 회차 해시 태그(`{event:E}`)는 회차 단위 키(같은 Lua에서 함께 쓰는 순번 카운터·serving·리더 상태·빠진 번호 등)에 붙여 한 샤드에 두고, 사람·토큰 단위 키(`q:dup`·`q:adm`·`q:lobby:{hash}`·`q:arr`)에는 붙이지 않아 샤드 전역에 고르게 흩는다(§3). |
| Redis 좌석 클러스터 | 좌석 상태 비트맵, 홀드 세부 정보(Hash), 펜싱 토큰, 홀드 만료 인덱스(Sorted Set), 사용자별 예매 보유 수, 홀드 요청 멱등키, 입장 토큰 jti 거부 목록, 구매 세션(클라이언트 임시 ECDH 공개키와 마지막 요청 일련번호 포함), 홀드·세션 이벤트 Stream, 좌석 델타 브로드캐스트 채널(샤드 Pub/Sub) | purchase-svc (단독 쓰기), realtime-gw (델타 채널 수신 구독 전용) | 좌석 예매 트랜잭션 장애가 대기열로 확산되지 않도록 독립 클러스터로 분리한다. `{event:id}` 해시 태그를 적용하여 단일 공연의 비트맵, 홀드 정보, 쿼터 카운터를 동일 샤드에 배치함으로써 Lua 스크립트 원자성을 보장한다. |
| Redis 세션·캐시 클러스터 | identity 사용자 세션, 전역 레이트 리밋 카운터(rate-limit-svc 전용), catalog 읽기 모델 캐시, shop 굿즈 재고 차감 카운터, trust-svc 실시간 행동 피처, ops-svc Socket.IO 어댑터 상태, core-svc BullMQ 큐, 스캐너 로그인 기기 승인 코드(identity), 스캐너 기기 등록 코드(대안 B, 코드의 SHA-256만, ADR-0062) | 복수 서비스 공유 | 네임스페이스 키 접두사와 Redis ACL 기반 사용자 격리를 적용한다. 타 컨텍스트에 속한 키는 인가 없이 교차 읽기 및 쓰기를 엄격히 금지한다. |
| Aurora PostgreSQL (purchase) | 주문, 결제 시도(결제사·결제창 참조), 주문 이벤트 소싱 스토어, 좌석 판매 행(PENDING/SOLD/RETURNED), 1인 예매 한도 원장, 홀드 감사 원장, 예매 취소 및 환불 기록, 회차 취소 요청과 일괄 환불 작업 진행, 배상 지급 기록, Outbox 테이블 | purchase-svc | 주문 생성, 좌석 확정(Hard Sale), 쿼터 차감을 단일 ACID 트랜잭션으로 원자 처리한다. 샤딩을 배제하고 단일 대형 인스턴스 스케일업과 수평 읽기 복제로 대응한다(ADR-0028). |
| Aurora PostgreSQL (payment) | PG사별 결제 원장(가상계좌 입금 기한·번호는 입금 확정·만료 때 삭제, ADR-0062), 결제 취소 원장, 결제 상태 전이 이벤트, 웹훅 수신 멱등 기록, 결제사 정산 대사 결과, 정산서·지급 묶음·지급 건·미수금(ADR-0047), Outbox 테이블 | payment-svc | 결제 비밀 키 및 외부 결제 대행사(PG) 통신 장애 영향을 타 도메인으로부터 물리 격리한다. |
| Aurora PostgreSQL (ticket, 교차 리전 읽기 복제본 포함) | 티켓 발행 원장(결제자·보유자), 기기 바인딩 공개키 및 폐기 목록, 양도 요청과 소유권 양도 이력, 게이트 스캔 이벤트 로그, 스캐너 기기 등록·배치, 회차별 변경 일련번호 기록, 이상 표시, 부스 재발급 허용(ADR-0051) | ticket-svc | 공연 당일 현장 입장 가용성을 극대화하기 위해 재해 복구용 교차 리전 읽기 복제본(Aurora Global Database의 도쿄 보조 클러스터, 읽기 인스턴스 1대. 관리형 전환으로 쓰기를 옮기지 않는다, 추천 적용 2026-10-22, ADR-0083)을 상시 동기화한다. 티켓 양도와 상태 변경은 행 잠금과 낙관적 락 버전 컬럼을 병용하여 이중 처리를 막는다. |
| Aurora PostgreSQL (공유 클러스터: identity·ops·core 개별 논리 DB 및 역할) | 계정, 세션 참조, 법적 동의, 관리자 계정, 현장 스태프 권한 배정, 스캐너 세션; 운영 명령 감사 로그, 이벤트 스토어, 법적 요청 대장, 승인 업무, CS 처리함 건(고객 문의·게시물 신고 건 포함, ADR-0066), 예매 제한과 소명, 결정 기록·가명정보 처리 기록(ADR-0052), 수요 예측(`demand_forecast`, ADR-0078); 판매자 신원정보, 판매 승인 상태, 공연예술통합전산망 전송 기록, 공연·공연장·좌석 배치(공연장 캔버스·무대·구역 도형과 좌석 좌표)·좌석맵 템플릿 10종(`venue` TEMPLATE 행, 배포 때 넣음, ADR-0066)·가격 티어·판매 정책, 판매 자격 명단(판매 기간 끝 + 1일 파기, ADR-0062), 굿즈 주문 및 재고 확정, 관람 후기(`review`)와 후기 사진 기록(`review_image`, 파생본 키만)·게시물 신고(`content_report`), 고객 문의(`inquiry`·`inquiry_message`, support 모듈, ADR-0066), 홈 구성(배너·테마, ADR-0063), 알림 구독 및 웹훅, 알림 발송 기록(`notification_delivery`, 90일 [가정], ADR-0062) | identity-svc, ops-svc, core-svc | 운영 비용 효율화를 위해 물리 클러스터를 공유하되, 서비스별 독립 논리 데이터베이스 및 전용 DB 계정을 분리한다. 논리 DB 간 교차 참조 및 외래키 조인은 엄격히 금지한다. |
| MongoDB | 상품 카탈로그 정의(굿즈, 주차권, VIP 패키지, 패스트트랙 등 비정형 티켓 연동 부가 상품 문서, 유형별 `$jsonSchema` 제약) | core-svc (shop) | 상품 유형별 유연한 스키마 확장과 속성 검색을 지원한다(ADR-0013). |
| ClickHouse | 대규모 분석 전용 저장소(분석 저장소, ADR-0042·0052): 브론즈(이벤트·스냅샷 원본, 가명 처리만, 적재 뒤 90일), 실버(중복 제거·정리된 가명 사건과 구매 세션 누적 스냅샷, 90일), 골드(스타 스키마 집계·지표 뷰, 사람 단위 행 없음, 2년), 실시간 표 `rt`(Flink `ops-rt`의 누적 덮어쓰기와 1초 칸, 관제·파트너 판매 현황의 잠정 숫자, 90일, docs/streaming.md §4.3), trust-svc 원시 탐지 신호(TTL 30일, 적재는 Flink `trust-reassess`), 접속기록 저장소(별도 논리 DB, 보존 3개월. 원문 미기재 저장소를 ClickHouse 독립 DB로 확정, 추천 적용 2026-10-09) | peaket-data(적재 잡·마감 실행기), ops-svc(골드 지표 뷰·rt 읽기), trust-svc, identity 및 API 게이트웨이 로그 파이프라인 | 런타임 하트비트 부하를 제거하고 비동기 마이크로 배치 일괄 삽입 방식으로 처리한다. 잠정 숫자(rt)와 확정 숫자(골드)는 다른 표에 두고, 확정 숫자의 중복 제거는 dbt SQL로 한다(docs/features/analytics.md §2·§5.5). |
| Kafka | 핵심 거래 이벤트, 분산 텔레메트리, 실시간 제어 명령 토픽 | 발행 서비스별 독립 파티셔닝 | 도메인별 토픽 분리와 전송 신뢰성 레벨(at-least-once)을 차등 적용한다(ADR-0026). 거래·제어 클러스터와 텔레메트리 클러스터는 물리적으로 다른 MSK 클러스터 둘이다(ADR-0026 결정 2, docs/infra.md §1). |
| S3 (Apache Iceberg) | 개인을 식별할 수 없는 집계 지표(원시 행동 신호 표본은 두지 않음, ADR-0004 상태 줄), 동결된 회차 골드의 영구 아카이브(ADR-0042·0052), 분석 수집 버킷(기준 자료·운영 기록 코드·비용 파일, 개인정보 없음)과 공연 리포트 파일 버킷, Flink 분산 체크포인트, 정기 백업 스냅샷 | 데이터 엔지니어링 팀 | 분석 레이크와 리포트 버킷에는 원시 개인정보 저장을 금지하며, 장기 분석 및 감사 추적을 위한 데이터 레이크로 운용한다. 저장소 백업은 별도 백업 버킷(SSE-KMS, 백업 역할만 읽음)에 두고, 원시 IP가 든 ClickHouse 백업은 7일 [가정]만 둔다(ADR-0053). |
| S3 공개 정적 객체(CDN 원본) | 회차별 좌석맵 파일(공연장 캔버스·무대 도형, 구역 도형·라벨 위치·등급, 좌석 좌표, 배치 버전이 이름에 든다), 장르별 랭킹 파일(매일 1개), 홈 배너 이미지 파생본, 후기 사진 파생본(목록 240px·보기 긴 변 1,280px [가정], ADR-0066), 매진 페이지와 대기 상태 파일 대체 경로 | core-svc catalog(좌석맵 파일·배너 이미지 게시), core-svc review(후기 사진 파생본 게시·삭제), peaket-data(랭킹 파일 게시 잡), queue-svc(대체 경로) | 개인정보를 담지 않는 공개 파일만 둔다. 좌석맵 파일은 배치를 바꾸면 새 이름으로 내고 옛 이름은 바꾸지 않아 CDN에 오래 캐시한다(추천 적용 2026-10-14, ADR-0063). 후기 사진은 비공개 격리 위치에 받은 원본을 검사·다시 인코딩해 메타데이터(촬영 위치 포함)를 지운 파생본만 여기에 두고 원본은 바로 지운다. 후기를 지우면 파생본을 지우고, 가리면 공개 위치에서 내려 비공개로 두며(다시 보이게 하면 되돌린다), 두 경우 모두 CDN을 무효화한다(추천 적용 2026-10-19, ADR-0066). |
| 클라이언트 로컬 저장소 (IndexedDB·Cache API) | 모바일 월렛 티켓 서명 데이터, WebCrypto 기기 개인키(`extractable=false`. 스크립트가 꺼낼 수 없을 뿐 하드웨어 보관이 아니다, ADR-0050), 현장 스캐너 회차 목록(티켓별 구역·좌석 표시·상태·유효 키·입장 상태, 개인정보 없음), 폐기 keyId 캐시, 오프라인 스캔 이벤트 로컬 큐, 현장 스태프 토큰, 좌석맵 파일 캐시(배치 버전이 키), 최근 검색어(이 기기에만, localStorage), 대기 화면의 처음 받은 앞 인원(sessionStorage, ADR-0063) | 클라이언트 애플리케이션 | 기기 서명용 개인키는 서버로 전송하지 않고 브라우저 프로필의 IndexedDB에만 둔다. |

## 2. ERD (PostgreSQL 주요 엔티티)

```mermaid
erDiagram
    account ||--o{ session : has
    account ||--o{ device : binds
    account ||--o{ consent : gives
    account ||--o| identity_verification : "verified_by (ci_hmac)"
    account ||--|{ account_provider : "로그인 수단 1개 이상"
    account ||--o{ account_merge : "대표 계정"
    admin_account }o--|| promoter : "belongs_to (partner only)"
    promoter ||--o{ event : organizes
    promoter ||--o{ settlement_statement : ""
    settlement_statement ||--o{ payout : ""
    settlement_statement ||--o{ statement_dispute : "이의 제기"
    settlement_statement ||--o{ statement_adjustment : "수기 조정"
    payout_batch ||--o{ payout : ""
    promoter ||--o{ partner_receivable : ""
    venue ||--o{ section : has
    promoter ||--o{ venue : "배치본 소유(LAYOUT)"
    venue ||--o{ event : "회차가 쓰는 배치본"
    section ||--o{ seat : has
    event ||--o{ price_tier : defines
    event ||--o{ event_seat_price : "maps seat to tier"
    seat ||--o{ event_seat_price : ""
    account ||--o{ purchase_order : places
    event ||--o{ purchase_order : for
    purchase_order ||--o{ order_item : contains
    purchase_order ||--o{ order_event : "event sourced"
    purchase_order ||--|| order_idempotency : "멱등키(파티션 밖 유일 확인 표, ADR-0083)"
    event ||--o{ seat_sale : "부분 UNIQUE(event_id, seat_id), 활성 PENDING·SOLD만"
    event ||--o{ seat_hold : "홀드 원장(평소 비동기 적재, 대체 경로는 직접 기록)"
    purchase_order ||--o{ seat_sale : reserves
    account ||--o{ purchase_quota : "per event"
    purchase_order ||--o| payment : paid_by
    purchase_order ||--o{ payment_attempt : "결제 시도(활성 1건)"
    payment ||--o{ payment_event : ""
    payment ||--o{ webhook_receipt : "dedup key(PG별)"
    payment ||--|| payment_per_order : "주문당 결제 1건(파티션 밖 유일 확인 표, ADR-0083)"
    order_item ||--o| ticket : issues
    ticket ||--o{ device_key : "public keys, revoked_at"
    ticket ||--o{ transfer_offer : "양도 요청"
    ticket ||--o{ scan_event : ""
    scanner_device ||--o{ scan_event : ""
    promoter ||--o{ scanner_device : "배정 파트너"
    event ||--o{ scanner_placement : "기기 배치(ADR-0051)"
    scanner_device ||--o{ scanner_placement : ""
    event ||--o{ scanner_change : "회차별 변경 일련번호"
    ticket ||--o{ gate_flag : "이상 표시"
    ticket ||--o{ booth_authorization : "부스 재발급 허용"
    ticket ||--o{ ticket_addon : ""
    account ||--o{ merch_order : ""
    promoter ||--o{ merch_order : "판매자(POL-037)"
    merch_order ||--o{ merch_order_item : "price snapshot"
    product_stock ||--o{ merch_order_item : confirms
    event ||--o{ review : "관람 후기(회차 단위)"
    account ||--o{ review : writes
    purchase_order ||--o{ review : "작성 자격 근거(결제자 주문)"
    event ||--o{ home_banner : "배너 대상"
    home_theme ||--o{ home_theme_item : ""
    event ||--o{ home_theme_item : ""
    admin_account ||--o{ home_banner : "작성자"
    admin_account ||--o{ home_theme : "작성자"
    takedown_notice ||--o{ takedown_action : ""
    review ||--o{ takedown_action : ""
    review ||--o{ review_image : "후기 사진(최대 3장 [가정], ADR-0066)"
    account ||--o{ review_image : "올린 계정(붙이기 전 review_id NULL)"
    review ||--o{ content_report : "게시물 신고(target_kind REVIEW, 계정당 한 번)"
    account ||--o{ content_report : "신고한 계정"
    content_report }o--o| cs_case : "같은 후기의 신고는 한 건(논리 DB가 달라 외래키 없음)"
    cs_case |o--o{ takedown_action : "신고 처리 조치(외래키 없음)"
    account ||--o{ inquiry : "고객 문의(ADR-0066)"
    inquiry ||--|{ inquiry_message : "기록(첫 문의·추가 문의·진행 경과·답변)"
    inquiry }o--o| cs_case : "CS 처리함 건(외래키 없음)"
    admin_account ||--o{ command_event : "actor/approver"
    data_request ||--o{ provision_ledger : ""
    security_incident ||--o{ incident_filing : "의무별 신고·통지"
    access_review ||--o{ access_finding : ""
    admin_account ||--o{ access_finding : "점검 대상"
    verification_case }o--|| account : ""
    account ||--o{ staff_assignment : "회차 역할"
    event ||--o{ staff_assignment : ""
    staff_assignment ||--o{ scanner_session : ""
    scanner_device ||--o{ scanner_session : ""
    purchase_order ||--o{ order_cancellation : "티켓 단위 취소"
    payment ||--o{ payment_cancel : "부분·전액 취소"
    event ||--o{ event_cancellation_request : "회차 취소 요청(ADR-0046)"
    purchase_order ||--o{ compensation : "배상(주최 측 귀책·공연 내용 변경)"
    admin_account ||--o{ approval_request : "요청자·승인자"
    cs_case |o--o{ approval_request : "건에서 생성"
    account ||--o{ booking_restriction : "예매 제한"
    account ||--o{ appeal : "소명"
    event ||--o{ kopis_report : "1일 전송(FR-054)"
    event ||--o{ sale_eligibility_list : "판매 자격 명단(팬클럽 선예매)"
    account ||--o{ notification_delivery : "알림 발송 기록(90일)"
    sale_eligibility_list ||--o{ sale_eligibility_member : ""
    event ||--o{ decision_record : "결정 기록(ADR-0052)"
    admin_account ||--o{ decision_record : "결정자"
    event ||--o{ pseudonymization_log : "가명정보 처리 기록"
    event ||--o{ demand_forecast : "수요 예측(ADR-0078)"

    account {
        uuid id PK
        text status "ACTIVE|WITHDRAWAL_PENDING|MERGED|DELETED. WITHDRAWAL_PENDING은 탈퇴 유예(결제 결과 대기·가상계좌 지연 환급 동안, 탈퇴 요청 202). 새 예매·주문·양도 요청은 409이고 로그인·환불 계좌 입력·알림만 허용(planning/03 §1.5 ⑧, 추천 적용 2026-10-20, ADR-0073)"
        uuid merged_into_account_id "MERGED일 때 대표 계정"
        text nickname
        text email
        text phone "optional"
        bool age_verified "14세 이상 확인 여부만"
        timestamptz created_at
        timestamptz deleted_at
    }
    identity_verification {
        uuid account_id PK
        bytea ci_hmac "UNIQUE, KMS HMAC(조회는 보존 중인 모든 키 버전으로)"
        int ci_hmac_key_version
        bytea pid "HMAC(pid 키, ci_hmac), 본인확인 때 한 번 계산(ADR-0050)"
        int pid_key_version
        timestamptz verified_at
        text source_record "출처·시기·목적·대상, 1년 이상"
    }
    account_provider {
        uuid account_id FK
        text provider
        text provider_user_id "UNIQUE (provider, provider_user_id)"
        timestamptz linked_at
    }
    account_merge {
        uuid id PK
        uuid primary_account_id FK
        uuid merged_account_id FK
        text merged_provider "흡수 계정이 쓰던 제공자"
        jsonb moved_summary "항목별 개수"
        timestamptz requested_at
        timestamptz confirmed_at
        timestamptz completed_at
    }
    session {
        uuid id PK
        uuid account_id FK
        uuid device_id FK
        bytea refresh_hash "SHA-256"
        uuid refresh_family
        timestamptz absolute_expires_at
        timestamptz idle_expires_at
        timestamptz terminated_at
    }
    admin_account {
        uuid id PK
        text role "partner_admin|partner_member|viewer|operator|commander|cs_agent|cs_lead"
        uuid promoter_id FK "partner_admin·partner_member만"
        text email
        text password_phc "pbkdf2-sha256, 600000회 이상, KMS 페퍼 버전 포함(ADR-0033, ADR-0050)"
        bytea totp_seed_enc "AES-256-GCM"
        int failed_attempts
        timestamptz locked_at
    }
    event {
        uuid id PK
        uuid promoter_id FK
        uuid venue_id FK
        timestamptz open_at "오픈 시각(오픈 간격 규칙)"
        timestamptz entry_opens_at "입장 시작"
        timestamptz starts_at "공연 시작. 판매 종료 = starts_at - 24시간, 칸 없이 계산(ADR-0064)"
        timestamptz ends_at "공연 종료 예정, 파트너 필수 입력(ADR-0051)"
        timestamptz entry_closed_at "입장 기록 마감"
        bool reentry_allowed "입장 정책, 기본 false"
        int lobby_minutes "default 10"
        text ordering_strategy "FIFO|PREQUEUE_SHUFFLE|HYBRID"
        text seat_assignment "PICK|AUTO"
        int per_person_limit
        jsonb sale_policy "DSL AST(문법 1판: design/d5 §6.7, 추천 적용 2026-10-14, ADR-0062)"
        text pg_primary "TOSS|PORTONE, 결제사 지정(POL-036). 판매 승인 뒤에는 비지 않음(비었으면 승인 때 플랫폼 기본값 저장, ADR-0062)"
        text pg_fallback "TOSS|PORTONE|NULL"
        text status "SCHEDULED|CANCELLED|POSTPONED. 기본은 SCHEDULED(이름은 추천 적용 2026-10-20, ADR-0073), 회차 취소 요청이 확정되면 CANCELLED, 연기가 확정되면 POSTPONED(바뀐 starts_at·ends_at을 따른다, planning/03 §2.11). 판매 승인은 sale_review 칸이고, 판매 상태(판매 전·판매 중·판매 종료)는 이 칸이 아니라 open_at·starts_at으로 계산한다(ADR-0064)"
        text sale_review "DRAFT|SUBMITTED|APPROVED|REJECTED, 판매 승인(POL-037, planning/03 §2.14)"
        text scale "LARGE|MEDIUM|SMALL, 공연 규모(architecture §9.5). 판매 승인 때 정하고 T-30분 점검 전까지 올리기만 한다. 승인 전 NULL(ADR-0062·0078)"
        timestamptz sale_approved_at "마지막 판매 승인 시각. NULL이면 비공개"
        jsonb pending_revision "재승인 대기 변경분. 승인 때 공개본에 반영(판매 승인 단위가 공연으로 정해지면 그 엔터티로 옮긴다, ADR-0062)"
        jsonb accessible_seating_check "판매 승인 요청 때 서버가 다시 센 휠체어석 수·기준 수·위치 확인 좌석 수·온라인 판매 휠체어석 수와 파트너 확인·부족 이유(FR-023, ADR-0062)"
        int commission_rate_bp "판매 승인 때 promoter 값으로 고정한 중개수수료율(만분율, ADR-0060)"
        text genre "장르 정본 목록: 콘서트|뮤지컬|연극|클래식|페스티벌|팬미팅|기타. SCR-021 1단계·검색 필터·홈 장르 바로가기·장르별 랭킹이 같은 값을 쓴다(추천 적용 2026-10-14, ADR-0063)"
    }
    venue {
        uuid id PK
        text name
        text kind "TEMPLATE(공연장 틀)|LAYOUT(틀을 복제한 공연용 배치본)"
        uuid template_venue_id "LAYOUT일 때 복제한 틀"
        uuid promoter_id "LAYOUT일 때 배치본을 가진 파트너. TEMPLATE은 NULL"
        int canvas_width "공연장 좌표계 폭(좌석맵 에디터 배치 층의 캔버스)"
        int canvas_height
        jsonb stage_shapes "무대·통로 등 판매하지 않는 도형 목록(종류 RECT|POLYGON|SECTOR|ARC_BAND, 공연장 좌표계 꼭짓점, 이름)"
        int layout_version "배치본을 저장할 때마다 올린다. 좌석맵 파일 이름에 든다"
        timestamptz geometry_locked_at "이 배치본을 쓰는 회차 중 가장 이른 오픈 시각. 그 뒤 도형·좌표·좌석 추가·삭제 잠금"
        text template_code "TEMPLATE만. ARENA-END|ARENA-THRUST|ARENA-CENTER|DOME|STADIUM|THEATER-L|THEATER-M|THEATER-S|HALL|FLAT(좌석맵 템플릿 10종, ADR-0066). TEMPLATE의 name은 템플릿 이름이고 특정 공연장 이름을 쓰지 않는다"
        text template_family "TEMPLATE만. ARENA|DOME|STADIUM|THEATER|HALL|FLAT"
        jsonb variants "TEMPLATE만. 고를 수 있는 것(돌출 길이, 그라운드 구역 수, 오케스트라 피트 있음·없음, 합창석 판매 여부, 블록 수)의 키·값 범위·기본값"
        int default_capacity "TEMPLATE만. 기본 좌석 수 [가정]. 파트너가 목표 좌석 수로 바꾼다"
        int template_version "TEMPLATE만. 템플릿 판. 배포 때 올리고 이미 복제한 배치본은 바뀌지 않는다"
        bool published "TEMPLATE만. 파트너 템플릿 목록에 보이는지"
        text schematic_key "TEMPLATE만. 개략도(SVG) 파일 키. 템플릿과 함께 배포 때 넣는다"
    }
    section {
        uuid id PK
        uuid venue_id FK
        text name "구역 이름"
        text level "층"
        jsonb shape "공연장 좌표계 다각형 꼭짓점 목록. 사각형·부채꼴도 저장 때 다각형으로 바꾸고 그린 도구 값은 editor_meta에 둔다"
        jsonb editor_meta "에디터 도구 값(도형 도구의 원래 매개변수, 행 배치 도구의 행 수·좌석 수·간격·곡률·번호 규칙)과 좌석 채우기 규칙(방식 좌석 수·행 × 좌석, 목표 수, 행 모양 직선·곡선, 좌석 간격·행 간격, 세로 통로 수·폭, 행 이름 숫자·알파벳, 첫 번호, 번호 방향, 값은 [가정] 기본값, ADR-0066). 팬 화면은 쓰지 않는다"
        int label_x "구역 라벨 위치(공연장 좌표계)"
        int label_y
        text default_tier "구역 기본 등급. 회차의 판매 등급은 event_seat_price가 정한다"
        text gate_zone "기본 입장 게이트 구역"
    }
    review {
        uuid id PK
        uuid event_id FK "회차. 작성 자격을 회차로 판정한다"
        uuid account_id FK "작성 계정. DELETED가 아닌 행에서 (event_id, account_id) 유일"
        uuid basis_order_id "작성 자격 근거 주문(그 회차 티켓의 결제자 주문, purchase 논리 DB라 외래키 없음)"
        smallint rating "별점 1~5, 필수"
        text body "NFC 정규화 뒤 grapheme 10~1,000자 [가정]"
        text status "VISIBLE|HIDDEN|DELETED. HIDDEN 사유는 takedown_action(통보·같은 내용·권리 침해 임시조치·신고 처리 노출 차단·불법 촬영물 신고 가림, ADR-0066)"
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at
    }
    review_image {
        uuid id PK
        uuid review_id "붙인 후기. 붙이기 전 NULL(ADR-0066)"
        uuid account_id "올린 계정. 자기 후기에만 붙인다"
        text status "UPLOADED|SCANNING|READY|REJECTED|DELETED"
        text reject_reason "UNSUPPORTED_TYPE|TOO_LARGE|TOO_SMALL|CODE_DETECTED|MALWARE"
        text alt_text "사진 설명(대체 텍스트), 선택, 100자 [가정]. 비우면 '후기 사진 1/3'으로 읽는다"
        int width
        int height
        smallint sort "후기 안 순서(0~2)"
        text thumb_key "목록 파생본(240px [가정]) 키"
        text view_key "보기 파생본(긴 변 1,280px [가정]) 키. 원본 키는 두지 않는다(파생본을 만든 뒤 원본을 지운다)"
        timestamptz created_at
        timestamptz attached_at
        timestamptz deleted_at "붙이지 않은 사진은 올린 뒤 24시간 [가정]에 지운다"
    }
    content_report {
        uuid id PK
        text target_kind "REVIEW(ADR-0066)"
        uuid target_id "신고한 게시물. (target_id, reporter_account_id) 유일"
        uuid reporter_account_id "신고한 계정. 글쓴이·다른 팬·파트너에게 보이지 않는다"
        text category "SCALPING|MACRO|ABUSE|RIGHTS|ILLEGAL_FILMING|SPAM|OFF_TOPIC|OTHER(사유 8종, POL-044)"
        text detail "자세한 내용 0~500자 [가정]. RIGHTS를 본인이 신고하거나 OTHER면 필수"
        bool rights_holder "RIGHTS일 때 권리를 침해받은 본인인지(정보통신망법 §44의2① 삭제 요청)"
        text notify_channel "APP|EMAIL|NULL. 처리 결과를 받을 곳(본인 요청이면 필수)"
        text status "RECEIVED|IN_REVIEW|RESOLVED"
        text outcome "NO_ACTION|TEMP_BLOCKED|BLOCKED"
        uuid case_id "CS 처리함 건(같은 후기의 신고는 한 건, ops 논리 DB라 외래키 없음)"
        timestamptz created_at
        timestamptz resolved_at
        timestamptz purge_at "처리 뒤 1년 [가정]"
    }
    inquiry {
        uuid id PK
        text number "접수 번호 Q-YYMM-NNNN [가정](예 Q-2610-0042, ADR-0066)"
        uuid account_id "문의한 계정. 본인만 본다"
        text category "문의 유형 11종(openapi InquiryCategory)"
        text order_ref "관련 주문(이 계정의 예매번호·굿즈 주문번호, 선택)"
        text title "5~50자 [가정]"
        text status "RECEIVED|IN_PROGRESS|ANSWERED|CLOSED"
        uuid case_id "CS 처리함 건(ops 논리 DB라 외래키 없음)"
        timestamptz created_at
        timestamptz answered_at
        timestamptz fan_viewed_at "팬이 상세를 마지막으로 연 시각. 그 뒤의 답변·진행 경과가 '새 답변'"
        timestamptz closed_at "답변 뒤 14일 [가정] 동안 추가 문의가 없거나 담당자가 닫을 때"
        timestamptz purge_at "닫힌 뒤 3년(전자상거래법 시행령 §6①4호)"
    }
    inquiry_message {
        uuid id PK
        uuid inquiry_id FK
        text author_kind "FAN|AGENT|SYSTEM. AGENT는 '피켓 고객센터'로만 보이고 담당자 개인 식별자는 ops-svc 감사 기록에만 둔다"
        text kind "MESSAGE|PROGRESS|ANSWER"
        text body "2,000자까지(팬 글은 10자 이상 [가정]), 첨부 없음"
        timestamptz created_at
    }
    home_banner {
        uuid id PK
        uuid event_id "대상 회차(판매 승인된 공연만)"
        text image_key "운영자가 올린 가로형 배너 원본 키. 공개는 메타데이터를 지운 파생본만"
        text alt_text "대체 텍스트, 필수"
        int sort_order
        timestamptz display_from "노출 시작"
        timestamptz display_until "노출 끝"
        uuid created_by "작성 운영자 관리 계정 ID"
        uuid updated_by
        timestamptz updated_at
    }
    home_theme {
        uuid id PK
        text name "테마 이름"
        int sort_order
        timestamptz display_from
        timestamptz display_until
        uuid created_by "작성 운영자 관리 계정 ID"
        uuid updated_by
        timestamptz updated_at
    }
    home_theme_item {
        uuid theme_id FK
        uuid event_id "판매 승인된 공연만"
        int sort_order
    }
    promoter {
        uuid id PK
        text legal_name "상호(판매자 신원정보, POL-037)"
        text representative "대표자"
        text address
        text phone
        text email
        text business_reg_no "사업자등록번호"
        text mail_order_report_no "통신판매업 신고번호 또는 면제 근거"
        timestamptz verified_at "판매 승인 때 사업자 진위 확인"
        text toss_seller_id "토스페이먼츠 지급대행 셀러(ADR-0047)"
        text toss_seller_status "APPROVAL_REQUIRED|PARTIALLY_APPROVED|KYC_REQUIRED|APPROVED"
        text portone_partner_id "포트원 파트너"
        text payout_bank_code "정산 은행"
        text payout_account_last4 "끝 4자리만, 계좌번호 저장 안 함"
        timestamptz payout_account_changed_at "변경 뒤 3영업일 지급 보류"
        int commission_rate_bp "계약 중개수수료율(만분율). 지금 계약값이고, 판매 승인 때 event.commission_rate_bp로 복사한다(ADR-0060)"
    }
    takedown_action {
        uuid id PK
        uuid notice_id FK "takedown_notice(NOTICE·SAME_CONTENT일 때)"
        uuid review_id FK
        text reason "NOTICE|SAME_CONTENT|RIGHTS_TEMP|POLICY|FILMING_HOLD. 같은 내용 차단은 공연법 시행령 §3의3 2호 마목(POL-024). RIGHTS_TEMP는 권리 침해 삭제 요청의 임시조치(정보통신망법 §44의2④·§44의3), POLICY는 게시물 신고 처리의 노출 차단, FILMING_HOLD는 불법 촬영물 신고를 받아 확인할 때까지 바로 가림(POL-044, ADR-0066)"
        text content_fingerprint "NFKC 정규화 뒤 공백·문장부호를 뺀 본문의 SHA-256"
        uuid case_id "신고 처리 조치의 CS 처리함 건(RIGHTS_TEMP·POLICY·FILMING_HOLD, ops 논리 DB라 외래키 없음). 신고자 정보는 넣지 않는다"
        timestamptz hidden_at
        timestamptz ends_at "RIGHTS_TEMP의 끝 시각(hidden_at + 30일 이내). 지나면 다시 보인다"
        timestamptz restored_at "통보 철회 때 같은 notice_id 전체 복원, 신고 처리 조치는 해제 때"
    }
    seat {
        uuid id PK
        uuid section_id FK
        text row_label
        int number
        bool wheelchair
        text gate_zone
        int x "좌석 중심 x(공연장 좌표계)"
        int y "좌석 중심 y"
    }
    purchase_order {
        uuid id PK "UUIDv7, 월 파티션 키(ID 범위, ADR-0083)"
        uuid account_id
        uuid event_id
        text status "CREATED|AUTHENTICATED|ACCEPTED|RESERVED|AWAITING_DEPOSIT|APPROVED|UNKNOWN|CONFIRMED|FAILED|COMPENSATED|PARTIALLY_REFUNDED|REFUNDED(planning/03 §2.4, payment §3). trade.orders의 DEPOSIT_REVERSED·EVENT_CANCELLATION_CONFIRMED·COMPENSATION_PAID는 사건이라 저장 값이 아니다"
        int amount "서버 계산"
        text idempotency_key "사본. 유일 확인은 order_idempotency(파티션 표라 여기에 유일 제약을 걸 수 없다, ADR-0083)"
        timestamptz created_at
    }
    order_idempotency {
        text idempotency_key PK "클라이언트 Idempotency-Key, 파티션하지 않음"
        uuid order_id
        uuid account_id "다시 온 요청의 계정이 같은지 확인"
        timestamptz created_at "24시간 [가정] 뒤 정비 시간에 지움"
    }
    seat_sale {
        uuid event_id
        uuid seat_id
        uuid order_id
        text status "PENDING|SOLD|RETURNED"
        timestamptz reserved_at
    }
    seat_hold {
        uuid event_id
        uuid seat_id
        uuid account_id
        bigint fencing_token
        text status "HELD|RELEASED|EXPIRED, HELD는 (event_id, seat_id) 유일 부분 인덱스"
        timestamptz expires_at
    }
    purchase_quota {
        uuid account_id
        uuid event_id
        int used
        int limit_count
    }
    payment_attempt {
        uuid id PK
        uuid order_id "활성(READY·ACCEPTED) 부분 유니크"
        text pg "TOSS|PORTONE|SIMULATOR"
        text pg_order_ref "토스 orderId 또는 포트원 paymentId"
        text status "READY|ACCEPTED|SUPERSEDED|EXPIRED"
        timestamptz created_at
    }
    payment {
        uuid id PK "UUIDv7, 월 파티션 키(ID 범위, ADR-0083)"
        uuid order_id "승인 요청은 주문당 한 번. 유일 확인은 payment_per_order(ADR-0083)"
        uuid attempt_id
        text pg "TOSS|PORTONE|SIMULATOR(결제 시도에서 고정)"
        text pg_payment_ref "토스 paymentKey 또는 포트원 paymentId"
        text pg_confirm_token "포트원 paymentToken, 결과 확정 시 삭제"
        bytea deposit_secret_hash "토스 가상계좌 입금 콜백 secret의 SHA-256, 입금 확정 시 삭제(ADR-0050)"
        int amount
        text status "ACCEPTED|AWAITING_DEPOSIT|APPROVED|UNKNOWN|FAILED|PARTIAL_CANCELED|CANCELED"
        timestamptz deposit_due_at "가상계좌 입금 기한(결제사에 보낸 값, ADR-0062)"
        text virtual_account_no "결제사가 발급한 가상계좌 번호, 필드 암호화(P1 기준), 입금 확정·만료 때 삭제"
        text idempotency_key "confirm-{orderId}"
        timestamptz authenticated_at "10분 deadline 기준"
    }
    payment_per_order {
        uuid order_id PK "주문당 결제 1건, 파티션하지 않음"
        uuid payment_id "결제 파티션을 지울 때 같은 범위의 행을 함께 지움"
    }
    merch_order {
        uuid id PK "UUIDv7"
        uuid account_id
        uuid promoter_id "판매자(상품을 등록한 파트너, POL-037)"
        text fulfillment "DELIVERY|PICKUP|WALLET, 수령 방식. 한 주문은 한 판매자·한 수령 방식(POL-016)"
        text status "CREATED|AWAITING_DEPOSIT|PAID|EXPIRED|FAILED(planning/03 §2.13)"
        text pg_store "STANDARD|ESCROW, 결제 상점(굿즈 택배만 에스크로 상점, POL-014)"
        bool escrow "구매자가 결제대금예치를 골랐는지"
        timestamptz purchase_confirmed_at "에스크로 구매 확정(결제사 상태, 3영업일 무선택이면 자동)"
        timestamptz created_at
    }
    merch_order_item {
        uuid id PK
        uuid order_id FK
        text product_id "MongoDB 상품 문서 ID"
        int quantity
        int unit_price "주문 시점 가격 스냅샷"
        text status "READY|SHIPPED|DELIVERED|PICKED_UP|LOCKED|RETURN_REQUESTED|RETURN_RECEIVED|DISPUTED|CANCELLED|REFUNDED(planning/03 §2.13)"
        text tracking_no "송장(택배사·번호, 판매자 등록)"
        timestamptz delivered_at "배송 완료 기록, 택배 반품 기한의 기준(POL-016 §1.4)"
        timestamptz picked_up_at "교환권 확인(현장 수령), 반품 기한의 기준"
        text return_reason "CHANGE_OF_MIND|DEFECT_OR_MISMATCH(단순 변심, 상품 이상·설명과 다름)"
        text return_tracking_no "반품 송장(선택)"
        timestamptz return_received_at "판매자 도착 확인(부가 상품은 CS 확인)"
        text reject_reason "판매자 거절 사유(전자상거래법 §17②1·2호)와 근거"
        timestamptz settle_eligible_at "정산 기준일(POL-039 ②, ADR-0062)"
        uuid statement_id "들어간 상품 정산서"
    }
    ticket {
        uuid id PK "UUIDv7, 월 파티션 키(ID 범위, ADR-0083)"
        uuid account_id "보유자"
        uuid payer_account_id "결제자(주문에서 복사, 바뀌지 않음)"
        uuid event_id
        uuid seat_id
        text gate_zone
        text status "ISSUED|ACTIVE|TRANSFER_PENDING|CANCEL_REQUESTED|REFUNDED|FLAGGED|VOIDED(가상계좌 입금 오류). planning/03 §2.5의 Reissued·Transferred는 상태가 아니라 사건이고, ScannedIn·ScannedOut은 이 칸이 아니라 판정 표가 갱신하는 입장 상태다(§4 14)"
        int version "양도·취소·회수 낙관적 잠금"
    }
    transfer_offer {
        uuid id PK
        uuid ticket_id FK
        uuid from_account_id "보낸 사람(결제자)"
        uuid to_account_id "받는 사람(본인확인 회원)"
        text status "OFFERED|ACCEPTED|REJECTED|WITHDRAWN|EXPIRED|RECLAIMED"
        timestamptz expires_at "48시간과 양도 마감 중 이른 때"
        timestamptz decided_at
    }
    device_key {
        uuid id PK
        uuid ticket_id FK
        bytea key_id "공개키 SPKI SHA-256 앞 8바이트, QR v1(ADR-0051)"
        bytea public_key "ECDSA P-256"
        text reason "ISSUE|REISSUE|TRANSFER|BOOTH(ADR-0050)"
        timestamptz registered_at
        timestamptz revoked_at
    }
    scan_event {
        uuid id PK "클라이언트 생성, 멱등. 기본 키는 (event_id, id)(ADR-0083)"
        uuid event_id PK "회차, 파티션 키"
        uuid ticket_id FK
        uuid scanner_device_id FK
        uuid scanner_session_id "그 시각의 세션"
        uuid staff_account_id "서버가 세션으로 정함, 1년 뒤 삭제"
        text direction "IN|OUT"
        text method "QR|OVERRIDE|VERIFY"
        text result "PASS|REJECT|CHECK"
        text reason "사유 코드(offline-gate §6.5)"
        text gate_zone
        bytea key_id
        timestamptz qr_ts
        timestamptz scanned_at_device "보정 시각"
        int clock_offset_ms
        bigint known_seq "판정 때 반영한 서버 변경 일련번호"
        bigint device_seq "기기 일련번호"
        timestamptz received_at
        text flag "NONE|DUPLICATE|NO_EXIT|AFTER_CANCEL|OUT_OF_SESSION|AFTER_CLOSE|TIME_UNCERTAIN"
    }
    scanner_device {
        uuid id PK
        uuid promoter_id "배정 파트너"
        text name "예: 동문-03"
        text status "ACTIVE|REVOKED|RETIRED"
        text credential_type "MTLS_CERT|DEVICE_KEY(대안 B)"
        bytea credential_thumbprint "인증서 또는 기기 키 지문"
        timestamptz cert_expires_at
        uuid enrolled_by "operator"
        timestamptz enrolled_at
        timestamptz revoked_at
        text revoke_reason
    }
    scanner_placement {
        uuid event_id
        uuid scanner_device_id
        text gate_zone
        text mode "IN|OUT, OUT은 재입장 허용 회차만"
        uuid set_by "파트너 또는 gate_lead"
        timestamptz set_at
    }
    scanner_change {
        uuid event_id
        bigint seq "회차별 서버 일련번호"
        text kind "KEY_REGISTERED|KEY_REVOKED|TICKET_STATUS|SCAN_STATE|POLICY|PLACEMENT|FLAG|SESSION_TERMINATED"
        jsonb payload "개인정보 없음"
        timestamptz created_at
    }
    gate_flag {
        uuid id PK
        uuid event_id
        uuid ticket_id FK
        text kind "DUPLICATE|NO_EXIT|AFTER_CANCEL|OUT_OF_SESSION|AFTER_CLOSE|OVERRIDE_REVIEW"
        text awareness "CONCURRENT|KNOWN, 중복 입장일 때"
        jsonb scan_event_ids
        text status "OPEN|OK|SUSPECT|UNDETERMINED"
        uuid resolved_by "gate_lead 또는 CS"
        timestamptz resolved_at
        text note "개인정보 금지"
    }
    booth_authorization {
        uuid id PK
        uuid ticket_id FK
        bytea booth_code_hash "8자 코드의 SHA-256"
        uuid reverification_id "identity 부스 본인확인 대조"
        text status "PENDING|ALLOWED|USED|EXPIRED"
        uuid allowed_by "gate_lead"
        timestamptz allowed_at
        timestamptz expires_at "허용 뒤 10분"
    }
    command_event {
        uuid command_id
        int seq
        text type
        uuid actor "or 'system'"
        text reason
        jsonb approvals
        jsonb dry_run
        timestamptz acked_at
    }
    audit_chain {
        bigint seq PK "빈틈 없는 번호"
        text record_type
        uuid record_id
        bytea record_sha256 "기록 정규화 값의 SHA-256"
        bytea mac "HMAC(감사 체인 키, PEAKET-audit-v1, seq, 직전 mac, 기록 해시)"
        bytea leaf_salt "잎 솔트 32바이트 난수, 비공개, 기록 파기 때 함께 파기(ADR-0075)"
        timestamptz created_at
    }
    audit_checkpoint {
        bigint no PK "체크포인트 번호"
        bigint first_seq
        bigint last_seq
        int leaf_count
        bytea merkle_root "RFC 9162 머클 트리 해시(잎은 PEAKET-audit-leaf-v1, seq, 기록 해시, 잎 솔트)"
        bytea prev_checkpoint_hash
        bytea access_log_day_anchor "일 체크포인트에만"
        jsonb closed_events "회차 마감 체크포인트에만"
        bytea checkpoint_hash "RFC 8785 정규화 JSON의 SHA-256"
        bytea signature "체크포인트 서명 키(KMS ECDSA P-256)"
        text ots_state "PENDING|COMPLETE"
        bytea ots_proof
        timestamptz created_at
        timestamptz published_at
    }
    data_request {
        uuid id PK
        text requester "agency|police"
        text kind "report|cdr|subscriber"
        bool legal_basis_checked
        timestamptz submitted_at
        timestamptz retain_until "7y or 1y"
    }
    security_incident {
        uuid id PK
        text kind "INTRUSION|PERSONAL_DATA|PERSONAL_DATA_POSSIBLE (FR-063)"
        timestamptz aware_at "인지 시각, 모든 기한의 기준"
        int affected_count "유출등 대상 수, 모르면 null"
        bool sensitive_or_unique "민감정보·고유식별정보 포함"
        bool external_access "외부 불법 접근"
        timestamptz outage_started_at "공격으로 생긴 장애 시작, 관제 지표가 채움"
        timestamptz outage_ended_at
        uuid decided_by "해당 판단 commander"
        text status "OPEN|CLOSED"
    }
    incident_filing {
        uuid id PK
        uuid incident_id FK
        text duty "KISA_REPORT_24H|ADDITIONAL_24H|USER_NOTICE|RELIEF_14D|SUBJECT_NOTICE_72H|PIPC_REPORT_72H|POSSIBILITY_NOTICE_72H"
        timestamptz due_at
        timestamptz done_at
        text channel "기관·방법(서면, 전자우편, 홈페이지 게시 등)"
        text summary "신고·통지 내용 요약, 개인정보 원문 없음"
    }
    access_review {
        uuid id PK
        text period "YYYY-MM, 월 1회 정기 점검(FR-064)"
        uuid reviewer "개인정보 보호책임자가 지정한 commander"
        timestamptz due_at "월말"
        timestamptz completed_at
    }
    access_finding {
        uuid id PK
        uuid review_id FK
        text rule "REPEAT_DOWNLOAD|BULK_DOWNLOAD|OFF_HOURS|OUTSIDE_IP|OUT_OF_SCOPE"
        uuid subject_account_id "점검 대상 관리 계정, 점검자 본인이면 다른 commander만 종결"
        timestamptz detected_at
        text reason "확인한 사유(소명)"
        text action "NONE|REPORTED|RECALLED|DELETED|ACCESS_REVOKED|INCIDENT"
        timestamptz closed_at
    }
    verification_case {
        uuid id PK
        uuid account_id
        text reason_category
        text status
        text appeal_result
    }
    staff_assignment {
        uuid id PK
        uuid account_id "수락한 PEAKET 계정, UNIQUE(event_id, account_id)"
        uuid event_id "회차"
        text role "gate_staff|gate_lead"
        text invite_email "수락·만료 시 파기"
        bytea invite_token_hash "32바이트 난수의 SHA-256(ADR-0051)"
        timestamptz invite_expires_at "24시간"
        uuid invited_by "파트너 관리 계정"
        timestamptz valid_from "입장 시작 3시간 전"
        timestamptz valid_until "공연 종료(event.ends_at) 2시간 뒤"
        text status "INVITED|ASSIGNED|REVOKED|ENDED|EXPIRED. planning/03 §2.7의 OnDuty는 저장하지 않고 ASSIGNED이면서 지금이 valid_from과 valid_until 사이인 것으로 계산한다(추천 적용 2026-10-20, ADR-0073)"
    }
    scanner_session {
        uuid id PK "CSPRNG 128비트 이상"
        uuid staff_assignment_id FK
        uuid scanner_device_id FK
        uuid approved_by_session "승인한 휴대폰 세션"
        text role "gate_staff|gate_lead, 대리 승인이면 gate_staff"
        bool proxy "책임자 대리 승인"
        timestamptz approved_at
        timestamptz expires_at "역할 유효 끝"
        timestamptz last_seen_at
        timestamptz terminated_at "교대·해제·폐기·만료"
    }
    order_cancellation {
        uuid id PK
        uuid order_id FK
        uuid ticket_id
        text reason "USER|EVENT_CANCELLED|EVENT_POSTPONED|ACCOUNT_WITHDRAWAL|EXCEPTION|MINOR_CONTRACT_CANCEL(공제 없이 전액, POL-038 ⑧)"
        uuid approval_id "예외 환불 승인 업무(있을 때)"
        int days_before "공연일까지 남은 날"
        bool within_24h "비영업일 제외"
        numeric deduction_rate
        int refund_amount
        text status "REQUESTED|REFUND_PENDING|REFUNDED|VOIDED"
    }
    payment_cancel {
        uuid id PK
        uuid payment_id FK
        int amount
        text idempotency_key "cancel-{cancellationId}"
        text status "REQUESTED|CANCEL_PENDING|CANCELED|FAILED"
    }
    event_cancellation_request {
        uuid id PK
        uuid event_id
        uuid promoter_id
        text kind "CANCEL|POSTPONE"
        text partner_reason
        text fault "ORGANIZER|FORCE_MAJEURE|CONTENT_CHANGE(귀책 판정)"
        uuid judged_by "commander"
        jsonb dry_run "대상 주문 수, 환급·배상 총액, 결제사별 건수"
        jsonb approvals "판정자 외 1인"
        text status "REQUESTED|JUDGED|PENDING_APPROVAL|APPROVED|RUNNING|PAUSED|COMPLETED|REJECTED"
        int done_count
        int failed_count
    }
    compensation {
        uuid id PK
        uuid order_id
        uuid event_id
        int base_amount "실제 결제 금액"
        int amount "10%"
        text funding "OFFSET|GUARANTEE|ADVANCE"
        text status "ACCOUNT_PENDING|REQUESTED|PAID|FAILED"
        text account_last4 "끝 4자리만, 계좌번호 저장 안 함"
        text payout_ref
    }
    settlement_statement {
        uuid id PK
        uuid promoter_id
        text kind "EVENT|PRODUCT(티켓 회차 정산서, 굿즈·부가 상품 상품 정산서, ADR-0062)"
        uuid performance_id "회차(상품 정산서는 null)"
        text pg "TOSS|PORTONE"
        text pg_store "STANDARD|ESCROW(토스페이먼츠만)"
        date period_start "상품 정산서의 주 시작(KST)"
        date period_end
        bigint gross_amount "판매 대금"
        bigint refund_amount
        bigint commission_amount "중개수수료"
        bigint commission_vat
        bigint offset_amount "미수금 상계"
        bigint payout_amount
        text status "CALCULATED|NOTIFIED|DISPUTED|CONFIRMED|HELD|SCHEDULED|FAILED|PAID|CARRIED_OVER"
        text hold_reason "KYC|ACCOUNT_CHANGE|BALANCE"
        timestamptz dispute_due_at "통지 뒤 2영업일"
        date payout_date "회차 정산서는 회차 종료 뒤 5영업일, 상품 정산서는 계산일 뒤 4영업일"
    }
    statement_dispute {
        uuid id PK
        uuid statement_id
        text reason_code "GROSS_AMOUNT|REFUND_AMOUNT|COMMISSION|OFFSET|OTHER"
        text detail "2,000자"
        uuid submitted_by
        timestamptz submitted_at
        text result "ADJUSTED|DISMISSED"
        timestamptz resolved_at
    }
    statement_adjustment {
        uuid id PK
        uuid statement_id
        uuid approval_id "수기 조정 승인 업무"
        text reason_code "GROSS_AMOUNT|REFUND_AMOUNT|COMMISSION|OFFSET|OTHER|LEDGER_ERROR|CONTRACT_CORRECTION|AGREED_DEDUCTION"
        uuid dispute_id "이의 인정이면"
        bigint amount "+ 지급 늘림 / − 줄임"
        text evidence_note "2,000자"
        timestamptz applied_at
    }
    payout_batch {
        uuid id PK
        text pg
        text pg_store "STANDARD|ESCROW(토스페이먼츠만)"
        date payout_date
        bigint total_amount
        int statement_count
        uuid approval_id "지급 묶음 승인(2인)"
        text portone_bulk_payout_id "포트원 콘솔 실행 기록"
        bigint pg_balance_krw "묶음 때 본 결제사 잔액"
        text pg_balance_source "PG_API|OPERATOR_CONSOLE"
        timestamptz pg_balance_observed_at
        uuid pg_balance_observed_by "OPERATOR_CONSOLE일 때 입력한 operator"
        text status "PREPARED|APPROVAL_PENDING|APPROVED|SUBMITTED|COMPLETED|PARTIAL_FAILED"
    }
    payout {
        uuid id PK
        uuid batch_id
        uuid statement_id
        int seq
        bigint amount "10억 원 미만"
        text ref_payout_id UK "정산서 ID-순번, 멱등"
        text pg_payout_id
        text status "REQUESTED|IN_PROGRESS|COMPLETED|FAILED|CANCELED"
        text error_code
    }
    partner_receivable {
        uuid id PK
        uuid promoter_id
        text cause "REFUND_AFTER_PAYOUT|CHARGEBACK|COMPENSATION_ADVANCE|NEGATIVE_STATEMENT"
        bigint amount
        bigint remaining
        text status "OPEN|OFFSET|GUARANTEE|BILLED|CLOSED|WRITTEN_OFF"
        text source_ref
    }
    approval_request {
        uuid id PK
        text kind "SYSTEM_FAULT_REFUND|DISCRETIONARY_WAIVER|TRANSFER_RECLAIM|BOOKING_RESTRICTION|PAYOUT_BATCH|SETTLEMENT_ADJUSTMENT|COMMANDER_ROLE_CHANGE|CONTRACT_TERMS_CHANGE|MINOR_CONTRACT_CANCEL"
        text target_ref
        int amount
        text reason_code
        text reason_text
        text evidence_checked "확인한 증빙 종류만(내용·파일 없음)"
        uuid requested_by
        int required_approvals "1|2(POL-038)"
        jsonb approvals "승인자·시각, 요청자 제외"
        text status "REQUESTED|PENDING_APPROVAL|APPROVED|REJECTED|ESCALATED|EXECUTING|DONE|FAILED. FAILED는 원인을 고친 뒤 승인자가 같은 approve를 다시 부르면(재인증) EXECUTING으로 다시 실행(추천 적용 2026-10-20, ADR-0073)"
        timestamptz due_at
    }
    cs_case {
        uuid id PK
        text kind "UNKNOWN_PAYMENT|REFUND_FAILED|FLAGGED|REFUND_ACCOUNT_PENDING|COMPENSATION_PENDING|ABUSE_FLAG|DISPUTE|JUDGEMENT_PENDING|STATEMENT_DISPUTE|SELLER_KYC_REQUIRED|PAYOUT_ERROR|PAYOUT_FAILED|PAYOUT_DELAYED|PORTONE_PAYOUT_EXECUTION|SCANNER_UNREPORTED|KOPIS_REPORT_FAILED|VERIFICATION_APPEAL|APPROVAL_EXECUTION_FAILED|RETURN_DELAYED|MINOR_CONTRACT_CANCEL|INQUIRY|CONTENT_REPORT|RIGHTS_REQUEST. INQUIRY는 고객 문의, CONTENT_REPORT는 게시물 신고, RIGHTS_REQUEST는 권리 침해 삭제 요청(ADR-0066)"
        text target_ref "문의 건은 inquiry ID, 신고 건은 신고된 후기 ID"
        timestamptz progress_due_at "분쟁 진행 경과 3영업일, 미보고 스캐너 파트너 확인 요청 1영업일"
        timestamptz result_due_at "분쟁 결과 10영업일, 환급 3영업일, 추가 검증 이의 결과 10영업일, 현장 건 3영업일, 배상 대기 10영업일(design/d5 §7.6, 수치 [가정], ADR-0062). 문의 답변 3영업일, 게시물 신고 결과 3영업일, 권리 침해 삭제 요청과 불법 촬영물 사유 신고의 판단 1영업일(수치 [가정], ADR-0066)"
        text status "OPEN|IN_PROGRESS|RESOLVED"
        uuid assignee
    }
    booking_restriction {
        uuid id PK
        uuid account_id
        text reason_code
        uuid confirmed_by "cs_lead"
        timestamptz starts_at
        timestamptz ends_at
        timestamptz appeal_due_at "1일 이상"
        text status "ACTIVE|LIFTED|EXPIRED"
    }
    appeal {
        uuid id PK
        text kind "RESTRICTION|RECLAIM"
        uuid target_id
        uuid account_id
        text body "보존 기한 뒤 파기"
        timestamptz submitted_at
        text result
    }
    kopis_report {
        date report_date
        uuid event_id
        text payload_hash "대사 완료 원장 대조 해시"
        text status "SENT|FAILED|RETRYING"
        timestamptz sent_at
    }
    sale_eligibility_list {
        uuid id PK
        uuid event_id "판매 승인 단위(지금은 회차. 단위가 공연으로 정해지면 그 엔터티로, design/d5 §1.6 31번)"
        text key "영문 소문자·숫자·하이픈 3~32자, 규칙의 buyer.lists 값"
        text name "표시 이름"
        int member_count
        bytea file_sha256 "올린 파일의 SHA-256(파일은 저장하지 않음)"
        timestamptz locked_at "판매 시작 24시간 전 [가정]에 잠금"
        timestamptz destroy_due_at "판매 기간 끝 + 1일 [가정], 추천 적용 2026-10-14, ADR-0062"
    }
    sale_eligibility_member {
        uuid list_id FK
        uuid account_id "회원 코드를 바꾼 계정, 판매 기간 끝 + 1일 [가정]에 파기"
    }
    notification_delivery {
        text dedup_key PK "종류:대상:사건·버전:계정:채널"
        text kind
        text target_ref
        uuid account_id
        text channel "EMAIL|WEB_PUSH|ALIMTALK|SMS|CONSOLE"
        text status
        timestamptz sent_at
        text provider_message_id "받는 주소·전화번호·본문은 넣지 않음, 90일 [가정] 뒤 파기(design/d5 §9.1.1, ADR-0062)"
    }
    decision_record {
        uuid id PK
        uuid event_id FK "계기가 된 회차"
        text trigger_rule "걸린 결정 규칙(planning/01 §3.2)"
        text trigger_stage "R0|R1|R2|R3"
        text kind "OPERATING_DEFAULT|PRODUCT|SALES_POLICY|BOT_POLICY|PARTNER_RECOMMENDATION|TARGET"
        text summary "분석 요약, 개인정보 금지"
        text decision
        text evidence_strength "WEAK|MEDIUM|STRONG"
        jsonb expected_effect "지표, 목표 값, 확인할 회차 수"
        text revert_condition
        text ref "ADR·POL 번호나 설정 변경 ID"
        text partner_response "ACCEPTED|DECLINED|NONE"
        text status "AWAITING_CHECK|CHECKED|WITHDRAWN"
        text check_result "MET|NOT_MET|INCONCLUSIVE"
        uuid decided_by FK
        timestamptz decided_at
    }
    demand_forecast {
        uuid id PK
        uuid event_id FK
        timestamptz computed_at
        text trigger "SALE_REVIEW|DAILY|T_MINUS_30"
        int subscribers "오픈 알림 구독 수(core-svc가 넘긴 수, 계정 없음)"
        numeric ratio_median "구독 대비 진입 비율 중앙값"
        numeric ratio_upper "75번째 백분위"
        int sample_count "비율에 쓴 지난 회차 수. 10 미만이면 기본 비율"
        int expected_median
        int expected_upper
        text suggested_scale "LARGE|MEDIUM|SMALL"
    }
    pseudonymization_log {
        uuid id PK
        uuid event_id "처리한 회차"
        text purpose "통계작성(공연 리포트·결정 규칙)"
        text items "pid, 계정 ID, 대기 참여·구매 세션·주문·티켓·홀드 ID"
        text key_version "분석 가명 키 버전"
        jsonb usage "이용 내역: 적재 건수, 마감 단계, 실버 조회 요약"
        timestamptz processed_from
        timestamptz destroy_due_at "적재 뒤 90일"
        timestamptz destroyed_at
    }
```

`event` 테이블의 단일 레코드는 독립된 좌석 재고를 보유하는 개별 회차를 나타내며, 이는 Redis의 `{event:E}` 키 샤딩 단위와 일치한다. 동일 공연에 여러 회차가 존재할 경우 회차별로 별도의 `event` 행이 생성된다. `seat_sale` 테이블의 유니크 제약은 활성 상태(PENDING·SOLD)에만 적용되는 부분 유니크 인덱스(`UNIQUE (event_id, seat_id) WHERE status IN ('PENDING','SOLD')`)로 구성되어 있으므로, 예매 취소로 인하여 `RETURNED` 상태로 전환된 좌석은 이력 행을 보존하면서도 재판매를 허용한다.

파티션 표 규칙(추천 적용 2026-10-22, ADR-0083): 파티션 표의 기본 키와 유일 규칙은 파티션 키 열을 모두 담는다(PostgreSQL 18). 주문(`purchase_order`)·결제(`payment`)·티켓(`ticket`)은 서버가 만든 UUIDv7 `id`의 범위로 한 달씩 나눈다. 경계는 한국 시각 매월 1일 0시의 유닉스 밀리초를 앞 48비트에 두고 나머지를 0으로 채운 UUID다(PostgreSQL은 `uuid`를 바이트 순서로 비교한다). 기본 키 `id`가 파티션 키라서 같은 DB 안의 외래 키(`device_key`·`transfer_offer`·`scan_event`·`gate_flag`·`booth_authorization`·`ticket_addon` → `ticket`, `order_item`·`order_cancellation` → `purchase_order`, `payment_event`·`payment_cancel` → `payment`)가 이 표들을 가리킬 수 있다(PostgreSQL 12부터). 파티션 키를 담을 수 없는 전역 유일 규칙은 파티션하지 않는 유일 확인 표가 맡고 원장 행과 같은 트랜잭션에서 넣는다: 주문 멱등키는 `order_idempotency`, 주문당 결제 1건은 `payment_per_order`다. 회차로 나누는 `scan_event`의 기본 키는 `(event_id, id)`다. 다음 파티션은 정비 잡이 미리 만들고(월 파티션 3개월·Outbox 일 파티션 7일 앞 [가정, wbs 0.3.2에서 확정]), 기본(DEFAULT) 파티션은 두지 않는다. Drizzle 0.45.4에는 파티션 선언이 없어 부모 표와 첫 파티션은 손으로 쓴 SQL 마이그레이션 파일로 만든다.

회차의 판매 종료는 공연 시작 24시간 전이다(소유자 결정 2026-10-14, ADR-0064). 새 칸을 두지 않고 `starts_at - interval '24 hours'`로 계산하며(추천 적용 2026-10-14, ADR-0064), 대기열 진입·입장 확정(queue-svc), 좌석 홀드·주문 생성(purchase-svc), 취소표 알림 신청, 홈·검색의 판매 상태와 남은 판매 기간(core-svc catalog), 대기열 회차 키의 TTL이 모두 이 한 식을 쓴다. 회차가 연기되면 바뀐 `starts_at`을 따른다. 판매 종료 뒤에는 그 회차의 새 홀드·주문(판매 종료 전 홀드의 주문은 제외)을 받지 않으므로, 판매 종료 뒤 취소로 `RETURNED`가 된 좌석은 다시 팔지 않고 빈 좌석으로 남는다(ADR-0064 남는 한계). 예매 취소 기한(`starts_at`, POL-032)과 양도 마감은 이 식과 따로다.

좌석맵은 두 층으로 저장한다(추천 적용 2026-10-14, ADR-0063). 배치 층은 `venue`의 캔버스 크기·무대 도형과 `section`의 도형(공연장 좌표계 다각형)·라벨 위치·기본 등급이고, 좌석 층은 `seat`의 열·번호·속성과 좌표(x·y)다. 팬 화면은 전체 배치를 먼저 그리고 확대하면 그 범위 구역의 좌석을 그린다(docs/features/seat-hold.md §10). 회차별 좌석맵 파일은 이 두 층과 등급(`event_seat_price`)을 한 파일에 싣고 `layout_version`을 이름에 넣는다. 구역마다 좌석이 비트맵 인덱스의 한 범위를 차지하도록 좌석 인덱스를 매기고 그 범위를 파일에 적어, 브라우저가 스냅샷 비트맵에서 구역별 남은 좌석을 셀 수 있게 한다.

좌석맵의 소유 단위(추천 적용 2026-10-14, ADR-0063): `venue`의 TEMPLATE 행은 공연장 틀이고, 파트너가 회차 묶음(같은 공연의 회차들)의 좌석맵을 만들 때 틀을 복제해 그 공연용 배치본(LAYOUT 행, 자기 `section`·`seat`, `layout_version`)을 만든다. 같은 공연의 회차들은 같은 배치본을 가리키고(`event.venue_id`), 편집은 그 배치본에만 미친다. 틀을 고쳐도 이미 만든 배치본은 바뀌지 않고, 다른 파트너의 배치본은 보이지도 고쳐지지도 않는다. 판매 승인 뒤 배치본을 바꾸면 그 회차들은 다시 승인 대기다(planning/03 §2.14, 지금 규칙). 배치본을 쓰는 회차 중 하나라도 오픈(판매 시작)하면(`geometry_locked_at`) 도형·좌표·좌석 추가·삭제는 바꾸지 않고, 기존 좌석의 속성 변경(판매 제외 등)만 지금 규칙대로 받는다. 좌석 ID와 비트맵 인덱스가 판매·홀드 기록과 이어져 있기 때문이다.

좌석맵 템플릿(소유자 요청 2026-10-19, 목록과 세부는 추천 적용 2026-10-19, ADR-0066): 국내에서 흔한 공연장 모양 10종(실내 아레나 엔드 스테이지·돌출 무대·센터 무대, 돔 구장, 종합운동장, 대극장(3층), 중극장(2층), 소극장, 콘서트홀(합창석), 평면 블록)을 `venue` TEMPLATE 행으로 둔다. 기본 좌석 수는 모두 [가정]이고 파트너가 바꾼다. 템플릿은 저장소의 정적 파일(`seed/seatmap-templates/*.json`, 예정)을 배포 때 넣는다. 파트너는 읽기만 하고 운영자 편집 화면은 없다(바꿀 때는 배포). [템플릿에서 만들기]는 고른 템플릿의 도형(변형 반영)과 구역별 채우기 규칙(목표 좌석 수를 구역 비율대로 나눈 값, `section.editor_meta`)을 그 공연의 배치본(LAYOUT)으로 복제한다. 이미 좌석이 있는 배치본은 바꾸겠다는 확인(`replace`) 없이는 덮어쓰지 않고, 오픈 뒤 잠긴 배치본(`geometry_locked_at`)은 바꾸지 않는다. 자동 채우기 계산은 에디터(브라우저)가 하고, 서버는 저장 때 좌석이 구역 도형 안인지와 같은 구역·열·번호가 겹치지 않는지 다시 검사하며 좌석끼리 겹치면(중심 사이가 좌석 간격의 절반보다 가까움 [가정]) 경고만 한다. 템플릿은 흔한 모양을 본뜬 출발점이고 실제 공연장의 배치도가 아니다. 실제 공연장 배치도는 공연장이 준 공식 자료와 허락이 있어야 쓸 수 있어 넣지 않고, 특정 공연장 이름과 다른 예매처·공연장 누리집의 배치도는 쓰지 않는다. 스탠딩(정리번호 입장) 구역은 범위 밖이라 플로어는 지정석이다(ADR-0051).

관람 후기(`review`)는 기대평 종류를 두지 않는다(소유자 결정 2026-10-14, ADR-0063). 작성 자격은 그 회차의 `event.ends_at`이 지났고, 그 회차 티켓의 결제자이며, 취소·환불·무효가 아닌 티켓이 하나 이상 남은 계정이다. 양도받은 보유자는 쓰지 않는다. 한 계정은 한 회차에 후기 하나이고 고치거나 지울 수 있다. 별점이 낮다는 이유로 숨기지 않는다(ADR-0063). core-svc review 모듈이 쓸 때마다 ticket-svc에 결제자 티켓을 물어 확인하고(논리 DB 간 조인 금지), 확인한 주문을 `basis_order_id`로 남긴다. 취소된 회차(`status` CANCELLED)는 쓸 수 없고, 연기된 회차는 바뀐 `ends_at`을 따른다. 공개 응답의 작성자 표시는 닉네임 첫 글자와 '**'(예: '김**'), 관람 회차 일시뿐이고 이메일·전화번호·실명·계정 ID는 싣지 않으며 본인 후기는 `mine` 불리언으로만 알린다. 계정 병합 때 두 계정이 같은 회차에 후기를 하나씩 가지면 대표 계정 후기만 남기고 흡수 계정 후기는 DELETED로 바꾼다(병합 영향 요약에 보인다)(추천 적용 2026-10-14, ADR-0063). 공연(회차 묶음) 엔터티가 없어(design/d5 §1.6 31번) 같은 공연의 여러 회차 후기를 한데 모아 보이는 기준은 그 결정 때 정하고, 그 전에는 회차 단위로 보인다.

후기 사진(`review_image`, 소유자 요청 2026-10-19, 세부는 추천 적용 2026-10-19, ADR-0066): 한 후기에 사진은 최대 3장 [가정]이고, 형식·크기는 공연 이미지와 같은 기준(JPEG·PNG·WebP, 한 장 10MB, 긴 변 20,000px·4,000만 화소 상한, ADR-0062 결정 38)에 짧은 변 320px 이상 [가정]을 더한다. 팬이 사진을 먼저 올리면(`review_id` NULL) 후기 쓰기·고치기 본문에서 자기 사진만 붙인다. core-svc review 모듈은 비공개 격리 위치에 받은 원본을 확장자·매직 바이트·디코딩·악성 코드로 검사하고, 파생본을 만들기 전에 사진에서 QR 코드·바코드를 찾아 찾으면 그 사진을 받지 않는다(어떤 QR이든, `CODE_DETECTED`). 통과하면 다시 인코딩해 메타데이터(촬영 위치 포함)를 지운 파생본 2종(목록 240px, 보기 긴 변 1,280px [가정])만 공개 정적 객체로 내고 원본은 바로 지운다. 붙이지 않은 사진은 24시간 [가정] 뒤 지우고, 후기를 지우면 사진도 지우며 후기를 가리면 사진도 가린다. QR 거르기는 일부만 보이거나 흐린 코드를 놓칠 수 있다(planning/01 §5.2).

게시물 신고(`content_report`, 소유자 요청 2026-10-19, 세부는 추천 적용 2026-10-19, ADR-0066, POL-044): 후기마다(내 후기 제외) [신고]로 사유 8종 중 하나와 자세한 내용(0~500자 [가정])을 받는다. 같은 후기는 계정당 한 번(`(target_id, reporter_account_id)` 유일)이고 하루 10건 [가정]까지다. core-svc review 모듈이 받아 같은 후기의 신고를 CS 처리함 건 하나로 모으고 신고 수·사유별 수를 센다. 건 종류는 `CONTENT_REPORT`(결과 3영업일 [가정])이고, 개인정보 노출·명예훼손을 권리를 침해받은 본인이 요청하면 `RIGHTS_REQUEST`(정보통신망법 §44의2 삭제 요청, 1영업일 [가정], '지체 없이')다. 음란물·불법 촬영물 사유가 들어오면 확인할 때까지 바로 가리고(`takedown_action` `FILMING_HOLD`) 1영업일 [가정] 안에 판단한다. CS 담당자의 처리는 조치 없음·임시조치(최대 30일, `RIGHTS_TEMP`)·노출 차단(`POLICY`)과 해제다. 결과는 신고자에게 알리고, 임시조치·노출 차단은 글쓴이에게 조치 사실과 사유 종류만 알리며 신고자를 밝히지 않는다. 임시조치·노출 차단한 후기 자리에는 그 사실을 보인다(§44의2② 후단 공시). 피켓에 보낸 신고는 신고기관에 자동으로 전달되지 않는다. 신고 기록은 처리가 끝나고 1년 [가정] 뒤 지운다.

고객 문의(`inquiry`·`inquiry_message`, 추천 적용 2026-10-19, ADR-0066): core-svc의 support 모듈이 가진다(팬 경로 `gw-fan`). 문의 본문은 첫 `inquiry_message`(FAN·MESSAGE)이고 추가 문의·진행 경과·답변이 같은 기록에 시간 순으로 쌓인다. 첨부 파일은 받지 않는다. 접수하면 CS 처리함 건을 만든다. 유형 '공연(판매자) 관련 분쟁'은 지금처럼 `DISPUTE`(진행 경과 3영업일·결과 10영업일), '미성년자 계약 취소'는 지금처럼 `MINOR_CONTRACT_CANCEL`(design/d5 §7.6)이고 그 밖의 유형은 `INQUIRY`(답변 3영업일 [가정])다. ops-svc는 팬 요청을 직접 받지 않는다(독립 제어 평면). 접수 사실은 core-svc가 Outbox 이벤트(asyncapi `support.cases-requested`, 본문 없음)로 넘기고 ops-svc가 그것으로 건을 만들며, 담당자의 답변·진행 경과는 ops-svc가 권한과 감사 로그를 처리한 뒤 core-svc support 모듈 내부 API로 넣고 팬에게 알린다(docs/architecture.md §3.1). 담당자는 '피켓 고객센터'로만 보이고 담당자 개인 식별자는 ops-svc 감사 기록에만 둔다. 문의는 본인만 보고 없는 문의와 남의 문의는 같은 404다. 계정당 하루 10건 [가정]까지 접수한다. '새 답변' 표시는 팬이 상세를 마지막으로 연 시각(`fan_viewed_at`) 뒤의 답변·진행 경과로 정한다. 답변 뒤 14일 [가정] 동안 추가 문의가 없으면 닫히고, 닫힌 뒤 3년(전자상거래법 시행령 §6①4호. 일반 문의까지 소비자 불만·분쟁 처리 기록으로 보는 것은 해석, POL-027) 뒤 지운다.

홈 구성(`home_banner`, `home_theme`, `home_theme_item`)은 운영자가 관제 콘솔 [홈 구성](SCR-068 탭)에서 쓰고 core-svc catalog가 홈 피드에 싣는다. 대상은 판매 승인된 공연뿐이고 노출 기간 밖이거나 판매 승인이 취소된 공연은 피드에서 빠진다. 저장은 ops-svc가 권한(operator 1인)과 감사 로그를 처리한 뒤 core-svc 내부 API로 반영한다(추천 적용 2026-10-14, ADR-0063). 장르별 랭킹은 저장하지 않고 분석 저장소가 매일 계산해 정적 파일로 낸다(docs/features/analytics.md §8.5).

MongoDB의 `products` 컬렉션은 상품 1건당 단일 문서로 모델링된다. 상품 유형(`type`: merch·parking·vip·fast_lane 등)에 따라 `$jsonSchema` 유효성 검증을 거치며, 동적 속성 구조(`attributes`: 속성 패턴 및 다중키 인덱스), 배송 정보(`shipping`, 판매자가 정하는 편도 배송비 포함), 반품 조건(`return_terms`: 판매자가 정하는 단순 변심 반품 배송비(편도)와 반품 받을 주소. 취소·반품 기준 자체는 PEAKET 공통이라 상품마다 두지 않는다, planning/03 POL-016 §1.4, 추천 적용 2026-10-14, ADR-0062), 양도 가능 여부(`transferable`), 티켓 연동 여부(`ticket_linked`), 한정 수량(`limited_qty`), 중개수수료율(`commission_rate_bp`: 상품을 처음 공개할 때 그 파트너의 계약 수수료율로 고정, 추천 적용 2026-10-14, ADR-0062)을 포함한다. 상품 데이터의 변경 사항은 Change Stream을 통해 실시간으로 발행되어 프론트엔드 캐시 페이지 재검증(On-demand Revalidation)을 유도한다.

## 3. Redis 키 설계 (원문 §6 'Redis 구성')

| 키 (예시) | 자료구조 | 용도 | 비고 |
| --- | --- | --- | --- |
| `q:{event:E}:seq` | 문자열 (`INCR` / `INCRBY`) | 대기열 순번 발급 카운터 | 회차 해시 태그는 이 카운터처럼 같은 Lua에서 함께 쓰는 회차 단위 키에 붙이고, 사람·토큰 단위 키(`q:dup`·`q:adm`·`q:lobby:{hash}`·`q:arr`)에는 붙이지 않아 샤드 전역에 고르게 흩는다(§1). 장애 전환 직후에는 복제 지연 중 유실되었을 수 있는 최대 발급량을 건너뛰며 대기표에 세대 번호를 각인한다. |
| `q:dup:{pid}:E` | 문자열 (`SET NX`) | 1인 1순번 중복 발급 검증(로비 참가 1인 1장 포함) | 사람(pid) 식별자 기반으로 전 샤드에 고르게 분산한다. '선점 락 획득 → 순번 발급 → 순번 기록'의 순서로 실행되며, 그 대기가 끝날 때 지우고 남은 키는 그 회차의 판매 종료(공연 시작 24시간 전 = `starts_at` - 24시간, ADR-0064) TTL로 자동 파기된다(탈퇴 계정 키 역시 표준 개인정보 보호지침 §10①에 따라 5일 이내 삭제). 판매는 온세일 윈도우가 아니라 판매 종료나 매진까지 이어지므로 윈도우 끝에 묶지 않는다(추천 적용 2026-10-14, ADR-0063 결정 11). 대기 취소·로비 참가 취소 때(ADR-0060)와 만료된 대기표의 입장 확정(410) 때 지워 같은 사람이 다시 참가할 수 있게 하고, 입장 확정(ADMITTED) 때도 지운다(그 뒤에는 `q:adm`이 다시 줄 서기를 막는다). 진입 Lua는 같은 사람 슬롯의 `q:adm`이 있으면 선점하지 않고 409 `ALREADY_ADMITTED`로 거절한다(추천 적용 2026-10-14, ADR-0062). |
| `q:lobby:{hash}` | 문자열 | 참가 토큰 해시 → 순번 매핑 (셔플 결과) | 특정 공연 태그 없이 토큰 해시 기준으로 샤드 전역에 분산 배치한다(최대 100만 건 수준). |
| `q:{event:E}:lobby_members` | Set | 로비 참가자 목록(참가 토큰 해시) | 로비 입장 때 `SADD`, 로비 참가 취소 때 `SREM`(ADR-0060). 로비 1인 1장 선점은 `q:dup:{pid}:E`가 맡는다. T=0에 리더가 목록을 고정해 셔플 전 배열(해시 오름차순)과 머클 루트를 만든다(최대 100만 건 수준). 셔플 결과 `q:lobby:{hash}`와 다른 키다. 수명은 `q:dup`과 같다(그 회차 판매 종료 TTL, 추천 적용 2026-10-20, ADR-0073). |
| `q:{event:E}:removed` | 비트맵 (125KB) | 이탈 및 취소된 빠진 번호 비트맵 | 1초 주기로 백그라운드 워커가 스캔하여 CDN 정적 구간 캐시 파일을 생성한다. 추가 검증을 통과해 복귀한 번호도 비트를 끄지 않는다(입장 확정은 `q:{event:E}:verify`로 예외 처리, ADR-0062). |
| `q:{event:E}:slots` | Sorted Set (점수 = 만료 타임스탬프) | 입장 자리 관리 | 최초 진입 사용 기한 5분을 부여하고, 구매 세션 시작 이벤트 수신 시 최대 체류 시한으로 갱신하며, 세션 종료 이벤트 수신 시 즉시 삭제한다. 만료 입장 자리는 `ZREMRANGEBYSCORE` 명령으로 일괄 정리한다. |
| `q:{event:E}:admitted` | 카운터 | 누적 및 실시간 입장 인원 계측 | 예매 단계로 통과된 사용자 총량을 실시간으로 추적한다. |
| `q:{event:E}:serving` | 문자열 | 현재 입장 번호(serving) | admission-ctrl 리더만 리더 세대를 확인하는 Lua로 전진시킨다(ADR-0056). |
| `q:{event:E}:leader` | 문자열 | 리더 세대(펜싱 토큰) | 리더가 Lease를 얻을 때 올린 `leaseTransitions`의 최댓값이다. 리더의 쓰기마다 같은 Lua에서 비교해 낮은 세대의 쓰기를 `FENCED`로 거절한다(ADR-0056). |
| `q:{event:E}:ctl` | Hash | 리더 상태 | 운영자가 정한 동시 입장 목표와 수동 고정 만료 시각, 입장 일시정지와 만료 시각, 판매 일시정지(명령 3, 만료 없음), AIMD 현재 목표. 새 리더가 이 값으로 시작한다(ADR-0056, 판매 일시정지는 ADR-0062). |
| `q:{event:E}:batch_done` | Hash | 묶음 셔플 뒤 카운터 전진 기록 | 묶음 번호를 `HSETNX`로 남기는 일과 카운터 전진을 같은 Lua에서 해 묶음마다 한 번만 전진한다(ADR-0056). |
| `q:{event:E}:batch_members:{batchNo}` | Set | 동시 도착 구간 묶음 수합(사전 검증 토큰 해시) | 오픈 직후 N초(2초 [가정]) 안의 묶음 대상 진입을 `INCR` 대신 `SADD`로 모은다(ADR-0041). 구간이 닫히면 리더가 묶음 셔플과 머클 루트에 쓰고 카운터를 묶음 크기만큼 전진한다(`q:{event:E}:batch_done`). 수명은 `q:dup`과 같다(추천 적용 2026-10-20, ADR-0073). |
| `q:{admission}:leader`, `q:{admission}:ctl` | 문자열, Hash | 회차와 무관한 리더 세대와 상태(자동 제어 긴급 정지, 전체 범위 판매 일시정지) | 회차별 키와 같은 방식으로 쓴다(ADR-0056, 판매 일시정지는 ADR-0062). |
| `q:adm:{pid}:E` | 문자열 (Lua 확인·기록) | 입장 확정 때 1인 1순번 재확인 | 값은 입장한 대기표(로비 진입자는 참가 토큰)의 해시다. 비었으면 채우고, 같은 대기표면 통과, 다른 대기표면 409로 거절하고 그 번호를 빠진 번호로 기록한다. `q:dup`과 같은 분산 규칙(사람 식별자 기준)을 따르고, 수명은 그 회차의 판매 종료(공연 시작 24시간 전 = `starts_at` - 24시간) TTL이다(입장 뒤 판매가 끝날 때까지 다시 줄 서기를 막는다. 판매 종료 뒤에는 진입 자체를 받지 않는다. 탈퇴 계정은 5일 이내 삭제, ADR-0056, 판매가 윈도우로 끝나지 않는 것은 ADR-0063 결정 11, 판매 종료 시각은 ADR-0064). |
| `q:arr:{reqId}:E` | 문자열 (`SET NX`) | 도착 시각 쿠키(`__Host-peaket_arr`)의 CloudFront 요청 ID를 한 번만 받기 | 진입 Degraded 때 queue-svc가 쿠키의 MAC·회차·시각·sid를 확인한 뒤 요청 ID로 선점한다. 이미 있으면 쿠키를 무시하고 일반 진입으로 처리한다(ADR-0053 결정 2). 요청 ID 기준으로 샤드 전역에 흩는다. 수명은 쿠키 수명과 같은 10분 [가정, Phase 2 2.2.3에서 확정](추천 적용 2026-10-20, ADR-0073). |
| `q:{event:E}:verify` | Hash | 추가 검증 격리 기록 | 필드는 대기표(로비 진입자는 참가 토큰) 해시, 값은 `VERIFYING`·`PASSED`·`REJECTED`와 시각. 격리 때 쓰고 통과·이의 인정 때 `PASSED`, 기각 때 `REJECTED`로 바꾸며, 복귀한 대기표의 대기 취소·1인 1순번 위반 때 지운다. 입장 확정은 빠진 번호라도 `PASSED`면 받는다. 수명은 `q:dup`과 같다(추천 적용 2026-10-14, ADR-0062) |
| `q:{event:E}:elig:{listKey}` | Set | 판매 자격 명단의 대기열 사본(사람 식별자) | 로비·진입 때 자격 확인. 판매 기간 끝 + 1일 TTL(추천 적용 2026-10-14, ADR-0062) |
| `s:{event:E}:bitmap` | 비트맵 (6.25KB) | 공연장 좌석 홀드 상태 비트맵 | Lua 스크립트를 통해 다중 좌석의 홀드 여부를 1회 왕복으로 원자 검사하고 설정한다. |
| `s:{event:E}:hold:{seat}` | Hash | 개별 좌석 홀드 상세 (소유자, 펜싱 토큰, 만료 시각) | 특정 좌석의 임시 홀드 소유권과 펜싱 토큰을 검증한다. |
| `s:{event:E}:expiry` | Sorted Set | 홀드 만료 시간 인덱스 | purchase-svc 내부 타이머 워커가 주기적으로 폴링하여 만료 좌석을 원자 회수한다 (BullMQ 미사용). |
| `s:{event:E}:quota:{account}` | 문자열 | 계정별 실시간 좌석 보유 수 | 원자적 쿼터 차감을 위해 좌석 비트맵과 동일 샤드에서 동일 Lua 스크립트로 처리한다. |
| `s:idem:{key}` | 문자열 | 홀드 요청 멱등성 보장 키 | 런타임 홀드 중복을 차단하며, 영구 주문 및 결제 멱등키는 PostgreSQL 원장에 기록한다. |
| `s:jti:{jti}` | 문자열 (`SET NX`) | 대기열 입장 토큰 재사용 차단 및 세션 바인딩 | 토큰 1회성 검증 후 구매 세션 ID와 상호 결합한다. |
| `s:session:{sid}` | Hash | 구매 세션 메타데이터 (유휴 만료 시한, 단말 임시 ECDH 공개키, 마지막 요청 일련번호, 기기 지문). 요청 서명 확인과 일련번호 갱신은 한 번의 원자 연산으로 한다(ADR-0050 결정 8) | 결제 완료 시까지 유지되는 런타임 세션 상태를 저장한다. |
| `s:{event:E}:stream` | Stream | 홀드 획득, 세션 시작 및 종료 이벤트 (Redis 인메모리 Outbox) | 릴레이 워커가 비동기로 컨슘하여 Kafka 토픽으로 전파한다. Kafka 전송 확인을 받은 항목까지 `XACK`한 뒤 `XTRIM … MINID`(Redis 6.2·Valkey부터)로 지우고, 키는 회차 판매 종료 + 1일 [가정] TTL로 지운다(추천 적용 2026-10-20, ADR-0070). |
| `s:{event:E}:sec:{section}` | 샤드 Pub/Sub 채널 | 구역별 좌석 홀드 상태 변경 델타 브로드캐스트 | realtime-gw 파드가 해당 구역을 보고 있는 클라이언트 접속 서버에만 선별 구독한다. |
| `id:devauth:{device_code}` [보완] | Hash | 현장 스캐너 모바일 기기 간편 승인 정보 (user_code 8자, 단말 기기 식별자, 배정 파트너, 승인 상태, 승인 계정 ID, 선택한 배정, 대리 승인 여부) | 세션·캐시 클러스터에 저장한다. 유효 수명은 5분으로 설정되며 [가정, wbs 5.5.2에서 확정], 모바일 승인 완료 또는 만료 시 즉시 파기한다(ADR-0030·0051). 승인 실패 계수는 `id:devauth:fail:{account}`(10분), 코드 발급 계수는 `id:devauth:issue:{device}`(1시간)에 둔다 |
| `scanner:enroll:{코드 SHA-256}` | 문자열 | 스캐너 기기 등록 코드(대안 B, 12자 `XXXX-XXXX-XXXX`) → 기기 ID | 값은 기기 ID다. TTL 10분 [가정, wbs 5.4.3에서 확정], 등록되면 바로 지우고 새 코드를 만들면 이전 키를 지운다. 기기 승인 코드와 같은 방식으로 세션·캐시 클러스터에 둔다. 대안 B로 갈 때만 쓴다(추천 적용 2026-10-14, ADR-0062) |
| `tr:{event:E}:devshare:{deviceRef}` | HyperLogLog | 회차별 기기 공유 수(그 기기 가명으로 사전 검증한 서로 다른 pid 수) | 세션·캐시 클러스터의 trust-svc 사용자. 사전 검증 때 `PFADD` 뒤 `PFCOUNT`, 수명 10분 [가정]. 앞서 통과한 사람은 Flink 대기 중 재평가가 다시 본다(추천 적용 2026-10-20, ADR-0071, docs/streaming.md §5.5) |
| `tr:{event:E}:asnhost:{asn}:{10초 칸}` | 문자열 (`INCR`) | 호스팅·프록시 대역 ASN의 10초 진입 수 | 같은 사용자. 만료 30초 [가정]. 통신사 대역은 세지 않는다(신호가 약하고 키가 뜨거워짐, ADR-0071) |
| `cat:suggest:{정규화한 입력}` | 문자열(JSON) | 연관 검색어 읽기 모델 캐시(최대 8개 [가정]) | 세션·캐시 클러스터의 catalog 읽기 모델 캐시 영역. 입력을 NFKC·소문자·앞뒤 공백 제거로 정규화한 값이 키이고 TTL 60초 [가정]이다. 2자 [가정] 미만과 50자 [가정] 초과 입력은 만들지 않는다. CDN 캐시 키도 같은 정규화 값만 쓴다(guidelines §9, 추천 적용 2026-10-14, ADR-0063) |
| `id:link:{proposal_id}` [보완] | Hash | 소셜 가입 시 기존 계정 연결 제안 임시 세션 (신규 제공자, sub, 검증 이메일, 대상 계정 ID, 브라우저 지문, 인증 실패 카운트) | 세션·캐시 클러스터에 저장한다. 유효 수명은 10분이며, 1회성 토큰으로 소비되어 연결 완료 또는 만료 시 즉시 삭제한다(POL-034). |
| `id:merge:{proposal_id}` [보완] | Hash | 본인인증 기반 계정 병합 제안 세션 (대표 계정 ID, 흡수 계정 ID, 이관 항목 통계 요약, 병합 차단 사유) | 세션·캐시 클러스터에 저장한다. 유효 수명은 10분이며, 사용자 최종 승인 확인 직후 삭제한다(POL-034). |

- 클러스터 환경에서 표준 Pub/Sub은 모든 브로드캐스트 메시지가 전체 클러스터 노드로 복제되어 심각한 네트워크 오버헤드를 유발하므로, Redis 7.0의 샤드 Pub/Sub(`SPUBLISH`)을 필수 채택하여 대상 샤드 노드에만 트래픽을 격리한다.
- Redis의 마스터-복제본 동기화는 기본적으로 비동기 방식으로 동작하므로 장애 조치(Failover) 시 미처 복제되지 못한 쓰기 연산이 유실될 수 있다(Redis Cluster 아키텍처 한계). 대기열 순번 발급은 세대 번호 체계로 오차를 흡수하고(1인 1순번은 입장 확정 때 사람별 입장 키로 다시 확인한다, ADR-0056), 좌석 홀드 누락은 관계형 데이터베이스의 최종 트랜잭션 검증 단계에서 무결성을 보장하도록 설계한다.
- Sorted Set 자료구조는 데이터 크기가 작고 개별 원소의 시간 정렬 처리가 필수적인 영역(입장 자리, 홀드 만료 인덱스, 지연 큐)에 한정하여 사용한다. 수백만 건의 대기열 순번 정렬에는 절대 사용하지 않는다(ADR-0002: `ZRANK` 연산은 CDN 캐싱이 불가능하며, 단일 키에 초당 수십만 조회가 집중될 경우 CPU 병목을 유발함).

## 4. 데이터별 일관성 선택과 트랜잭션 경계

| 데이터 | 일관성 모델 | 채택 사유 | 저장소 및 제어 경계 |
| --- | --- | --- | --- |
| 판매 확정 (SOLD) | 강한 일관성 (CP) | 초과 판매(오버셀) 발생 시 금전적 손실 및 법적 분쟁을 초래하므로 절대 허용할 수 없다. | PostgreSQL 활성 상태 부분 유니크 인덱스 `UNIQUE (event_id, seat_id) WHERE status IN ('PENDING','SOLD')`(§2) 및 트랜잭션 격리 |
| 좌석 홀드(Hold) | 사실상 강한 일관성 + DB 최종 검증 | 홀드 응답 지연시간 p99 50ms를 보장해야 하며, 인메모리 페일오버로 인한 홀드 누락은 DB 트랜잭션에서 흡수한다. | Redis Lua 스크립트 + `WAIT` 복제 대기, 펜싱 토큰 검증 |
| 1인당 구매 매수 제한 | 사실상 강한 일관성 + DB 최종 검증 | 매크로 및 부정 구매를 방지하는 공정 예매의 핵심 규칙이다. | Redis Lua 원자 카운터(홀드와 동일 원자 처리) + PostgreSQL 쿼터 행 조건부 갱신 |
| 대기 순번 노출 | 최종적 일관성 (AP) | 클라이언트의 폴링 주기(1~20초) 수준의 일시적 순번 지연은 사용자 경험 및 비즈니스에 무해하다. | CDN 엣지 캐싱 + 클라이언트 적응형 폴링 |
| 공연 메타데이터 | 최종적 일관성 | 쓰기 빈도가 극히 낮고 읽기 트래픽이 압도적인 도메인이다. | Next.js ISR 캐시 + Redis 읽기 모델 캐시 |
| 홈 피드·장르별 랭킹·후기 요약·연관 검색어 | 최종적 일관성 | 공개 표시용이라 수십 초~하루의 지연이 판매에 영향을 주지 않는다. 랭킹은 하루 1회 확정 숫자로 낸다. | 홈 ISR·CDN 캐시, 랭킹 정적 파일(매일 10:00 [가정]), 후기 요약 CDN 캐시, 연관 검색어 Redis·CDN 캐시(ADR-0063) |
| 관람 후기 작성 | 쓰기 때 자격 재확인 | 자격(결제자·취소 아님·공연 종료 뒤)은 ticket-svc의 현재 상태로 정한다. | core-svc review 트랜잭션 + ticket-svc 조회, 계정·회차 유일 부분 인덱스 |
| 게시물 신고·고객 문의의 CS 처리함 건 | 접수는 강한 일관성, 건 등록은 최종적 일관성 | 접수는 core-svc가 확정하고, 건 등록이 늦거나 ops-svc가 멈춰도 접수는 받는다. 같은 후기 신고는 계정당 하나다. | core-svc 트랜잭션(신고 유일 인덱스, 문의·첫 기록) + Outbox → ops-svc `cs_case`(ADR-0066) |
| 결제 원장 | 강한 일관성 + 멱등성 | 이중 승인 및 결제 누락을 막아야 한다. | PostgreSQL ACID 트랜잭션 + `Idempotency-Key` 헤더 |
| 티켓 소유권 (양도 요청·수락·돌려주기·회수·취소) | 강한 일관성 (행 잠금 + 버전 컬럼) | 이중 양도 사기와 양도·취소·스캔 사이의 동시성 경합을 막아야 한다. | PostgreSQL 비관적 행 잠금 + 낙관적 락 버전 제어 (+ 교차 리전 읽기 복제본) |
| 예매 취소 및 환불 원장 | 강한 일관성 + 멱등성 | 이중 환불 지급 및 정산 불일치를 방지해야 한다. | PostgreSQL (purchase·payment) 트랜잭션 + `cancel-{cancellationId}` 멱등키 |
| 정산서·지급(결제사 지급대행) | 강한 일관성 + 멱등성 | 지급한 돈은 결제사가 되돌려 주지 않으므로 중복 지급과 같은 미수금의 이중 상계를 막아야 한다. | PostgreSQL(payment) 트랜잭션, `ref_payout_id` 유일 제약, 결제사 멱등키(ADR-0047) |
| 관제 및 통계 지표 | 최종적 일관성 (초 단위 지연 허용) | 시스템 모니터링 및 실시간 관제는 통계적 근사치로 충분한 의사결정이 가능하다. | Apache Flink 스트리밍 파이프라인 → ClickHouse 마트, Prometheus |
| 현장 게이트 스캔 로그 | 오프라인 우선 로컬 일관성, 사후 최종 정합 | 네트워크 장애 및 통신 두절 상황에서도 게이트 무중단 입장이 보장되어야 한다. | 클라이언트 IndexedDB 로컬 기록 → 기기 인증 업로드 → 서버 판정 표(두 칸 버전 벡터: 서버 변경 일련번호, 기기 일련번호) → `scanner_change`로 다른 스캐너에 입장 상태 공유(ADR-0051) |
| 상품 카탈로그 정의 | 최종적 일관성 | 신규 상품 등록 및 수정 후 수 초 이내의 전파 지연은 운영상 지장이 없다. | MongoDB 단일 문서 트랜잭션 + Change Stream 이벤트 전파 |
| 한정 굿즈 재고 | 사실상 강한 일관성 + DB 최종 검증 | 한정판 굿즈의 초과 주문을 방지해야 한다. | Redis 원자적 재고 선차감 + 주문 확정 시 PostgreSQL 조건부 갱신 |

트랜잭션 경계 (원칙: 단일 ACID 트랜잭션은 단일 서비스의 단일 데이터베이스 경계 내로 한정함):
1. **주문 생성 및 결제 접수 (purchase)**: 주문 레코드 생성, 주문 멱등키 행(`order_idempotency`, ADR-0083) 등록, 주문 이벤트 소싱 로그 기록, Saga 오케스트레이션 개시 명령, Outbox 메시지 적재를 단일 DB 트랜잭션으로 커밋하고 즉시 HTTP 202 Accepted 응답을 반환한다. 결제 시도 생성은 이전 READY 시도의 SUPERSEDED 전이와, 결제 접수는 활성 시도의 ACCEPTED 전이와 같은 트랜잭션에 넣는다(활성 시도 부분 유니크, ADR-0044).
2. **Hard Sale 좌석 확정 (purchase)**: `seat_sale` 테이블에 PENDING 상태 행을 삽입하여 부분 유니크 제약으로 확정 예약하고, `purchase_quota`를 조건부 갱신하며, 주문 상태 전이 이벤트를 원자 기록한다. 결제 승인 실패 또는 결제 제한 시간 만료 시 PENDING 행을 삭제하고 해제 이벤트를 발행한다. 가상계좌는 승인 응답이 입금 대기면 PENDING을 입금 기한 + 10분 [가정]까지 두고 입금이 확인되면 SOLD로 바꾸며, 입금 오류로 결제사가 입금을 되돌리면 SOLD를 PENDING으로 되돌린다(planning/03 §2.3·§2.4, 추천 적용 2026-10-14, ADR-0062).
3. **결제 승인 처리 (payment)**: `payment` 레코드 상태 전이, `payment_event` 기록, Outbox 적재를 단일 트랜잭션으로 처리한다. `payment` 행을 처음 만드는 트랜잭션에는 `payment_per_order` 행을 함께 넣어 주문당 결제 1건을 지킨다(결제 표는 월 파티션이라 `order_id` 유일 제약을 직접 걸 수 없다, ADR-0083). 외부 PG사 웹훅 수신은 `webhook_receipt` 테이블에 PG사별 고유 식별자(토스 `transmission_id`, 포트원 이벤트 유형·`paymentId`·`timestamp`) 기반 유니크 제약을 적용하여 같은 식별자로 다시 온 웹훅은 한 번만 처리한다. 토스 문서는 재전송 때 전송 ID가 같은지 밝히지 않으므로, 식별자가 다른 중복은 결제 상태를 단건 조회 API 결과로만 바꾸는 규칙이 결과를 바꾸지 않게 한다(docs/features/payment.md §5). 웹훅이 들어온 경로의 결제사와 결제 기록의 결제사가 다르면 반영하지 않는다(ADR-0044).
4. **티켓 발권 및 키 바인딩 (ticket)**: `ticket` 엔티티 생성은 발권 때, 첫 `device_key` 등록은 팬이 '입장용 휴대폰 등록'을 누를 때 하고(ADR-0051), 키 등록·폐기는 같은 트랜잭션에서 `scanner_change`에 변경을 적는다. 티켓 양도 트랜잭션은 `SELECT … FOR UPDATE`를 통한 행 잠금과 `version` 낙관적 락을 적용하며, 신규 수신자의 공개키 등록과 기존 기기 키의 `revoked_at` 설정을 단일 트랜잭션으로 완결한다.
5. **굿즈 주문 및 재고 확정 (core shop)**: Redis에서 가용 재고를 원자 차감한 뒤, 결제 승인 직전에 PostgreSQL `product_stock` 테이블을 조건부 갱신(`stock >= quantity`)하고 `merch_order` 레코드를 생성한다.
6. **운영 제어 명령 (ops)**: `command_event` 테이블에 명령 이벤트를 append-only 방식으로만 기록한다(이벤트 소싱 아키텍처 및 주기적 상태 스냅샷). 이는 불변 감사 로그와 동일 저장소에 영구 보존된다. 같은 트랜잭션에서 `audit_chain`에 키 건 해시 체인 행을 더하고 5분마다 마지막 값을 S3 Object Lock에 앵커로 남겨, 명령 기록을 고치거나 지우면 검증에서 드러나게 한다(ADR-0053). 행마다 비공개 잎 솔트를 함께 쓰고, 매일과 회차 마감에 감사 체크포인트(`audit_checkpoint`)를 만들어 서명하고 공개 타임스탬프에 고정해 게시한다(ADR-0075). 입장 일시정지 연장(`EXTENDED`)과 명령 11 사후 검토(`POST_REVIEW_SUBMITTED`·`POST_REVIEW_CONFIRMED`)는 같은 command_id의 이벤트로 더한다(추천 적용 2026-10-14, ADR-0062).
7. **트랜잭셔널 아웃박스 릴레이**: 프로덕션 표준은 Debezium 기반 CDC 릴레이를 채택하고, 로컬 개발 및 초기 버전(v0)에서는 `FOR UPDATE SKIP LOCKED` 기반의 주기적 폴링 릴레이를 운용한다. Redis 인메모리 원본 이벤트(좌석 홀드, 구매 세션 개시 및 종료)는 Redis Stream 전용 릴레이 워커가 Kafka 토픽으로 브리지한다. 정리 규칙(추천 적용 2026-10-20, ADR-0070):
   - CDC 릴레이에서는 Outbox 행을 INSERT만 하고 고치지 않는다. Debezium Outbox 라우터는 UPDATE를 받지 않고 DELETE는 걸러 낸다.
   - Outbox 표는 ID(UUIDv7) 범위로 하루씩 나누고(기본 키 `id`, 7일 앞까지 미리 만듦, ADR-0083), 3일 [가정] 지난 파티션을 정비 시간(04:00~06:00)에 떼어 지운다. 지우기 전에 CDC 커넥터가 그 파티션을 지났는지(커넥터 지연 1일 미만) 확인한다. 로컬·v0 폴링 릴레이는 보낸 행에 보낸 시각을 쓰고 같은 파티션 규칙으로 지운다.
   - CDC 복제 슬롯이 붙잡은 WAL이 10GB [가정]를 넘거나 슬롯이 30분 [가정] 넘게 비활성이면 SEV2다(docs/observability.md §5). PostgreSQL `max_slot_wal_keep_size`의 기본값은 한도가 없어 커넥터가 멈추면 WAL이 계속 쌓인다. 이 설정은 AWS의 Aurora PostgreSQL 매개변수 목록에 있다(2026-10-22 확인, 기본값 없음). 바꿀 수 있는지(`describe-db-cluster-parameters`의 `IsModifiable`)와 값은 wbs 0.3.2에서 정하고, 정하면 위 경보 기준보다 크게 둔다. 넘으면 슬롯이 무효가 되어 커넥터가 이어 읽지 못하기 때문이다(ADR-0083).
   - Debezium은 `publish.via.partition.root=true`로 두어 일 파티션의 변경을 부모 표 이름으로 내보낸다. 기본값(false)이면 파티션마다 그 이름으로 나가 커넥터의 수집 표 목록·라우팅과 어긋난다(추천 적용 2026-10-22, ADR-0083).
   - 연결 풀 유휴 회수와 DB·Redis 시간 초과 기본값은 docs/architecture.md §5 '시간 초과 기본값'을 따른다. 세션 `idle_session_timeout`은 연결 풀과 맞지 않아 쓰지 않는다.
8. **예매 취소 오케스트레이션 (purchase → ticket → payment)**: purchase 서비스에서 `order_cancellation` 등록, 주문 이벤트 기록, Outbox 적재를 단일 트랜잭션으로 수행한다. 이어 ticket 서비스가 티켓 키를 폐기하고 상태를 변경(행 잠금 + 버전 검증)한 뒤, purchase 서비스가 `seat_sale`을 RETURNED 상태로 전이하고 쿼터를 복구하며 Redis 비트맵을 복원한다. 최종적으로 payment 서비스가 PG사 결제 취소 API를 호출하고 `payment_cancel`을 기록한다. 단, 현장 입장 시작 이후 접수된 취소 건은 악의적 입장 후 환불을 방지하기 위해 최종 결제 취소 단계를 입장 기록 마감(docs/features/offline-gate.md §7.3) 뒤로 유예한다(POL-032, ADR-0051 결정 13).
9. **계정 병합 오케스트레이션 (identity → 각 분산 서비스)**: identity 서비스에서 흡수 대상 계정 상태를 MERGED로 변경하고, 소셜 로그인 제공자 연동(`account_provider`)을 이관하며, `account_merge` 이력 기록 및 Outbox 메시지 발행을 단일 트랜잭션으로 완결한다. 이후 각 분산 서비스는 `identity.accounts-merged` 이벤트를 수신하여 자체 DB 내 `account_id` 외래키를 대표 계정 ID로 멱등하게 갱신한다. 특히 ticket-svc는 티켓 소유권 변경과 흡수 계정의 기기 키 폐기 처리를 비관적 행 잠금 기반으로 엄격히 수행한다(POL-034).
10. **양도 수락·돌려주기·회수 (ticket)**: 티켓 행 잠금 안에서 양도 요청 상태와 기한을 다시 확인하고, 보유자 변경, 새 기기 키 등록, 이전 키 폐기, `transfer_offer` 상태 전이, Outbox 적재를 단일 트랜잭션으로 처리한다(ADR-0046).
11. **승인 업무 실행 (ops → purchase·ticket·payment)**: ops 서비스에서 `approval_request` 상태를 EXECUTING으로 바꾸고 감사 이벤트와 Outbox를 같은 트랜잭션에 쓴다. 대상 서비스는 승인 ID를 멱등키로 쓰므로 재전달돼도 한 번만 반영되고, 실패하면 Failed와 CS 처리함 건이 남는다. 원인을 고친 뒤 승인자가 같은 approve를 다시 부르면(재인증) 같은 승인 ID로 다시 실행하고 새 경로는 두지 않는다(추천 적용 2026-10-20, ADR-0073).
12. **일괄 환불 작업 (purchase → payment)**: 주문마다 `order_cancellation`을 만들고 `cancel-{cancellationId}`로 결제사 취소를 호출한다. 진행 수와 실패 수는 `event_cancellation_request`에 모은다. 작업이 멈췄다가 재개돼도 주문 단위 멱등키 때문에 중복 환급이 생기지 않는다.
13. **정산서 확정과 지급 요청 (payment)**: 정산서 확정, 미수금 상계(행 잠금), 지급 건 생성(`ref_payout_id` 유일), Outbox 적재를 단일 트랜잭션으로 처리한다. 결제사 지급 요청은 승인된 지급 묶음에 대해서만 같은 멱등키로 보내고, 오류 응답이면 키를 바꿔 재전송하지 않는다. 상태는 서명을 확인한 웹훅과 단건 조회(토스페이먼츠) 또는 지급 내역 조회(포트원)로만 바꾼다(ADR-0047).
14. **스캔 수신과 입장 판정 (ticket)**: 업로드된 스캔 기록마다 클라이언트 ID로 멱등 저장하고, 티켓 행 잠금 안에서 판정 표(offline-gate §7.1)를 적용해 입장 상태를 갱신하고, 이상 표시(`gate_flag`)와 변경 기록(`scanner_change`, 회차별 일련번호)을 같은 트랜잭션에 쓴다. 세션 유효 여부는 identity의 세션 시각으로 판정한다. 입장 기록 마감은 별도 작업으로 `event.entry_closed_at`을 정하고 취소 접수 티켓의 환급·이상 표시를 Outbox로 넘긴다(ADR-0051).

## 5. 동시성 제어가 필요한 지점

| 동시성 경합 지점 | 제어 메커니즘 | 검증 및 보증 수단 |
| --- | --- | --- |
| 동일 인기 좌석에 대해 1,000명의 사용자가 동시 홀드 시도 | Redis Lua 스크립트 기반 원자적 비트맵 검사 및 설정, 단조 증가 펜싱 토큰 발급, 다중 좌석 요청 시 좌석 ID 오름차순 정렬 잠금 | K2 불변식 자동 검사기 |
| 계정 병합 처리 도중 해당 계정의 동시 로그인 및 신규 주문 인입 | 흡수 대상 계정에 대한 비관적 행 잠금(`FOR UPDATE`) 적용 및 MERGED 상태 검증, 진행 중인 활성 구매 세션이나 결제 대기 주문이 존재할 경우 병합 요청 거부, 서비스별 데이터 이관은 고유 `merge_id` 멱등키로 제어 | identity 통합 테스트 (I-T31·I-T32) |
| 동일 사용자가 여러 브라우저 탭 및 기기에서 동시 홀드를 시도하여 1인 예매 한도 초과 | 동일한 Lua 스크립트 트랜잭션 내에서 현재 보유 수와 요청 수량의 합산 검증, 최종 DB 주문 생성 시 쿼터 원장 행 조건부 갱신(`used + qty <= limit`) | K2 카오스 검증 ('1인 예매 한도 초과 0건' 달성) |
| 오픈 직후 대기열 순번 발급 트래픽 초당 20만 건 폭주 | 단일 Redis 키 대상 `INCR` 연산 적용, 한계 도달 시 파드 단위 1~2ms 버퍼링 배치 `INCRBY` 기법 적용 | K1 벤치마크, PoC 실측 평가 |
| 1인 1순번 보장 및 중복 발급 차단 | `SET NX` 기반 선점 락 획득 → 순번 카운터 증가 → 계정별 순번 기록 3단계 원자 파이프라인 적용. 클라이언트 재시도로 인해 발생한 누락 번호는 빠진 번호 비트맵에 영구 기록. 장애 전환으로 선점 키가 사라져 나간 두 번째 순번은 입장 확정 때 사람별 입장 키로 막는다(ADR-0056) | K1 순번 연속성 및 오차율 계측, Q-T31 |
| 동시 입장 목표 제어 | admission-ctrl 리더 파드만 서빙 번호(serving)를 전진시키며 200ms 주기로 활성 구매 세션 빈자리를 재계산. 빈자리 소진 시 클라이언트에 '곧 입장' 대기 상태 반환 | ADR-0005 |
| 컨트롤러 이중화 시 리더 중복 발생 (두 파드가 동시에 serving 번호를 갱신하는 스플릿 브레인) | Kubernetes Lease 기반 분산 리더 선출 체계 적용, 제어 명령 실행 직전 Lease 갱신 상태 재검증, 대기열 Redis 쓰기마다 리더 세대(Lease `leaseTransitions`)를 확인해 옛 리더의 쓰기 거절(ADR-0056) | 33장 분산 리더 강제 종료 카오스 실험, Q-T30 |
| Redis 마스터 장애 조치(Failover) 직후 복제 누락으로 인한 순번 중복 발급 위험 | 신규 승격 마스터에서 카운터 값을 보수적 안전 여유치만큼 일괄 전진시키고 발급 대기표에 신규 세대 번호 부여 | FIS (AWS Fault Injection Simulator) 장애 주입 시험(포트폴리오 기간에는 로컬 Redis 주 노드 강제 종료, docs/verification.md §5.3) |
| 동일 주문에 대한 결제 승인 중복 호출 | 결제 대행사 호출 시 `Idempotency-Key: confirm-{orderId}` 헤더 전달, 승인 불명 시 UNKNOWN 상태 전이 및 결제 단건 조회 API 기반 사후 정합성 해소 | K7 결제 무결성 검증 |
| 결제 대행사 웹훅의 중복 및 역순 도달 | PG사별 결제 식별자 기반 `webhook_receipt` 유니크 제약(토스 `transmission_id`, 포트원 이벤트 종류·`paymentId`·`timestamp`) 적용 | K7, 결제 단위 테스트 (P-T17) |
| 동일 티켓에 대한 이중 양도 사기, 양도 수락과 기한 만료·철회의 경합 | PostgreSQL `SELECT … FOR UPDATE` 행 잠금 및 `version` 컬럼 기반 낙관적 락 검증 병용, 잠금 안에서 기한 재확인 | E2E 동시성 시나리오 테스트 |
| 동일 티켓에 대한 취소, 양도, 게이트 스캔이 동시 경합 | 비관적 행 잠금 및 버전 컬럼으로 데이터베이스 우선순위 정렬, 입장 시작부터 마감까지 돌려주기·양도 수락·회수 금지(ADR-0051), 오프라인 스캔이 늦게 올라오면 '취소 뒤 입장' 이상 표시 | E2E, 현장 오프라인 테스트 (O-T16, O-T22) |
| 취소 처리 중복 및 이중 환불 발생 | `cancel-{cancellationId}` 멱등키 적용, 포트원의 경우 잔여 취소 가능 금액 일치 여부 사전 검증, 응답 타임아웃 시 3시간 경과 후 결제 상태 단건 조회 후 재전송 | 결제 단위 테스트 (P-T21) |
| 같은 승인 업무에 승인 두 번, 요청자 본인 승인 | `approval_request` 승인자 중복 금지와 요청자 제외를 서버가 검사하고 상태 전이에 버전을 쓴다 | R-T6·R-T7 |
| 같은 미수금을 두 정산서가 동시에 상계, 같은 정산서의 지급 요청 중복 | `partner_receivable` 행 잠금(`FOR UPDATE`) 안에서 남은 금액을 확인해 상계, 정산서당 지급 묶음 하나와 `ref_payout_id` 유일 제약, 결제사 멱등키 고정 | J-T5·J-T11 |
| 오프라인 단절 상황에서 복제 티켓의 중복 입장 시도 | 티켓별 지정 게이트 구역 통제(사전 예방), 변경분으로 입장 상태 공유(온라인 스캐너는 두 번째 입장 거부), 업로드 뒤 서버 판정 표로 중복 입장 이상 표시. 올라오지 않은 기록은 찾지 못함(ADR-0051) | K10 오프라인 정합성 검증 (O-T2, O-T23) |
| 다중 좌석 예매 시 DB 트랜잭션 간 데드락 발생 (Degraded 비상 우회 경로) | 좌석 고유 ID 오름차순 정렬 잠금 강제화 및 트랜잭션 첫 문장의 `SET LOCAL lock_timeout = '100ms'` [가정](트랜잭션이 끝나면 사라져 PgBouncer 트랜잭션 풀링에서도 다음 사용자에게 남지 않는다. 잠금을 얻지 못하면 409 `seat-already-held`, 추천 적용 2026-10-22, ADR-0083) | K3 비상 예매 경로 스트레스 테스트 |
| Degraded 비상 예매 경로에서 좌석 상태 UPDATE 과다로 인한 성능 저하 | `seat_hold`·`seat_sale`의 `status` 전이는 부분 유니크 인덱스의 조건 열을 바꿔 HOT(Heap-Only Tuples) 갱신이 되지 않는다(PostgreSQL 18 `relcache.c`가 인덱스 조건 열을 HOT를 막는 열에 넣음). `fillfactor`는 인덱스 밖 열만 바꾸는 갱신(`purchase_quota.used` 등)에 쓰고, `seat_hold`는 표별 `autovacuum_vacuum_scale_factor`를 0.02 [가정](기본 0.2)로 낮춰 청소를 앞당긴다(추천 적용 2026-10-22, ADR-0083) | K3 데이터베이스 부하 튜닝(죽은 행 수·인덱스 크기) |

데이터베이스 인덱스는 활성 판매의 유일 부분 인덱스 `seat_sale (event_id, seat_id) WHERE status IN ('PENDING','SOLD')`(§2), 홀드 원장의 활성 홀드 유일 부분 인덱스 `seat_hold (event_id, seat_id) WHERE status = 'HELD'`, 좌석 Redis 장애 때 대체 경로가 잠그는 `event_seat_price (event_id, seat_id)` 기본 키(회차·좌석마다 한 행이라 좌석 ID 순으로 `FOR UPDATE`한다, docs/features/seat-hold.md §9), 공연명 및 아티스트 검색 최적화를 위한 `pg_trgm` 삼중자 인덱스를 표준으로 구축한다. 트랜잭션 격리 수준 실험(READ COMMITTED, REPEATABLE READ, SERIALIZABLE 환경에서의 쓰기 스큐 재현)을 통해 어플리케이션 계층의 비즈니스 로직에만 의존하지 않고 데이터베이스 물리 유니크 제약을 최종 안전 방어선으로 설정한 설계 타당성을 입증한다.

- 알려진 한계(2026-10-22, ADR-0083): `pg_trgm`은 3글자 조각을 뽑지 못하는 패턴이면 인덱스 전체를 훑으므로, '공연'처럼 두 글자 검색어는 삼중자 인덱스를 제대로 쓰지 못한다. 공연 목록이 작아 지금은 받아들이고, 부하 시험에서 느리게 재지면 검색 방식을 새 ADR로 다시 본다. 두 글자 조각 확장(pg_bigm)은 Aurora PostgreSQL 지원 여부를 확인하지 않았다.

## 6. 개인정보·민감 정보의 암호화와 보존·파기

본 절의 원본 정책은 `docs/security/data-classification.md`(보호 등급 P1~P3 체계, 항목별 등급·보존 시한·법적 근거)와 `docs/security/secrets-and-keys.md`(암호화 키 라이프사이클)에 명시되어 있다. 본 절에서는 각 데이터 요소의 저장 암호화 방식과 보존·파기 라이프사이클을 요약 기술한다.

| 데이터 항목 | 저장 암호화 방식 | 법적 보존 시한 및 파기 정책 |
| --- | --- | --- |
| 관리자 계정 비밀번호, 비상 복구 코드 | PBKDF2-HMAC-SHA256 결과에 KMS HMAC 페퍼(관리 계정 ID 결합)를 건 PHC 문자열 (반복 횟수 600,000회 이상, 알고리즘 파라미터와 페퍼 키 버전이 포함되어 향후 전환 시 로그인 때 점진적 재해시 지원. ADR-0033, ADR-0050) | 관리자 계정 삭제 시 즉시 파기 |
| MFA TOTP 시드 | AES-256-GCM 기반 AWS KMS 봉투 암호화 적용 (인증 시 복호화 필요) | MFA 등록 해제 또는 계정 삭제 시 즉시 파기 |
| 세션 토큰, 리프레시 토큰 | 데이터베이스 원문 저장 금지, SHA-256 단방향 해시값만 저장 (원문은 HttpOnly 세큐어 쿠키로 단말 보관) | 세션 만료 또는 명시적 로그아웃 시 즉시 삭제 |
| 본인확인 연계정보 (CI) | AWS KMS HMAC 키 기반 HMAC-SHA256 해시값 + 키 버전 저장(본인확인 때 보존 중인 모든 키 버전으로 중복 조회). pid는 별도 KMS HMAC 키로 본인확인 때 한 번 계산해 키 버전과 함께 저장하고, 발급된 JWT 액세스 토큰에는 이 pid만 포함(ADR-0050) | 회원 탈퇴 시 즉시 영구 파기 (재가입 방지 목적의 보관 일체 금지, POL-033). 단, 본인인증 수집 출처·일시·목적·대상자 메타데이터는 1년 이상 보존 |
| 일반 개인정보 (성명, 전화번호, 이메일, 배송지 주소 등 P2 등급) | 스토리지 레벨 AWS KMS 암호화(EBS/RDS KMS 암호화) 적용, 어플리케이션 로그 출력 시 pino redact 기반 마스킹 강제 | 주문·결제 기록은 전자상거래법에 의거 5년 보존, 소비자 불만 및 분쟁 해결 기록은 3년 보존. 회원 탈퇴 시 운영 DB에서 분리 보관 후 법정 시한 도래 시 영구 파기 |
| 시스템 접속기록 (접속 일시, 접속 IP 주소, 단말기 정보) | 전용 접속기록 저장소에 스토리지 암호화 적용. 일 단위 해시 앵커(그날 접속기록 파일 목록과 SHA-256을 감사 앵커 버킷 S3 Object Lock에 남김)로 변조를 찾는다(추천 적용 2026-10-20, ADR-0073) | 최소 3개월 보존 (통신비밀보호법 시행령 §41②2호 준용, 전기통신사업자 간주 POL-025) |
| 보안 사고·신고·통지 기록, 접속기록 점검 기록 (`security_incident`, `incident_filing`, `access_review`, `access_finding`) | ops-svc 감사 저장소, 스토리지 암호화와 WORM 사본 | 관리 계정 접속기록과 같이 2년 이상 보존 [가정, wbs 7.4.1 내부 관리계획 작성에서 확정]. 개인정보 원문은 넣지 않고 대상 수와 요약만 남긴다(ADR-0049) |
| 사용자 행동 신호 원시 데이터 | ClickHouse 시계열 테이블 TTL 적용 | 수집 후 30일 경과 시 자동 파기. S3 장기 보존 영역에는 식별자 없는 비식별 집계 데이터만 이관 |
| 봇 의심 판정 라벨 (허니팟 적중, 표본 검토, 사후 이상 탐지 라벨) | ClickHouse 시계열 테이블 TTL 적용 | 30일 경과 후 세션 ID를 완전히 제거하고 봇 탐지 등급별 통계 집계치만 보존 (FR-049) |
| 분석 저장소 가명 사건 (브론즈·실버: 순번·입장·홀드·주문·결제·발권·봇 판정 사건) | ClickHouse 분석 DB 전용 TTL. 식별값은 적재 때 회차별 가명(HMAC, 분석 가명 키)으로 바꾸고 이름·연락처·연계정보·IP·결제 토큰은 싣지 않는다. 가명 키는 KMS에 두고 원본 적재 잡만 쓴다(ADR-0052) | 가명정보 처리 기간 90일(개인정보 보호법 §28의4②) 경과 시 파기. 2년 보존하는 골드와 영구 보존하는 Iceberg 아카이브에는 사람 단위 행을 두지 않음(ADR-0042·0052) |
| 가명정보 처리 기록 (`pseudonymization_log`) | ops-svc 감사 저장소, 스토리지 암호화와 WORM 사본. 개인정보 원문은 넣지 않고 목적·항목·회차·키 버전·이용 내역만 남긴다 | 가명정보를 파기한 날부터 3년 이상(개인정보 보호법 §28의4③, 시행령 §29의5②) |
| 결정 기록 (`decision_record`) | ops-svc 논리 DB, 스토리지 레벨 암호화. 분석 요약에 개인정보를 쓰지 않는다 | 결정이 유효한 동안 유지하고, 철회·대체된 기록은 5년 [가정] 뒤 파기(자체 기준, POL-040) |
| 수사기관 제공 대장 및 통신자료 요청서 | 감사 로그 전용 저장소 (WORM 사본과 키 건 해시 체인으로 변조 탐지, ADR-0053) | 통신사실확인자료 제공 대장은 7년 보존, 통신이용자정보 제공 대장은 1년 보존 |
| 관리자 계정 접속 로그 및 시스템 권한 변경 이력 | 감사 로그 전용 저장소 | 관리자 접속 기록은 2년, 관리자 권한 부여 및 회수 이력은 3년 이상 보존 |
| 감사 기록 잎 솔트(`audit_chain.leaf_salt`)와 공개 감사 체크포인트(`audit_checkpoint`) | 잎 솔트는 감사 저장소(스토리지 암호화)에만 둔다. 체크포인트에는 해시·번호·건수·시각·서명·공개 타임스탬프 증명만 있고 공개 게시 버킷(S3 Object Lock 컴플라이언스 7년)에 게시한다(ADR-0075) | 잎 솔트는 그 감사 기록과 같은 보존 기간이 지나면 기록과 함께 파기한다. 체크포인트는 7년 보존 |
| 주민등록번호, 신용카드 번호, 은행 계좌번호, 생체 인식 정보 | 주민등록번호·신용카드 번호·생체 인식 정보는 받지 않는다. 은행 계좌번호는 환불·배상·정산 때 받아 결제사·송금 요청에 바로 넘기고 저장하지 않는다(아래 '환불·배상·정산 계좌' 행). 결제사가 입금용으로 발급한 가상계좌 번호는 이용자의 계좌가 아니며 아래 '가상계좌 입금 안내' 행을 따른다 | 일체 저장하지 않음 |
| 모바일 월렛 기기 개인키 | 클라이언트 브라우저 WebCrypto API 추출 불가(non-exportable) 키로 브라우저 프로필에 저장(하드웨어 보관 아님, ADR-0050 결정 1), 서버에는 단말 공개키만 등록 | 티켓 재발급, 양도, 돌려주기, 회수, 예매 취소 시 즉시 폐기 목록에 등록. 재발급은 입장 시작 전 재인증 뒤 티켓당 24시간에 1회, 입장 시작 뒤 현장 부스만 |
| 현장 스태프 초대 이메일 | 별도 필드 암호화 없이 스토리지 레벨 암호화(P2) 적용 | 초대 수락이 완료되거나 초대 유효기간 만료 시 즉시 영구 파기 |
| 현장 스태프 권한 배정 이력 (계정 ID, 할당 역할, 유효 시간대) | 스토리지 레벨 암호화(P2) 적용 | 해당 공연 회차 종료 시점으로부터 1년간 보존 (현장 스캔 및 입장 분쟁 소명 대응용 자체 기준). 스캔 기록 속 스태프 계정 ID도 같은 1년 뒤 지운다(ADR-0051) |
| 부스 본인확인 대조 기록 (계정 ID, 티켓 ID, 일치 여부, 시각) | 스토리지 레벨 암호화(P2). 연계정보 원문은 받자마자 버리고 `ci_hmac` 대조 결과만 남긴다 | 공연 회차 종료 뒤 1년 [가정] (부스 재발급 분쟁 소명용 자체 기준) |
| 예매 취소 및 환불 집행 기록 | 스토리지 레벨 암호화(P2) 적용 | 전자상거래법 시행령 §6①2·3에 의거 계약·청약철회 및 대금결제에 관한 기록으로 5년간 보존 |
| 환불·배상·정산 계좌 | 저장하지 않음. 결제사 취소·송금·지급대행 등록 요청에 바로 넘기고 은행·끝 4자리와 결과만 남긴다(POL-014, POL-039) | 끝 4자리와 송금 결과는 배상 지급 기록으로 5년 보존 |
| 가상계좌 입금 안내 (`payment.deposit_due_at`·`virtual_account_no`) | 결제사가 입금용으로 발급한 번호이고 이용자의 은행 계좌번호가 아니다. 필드 암호화(AES-256-GCM, 보수적으로 P1 기준), 원문 로그 금지 | 입금 확정·입금 기한 만료 때 삭제(입금 secret 해시와 같은 수명, ADR-0050 결정 4, 추천 적용 2026-10-14, ADR-0062) |
| 판매 자격 명단 (`sale_eligibility_list`·`sale_eligibility_member`, 대기열 Redis 사본) | 스토리지 레벨 암호화(P2). 올린 파일은 저장하지 않고 회원 코드를 계정 ID로 바꾼 집합만 둔다. 감사 로그에는 올린 계정·시각·건수·파일 SHA-256만 남긴다 | 판매 기간 끝 + 1일 [가정]에 DB·Redis에서 파기(추천 적용 2026-10-14, ADR-0062) |
| 미성년자 계약 취소 확인 기록 | 스토리지 레벨 암호화(P2). 계정 ID·주문 ID·확인 방법·결과(계약 당시 만 19세 미만 여부)·확인 일시·확인한 서류 종류와 확인자만 남기고 생년월일·연계정보·서류 사본은 저장하지 않는다 | 취소 기록과 함께 5년(전자상거래법 시행령 §6①2호, 추천 적용 2026-10-14, ADR-0062) |
| 알림 발송 기록 (`notification_delivery`) | 스토리지 레벨 암호화(P2). 중복 키·종류·대상 ID·계정 ID·채널·상태·시각·발송 대행 메시지 ID만 두고 받는 주소·전화번호·본문은 넣지 않는다 | 90일 [가정] 뒤 파기. 법정 통지를 보낸 사실은 그 건의 처리 기록에 따로 남는다(추천 적용 2026-10-14, ADR-0062) |
| 정산서·지급 묶음·지급 건·미수금 | 스토리지 레벨 암호화(P2) | 전자상거래법 시행령 §6①3호의 대금결제 기록으로 5년 보존(ADR-0047) |
| 관람 후기 (`review`: 작성 계정, 회차, 자격 근거 주문, 별점, 본문) | 스토리지 레벨 암호화(P2). 공개 응답에는 닉네임 첫 글자와 '**', 관람 회차 일시, 별점, 본문만 싣는다(추천 적용 2026-10-14, ADR-0063) | 작성자가 지우거나 회원 탈퇴 때 파기. 통보로 숨긴 후기의 법정 차단 조치 증적(`takedown_action`)은 3년 보존 |
| 후기 사진 (`review_image`: 파생본 2종, 사진 설명) | 공개 데이터. 원본은 비공개 격리 위치에서 검사·다시 인코딩한 뒤 바로 지우고 원본 키를 두지 않는다. 파생본은 메타데이터(촬영 위치 포함)를 지운 공개 정적 객체다. 입장 QR·바코드가 보이는 사진은 받지 않는다(추천 적용 2026-10-19, ADR-0066) | 후기와 같은 수명(후기를 지우면 함께 지우고 가리면 함께 가린다). 붙이지 않은 사진은 24시간 [가정] 뒤 삭제 |
| 게시물 신고 (`content_report`: 신고 계정, 사유, 자세한 내용, 권리 침해 본인 여부, 결과 받을 곳) | 스토리지 레벨 암호화(P2), 로그에 내용 출력 금지. 신고자는 글쓴이·다른 팬·파트너에게 보이지 않는다. 신고 처리 조치(`takedown_action`)에는 신고자 정보를 넣지 않는다 | 처리가 끝나고 1년 [가정] 뒤 파기(자체 기준, 추천 적용 2026-10-19, ADR-0066) |
| 고객 문의 (`inquiry`·`inquiry_message`: 문의한 계정, 유형, 관련 주문, 제목, 내용, 추가 문의, 답변·진행 경과) | 스토리지 레벨 암호화(P2), 로그에 내용 출력 금지. 첨부 파일은 받지 않고, 민감한 내용과 계좌번호는 적지 않아도 된다고 화면에서 안내한다. 담당자 개인 식별자는 ops-svc 감사 기록에만 둔다 | 닫힌 뒤 3년 경과 시 자동 파기(전자상거래법 시행령 §6①4호의 소비자 불만·분쟁 처리 기록. 일반 문의까지 이 기록으로 보는 것은 해석, POL-027, 추천 적용 2026-10-19, ADR-0066) |
| 홈 구성 (`home_banner`·`home_theme`, 배너 이미지) | 스토리지 레벨 암호화. 이용자 개인정보는 없고 작성 운영자 관리 계정 ID만 남는다. 출연자 사진이 든 배너는 docs/security/data-classification.md의 '홈 배너 이미지와 대체 텍스트, 공연 포스터·상세 이미지' 행과 법률 질문 23번을 따른다 | 노출 기간이 끝나고 30일 [가정] 뒤 이미지 파생본을 지운다. 구성 변경 이력은 감사 로그(관리 계정 작업, 2년 이상)에 남는다(추천 적용 2026-10-14, ADR-0063) |
| 승인 업무·CS 처리함 기록(요청자, 승인자, 사유 코드, 확인한 증빙 종류) | 감사 로그 전용 저장소 | 분쟁 처리 기록으로 3년 보존(전자상거래법 시행령 §6①4호. 중개자는 자기 시스템으로 처리한 기록을 보존한다, 같은 항 단서). 증빙 내용과 진단서는 저장하지 않는다 |
| 소명 본문 | 스토리지 레벨 암호화(P2) 적용 | 처리 완료 뒤 3년(분쟁 처리 기록과 같은 기준) 경과 시 자동 파기(ASVS 14.2.7) |
| 판매자 신원정보(파트너 사업자) | 스토리지 레벨 암호화(P2). 개인사업자 대표자 성명은 개인정보로 다룬다 | 파트너 계약 종료 뒤 5년(계약 기록) |
| 계정 연동 및 계정 병합 기록 (대표·흡수 계정 ID, 연동 제공자 유형, 이관 항목 통계, 승인 일시) | 스토리지 레벨 암호화(P2) 적용 | 대표 계정이 존속하는 기간 동안 유지. 대표 계정 탈퇴 시 계정 원장과 함께 파기 (자체 기준). 흡수된 계정의 원본 이메일 및 닉네임은 병합 완료 즉시 영구 파기 (POL-034) |

개인정보 및 거래 데이터의 법정 보존 시한 도래 후 파기는 PostgreSQL 월 단위 테이블 파티션 DROP(주문·결제·티켓. UUIDv7 ID 범위 파티션이고, 결제 파티션을 지울 때 같은 범위의 `payment_per_order` 행을 함께 지운다. 주문 멱등키 표 `order_idempotency`의 행은 24시간 [가정] 뒤 지운다, ADR-0083), ClickHouse TTL 자동 만료, 그리고 정기 배치 작업의 다단계 파기 파이프라인을 통해 집행되며, 파기 결과는 별도의 법정 파기 관리 대장에 영구 기록된다(FR-044).

