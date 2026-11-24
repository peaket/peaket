// 스캐너 화면들이 함께 쓰는 셸 조각: 표준 상태 띠와 아래 바(d5 §3.4). 셸 자체는 @peaket/ds/ScannerShell(CMP-065 scanner)이다.
import { ScannerStatusStrip } from "@peaket/ds/ScannerShell";
import type { CSSProperties, ReactNode } from "react";
import { liveRequested } from "../api/config";
import { lead, placement, staff } from "../fixtures/scanner";
import { liveRuntime } from "../app/live-runtime";
import { Link, navigate, renderLink, useLocation } from "../app/router";
import type { ScannerLayout } from "../app/layout";

export const OFFLINE_LABEL = "오프라인 · 마지막 변경분 3분 전";

/** 실제 연결 화면 사이를 옮겨도 `?live=1`을 잃지 않게 한다(?live=1은 이 빌드의 실제 연결 스위치다) */
export function withLive(href: string, search: string): string {
  if (!liveRequested(search)) return href;
  return `${href}${href.includes("?") ? "&" : "?"}live=1`;
}

/** 태블릿 배치는 띠·아래 바 좌우 여백이 24px다(보드 -t) */
export const stripStyle = (layout: ScannerLayout): CSSProperties | undefined =>
  layout === "t" ? { padding: "8px 24px" } : undefined;
export const bottomStyle = (layout: ScannerLayout): CSSProperties | undefined =>
  layout === "t" ? { padding: "10px 24px 14px" } : undefined;

export function logout() {
  // 온라인이면 큐를 10초까지 올린 뒤 토큰을 지우고 로그인 화면으로 간다(7.4.4). 런타임이 없으면 바로 이동한다.
  void liveRuntime.logout().catch(() => navigate("/login"));
}

export interface StripProps {
  /** 일반 스태프 세션(도윤)이면 true */
  asStaff?: boolean;
  online?: boolean;
  mode?: "in" | "out";
  queue: number;
  queueCurrent?: boolean;
  /** 배치 구역·모드를 보이지 않을 때(배치 없음·폐기) */
  hidePlacement?: boolean;
  /** 모드 뒤·연결 앞에 둘 배지(배치 없음 등) */
  badges?: ReactNode;
}

export function Strip({ asStaff = false, online = true, mode = "in", queue, queueCurrent, hidePlacement, badges }: StripProps) {
  const who = asStaff ? staff : lead;
  const { search } = useLocation();
  return (
    <ScannerStatusStrip
      user={{ name: who.name, initial: who.initial }}
      role={{ label: who.role, tone: asStaff ? "staff" : "lead" }}
      zone={hidePlacement ? undefined : placement.zone}
      mode={hidePlacement ? undefined : mode}
      badges={badges}
      network={online ? { online: true } : { online: false, label: OFFLINE_LABEL }}
      queue={{ count: queue, href: withLive("/sync", search), current: queueCurrent }}
      onLogout={logout}
      renderLink={renderLink}
    />
  );
}

/** 아래 바의 [현장 관리](현장 책임자만) */
export function ManageLink({ current = false }: { current?: boolean }) {
  const { search } = useLocation();
  return (
    <Link className="btn btn-secondary" href={withLive("/manage", search)} aria-current={current ? "page" : undefined} style={{ height: 44 }}>
      현장 관리
    </Link>
  );
}
