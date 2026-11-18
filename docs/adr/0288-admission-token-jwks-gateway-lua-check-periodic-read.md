# ADR-0288: 입장 토큰 공개키 묶음은 queue-svc가 내고, gw-fan은 그 사본으로 공통 Lua에서 확인하며, purchase-svc는 주기로 읽는다(2026-11-19)

- **상태**: 채택(추천 적용, 2026-11-19, BUILD_ORDER BAT-057 계획 `bat057-plan-c33b13d2`). HOT-400 줄의 PRF-110·PRF-137이 넘긴 것(입장 토큰 공개키 묶음 배포, 게이트웨이의 `typ`·`iss`·`aud`·`exp`·주소의 회차 대조, 옛 키 검증 허용, purchase-svc의 주기 읽기)을 구현하기 전에 정한 세부다(docs/architecture.md §8.6 4의 2). 결정 4의 Lua 서명 확인은 2026-11-19 구현 담당이 같은 프록시 이미지와 kind에서 됨을 봤다(아래 '확인'). 결정 1·5·6·7의 'BAT-057 리뷰 반영' 문장은 리뷰 지적 R057-1·2·5~8을 반영해 같은 날 더했다(docs/review/plans/BAT-057.md '리뷰 반영').
- **관련**: [ADR-0008](0008-client-specific-thin-gateways.md)(클라이언트별 얇은 게이트웨이), [ADR-0050](0050-crypto-corrections-and-key-management.md) 결정 9(키 셋 나누기), [ADR-0183](0183-admission-confirm-first-implementation.md)(입장 확정과 입장 토큰), [docs/features/queue-admission.md](../features/queue-admission.md) §6 '입장 토큰 공개키 묶음과 게이트웨이 확인', [docs/features/seat-hold.md](../features/seat-hold.md) §2 '입장 토큰 공개키 묶음 주기 읽기', [docs/infra.md](../infra.md) §4.1 '입장 토큰 확인', [docs/security/secrets-and-keys.md](../security/secrets-and-keys.md) '대기열 입장 토큰 서명 키' 행, [docs/security/asvs/queue-admission.md](../security/asvs/queue-admission.md) 9.1.3·9.2.1~9.2.3
- **관련 ID**: Q-T69, S-T28, HOT-400, PRF-110, PRF-137

## 맥락

- 입장 토큰(차례가 온 사람이 구매 세션 하나에 쓰는 ES256 JWT)은 queue-svc가 환경 값의 개인 JWK로 서명한다(PRF-110). 받는 쪽은 둘이다. gw-fan이 구매 경로의 요청마다 서명·유효 기간·주소의 회차를 보고, purchase-svc는 구매 세션을 여는 첫 사용 요청에서 한 번 더 본다(docs/features/seat-hold.md §2). 지금 purchase-svc는 공개키 묶음을 환경 값 `PEAKET_ADMISSION_JWKS`로 받아 키를 바꾸면 다시 시작해야 하고, 게이트웨이는 입장 토큰을 보지 않는다(BAT-055는 팬 토큰과 `ticket:buy`만 걸었다).
- 정본은 '공개키는 JWKS로 정적 배포'(secrets-and-keys), '옛 키는 최대 체류 시각 + 1일까지 검증만 허용'(같은 행), '입장 토큰 공개키는 queue-svc JWKS에서만'(ASVS 9.1.3)까지 정했다. 묶음을 어디서 내는지, 옛 키의 끝을 받는 쪽이 어떻게 아는지, 게이트웨이가 무엇으로 확인하는지는 비어 있었다.
- Envoy Gateway v1.10의 `SecurityPolicy.jwt`는 제공자가 여럿이면 '어느 하나가 맞으면 통과'다(`api/v1alpha1/jwt_types.go` v1.10.0의 `Providers` 설명 'the JWT is considered valid if any of the providers successfully validate the JWT', 2026-11-19 확인). 모두를 요구하는 칸은 없다. 라우트 하나에는 `SecurityPolicy`가 하나만 붙는다. 그래서 같은 라우트에서 팬 토큰과 입장 토큰을 둘 다 요구하는 일은 Envoy JWT 필터 설정만으로 할 수 없다. Envoy의 '어느 하나' 검사기는 앞의 제공자가 맞으면 뒤 제공자를 보지도 않는다.
- 게이트웨이에는 이미 공통 Lua가 JWT 확인보다 앞에서 돈다(docs/infra.md §4.1, 원본 확인·`typ` 확인). Envoy Lua에는 공개키를 읽는 `importPublicKey`와 서명을 확인하는 `verifySignature`가 있다(Envoy 문서는 받는 키 종류를 적지 않는다).

