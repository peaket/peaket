// CMP-041 ScanResult(판정 결과). 정본: docs/design/d3 SCR-034, d5 §8.3, 키트 21절(.scan-result·.scan-pass·.scan-reject·.scan-check·.scan-verify).
// - 판정은 색 + 아이콘 + 글자를 함께 쓴다(색만으로 말하지 않는다). 직사광선을 생각해 대비가 가장 높은 면 색이다.
// - role="alert"로 판정과 사유를 읽어 준다. 결과가 바뀔 때 움직임 없이 바로 바꾼다(d3 SCR-034).
// - 크기: md(휴대폰 세로 오버레이·가로 오른쪽 칸) · lg(관리형 태블릿, 판정 글자 88px)
// - layout inline: 휴대폰 가로 배치처럼 아이콘과 판정을 한 줄에 둔다.
// - 소리·진동은 판정 Worker를 붙이는 단계(wbs 5.x)에서 더한다. 이 부품은 그림만 그린다.
import type { CSSProperties } from "react";
import { cx } from "../../lib/cx";

export type ScanTone = "pass" | "reject" | "check" | "verify";

export interface ScanResultProps {
  /** 판정 색: pass 녹색 · reject 적색 · check 황색 · verify 인디고(확인 스캔) */
  tone: ScanTone;
  /** 큰 글자 판정(통과·거부·확인 필요) */
  verdict: string;
  /** 사유 한 줄(거부·확인 필요) */
  reason?: string;
  /** 굵은 안내 한 줄(예: '현장 책임자 확인 전에는 들여보내지 마세요') */
  note?: string;
  /** 확인 스캔 결과: 위에 '확인 스캔', 아래 '입장 기록 안 함'과 '스캔 기록은 올라갑니다' */
  verify?: boolean;
  /** 좌석 표시(관람객 이름·연락처는 보이지 않는다) */
  seat?: string;
  /** 다음 스캔까지 안내(예: '2초 뒤 다음 스캔') */
  next?: string;
  /** 키트 아이콘 이름을 바꿀 때(기본: pass·verify check-circle, reject x-circle, check alert) */
  icon?: string;
  size?: "md" | "lg";
  layout?: "stack" | "inline";
  className?: string;
  style?: CSSProperties;
}

const toneClass: Record<ScanTone, string> = {
  pass: "scan-pass",
  reject: "scan-reject",
  check: "scan-check",
  verify: "scan-verify",
};

const toneIcon: Record<ScanTone, string> = {
  pass: "check-circle",
  reject: "x-circle",
  check: "alert",
  verify: "check-circle",
};

export function ScanResult({
  tone,
  verdict,
  reason,
  note,
  verify = false,
  seat,
  next,
  icon,
  size = "md",
  layout = "stack",
  className,
  style,
}: ScanResultProps) {
  const lg = size === "lg";
  const inline = layout === "inline";
  const iconName = icon ?? toneIcon[tone];
  const iconSize = lg ? (verify ? 80 : 104) : undefined;
  const iconEl = (
    <i
      className={cx("ic", inline ? "ic-48" : verify && !lg ? "ic-48" : "ic-64", `ic-${iconName}`)}
      aria-hidden="true"
      style={iconSize ? { width: iconSize, height: iconSize } : undefined}
    />
  );
  const verdictEl = (
    <p className="verdict" style={lg ? { fontSize: 88, lineHeight: "100px" } : undefined}>
      {verdict}
    </p>
  );

  const body = (
    <>
      {verify ? <p className={lg ? "t-xl" : "t-lg"}>확인 스캔</p> : null}
      {inline ? (
        <div className="row" style={{ gap: 12 }}>
          {iconEl}
          {verdictEl}
        </div>
      ) : (
        <>
          {iconEl}
          {verdictEl}
        </>
      )}
      {reason ? (
        <p className="reason" style={lg ? { fontSize: 28, lineHeight: "36px" } : undefined}>
          {reason}
        </p>
      ) : null}
      {note ? <p className={lg ? "t-xl" : "t-md fw-b"}>{note}</p> : null}
      {verify ? (
        <>
          <p
            className={lg ? "t-lg" : "t-md fw-b"}
            style={{ border: "2px solid currentColor", borderRadius: 8, padding: lg ? "6px 16px" : "4px 12px" }}
          >
            입장 기록 안 함
          </p>
          <p className={lg ? "t-md fw-b" : "t-sm"}>스캔 기록은 올라갑니다</p>
        </>
      ) : null}
    </>
  );

  return (
    <section
      className={cx("scan-result", toneClass[tone], className)}
      role="alert"
      aria-label="판정 결과"
      style={{ gap: lg ? 14 : inline ? 6 : 8, ...(lg ? { padding: "32px 24px" } : inline ? { padding: "12px 16px" } : null), ...style }}
    >
      {lg ? (
        <div className="col" style={{ gap: 8, alignItems: "center" }}>
          {body}
        </div>
      ) : (
        body
      )}
      {seat ? (
        <p className={cx("row", lg ? "t-xl" : "t-lg")} style={{ gap: lg ? 8 : 6, justifyContent: "center" }}>
          <i className={cx("ic ic-pin", lg ? "ic-28" : "ic-24")} aria-hidden="true" />
          {seat}
        </p>
      ) : null}
      {next ? (
        <p className={cx("row", lg ? "t-lg" : "t-md fw-b")} style={{ gap: lg ? 8 : 6, justifyContent: "center" }}>
          <i className={cx("ic ic-clock", lg ? "ic-24" : "ic-16")} aria-hidden="true" />
          {next}
        </p>
      ) : null}
    </section>
  );
}
