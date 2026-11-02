// 소셜 로그인 제공자(docs/features/identity.md §2, ADR-0119). 운영의 issuer는 제공자가 공개한 OIDC 발견 문서의 값으로 고정한다
// (asvs/auth.md 10.5.3, 2026-10-28 확인). 로컬·CI만 모의 제공자 주소로 바꿀 수 있다.
export const PROVIDERS = ['kakao', 'naver', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_ISSUER: Readonly<Record<Provider, string>> = Object.freeze({
  kakao: 'https://kauth.kakao.com',
  naver: 'https://nid.naver.com',
  google: 'https://accounts.google.com',
});

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

/** identity.proto Provider 이름 */
export const PROTO_PROVIDER: Readonly<Record<Provider, string>> = Object.freeze({ kakao: 'PROVIDER_KAKAO', naver: 'PROVIDER_NAVER', google: 'PROVIDER_GOOGLE' });