## 결정

1. **묶음의 원천은 queue-svc 설정이다.** 지금 키 `PEAKET_ADMISSION_TOKEN_KEY`(개인 JWK) 하나와, 키를 바꾸는 동안만 옛 키 `PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS`(공개 JWK)·그 끝 시각 `PEAKET_ADMISSION_TOKEN_KEY_PREVIOUS_UNTIL`(ISO 8601, 초 단위)·다음 키 `PEAKET_ADMISSION_TOKEN_KEY_NEXT`(공개 JWK)를 둔다. identity 키 셋(docs/features/identity.md §3 '서명 키 셋')과 같은 이름 꼴·두 단계 교체다. 옛 키·다음 키에 `d`가 있거나, kid가 겹치거나, 옛 키가 있는데 끝 시각이 없거나 밀리초가 0이 아니거나, 끝 시각이 지금 + 최대 체류 45분 + 1일 + 1시간 [가정]보다 뒤면 시작하지 않는다. 끝 시각이 시간대까지 다 적은 꼴이 아니거나 옛 키·다음 키가 P-256 공개키로 읽히지 않아도 시작하지 않는다(추천 적용, 2026-11-19, BAT-057 리뷰 반영 R057-6·R057-7).
2. **queue-svc가 묶음을 낸다.** 앱 포트 `GET /internal/jwks/admission.json`(클러스터 안에서만, `Cache-Control: max-age=300`)이 지금 키·다음 키와, 지금 시각 ≤ 끝 시각일 때만 옛 키의 공개 부분을 준다. 옛 키 원소에는 끝 시각(초, NumericDate) 칸 `peaket_until`을 싣는다. JWK에 없는 이름의 칸은 받는 쪽이 모르면 무시하는 칸이다(RFC 7517 §4).
3. **받는 쪽은 `peaket_until`을 스스로 지킨다.** 그 칸이 있는 키는 그 시각까지만 쓴다(purchase-svc는 밀리초로, 게이트웨이는 초로). 그래서 묶음 읽기가 늦거나 게이트웨이 사본이 옛 키를 들고 있어도, 끝 시각 뒤에는 옛 키로 서명한 토큰을 받지 않는다. 옛 개인키가 샌 뒤의 교체에서 위조 토큰이 끝 시각을 넘겨 통하지 않게 하려는 것이다.
4. **gw-fan 구매 경로의 확인은 공통 Lua가 한다.** openapi에서 모든 `security` 갈래에 `admissionToken`이 있는 작업(라우트 원천 `gw-fan-buy`)에 공통 Lua 설정 `admission`(참)·`admissionIssuer`·`corsOrigin`을 준다. Lua는 JWT 확인(팬 토큰)보다 앞에서 사전 요청을 건너뛰고 ① 값 하나·2,048자 이하·JWT 꼴 ② `alg` ES256 ③ `kid`가 키 목록에 있고 끝 시각 안 ④ 서명 ⑤ `typ` `admission+jwt` ⑥ `iss` ⑦ `aud` 문자열 `purchase` ⑧ 정수 `exp`와 지금(초) < `exp` ⑨ 주소가 `/v1/events/{eventId}/`로 시작하면 `eventId` = `event`를 본다. ①~⑧은 401 `admission-token-invalid`, ⑨는 403이다. 머리의 키 출처 칸(`jku`·`x5u`·`jwk`·`x5c`)은 읽지 않는다. 팬 토큰 확인·`ticket:buy` 인가는 지금 그대로 JWT 필터와 인가가 한다.
5. **게이트웨이 키 목록은 배포 때 받는 사본이다.** 프록시 환경 값 `PEAKET_ADMISSION_JWKS`(ConfigMap `peaket-admission-jwks`의 `jwks`, `optional: true`)에 queue-svc 묶음과 같은 꼴의 JSON을 둔다. 값이 없거나 읽지 못하거나 쓸 키가 없으면 모든 입장 토큰을 거절한다(닫힌 쪽). 원소 하나라도 틀리거나 kid가 겹쳐도 목록 전체를 쓰지 않는다(추천 적용, 2026-11-19, BAT-057 리뷰 반영 R057-8). ConfigMap이 없어도 다섯 게이트웨이 프록시는 뜬다(입장 토큰을 쓰지 않는 경로를 함께 멈추지 않게). 교체 때 이 값을 queue-svc 설정과 함께 고친다.
6. **Lua가 낸 거절에 교차 출처 머리를 단다.** Lua는 교차 출처 필터보다 앞이라(BAT-055 `filterOrder`) 그 응답에는 필터의 머리가 붙지 않는다. `corsOrigin`을 받은 라우트에서 요청 `Origin`이 그 값과 같으면 Lua가 `Access-Control-Allow-Origin`·`Access-Control-Allow-Credentials: true`·`Access-Control-Expose-Headers: WWW-Authenticate`를 직접 단다(`Vary: Origin`은 아래). 화면이 401·403 본문을 읽게 하려는 것이다. Lua의 403은 게이트웨이가 낸 응답이라 gw-fan의 조건 없는 403 응답 고치기가 머리를 새로 써서 Lua 머리가 빠진다(BAT-057 시험 K15). 그래서 그 고치기 앞에 '상태 403이고 `Access-Control-Allow-Origin`이 정확히 www 출처'를 고르는 403 고치기를 두고 교차 출처 머리 넷과 보안 머리 셋을 고정 값으로 싣는다. `Vary: Origin`은 Lua가 달지 않는다: 401은 gw-fan `lateResponseHeaders`가 덧붙이고, 고친 403은 그 고치기가 단다(겹쳐 `Origin,Origin`이 되지 않게). 차례와 값은 docs/infra.md §4.1 '거절 응답의 교차 출처 머리'(추천 적용, 2026-11-19, BAT-057 리뷰 반영 R057-1·R057-5).
7. **purchase-svc는 묶음을 주기로 읽는다.** `PEAKET_ADMISSION_JWKS_URL`이 있으면 시작 때 바로 읽고, 처음 받기 전에는 1초 [가정]마다, 받은 뒤에는 5분 [가정]마다 배경에서 다시 읽는다(시간 한도 1초 [가정]). 실패·시간 초과·빈 `keys`·틀린 모양은 실패로 보고 마지막 묶음을 쓰며 30초 [가정] 뒤 다시 읽는다. 모르는 kid는 그 요청이 다시 읽기 한 번을 기다린다(하나로 묶고 30초에 한 번, 기다림 1초). 한 번도 받지 못했으면 서명을 확인하는 요청은 503 `dependency-unavailable`이고 준비 상태는 막지 않는다(자동 배정 공연의 첫 홀드도 같다. 추천 적용, 2026-11-19, BAT-057 리뷰 반영 R057-2). 정적 `PEAKET_ADMISSION_JWKS`는 local·ci만 받는다.
8. **배포 단위.** `deploy/workloads/queue-svc/values.yaml`(PRF-050이 넘긴 것)과 `deploy/workloads/purchase-svc/values.yaml`(PRF-137의 세 값)을 둔다. 입장 토큰 개인 JWK 같은 비밀은 `secretEnvFrom`으로만 받는다. 발급자는 세 곳(queue-svc `PEAKET_ADMISSION_TOKEN_ISSUER`, purchase-svc `PEAKET_ADMISSION_ISSUER`, gw-fan `admissionIssuer`)이 같은 값 `https://queue.peaket.example` [가정]이고 정적 시험이 셋을 견준다. purchase-svc가 queue-svc 앱 포트를 부르므로 메시 원천(`deploy/platform/mesh/port-allow.yaml`)의 queue-svc `rest` 부르는 쪽에 purchase-svc를 더한다.

