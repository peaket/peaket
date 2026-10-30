// 단축키 안내 대화상자(d5 §3.3 '단축키', 목록은 [가정]). 계정 메뉴의 '단축키 안내'와 한 글자 단축키 '?'로 연다.
import { Overlay } from '@/shared/ui/Overlay';

export function ShortcutsDialog({ onClose, singleKey }: { onClose: () => void; singleKey: boolean }) {
  return (
    <Overlay onClose={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="sk-t" aria-describedby="sk-d" style={{ maxWidth: 520 }}>
        <h2 className="dialog-title" id="sk-t">
          단축키 안내
        </h2>
        <p className="t-sm muted" id="sk-d">
          한 글자 단축키는 처음에 꺼져 있고 내 계정의 [한 글자 단축키 쓰기]로 켭니다. 켜도 글 입력 칸·선택 상자·편집 영역에 초점이 있으면 동작하지 않습니다.
          {singleKey ? ' 지금 켜져 있습니다.' : ' 지금 꺼져 있습니다.'}
        </p>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">단축키 목록</caption>
            <thead>
              <tr>
                <th scope="col">키</th>
                <th scope="col">하는 일</th>
                <th scope="col">동작하는 때</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <kbd className="mono">?</kbd>
                </td>
                <td>단축키 안내 대화상자를 연다</td>
                <td>한 글자 단축키를 켰고, 입력 칸에 초점이 없을 때</td>
              </tr>
              <tr>
                <td>
                  <kbd className="mono">Space</kbd>
                </td>
                <td>감사 리플레이 재생·정지(SCR-031)</td>
                <td>타임라인 플레이어에 초점이 있을 때만(스위치와 상관없다)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </Overlay>
  );
}
