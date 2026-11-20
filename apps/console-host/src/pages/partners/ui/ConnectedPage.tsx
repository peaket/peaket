// SCR-065 실제 경로: ops-svc 파트너사·계약 API에 연결한 화면(BAT-615 LCH-070).
// 계약 탭(지금 조건·변경 이력·변경 요청·승인 대기), 판매자 정보 탭(있는 칸만), 결제사 등록 탭은 지급대행 연동 전 자리다.
// viewer는 메뉴에서 숨기고(들어와도 안내), CS는 읽기만 한다. 승인은 SCR-046(다음 묶음)에서 한다.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';
import { useChosenRole } from '@/features/preview-host';
import { NoAccess } from '@/features/screen-access';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import { contractProblemMessage, formatBp, formatKst, guaranteeLabel, parseBp, periodLabel, type GuaranteeKind } from '../model/contracts';

interface PromoterSummary {
  promoterId: string;
  legalName: string;
  commissionRateBp: number;
  guaranteeRateBp: number;
  contractChangePending: boolean;
}

interface ContractPeriod {
  commissionRateBp: number;
  guaranteeRateBp: number;
  guaranteeKind: GuaranteeKind;
  validFrom: string;
  validUntil: string | null;
  approvalId: string | null;
}

interface PromoterDetail {
  promoterId: string;
  legalName: string;
  contract: ContractPeriod;
  pendingContractApprovalId: string | null;
  seller: Record<string, string | null> | null;
  verifiedAt: string | null;
  payoutAccount: null;
  pgRegistration: { tossSellers: unknown[]; portonePartnerRegistered: boolean };
}

type Tab = 'contract' | 'seller' | 'pg';
type Load = { kind: 'loading' } | { kind: 'ready'; items: PromoterSummary[] } | { kind: 'config' } | { kind: 'error'; message: string };

const ACCESS: Record<ConsoleRole, boolean> = { viewer: false, operator: true, commander: true, cs_agent: true, cs_lead: true };
const TITLE = '파트너사·계약';

const contractChangeCopy = (status?: string): string => {
  if (status === 'PENDING_APPROVAL') return '승인 대기';
  if (status === 'FAILED') return '적용 실패 · 다시 승인 필요';
  return '진행 중';
};

