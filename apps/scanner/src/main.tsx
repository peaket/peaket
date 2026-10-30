// 게이트 스캐너 진입점. 라이트 고정(<body class="pk">, .dark를 붙이지 않는다, d1 §4).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root가 없습니다");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
