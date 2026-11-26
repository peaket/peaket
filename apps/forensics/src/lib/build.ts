// F-04-16 포렌식 앱의 빌드 갈래와 응답 헤더. 정본: docs/frontend.md §5.14.1(묶음 G·C+COEP)·§5.19,
// docs/features/forensic-replay.md §6.8, docs/design/d5 §7.17. 운영 빌드는 콘솔과 같은 출처의 /forensics/ 아래에 둔다.
import { consoleForensicsHeaders, staticAppHeaders } from '@peaket/config/headers/security-headers.mjs';

export type ForensicsMode = 'demo' | 'operating';

export function forensicsMode(env: Record<string, string | undefined>): ForensicsMode {
  const value = env.PEAKET_FORENSICS_MODE;
  if (value === undefined || value === 'demo') return 'demo';
  if (value === 'operating') return 'operating';
  throw new TypeError(`PEAKET_FORENSICS_MODE는 demo 또는 operating이어야 합니다: ${value}`);
}

export function forensicsInput(mode: ForensicsMode): Record<string, string> {
  return mode === 'operating' ? { forensics: 'operating.html' } : { index: 'index.html' };
}

export function forensicsBase(mode: ForensicsMode): '/' | '/forensics/' {
  return mode === 'operating' ? '/forensics/' : '/';
}

function sourceHeaders(mode: ForensicsMode): Record<string, string> {
  return mode === 'operating' ? consoleForensicsHeaders() : staticAppHeaders('forensics');
}

export function forensicsDevHeaders(mode: ForensicsMode): Record<string, string> {
  const h = sourceHeaders(mode);
  return {
    'Referrer-Policy': h['Referrer-Policy'],
    'Cross-Origin-Opener-Policy': h['Cross-Origin-Opener-Policy'],
    'Cross-Origin-Embedder-Policy': h['Cross-Origin-Embedder-Policy'],
    'Permissions-Policy': h['Permissions-Policy'],
  };
}

export function forensicsPreviewHeaders(mode: ForensicsMode): Record<string, string> {
  return sourceHeaders(mode);
}
