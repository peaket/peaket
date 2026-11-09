// SCR-019 셔플 검증의 본문(d5 §5.19): 머리·①~⑤ 공개 기록 타임라인(CMP-049)·⑧ 동시 도착 묶음·⑥⑨ 내 순번 검증·⑦ 재현 규격.
// 미리보기(?state=)는 서버에서, 실제 공시 기록은 ShuffleProofLive가 브라우저에서 같은 본문을 그린다. 받은 값(해시·사유·한계)은 React 텍스트로만 넣는다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ProofCard, ProofHash, ProofValue, ShuffleProofPanel, ShuffleVerifier, type ShuffleProofStep, type ShuffleVerifierResult } from '@peaket/ds/ShuffleProofPanel';
import { SHUFFLE_SPEC_URL, type ShuffleProof } from '@/entities/shuffle-proof';
import { disclosureBadgesOf, type DisclosureView, type ProofFlags, resultFileHref, resultStep, seedBadgesOf, seedNote, verifyDisabledReason } from '../model/proof-view';
import { EMERGENCY_BEACON_HEX } from '../model/recompute';

export function ProofHeading({ title, perfLabel, backHref, sortLabel, v, openText, seedAt }: { title?: string; perfLabel?: string; backHref: string; sortLabel: string; v: ProofFlags; openText: string; seedAt: string }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <Link className="row t-sm self-start" href={backHref} style={{ gap: 2, color: 'var(--text-muted)' }}>
        <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
        {title && perfLabel ? `${title} · ${perfLabel}` : '공연 상세로 돌아가기'}
      </Link>
      <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]">셔플 검증</h1>
      <p className="t-md muted">누구나 공개된 시드·비콘·참가자 목록으로 전체 순서를 다시 계산할 수 있습니다</p>
      {v.preT0 ? (
        <div className="banner banner-info mt-1.5" role="status">
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">셔플 전입니다</span>
            오픈 <span className="num">{openText}</span> · 원본 시드 공개 <span className="num">{seedAt}</span> 예정
          </div>
        </div>
      ) : !v.noFile ? (
        <div className="row wrap mt-1.5" style={{ gap: 6 }}>
          <span className="badge badge-primary">{sortLabel}</span>
          {seedBadgesOf(v).map((b) => (
            <span key={b.label} className={`badge badge-${b.tone}`}>
              <i className={`ic ${b.tone === 'success' ? 'ic-check' : 'ic-clock'}`} aria-hidden="true" />
              {b.label}
            </span>
          ))}
          {disclosureBadgesOf(v).map((b) => (
            <span key={b.label} className={`badge badge-${b.tone}`}>
              <i className="ic ic-alert-circle" aria-hidden="true" />
              {b.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProofNoFile({ retryHref, onRetry }: { retryHref: string; onRetry?: () => void }) {
  return (
    <div className="state card-flat px-5 py-10" role="alert">
      <span className="state-icon is-danger">
        <i className="ic ic-alert-circle" aria-hidden="true" />
      </span>
      <p className="t-lg">검증 파일을 찾지 못했습니다</p>
      {onRetry ? (
        <button className="btn btn-outline" type="button" onClick={onRetry}>
          <i className="ic ic-refresh" aria-hidden="true" />
          다시 시도
        </button>
      ) : (
        <Link className="btn btn-outline" href={retryHref}>
          <i className="ic ic-refresh" aria-hidden="true" />
          다시 시도
        </Link>
      )}
    </div>
  );
}

export interface ProofBodyProps {
  proof: ShuffleProof;
  v: ProofFlags;
  /** 미리보기 상태가 바뀌면 입력을 처음으로 되돌린다 */
  verifierKey: string;
  /** 같은 브라우저의 토큰 해시 */
  autofill?: string;
  onVerify?: (tokenHash: string, ctx: { signal: AbortSignal; onProgress: (text: string) => void }) => Promise<ShuffleVerifierResult | { error: string }>;
  defaultResult?: ShuffleVerifierResult;
  /** 시작 전에 알릴 받을 크기 */
  sizeNotice?: string;
}

export function ShuffleProofBody({ proof, v, verifierKey, autofill, onVerify, defaultResult, sizeNotice }: ProofBodyProps) {
  const disabledReason = verifyDisabledReason(v, proof.seed.at);
  return (
    <div className="col gap-7 md:gap-9 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6">
      <div className="col gap-4 md:gap-9 lg:col-span-8 lg:gap-10">
        {v.fifo ? null : (
          <section className="col gap-3.5 md:gap-4" aria-labelledby="h-tl">
            <h2 className="t-lg" id="h-tl">
              공개 기록
            </h2>
            <ShuffleProofPanel steps={timeline(proof, v, autofill)} />
          </section>
        )}
        <BatchSection proof={proof} v={v} autofill={autofill} />
      </div>

      <aside className="col gap-6 md:gap-9 lg:sticky lg:top-6 lg:col-span-4 lg:gap-4" aria-label="내 순번 검증과 재현 규격">
        <section className="col gap-3.5 md:gap-4 lg:gap-3.5" aria-labelledby="h-verify">
          <h2 className="t-lg" id="h-verify">
            내 순번 검증
          </h2>
          <ShuffleVerifier
            key={`${verifierKey}:${autofill ?? ''}`}
            className="p-4 md:p-5 lg:shadow-(--shadow-sm)"
            layout="responsive"
            tokenLabel={v.fifo ? '사전 검증 토큰 해시' : '참가 토큰 해시'}
            {...(autofill ? { autofill } : {})}
            hint={
              autofill
                ? v.fifo
                  ? '이 브라우저에 있는 사전 검증 토큰 해시를 자동으로 채웠습니다.'
                  : '이 브라우저에 있는 참가 토큰 해시를 자동으로 채웠습니다. 동시 도착 묶음 참가자는 사전 검증 토큰 해시를 넣습니다.'
                : v.fifo
                  ? '사전 검증 토큰의 SHA-256 해시를 넣습니다.'
                  : '참가 토큰의 SHA-256 해시를 넣습니다. 동시 도착 묶음 참가자는 사전 검증 토큰 해시를 넣습니다.'
            }
            {...(disabledReason ? { disabledReason } : {})}
            {...(defaultResult ? { result: defaultResult } : {})}
            defaultShowResult={v.matched}
            {...(onVerify ? { onVerify, busyLabel: '결과 파일을 모아 다시 계산하는 중입니다' } : {})}
            {...(sizeNotice ? { sizeNotice } : {})}
          />
        </section>
        <SpecLink />
      </aside>
    </div>
  );
}

/** ①~⑤ 공개 기록 네 단계 */
function timeline(p: ShuffleProof, v: ProofFlags, autofill: string | undefined): ShuffleProofStep[] {
  const result = resultStep({ pub: v.pub, rootOpen: v.rootOpen, stoppedNote: v.stoppedNote, emergency: v.disclosure.emergency !== null });
  return [
    {
      id: 'lobby',
      title: '로비 개방',
      meta: p.lobby.at,
      published: v.commitOpen,
      children: v.commitOpen ? (
        <ProofCard>
          <ProofHash label="시드 해시(커밋)" value={p.lobby.seedHash} copyLabel="시드 해시 복사" />
          <Facts
            items={[
              ['drand 체인', <span key="c" className="mono">{p.lobby.chain}</span>],
              ['라운드', <span key="r" className="num">{p.lobby.round}</span>],
              ['알고리즘', p.lobby.algorithm],
            ]}
          />
          <RedisclosureHistory items={v.disclosure.redisclosures} />
        </ProofCard>
      ) : (
        <p className="t-sm muted">로비 개방 전에 시드 해시와 사용할 drand 라운드를 공시합니다</p>
      ),
    },
    {
      id: 'open',
      title: '오픈 정각',
      meta: p.open.at,
      published: v.rootOpen,
      children: v.rootOpen ? (
        <ProofCard gap={4}>
          <ProofHash label="참가자 머클 루트" value={p.open.merkleRoot} copyLabel="머클 루트 복사" />
          {v.rootLate ? <p className="t-sm muted">이 머클 루트는 비콘 라운드가 나온 뒤에 공시했습니다</p> : null}
        </ProofCard>
      ) : (
        <p className="t-sm muted">오픈 때 참가자 목록을 고정하고 머클 루트를 공개합니다</p>
      ),
    },
    {
      id: 'result',
      title: '결과 생성',
      meta: v.disclosure.emergency ? '비콘 없음' : p.result.roundLabel,
      published: v.pub,
      children: (
        <div className="col" style={{ gap: 8 }}>
          <DisclosureNotices d={v.disclosure} round={p.lobby.round} />
          {result.showValues ? (
            <ProofCard>
              {!v.disclosure.emergency && p.result.beacon ? (
                <>
                  <ProofValue label="drand 값">
                    <code className="hash">{p.result.beacon}</code>
                  </ProofValue>
                  <ProofValue label="drand 서명">
                    <code className="hash">{p.result.signature}</code>
                  </ProofValue>
                </>
              ) : null}
              <ProofHash label="결과 파일 주소 · 참가 토큰 해시 앞 세 자리별 4,096개" value={`${p.result.fileBase}{앞 세 자리}.json`} copyLabel="결과 파일 주소 복사" />
              <div className="row between wrap" style={{ gap: 8 }}>
                <span className="t-sm muted">
                  결과 게시 <span className="num">{p.result.publishedAt}</span>
                </span>
                <MyResultFile base={p.result.fileBase} autofill={autofill} />
              </div>
            </ProofCard>
          ) : null}
          {result.note ? <p className="t-sm muted">{result.note}</p> : null}
        </div>
      ),
    },
    {
      id: 'seed',
      title: '시드 공개',
      meta: p.seed.at,
      published: v.seedOpen,
      children: v.seedOpen ? (
        <ProofCard gap={4}>
          <ProofHash label="원본 시드" value={p.seed.value} copyLabel="원본 시드 복사" />
        </ProofCard>
      ) : (
        <p className="t-sm muted">{seedNote(v.stoppedNote, '오픈 60분 뒤 원본 시드를 공개합니다')}</p>
      ),
    },
  ];
}

/** ③·⑧ 공시 안내: 읽지 못한 공시(위조·손상 가능성)와 비상 셔플의 사유·한계(ADR-0239 결정 13) */
function DisclosureNotices({ d, round }: { d: DisclosureView; round: string }) {
  return (
    <>
      {d.invalidNote ? (
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">{d.invalidNote}</span>
          </div>
        </div>
      ) : null}
      {d.emergency ? <EmergencyNotice e={d.emergency} round={round} /> : null}
    </>
  );
}

/** 비상 셔플은 공개 난수가 없다. 그 사실과 사유·한계를 값 자리에 먼저 보인다(d5 §5.19 '비상 셔플') */
function EmergencyNotice({ e, round }: { e: NonNullable<DisclosureView['emergency']>; round: string }) {
  const facts = [
    ['허가 시각', e.at],
    ['서버가 적은 사유', e.reason],
    ['서버가 적은 한계', e.limitation],
  ] as const;
  return (
    <div className="banner banner-warning" role="note" style={{ overflowWrap: 'anywhere' }}>
      <i className="ic ic-alert-circle" aria-hidden="true" />
      <div className="banner-body col" style={{ gap: 8, minWidth: 0 }}>
        <span className="banner-title">비상 셔플: 비콘(외부 공개 난수) 없이 시드만으로 뽑았습니다</span>
        <dl className="col t-sm" style={{ gap: 4 }}>
          {facts.map(([k, val]) => (
            <div key={k}>
              <dt className="inline fw-b">{k}</dt> <dd className="inline">{val}</dd>
            </div>
          ))}
        </dl>
        <p className="t-sm">{round ? `공시했던 라운드(${round})는 쓰지 않았습니다. ` : ''}다시 계산할 때는 비콘 값 자리에 아래 고정값을 넣습니다</p>
        <ProofHash label={'고정 비콘 값 · SHA-256("PEAKET-shuffle-v1-no-beacon")'} value={EMERGENCY_BEACON_HEX} copyLabel="고정 비콘 값 복사" />
      </div>
    </div>
  );
}

/** ①·⑧ 라운드를 다시 공시한 이력은 모두 보인다(라운드를 고르는 일은 결과를 다시 뽑는 일이 될 수 있어 숨기지 않는다, ADR-0239 결정 12) */
function RedisclosureHistory({ items }: { items: DisclosureView['redisclosures'] }) {
  if (items.length === 0) return null;
  return (
    <ProofValue label="라운드 다시 공시 이력">
      <p className="t-sm muted">공시 뒤 일정이 바뀌어 라운드만 다시 공시했습니다. 시드와 커밋은 그대로입니다. 줄 끝의 사유는 서버가 적은 글입니다</p>
      <ol className="col t-sm" style={{ gap: 4, overflowWrap: 'anywhere' }}>
        {items.map((r, i) => (
          <li key={`${i}:${r.previousRound}:${r.round}`}>
            <span className="num">
              {r.previousRound} → {r.round}
            </span>{' '}
            · <span className="num">{r.at}</span> · {r.reason}
          </li>
        ))}
      </ol>
    </ProofValue>
  );
}

/** ④ 결과 파일은 앞자리별로 나뉘어 있어, 내 토큰 해시를 알 때 내 앞자리 파일로 잇는다 */
function MyResultFile({ base, autofill }: { base: string; autofill: string | undefined }) {
  if (!autofill) return <span className="t-sm muted">토큰 해시 앞 세 자리의 파일을 받습니다</span>;
  return (
    <a className="link-more" href={resultFileHref(base, autofill)}>
      <i className="ic ic-download" aria-hidden="true" />내 앞자리 결과 파일 내려받기
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </a>
  );
}

/** 휴대폰: 키트 .kv(이름 왼쪽·값 오른쪽) · 태블릿 이상: 세 칸(이름 위·값 아래) */
function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] leading-[18px] md:grid-cols-3 md:gap-3">
      {items.map(([k, val]) => (
        <div key={k} className="contents md:flex md:flex-col md:gap-0.5">
          <dt className="muted md:text-xs md:leading-4 md:font-bold">{k}</dt>
          <dd className="text-right font-medium md:text-left md:text-sm md:leading-[19px] md:font-normal">{val}</dd>
        </div>
      ))}
    </dl>
  );
}

/** ⑧ 동시 도착 묶음(오픈 10분 전 커밋, 오픈 직후 2초 묶음의 시드·참가자 루트) */
function BatchSection({ proof: p, v, autofill }: { proof: ShuffleProof; v: ProofFlags; autofill: string | undefined }) {
  const batchResult = resultStep({ pub: v.batchPub, rootOpen: v.batchRootOpen, stoppedNote: v.batchStoppedNote, emergency: v.batchDisclosure.emergency !== null });
  const facts: [string, ReactNode][] = [
    ['묶음 구간', <span key="w" className="num">{p.batch.window}</span>],
    ['대상', '오픈 전에 사람 확인을 마치고 이 구간에 도착한 분'],
    ['순서', v.fifo ? '이 구간에 도착한 분들은 무작위로 순서를 정하고, 그 뒤에 오신 분은 도착 순으로 섭니다' : '로비 참가자 뒤에 이어 섭니다'],
  ];
  return (
    <section className="col gap-3.5 md:gap-4" aria-labelledby="h-batch">
      <h2 className="t-lg" id="h-batch">
        동시 도착 묶음
      </h2>
      <dl className="card-flat col gap-2 px-4 py-3.5 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] md:gap-4 md:p-4">
        {facts.map(([k, val]) => (
          <div key={k} className="t-sm md:flex md:flex-col md:gap-0.5">
            <dt className="inline fw-b md:block md:text-xs md:leading-4 md:text-(--text-muted)">{k}</dt>{' '}
            <dd className="inline md:block">{val}</dd>
          </div>
        ))}
      </dl>
      <ProofCard>
        {v.batchCommitOpen ? (
          <ProofHash label={`묶음 시드 해시(커밋) · ${p.batch.committedAt} 공시`} value={p.batch.seedHash} copyLabel="묶음 시드 해시 복사" />
        ) : (
          <p className="t-sm muted">오픈 10분 전에 묶음 시드 해시를 공시합니다</p>
        )}
        <RedisclosureHistory items={v.batchDisclosure.redisclosures} />
        {v.batchRootOpen ? (
          <ProofValue
            label={
              <>
                묶음 참가자 머클 루트 · drand 라운드 <span className="num">{p.batch.round}</span>
              </>
            }
          >
            <code className="hash">{p.batch.merkleRoot}</code>
          </ProofValue>
        ) : (
          <p className="t-sm muted">묶음이 닫히면 참가자 머클 루트를 공개합니다</p>
        )}
        {v.batchRootLate ? <p className="t-sm muted">이 머클 루트는 비콘 라운드가 나온 뒤에 공시했습니다</p> : null}
        <DisclosureNotices d={v.batchDisclosure} round={p.batch.round} />
        {batchResult.showValues ? (
          <>
            {!v.batchDisclosure.emergency && p.batch.beacon ? (
              <>
                <ProofValue label="묶음 drand 값">
                  <code className="hash">{p.batch.beacon}</code>
                </ProofValue>
                <ProofValue label="묶음 drand 서명">
                  <code className="hash">{p.batch.signature}</code>
                </ProofValue>
              </>
            ) : null}
            <ProofHash label="묶음 결과 파일 주소 · 사전 검증 토큰 해시 앞 세 자리별" value={`${p.batch.fileBase}{앞 세 자리}.json`} copyLabel="묶음 결과 파일 주소 복사" />
            {v.fifo ? <MyResultFile base={p.batch.fileBase} autofill={autofill} /> : null}
          </>
        ) : null}
        {batchResult.note && (v.batchRootOpen || v.batchStoppedNote) ? <p className="t-sm muted">{batchResult.note}</p> : null}
        {v.batchSeedOpen ? (
          <ProofValue label="묶음 원본 시드">
            <code className="hash">{p.batch.seed}</code>
          </ProofValue>
        ) : (
          <p className="t-sm muted">{seedNote(v.batchStoppedNote, `묶음 원본 시드는 ${p.seed.at}에 공개합니다`)}</p>
        )}
      </ProofCard>
    </section>
  );
}

/** ⑦ 재현 규격·알고리즘 설명: 휴대폰은 줄 목록(.li), 태블릿 이상은 카드 */
function SpecLink() {
  return (
    <>
      <a className="li md:hidden" href={SHUFFLE_SPEC_URL} style={{ color: 'inherit', borderTop: '1px solid var(--border)' }}>
        <i className="ic ic-doc ic-24" aria-hidden="true" style={{ color: 'var(--link)' }} />
        <span className="li-title grow">재현 규격·알고리즘 설명</span>
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>
      <a className="card hidden items-center md:flex" href={SHUFFLE_SPEC_URL} style={{ gap: 14, padding: 18, color: 'inherit' }}>
        <i className="ic ic-doc ic-24" aria-hidden="true" style={{ color: 'var(--link)' }} />
        <span className="t-md fw-b grow">재현 규격·알고리즘 설명</span>
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>
    </>
  );
}
