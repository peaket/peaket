// 게이트 스캐너 개발·빌드 설정(Vite 8 + React, docs/frontend.md §2.3).
// - 경로 이동은 앱 안의 작은 경로 고르기(src/app/router.tsx)가 하므로, 모든 주소에 index.html을 준다(appType 'spa').
// - SEED 부품 CSS를 층(@layer seed-components) 안으로 싣는 `seed-layered` 조건을 기본 조건에 더한다(d2 §1).
// - PWA(vite-plugin-pwa)·서비스 워커·Dexie·판정 Worker는 이 퍼블리싱 단계에서 붙이지 않는다(wbs 5.x).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  appType: "spa",
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ["seed-layered", ...defaultClientConditions],
  },
  server: { port: 3003, strictPort: true },
  preview: { port: 3003, strictPort: true },
});
