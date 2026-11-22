// 파트너 콘솔 화면 보안 값(OPS-340, docs/frontend.md §5.14.1, ADR-0360 결정 7). proxy.ts와 루트 레이아웃이 함께 쓴다.

/** 루트 레이아웃이 요청 nonce를 읽는 요청 머리. proxy가 요청마다 덮어쓴다(바깥 요청의 같은 머리는 쓰이지 않는다) */
export const NONCE_HEADER = 'x-nonce';

/** Trusted Types 정책 이름(보고 모드): peaket(ds 서식 글 기본 정책), peaket-paste(붙여넣기 해석), nextjs(Next.js 클라이언트), default(좁은 기본 정책) */
export const PARTNER_TRUSTED_TYPES = ['peaket', 'peaket-paste', 'nextjs', 'default'] as const;

export const PARTNER_TRUSTED_TYPES_REPORT_ONLY = `require-trusted-types-for 'script'; trusted-types ${PARTNER_TRUSTED_TYPES.join(' ')}; report-to csp`;

/** 좁은 기본 정책 스크립트(같은 출처 파일)와 그 무결성(SHA-384, public/trusted-types-default.js를 고치면 다시 잰다) */
export const TRUSTED_TYPES_DEFAULT_SRC = '/trusted-types-default.js';
export const TRUSTED_TYPES_DEFAULT_SRI = 'sha384-c0S45Ru1JZ2mwcSJRutQxFEjSLezKMVrZcqjczCQPP9YKdShNcne9YO8MFLq4TKl';
