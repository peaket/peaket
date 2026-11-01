# 설계: 차단기·구매 요청 인증 훅·gRPC 채널 생성 함수

## Context

- ADR-0009 결정 2는 서비스 안 2차 차단기를 opossum으로 의존성마다 두고(벌크헤드 포함), 결정 5는 상태와 끊은 수를 관측하라고 한다. 수치는 docs/features/bot-defense.md §11(10초 창 20건 이상·실패 50% 이상이면 열림·5초마다 시험 호출 하나)에만 있다.
- ADR-0050 결정 8과 docs/frontend.md §5.3이 구매 세션 요청 서명을 정했다: `mac = base64url(HMAC-SHA256(key, utf8(METHOD ‖ LF ‖ pathAndQuery ‖ LF ‖ seq ‖ LF ‖ base64url(SHA-256(body)))))`, 키는 `HKDF-SHA256(ECDH 공유 비밀, salt = jti, info = "PEAKET-purchase-v1")`. 일련번호는 구매 세션에 저장한 마지막 번호보다 커야 받는다. 서명 불일치·재사용은 401이다(openapi 홀드 경로 설명).
- ADR-0082 결정 4와 guidelines §5가 gRPC 채널 규칙을 정했다: 재시도·헤지 정책 없음, `grpc.enable_retries` 끄지 않음(투명 재시도 유지), 프로필 `service`(pick_first)·`headless-round-robin`(헤드리스 Service·round_robin·서버 `grpc.max_connection_age_ms`), 앱은 데드라인·추적 머리를 넘긴다.

## Goals / Non-Goals

- 목표: 위 셋을 `packages/platform`에 두고 시험으로 고정한다.
- 목표 아님: 서버 ECDH 키 보관과 구매 세션 저장소(`s:session:{sid}`) 어댑터(BOT-100·PRF-110), 서비스별 대체 응답, gRPC 서버의 우아한 종료(BAS-080), 운영 오버레이 정책 검사(D-T28).

## Decisions

