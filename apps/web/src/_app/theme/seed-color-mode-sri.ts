// 생성 파일: 손으로 고치지 않는다. `pnpm --filter @peaket/web color-mode`가 public/seed-color-mode.js의 SHA-256으로 다시 만든다(BUILD_ORDER BAT-172).
export const SEED_COLOR_MODE_SRI = 'sha256-EZHpuGyq959I04GOtQl2BVUkp36V0O3MSY9cCoSqr3c=';

if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(SEED_COLOR_MODE_SRI)) {
  throw new Error('seed-color-mode-sri.ts의 SEED_COLOR_MODE_SRI가 sha256-… 꼴이 아니다: pnpm --filter @peaket/web color-mode');
}
