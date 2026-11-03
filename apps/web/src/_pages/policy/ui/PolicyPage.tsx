// SCR-057 약관·정책 문서(d5 §5.31, d3 SCR-057 행, 캔버스 보드 SCR-057-m·t·d를 한 페이지 반응형으로 합쳤다).
// ① 문서 선택 → ② 제목·시행일·이전 버전 → ③ 목차 → 본문(h2·h3). 개인정보 처리방침에는 쿠키 목록 표(쿠키 동의 배너는 두지 않는다, ADR-0060).
// 휴대폰: 한 열(간격 20) · 태블릿(md): 문서 선택 최대 400, 제목 t-2xl, 목차 두 칸 · 데스크톱(lg): 12칸 — 왼쪽 3칸 문서 선택·고정 목차, 오른쪽 9칸 제목·본문(최대 720).
// 상태: ?state=개인정보 처리방침·이용약관·없는 문서(보드). 없으면 주소의 문서. 모르는 문서 주소는 notFound() → 같은 폴더의 '없는 문서' 화면(404).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { getPolicyDoc, POLICY_DOCS, type PolicyBlock, type PolicyDoc } from '@/entities/policy-doc';
import { SCR057_STATES, type Scr057State } from '@/shared/config/screens.discovery';
import { cx } from '@/shared/lib/cx';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { DocSelect } from './DocSelect';

type Props = PageProps<{ slug: string }>;

const STATE_SLUG: Record<Exclude<Scr057State, '없는 문서'>, string> = { '개인정보 처리방침': 'privacy', 이용약관: 'terms' };
const DOC_OPTIONS = POLICY_DOCS.map((d) => ({ slug: d.slug, title: d.title }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: getPolicyDoc(slug)?.title ?? '약관·정책 문서' };
}

