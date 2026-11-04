// SEED CSS 층 탐침(FE-T36 PoC, docs/frontend.md §5.17·§6.3, BUILD_ORDER BAS-170). 제품 화면이 아니다.
// 앱은 PoC 빌드(PEAKET_POC=seed-css)에서만 이 탐침을 싣는다(웹·파트너는 page.poc.tsx, 관제·스캐너·포렌식은 poc-seed-css.html).
// SEED recipe(action-button)를 React 밖에서 직접 써서 그 앱의 번들러가 recipe CSS를 seed-components 층에 싣는지(②)와,
// 같은 요소에 준 Tailwind 유틸(px-8)이 SEED 부품을 이기는지, Tailwind 초기화(button 배경 없앰)가 SEED 부품을 덮지 않는지(④)를 본다.
// 검사는 tools/web-checks/seed-css/가 한다.
import { actionButton } from '@seed-design/css/recipes/action-button';

const seedButton = actionButton({ variant: 'brandSolid', size: 'medium', layout: 'withText' });

export function SeedLayerProbe() {
  return (
    <main className="p-6" data-probe="seed-layer">
      <h1 className="t-lg fw-b">SEED CSS 층 탐침(FE-T36)</h1>
      <p className="mt-4">
        <button type="button" data-probe="seed-util" className={`${seedButton} px-8`}>
          SEED 부품과 Tailwind 유틸
        </button>
      </p>
      <p className="mt-4">
        <button type="button" data-probe="seed-only" className={seedButton}>
          SEED 부품만
        </button>
      </p>
    </main>
  );
}
