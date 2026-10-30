// CMP-049 ShuffleProofPanel — 셔플 공개 기록 단계 타임라인(키트 .timeline·.tl-item·.tl-dot, 캔버스 보드 SCR-019 '공개 기록').
// 단계마다 제목(h3)·시각·<공개됨|공개 전> 배지와 내용 카드. 공개된 단계는 점이 초록(.tl-dot.ok)이다. 상태는 before·after-shuffle·revealed(d2 §2).
// 서버 컴포넌트에서도 쓴다(복사 버튼 ProofHash만 클라이언트 부품).
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface ShuffleProofStep {
  id: string;
  /** '로비 개방' */
  title: string;
  /** 제목 옆 시각·라운드('10/14(수) 19:50') */
  meta: ReactNode;
  /** 공개됨이면 참(점 초록, 배지 '공개됨'), 아니면 '공개 전' */
  published: boolean;
  /** 공개된 단계의 내용(카드 안), 공개 전 단계의 안내 글 */
  children: ReactNode;
}

export interface ShuffleProofPanelProps {
  steps: readonly ShuffleProofStep[];
  className?: string;
}

export function ShuffleProofPanel({ steps, className }: ShuffleProofPanelProps) {
  return (
    <ol className={cx('timeline', className)}>
      {steps.map((s) => (
        <li key={s.id} className="tl-item">
          <span className={cx('tl-dot', s.published && 'ok')} aria-hidden="true" />
          <div className="col" style={{ gap: 10, minWidth: 0 }}>
            <div className="row wrap" style={{ gap: '4px 8px' }}>
              <h3 className="t-md fw-b">{s.title}</h3>
              <span className="t-sm muted num">{s.meta}</span>
              {s.published ? <span className="badge badge-success">공개됨</span> : <span className="badge">공개 전</span>}
            </div>
            <div>{s.children}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 단계 내용 카드(키트 .card, 휴대폰 안쪽 여백 14 · 태블릿 이상 16) */
export function ProofCard({ children, gap = 12, className }: { children: ReactNode; gap?: number; className?: string }) {
  return (
    <div className={cx('card col p-3.5 md:p-4', className)} style={{ gap }}>
      {children}
    </div>
  );
}

/** 이름표(.t-xs.fw-b.muted) + 값(해시는 .hash) 한 줄. 복사가 필요하면 ProofHash를 쓴다 */
export function ProofValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="t-xs fw-b muted">{label}</span>
      {children}
    </div>
  );
}
