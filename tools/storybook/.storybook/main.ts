// @peaket/ds Storybook 설정(docs/design/d2 §1 '시각 회귀', docs/frontend.md FE-T18·FE-T40, BUILD_ORDER BAS-180).
// - 이 작업 공간(tools/storybook)은 뿌리 작업 공간과 따로다. 이야기 파일은 부품 옆(packages/ds/src/components/*/*.stories.tsx)에 둔다.
//   부품이 가져오는 react·SEED 패키지는 뿌리 설치(packages/ds/node_modules)에서 풀리므로, react·react-dom은 이 작업 공간의
//   한 벌로 모은다(resolve.dedupe). 두 벌이면 훅이 깨진다.
// - 이야기(story)는 부품 상태마다 하나다. 정적 빌드(`pnpm run build`)를 FE-T40 시각 회귀와 FE-T18 접근성·동작 검사
//   (tools/web-checks/ds/)가 판을 고정한 Playwright 컨테이너에서 연다.
// - 밖으로 정보를 보내지 않게 사용 통계 전송(telemetry)을 끈다. 개발 서버(`pnpm run dev`)는 새 판 확인도 끄고(--no-version-updates),
//   새 소식 알림을 끈다. 개발 서버의 관리 화면은 새 소식 내용을 storybook.js.org에서 받아 올 수 있다(정적 빌드·CI는 받지 않는다).
// - SEED 부품 CSS는 층 판(seed-layered 조건)으로 싣는다. 앱과 같은 Vite 조건·Tailwind 플러그인을 쓴다(d2 §1).
// - 운영 배포에는 올리지 않는다(docs/security/asvs/frontend.md 13.4.2·13.4.5).
import type { StorybookConfig } from '@storybook/react-vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions } from 'vite';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const config: StorybookConfig = {
  stories: ['../../../packages/ds/src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  typescript: { reactDocgen: 'react-docgen' },
  async viteFinal(cfg) {
    cfg.plugins = [...(cfg.plugins ?? []), react(), tailwindcss()];
    cfg.resolve = { ...cfg.resolve, conditions: ['seed-layered', ...defaultClientConditions], dedupe: ['react', 'react-dom'] };
    cfg.server = { ...cfg.server, fs: { ...cfg.server?.fs, allow: [repoRoot] } };
    return cfg;
  },
};

export default config;
