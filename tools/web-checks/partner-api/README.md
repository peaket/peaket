# 파트너 가짜 API

서버 모듈(core-svc shop·notify·export, payment-svc 정산)이 아직 없어 SCR-023·025·027의 실제 화면을 브라우저에서 눌러 보기 위한 계약 모양 가짜 API다. 실제 서버가 생기면 지운다(ADR-0199와 같은 방식).

```powershell
# 터미널 1
node tools/web-checks/partner-api/server.mjs --port 4012

# 터미널 2
$env:NEXT_PUBLIC_PARTNER_API_ORIGIN='http://127.0.0.1:4012'
pnpm --filter @peaket/partner dev
```

- `PARTNER_ORIGIN`(기본 `http://localhost:3001`)로 CORS 허용 출처를 바꾼다.
- 재인증은 `POST /v1/partner/auth/reauthentications`가 바로 `DONE`과 `test-booker-export-token`을 준다. 실제 패스키 창은 실제 identity-svc와 붙일 때 본다.
- 명단 내려받기는 `X-Reauth-Token: test-booker-export-token`을 요구한다. 없으면 403 `reauth-required`다.
- 상품 정산서는 자료가 있는 상태(200)로 답한다. payment-svc가 없을 때의 준비 중 상태는 Playwright `page.route`로 404를 주어 확인한다.
- 상품 만들기·고치기, 웹훅 등록·비밀 재발급·다시 보내기, 송장 등록·반품 도착 확인/거절, 정산 이의 제기는 메모리에만 반영한다. 프로세스를 다시 띄우면 처음 자료로 돌아간다.
