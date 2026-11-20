# ADR-0321: 관리 인증 게이트웨이 — Set-Cookie 전달·출처 확인·gw-ops 허용 IP(2026-11-20)

- **상태**: 채택(2026-11-20, 감독 승인). 갈래 3 BAT-045 계획 담당이 감독에게 1~3을 올렸고, 감독이 BOT-132·BOT-140의 클라우드 밖 몫과 `PEAKET_OPS_ALLOWED_IPS` 방식을 승인했다.
- **관련**: [docs/security/auth-controls.md](../security/auth-controls.md) §2.1 C1·C2·C8, §5, §6, [docs/features/identity.md](../features/identity.md) §3·§6, [docs/infra.md](../infra.md) §4.1·§9, [docs/security/authz-matrix.md](../security/authz-matrix.md) §6, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/{partner,ops}/auth/*`, [deploy/gateways/00-common.yaml](../../deploy/gateways/00-common.yaml), [ADR-0144](0144-edge-load-balancer-shared-fate-separation-and-failure-response.md), [ADR-0145](0145-api-contract-gaps-logout-scanner-version-telemetry-labels.md), [ADR-0065](0065-web-frontend-security-after-asvs-v3.md)
- **관련 ID**: I-T46 ④⑤, I-T52 ①②, I-T53 ⑤, C-T69 범위 밖, BUILD_ORDER BOT-132·BOT-140, ASVS v5.0.0-3.5.1·9.2.2·14.3.2

## 맥락

- gw-partner·gw-ops는 identity의 로그인·갱신·로그아웃 응답을 그대로 넘긴다. 그러나 게이트웨이를 거친 `Set-Cookie` 전달과, 갱신 경로 밖으로 리프레시 쿠키가 새는지를 보는 시험이 없었다. 공통 Lua는 `Cookie` 머리를 읽기만 했다.
- gw-ops에는 허용 IP 검사가 없었다. 원본 확인 헤더가 틀려도 끝단 신호 머리만 지우고 요청을 통과시켰다. 관제 배포는 CloudFront를 거쳐야만 닿아야 한다(ADR-0144 결정 2).
- Envoy Gateway `SecurityPolicy.authorization.clientCIDRs`는 환경별 CIDR을 정적으로 적어야 하고, 기존 라우트별 JWT 인가와 겹치면 어느 정책이 이기는지가 라우트마다 달라진다. 원본 확인 뒤에만 보는 차례도 만들기 어렵다.
- AWS WAF·보안 그룹·CloudFront 웹 ACL·VPN 출구는 클라우드 계정과 실제 IP 값이 없어 이 묶음에서 할 수 없다.

## 결정

1. **`Set-Cookie`는 지우거나 다시 쓰지 않는다**: 로그인·갱신·로그아웃 응답의 `Set-Cookie`와 `Cache-Control: no-store`를 게이트웨이가 그대로 넘긴다. 공통 Lua에는 응답 고치기가 없다. 쿠키로 인증하는 쓰기의 `Origin`은 기존 `SecurityPolicy.csrf.additionalOrigins`(관제 콘솔·파트너 콘솔 출처)가 본다. 사전 요청(OPTIONS)은 CORS 정책이 답한다.
2. **gw-ops는 원본 확인을 필수로 한다**: `requireOriginVerify: true`인 게이트웨이는 `x-peaket-origin-verify`가 틀리거나 없으면 403 Problem이고 백엔드에 닿지 않는다. `/internal/` 404가 그보다 먼저다(기존 차례). gw-partner는 켜지 않는다(팬·파트너 원본 NLB의 직접 호출 규칙이 아직 정본에 없다).
3. **gw-ops 허용 IP는 공통 Lua + 환경 값 `PEAKET_OPS_ALLOWED_IPS`**: `ConfigMap peaket-ops-allow`의 `cidrs`를 EnvoyProxy가 환경 값으로 받는다. 값은 쉼표로 이은 IPv4 CIDR 1~32개이고, 공통 Lua가 원본 확인이 맞은 요청에서만 `CloudFront-Viewer-Address`(IPv4, `IP` 또는 `IP:port`)를 견준다. 값이 없거나 CIDR이 하나라도 틀리면 **모두 거절**한다(닫힌 쪽). IPv6 주소는 이 묶음에서 거절하고 다음 묶음으로 미룬다. `SecurityPolicy.clientCIDRs`는 쓰지 않는다. local·ci는 시험 값(`127.0.0.0/8`, `203.0.113.0/24`)을 쓰고, 운영 값은 소유자가 `deploy/envs/<환경>/gateways/peaket-ops-allow.yaml`에 채운다.
4. **리프레시 쿠키 깊은 방어**: `refreshCookie`·`refreshPath`를 받은 게이트웨이는 그 경로의 `POST`가 아닌 모든 요청에서 그 쿠키를 `Cookie` 머리에서 지운다. 머리가 여럿이거나 값이 큰따옴표로 묶여 있어도, 이름 앞뒤에 빈칸이 있어도 지운다. gw-ops는 `__Host-peaket_ops_rt`, gw-partner는 `__Secure-peaket_partner_rt`를 지운다. 브라우저 Path에 기대지 않는 깊은 방어다.
5. **거절의 흔적**: 거절마다 `gateway_ops_ip_denied_{missing|malformed|not_allowed}` 지표를 세고(Envoy 지표에는 라벨을 쓸 수 없어 사유별 이름), 출발지 IP는 `/24`로 가린 값만 로그에 남긴다. 경보 규칙과 WAF 로그 탐지는 클라우드 계정 뒤로 남긴다.
6. **위험 명령 재인증은 ops-svc 몫**: 게이트웨이는 `X-Reauth-Token` 머리를 그대로 넘기고, 판정은 ops-svc가 한다(ADR-0322).

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 공통 Lua 환경 값 + IPv4 CIDR(이 결정) | 원본 확인 뒤에만 보고, 값이 없으면 닫힌 쪽이며, local·ci와 운영이 같은 코드다 | IPv6·도메인 이름·동적 목록은 다음 묶음이다. 프록시를 다시 띄워야 값이 바뀐다 | 고른다 |
| B. `SecurityPolicy.authorization.clientCIDRs` | 쿠버네티스 정본에 가깝다 | 환경별 정적 값, 라우트별 JWT 인가와 겹칠 때 승자가 불분명, 원본 확인과 차례를 못 만든다 | 쓰지 않는다 |
| C. AWS WAF·보안 그룹만 쓴다 | 관리가 한 곳이다 | 클라우드 계정·실제 IP가 없다. 게이트웨이까지 오는 직접 호출을 못 막는다 | 클라우드 계정 뒤로 남긴다 |
| D. `X-Forwarded-For`를 본다 | 흔한 방식이다 | 클라이언트가 꾸밀 수 있다 | 쓰지 않는다. CloudFront-Viewer-Address만 본다 |

## 결과

- gw-ops 직접 호출은 403이고, CloudFront를 거치고 허용 목록 안인 요청만 백엔드에 닿는다. 리프레시 쿠키는 갱신 경로 밖으로 넘어가지 않는다.
- 대가: 공통 Lua에 IP 파싱·CIDR 견주기·쿠키 다시 쓰기가 는다. 프록시 환경 값 `PEAKET_OPS_ALLOWED_IPS`와 local ConfigMap 한 파일이 는다.
- 남는 한계: IPv6 허용 목록, 웹 ACL IP 속도 규칙, 게이트웨이 파드별 로그인 한도, AWS WAF 로그 탐지·CloudTrail 경보, 출시 후보 데모·운영 점검은 다른 묶음·소유자 몫이다.

## 되돌릴 조건

- 운영에서 IPv6로 들어오는 관제 요청이 생기면 IPv6 CIDR 허용 목록을 더한다(지금은 거절).
- 프록시 재시작 없이 허용 IP를 바꿔야 하는 운영 요구가 생기면 환경 값 대신 동적 설정(예: ratelimit 서비스 같은 외부 판정)을 검토한다.
- 직접 호출 규칙이 정본에 생기면 gw-partner에도 `requireOriginVerify`를 켠다.