## 검토한 대안

1. **Envoy JWT 필터의 '모두 맞아야 통과'를 `EnvoyPatchPolicy`로 고쳐 넣기**: 두 토큰을 Envoy 필터가 확인하고 공개키를 queue-svc에서 바로 읽는(게이트웨이 캐시) 점은 좋다. 그러나 컨트롤러 설정 `enableEnvoyPatchPolicy`를 켜야 하고, 생성 라우트마다 xDS 경로(라우트 이름·필터 차례)를 맞춘 패치가 필요하다. 패치가 받아지지 않으면 '어느 하나' 그대로 남아 팬 토큰만으로 통과한다(열린 쪽 실패). Envoy JWT의 `exp` 시계 허용 60초도 남는다. 고르지 않았다. 결정 4가 kind에서 안 되면 감독이 정한다.
2. **외부 인가(ext_authz)로 purchase-svc나 queue-svc에 묻기**: 구매 경로 요청마다 서비스 호출이 하나 늘고(핫패스 지연, NFR-003), 게이트웨이가 서비스에 기대게 된다. 방향을 바꾸는 일이라 고르지 않았다.
3. **Wasm 필터**: 따로 빌드하는 모듈(새 산출물·이미지 출처)이 든다. 고르지 않았다.
4. **게이트웨이는 보지 않고 purchase-svc가 요청마다 서명을 본다**: 정본(gw-fan의 회차 대조, realtime-gw가 게이트웨이 확인에 기대는 것)과 어긋난다. 고르지 않았다.
5. **`peaket_until` 없이 받는 쪽이 묶음만 따르기**(identity와 같음): 게이트웨이 사본은 다시 배포할 때까지 옛 키를 들고 있고, purchase-svc도 queue-svc에 닿지 못하는 동안 옛 키를 계속 쓴다. 옛 키의 끝이 정본 값(최대 체류 + 1일)보다 늦어질 수 있어 고르지 않았다.

