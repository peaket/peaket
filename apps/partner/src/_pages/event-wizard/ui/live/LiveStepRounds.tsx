// 2단계 회차·입장 정책(실제 입력, ADR-0245). 가격 등급은 좌석맵과 함께 HOT-210~240이 잇는다.
import { blankRound, ROUND_MAX, type RoundDraft } from '../../model/form';
import { errorAttrs, FieldLabel, FieldMessage, roundFieldId, type StepProps } from './fields';

function DateField({
  index,
  name,
  label,
  value,
  errorOf,
  onChange,
}: {
  index: number;
  name: keyof RoundDraft;
  label: string;
  value: string;
  errorOf: StepProps['errorOf'];
  onChange: (value: string) => void;
}) {
  const id = roundFieldId(index, name);
  const error = errorOf(`rounds.${index}.${name}`);
  return (
    <div className="field">
      <FieldLabel htmlFor={id} required>
        {label}
      </FieldLabel>
      <div className={error ? 'input-group input-group-sm is-error' : 'input-group input-group-sm'}>
        <i className="ic ic-calendar" aria-hidden="true" />
        <input id={id} type="datetime-local" max="9999-12-31T23:59" value={value} onChange={(e) => onChange(e.target.value)} {...errorAttrs(id, error)} />
      </div>
      <FieldMessage id={id} error={error} />
    </div>
  );
}

export function LiveStepRounds({ draft, update, errorOf }: StepProps) {
  const rounds = draft.rounds;
  const setRound = (index: number, patch: Partial<RoundDraft>, name: keyof RoundDraft) =>
    update({ rounds: rounds.map((r, i) => (i === index ? { ...r, ...patch } : r)) }, `rounds.${index}.${name}`);
  const roundsError = errorOf('rounds');

  return (
    <div className="grid items-start gap-5 lg:grid-cols-12 xl:grid-cols-3 xl:gap-6">
      <section className="card pad-lg col lg:col-span-8 xl:col-span-2" style={{ gap: 16 }} aria-labelledby="x-h-round">
        <div className="section-title">
          <h2 id="x-h-round">회차와 오픈 시각</h2>
          <button
            className="btn btn-outline btn-sm"
            id="r-add"
            type="button"
            aria-describedby="x-round-add-h"
            disabled={rounds.length >= ROUND_MAX}
            onClick={() => update({ rounds: [...rounds, blankRound(crypto.randomUUID())] }, 'rounds')}
          >
            <i className="ic ic-plus" aria-hidden="true" />
            회차 더하기
          </button>
        </div>
        <p className="hint" id="x-round-add-h">
          같은 공연장·배치본으로 더합니다. 시각은 모두 한국 시각(KST)입니다
        </p>
        <p className="hint">
          오픈 시각은 다른 공연과 5분 이상 떨어져야 하고 수요일 03:00~06:30에는 오픈할 수 없습니다(POL-030·041). 대형 공연끼리의 30분 간격은 판매 승인에서 규모를 정할 때 검사합니다.
        </p>
        <FieldMessage id="r-add" error={roundsError} />

        {rounds.map((r, i) => {
          const no = i + 1;
          const lobbyId = roundFieldId(i, 'lobbyMinutes');
          const lobbyError = errorOf(`rounds.${i}.lobbyMinutes`);
          return (
            <div key={r.key} className="col" role="group" aria-labelledby={`r-${i}-t`} style={{ gap: 14, padding: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)' }}>
              <div className="row between">
                <strong className="t-md" id={`r-${i}-t`}>
                  {no}회차
                </strong>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={`${no}회차 빼기`}
                  disabled={rounds.length === 1}
                  onClick={() => {
                    update({ rounds: rounds.filter((_, n) => n !== i) }, 'rounds.*');
                    document.getElementById('r-add')?.focus();
                  }}
                >
                  <i className="ic ic-trash" aria-hidden="true" />
                </button>
              </div>
              <div className="grid grid-cols-2 items-start gap-x-4 gap-y-[14px] xl:grid-cols-3">
                <DateField index={i} name="startsAt" label="공연 시작(KST)" value={r.startsAt} errorOf={errorOf} onChange={(startsAt) => setRound(i, { startsAt }, 'startsAt')} />
                <DateField index={i} name="entryOpensAt" label="입장 시작(KST)" value={r.entryOpensAt} errorOf={errorOf} onChange={(entryOpensAt) => setRound(i, { entryOpensAt }, 'entryOpensAt')} />
                <DateField index={i} name="endsAt" label="공연 종료 예정(KST)" value={r.endsAt} errorOf={errorOf} onChange={(endsAt) => setRound(i, { endsAt }, 'endsAt')} />
                <DateField index={i} name="openAt" label="오픈 시각(KST)" value={r.openAt} errorOf={errorOf} onChange={(openAt) => setRound(i, { openAt }, 'openAt')} />
                <div className="field">
                  <label className="label" htmlFor={lobbyId}>
                    로비 개방
                  </label>
                  <div className={lobbyError ? 'input-group input-group-sm is-error' : 'input-group input-group-sm'}>
                    <input
                      id={lobbyId}
                      type="text"
                      inputMode="numeric"
                      value={String(r.lobbyMinutes)}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        if (v === '' || /^\d{1,3}$/.test(v)) setRound(i, { lobbyMinutes: v === '' ? '' : Number(v) }, 'lobbyMinutes');
                      }}
                      {...errorAttrs(lobbyId, lobbyError, `${lobbyId}-h`)}
                    />
                    <span className="t-sm muted nowrap">분 전</span>
                  </div>
                  <span className="hint" id={`${lobbyId}-h`}>
                    기본 10분 · 하이브리드·사전 셔플 공연에서 씁니다
                  </span>
                  <FieldMessage id={lobbyId} error={lobbyError} />
                </div>
                <div className="field">
                  <span className="label" aria-hidden="true">
                    재입장
                  </span>
                  <label className="check-row" style={{ alignItems: 'center', minHeight: 40, fontSize: 14 }}>
                    <input className="sw" type="checkbox" role="switch" aria-describedby={`r-${i}-re-h`} checked={r.reentryAllowed} onChange={(e) => setRound(i, { reentryAllowed: e.target.checked }, 'reentryAllowed')} />
                    재입장 허용
                  </label>
                  <span className="hint" id={`r-${i}-re-h`}>
                    {r.reentryAllowed ? '허용 · 판매 조건으로 공연 상세에 공시합니다' : '불허(기본) · 판매 조건으로 공연 상세에 공시합니다'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="card pad-lg col lg:col-span-4 xl:col-span-1" style={{ gap: 12 }} aria-labelledby="x-h-tier">
        <div className="section-title">
          <h2 id="x-h-tier">가격 등급</h2>
        </div>
        <p className="t-sm muted">가격 등급은 공연을 등록한 뒤 좌석맵을 만들면서 정합니다.</p>
      </section>
    </div>
  );
}
