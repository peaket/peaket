// 게이트 스캐너 진입점. 라이트 고정(<body class="pk">, .dark를 붙이지 않는다, d1 §4).
// 전역 CSS(층 순서 선언이 맨 앞)를 다른 무엇보다 먼저 가져온다. 부품 CSS가 먼저 묶이면 그 층이 가장 약한 층이 된다(d2 §1, FE-T36)
import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { registerServiceWorker } from "./sw/register";

// 앱 셸 서비스 워커는 뜰 때 한 번 등록한다. 실패해도 앱은 온라인으로 계속 뜬다(offline-gate §6.2).
void registerServiceWorker({ url: "/sw.js", scope: "/" });

const root = document.getElementById("root");
if (!root) throw new Error("#root가 없습니다");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
