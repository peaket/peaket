# 제안: 차단기·구매 요청 인증 훅·gRPC 채널 생성 함수(wbs 0.3.3, BUILD_ORDER FND-100)

## Why

서비스 템플릿(`packages/platform`)은 FND-090까지 요청 받기·검사·멱등·Outbox·Kafka·정비를 갖췄다. 그러나 서비스가 다른 서비스나 외부 제공자를 부를 때의 장애 격리와, 구매 세션 쓰기 요청의 소지 증명 확인이 아직 없다. v0(wbs 1.1.x)과 첫 서비스가 이 셋에 기대므로 최소 기반에서 먼저 만든다(wbs §1 '실행 방식').

- 서비스 안 2차 차단기(ADR-0009 결정 2·5): 의존성마다 opossum 차단기와 동시 호출 상한(벌크헤드), 열림·반 열림·닫힘 상태와 끊은 수를 지표로 낸다. 서비스마다 다르게 짜면 실패로 세는 것과 문턱이 달라진다.
- 구매 요청 인증 훅(ADR-0050 결정 8, docs/frontend.md §5.3): 구매 세션 쓰기 요청(홀드·해제·연장·주문·결제 시도·접수)의 `X-Purchase-Seq`·`X-Purchase-Mac`을 처리기마다 확인하면 순서(모양 검사보다 먼저)와 상수 시간 비교가 흩어진다.
- gRPC 채널 생성 함수(ADR-0082 결정 4, docs/api/guidelines.md §5): 재시도·헤지 정책 없이 투명 재시도만 남기고, 부하 분산 프로필 `service`·`headless-round-robin`을 설정 하나로 고르며, 남은 시간과 추적 머리를 넘기는 채널을 한 곳에서 만든다.

## What Changes

- **차단기**(`createCircuitBreaker`): opossum 10을 감싼다. 기본값은 10초 [가정] 창·20건 [가정]·실패 50% [가정] 이상·5초 [가정] 뒤 시험 호출 하나(docs/features/bot-defense.md §11의 수치를 공용 기본값으로). 열리면 503 `dependency-unavailable`과 `Retry-After`, 동시 호출 상한을 넘으면 429 `server-busy`. 업무 거절(4xx, gRPC 업무 코드)은 실패로 세지 않는다. 지표 `circuit_breaker_state`·`circuit_breaker_rejected_total`, 상태 바뀜 로그.
- **구매 요청 인증 훅**(`@PurchaseSigned()`, 포트 `PurchaseSessionPort`): 인증 가드가 신원·역할과 멱등 키 형식을 본 뒤, 모양 검사보다 먼저 머리 형식 → 구매 세션 → HMAC 상수 시간 비교 → 일련번호 올리기 순으로 보고, 하나라도 틀리면 401(일련번호는 서명이 맞을 때만 올린다). 두 검사 길의 머리 스키마에서 두 머리를 뺀다(멱등 키와 같은 방식). 요청 인증 키를 만드는 함수(HKDF-SHA256 32바이트)와 MAC 입력 함수, 구현과 따로 계산한 시험 벡터. 거절 지표 `purchase_request_rejections_total{reason}`.
- **gRPC 채널**(`createGrpcClient`·`grpcChannelOptions`·`grpcServerOptions`·`grpcTarget`): 서비스 설정에는 부하 분산 방식만, DNS 서비스 설정 끔, 의존성마다 따로 연결, 잠긴 이름 덮어쓰기 거절. 가로채기가 데드라인(남은 시간·호출 상한)·호출 span·추적 머리·`dep` 소요를 맡는다. 설정 `PEAKET_GRPC_LB_PROFILE`(기본 `service`, `headless-round-robin`은 `local`·`ci`만).

## Impact

- 정본: docs/api/guidelines.md §2(`dependency-unavailable`)·§5(채널 함수 세부), docs/frontend.md §5.3(키 32바이트·벡터 위치), docs/features/bot-defense.md §11(지표 이름), docs/observability.md §3(운영 확인 표 세 줄), docs/security/asvs/delivery.md(15.2.2·16.5.2)·queue-admission.md(9.1.1·11.2.2·11.2.4), ADR-0009·0050·0082 상태 줄.
- ID: ADR-0009·0050·0079·0082·0124, FE-T7(서버 쪽 벡터), G-15(차단기 부분), WBS 0.3.3.
- 코드: packages/platform(새 모듈 셋, 인증 가드·시작 확인·두 검사 길·설정·서비스 시작 옵션), 의존성 `opossum` 10.0.0·`@grpc/grpc-js` 1.14.6(잠금 파일에 이미 있던 판)·`@types/opossum`.
- 넘김: 서버 ECDH 키·구매 세션 저장소 어댑터(BOT-100·PRF-110), 화면 서명기의 키 길이와 같은 벡터(HOT-360), 이름 붙은 `type` 목록과 계약 설명(BAS-040), gRPC 서버 쪽 우아한 종료(BAS-080, D-T27), 운영 오버레이의 프로필 검사(D-T28, wbs 0.4.4).
