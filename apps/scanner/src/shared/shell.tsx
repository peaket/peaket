// 스캐너 화면들이 함께 쓰는 셸 조각: 표준 상태 띠와 아래 바(d5 §3.4). 셸 자체는 @peaket/ds/ScannerShell(CMP-065 scanner)이다.
import { ScannerStatusStrip } from "@peaket/ds/ScannerShell";
import type { CSSProperties, ReactNode } from "react";
import { lead, placement, staff } from "../fixtures/scanner";
import { Link, navigate, renderLink } from "../app/router";
import type { ScannerLayout } from "../app/layout";

export const OFFLINE_LABEL = "오프라인 · 마지막 변경분 3분 전";

/** 태블릿 배치는 띠·아래 바 좌우 여백이 24px다(보드 -t) */
export const stripStyle = (layout: ScannerLayout): CSSProperties | undefined =>
  layout === "t" ? { padding: "8px 24px" } : undefined;
export const bottomStyle = (layout: ScannerLayout): CSSProperties | undefined =>
  layout === "t" ? { padding: "10px 24px 14px" } : undefined;

export function logout() {
  // 퍼블리싱 단계: 업로드 대기를 비우고 세션을 끝내는 일은 데이터 연결 단계에서 붙인다. 지금은 로그인 화면으로 간다.
  navigate("/login");
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
  return (
    <ScannerStatusStrip
      user={{ name: who.name, initial: who.initial }}
      role={{ label: who.role, tone: asStaff ? "staff" : "lead" }}
      zone={hidePlacement ? undefined : placement.zone}
      mode={hidePlacement ? undefined : mode}
      badges={badges}
      network={online ? { online: true } : { online: false, label: OFFLINE_LABEL }}
      queue={{ count: queue, href: "/sync", current: queueCurrent }}
      onLogout={logout}
      renderLink={renderLink}
    />
  );
}

/** 아래 바의 [현장 관리](현장 책임자만) */
export function ManageLink({ current = false }: { current?: boolean }) {
  return (
    <Link className="btn btn-secondary" href="/manage" aria-current={current ? "page" : undefined} style={{ height: 44 }}>
      현장 관리
    </Link>
  );
}
