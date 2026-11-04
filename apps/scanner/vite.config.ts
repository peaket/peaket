// 게이트 스캐너 개발·빌드 설정(Vite 8 + React, docs/frontend.md §2.3).
// - 경로 이동은 앱 안의 작은 경로 고르기(src/app/router.tsx)가 하므로, 모든 주소에 index.html을 준다(appType 'spa').
// - SEED 부품 CSS를 층(@layer seed-components) 안으로 싣는 `seed-layered` 조건을 기본 조건에 더한다(d2 §1).
// - PWA(vite-plugin-pwa)·서비스 워커·Dexie·판정 Worker는 이 퍼블리싱 단계에서 붙이지 않는다(wbs 5.x).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defaultClientConditions, defineConfig } from "vite";

// SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/)는 탐침 화면(poc-seed-css.html) 하나만 묶는다(운영 빌드처럼 진입점 하나)
const seedCssPoc = process.env.PEAKET_POC === "seed-css";
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  appType: "spa",
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ["seed-layered", ...defaultClientConditions],
  },
  server: { port: 3003, strictPort: true },
  preview: { port: 3003, strictPort: true },
  build: seedCssPoc
    ? { rolldownOptions: { input: { "poc-seed-css": page("./poc-seed-css.html") } } }
    : {},
});
