// 1단계 기본 정보(보드 SCR-021-d·t·xl s1). 배치: 태블릿 1열 · lg 6+6열(오른쪽에 이미지·전산망) · xl 세 칸.
import { MediaUploader, type MediaItem } from '@peaket/ds/MediaUploader';
import { RichTextEditor } from '@peaket/ds/RichTextEditor';
import { artists } from '@/entities/artist';
import { venues } from '@/entities/venue';
import { draft, GENRES, kopisRows, media } from '../model/fixtures';
import { SearchCombo } from './parts/SearchCombo';

const KOPIS_BADGE = { 입력됨: 'badge badge-success', '입력 필요': 'badge badge-warning', 자동: 'badge', '비어 있음': 'badge' } as const;

export function StepBasic({ imageError }: { imageError: boolean }) {
  const items: MediaItem[] = [
    {
      id: media.poster.id,
      fileName: media.poster.fileName,
      status: 'done',
      alt: media.poster.alt,
      preview: (
        <span className="poster poster-lumen poster-sm" style={{ width: 52 }} role="img" aria-label={`${media.poster.fileName} 미리보기`}>
          <span className="poster-title">LUMEN</span>
        </span>
      ),
    },
    { id: media.detail.id, fileName: media.detail.fileName, status: 'uploading', progress: media.detail.progress },
    ...(imageError ? [{ id: media.rejected.id, fileName: media.rejected.fileName, status: 'error' as const, error: media.rejected.error }] : []),
  ];

  return (
    <div className="grid items-start gap-5 lg:grid-cols-12 xl:grid-cols-3 xl:gap-6">
      <section className="card pad-lg col lg:col-span-6 xl:col-span-1" style={{ gap: 16 }} aria-labelledby="h-basic">
        <div className="section-title">
          <h2 id="h-basic">기본 정보</h2>
        </div>
        <div className="grid grid-cols-2" style={{ gap: 16 }}>
          <div className="field col-span-2">
            <label className="label" htmlFor="w-title">
              공연명 <span className="opt">(필수)</span>
            </label>
            <input className="input" id="w-title" type="text" defaultValue={draft.title} />
          </div>
          <div className="field col-span-2">
            <label className="label" htmlFor="w-venue">
              공연장 <span className="opt">(필수)</span>
            </label>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <SearchCombo
                className="grow"
                inputId="w-venue"
                options={venues.map((v) => v.name)}
                defaultValue={draft.venueName}
                placeholder="공연장 찾기"
                describedBy="w-venue-h"
                listLabel="공연장 후보"
              />
              <button className="btn btn-outline" type="button" style={{ minHeight: 48 }}>
                새 공연장 요청
              </button>
            </div>
            <span className="hint" id="w-venue-h">
              공연예술통합전산망으로 보내는 항목입니다
            </span>
          </div>
          <div className="field max-lg:col-span-2">
            <label className="label" htmlFor="w-artist">
              아티스트 <span className="opt">(필수)</span>
            </label>
            <SearchCombo inputId="w-artist" options={artists.map((a) => a.name)} defaultValue={draft.artistName} placeholder="아티스트 찾기" listLabel="아티스트 후보" />
            <button className="btn btn-text" type="button" style={{ alignSelf: 'flex-start' }}>
              <i className="ic ic-plus" aria-hidden="true" />새 이름
            </button>
          </div>
          <div className="field max-lg:col-span-2">
            <label className="label" htmlFor="w-genre">
              장르 <span className="opt">(필수)</span>
            </label>
            <div className="input-group">
              <select id="w-genre" defaultValue={draft.genre}>
                {GENRES.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="w-age">
              관람 연령 <span className="opt">(필수)</span>
            </label>
            <input className="input" id="w-age" type="text" placeholder="예: 만 7세 이상" defaultValue="" />
          </div>
          <div className="field">
            <label className="label" htmlFor="w-run">
              러닝타임 <span className="opt">(필수)</span>
            </label>
            <div className="input-group">
              <input id="w-run" type="text" inputMode="numeric" defaultValue={draft.runtimeMin} />
              <span className="t-sm muted">분</span>
            </div>
          </div>
          <div className="field col-span-2">
            <label className="label" htmlFor="w-prod">
              기획사·제작사 <span className="opt">(필수)</span>
            </label>
            <input className="input" id="w-prod" type="text" defaultValue={draft.producer} aria-describedby="w-prod-h" />
            <span className="hint" id="w-prod-h">
              공연예술통합전산망으로 보내는 항목입니다
            </span>
          </div>
          <div className="field col-span-2">
            <label className="label" htmlFor="w-alias">
              다른 이름(영문 표기 등) <span className="opt">(선택)</span>
            </label>
            <ul className="col" style={{ gap: 6 }} aria-label={`적은 다른 이름 ${draft.aliases.length}개`}>
              {draft.aliases.map((a) => (
                <li key={a} className="row" style={{ gap: 8, padding: '4px 4px 4px 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-muted)' }}>
                  <span className="t-sm grow">{a}</span>
                  <button className="btn btn-ghost btn-sm" type="button" aria-label={`다른 이름 ${a} 지우기`}>
                    지우기
                  </button>
                </li>
              ))}
            </ul>
            <div className="row" style={{ gap: 8 }}>
              <input className="input grow" id="w-alias" type="text" placeholder="다른 이름 더하기" aria-describedby="w-alias-h" defaultValue="" />
              <button className="btn btn-outline" type="button" style={{ minHeight: 48 }}>
                더하기
              </button>
            </div>
            <span className="hint" id="w-alias-h">
              {draft.aliasMax}개까지 · 검색에만 쓰입니다({draft.aliases.length}/{draft.aliasMax})
            </span>
          </div>
        </div>
        <div className="field">
          <span className="label" id="w-desc-l">
            공연 설명 <span className="opt">(선택)</span>
          </span>
          <RichTextEditor
            id="w-desc"
            labelledBy="w-desc-l"
            toolbarLabel="공연 설명 서식"
            hint="저장할 때 허용한 서식만 남기고 나머지는 지웁니다"
            counter={draft.descriptionCounter}
          >
            <p>
              <strong>LUMEN</strong>이 서울에서 여는 첫 단독 공연입니다. 대표곡과 새 앨범 수록곡을 밴드 편성으로 들려 드립니다.
            </p>
            <ul style={{ listStyle: 'disc', paddingLeft: 20 }}>
              <li>공연 시간: 약 120분</li>
              <li>공연장: 피켓 아레나</li>
            </ul>
          </RichTextEditor>
        </div>
        <div className="field">
          <label className="label" htmlFor="w-notice">
            안내 사항 <span className="opt">(선택)</span>
          </label>
          <textarea
            className="textarea"
            id="w-notice"
            placeholder="예: 촬영 가능 여부, 늦게 도착했을 때의 입장 안내"
            style={{ minHeight: 88 }}
            aria-describedby="w-notice-h"
          />
          <span className="hint" id="w-notice-h">
            공연예술통합전산망으로 보내는 항목입니다
          </span>
        </div>
      </section>

      <div className="col gap-5 lg:col-span-6 xl:contents">
        <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="h-media">
          <div className="section-title">
            <h2 id="h-media">포스터·상세 이미지</h2>
            <span className="t-sm muted">{items.length}장</span>
          </div>
          {imageError ? (
            <div className="error-summary" role="alert" aria-labelledby="w-media-err">
              <strong className="row" id="w-media-err" style={{ gap: 6 }}>
                <i className="ic ic-alert-circle tx-danger" aria-hidden="true" />
                이미지 1장이 기준에 맞지 않아 올리지 못했습니다
              </strong>
              <span>
                {media.rejected.fileName}: {media.rejected.error}
              </span>
            </div>
          ) : null}
          <MediaUploader items={items} />
        </section>

        <section className="card pad-lg col" style={{ gap: 12 }} aria-labelledby="h-kopis">
          <div className="col" style={{ gap: 4 }}>
            <div className="section-title">
              <h2 id="h-kopis">공연예술통합전산망 10개 항목 확인</h2>
            </div>
            <p className="t-sm muted">공연법 시행규칙 §2의 항목을 1일 단위로 보냅니다</p>
          </div>
          <div className="table-wrap">
            <table className="table dense" style={{ tableLayout: 'fixed' }}>
              <caption className="sr-only">공연예술통합전산망으로 보내는 10개 항목과 채우는 곳, 입력 상태</caption>
              <thead>
                <tr>
                  <th scope="col" style={{ width: '36%' }}>
                    항목
                  </th>
                  <th scope="col" style={{ width: '40%' }}>
                    채우는 곳
                  </th>
                  <th scope="col" style={{ width: '24%' }}>
                    상태
                  </th>
                </tr>
              </thead>
              <tbody>
                {kopisRows.map((r) => (
                  <tr key={r.item}>
                    <td>{r.item}</td>
                    <td className="muted">{r.source}</td>
                    <td>
                      <span className={KOPIS_BADGE[r.status]}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
