// SCR-019 셔플 검증(d5 §5.19, d3 SCR-019 행, planning/04 SCR-019, 캔버스 보드 SCR-019-m·t·d를 한 페이지 반응형으로 합쳤다).
// 머리(공연 상세로 돌아가기 · h1 · 설명 · 배지) → ①~⑤ 공개 기록 타임라인(CMP-049) → ⑧ 동시 도착 묶음 → ⑥⑨ 내 순번 검증 → ⑦ 재현 규격.
// 휴대폰·태블릿: 한 열(태블릿은 검증 입력 옆에 버튼). 데스크톱(lg): 12칸 — 왼쪽 8칸 공개 기록·묶음, 오른쪽 4칸 고정 검증 패널.
// 상태: ?state=시드 공개 뒤·셔플 전·셔플 직후·검증 결과 일치·FIFO 공연·파일 없음(합성 값 미리보기, 개발 서버에서 아는 상태 이름일 때만). 그 밖에는 실제 공시 기록을 읽는다(ShuffleProofLive, ADR-0232).
import { notFound } from 'next/navigation';
import { resolvePreviewTheme } from '@peaket/ds/Preview';
import { getPerformance } from '@/entities/performance';
import { getProduction, SORT_MODE_LABEL } from '@/entities/production';
import { getShuffleProof, OPEN_TEXT } from '@/entities/shuffle-proof';
import { SCR019_STATES, type Scr019State } from '@/shared/config/screens.discovery';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { type ProofFlags, previewStateOf } from '../model/proof-view';
import { ProofHeading, ProofNoFile, ShuffleProofBody } from './ShuffleProofBody';
import { ShuffleProofLive } from './ShuffleProofLive';

type Props = PageProps<{ id: string }>;

/** 보드 renderVals 그대로 */
function view(st: Scr019State): ProofFlags {
  const fifo = st === 'FIFO 공연';
  const pub = st === '시드 공개 뒤' || st === '셔플 직후' || st === '검증 결과 일치' || fifo;
  const seed = st === '시드 공개 뒤' || st === '검증 결과 일치' || fifo;
  return {
    fifo,
    noFile: st === '파일 없음',
    preT0: st === '셔플 전',
    commitOpen: true,
    rootOpen: pub,
    pub,
    rootLate: false,
    batchCommitOpen: true,
    batchRootOpen: pub,
    batchPub: pub,
    batchRootLate: false,
    seedOpen: seed,
    batchSeedOpen: seed,
    verifyOpen: seed,
    matched: st === '검증 결과 일치',
    hasBatch: true,
    allStopped: false,
    stoppedNote: null,
    batchStoppedNote: null,
  };
}

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export async function ShuffleProofPage({ params, searchParams }: Props) {
  const { id } = await params;
  const eventId = decoded(id);
  const sp = await searchParams;
  const dark = resolvePreviewTheme(sp) === 'dark';
  const backHref = `/events/${encodeURIComponent(eventId)}`;
  // 화면에 보일 공연 이름은 목업 목록에서 찾고, 없는 실제 회차도 공시 기록은 그대로 보인다
  const perf = getPerformance(eventId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const previewState = previewStateOf(firstParam(sp, 'state'), process.env.NODE_ENV, SCR019_STATES as readonly Scr019State[]);

  if (previewState === null) {
    return (
      <AppShell dark={dark}>
        <main className="page-main lg:px-8" id="main" tabIndex={-1}>
          <div className="col mx-auto w-full max-w-[976px] gap-7 px-4 pt-5 pb-10 md:gap-9 md:px-6 md:pt-7 md:pb-12 lg:gap-8 lg:px-0 lg:pt-8 lg:pb-16">
            <ShuffleProofLive eventId={eventId} {...(production ? { title: production.title } : {})} {...(perf ? { perfLabel: perf.label } : {})} backHref={backHref} />
          </div>
        </main>
      </AppShell>
    );
  }

  if (!perf || !production) notFound();
  const state = previewState;
  const v = view(state);
  const proof = getShuffleProof(perf.id, v.fifo);
  const sortLabel = v.fifo ? SORT_MODE_LABEL.FIFO : SORT_MODE_LABEL[production.sortMode === 'FIFO' ? 'HYBRID' : production.sortMode];

  return (
    <AppShell dark={dark}>
      <main className="page-main lg:px-8" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[976px] gap-7 px-4 pt-5 pb-10 md:gap-9 md:px-6 md:pt-7 md:pb-12 lg:gap-8 lg:px-0 lg:pt-8 lg:pb-16">
          <ProofHeading title={production.title} perfLabel={perf.label} backHref={backHref} sortLabel={sortLabel} v={v} openText={OPEN_TEXT} seedAt={proof.seed.at} />
          {v.noFile ? (
            <ProofNoFile retryHref={`/events/${perf.id}/shuffle-proof`} />
          ) : (
            <ShuffleProofBody proof={proof} v={v} verifierKey={state} autofill={proof.myToken} defaultResult={{ fileRank: proof.myRank, recomputedRank: proof.myRank }} />
          )}
        </div>
      </main>
      <PreviewSwitcher path={`/events/${perf.id}/shuffle-proof`} states={SCR019_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
