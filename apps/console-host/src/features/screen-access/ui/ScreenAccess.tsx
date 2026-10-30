// 화면 안 역할 처리(d5 §3.3 '역할별 메뉴 표'). 퍼블리싱에서 ?role=로 역할을 바꾸면 그 역할로 버튼이 비활성·숨김이 된다.
// - ?role=을 고르지 않았으면 위 상태 바를 보드 머리의 역할·사람으로 맞춘다(보드의 CS 담당자는 다은·준이다). 고른 역할은 features/preview-host의 useChosenRole.
// - 표의 '—'인 역할: 화면 대신 권한 안내(ds PermissionDenied). 메뉴에서도 빠져 있다(nav.ts).
// - 읽기만 하는 역할(보드에 그 역할 상태가 없을 때): 본문 위 안내 한 줄(id ro-why)과, 실행 버튼을 aria-disabled + 이유로 바꾼다.
// 역할 목업(entities)에 기대므로 shared가 아니라 features 층에 둔다.
// 데이터 연결 단계에서 권한은 서버가 판단하고(ADR-0061 결정 4), 이 퍼블리싱 층은 걷어 낸다(ADR-0170).
import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { PermissionDenied } from '@peaket/ds/PermissionDenied';
import { OPERATORS, type Operator } from '@/entities/operator';

/** 이 화면에서 역할이 하는 일: 실행 · 읽기 · 없음(표의 '—') */
export type Access = 'act' | 'read' | 'none';

/** 보드 머리에 그려진 사람. CS 두 역할은 보드 이름(다은·준)이다 */
export const BOARD_PEOPLE: Record<ConsoleRole, Operator> = {
  ...OPERATORS,
  cs_agent: { ...OPERATORS.cs_agent, name: '다은', initial: '다' },
  cs_lead: { ...OPERATORS.cs_lead, name: '준', initial: '준' },
};

const ROLE_LABEL: Record<ConsoleRole, string> = {
  viewer: 'viewer(조회)',
  operator: 'operator(운영자)',
  commander: 'commander(지휘자)',
  cs_agent: 'cs_agent(CS 담당자)',
  cs_lead: 'cs_lead(CS 책임자)',
};

const RoCtx = createContext(false);
const stop = (e: MouseEvent) => e.preventDefault();

export interface RoProps {
  'aria-disabled'?: true;
  'aria-describedby'?: string;
  onClick?: (e: MouseEvent) => void;
}

/** 실행 버튼의 읽기 전용 속성을 만드는 함수. 버튼에 원래 설명 id가 있으면 넘긴다: <button {...ro('cf-sum')}> */
export type Ro = (describedBy?: string) => RoProps;

/**
 * 실행 버튼에 펼쳐 넣는다. 읽기 전용이면 aria-disabled와 이유(ro-why)를 붙이고 누름을 막는다.
 * 원래 설명(aria-describedby)은 덮어쓰지 않고 그 뒤에 ro-why를 이어 붙인다.
 */
export function useRo(): Ro {
  const on = useContext(RoCtx);
  return (describedBy) => {
    if (!on) return describedBy ? { 'aria-describedby': describedBy } : {};
    return { 'aria-disabled': true, 'aria-describedby': describedBy ? `${describedBy} ro-why` : 'ro-why', onClick: stop };
  };
}

/** 읽기 전용 안내 한 줄과 그 범위. on이 거짓이면 children만 그린다 */
export function ReadOnlyScope({
  on,
  role,
  who,
  title,
  children,
}: {
  on: boolean;
  role: ConsoleRole;
  who: string;
  /** 읽기만이 아니라 일부만 막을 때의 제목(예: '요청만 합니다') */
  title?: string;
  children: ReactNode;
}) {
  return (
    <RoCtx.Provider value={on}>
      {on ? (
        <div className="banner banner-info" role="status" style={{ marginBottom: 12 }}>
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body" id="ro-why">
            <span className="banner-title">{title ?? `${ROLE_LABEL[role]}는 이 화면을 읽기만 합니다`}</span>
            실행 버튼은 {who}만 누를 수 있습니다(역할별 메뉴 표).
          </div>
        </div>
      ) : null}
      {children}
    </RoCtx.Provider>
  );
}

/** 표의 '—'인 역할로 주소를 직접 열었을 때 */
export function NoAccess({ title, role, who }: { title: string; role: ConsoleRole; who: string }) {
  return (
    <section className="widget" aria-label={title}>
      <PermissionDenied
        variant="inline"
        headingLevel={1}
        title={`${title} 화면은 ${ROLE_LABEL[role]} 메뉴에 없습니다`}
        description={`이 화면은 ${who}가 씁니다. 필요한 일은 담당 역할에게 요청하세요.`}
        actions={
          <Link className="btn btn-outline" to="/dashboard">
            대시보드로 가기
          </Link>
        }
        style={{ padding: '64px 16px' }}
      />
    </section>
  );
}
