// 1단계 기본 정보(실제 입력, ADR-0245). 배치는 퍼블리싱 화면(StepBasic)과 같다. 공연 설명은 HOT-185, 이미지는 HOT-190이 잇는다.
import { useState, type KeyboardEvent } from 'react';
import { GENRES, kopisRows } from '../../model/fixtures';
import { ALIAS_MAX, ARTIST_MAX, kopisStatus, type PlaceChoice } from '../../model/form';
import { searchArtists, searchPlaces, type NameHit } from '../../model/wizard-api';
import { NameSearch } from '../parts/NameSearch';
import { errorAttrs, FieldLabel, FieldMessage, TextField, type StepProps } from './fields';

const KOPIS_BADGE = { 입력됨: 'badge badge-success', '입력 필요': 'badge badge-warning', 자동: 'badge', '비어 있음': 'badge' } as const;
const CHIP_STYLE = { gap: 8, padding: '4px 4px 4px 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-muted)' } as const;

/** 한글 조합을 끝내는 Enter를 빼고 Enter면 부른다 */
function onEnter(run: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    run();
  };
}

function PlaceField({ draft, update, errorOf, onApiError }: StepProps & { onApiError: (e: unknown) => void }) {
  // 사용자가 누른 버튼이 사라질 때만 다음 칸으로 초점을 옮긴다(처음 그릴 때는 옮기지 않는다)
  const [touched, setTouched] = useState(false);
  const error = errorOf('place');
  const set = (place: PlaceChoice | null) => {
    setTouched(true);
    update({ place }, 'place');
  };
  const place = draft.place;
  return (
    <div className="field col-span-2">
      <FieldLabel htmlFor="w-venue" required>
        공연장
      </FieldLabel>
      {/* 줄마다 key를 달아 버튼을 다시 쓰지 않게 한다(다시 쓰면 autoFocus가 걸리지 않는다) */}
      {place?.kind === 'picked' ? (
        <div key="picked" className="row" style={CHIP_STYLE}>
          <span className="t-sm grow" id="w-venue" tabIndex={-1}>
            {place.name}
          </span>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- 공연장을 고른 뒤에만 켠다. 입력 칸이 사라져 초점을 옮겨야 한다 */}
          <button className="btn btn-ghost btn-sm" type="button" autoFocus={touched} aria-label={`공연장 ${place.name} 바꾸기`} onClick={() => set(null)}>
            바꾸기
          </button>
        </div>
      ) : place?.kind === 'new' ? (
        <div key="new" className="col" style={{ gap: 8 }}>
          <input
            className={error ? 'input is-error' : 'input'}
            id="w-venue"
            type="text"
            placeholder="새 공연장 이름"
            aria-label="새 공연장 이름"
            value={place.name}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- '새 공연장 요청'을 누른 뒤에만 켠다. 누른 버튼이 사라져 초점을 옮겨야 한다
            autoFocus={touched}
            onChange={(e) => update({ place: { ...place, name: e.target.value } }, 'place')}
            {...errorAttrs('w-venue', error)}
          />
          <input
            className={error ? 'input is-error' : 'input'}
            type="text"
            placeholder="도로명 주소"
            aria-label="새 공연장 도로명 주소"
            value={place.address}
            onChange={(e) => update({ place: { ...place, address: e.target.value } }, 'place')}
            {...errorAttrs('w-venue', error)}
          />
          <button className="btn btn-text" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => set(null)}>
            목록에서 찾기
          </button>
        </div>
      ) : (
        <div key="search" className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <NameSearch
            inputId="w-venue"
            placeholder="공연장 찾기"
            listLabel="공연장 후보"
            emptyText="찾는 공연장이 없으면 새 공연장을 요청해 주세요"
            describedBy={[error ? 'w-venue-e' : undefined, 'w-venue-h'].filter(Boolean).join(' ')}
            invalid={!!error}
            autoFocus={touched}
            search={searchPlaces}
            onError={onApiError}
            onPick={(h: NameHit) => set({ kind: 'picked', id: h.id, name: h.name })}
          />
          <button className="btn btn-outline" type="button" style={{ minHeight: 48 }} onClick={() => set({ kind: 'new', name: '', address: '' })}>
            새 공연장 요청
          </button>
        </div>
      )}
      <FieldMessage id="w-venue" error={error} />
      <span className="hint" id="w-venue-h">
        공연예술통합전산망으로 보내는 항목입니다
      </span>
    </div>
  );
}

