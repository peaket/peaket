# ADR-0215: 로그인·재인증 화면의 form-action에 소셜 제공자 인가 출처를 넣는다

- **상태**: 채택(2026-11-05, 추천 적용). 갈래 3 BOT-044 브라우저 확인이 찾은 결함을 갈래 2가 고친다(HOT-290·HOT-321 뒤).
- **관련**: [docs/frontend.md](../frontend.md) §5.14.1 묶음 B '+ 로그인 화면'·'+ 재인증을 시작하는 화면', [docs/features/identity.md](../features/identity.md) §2 '웹 앱 서버 경로'·§7.1, packages/config/headers/security-headers.mjs, apps/web/src/_app/security/page-headers.ts, ADR-0065, ADR-0119, ADR-0193
- **관련 ID**: SCR-004, FE-T35, I-T74

## 맥락

- 로그인 시작(`POST /login/{제공자}`), 로그인 수단 잇기 확인(`/login/link`), 재인증(`POST /reauth/{제공자}`, 계정 설정의 탈퇴·원격 로그아웃과 로그인 수단 화면의 해제·추가), 로그인 수단 추가(`POST /link/{제공자}`)는 모두 앱 서버가 303으로 제공자 인가 주소로 보낸다.
- `form-action`은 양식을 보낸 뒤 이어지는 넘김마다 본다. 그런데 묶음 B의 `form-action 'self'`만 있어, 막는 CSP 아래에서는 제공자로 가지 못했다.
  - 갈래 3이 운영 빌드와 Chromium에서 재현했다. 로그인이 끝나지 않고, 재인증 버튼은 처리 중으로 멈춘다.
- 정본(§5.14.1)은 '세 소셜 제공자 인가 출처를 더한다'고만 적었고 값은 '연동 때 제공자 문서로 확정'이었다. 코드에는 그 값을 넣을 자리가 없었다.

## 결정

1. 묶음 B에 변형 `socialLogin`을 둔다. `form-action`에 다음을 더한다. 값은 [가정]이고, 연동 때 제공자 문서와 스테이징 보고 모드로 확정한다.
   - 카카오 인가 `https://kauth.kakao.com`, 카카오계정 로그인 `https://accounts.kakao.com`. 카카오는 인가 주소가 로그인 화면으로 넘긴다.
   - 네이버 `https://nid.naver.com`
   - 구글 `https://accounts.google.com`
2. 붙이는 화면은 `/login`, `/login/link`, `/my/settings`, `/my/settings/providers`다. 그 밖의 화면은 `'self'` 그대로다(양식이 다른 사이트로 가지 않게).
3. 로컬·CI에서 제공자 issuer를 모의 제공자로 바꾸면(`PEAKET_OIDC_{P}_ISSUER`, social-login 설정이 local·ci에서만 받는다) proxy가 그 출처로 위 값을 덮는다. `PEAKET_CSP_ORIGINS`는 그보다 앞선다. 개발 서버(`next dev`)는 CSP가 보고 모드라 막지 않는다.
4. 같은 확인에서 나온 로그인 폼의 빈 기기 값(deviceId)은 결함으로 고친다.
   - 숨은 칸은 value가 곧 기본값이다. 그래서 누른 뒤 '진행 중'으로 다시 그릴 때 React가 `defaultValue=""`로 되돌렸다.
   - 이제 저장소 값을 그리는 값으로 든다(하이드레이션 뒤).

## 결과

- 막는 CSP 아래에서 로그인·재인증·로그인 수단 추가가 제공자로 간다. 로그인 폼은 다시 그려도 기기 값을 싣고, 기기 행·새 기기 알림·기기 한도가 맞는다(identity §8).
- 남는 한계: 제공자가 인가 중에 다른 출처로 넘기면(지역·계정 상태에 따라) 막힐 수 있다. 연동 때 스테이징 보고 모드로 모아 값을 확정한다.

## 다른 선택지

- 양식 대신 스크립트로 제공자 주소를 받아 이동(`location.assign`)하기: form-action을 피하지만 로그인 시작이 스크립트에 기대게 되고, 앱 서버 양식으로 시작하는 정본 흐름(identity §2 '웹 앱 서버 경로')을 바꿔야 한다. 그래서 출처를 더했다.
- `form-action`을 모든 화면에서 넓히기: 다른 화면의 양식이 제공자 출처로 갈 길이 생긴다. 쓰는 네 화면에만 둔다.