1. **opossum은 상태만 맡고, 열림 판정은 감싸개가 한다.** 정본이 opossum을 골랐으므로 상태(닫힘·열림·반 열림), 열림 → 반 열림 타이머(`resetTimeout`), 반 열림의 시험 호출 하나는 opossum에 맡긴다. 그 밖은 감싸개가 쥔다. 처음에는 opossum의 집계(`rotateBucketController`로 창을 주입한 시계로 돌리고, 문턱에서 아주 작은 값을 빼 '이상'으로 맞춤)를 썼으나, 코드 리뷰 네 번에서 아래 결함이 나와 지금 모양으로 바꿨다(2026-11-01).
   - 열림 판정: 끝난 호출을 끝난 시각의 칸(주입한 시계, 10초를 1초 칸 10개로)에 넣고, 닫힌 상태에서 창 안의 끝난 호출이 20건 이상이고 실패가 50% 이상이면 opossum의 `open()`을 부른다. 아직 끝나지 않은 호출은 분모에 넣지 않는다. opossum은 호출 수를 시작할 때, 실패 수를 끝날 때 다른 칸에 더해 분자와 분모가 다른 호출을 셌다(시간 초과가 몰린 직후 회복해도 열리고, 멈춘 호출이 분모를 부풀려 열려야 할 때 안 열림). 그래서 opossum의 호출 수 문턱을 닿을 수 없게 두어 닫힌 상태에서는 스스로 열지 않게 한다. 반 열림의 시험 호출이 실패하면 opossum이 문턱과 관계없이 다시 연다.
   - 닫히면 창을 비운다(시험 호출 하나로 닫았으니 그 앞의 실패로 다시 열지 않는다).
   - 반 열림의 판정은 시험 호출 하나만 한다. opossum은 시험 호출과 그 전부터 진행 중이던 호출을 가리지 않아, 늦게 끝난 옛 호출의 실패가 다시 열거나 성공이 시험 호출 없이 닫았다. 그래서 감싸개가 opossum에 넘기는 약속을 따로 두고, 열릴 때 진행 중이던 호출의 약속을 '떼어 냄' 값으로 먼저 끝낸다(열린 동안의 성공은 opossum이 상태를 바꾸지 않는다). 부른 쪽은 그 호출의 진짜 결과를 그대로 받는다.
   - 시험 호출 한도(`trialTimeoutMs`, 5초 [가정]): opossum은 반 열림에서 시험 호출이 끝나야만 상태를 바꾸므로, 시간 상한 없이 짠 호출 하나가 끝나지 않으면 반 열림에 영원히 머물며 모든 호출을 503으로 끊었다. 한도를 넘으면 실패로 세어 다시 열고, 부른 쪽은 늦게라도 진짜 결과를 받는다. 결제사 승인처럼 오래 걸리는 의존성은 이 값을 늘려 쓴다.
   - 열림 → 반 열림 5초만 opossum의 타이머(시스템 시계)다. 절대 규칙 '시간 의존 로직은 Clock 주입'의 예외로 적고, 시험은 가짜 타이머로 고정한다. 시험 호출 한도도 타이머다. 판정 창은 주입한 시계를 따른다.
   - opossum 자체 시간 제한은 끈다(`timeout: false`, 끊는 시간은 남은 시간과 호출 상한이 맡는다, guidelines §5). 지연 백분위와 주기 스냅샷도 끈다(실패마다 지연 배열을 정렬하는 비용).
   - opossum 자체 창은 판정에 쓰지 않지만 돌려야 한다: opossum은 성공·실패마다 지연 값을 첫 칸 배열에 쌓고 '돌리기' 신호가 올 때만 칸을 넘긴다. 그래서 `rotateBucketController`로 우리 신호를 주고, 우리 창이 칸을 넘길 때 같이 돌린다(다섯 번째 코드 리뷰 2026-11-01: 돌리지 않으면 초당 1,000건에 하루 약 600MB가 쌓였다). 두 타이머 값(`openMs`·`trialTimeoutMs`)은 2^31 − 1ms 이하만 받는다(넘으면 Node가 1ms로 줄인다).
2. **벌크헤드는 opossum 밖에 둔다.** opossum의 `capacity`는 자리가 없을 때 그 거절을 실패로 세거나(기본) 성공으로 세는데(오류 거르기), 반 열림의 시험 호출이 자리 없음으로 끝나면 차단기가 그것으로 닫히거나 다시 열린다. 그래서 동시 호출 수는 감싸개가 세고, 넘으면 opossum을 부르지 않고 429 `server-busy`(자기 과부하, guidelines §2)를 던진다. 세는 것은 의존성을 실제로 부른 호출뿐이다(떼어 냈거나 시험 한도를 넘겼어도 아직 도는 호출은 센다). 열렸거나 반 열림의 시험 호출이 이미 나갔으면 상한보다 먼저 503이다(열린 동안 429가 나가지 않게). 시험 호출 하나는 상한이 차도 보낸다: 응답 없이 멈춘 호출이 자리를 다 잡으면 시험 호출을 못 보내 회복을 알 수 없기 때문이다(최대 상한 + 1). 이 셋은 다시 본·세 번째 코드 리뷰(2026-11-01)에서 고쳤다.
   - 서비스가 준 실패 분류 함수가 던지면 실패로 센다(opossum 안에서 던지면 결과 약속이 끝나지 않았다). 정수 설정은 양의 정수만 받는다(0과 1 사이 소수가 0으로 잘렸다). 끈 뒤에는 감싸개가 직접 503으로 끝내고 남은 호출을 떼어 낸다(opossum은 끈 뒤에도 남은 호출의 실패로 상태를 열림으로 덮어써 검사 없이 불렀다). 의존성 오류의 `code`가 opossum의 것과 같아도 우리가 부른 호출이면 그대로 돌려준다(코드 리뷰 2026-11-01).