function ArtistField({ draft, update, errorOf, onApiError }: StepProps & { onApiError: (e: unknown) => void }) {
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const error = errorOf('artists');
  const full = draft.artists.length >= ARTIST_MAX;

  function addNew() {
    const name = newName.trim();
    if (name === '' || full || draft.artists.some((a) => !a.artistId && a.name.trim() === name)) return;
    update({ artists: [...draft.artists, { name }] }, 'artists');
    setNewName('');
  }

  return (
    <div className="field max-lg:col-span-2">
      <FieldLabel htmlFor="w-artist" required>
        아티스트
      </FieldLabel>
      {draft.artists.length > 0 ? (
        <ul className="col" style={{ gap: 6 }} aria-label={`더한 아티스트 ${draft.artists.length}명`}>
          {draft.artists.map((a, i) => (
            <li key={a.artistId ?? `new-${a.name}`} className="row" style={CHIP_STYLE}>
              <span className="t-sm grow">
                {a.name}
                {a.artistId ? null : <span className="t-xs muted"> (새 이름)</span>}
              </span>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                aria-label={`아티스트 ${a.name} 지우기`}
                onClick={() => {
                  update({ artists: draft.artists.filter((_, n) => n !== i) }, 'artists');
                  document.getElementById('w-artist')?.focus();
                }}
              >
                지우기
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <NameSearch
        inputId="w-artist"
        placeholder="아티스트 찾기"
        listLabel="아티스트 후보"
        emptyText="찾는 이름이 없으면 새 이름으로 더해 주세요"
        describedBy={error ? 'w-artist-e' : undefined}
        invalid={!!error}
        search={searchArtists}
        onError={onApiError}
        onPick={(h) => {
          if (!full && !draft.artists.some((a) => a.artistId === h.id)) update({ artists: [...draft.artists, { artistId: h.id, name: h.name }] }, 'artists');
        }}
      />
      {adding ? (
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input grow"
            type="text"
            placeholder="새 아티스트 이름"
            aria-label="새 아티스트 이름"
            value={newName}
            maxLength={100}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- '새 이름'을 누른 뒤에만 그려진다
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={onEnter(addNew)}
            onBlur={addNew}
            {...errorAttrs('w-artist', error)}
          />
          <button className="btn btn-outline" type="button" style={{ minHeight: 48 }} disabled={full} onClick={addNew}>
            더하기
          </button>
        </div>
      ) : (
        <button className="btn btn-text" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
          <i className="ic ic-plus" aria-hidden="true" />새 이름
        </button>
      )}
      <FieldMessage id="w-artist" error={error} />
    </div>
  );
}

function AliasField({ draft, update, errorOf }: StepProps) {
  const [value, setValue] = useState('');
  const error = errorOf('aliases');
  const full = draft.aliases.length >= ALIAS_MAX;

  function add() {
    const name = value.trim();
    if (name === '' || full || draft.aliases.includes(name)) return;
    update({ aliases: [...draft.aliases, name] }, 'aliases');
    setValue('');
  }

  return (
    <div className="field col-span-2">
      <FieldLabel htmlFor="w-alias">다른 이름(영문 표기 등)</FieldLabel>
      {draft.aliases.length > 0 ? (
        <ul className="col" style={{ gap: 6 }} aria-label={`적은 다른 이름 ${draft.aliases.length}개`}>
          {draft.aliases.map((a) => (
            <li key={a} className="row" style={CHIP_STYLE}>
              <span className="t-sm grow">{a}</span>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                aria-label={`다른 이름 ${a} 지우기`}
                onClick={() => {
                  update({ aliases: draft.aliases.filter((x) => x !== a) }, 'aliases');
                  document.getElementById('w-alias')?.focus();
                }}
              >
                지우기
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row" style={{ gap: 8 }}>
        <input
          className={error ? 'input grow is-error' : 'input grow'}
          id="w-alias"
          type="text"
          placeholder="다른 이름 더하기"
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onEnter(add)}
          onBlur={add}
          {...errorAttrs('w-alias', error, 'w-alias-h')}
        />
        <button className="btn btn-outline" type="button" style={{ minHeight: 48 }} disabled={full} onClick={add}>
          더하기
        </button>
      </div>
      <span className="hint" id="w-alias-h">
        {ALIAS_MAX}개까지 · 검색에만 쓰입니다({draft.aliases.length}/{ALIAS_MAX})
      </span>
      <FieldMessage id="w-alias" error={error} />
    </div>
  );
}

export function LiveStepBasic(props: StepProps & { onApiError: (e: unknown) => void }) {
  const { draft, update, errorOf } = props;
  const status = kopisStatus(draft);
  const genreError = errorOf('genre');
  const noticeError = errorOf('notice');
  return (
    <div className="grid items-start gap-5 lg:grid-cols-12 xl:grid-cols-3 xl:gap-6">
      <section className="card pad-lg col lg:col-span-6 xl:col-span-2" style={{ gap: 16 }} aria-labelledby="h-basic">
        <div className="section-title">
          <h2 id="h-basic">기본 정보</h2>
        </div>
        <div className="grid grid-cols-2" style={{ gap: 16 }}>
          <TextField className="field col-span-2" id="w-title" label="공연명" required value={draft.title} error={errorOf('title')} onChange={(title) => update({ title }, 'title')} />
          <PlaceField {...props} />
          <ArtistField {...props} />
          <div className="field max-lg:col-span-2">
            <FieldLabel htmlFor="w-genre" required>
              장르
            </FieldLabel>
            <div className={genreError ? 'input-group is-error' : 'input-group'}>
              <select id="w-genre" value={draft.genre} onChange={(e) => update({ genre: e.target.value }, 'genre')} {...errorAttrs('w-genre', genreError)}>
                <option value="">장르 고르기</option>
                {GENRES.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </div>
            <FieldMessage id="w-genre" error={genreError} />
          </div>
          <TextField id="w-age" label="관람 연령" required placeholder="예: 만 7세 이상" value={draft.ageRating} error={errorOf('ageRating')} onChange={(ageRating) => update({ ageRating }, 'ageRating')} />
          <TextField id="w-run" label="러닝타임(분)" required inputMode="numeric" value={draft.runningMinutes} error={errorOf('runningMinutes')} onChange={(runningMinutes) => update({ runningMinutes }, 'runningMinutes')} />
          <TextField
            className="field col-span-2"
            id="w-prod"
            label="기획사·제작사"
            required
            hint="공연예술통합전산망으로 보내는 항목입니다"
            value={draft.producer}
            error={errorOf('producer')}
            onChange={(producer) => update({ producer }, 'producer')}
          />
          <AliasField {...props} />
        </div>
        <div className="field">
          <FieldLabel htmlFor="w-notice">안내 사항</FieldLabel>
          <textarea
            className={noticeError ? 'textarea is-error' : 'textarea'}
            id="w-notice"
            placeholder="예: 촬영 가능 여부, 늦게 도착했을 때의 입장 안내"
            style={{ minHeight: 88 }}
            value={draft.notice}
            onChange={(e) => update({ notice: e.target.value }, 'notice')}
            {...errorAttrs('w-notice', noticeError, 'w-notice-h')}
          />
          <span className="hint" id="w-notice-h">
            공연예술통합전산망으로 보내는 항목입니다
          </span>
          <FieldMessage id="w-notice" error={noticeError} />
        </div>
        <p className="hint">공연 설명과 포스터·상세 이미지는 아직 이 화면에서 입력할 수 없습니다. 판매 승인을 요청하기 전에 넣게 됩니다.</p>
      </section>

      <section className="card pad-lg col lg:col-span-6 xl:col-span-1" style={{ gap: 12 }} aria-labelledby="h-kopis">
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
              {kopisRows.map((r) => {
                const s = status[r.item] ?? r.status;
                return (
                  <tr key={r.item}>
                    <td>{r.item}</td>
                    <td className="muted">{r.source}</td>
                    <td>
                      <span className={KOPIS_BADGE[s]}>{s}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
