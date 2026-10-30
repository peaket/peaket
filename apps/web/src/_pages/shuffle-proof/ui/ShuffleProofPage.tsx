// SCR-019 셔플 검증(d5 §5.19, d3 SCR-019 행, planning/04 SCR-019, 캔버스 보드 SCR-019-m·t·d를 한 페이지 반응형으로 합쳤다).
// 머리(공연 상세로 돌아가기 · h1 · 설명 · 배지) → ①~⑤ 공개 기록 타임라인(CMP-049) → ⑧ 동시 도착 묶음 → ⑥⑨ 내 순번 검증 → ⑦ 재현 규격.
// 휴대폰·태블릿: 한 열(태블릿은 검증 입력 옆에 버튼). 데스크톱(lg): 12칸 — 왼쪽 8칸 공개 기록·묶음, 오른쪽 4칸 고정 검증 패널.
// 상태: ?state=시드 공개 뒤(기본)·셔플 전·셔플 직후·검증 결과 일치·FIFO 공연·파일 없음. 선착순 공연 회차는 상태를 고르지 않아도 'FIFO 공연' 모양이다.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ProofCard, ProofHash, ProofValue, ShuffleProofPanel, ShuffleVerifier, type ShuffleProofStep } from '@peaket/ds/ShuffleProofPanel';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { getPerformance } from '@/entities/performance';
import { getProduction, SORT_MODE_LABEL } from '@/entities/production';
import { getShuffleProof, OPEN_TEXT, SHUFFLE_SPEC_URL, type ShuffleProof } from '@/entities/shuffle-proof';
import { SCR019_STATES, type Scr019State } from '@/shared/config/screens.discovery';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';

type Props = PageProps<{ id: string }>;

/** 보드 renderVals 그대로 */
function view(st: Scr019State) {
  const fifo = st === 'FIFO 공연';
  const pub = st === '시드 공개 뒤' || st === '셔플 직후' || st === '검증 결과 일치' || fifo;
  const seed = st === '시드 공개 뒤' || st === '검증 결과 일치' || fifo;
  return {
    fifo,
    noFile: st === '파일 없음',
    preT0: st === '셔플 전',
    pub,
    afterShuffle: st === '셔플 직후',
    seedOpen: seed,
    matched: st === '검증 결과 일치',
  };
}

