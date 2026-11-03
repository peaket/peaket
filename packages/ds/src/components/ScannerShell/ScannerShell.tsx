// CMP-065 AppShell의 scanner 변형(게이트 스캐너 셸, 라이트 고정). 정본: docs/design/d5 §3.4, 키트 21절(.ss·.ss-strip·.ss-bottom).
// - 위 상태 띠(header.ss-strip): 닉네임·역할 배지·구역·입장/퇴장(색과 글자)·온라인/오프라인·업로드 대기(→ SCR-035)·[로그아웃]
// - 본문(main#main): 화면이 채운다. 배치(휴대폰 세로·가로, 관리형 태블릿 세로)마다 main의 class·style을 넘긴다.
// - 아래 바(nav.ss-bottom): [현장 관리](현장 책임자만) 등. 넘기지 않으면 그리지 않는다.
// - 라이트 고정: 스캐너는 다크를 쓰지 않는다(d1 §4, d2 §1). 페이지 <body class="pk">에서 쓰고 .dark를 붙이지 않는다.
// - 터치 영역 44px 이상, 현장 주요 버튼은 56px(키트 btn-field)과 버튼 사이 16px(d5 §3.4).
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { renderLinkOrAnchor, type RenderLink } from "../../lib/link";
import { SkipLink } from "../SkipLink";

export interface ScannerShellProps {
  /** 위 상태 띠의 내용(보통 ScannerStatusStrip) */
  strip: ReactNode;
  /** 위 상태 띠의 이름(header aria-label). 로그인 화면은 '스캐너 기기 정보' */
  stripLabel?: string;
  stripStyle?: CSSProperties;
  /** 아래 바의 내용. 없으면 아래 바를 그리지 않는다 */
  bottom?: ReactNode;
  bottomLabel?: string;
  bottomStyle?: CSSProperties;
  mainClassName?: string;
  mainStyle?: CSSProperties;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function ScannerShell({
  strip,
  stripLabel,
  stripStyle,
  bottom,
  bottomLabel = "스캐너 메뉴",
  bottomStyle,
  mainClassName,
  mainStyle,
  className,
  style,
  children,
}: ScannerShellProps) {
  return (
    <div className={cx("ss", className)} style={{ position: "relative", minHeight: "100dvh", ...style }}>
      <SkipLink />
      <header className="ss-strip" aria-label={stripLabel} style={stripStyle}>
        {strip}
      </header>
      <main id="main" tabIndex={-1} className={cx("focus:outline-none", mainClassName)} style={{ flex: 1, ...mainStyle }}>
        {children}
      </main>
      {bottom ? (
        <nav className="ss-bottom" aria-label={bottomLabel} style={bottomStyle}>
          {bottom}
        </nav>
      ) : null}
    </div>
  );
}

export type ScannerRoleTone = "lead" | "staff" | "proxy";

export interface ScannerStatusStripProps {
  /** 닉네임(관람객 이름이 아니라 스태프 닉네임). initial은 동그라미 안 글자 */
  user?: { name: string; initial?: string };
  /** 역할 배지. lead=현장 책임자(진한 배지), staff=현장 스태프, proxy=대리 승인(경고 배지) */
  role?: { label: string; tone?: ScannerRoleTone };
  /** 배치 구역(예: '동문 구역') */
  zone?: string;
  /** 입장·퇴장 모드. 퇴장은 다른 색과 글자로 보인다 */
  mode?: "in" | "out";
  /** 모드 뒤·연결 앞에 둘 배지(예: SCR-033 '배치 없음') */
  badges?: ReactNode;
  /** 연결 상태. 오프라인이면 label에 마지막 변경분을 적는다 */
  network?: { online: true } | { online: false; label: string };
  /** 업로드 대기 건수와 동기화 화면 주소. current면 지금 그 화면이다 */
  queue?: { count: number; href: string; current?: boolean };
  /** 로그아웃 버튼을 누를 때. 주지 않으면 버튼을 그리지 않는다 */
  onLogout?: () => void;
  /** 다른 배지(기기 정보 등)를 끝에 더한다 */
  extra?: ReactNode;
  renderLink?: RenderLink;
}

const roleClass: Record<ScannerRoleTone, string> = {
  lead: "badge badge-solid",
  staff: "badge",
  proxy: "badge badge-warning",
};

/** 상태 띠의 표준 내용(SCR-033·034·035·052·059). 보드의 순서·클래스 그대로다 */
export function ScannerStatusStrip({ user, role, zone, mode, badges, network, queue, onLogout, extra, renderLink }: ScannerStatusStripProps) {
  return (
    <>
      {user ? (
        <span className="who">
          <span className="avatar" style={{ width: 28, height: 28 }} aria-hidden="true">
            {user.initial ?? user.name.slice(0, 1)}
          </span>
          {user.name}
        </span>
      ) : null}
      {role ? <span className={roleClass[role.tone ?? "staff"]}>{role.label}</span> : null}
      {zone ? <span className="badge badge-outline">{zone}</span> : null}
      {mode === "in" ? <span className="badge mode-in">입장</span> : null}
      {mode === "out" ? <span className="badge mode-out">퇴장</span> : null}
      {badges}
      {network ? (
        network.online ? (
          <span className="badge badge-success">
            <i className="ic ic-wifi" aria-hidden="true" />
            온라인
          </span>
        ) : (
          <span className="badge badge-warning">
            <i className="ic ic-wifi-off" aria-hidden="true" />
            {network.label}
          </span>
        )
      ) : null}
      {queue
        ? renderLinkOrAnchor(renderLink, {
            href: queue.href,
            className: "badge",
            "aria-current": queue.current ? "page" : undefined,
            "aria-label": queue.current
              ? `업로드 대기 ${queue.count}건, 동기화 화면(지금 화면)`
              : `업로드 대기 ${queue.count}건, 동기화 화면으로`,
            children: `대기 ${queue.count}`,
          })
        : null}
      {extra}
      {onLogout ? (
        <button className="btn btn-outline btn-sm" type="button" style={{ marginLeft: "auto", height: 44 }} onClick={onLogout}>
          로그아웃
        </button>
      ) : null}
    </>
  );
}
