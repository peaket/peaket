'use client';
// SCR-024 판매 정책 화면의 라이브 모드(ADR-0261, d5 §6.7). 규칙은 종류별 폼으로만 고치고 JSON은 읽기 전용이다.
// 서버의 GET·PUT sale-policy와 판매 자격 명단 세 경로에 잇는다. 시뮬레이션은 서버와 같은 @peaket/validation 평가 함수를 쓴다.
import { useEffect, useMemo, useState } from 'react';
import { evaluateSalePolicy, parseSalePolicy, type SalePolicyRule } from '@peaket/validation/sale-policy';
import { deleteEligibility, listEligibility, readPolicy, savePolicy, uploadEligibility, type EligibilityList } from '../model/api';
import { type FormKind, kindOf, ruleFromForm, summaryOf } from '../model/form';

type Kind = FormKind;
const CTX = { rounds: [], grades: ['R', 'S', 'A'] } as const;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR') : '잠금 없음');
const timeOf = (iso: string | undefined) => (iso ? iso.slice(0, 16) : '');

export function LiveSalePolicy({ productionId }: { productionId: string }) {
  const [state, setState] = useState<'loading' | 'error' | 'notFound' | 'ok'>('loading');
  const [rules, setRules] = useState<SalePolicyRule[]>([]);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [lists, setLists] = useState<EligibilityList[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<Kind>('presale');
  const [editAt, setEditAt] = useState<number | null>(null);
  const [name, setName] = useState('팬클럽 선예매');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [listKey, setListKey] = useState('');
  const [limit, setLimit] = useState(2);
  const [grade, setGrade] = useState('R');
  const [daysFrom, setDaysFrom] = useState(7);
  const [daysTo, setDaysTo] = useState(9);
  const [rate, setRate] = useState(10);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [simQty, setSimQty] = useState(2);
  const [simList, setSimList] = useState('');

  const load = async () => {
    setState('loading');
    try {
      const p = await readPolicy(productionId);
      setRules(p.rules as SalePolicyRule[]);
      setVersion(p.version);
      setPending(p.pending);
      setState('ok');
      try {
        const l = await listEligibility(productionId);
        setLists(l);
        setListKey((k) => k || l[0]?.key || '');
        setSimList((k) => k || l[0]?.key || '');
      } catch {
        setLists([]);
      }
    } catch (e) {
      setState((e as { status?: number }).status === 404 ? 'notFound' : 'error');
    }
  };
  useEffect(() => {
    void load();
  }, [productionId]);

  const selected = editAt !== null ? rules[editAt] : undefined;
  const json = useMemo(() => JSON.stringify(selected ?? rules, null, 2), [selected, rules]);
  const decision = useMemo(() => {
    try {
      const parsed = parseSalePolicy(rules, CTX);
      if (!parsed.ok) return null;
      return evaluateSalePolicy(parsed.rules, { at: new Date(), round: 'ALL', grade, quantity: simQty, lists: simList ? [simList] : [] }, 4);
    } catch {
      return null;
    }
  }, [rules, grade, simQty, simList]);

  const resetForm = (k: Kind = kind) => {
    setEditAt(null);
    setKind(k);
    setName(k === 'refund' ? '7~9일 전 취소 공제율' : k === 'grade' ? '등급 판매 여부' : '팬클럽 선예매');
    setFrom('');
    setTo('');
    setLimit(2);
    setRate(10);
    setMessage(null);
  };

  const pickRule = (i: number) => {
    const r = rules[i]!;
    const k = kindOf(r);
    setEditAt(i);
    setKind(k);
    setName(r.name);
    setFrom(timeOf(r.during?.from));
    setTo(timeOf(r.during?.to));
    const cond = r.rule?.if;
    setListKey(cond && 'fact' in cond && cond.has ? cond.has : (lists[0]?.key ?? ''));
    setGrade(cond && 'fact' in cond && typeof cond.eq === 'string' ? cond.eq : 'R');
    const then = r.rule?.then;
    setLimit(then && 'limitPerPerson' in then ? then.limitPerPerson : 2);
    setDaysFrom(r.refundFee?.[0]?.daysLeft.gte ?? 7);
    setDaysTo(r.refundFee?.[0]?.daysLeft.lte ?? 9);
    setRate(r.refundFee?.[0]?.rate ?? 10);
    setMessage(null);
  };

  const makeRule = (): SalePolicyRule => ruleFromForm({ kind, name, from, to, listKey, limit, grade, daysFrom, daysTo, rate });

  const apply = () => {
    const next = makeRule();
    try {
      const parsed = parseSalePolicy([...rules.filter((_, i) => i !== editAt), next], CTX);
      if (!parsed.ok) {
        setMessage(`입력 오류: ${parsed.errors[0]?.path ?? ''} ${parsed.errors[0]?.code ?? ''}`.trim());
        return;
      }
      setRules(parsed.rules);
      resetForm();
    } catch {
      setMessage('입력한 규칙의 모양이 올바르지 않습니다');
    }
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await savePolicy(productionId, version, rules);
      setVersion(r.version);
      setPending(r.pending);
      setMessage('저장했습니다');
    } catch (e) {
      const err = e as { status?: number; type?: string };
      if (err.status === 412) setMessage('다른 곳에서 판매 정책이 바뀌었습니다. 다시 불러온 뒤 고쳐 주세요');
      else if (err.status === 403) setMessage('판매 승인을 받은 공연은 파트너 관리자만 고칠 수 있습니다');
      else if (err.status === 409) setMessage('판매가 중지된 공연이라 바꿀 수 없습니다');
      else if (err.status === 422) setMessage('규칙에 고칠 곳이 있습니다. 폼 값을 확인해 주세요');
      else setMessage('저장하지 못했습니다. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const key = listKey || `list-${Date.now()}`;
      const r = await uploadEligibility(productionId, key, name || key, file);
      setListKey(r.listKey);
      setSimList(r.listKey);
      setMessage(`반영 ${r.applied}명 · 형식 오류 ${r.invalidLineCount}줄 · 없는 코드 ${r.unknownLineCount}줄 · 명단 키 ${r.listKey}`);
      setLists(await listEligibility(productionId));
    } catch (e) {
      const err = e as { status?: number };
      setMessage(err.status === 413 ? '명단 파일은 8MB까지 올릴 수 있습니다' : err.status === 422 ? '명단 파일 형식을 확인해 주세요' : '명단을 올리지 못했습니다');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return <p className="t-sm muted" role="status">판매 정책을 불러오는 중입니다</p>;
  if (state === 'notFound') return <p className="t-sm muted" role="status">공연을 찾을 수 없습니다</p>;
  if (state === 'error') return <p className="error-msg" role="alert">판매 정책을 불러오지 못했습니다. 다시 시도해 주세요</p>;

  return (
    <div className="grid items-start gap-4 md:gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="col min-w-0 gap-4 md:gap-5">
        <section className="card col" style={{ overflow: 'hidden' }} aria-labelledby="h-live-rules">
          <div className="row between" style={{ padding: '16px 16px 12px' }}>
            <h2 className="t-md fw-b" id="h-live-rules">등록 규칙</h2>
            <button className="btn btn-outline btn-sm" type="button" onClick={() => resetForm('presale')}>새 규칙</button>
          </div>
          <table className="table dense">
            <caption className="sr-only">등록 규칙 {rules.length}개의 이름, 조건 요약, 상태</caption>
            <thead><tr><th scope="col">규칙 이름</th><th scope="col">조건 요약</th><th scope="col">상태</th></tr></thead>
            <tbody>
              {rules.length === 0 ? <tr><td colSpan={3} className="muted">등록한 규칙이 없습니다</td></tr> : rules.map((r, i) => (
                <tr key={`${r.name}-${i}`} className={editAt === i ? 'is-selected' : undefined}>
                  <td className="fw-b"><button className="link-more" type="button" onClick={() => pickRule(i)}>{r.name}</button></td>
                  <td>{summaryOf(r)}</td>
                  <td><span className="badge">초안</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card col" style={{ gap: 10 }} aria-labelledby="h-live-lists">
          <h2 className="t-md fw-b" id="h-live-lists">판매 자격 명단</h2>
          <ul className="col" style={{ gap: 8 }}>
            {lists.map((l) => (
              <li key={l.key} className="row between" style={{ gap: 8 }}>
                <span className="t-sm">{`${l.name} · ${l.memberCount.toLocaleString('ko-KR')}명 · ${fmt(l.lockedAt)}`}</span>
                <button className="btn btn-text btn-sm" type="button" disabled={busy} onClick={() => void deleteEligibility(productionId, l.key).then(load)}>지우기</button>
              </li>
            ))}
            {lists.length === 0 ? <li className="t-sm muted">올린 명단이 없습니다</li> : null}
          </ul>
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor="live-list-file">명단 올리기(CSV·텍스트, 8MB까지)</label>
            <input id="live-list-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => void upload(e.target.files?.[0] ?? null)} />
            <p className="t-xs muted">명단 키는 아래 규칙 폼의 자격 명단 값으로 씁니다.</p>
          </div>
        </section>
      </div>

      <div className="col min-w-0 gap-4 md:gap-5">
        <section className="card col" style={{ gap: 12 }} aria-labelledby="h-live-edit">
          <h2 className="t-md fw-b" id="h-live-edit">{editAt === null ? '새 규칙' : '규칙 고치기'}</h2>
          <fieldset className="col" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
            <legend className="label">규칙 종류</legend>
            <div className="row wrap" style={{ gap: 16 }}>
              {([['presale', '선예매 창·자격 명단·1인 한도'], ['grade', '등급 판매 여부'], ['refund', '취소 공제율 구간']] as const).map(([v, label]) => (
                <label key={v} className="check-row t-sm">
                  <input type="radio" name="live-kind" checked={kind === v} onChange={() => resetForm(v)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor="live-name">규칙 이름</label>
            <input id="live-name" className="input input-sm" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          </div>
          {kind === 'presale' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="field" style={{ gap: 4 }}>
                  <label className="label" htmlFor="live-from">적용 시작(KST)</label>
                  <input id="live-from" className="input input-sm" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="field" style={{ gap: 4 }}>
                  <label className="label" htmlFor="live-to">적용 끝(KST, 비우면 계속)</label>
                  <input id="live-to" className="input input-sm" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="field" style={{ gap: 4 }}>
                  <label className="label" htmlFor="live-list">자격 명단 키</label>
                  <input id="live-list" className="input input-sm" value={listKey} onChange={(e) => setListKey(e.target.value)} />
                </div>
                <div className="field" style={{ gap: 4 }}>
                  <label className="label" htmlFor="live-limit">1인 한도(1~4)</label>
                  <input id="live-limit" className="input input-sm" type="number" min={1} max={4} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
                </div>
              </div>
            </>
          ) : kind === 'grade' ? (
            <div className="field" style={{ gap: 4 }}>
              <label className="label" htmlFor="live-grade">판매하지 않을 등급 ID</label>
              <input id="live-grade" className="input input-sm" value={grade} onChange={(e) => setGrade(e.target.value)} />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="field" style={{ gap: 4 }}>
                <label className="label" htmlFor="live-days-from">남은 일수 이상</label>
                <input id="live-days-from" className="input input-sm" type="number" min={0} value={daysFrom} onChange={(e) => setDaysFrom(Number(e.target.value))} />
              </div>
              <div className="field" style={{ gap: 4 }}>
                <label className="label" htmlFor="live-days-to">남은 일수 이하</label>
                <input id="live-days-to" className="input input-sm" type="number" min={0} value={daysTo} onChange={(e) => setDaysTo(Number(e.target.value))} />
              </div>
              <div className="field" style={{ gap: 4 }}>
                <label className="label" htmlFor="live-rate">공제율(%)</label>
                <input id="live-rate" className="input input-sm" type="number" min={0} max={100} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
              </div>
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-outline btn-sm" type="button" onClick={apply}>폼 값을 규칙에 넣기</button>
            <button className="btn btn-primary btn-sm" type="button" disabled={busy || rules.length === 0} onClick={() => void save()}>판매 정책 저장</button>
            <button className="btn btn-text btn-sm" type="button" onClick={() => setJsonOpen((v) => !v)}>JSON 보기</button>
          </div>
          {jsonOpen ? <pre className="code" tabIndex={0} aria-label="판매 정책 JSON, 읽기 전용" style={{ whiteSpace: 'pre', overflowX: 'auto', padding: 12, margin: 0 }}>{json}</pre> : null}
          {message ? <p className={message.startsWith('저장') || message.startsWith('반영') ? 't-sm' : 'error-msg'} role={message.startsWith('저장') || message.startsWith('반영') ? 'status' : 'alert'}>{message}</p> : null}
          {pending ? <p className="t-sm muted">승인된 공연이라 이 규칙은 재승인 대기 판에 저장됩니다.</p> : null}
        </section>

        <section className="card col" style={{ gap: 10 }} aria-labelledby="h-live-sim" role="region">
          <h2 className="t-md fw-b" id="h-live-sim">시뮬레이션</h2>
          <div className="row wrap" style={{ gap: 12 }}>
            <label className="check-row t-sm">등급 <input className="input input-sm" style={{ width: 70 }} value={grade} onChange={(e) => setGrade(e.target.value)} /></label>
            <label className="check-row t-sm">매수 <input className="input input-sm" style={{ width: 70 }} type="number" min={1} max={10} value={simQty} onChange={(e) => setSimQty(Number(e.target.value))} /></label>
            <label className="check-row t-sm">명단 <select className="input input-sm" value={simList} onChange={(e) => setSimList(e.target.value)}><option value="">없음</option>{lists.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}</select></label>
          </div>
          <p className="t-sm" role="status">
            {decision === null ? '규칙을 읽지 못해 시뮬레이션할 수 없습니다' : decision.allowed ? `허용 · 1인 ${decision.limit}매` : `거부(${decision.reason})`}
          </p>
        </section>
      </div>
    </div>
  );
}