export async function ShuffleProofPage({ params, searchParams }: Props) {
  const { id } = await params;
  const perf = getPerformance(id);
  const production = perf ? getProduction(perf.productionId) : undefined;
  if (!perf || !production) notFound();
  const sp = await searchParams;
  const realFifo = production.sortMode === 'FIFO';
  const fallback: Scr019State = realFifo ? 'FIFO 공연' : '시드 공개 뒤';
  const state = firstParam(sp, 'state') !== undefined ? resolvePreviewState(sp, SCR019_STATES, fallback) : fallback;
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = view(state);
  const proof = getShuffleProof(perf.id, v.fifo);
  const sortLabel = v.fifo ? SORT_MODE_LABEL.FIFO : SORT_MODE_LABEL[production.sortMode === 'FIFO' ? 'HYBRID' : production.sortMode];

  return (
    <AppShell dark={dark}>
      <main className="page-main lg:px-8" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[976px] gap-7 px-4 pt-5 pb-10 md:gap-9 md:px-6 md:pt-7 md:pb-12 lg:gap-8 lg:px-0 lg:pt-8 lg:pb-16">
          <div className="col" style={{ gap: 10 }}>
            <Link className="row t-sm self-start" href={`/events/${perf.id}`} style={{ gap: 2, color: 'var(--text-muted)' }}>
              <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
              {production.title} · {perf.label}
            </Link>
            <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]">셔플 검증</h1>
            <p className="t-md muted">누구나 공개된 시드·비콘·참가자 목록으로 전체 순서를 다시 계산할 수 있습니다</p>
            {v.preT0 ? (
              <div className="banner banner-info mt-1.5" role="status">
                <i className="ic ic-clock" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">셔플 전입니다</span>
                  오픈 <span className="num">{OPEN_TEXT}</span> · 원본 시드 공개 <span className="num">{proof.seed.at}</span> 예정
                </div>
              </div>
            ) : !v.noFile ? (
              <div className="row wrap mt-1.5" style={{ gap: 6 }}>
                <span className="badge badge-primary">{sortLabel}</span>
                {v.seedOpen ? (
                  <span className="badge badge-success">
                    <i className="ic ic-check" aria-hidden="true" />
                    원본 시드 공개됨
                  </span>
                ) : (
                  <span className="badge badge-warning">
                    <i className="ic ic-clock" aria-hidden="true" />
                    원본 시드 공개 전
                  </span>
                )}
              </div>
            ) : null}
          </div>

          {v.noFile ? (
            <div className="state card-flat px-5 py-10" role="alert">
              <span className="state-icon is-danger">
                <i className="ic ic-alert-circle" aria-hidden="true" />
              </span>
              <p className="t-lg">검증 파일을 찾지 못했습니다</p>
              {/* 다시 시도는 같은 주소를 다시 부른다(검증 정보 API를 잇는 단계에서 다시 받기로 바꾼다) */}
              <Link className="btn btn-outline" href={`/events/${perf.id}/shuffle-proof`}>
                <i className="ic ic-refresh" aria-hidden="true" />
                다시 시도
              </Link>
            </div>
          ) : (
            <div className="col gap-7 md:gap-9 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6">
              <div className="col gap-4 md:gap-9 lg:col-span-8 lg:gap-10">
                {v.fifo ? null : (
                  <section className="col gap-3.5 md:gap-4" aria-labelledby="h-tl">
                    <h2 className="t-lg" id="h-tl">
                      공개 기록
                    </h2>
                    <ShuffleProofPanel steps={timeline(proof, v)} />
                  </section>
                )}
                <BatchSection proof={proof} v={v} />
              </div>

              <aside className="col gap-6 md:gap-9 lg:sticky lg:top-6 lg:col-span-4 lg:gap-4" aria-label="내 순번 검증과 재현 규격">
                <section className="col gap-3.5 md:gap-4 lg:gap-3.5" aria-labelledby="h-verify">
                  <h2 className="t-lg" id="h-verify">
                    내 순번 검증
                  </h2>
                  <ShuffleVerifier
                    key={state}
                    className="p-4 md:p-5 lg:shadow-(--shadow-sm)"
                    layout="responsive"
                    tokenLabel={v.fifo ? '사전 검증 토큰 해시' : '참가 토큰 해시'}
                    autofill={proof.myToken}
                    hint={
                      v.fifo
                        ? '이 브라우저에 있는 사전 검증 토큰 해시를 자동으로 채웠습니다.'
                        : '이 브라우저에 있는 참가 토큰 해시를 자동으로 채웠습니다. 동시 도착 묶음 참가자는 사전 검증 토큰 해시를 넣습니다.'
                    }
                    disabledReason={v.seedOpen ? undefined : `원본 시드를 공개한 뒤(${proof.seed.at}) 다시 계산할 수 있습니다`}
                    result={{ fileRank: proof.myRank, recomputedRank: proof.myRank }}
                    defaultShowResult={v.matched}
                  />
                </section>
                <SpecLink />
              </aside>
            </div>
          )}
        </div>
      </main>
      <PreviewSwitcher path={`/events/${perf.id}/shuffle-proof`} states={SCR019_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

type View = ReturnType<typeof view>;

/** ①~⑤ 공개 기록 네 단계 */
function timeline(p: ShuffleProof, v: View): ShuffleProofStep[] {
  return [
    {
      id: 'lobby',
      title: '로비 개방',
      meta: p.lobby.at,
      published: true,
      children: (
        <ProofCard>
          <ProofHash label="시드 해시(커밋)" value={p.lobby.seedHash} copyLabel="시드 해시 복사" />
          <Facts
            items={[
              ['drand 체인', <span key="c" className="mono">{p.lobby.chain}</span>],
              ['라운드', <span key="r" className="num">{p.lobby.round}</span>],
              ['알고리즘', p.lobby.algorithm],
            ]}
          />
        </ProofCard>
      ),
    },
    {
      id: 'open',
      title: '오픈 정각',
      meta: p.open.at,
      published: v.pub,
      children: v.pub ? (
        <ProofCard gap={4}>
          <ProofHash label="참가자 머클 루트" value={p.open.merkleRoot} copyLabel="머클 루트 복사" />
        </ProofCard>
      ) : (
        <p className="t-sm muted">오픈 때 참가자 목록을 고정하고 머클 루트를 공개합니다</p>
      ),
    },
    {
      id: 'result',
      title: '결과 생성',
      meta: p.result.roundLabel,
      published: v.pub,
      children: v.pub ? (
        <ProofCard>
          <ProofValue label="drand 값">
            <code className="hash">{p.result.beacon}</code>
          </ProofValue>
          <ProofValue label="drand 서명">
            <code className="hash">{p.result.signature}</code>
          </ProofValue>
          <ProofHash label="결과 파일 주소 · 참가 토큰 해시 앞자리별 약 1,000개" value={p.result.fileUrl} copyLabel="결과 파일 주소 복사" />
          <div className="row between wrap" style={{ gap: 8 }}>
            <span className="t-sm muted">
              결과 게시 <span className="num">{p.result.publishedAt}</span>
            </span>
            <a className="link-more" href={p.result.fileUrl}>
              <i className="ic ic-download" aria-hidden="true" />
              정렬 결과 파일 내려받기
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </a>
          </div>
        </ProofCard>
      ) : (
        <p className="t-sm muted">
          공시한 drand 라운드 <span className="num">33,057,413</span>(20:00:03)을 받은 뒤 결과를 게시합니다
        </p>
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
        <p className="t-sm muted">오픈 60분 뒤 원본 시드를 공개합니다</p>
      ),
    },
  ];
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
function BatchSection({ proof: p, v }: { proof: ShuffleProof; v: View }) {
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
        <ProofHash label={`묶음 시드 해시(커밋) · ${p.batch.committedAt} 공시`} value={p.batch.seedHash} copyLabel="묶음 시드 해시 복사" />
        {v.pub ? (
          <>
            <ProofValue
              label={
                <>
                  묶음 참가자 머클 루트 · drand 라운드 <span className="num">{p.batch.round}</span>
                </>
              }
            >
              <code className="hash">{p.batch.merkleRoot}</code>
            </ProofValue>
            <ProofHash label="묶음 결과 파일 주소 · 사전 검증 토큰 해시 앞자리별" value={p.batch.fileUrl} copyLabel="묶음 결과 파일 주소 복사" />
          </>
        ) : (
          <p className="t-sm muted">묶음이 닫히면 참가자 머클 루트와 결과 파일을 공개합니다</p>
        )}
        {v.seedOpen ? (
          <ProofValue label="묶음 원본 시드">
            <code className="hash">{p.batch.seed}</code>
          </ProofValue>
        ) : (
          <p className="t-sm muted">
            묶음 원본 시드는 <span className="num">{p.seed.at}</span>에 공개합니다
          </p>
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
