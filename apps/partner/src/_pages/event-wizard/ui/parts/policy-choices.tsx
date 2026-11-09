// 4단계 판매 정책의 좌석 배정 선택지와 공통 문구(퍼블리싱 화면과 실제 위저드가 함께 쓴다).
import type { Choice } from './ChoiceCards';

export const SEAT_CHOICES: readonly Choice[] = [
  { value: 'PICK', title: '좌석 직접 선택', desc: '팬이 좌석맵에서 좌석을 고릅니다' },
  { value: 'AUTO', title: '자동 배정', desc: '팬은 등급·매수·휠체어석 여부만 고르고 시스템이 연석을 배정합니다' },
];

export const PREVIEW_TITLE = '고객 문구 미리보기 · 공연 상세·대기실·결제 직전에 같은 문구로 보입니다';

export function AutoExtra({ disabled }: { disabled?: boolean }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={disabled ? 'e-pref' : 'n-pref'}>
          선호 기준
        </label>
        <div className={disabled ? 'input-group input-group-sm is-disabled' : 'input-group input-group-sm'}>
          <select id={disabled ? 'e-pref' : 'n-pref'} defaultValue="무대 중앙 인접 순(기본)">
            <option>무대 중앙 인접 순(기본)</option>
          </select>
          <i className="ic ic-chevron-down" aria-hidden="true" />
        </div>
        <span className="hint">기본값은 시안에서 확정합니다 [가정]</span>
      </div>
    </>
  );
}
