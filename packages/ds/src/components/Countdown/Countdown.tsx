'use client';
// CMP-014 Countdown. 보드 마크업:
//   inline: <span class="timer [is-warning|is-paused|is-expired]" role="timer" aria-label="홀드 남은 시간 3분 58초"><i class="ic ic-clock"></i>홀드 3:58</span>
//   large(오픈까지): <p class="t-display" role="timer" aria-labelledby="cd-l">09:58</p>
// - 다음 초 경계까지 setTimeout으로 기다렸다 깨어나고, 깰 때마다 벽시계로 남은 시간을 다시 계산한다.
//   화면이 다시 보이면(visibilitychange) 바로 다시 맞춘다. requestAnimationFrame은 쓰지 않는다(d2 CMP-014).
// - warning: warnBelow초(기본 60) 미만. paused: 멈춤 아이콘(ic-pause)과 .is-paused, 읽히는 이름 끝에 ', 멈춤'. expired: '만료'.
// - deadline(끝나는 시각, epoch ms) 또는 remaining(남은 초, 그린 때부터 센다 — 목업·미리보기) 가운데 하나를 준다.
// - 낭독(aria-live="polite"): threshold(좌석 홀드: 1분 남았을 때 한 번) · milestones(오픈: 5분·1분·10초) · none.
//   role="timer"는 스스로 읽지 않으므로 이 영역이 알린다.
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { formatDuration } from '../../lib/format';
import { Icon } from '../../icons';

export interface CountdownProps {
  /** 끝나는 시각(epoch ms) */
  deadline?: number;
  /** 남은 초(목업·미리보기). deadline이 없을 때 쓴다 */
  remaining?: number;
  /** 시계를 멈춘다(새 결제 일시 정지 503 동안, ADR-0085). 남은 시간은 그대로 보인다 */
  paused?: boolean;
  /** 시계를 돌릴지. false면 처음 값 그대로 그린다(상태 미리보기) */
  running?: boolean;
  variant?: 'inline' | 'large';
  /** 읽히는 이름 앞말('홀드 남은 시간', '오픈까지') */
  label: string;
  /** large: 이름이 된 보이는 글의 id(aria-labelledby). 주면 label은 낭독 문장에만 쓴다 */
  labelledBy?: string;
  /** inline: 보이는 글자 앞말('홀드' → '홀드 3:58') */
  prefix?: string;
  /** 이 초 미만이면 경고 모양. 기본 60 */
  warnBelow?: number;
  /** 끝난 뒤 보이는 글자. 기본 '만료'(prefix가 있으면 '홀드 만료') */
  expiredText?: string;
  announce?: 'threshold' | 'milestones' | 'none';
  onExpire?: () => void;
  className?: string;
}

const MILESTONES = [300, 60, 10];

function secondsUntil(end: number): number {
  return Math.max(0, Math.ceil((end - Date.now()) / 1000));
}

/** 4:32 · 1:05:12(inline) / 04:32 · 01:05:12(large) */
function clockText(total: number, pad: boolean): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${pad ? String(h).padStart(2, '0') : h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${pad ? String(m).padStart(2, '0') : m}:${ss}`;
}

export function Countdown({
  deadline,
  remaining,
  paused = false,
  running = true,
  variant = 'inline',
  label,
  labelledBy,
  prefix,
  warnBelow = 60,
  expiredText,
  announce = variant === 'large' ? 'milestones' : 'threshold',
  onExpire,
  className,
}: CountdownProps) {
  const [left, setLeft] = useState<number>(() =>
    remaining !== undefined ? Math.max(0, Math.floor(remaining)) : deadline !== undefined ? secondsUntil(deadline) : 0,
  );
  const [spoken, setSpoken] = useState('');
  const leftRef = useRef(left);
  const endRef = useRef<number | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // 남은 초가 경계를 지날 때 한 번씩 알린다
  const prevRef = useRef(left);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = left;
    if (announce === 'none' || left >= prev) return;
    const marks = announce === 'threshold' ? [warnBelow] : MILESTONES;
    const crossed = marks.find((m) => prev > m && left <= m);
    if (crossed !== undefined && left > 0) setSpoken(`${label} ${formatDuration(left)} 남았습니다`);
    if (left === 0 && prev > 0) setSpoken(`${label} 끝났습니다`);
  }, [left, announce, warnBelow, label]);

  useEffect(() => {
    leftRef.current = left;
  }, [left]);

  useEffect(() => {
    if (!running || paused) {
      endRef.current = null;
      return;
    }
    // 시작(또는 멈춤에서 다시 시작)할 때 끝나는 시각을 정한다
    endRef.current = deadline ?? Date.now() + leftRef.current * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const end = endRef.current;
      if (end === null) return;
      const msLeft = end - Date.now();
      const s = Math.max(0, Math.ceil(msLeft / 1000));
      setLeft(s);
      if (s <= 0) {
        onExpireRef.current?.();
        return;
      }
      // 다음 초 경계(남은 ms가 (s-1)초가 되는 때)까지 기다린다
      const delay = msLeft - (s - 1) * 1000;
      timer = setTimeout(tick, Math.max(16, delay + 4));
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [running, paused, deadline]);

  const expired = left <= 0;
  const warning = !expired && !paused && left < warnBelow;
  const live =
    announce === 'none' ? null : (
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
    );

  if (variant === 'large') {
    return (
      <>
        <p
          className={cx('t-display', className)}
          role="timer"
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : `${label} ${formatDuration(left)}`}
          suppressHydrationWarning
        >
          {clockText(left, true)}
        </p>
        {live}
      </>
    );
  }

  const done = expiredText ?? (prefix ? `${prefix} 만료` : '만료');
  const aria = expired
    ? `${prefix ? `${prefix} ` : ''}시간 끝남`
    : `${label} ${formatDuration(left)}${paused ? ', 멈춤' : ''}`;
  return (
    <>
      <span
        className={cx('timer', warning && 'is-warning', paused && !expired && 'is-paused', expired && 'is-expired', className)}
        role="timer"
        aria-label={aria}
        suppressHydrationWarning
      >
        <Icon name={paused && !expired ? 'pause' : 'clock'} />
        {expired ? done : `${prefix ? `${prefix} ` : ''}${clockText(left, false)}`}
      </span>
      {live}
    </>
  );
}
