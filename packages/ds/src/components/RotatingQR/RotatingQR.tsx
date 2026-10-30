'use client';
// CMP-029 RotatingQR(d2 CMP-029, d5 §5.13, ADR-0025·0051, 기술 검토 낮음-106). 보드 SCR-013 마크업을 그대로 낸다:
//   <div class="qr-wrap is-live" role="img" aria-label="입장 QR, 티켓 T-48213-01, …"><div class="qr"><i class="on"></i>…(29×29)</div></div>
//   <div class="row"><span class="qr-ring"></span><span class="t-sm fw-b">15초마다 바뀝니다</span><span class="mono t-xs muted">지금 15:42:08</span></div>
//   stale: <div class="row"><span class="badge badge-warning">15초 지남</span><span class="mono t-xs muted">지금 15:42:31</span></div>
// - 퍼블리싱 단계라 서명한 실제 QR이 아니라 보드와 같은 가짜 무늬(씨앗으로 만든 29×29 칸)를 그린다(add-screen-publishing 결정 8).
// - QR 그림은 15초마다 한 프레임에 바로 바꾼다(겹치는 전환 없음). 바뀐 것은 둘레 점선(.qr-wrap.is-live)과 '지금 시:분:초' 글자로 알린다.
//   움직임 줄이기 설정이면 키트 CSS가 점선을 멈추고 시각만 매초 바뀐다. 주기적으로 바뀌므로 aria-live는 쓰지 않는다.
// - 도는 동안 화면 꺼짐 방지(Screen Wake Lock)를 건다. 브라우저가 지원하지 않거나 거절하면 조용히 넘어간다(밝기는 바꿀 수 없다).
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { cx } from '../../lib/cx';

const SIZE = 29;

/** 보드 qrCells(seed)와 같은 가짜 QR 무늬(29×29, 위치 찾기 무늬 셋·타이밍 줄·정렬 무늬 하나). 참이면 검은 칸 */
export function qrCells(seed: number): boolean[] {
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const n = SIZE;
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

export interface QrPatternProps {
  /** 대체 텍스트(티켓·코드 식별자를 넣는다) */
  label: string;
  /** 무늬 씨앗(목업) */
  seed: number;
  /** 둘레 점선이 도는 모양(.qr-wrap.is-live). 부스 코드처럼 입장 QR이 아니면 거짓 */
  live?: boolean;
  /** 최대 폭(px). 폭은 부모를 꽉 채우고 이 값에서 멈춘다 */
  maxWidth?: number;
  className?: string;
  style?: CSSProperties;
}

/** 정적 QR 그림(부스 코드 QR 등). 입장 QR은 RotatingQR을 쓴다 */
export function QrPattern({ label, seed, live = false, maxWidth, className, style }: QrPatternProps) {
  const cells = useMemo(() => qrCells(seed), [seed]);
  return (
    <div
      className={cx('qr-wrap', live && 'is-live', className)}
      role="img"
      aria-label={label}
      style={{ width: '100%', ...(maxWidth ? { maxWidth } : null), ...style }}
    >
      <div className="qr">
        {cells.map((on, i) => (
          <i key={i} className={on ? 'on' : undefined} />
        ))}
      </div>
    </div>
  );
}

export interface RotatingQRProps {
  /** 대체 텍스트. 티켓 식별자를 넣는다(예: '입장 QR, 티켓 T-48213-01, R구역 12열 7번, 15초마다 바뀝니다') */
  label: string;
  /** 첫 무늬 씨앗(목업). 15초마다 1씩 늘어 무늬가 바뀐다 */
  seed?: number;
  /** 보이는 시작 시각 'HH:MM:SS'(목업 시계). 없으면 기기 시각 */
  startTime?: string;
  /** 거짓이면 처음 무늬·시각 그대로 그린다(상태 미리보기) */
  running?: boolean;
  /** 15초 지남(기기 시계·잠금): 안내 줄 대신 <15초 지남> 배지 */
  stale?: boolean;
  /** 최대 폭(px). 기본 324(휴대폰 360 화면의 90%) */
  maxWidth?: number;
  /** 화면 꺼짐 방지를 걸지. 기본 참 */
  wakeLock?: boolean;
  className?: string;
}

const PERIOD = 15;

function parseClock(text: string | undefined): number {
  if (!text) {
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  const [h = 0, m = 0, s = 0] = text.split(':').map((v) => Number(v) || 0);
  return h * 3600 + m * 60 + s;
}

function clock(total: number): string {
  const t = ((total % 86400) + 86400) % 86400;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<{ release(): Promise<void> }>;
}

export function RotatingQR({
  label,
  seed = 17,
  startTime,
  running = true,
  stale = false,
  maxWidth = 324,
  wakeLock = true,
  className,
}: RotatingQRProps) {
  const [elapsed, setElapsed] = useState(0);
  // 시작 시각이 없으면 서버와 첫 그림을 맞추려고 '--:--:--'로 그린 뒤 기기 시각으로 바꾼다
  const [base, setBase] = useState<number | null>(() => (startTime ? parseClock(startTime) : null));

  useEffect(() => {
    if (base === null) setBase(parseClock(undefined));
  }, [base]);

  useEffect(() => {
    if (!running || stale) return;
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [running, stale]);

  useEffect(() => {
    if (!wakeLock || !running || typeof navigator === 'undefined') return;
    const api = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!api) return;
    let sentinel: { release(): Promise<void> } | null = null;
    let cancelled = false;
    api
      .request('screen')
      .then((s) => {
        if (cancelled) void s.release().catch(() => {});
        else sentinel = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      void sentinel?.release().catch(() => {});
    };
  }, [wakeLock, running]);

  const frame = Math.floor(elapsed / PERIOD);
  const now = base === null ? '--:--:--' : clock(base + elapsed);

  return (
    <div className={cx('col', className)} style={{ gap: 12, alignItems: 'center', alignSelf: 'stretch' }}>
      <QrPattern label={label} seed={seed + frame} live maxWidth={maxWidth} />
      {stale ? (
        <div className="row" style={{ gap: 8 }}>
          <span className="badge badge-warning">15초 지남</span>
          <span className="mono t-xs muted">지금 {now}</span>
        </div>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <span className="qr-ring" aria-hidden="true" />
          <span className="t-sm fw-b">15초마다 바뀝니다</span>
          <span className="mono t-xs muted">지금 {now}</span>
        </div>
      )}
    </div>
  );
}
