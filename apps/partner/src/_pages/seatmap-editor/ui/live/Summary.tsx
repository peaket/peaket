'use client';
// 아래 요약 줄(d5 §6.5 ⑧): 좌석 수 · 등급별 수 · 예상 매출 · 휠체어석 수. HOT-220만 마친 화면은 휠체어석 수만 보이고
// 기준 검사(W1~W3)·겹침·도형 밖 경고는 HOT-230이 더한다(ADR-0264 결정 1).
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { checkSeatmap } from '@peaket/validation/seatmap-checks';
import { seatTotal } from '../../model/doc';
import { tierSummary } from '../../model/price-tiers';
import type { EditorStore } from '../../model/store';

export function Summary({ store }: { store: EditorStore }) {
  const doc = useStore(store, (s) => s.doc);
  const total = seatTotal(doc);
  const tiers = tierSummary(doc);
  const wheel = doc.order.reduce((n, id) => n + doc.sections[id]!.seats.filter((x) => x.wheelchair).length, 0);
  const revenue = tiers.reduce((n, t) => n + t.revenue, 0);
  // 서버 저장 전에 같은 검사기로 화면에서도 경고를 보인다(ADR-0264 결정 15). 저장을 막지 않는다
  const warnings = useMemo(() => checkSeatmap({ sections: doc.order.map((id) => doc.sections[id]!) }), [doc]);
  const outside = warnings.find((w) => w.code === 'SEAT_OUTSIDE_SHAPE')?.seatCount ?? 0;
  return (
    <section className="card row wrap" aria-label="좌석 요약" style={{ padding: '10px 14px', gap: 14 }}>
      <span className="t-sm" data-testid="summary-seats">{`좌석 ${total.toLocaleString('ko-KR')}`}</span>
      <span className="t-sm">{`구역 ${doc.order.length.toLocaleString('ko-KR')}`}</span>
      {tiers.map((t) => (
        <span key={t.tierId} className="t-sm muted">{`${t.name} ${t.seats.toLocaleString('ko-KR')}`}</span>
      ))}
      <span className="t-sm">{`예상 매출 ₩${revenue.toLocaleString('ko-KR')}`}</span>
      <span className="t-sm">{`휠체어석 ${wheel.toLocaleString('ko-KR')}`}</span>
      {warnings.length > 0 ? <span className="t-sm fw-b" role="status">{`확인 필요 ${warnings.length}`}</span> : null}
      {outside > 0 ? <span className="t-sm fw-b" role="status">{`위치 확인 ${outside.toLocaleString('ko-KR')}석`}</span> : null}
    </section>
  );
}
