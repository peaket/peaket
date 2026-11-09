// 캐시 화면(A) CSP 틀을 proxy.ts(Next.js 안)와 앞 서버(csp-hash-server.mjs)가 함께 쓰는 이름과 값(ADR-0193, BUILD_ORDER HOT-290)

/** proxy.ts가 캐시 화면 응답에 싣는 안쪽 머리. 앞 서버가 해시를 채운 CSP로 바꾸고 지운다(밖으로 내보내지 않는다) */
export const CSP_TEMPLATE_HEADER = 'x-peaket-csp-template';
/** 정책 틀 안의 해시 자리. renderCsp의 해시 꼴 검사('sha256-…')를 지나가는 고정 값이다 */
export const HASH_SENTINEL = "'sha256-PEAKET+INLINE+HASHES+='";
