// 자동 제어 배너(F-03-3 OPS-380, C-T31 ①, docs/features/control-tower.md §6의 6, d5 §7.2 '제어 입력 없음'·'버짓 50% 소진·10배 경보').
// 호스트 control 슬라이스(늘 여는 흐름 control 사건 본문)를 그린다. 입력 없음은 danger, 자동 증액 멈춤은 warning이고 그 밖에는 그리지 않는다(위 상태 바가 보인다).
import { Link } from 'react-router';
import type { LiveControl } from '@/shared/model/live-host';
import { fmt, kst } from './frame';

/** 없는 입력 이름(admission-ctrl inputStaleKinds)의 글 */
const INPUT_LABEL: Record<string, string> = {
  downstream_latency: '하류 지연',
  downstream_errors: '하류 오류',
  seat_store: '좌석 저장소',
  budget_burn: '버짓 소진',
};

export function ControlBanner({ control }: { control: LiveControl }) {
  if (control.kind === 'no-input') {
    const target = typeof control.targetNow === 'number' ? `목표를 ${fmt(control.targetNow)}명으로 유지합니다` : '목표를 그대로 유지합니다';
    const kinds = (control.inputStaleKinds ?? []).map((k) => INPUT_LABEL[k] ?? k);
    return (
      <div className="banner banner-danger" role="alert">
        <i className="ic ic-pulse" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">자동 제어 입력이 끊겼습니다 · {target}</span>
          {control.since ? `${kst(control.since)}부터 ` : ''}
          {kinds.length > 0 ? `${kinds.join('·')} 입력이 들어오지 않아 ` : ''}
          자동 조절과 버짓 연동 감축을 멈췄습니다. 목표를 늘리지도 줄이지도 않습니다. 운영 명령(명령 1·2·3·6)은 그대로 쓸 수 있습니다.
        </div>
        <div className="row" style={{ gap: 14, alignSelf: 'center' }}>
          <Link to="/commands" className="link-more">
            운영 명령
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      </div>
    );
  }
  if (control.kind === 'raise-stopped') {
    const cut = control.lastDecrease && typeof control.lastDecrease.from === 'number' && typeof control.lastDecrease.to === 'number' ? ` 동시 입장 목표를 ${fmt(control.lastDecrease.from)}명에서 ${fmt(control.lastDecrease.to)}명으로 낮췄습니다.` : '';
    return (
      <div className="banner banner-warning" role="status">
        <i className="ic ic-alert" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">자동 증액이 멈췄습니다. 명령 1로 목표를 정하세요</span>
          {control.budgetHoldAt ? `${kst(control.budgetHoldAt)}에 버짓 연동 감축을 했습니다.` : '버짓 연동 감축을 했습니다.'}
          {cut} 운영자가 명령 1로 목표를 정할 때까지 자동 증액을 멈춥니다.
        </div>
        <div className="row" style={{ gap: 14, alignSelf: 'center' }}>
          <Link to="/commands" className="link-more">
            명령 1 동시 입장 목표
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      </div>
    );
  }
  return null;
}
