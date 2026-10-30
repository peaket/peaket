// CMP-053 DeviceApprovalPanel(기기 승인 QR과 확인 코드). 정본: docs/design/d5 §8.1, d3 SCR-036, 키트 16절(.qr-wrap·.qr·.code-display).
// - 관람객 입장 QR과 다른 모양·문구다: 굵은 인디고 테두리와 '기기 승인 QR · 관람객 입장 QR 아님' 이름표.
// - 확인 코드는 한 글자씩 읽게 aria-label을 단다(하이픈은 '하이픈'). 5분마다 한 프레임에 바로 바꾼다(겹치는 전환 없음).
// - QR 그림은 퍼블리싱용 근사다(캔버스 보드의 29×29 무늬를 같은 식으로 만든다). 실제 QR은 wbs 5.1.3 PoC가 고른 라이브러리로 바꾼다.
import { useId, useMemo } from "react";
import { cx } from "../../lib/cx";

export interface DeviceApprovalPanelProps {
  /** md: 휴대폰(세로·가로) · lg: 관리형 태블릿(QR 320, 코드 64px) */
  size?: "md" | "lg";
  /** QR 한 변(px) */
  qrWidth: number;
  /** 무늬를 고르는 씨앗. 코드가 바뀌면 다른 값을 준다 */
  qrSeed: number;
  /** QR 그림 이름(예: '기기 승인 QR, 스캐너 동문-03 로그인용, 5분마다 바뀝니다') */
  qrLabel: string;
  /** 확인 코드(4자-4자) */
  code: string;
  /** lg에서 코드 옆에 보이는 기기 이름 */
  deviceName?: string;
  /** 남은 시간 타이머: 보이는 글자와 낭독 이름 */
  timer: { text: string; label: string };
  /** 타이머 옆 안내 */
  timerNote: string;
  className?: string;
}

/** 확인 코드를 한 글자씩 읽는 이름 */
export function spellCode(code: string): string {
  return code
    .split("")
    .map((c) => (c === "-" ? "하이픈" : c))
    .join(", ");
}

/** 캔버스 보드와 같은 식의 29×29 QR 모양 무늬(찾기 패턴·타이밍·정렬 패턴 + 고정 난수). true면 검은 칸 */
export function approvalQrCells(seed: number): boolean[] {
  const n = 29;
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const out: boolean[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let on: boolean;
      const fr = r < 7 ? r : r >= n - 7 ? r - (n - 7) : -1;
      const fc = c < 7 ? c : c >= n - 7 ? c - (n - 7) : -1;
      const finder = fr >= 0 && fc >= 0 && !(r >= n - 7 && c >= n - 7);
      const sep = !finder && ((r <= 7 && c <= 7) || (r <= 7 && c >= n - 8) || (r >= n - 8 && c <= 7));
      if (finder) on = fr === 0 || fr === 6 || fc === 0 || fc === 6 || (fr >= 2 && fr <= 4 && fc >= 2 && fc <= 4);
      else if (sep) on = false;
      else if (r === 6) on = c % 2 === 0;
      else if (c === 6) on = r % 2 === 0;
      else if (r >= 20 && r <= 24 && c >= 20 && c <= 24) {
        const ar = r - 20;
        const ac = c - 20;
        on = ar === 0 || ar === 4 || ac === 0 || ac === 4 || (ar === 2 && ac === 2);
      } else on = rnd() > 0.52;
      out.push(on);
    }
  }
  return out;
}

export function DeviceApprovalPanel({
  size = "md",
  qrWidth,
  qrSeed,
  qrLabel,
  code,
  deviceName,
  timer,
  timerNote,
  className,
}: DeviceApprovalPanelProps) {
  const headingId = `${useId()}-code`;
  const cells = useMemo(() => approvalQrCells(qrSeed), [qrSeed]);
  const lg = size === "lg";
  const codeEl = (
    <p className="code-display" style={lg ? { fontSize: 64, lineHeight: "76px" } : undefined} role="img" aria-label={`확인 코드 ${spellCode(code)}`}>
      {code}
    </p>
  );
  return (
    <section className={cx("col", className)} style={{ gap: lg ? 20 : 12, alignItems: "center" }} aria-labelledby={headingId}>
      <h2 className="sr-only" id={headingId}>
        기기 승인 QR과 확인 코드
      </h2>
      <figure
        className="col"
        style={{
          gap: lg ? 12 : 10,
          alignItems: "center",
          padding: lg ? 16 : 12,
          border: "4px solid var(--primary)",
          borderRadius: lg ? 24 : 20,
          background: "var(--surface)",
          maxWidth: "100%",
        }}
      >
        {/* 폭 320에서도 넘치지 않게 이름표 글은 줄을 바꿀 수 있게 둔다 */}
        <figcaption className="badge badge-solid badge-lg" style={{ whiteSpace: "normal", textAlign: "center", height: "auto", paddingBlock: 4 }}>
          <i className="ic ic-device" aria-hidden="true" />
          기기 승인 QR · 관람객 입장 QR 아님
        </figcaption>
        <div className="qr-wrap" style={{ width: qrWidth, maxWidth: "100%" }} role="img" aria-label={qrLabel}>
          <div className="qr">
            {cells.map((on, i) => (
              <i key={i} className={on ? "on" : undefined} />
            ))}
          </div>
        </div>
      </figure>
      {lg ? (
        <dl className="row wrap" style={{ justifyContent: "center", alignItems: "flex-start", gap: "8px 40px" }}>
          {deviceName ? (
            <div className="col" style={{ gap: 2, alignItems: "center" }}>
              <dt className="label">기기</dt>
              <dd className="t-2xl">{deviceName}</dd>
            </div>
          ) : null}
          <div className="col" style={{ gap: 2, alignItems: "center" }}>
            <dt className="label">확인 코드</dt>
            <dd>{codeEl}</dd>
          </div>
        </dl>
      ) : (
        <div className="col" style={{ gap: 2, alignItems: "center" }}>
          <span className="label">확인 코드</span>
          {codeEl}
        </div>
      )}
      <div className="row wrap" style={{ justifyContent: "center", gap: lg ? 10 : 8 }}>
        <span className="timer" role="timer" aria-label={timer.label}>
          <i className="ic ic-clock" aria-hidden="true" />
          {timer.text}
        </span>
        <span className={lg ? "t-md fw-b" : "t-sm fw-b"}>{timerNote}</span>
      </div>
    </section>
  );
}