export async function PolicyPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const dark = resolvePreviewTheme(sp) === 'dark';
  const picked = firstParam(sp, 'state') !== undefined ? resolvePreviewState(sp, SCR057_STATES, '개인정보 처리방침') : null;
  const doc = picked === '없는 문서' ? undefined : getPolicyDoc(picked ? STATE_SLUG[picked] : slug);
  if (!doc && picked === null) notFound();
  const current: Scr057State = picked ?? (doc?.slug === 'terms' ? '이용약관' : '개인정보 처리방침');
  const version = firstParam(sp, 'version');
  const old = doc?.previous !== undefined && version === doc.previous;

  return (
    <AppShell dark={dark}>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        {doc ? <DocBody doc={doc} old={old} /> : <MissingDoc />}
      </main>
      <PreviewSwitcher path={`/policy/${slug}`} states={SCR057_STATES} current={current} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

/** 모르는 문서 주소(not-found)·'없는 문서' 상태(보드): 문서 선택(문서를 고르세요) + '주소를 찾을 수 없습니다' 카드 */
export function PolicyNotFound() {
  return (
    <AppShell>
      <main className="page-main px-4 pt-4 pb-10 md:px-6 md:pt-6 md:pb-12 lg:px-8 lg:pt-10 lg:pb-16" id="main" tabIndex={-1}>
        <MissingDoc />
      </main>
    </AppShell>
  );
}

function MissingDoc() {
  return (
    <div className="col mx-auto w-full max-w-[976px] gap-6">
      <DocSelect docs={DOC_OPTIONS} current={null} className="md:max-w-[400px] lg:max-w-[226px]" />
      <div className="card state px-5 py-9">
        <span className="state-icon h-14 w-14">
          <i className="ic ic-doc" aria-hidden="true" />
        </span>
        <h1 className="t-lg">주소를 찾을 수 없습니다</h1>
        <Link className="link-more min-h-11" href="/">
          홈으로
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function DocBody({ doc, old }: { doc: PolicyDoc; old: boolean }) {
  const h = `doc-h-${doc.slug}`;
  const toc = `toc-h-${doc.slug}`;
  const posted = !doc.postedOnly;
  return (
    <div className="col mx-auto w-full max-w-[976px] gap-5 md:gap-6 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:gap-y-8">
      <DocSelect docs={DOC_OPTIONS} current={doc.slug} className="md:max-w-[400px] lg:col-span-3 lg:max-w-none" />

      <div className="col lg:col-span-9 lg:self-end" style={{ gap: 8 }}>
        <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]" id={h}>
          {doc.title}
        </h1>
        <p className="row wrap t-sm muted" style={{ gap: '4px 14px' }}>
          <span>
            시행일 <span className="num">{old ? doc.previous : doc.effective}</span>
            {old ? ' · 이전 버전' : null}
          </span>
          {doc.previous && !old ? (
            <Link className="link-more" href={`/policy/${doc.slug}?version=${doc.previous}`}>
              이전 버전
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          ) : null}
          {old ? (
            <Link className="link-more" href={`/policy/${doc.slug}`}>
              지금 버전 보기
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          ) : null}
        </p>
      </div>

      {posted ? (
        <>
          <nav className="card-flat pad col lg:sticky lg:top-6 lg:col-span-3" style={{ gap: 10 }} aria-labelledby={toc}>
            <h2 className="t-md fw-b" id={toc}>
              목차
            </h2>
            <ol className="col t-sm gap-1 md:grid md:grid-cols-2 md:gap-x-6 md:gap-y-1.5 lg:flex lg:gap-2">
              {doc.sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.title}</a>
                </li>
              ))}
            </ol>
          </nav>

          <article className="prose lg:col-span-9 lg:max-w-[720px]" aria-labelledby={h}>
            {doc.sections.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-20" aria-labelledby={`${s.id}-h`}>
                <h2 id={`${s.id}-h`} style={i === 0 ? { marginTop: 0 } : undefined}>
                  {s.title}
                </h2>
                {s.blocks.map((b, k) => (
                  <Block key={k} block={b} />
                ))}
              </section>
            ))}
          </article>
        </>
      ) : (
        // 보안 사고 안내는 게시 중일 때만 내용이 있다(d5 §5.31). 게시 중인 안내가 없을 때의 글은 정본에 없어 정했다(추천안)
        <div className="state card-flat px-5 py-9 lg:col-span-9 lg:col-start-4">
          <span className="state-icon">
            <i className="ic ic-shield" aria-hidden="true" />
          </span>
          <p className="t-md fw-b">지금 게시 중인 보안 사고 안내가 없습니다</p>
        </div>
      )}
    </div>
  );
}

function Block({ block }: { block: PolicyBlock }) {
  switch (block.kind) {
    case 'placeholder':
      return <p className="muted">[조항 본문은 법무 검토 뒤 확정]</p>;
    case 'p':
      return <p>{block.text}</p>;
    case 'h3':
      return <h3 id={block.id}>{block.text}</h3>;
    case 'link':
      return (
        <p>
          <Link className="link-more" href={block.href}>
            {block.text}
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </p>
      );
    case 'legal':
      return (
        <div className="banner banner-legal" style={{ margin: '8px 0 10px' }}>
          <i className="ic ic-building" aria-hidden="true" />
          <div className="banner-body">
            <span className="legal-tag">법정 고지</span>
            {block.text}
          </div>
        </div>
      );
    case 'table':
      return (
        <div className="table-wrap relative" style={{ margin: '8px 0 10px' }}>
          <table className="table dense" aria-labelledby={block.labelledBy}>
            {block.caption ? <caption className="sr-only">{block.caption}</caption> : null}
            <thead>
              <tr>
                {block.head.map((th) => (
                  <th key={th} scope="col" style={{ whiteSpace: 'normal' }}>
                    {th}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.join('|')}>
                  {row.map((cell, c) => (
                    <td key={c} className={cx(block.mutedCols?.includes(c) && 'muted')}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
