// 원격 위젯 자리(실제 값, ADR-0100 결정 6, ADR-0360). 원격(대기열·구매 팀)의 위젯 정보를 싣고 계약 주판이 맞으면 위젯을 늦게 싣는다.
// 값은 위젯이 ConsoleServices(REST 위젯 조회 + 위젯 흐름)로 받는다. 싣는 동안은 스켈레톤, 원격을 받지 못하면 그 자리만 '받지 못함' 카드다(CMP-035).
// 퍼블리싱(?state=) 화면은 이 자리 대신 고정 자료 위젯을 그린다(board-d).
import { Component, useEffect, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { isLoadable, type DetailLink, type WidgetProps } from '@peaket/console-contract';
import { servicesFor } from '@/shared/api/live';
import { loadRemoteWidgets, type RemoteName } from '@/shared/lib/remotes/load-remote';
import { useLiveHost } from '@/shared/model/live-host';
import { FailCard, Skeleton } from './WidgetSlot';

interface RemoteWidgetProps {
  remote: RemoteName;
  /** 위젯 정보의 name(예: queue-admission-rate) */
  name: string;
  title: string;
  style?: CSSProperties;
}

class Boundary extends Component<{ title: string; style?: CSSProperties; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <FailCard title={this.props.title} style={this.props.style} remote /> : this.props.children;
  }
}

const noop = (_: DetailLink) => undefined;
const noStatus = () => undefined;
const RANGE_MS = 15 * 60_000;

export function RemoteWidget({ remote, name, title, style }: RemoteWidgetProps) {
  const [Widget, setWidget] = useState<ComponentType<WidgetProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const eventId = useLiveHost((s) => s.scope.eventId);
  const services = useMemo(() => servicesFor(name), [name]);
  useEffect(() => {
    let alive = true;
    loadRemoteWidgets(remote)
      .then((list) => {
        const m = list.find((w) => w.name === name);
        if (!m || !isLoadable(m)) throw new Error(`실을 수 없는 위젯: ${name}`);
        return m.load();
      })
      .then((mod) => {
        if (alive) setWidget(() => mod.default);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [remote, name]);
  const timeRange = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - RANGE_MS).toISOString(), to: to.toISOString() };
  }, [eventId]);
  if (failed) return <FailCard title={title} style={style} remote />;
  if (!Widget) return <Skeleton title={title} style={style} />;
  return (
    <Boundary title={title} style={style}>
      <div style={{ display: 'contents' }} data-remote={remote} data-widget={name}>
        <Widget eventId={eventId} timeRange={timeRange} density="comfortable" collapsed={false} services={services} onOpenDetail={noop} onStatus={noStatus} />
      </div>
    </Boundary>
  );
}
