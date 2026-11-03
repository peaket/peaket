// 뿌리 ESLint 설정(pnpm lint). 지금은 서비스 안 구조의 층 의존 방향 규칙만 건다(docs/architecture.md §3.1, 기술 검토 낮음-008).
// 화면 앱의 공용 규칙(docs/frontend.md, asvs/delivery.md 3.2.2)은 그 규칙이 생기는 단계에서 여기에 더한다.
import { serviceLayerConfigs } from './packages/config/eslint/service-layers.mjs';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.turbo/**'] },
  ...serviceLayerConfigs(['services/*/src/modules', 'packages/platform/template/src/modules']),
];
