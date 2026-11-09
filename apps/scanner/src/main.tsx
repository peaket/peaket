// 게이트 스캐너 진입점. 라이트 고정(<body class="pk">, .dark를 붙이지 않는다, d1 §4).
// 전역 CSS(층 순서 선언이 맨 앞)를 다른 무엇보다 먼저 가져온다. 부품 CSS가 먼저 묶이면 그 층이 가장 약한 층이 된다(d2 §1, FE-T36)
import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

const root = document.getElementById("root");
if (!root) throw new Error("#root가 없습니다");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