3. **실패로 세는 것.** 기본 분류: Problem은 5xx와 429만, gRPC는 `UNKNOWN`·`DEADLINE_EXCEEDED`·`RESOURCE_EXHAUSTED`·`INTERNAL`·`UNAVAILABLE`·`DATA_LOSS`만(docs/features/payment.md §10의 identity 장애 목록), 그 밖의 오류(연결 오류, 시간 초과 `TimeoutError`·`AbortError`, 분류 없는 예외)는 실패다. 업무 거절은 실패가 아니고 반 열림이면 닫는다(의존성이 답했다). 서비스는 `isFailure`로 바꿀 수 있다. 호출 전에 요청의 남은 시간이 0이면 차단기를 부르지 않고 504 `deadline-exceeded`다(우리 시간이 모자란 것을 의존성 실패로 세지 않게).
4. **열림 응답.** 503 `dependency-unavailable`, `Retry-After`는 시험 호출까지 남은 초(올림, 최소 1). 의존성 이름은 본문에 싣지 않는다(내부 구조 노출). 지표에는 싣는다.
5. **지표.** `circuit_breaker_state{service, dependency}`(0·1·2, 파드 수 세기에 쓰기 좋게 숫자 하나), `circuit_breaker_rejected_total{service, dependency, reason}`(`open`·`bulkhead`). bot-defense의 `trust_breaker_state`는 이 지표의 `dependency="trust-svc"`로 읽는다. 지표 저장소마다 한 벌(같은 저장소에 두 번 등록하지 않게).
6. **구매 요청 인증 훅의 자리.** 인증 가드 안, 신원·종료 세션·대상·스코프·관리 역할 판정과 멱등 키 형식 검사 뒤, 모양 검사 앞이다. 순서는 '익명 401 → 역할 403 → 멱등 키 400 → 구매 서명 401 → 모양 400'. 서명은 신원 증명의 일부라 모양 검사보다 먼저 본다. 멱등 키 형식 검사는 상태를 바꾸지 않아 앞에 둔다: 키가 틀린 요청이 일련번호를 쓰지 않고, FND-080이 정한 '키 400이 다른 머리·본문 오류보다 먼저'가 그대로다(처음에는 서명을 멱등 키보다 앞에 두려 했으나 이 두 까닭으로 바꿨다). 두 머리는 계약 머리 스키마에서 빼고 훅만 본다(멱등 키와 같은 방식, add-idempotency-and-outbox 결정 1). 그래서 머리가 없거나 형식이 틀려도 400이 아니라 401이다(화면은 401 하나로 처리한다, frontend §5.3). 계약이 두 머리를 요구하는 처리기에 `@PurchaseSigned()`가 없거나, 공개 역할을 허용한 처리기에 달았거나, 포트가 없으면 서비스가 시작하지 않는다.
7. **확인 순서와 일련번호.** 머리 형식(각 하나, 일련번호는 앞 0 없는 10진수 1 이상 2^53 − 1 이하, MAC은 채움 없는 base64url 43자) → 포트 `resolve`(구매 세션과 요청 인증 키, 없으면 401) → HMAC을 32바이트로 계산해 `timingSafeEqual` → 포트 `advance(ref, seq)`(마지막 번호보다 클 때만 원자적으로 올림, 아니면 401). 서명이 틀린 요청은 일련번호를 올리지 않는다(남이 번호를 태워 정상 요청을 막지 못하게). 요청 대상은 받은 그대로의 경로와 쿼리(`request.raw.url`), 본문은 플랫폼 해석기가 남긴 원시 바이트(`rawBodyOf`)다. 포트가 던진 오류는 그대로 낸다(저장소 장애면 포트가 503 `seat-store-unavailable` 등을 던진다).
8. **서버 개인키를 훅에 두지 않는다.** 훅과 포트 계약은 '요청 인증 키'(대칭 키)만 다룬다. ECDH 합의와 서버 키 보관은 purchase-svc(BOT-100)의 일이다. 감독 프롬프트의 절대 규칙 '개인키 서버 비저장(공개키만)'과 정본의 '구매 세션 서버 ECDH 키를 Secrets Manager에 두고 시작할 때 메모리로 넣는다'(docs/security/secrets-and-keys.md)가 부딪치는지는 소유자가 정한다(docs/PROGRESS.md 미해결). 이 단계는 그 결정과 상관없이 쓸 수 있다.
9. **키 길이 32바이트(추천 적용).** 정본에 HMAC 키 길이가 없다. WebCrypto `deriveKey`는 HMAC 길이를 주지 않으면 해시 블록 크기(512비트)로 만든다. 서버와 브라우저가 어긋나지 않게 HMAC-SHA256 출력 길이 32바이트로 정하고 frontend §5.3에 적는다. 시험 벡터는 구현과 따로 파이썬 표준 라이브러리로 계산하고 HKDF 결과를 OpenSSL `kdf`로 다시 확인했다.
10. **gRPC 채널.** `grpcChannelOptions(profile, extra)`가 만드는 값: 서비스 설정 JSON에 `loadBalancingConfig`만(`pick_first` 또는 `round_robin`, `retryPolicy`·`hedgingPolicy`·`methodConfig` 없음), `grpc.service_config_disable_resolution: 1`(DNS TXT 서비스 설정으로 재시도 정책이 들어오지 않게), `grpc.use_local_subchannel_pool: 1`(의존성마다 연결 분리). `grpc.enable_retries`는 넣지 않는다(기본 켬 = 투명 재시도만). 이 넷을 `extra`로 주면 예외다. `grpcServerOptions('headless-round-robin')`은 `grpc.max_connection_age_ms` 30초 [가정](정본에 값이 없다)를 낸다. 자격 증명은 평문이다(파드 사이 TLS는 메시, guidelines §5).
11. **gRPC 가로채기.** 호출마다 데드라인 = min(이미 건 데드라인, 지금 + min(요청의 남은 시간, 호출 상한)). 요청 밖(작업자)이면 호출 상한만. 호출 span(CLIENT, 이름 `<서비스>/<메서드>`, `rpc.system` grpc·`rpc.service`·`rpc.method`·`rpc.grpc.status_code`·`peaket.dependency`)을 열고 `propagation.inject`로 메타데이터에 추적 머리를 싣는다(서비스 사이는 신뢰 경계 안이다, observability §6). OTel gRPC 자동 계측은 쓰지 않는다(ESM에서 grpc-js를 고쳐 끼우는 방식이 확실하지 않고, 같은 호출 span이 둘 생기지 않게).
12. **설정.** `PEAKET_GRPC_LB_PROFILE`(기본 `service`). `headless-round-robin`은 `local`·`ci`에서만 받는다(운영 오버레이 검사 D-T28보다 앞의 막이, 디버그 오류와 같은 닫힘 실패).

