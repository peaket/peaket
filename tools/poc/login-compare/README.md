# tools/poc/login-compare — 로그인 구현 비교 PoC(I-T51)

ADR-0119 결정 3의 PoC다. 같은 소셜 로그인 흐름을 A(Auth.js, `@auth/core` 0.41.3 = next-auth 5.0.0-beta.32의 엔진. A1 기본 사용법, A2 문서 기능으로 고친 판)와 C(얇은 OIDC 클라이언트: C1 `openid-client` 6.8.8, C2 `oauth4webapi` 3.8.8)로 짜고, 모의 OIDC 제공자 셋과 identity 세션 대역으로 I-T51의 ①~⑥을 돌린다. 방법은 [docs/features/identity.md](../../../docs/features/identity.md) §12.1, 결과는 [RESULT.md](RESULT.md)다. 제품 코드가 아니다. 고른 안(C, `openid-client`)은 PRF-020(wbs 2.1.1)이 소비자 웹 앱 서버에 새로 쓴다.

뿌리 작업 공간과 따로 둔 작업 공간이다(자기 `pnpm-lock.yaml`, 보안 설정은 뿌리와 같다, docs/devops.md §4.4).

```bash
cd tools/poc/login-compare
pnpm install --frozen-lockfile
node --test --test-reporter=junit --test-reporter-destination=junit.xml
node report.mjs
```

| 파일 | 하는 일 |
| --- | --- |
| `harness.mjs` | 웹 표준 처리기를 Node http로 잇는 서버, 쿠키 모음을 가진 브라우저 흉내, 모의 OIDC 제공자(카카오·네이버·구글 흉내, 잘못된 issuer·aud·서명·nonce, 만료, 발견 문서 issuer 불일치, 네이버 id 불일치를 켜는 시험 스위치), identity 세션 대역 |
| `app-common.mjs` | 네 구현이 함께 쓰는 앱 서버 코드: Origin 대조, identity 세션 생성·끝내기, PEAKET 쿠키, 네이버 사용자 정보 |
| `c-progress.mjs` | C의 로그인 진행 쿠키 `__Host-peaket_oidc`(AES-256-GCM 봉인, 10분) |
| `a-authjs.mjs`(A1), `a-authjs-hardened.mjs`(A2), `c-openid-client.mjs`(C1), `c-oauth4webapi.mjs`(C2) | 네 구현 |
| `login-compare.test.mjs` | 구현마다 I-T51 ①~⑥(18개). 쿠키 수·서명 검증 여부·막힌 이유를 `cookie-counts.json`에 남긴다 |
| `report.mjs` | 시험 보고서·쿠키 수·코드 줄 수로 기준 다섯과 판정을 계산해 `RESULT.md`를 쓴다 |
