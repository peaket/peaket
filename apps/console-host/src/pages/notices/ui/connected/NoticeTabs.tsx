// SCR-068 탭 셋(d5 §7.16). 역할이 볼 수 있는 탭만 받는다(Page/ConnectedPage가 noticeTabs로 고른다).
import { NOTICE_TAB_LABEL, type NoticeTab } from '../../model/notices';

export function NoticeTabs({ tabs, active, onChange }: { tabs: NoticeTab[]; active: NoticeTab; onChange: (tab: NoticeTab) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="공지 종류">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          className={tab === active ? 'tab is-active' : 'tab'}
          role="tab"
          id={`nt-${tab}`}
          aria-selected={tab === active}
          aria-controls={`np-${tab}`}
          onClick={() => onChange(tab)}
        >
          {NOTICE_TAB_LABEL[tab]}
        </button>
      ))}
    </div>
  );
}
