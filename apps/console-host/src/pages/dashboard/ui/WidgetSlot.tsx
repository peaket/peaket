// 원격 위젯 자리(docs/frontend.md §4.5·§5.7). 위젯마다 오류 경계와 스켈레톤이 따로 있어 하나가 실패해도 나머지는 그린다(CMP-035).
// 퍼블리싱에서는 ctx.slot으로 '위젯 로딩'·'위젯 오류'·'원격 위젯 적재 실패' 상태를 그린다. 카드 모양은 보드 SCR-029-d의 w-verify(받지 못함) 카드다.
import { Component, type CSSProperties, type ReactNode } from 'react';
import { GRAFANA } from '@/entities/alert';
import type { DashCtx } from './ctx';

interface SlotProps {
  ctx: DashCtx;
  title: string;
  /** 이 위젯을 내보내는 원격(팀) */
  remote: 'queue' | 'purchase';
  style?: CSSProperties;
  /** '위젯 오류' 상태에서 실패로 그릴 위젯 */
  failOnError?: boolean;
  children: ReactNode;
}

function FailCard({ title, style, remote }: { title: string; style?: CSSProperties; remote?: boolean }) {
  return (
    <section className="widget is-error" role="region" aria-label={title} style={style}>
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b">{title}</h2>
        <div className="actions" style={{ gap: 12 }}>
          <span className="slo slo-stale">받지 못함</span>
          <a className="link-more" href={GRAFANA} target="_blank" rel="noreferrer" aria-label={`${title} 자세히 보기, Grafana 새 탭`}>
            자세히 보기
            <i className="ic ic-external" aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="widget-body grow" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div className="col" role="alert" style={{ alignItems: 'flex-start', gap: 8 }}>
          <span className="state-icon is-danger" style={{ width: 40, height: 40 }}>
            <i className="ic ic-alert-circle" aria-hidden="true" style={{ width: 20, height: 20 }} />
          </span>
          <strong className="t-sm">이 위젯만 불러오지 못했습니다</strong>
          <p className="t-xs muted">
            {remote
              ? '위젯 파일을 받지 못했습니다(무결성·계약 판 확인 실패 뒤 한 번 더 받았습니다). 다른 위젯은 그대로 그립니다.'
              : '일시적인 오류입니다. 다른 위젯은 그대로 갱신됩니다. 마지막 수신 20:03:52 KST'}
          </p>
          <button className="btn btn-outline btn-sm" type="button">
            <i className="ic ic-refresh" aria-hidden="true" />
            다시 시도
          </button>
        </div>
      </div>
    </section>
  );
}

function Skeleton({ title, style }: { title: string; style?: CSSProperties }) {
  return (
    <section className="widget" role="region" aria-label={title} aria-busy="true" style={style}>
      <div className="widget-head">
        <h2 className="t-sm fw-b">{title}</h2>
      </div>
      <div className="widget-body grow" style={{ gap: 10 }}>
        <span className="sr-only">불러오는 중</span>
        <span className="skel" style={{ height: 14, width: '40%' }} />
        <span className="skel" style={{ height: 34, width: '55%' }} />
        <span className="skel" style={{ height: 64, width: '100%' }} />
        <span className="skel" style={{ height: 14, width: '80%' }} />
      </div>
    </section>
  );
}

class Boundary extends Component<{ title: string; style?: CSSProperties; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <FailCard title={this.props.title} style={this.props.style} /> : this.props.children;
  }
}

export function WidgetSlot({ ctx, title, remote, style, failOnError, children }: SlotProps) {
  if (ctx.slot === 'loading') return <Skeleton title={title} style={style} />;
  if (ctx.slot === 'remote-fail' && remote === 'purchase') return <FailCard title={title} style={style} remote />;
  if (ctx.slot === 'error' && failOnError) return <FailCard title={title} style={style} />;
  return (
    <Boundary title={title} style={style}>
      {children}
    </Boundary>
  );
}