## 결과

- 구매 경로는 팬 토큰과 입장 토큰을 모두 확인하고, 다른 회차 주소의 요청은 게이트웨이에서 403으로 끝난다(S-T28 ①). purchase-svc는 키를 바꿔도 다시 시작하지 않는다.
- 대가: 키를 바꿀 때 고칠 곳이 둘이다(queue-svc 설정과 게이트웨이 ConfigMap). 차례를 어기면 새 kid 토큰이 게이트웨이에서 모두 401이다(운영 확인 표의 401 비율 경보로 드러난다). Lua 안에 서명 확인 붙이기(base64url 풀기, r‖s를 DER로)가 들고, 그 Lua는 kind에서만 돌려 볼 수 있다. 게이트웨이는 초 단위라 옛 키를 끝 시각의 그 초 끝까지 받는다(남는 차이, 1초 안).
- realtime-gw([ADR-0296](0296-realtime-gw-first-build-own-token-check-section-count-from-layout-file.md))는 아직 정적 `PEAKET_ADMISSION_JWKS`이고 `peaket_until`을 보지 않는다. 배포 전에 같은 주기 읽기로 맞춘다(갈래 1 정리 목록 후보, 계획 docs/review/plans/BAT-057.md).

## 되돌릴 조건

- kind에서 Envoy Lua가 P-256 공개키나 DER ECDSA 서명을 받지 못하면 결정 4를 멈추고 대안 1·2 가운데 감독이 정한다.
- Envoy Gateway가 JWT 제공자 여럿을 모두 요구하는 칸을 내면, Lua 서명 확인을 Envoy JWT 필터로 옮기고 키 목록 사본(결정 5)을 queue-svc 묶음 읽기로 바꾼다.
- 구매 경로 p99에서 Lua 확인이 1ms [가정]를 넘게 더하면(HOT-460 부하 측정) 공개키 객체를 일꾼마다 미리 만들어 두는 길을 먼저 보고, 그래도 넘으면 대안 1을 다시 본다.

## 확인

- 2026-11-19: Envoy Gateway v1.10.0 `api/v1alpha1/jwt_types.go`의 `JWT.Providers` 설명('any of the providers')과 모두를 요구하는 칸이 없음을 봤다. Lua `importPublicKey`·`verifySignature`의 P-256·DER 지원은 구현 담당이 kind에서 본다(docs/infra.md §4.1 '입장 토큰 확인'의 [확인 필요]).
- 2026-11-19(구현 담당 `bat057-impl-5f438f5c`): 같은 프록시 이미지(Envoy 1.40.2) 단독 실행과 kind(Envoy Gateway v1.10.0)에서 Lua `importPublicKey`가 P-256 SubjectPublicKeyInfo DER을, `verifySignature`가 DER ECDSA 서명을 받는 것을 봤다. 결정 4는 그대로 간다. v1.40에서는 `importPublicKey`가 돌려준 객체의 `get()` 값을 `verifySignature`에 넘기고, 공개키는 그 요청 안에서만 쓸 수 있다(요청마다 하나만 가져온다, docs/infra.md §4.1 '입장 토큰 확인'의 'Lua 서명 확인').