## Risks / Trade-offs

- opossum의 열림 → 반 열림 타이머는 시스템 시계다(결정 1). 시험은 가짜 타이머로 고정한다.
- 반 열림의 시험 호출이 끝나기 전에 온 호출은 503이다(opossum 동작, 정본의 '시험 호출 하나'와 같다).
- 판정 창은 1초 칸이라 실제로 보는 길이는 9~10초다. 끝난 호출만 세므로, 응답 없이 멈춘 호출은 끝나거나 시간 초과가 날 때까지 판정에 들지 않는다(gRPC·외부 HTTP 클라이언트는 늘 시간 한도를 건다). 문턱 값은 [가정]이고 Q-T58·G-15에서 잰다.
- 서명 확인이 모양 검사보다 앞이라 모양이 틀린 요청도 서명이 맞으면 일련번호를 쓴다. 다시 보낼 때는 새 번호로 서명하는 규칙(frontend §5.3)이라 문제없다.

## Migration Plan

새 모듈과 선택 옵션이라 옮길 것이 없다. 서비스가 생기면 의존성마다 차단기를 만들고, 구매 쓰기 처리기에 `@PurchaseSigned()`와 포트를 단다.

## Open Questions

- 서버 ECDH 개인키 보관과 감독 프롬프트 절대 규칙의 관계(결정 8, docs/PROGRESS.md 미해결).
