// 명령 카탈로그(d5 §7.3 '좌 4열'). 실제 화면에는 이 콘솔이 낼 수 있는 명령 1·3·6(대체 결제사 전환) 카드만 두고,
// 나머지 명령은 카드 없이 한 줄 안내로 둔다(계획 6-1: 열두 카드를 그려 두고 막으면 '낼 수 있는데 막힌 것'으로 읽힌다).
// 휴대폰은 작성 카드를 그리지 않는다(control-tower §12). props만으로 그린다.
import { COMMAND_NAMES, PHONE_BLOCKED, commandAvailability, type CommandKind, type ConsoleLayoutKind, type ConsoleRole } from '../../model/command-form';

export interface CommandCatalogProps {
  role: ConsoleRole;
  layout: ConsoleLayoutKind;
  onPick: (kind: CommandKind) => void;
  /** 지금 고른 명령 */
  picked?: CommandKind | null;
}

const CARDS: readonly { kind: CommandKind; no: string; summary: string }[] = [
  { kind: 'ADMISSION_TARGET', no: '명령 1', summary: '좌석 선택·결제 단계에 한꺼번에 들일 사람 수를 바꿉니다' },
  { kind: 'KILL_SWITCH', no: '명령 3', summary: '이 회차나 전체 회차의 판매를 바로 멈춥니다' },
  { kind: 'PG_FALLBACK', no: '명령 6', summary: '새 결제를 다른 결제사로 보냅니다' },
];

export function CommandCatalog({ role, layout, onPick, picked = null }: CommandCatalogProps) {
  if (layout === 'phone') {
    return (
      <section className="widget" aria-labelledby="h-catalog">
        <h2 className="t-sm fw-b" id="h-catalog">
          명령 내기
        </h2>
        <p className="t-sm muted" style={{ marginTop: 8 }}>
          {PHONE_BLOCKED}. 이 화면에서는 승인·반려와 보기만 할 수 있습니다.
        </p>
      </section>
    );
  }
  return (
    <section className="widget" aria-labelledby="h-catalog">
      <h2 className="t-sm fw-b" id="h-catalog">
        명령 내기
      </h2>
      <ul className="col" style={{ gap: 8, marginTop: 12, listStyle: 'none', padding: 0 }}>
        {CARDS.map((c) => {
          const a = commandAvailability({ role, layout, kind: c.kind });
          const blockId = `catalog-block-${c.kind}`;
          return (
            <li key={c.kind}>
              <button
                type="button"
                className={picked === c.kind ? 'btn btn-outline' : 'btn btn-ghost'}
                style={{ width: '100%', textAlign: 'left', display: 'block', padding: 12 }}
                aria-pressed={picked === c.kind}
                aria-describedby={a.canRequest ? undefined : blockId}
                onClick={() => onPick(c.kind)}
              >
                <span className="t-xs muted">{c.no}</span> <span className="t-sm fw-b">{COMMAND_NAMES[c.kind]}</span>
                <span className="t-xs muted" style={{ display: 'block', marginTop: 4 }}>
                  {c.summary}
                </span>
              </button>
              {a.canRequest ? null : (
                <p className="t-xs" id={blockId} style={{ margin: '4px 12px 0' }}>
                  {a.reason}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="t-xs muted" style={{ marginTop: 12 }}>
        그 밖의 명령은 이 콘솔에서는 아직 낼 수 없습니다(런북·운영 담당에게 요청).
      </p>
    </section>
  );
}
