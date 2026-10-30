// CMP-042 CameraView(카메라 뷰파인더). 정본: docs/design/d3 SCR-034·036·052, 키트 21절(.viewfinder·.vf-frame).
// - 지금은 퍼블리싱용 자리 표시다: 어두운 면 위에 네모 모서리만 그린다. 실제 카메라 영상(후면 1280×720)과
//   Worker 디코딩(BarcodeDetector·zxing-wasm)은 판정 경로를 만드는 단계(wbs 5.x, docs/frontend.md §5.5)에서 붙인다.
// - 안내 글이 있으면 children으로 넣는다. 안내 글 없이 그림으로만 둘 때는 asImage로 role="img"와 이름을 단다.
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../../lib/cx";

export interface CameraViewProps {
  /** 화면 낭독기가 읽을 이름(예: '카메라 뷰파인더') */
  label: string;
  /** 네모 한 변(px). 기본은 키트 값(폭의 62%, 최대 260) */
  frameWidth?: number;
  /** 안내 글 없이 그림 하나로 둘 때 */
  asImage?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function CameraView({ label, frameWidth, asImage = false, className, style, children }: CameraViewProps) {
  return (
    <div
      className={cx("viewfinder", className)}
      style={style}
      role={asImage ? "img" : undefined}
      aria-label={asImage ? label : undefined}
    >
      {asImage ? null : <span className="sr-only">{label}</span>}
      <div className="vf-frame" style={frameWidth !== undefined ? { width: frameWidth } : undefined} />
      {children}
    </div>
  );
}