export function ConnectedPage() {
  const chosen = useChosenRole();
  const role: ConsoleRole = chosen ?? 'operator';
  const canWrite = role === 'operator' || role === 'commander';
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PromoterDetail | null>(null);
  const [terms, setTerms] = useState<ContractPeriod[]>([]);
  const [tab, setTab] = useState<Tab>('contract');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createRate, setCreateRate] = useState('10');
  const [createGuarantee, setCreateGuarantee] = useState('10');
  const [createKind, setCreateKind] = useState<GuaranteeKind>('DEPOSIT');
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeRate, setChangeRate] = useState('');
  const [changeGuarantee, setChangeGuarantee] = useState('');
  const [changeKind, setChangeKind] = useState<GuaranteeKind | ''>('');
  const [changeReason, setChangeReason] = useState('');

  const refresh = useCallback(async () => {
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setLoad({ kind: 'config' });
      return;
    }
    setLoad({ kind: 'loading' });
    try {
      const [{ listOpsPromoters }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const body = (await listOpsPromoters({ limit: 100, ...(query.trim() ? { q: query.trim() } : {}) })).data as unknown as { items: PromoterSummary[] };
      const items = body.items ?? [];
      setLoad({ kind: 'ready', items });
      setSelectedId((prev) => (prev && items.some((p) => p.promoterId === prev) ? prev : (items[0]?.promoterId ?? null)));
    } catch {
      setLoad({ kind: 'error', message: '파트너사 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setTerms([]);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const [{ getOpsPromoter, listOpsPromoterContractTerms }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
        const [d, t] = await Promise.all([getOpsPromoter(selectedId), listOpsPromoterContractTerms(selectedId, { limit: 100 })]);
        if (!live) return;
        setDetail(d.data as unknown as PromoterDetail);
        setTerms(((t.data as unknown as { items: ContractPeriod[] }).items ?? []) as ContractPeriod[]);
      } catch {
        if (live) setNotice({ tone: 'bad', text: '파트너사 상세를 불러오지 못했습니다.' });
      }
    })();
    return () => {
      live = false;
    };
  }, [selectedId]);

  const current = detail?.contract ?? null;
  const pending = detail?.pendingContractApprovalId ?? null;
  const selected = useMemo(() => (load.kind === 'ready' ? load.items.find((p) => p.promoterId === selectedId) : undefined), [load, selectedId]);

  const create = async () => {
    const commissionRateBp = parseBp(createRate);
    const guaranteeRateBp = parseBp(createGuarantee);
    if (!createName.trim() || commissionRateBp === undefined || guaranteeRateBp === undefined) {
      setNotice({ tone: 'bad', text: '상호와 수수료율·보증 비율(0~100%)을 확인해 주세요.' });
      return;
    }
    setBusy(true);
    try {
      const [{ createOpsPromoter }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const created = await createOpsPromoter(
        { legalName: createName.trim(), commissionRateBp, guaranteeRateBp, guaranteeKind: createKind },
        { headers: { 'idempotency-key': crypto.randomUUID() } },
      );
      setCreateOpen(false);
      setCreateName('');
      setNotice({ tone: 'ok', text: '파트너사와 첫 계약을 등록했습니다.' });
      await refresh();
      setSelectedId((created.data as unknown as PromoterDetail).promoterId);
    } catch (e) {
      setNotice({ tone: 'bad', text: contractProblemMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const requestChange = async () => {
    if (!selectedId || !current) return;
    const rate = parseBp(changeRate);
    const guarantee = parseBp(changeGuarantee);
    if (changeRate.trim() && rate === undefined) return setNotice({ tone: 'bad', text: '수수료율은 0~100%로 적어 주세요.' });
    if (changeGuarantee.trim() && guarantee === undefined) return setNotice({ tone: 'bad', text: '보증 비율은 0~100%로 적어 주세요.' });
    if (!changeRate.trim() && !changeGuarantee.trim() && !changeKind) return setNotice({ tone: 'bad', text: '바꿀 칸을 하나 이상 골라 주세요.' });
    if (!changeReason.trim()) return setNotice({ tone: 'bad', text: '변경 사유를 적어 주세요.' });
    setBusy(true);
    try {
      const [{ createOpsPromoterContractTermChange }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsPromoterContractTermChange(
        selectedId,
        {
          ...(rate !== undefined ? { commissionRateBp: rate } : {}),
          ...(guarantee !== undefined ? { guaranteeRateBp: guarantee } : {}),
          ...(changeKind ? { guaranteeKind: changeKind } : {}),
          reason: changeReason.trim(),
        },
        { headers: { 'idempotency-key': crypto.randomUUID() } },
      );
      setChangeOpen(false);
      setChangeRate('');
      setChangeGuarantee('');
      setChangeKind('');
      setChangeReason('');
      setNotice({ tone: 'ok', text: '변경 요청을 보냈습니다. 요청자가 아닌 commander가 승인해야 적용됩니다.' });
      const [{ getOpsPromoter, listOpsPromoterContractTerms }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const [d, t] = await Promise.all([getOpsPromoter(selectedId), listOpsPromoterContractTerms(selectedId, { limit: 100 })]);
      setDetail(d.data as unknown as PromoterDetail);
      setTerms(((t.data as unknown as { items: ContractPeriod[] }).items ?? []) as ContractPeriod[]);
    } catch (e) {
      setNotice({ tone: 'bad', text: contractProblemMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!ACCESS[role]) return <NoAccess title={TITLE} role={role} who="operator·commander·CS 담당" />;
  if (load.kind === 'config') {
    return (
      <section className="widget" role="alert">
        <h1 className="t-xl">{TITLE}</h1>
        <p className="t-sm muted">관제 API 주소가 설정되지 않아 파트너사 목록을 부를 수 없습니다. 빌드의 `PEAKET_OPS_API_ORIGIN`을 확인해 주세요.</p>
      </section>
    );
  }

  return (
    <>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 16 }}>
        <div className="col" style={{ gap: 4 }}>
          <h1 className="t-xl">{TITLE}</h1>
          <p className="t-sm muted">파트너의 계약 수수료율·보증, 판매자 정보, 결제사 등록을 봅니다. 수수료율·보증 변경은 operator가 요청하고 요청자가 아닌 commander가 승인합니다(2인).</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-outline" type="button" onClick={() => void refresh()} disabled={busy}>
            <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
          </button>
          {canWrite ? (
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen((v) => !v)}>
              파트너사 등록
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className={`banner ${notice.tone === 'ok' ? 'banner-info' : 'banner-warning'}`} role="status">
          <div className="banner-body">{notice.text}</div>
        </div>
      ) : null}

      {createOpen && canWrite ? (
        <section className="widget" aria-labelledby="h-create">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-create">파트너사 등록(첫 계약)</h2>
          </div>
          <div className="widget-body" style={{ gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12 }}>
              <label className="field">
                <span className="label">상호</span>
                <input className="input" value={createName} onChange={(e) => setCreateName(e.target.value)} maxLength={100} />
              </label>
              <label className="field">
                <span className="label">중개수수료율(%)</span>
                <input className="input" inputMode="decimal" value={createRate} onChange={(e) => setCreateRate(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">계약 보증(%)</span>
                <input className="input" inputMode="decimal" value={createGuarantee} onChange={(e) => setCreateGuarantee(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">보증 종류</span>
                <select className="input" value={createKind} onChange={(e) => setCreateKind(e.target.value as GuaranteeKind)}>
                  <option value="DEPOSIT">보증금</option>
                  <option value="PERFORMANCE_BOND">이행보증보험</option>
                </select>
              </label>
            </div>
            <p className="hint">첫 계약은 등록과 함께 정해지고 승인 업무를 만들지 않습니다. 이후 변경만 2인 승인입니다.</p>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-outline" type="button" onClick={() => setCreateOpen(false)}>취소</button>
              <button className="btn btn-primary" type="button" onClick={() => void create()} disabled={busy}>등록</button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="grid-12" style={{ rowGap: 16, alignItems: 'start' }}>
        <div className="span-5 col" style={{ gap: 16 }}>
          <section className="widget" aria-labelledby="h-partners">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-partners">파트너 {load.kind === 'ready' ? load.items.length : 0}곳</h2>
            </div>
            <div className="widget-body" style={{ gap: 8 }}>
              <input className="input" placeholder="상호 검색" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="상호 검색" />
              {load.kind === 'loading' ? <p className="t-sm muted">불러오는 중…</p> : null}
              {load.kind === 'error' ? <p className="t-sm" role="alert">{load.message}</p> : null}
              {load.kind === 'ready' && load.items.length === 0 ? <p className="t-sm muted">등록된 파트너사가 없습니다.</p> : null}
              {load.kind === 'ready' && load.items.length > 0 ? (
                <div className="table-wrap">
                  <table className="table dense">
                    <caption className="sr-only">파트너사 목록. 이름을 누르면 오른쪽에 상세가 열립니다</caption>
                    <thead>
                      <tr>
                        <th scope="col">파트너</th>
                        <th scope="col" className="r">수수료율</th>
                        <th scope="col" className="r">보증</th>
                      </tr>
                    </thead>
                    <tbody>
                      {load.items.map((p) => (
                        <tr key={p.promoterId} className={p.promoterId === selectedId ? 'is-selected' : undefined}>
                          <td>
                            <button className="link fw-b" type="button" style={{ color: 'inherit' }} aria-current={p.promoterId === selectedId} onClick={() => setSelectedId(p.promoterId)}>
                              {p.legalName}
                            </button>
                            {p.contractChangePending ? <> <span className="badge badge-warning">승인 대기</span></> : null}
                          </td>
                          <td className="r">{formatBp(p.commissionRateBp)}</td>
                          <td className="r">{formatBp(p.guaranteeRateBp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </section>
          <section className="widget" aria-labelledby="h-basis">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-basis">계약·정산 기준</h2></div>
            <div className="widget-body">
              <dl className="col t-sm" style={{ gap: 12 }}>
                <div className="col" style={{ gap: 2 }}>
                  <dt className="fw-b">중개수수료</dt>
                  <dd className="muted">(판매 대금 − 환급) × 계약 수수료율, 원 미만 버림. 수수료 부가세 10%는 따로 붙습니다.</dd>
                </div>
                <div className="col" style={{ gap: 2 }}>
                  <dt className="fw-b">계약 보증</dt>
                  <dd className="muted">회차 예상 매출의 계약 보증 비율. 보증금이나 이행보증보험으로 받습니다(징수는 LCH-100·110).</dd>
                </div>
                <div className="col" style={{ gap: 2 }}>
                  <dt className="fw-b">판매 승인 때 고정</dt>
                  <dd className="muted">바뀐 수수료율은 승인 뒤 판매 승인을 받는 공연부터 쓰고, 그 공연의 회차에 고정됩니다. 이미 승인된 공연은 바뀌지 않습니다.</dd>
                </div>
              </dl>
            </div>
          </section>
        </div>

        <div className="span-7 col" style={{ gap: 16 }}>
          {!selectedId && load.kind === 'ready' ? (
            <section className="widget"><p className="t-sm muted" style={{ padding: 16 }}>왼쪽에서 파트너사를 골라 주세요.</p></section>
          ) : null}
          {selectedId ? (
            <section className="widget" role="region" aria-labelledby="h-detail">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-detail">{detail?.legalName ?? selected?.legalName ?? '파트너사'}</h2>
              </div>
              <div className="tabs tabs-sm" role="tablist" aria-label="파트너 상세" style={{ padding: '0 14px' }}>
                <button className={`tab ${tab === 'contract' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={tab === 'contract'} onClick={() => setTab('contract')}>계약</button>
                <button className={`tab ${tab === 'seller' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={tab === 'seller'} onClick={() => setTab('seller')}>판매자 정보</button>
                <button className={`tab ${tab === 'pg' ? 'is-active' : ''}`} type="button" role="tab" aria-selected={tab === 'pg'} onClick={() => setTab('pg')}>결제사 등록</button>
              </div>
              <div className="widget-body" style={{ gap: 14 }}>
                {tab === 'contract' && detail && current ? (
                  <>
                    {pending ? (
                      <div className="banner banner-warning" role="status">
                        <div className="banner-body">
                          <span className="banner-title">계약 변경 승인 대기</span>
                          {contractChangeCopy('PENDING_APPROVAL')} · 요청자가 아닌 commander가 승인해야 적용됩니다. 승인 전에는 지금 값 {formatBp(current.commissionRateBp)}를 씁니다. 승인 업무에서 확인하세요.
                        </div>
                      </div>
                    ) : null}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 16 }}>
                      <div className="field">
                        <span className="label">지금 중개수수료율</span>
                        <p className="t-md fw-b">{formatBp(current.commissionRateBp)}</p>
                      </div>
                      <div className="field">
                        <span className="label">지금 계약 보증</span>
                        <p className="t-md fw-b">{formatBp(current.guaranteeRateBp)} · {guaranteeLabel(current.guaranteeKind)}</p>
                      </div>
                    </div>
                    <dl className="kv">
                      <dt>적용 시작</dt>
                      <dd>{formatKst(current.validFrom)}</dd>
                      <dt>적용 끝</dt>
                      <dd>{periodLabel(current.validUntil)}</dd>
                      <dt>승인 업무</dt>
                      <dd>{current.approvalId ?? '첫 계약(승인 없음)'}</dd>
                    </dl>
                    <div className="banner banner-info">
                      <div className="banner-body">수수료율·보증 변경은 operator가 요청하고 commander가 승인합니다(2인). 바꾼 값은 승인 뒤 판매 승인을 받는 공연부터 쓰고, 판매 승인 때 회차에 고정됩니다.</div>
                    </div>
                    {canWrite ? (
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                        <button className="btn btn-primary" type="button" onClick={() => setChangeOpen((v) => !v)} disabled={!!pending}>
                          변경 요청
                        </button>
                      </div>
                    ) : null}
                    {changeOpen && canWrite && !pending ? (
                      <section className="card-flat col" style={{ gap: 10, padding: 14 }} aria-labelledby="h-change">
                        <h3 className="t-sm fw-b" id="h-change">계약 조건 변경 요청</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }}>
                          <label className="field">
                            <span className="label">수수료율(%) — 바꿀 때만</span>
                            <input className="input" inputMode="decimal" value={changeRate} onChange={(e) => setChangeRate(e.target.value)} placeholder={formatBp(current.commissionRateBp)} />
                          </label>
                          <label className="field">
                            <span className="label">보증 비율(%) — 바꿀 때만</span>
                            <input className="input" inputMode="decimal" value={changeGuarantee} onChange={(e) => setChangeGuarantee(e.target.value)} placeholder={formatBp(current.guaranteeRateBp)} />
                          </label>
                          <label className="field">
                            <span className="label">보증 종류 — 바꿀 때만</span>
                            <select className="input" value={changeKind} onChange={(e) => setChangeKind(e.target.value as GuaranteeKind | '')}>
                              <option value="">그대로</option>
                              <option value="DEPOSIT">보증금</option>
                              <option value="PERFORMANCE_BOND">이행보증보험</option>
                            </select>
                          </label>
                        </div>
                        <label className="field">
                          <span className="label">변경 사유(1~2,000자)</span>
                          <textarea className="input" rows={3} value={changeReason} maxLength={2000} onChange={(e) => setChangeReason(e.target.value)} />
                        </label>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                          <button className="btn btn-outline" type="button" onClick={() => setChangeOpen(false)}>취소</button>
                          <button className="btn btn-primary" type="button" onClick={() => void requestChange()} disabled={busy}>변경 요청 보내기</button>
                        </div>
                      </section>
                    ) : null}
                    <section className="col" style={{ gap: 8 }} aria-labelledby="h-history">
                      <h3 className="t-sm fw-b" id="h-history">변경 이력</h3>
                      {terms.length === 0 ? <p className="t-sm muted">계약 기간이 없습니다.</p> : (
                        <ol className="timeline">
                          {terms.map((t) => (
                            <li className="tl-item" key={`${t.validFrom}-${t.approvalId ?? 'first'}`}>
                              <span className={`tl-dot ${t.validUntil ? 'info' : 'ok'}`} aria-hidden="true" />
                              <div className="col" style={{ gap: 2 }}>
                                <span className="t-sm fw-b">
                                  수수료율 {formatBp(t.commissionRateBp)} · 보증 {formatBp(t.guaranteeRateBp)} {guaranteeLabel(t.guaranteeKind)}
                                  {t.validUntil ? '' : ' · 지금 계약'}
                                </span>
                                <span className="t-xs muted">{formatKst(t.validFrom)} ~ {t.validUntil ? formatKst(t.validUntil) : '상한 없음'} · {t.approvalId ? '변경 승인' : '첫 계약'}</span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  </>
                ) : null}

                {tab === 'seller' ? (
                  detail?.seller ? (
                    <dl className="kv">
                      <dt>상호</dt><dd>{detail.seller.legalName ?? detail.legalName}</dd>
                      <dt>대표자</dt><dd>{detail.seller.representative ?? '받지 않음'}</dd>
                      <dt>사업자등록번호</dt><dd>{detail.seller.businessRegNo ?? '받지 않음'}</dd>
                      <dt>통신판매업 신고번호</dt><dd>{detail.seller.mailOrderReportNo ?? detail.seller.exemptionBasis ?? '받지 않음'}</dd>
                      <dt>주소</dt><dd>{detail.seller.address ?? '받지 않음'}</dd>
                      <dt>전화</dt><dd>{detail.seller.phone ?? '받지 않음'}</dd>
                      <dt>이메일</dt><dd>{detail.seller.email ?? '받지 않음'}</dd>
                      <dt>사업자 확인</dt><dd>{detail.verifiedAt ? formatKst(detail.verifiedAt) : '확인 전'}</dd>
                    </dl>
                  ) : <p className="t-sm muted">판매자 신원정보를 아직 받지 않았습니다. 판매 승인 요청 때 받습니다(SCR-021, 다음 묶음).</p>
                ) : null}

                {tab === 'pg' ? (
                  <section className="col" style={{ gap: 10 }} aria-labelledby="h-pg">
                    <div className="banner banner-info">
                      <div className="banner-body">
                        <span className="banner-title">지급대행 연동 전</span>
                        토스페이먼츠 셀러 등록·포트원 파트너 등록·정산 계좌·KYC는 아직 이 화면에서 다루지 않습니다(LCH-110·LCH-120). 가짜 상태를 채우지 않습니다.
                      </div>
                    </div>
                    <dl className="kv">
                      <dt>토스페이먼츠 셀러</dt><dd>등록 전</dd>
                      <dt>포트원 파트너</dt><dd>등록 전</dd>
                      <dt>정산 계좌</dt><dd>연동 전</dd>
                    </dl>
                  </section>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
