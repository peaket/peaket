// 홈 구성(SCR-068 [홈 구성], d5 §7.16). 배너·테마를 표로 고치고 사유를 적어 게시한다.
// 휴대폰은 보기만 하고 작성·게시 자리에 범위 밖 안내 카드를 둔다(d5 §3.9 SCR-068 행).
// 판매 승인·기간·개수 검사는 model/home-layout.ts가 맡고, 단추는 보이기만 막는다(서버가 다시 막는다).
import { PhoneScopeCard } from '@/shared/ui/PhoneScopeCard';
import {
  BANNER_MAX,
  THEME_MAX,
  THEME_PRODUCTIONS_MAX,
  homeLayoutInputOf,
  type BannerView,
  type HomeLayoutView,
  type ThemeView,
} from '../../model/home-layout';
import type { NoticeLayout, NoticeRole } from '../../model/notices';

function Badge({ status }: { status: BannerView['status'] }) {
  const cls = status === '게시 중' ? 'badge badge-success' : status === '예정' ? 'badge badge-primary' : status === '끝남' ? 'badge' : 'badge badge-warning';
  return <span className={cls}>{status}</span>;
}

function ReadOnlyList({ view }: { view: HomeLayoutView }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <section className="widget" aria-labelledby="h-ro-b">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="h-ro-b">
            배너
          </h2>
          <span className="t-xs muted">
            {view.banners.length}장 · 최대 {BANNER_MAX}장
          </span>
        </div>
        <div className="widget-body" style={{ padding: 12, display: 'grid', gap: 8 }}>
          {view.banners.map((b) => (
            <article key={b.bannerId ?? b.productionId} className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">{b.title ?? b.productionId}</span>
              <span className="t-xs muted">{b.subtitle ?? b.alt}</span>
              <span>
                <Badge status={b.status} /> {b.reason ? <span className="t-xs muted">{b.reason}</span> : null}
              </span>
            </article>
          ))}
        </div>
      </section>
      <section className="widget" aria-labelledby="h-ro-t">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="h-ro-t">
            테마
          </h2>
        </div>
        <div className="widget-body" style={{ padding: 12, display: 'grid', gap: 8 }}>
          {view.themes.map((t) => (
            <article key={t.themeId ?? t.name} className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">{t.name}</span>
              <span className="t-xs muted">공연 {t.productionIds.length}개</span>
              <Badge status={t.status} />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function HomeLayoutPanel({
  role,
  layout,
  columns,
  view,
  reason,
  onChange,
  onReason,
  onPublish,
  onUpload,
  onReload,
  busy,
  error,
  problem,
}: {
  role: NoticeRole;
  layout: NoticeLayout;
  columns: 1 | 2 | 3;
  view: HomeLayoutView;
  reason: string;
  onChange: (view: HomeLayoutView) => void;
  onReason: (reason: string) => void;
  onPublish: () => void;
  onUpload: (index: number, file: File) => void;
  onReload: () => void;
  busy: boolean;
  error?: string | null;
  problem?: string | null;
}) {
  const phone = layout === 'phone';
  const canEdit = !phone && role !== 'viewer';
  const input = homeLayoutInputOf(view, { reason });
  const why = phone
    ? null
    : input
      ? null
      : reason.trim()
        ? '표에 저장할 수 없는 값이 있습니다. 노출 안 됨 까닭을 확인해 주세요'
        : '게시 사유를 적어 주세요';
  const setBanner = (index: number, patch: Partial<BannerView>) => {
    onChange({ ...view, banners: view.banners.map((b, i) => (i === index ? { ...b, ...patch } : b)) });
  };
  const setTheme = (index: number, patch: Partial<ThemeView>) => {
    onChange({ ...view, themes: view.themes.map((t, i) => (i === index ? { ...t, ...patch } : t)) });
  };
  const move = <T,>(items: T[], index: number, delta: number): T[] => {
    const next = [...items];
    const to = index + delta;
    if (to < 0 || to >= next.length) return next;
    [next[index], next[to]] = [next[to]!, next[index]!];
    return next;
  };
  const addBanner = () => {
    if (view.banners.length >= BANNER_MAX) return;
    onChange({
      ...view,
      banners: [
        ...view.banners,
        {
          productionId: '',
          imageId: '',
          alt: '',
          title: '',
          subtitle: '',
          displayFrom: new Date().toISOString(),
          displayUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          status: '노출 안 됨',
          reason: '저장 전',
        },
      ],
    });
  };
  const addTheme = () => {
    if (view.themes.length >= THEME_MAX) return;
    onChange({
      ...view,
      themes: [
        ...view.themes,
        {
          name: '',
          productionIds: [],
          displayFrom: new Date().toISOString(),
          displayUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          status: '노출 안 됨',
          reason: '저장 전',
        },
      ],
    });
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="banner banner-info">
        <span className="banner-title">판매 승인된 공연만 고를 수 있습니다</span>
        배너와 테마는 operator가 한 사람으로 게시하고, 게시와 변경은 감사 로그에 남습니다. 장르별 랭킹과 지금 판매 중은 시스템이 계산하므로 여기서 고치지 않습니다.
      </div>
      {phone ? <PhoneScopeCard title="홈 구성 편집·게시" /> : null}
      {error ? (
        <p className="hint" role="alert">
          {error}
        </p>
      ) : null}
      {problem ? (
        <div className="banner banner-warning" role="alert">
          <span className="banner-title">게시하지 못했습니다</span>
          {problem}
          <button className="btn btn-outline btn-sm" type="button" onClick={onReload} style={{ marginLeft: 8 }}>
            새로 읽기
          </button>
        </div>
      ) : null}

      {phone || role === 'viewer' ? (
        <div data-home-grid data-testid="home-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 12, alignItems: 'start' }}>
          <ReadOnlyList view={view} />
        </div>
      ) : (
        <div data-home-grid data-testid="home-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 12, alignItems: 'start' }}>
          <section className="widget" aria-labelledby="h-hb">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-hb">
                배너
              </h2>
              <span className="t-xs muted">
                {view.banners.length}장 · 최대 {BANNER_MAX}장
              </span>
              <span className="actions">
                <button className="btn btn-secondary btn-sm" type="button" onClick={addBanner} aria-disabled={view.banners.length >= BANNER_MAX ? 'true' : undefined}>
                  배너 추가
                </button>
              </span>
            </div>
            <div className="widget-body" style={{ padding: 12, display: 'grid', gap: 12 }}>
              <p className="hint">
                배너 이미지는 운영자가 올린 가로형 이미지(가로 1,240×400px 이상 [가정])입니다. 제목 40자·부제 80자와 대체 텍스트를 적어 주세요.
              </p>
              {view.banners.map((b, i) => (
                <article key={b.bannerId ?? `new-${i}`} className="col" style={{ gap: 6, borderTop: i ? '1px solid var(--border)' : undefined, paddingTop: i ? 10 : 0 }}>
                  <div className="row between" style={{ gap: 8 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="num fw-b">{i + 1}</span>
                      <Badge status={b.status} />
                      {b.reason ? <span className="t-xs muted">{b.reason}</span> : null}
                    </span>
                    <span className="row" style={{ gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onChange({ ...view, banners: move(view.banners, i, -1) })} aria-label={`${i + 1}번 배너 위로`}>
                        위
                      </button>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onChange({ ...view, banners: move(view.banners, i, 1) })} aria-label={`${i + 1}번 배너 아래로`}>
                        아래
                      </button>
                    </span>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <label className="field">
                      <span className="label">공연 ID</span>
                      <input className="input input-sm" name={`banner-production-${i}`} type="text" value={b.productionId} onChange={(e) => setBanner(i, { productionId: e.target.value })} />
                    </label>
                    <label className="field">
                      <span className="label">이미지</span>
                      <input
                        className="input input-sm"
                        name={`banner-image-${i}`}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) onUpload(i, file);
                        }}
                      />
                    </label>
                    <label className="field">
                      <span className="label">제목 (40자)</span>
                      <input className="input input-sm" name={`banner-title-${i}`} type="text" maxLength={40} value={b.title ?? ''} onChange={(e) => setBanner(i, { title: e.target.value })} />
                    </label>
                    <label className="field">
                      <span className="label">부제 (80자)</span>
                      <input className="input input-sm" name={`banner-subtitle-${i}`} type="text" maxLength={80} value={b.subtitle ?? ''} onChange={(e) => setBanner(i, { subtitle: e.target.value })} />
                    </label>
                  </div>
                  <label className="field">
                    <span className="label">대체 텍스트 (필수)</span>
                    <input className="input input-sm" name={`banner-alt-${i}`} type="text" maxLength={300} value={b.alt} onChange={(e) => setBanner(i, { alt: e.target.value })} />
                  </label>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <label className="field">
                      <span className="label">노출 시작 (KST)</span>
                      <input className="input input-sm" name={`banner-from-${i}`} type="datetime-local" value={b.displayFrom.slice(0, 16)} onChange={(e) => setBanner(i, { displayFrom: new Date(e.target.value).toISOString() })} />
                    </label>
                    <label className="field">
                      <span className="label">노출 끝 (KST)</span>
                      <input className="input input-sm" name={`banner-until-${i}`} type="datetime-local" value={b.displayUntil.slice(0, 16)} onChange={(e) => setBanner(i, { displayUntil: new Date(e.target.value).toISOString() })} />
                    </label>
                  </div>
                </article>
              ))}
              {view.banners.length === 0 ? <p className="muted">배너가 없습니다. [배너 추가]로 시작하세요.</p> : null}
            </div>
          </section>

          <section className="widget" aria-labelledby="h-ht">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-ht">
                테마
              </h2>
              <span className="t-xs muted">
                {view.themes.length}개 · 최대 {THEME_MAX}개
              </span>
              <span className="actions">
                <button className="btn btn-secondary btn-sm" type="button" onClick={addTheme} aria-disabled={view.themes.length >= THEME_MAX ? 'true' : undefined}>
                  테마 추가
                </button>
              </span>
            </div>
            <div className="widget-body" style={{ padding: 12, display: 'grid', gap: 12 }}>
              <p className="hint">테마 이름은 30자까지이고, 판매 승인된 공연을 1~{THEME_PRODUCTIONS_MAX}개 골라 순서를 정합니다.</p>
              {view.themes.map((t, i) => (
                <article key={t.themeId ?? `new-theme-${i}`} className="col" style={{ gap: 6, borderTop: i ? '1px solid var(--border)' : undefined, paddingTop: i ? 10 : 0 }}>
                  <div className="row between" style={{ gap: 8 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="num fw-b">{i + 1}</span>
                      <Badge status={t.status} />
                    </span>
                    <span className="row" style={{ gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onChange({ ...view, themes: move(view.themes, i, -1) })} aria-label={`${i + 1}번 테마 위로`}>
                        위
                      </button>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => onChange({ ...view, themes: move(view.themes, i, 1) })} aria-label={`${i + 1}번 테마 아래로`}>
                        아래
                      </button>
                    </span>
                  </div>
                  <label className="field">
                    <span className="label">테마 이름 (30자)</span>
                    <input className="input input-sm" name={`theme-name-${i}`} type="text" maxLength={30} value={t.name} onChange={(e) => setTheme(i, { name: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="label">공연 ID (쉼표로 구분)</span>
                    <input
                      className="input input-sm"
                      name={`theme-productions-${i}`}
                      type="text"
                      value={t.productionIds.join(', ')}
                      onChange={(e) => setTheme(i, { productionIds: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
                    />
                  </label>
                </article>
              ))}
              {view.themes.length === 0 ? <p className="muted">테마가 없습니다. [테마 추가]로 시작하세요.</p> : null}
            </div>
          </section>

          <div className="col" style={{ gap: 12 }}>
            <section className="widget" aria-labelledby="h-hp">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-hp">
                  미리보기
                </h2>
                <span className="t-xs muted">홈 슬라이드·테마 줄 모양</span>
              </div>
              <div className="widget-body" style={{ padding: 14, display: 'grid', gap: 10 }}>
                {view.banners.slice(0, 1).map((b) => (
                  <div key={b.bannerId ?? 'preview'} className="col" style={{ gap: 2 }}>
                    <span className="t-sm fw-b">{b.title || '배너 제목'}</span>
                    <span className="t-xs muted">{b.subtitle || b.alt || '부제'}</span>
                  </div>
                ))}
                {view.themes.slice(0, 1).map((t) => (
                  <div key={t.themeId ?? 'theme-preview'} className="col" style={{ gap: 2 }}>
                    <span className="t-xs fw-b">{t.name || '테마 이름'}</span>
                    <span className="t-xs muted">공연 {t.productionIds.length}개</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="widget" aria-labelledby="h-hpub">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-hpub">
                  게시
                </h2>
              </div>
              <div className="widget-body" style={{ padding: 14, display: 'grid', gap: 10 }}>
                <dl className="kv" style={{ fontSize: 13 }}>
                  <dt>마지막 저장</dt>
                  <dd>
                    {view.updatedBy ?? '—'} · {view.updatedAt?.slice(0, 10) ?? '—'}
                  </dd>
                  <dt>게시할 배너</dt>
                  <dd>
                    {view.banners.filter((b) => b.status === '게시 중').length} · 예정 {view.banners.filter((b) => b.status === '예정').length}
                  </dd>
                  <dt>게시할 테마</dt>
                  <dd>
                    {view.themes.filter((t) => t.status === '게시 중').length} · 예정 {view.themes.filter((t) => t.status === '예정').length}
                  </dd>
                </dl>
                <label className="field">
                  <span className="label">게시 사유 (필수)</span>
                  <textarea className="textarea" name="home-reason" value={reason} maxLength={500} onChange={(e) => onReason(e.target.value)} aria-describedby="home-publish-why" />
                </label>
                <p className="hint" id="home-publish-why">
                  {why ?? '게시하면 1분 안에 홈에 반영됩니다 [가정]. 게시와 변경은 감사 로그에 남습니다.'}
                </p>
                <button
                  className="btn btn-primary btn-block"
                  type="button"
                  aria-disabled={input ? undefined : 'true'}
                  aria-describedby="home-publish-why"
                  onClick={() => {
                    if (input && !busy) onPublish();
                  }}
                >
                  홈에 게시하기
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
