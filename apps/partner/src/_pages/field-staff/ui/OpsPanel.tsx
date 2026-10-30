// [현장 운영] 하위 탭(보드 SCR-037 isOpsTab, d5 §6.11): 공연 당일 파트너 사무실에서 입장 현장을 보는 화면.
// 순서: 설명 → 시간 띠 → 요약 타일 4개 → 동기화 경보 → 준비 점검 → 기기 배치 → 기기 준비 → 구역별 입장 → 사유별 건수 → 이상 표시 → 입장 기록 마감.
// 데스크톱: 배치 5 · 준비 7, 아래는 입장·사유 4 · 이상 표시·마감 8 / 태블릿: 한 열, 입장·사유 2열, 표는 가로 스크롤 상자 / 휴대폰: 한 열, 표는 카드 목록.
import { StatTile } from '@peaket/ds/StatTile';
import {
  FLAG_BADGE,
  placements,
  REJECT_REASONS,
  zoneSummary,
  type DeviceReadiness,
  type Flag,
  type OpsData,
  type OpsMode,
  type ZoneEntry,
} from '../model/fixtures';
import { placementDialogId } from './Dialogs';

/** 데스크톱·휴대폰은 카드 상자, 태블릿은 머리글이 상자 밖(보드 SCR-037-t) */
const CARD_NOT_MD = 'card md:max-lg:overflow-visible md:max-lg:rounded-none md:max-lg:border-0 md:max-lg:bg-transparent';
/** 데스크톱만 카드 상자(보드 SCR-037-d), 태블릿·휴대폰은 머리글 아래 표·목록 */
const CARD_LG_ONLY = 'card max-lg:overflow-visible max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent';
/** 휴대폰 타일은 조금 작게(보드 SCR-037-m .stat padding 12/14 · 값 22px) */
const TILES_M = 'max-md:[&_.stat]:px-3.5 max-md:[&_.stat]:py-3 max-md:[&_.stat-value]:text-[22px] max-md:[&_.stat-value]:leading-7';

export interface OpsPanelProps {
  mode: OpsMode;
  data: OpsData;
}

export function OpsPanel({ mode, data }: OpsPanelProps) {
  const live = mode === 'live';
  return (
    <>
      <p className="t-md">
        공연 당일 입장 현장을 실시간으로 봅니다. 스캐너 배치를 바꾸고, 기기 준비와 이상 표시를 확인합니다. 관람객 이름과 연락처는 보이지 않습니다.
      </p>

      <TimeStrip now={data.now} />

      <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${TILES_M}`}>
        {data.tiles.map((k) => (
          <StatTile
            key={k.label}
            label={k.label}
            value={
              <>
                <span className={k.muted ? 'muted' : undefined}>{k.value}</span>
                {k.sub ? <span className="t-md muted fw-m max-md:text-sm">{k.sub}</span> : null}
              </>
            }
            meta={k.meta}
          />
        ))}
      </div>

      {live && (
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">동기화 경보</span>
            동문-03 동기화 3분 넘음(2분 넘으면 경보) · 마지막 동기화 17:08:40 KST · 업로드 대기 12건
          </div>
        </div>
      )}

      <Readiness pre={mode === 'pre'} />

      <div className="grid-12 max-lg:flex max-lg:flex-col max-lg:gap-4" style={{ rowGap: 16, alignItems: 'start' }}>
        <Placements />
        <Devices devices={data.devices} warn={live} />
      </div>

      <div className="grid-12 max-lg:flex max-lg:flex-col max-lg:gap-4" style={{ rowGap: 16, alignItems: 'start' }}>
        <div className="span-4 grid items-start gap-4 md:max-lg:grid-cols-2">
          <Zones zones={data.zones} />
          <Rejects counts={data.rejects} />
        </div>
        <div className="span-8 col" style={{ gap: 16 }}>
          <Flags flags={data.flags} at={data.flagAt} />
          <CloseCard closed={mode === 'closed'} counts={data.close} />
        </div>
      </div>
    </>
  );
}

/* ---------- 시간 띠 ---------- */

function TimeStrip({ now }: { now: string | null }) {
  const closed = now === null;
  return (
    <>
      {/* 태블릿·데스크톱: 한 줄 */}
      <p className="card row wrap t-sm max-md:hidden" style={{ gap: '6px 12px', padding: '10px 16px' }}>
        <span>
          <span className="muted">입장 시작</span> <span className="fw-b num">16:30</span>
        </span>
        <span className="muted" aria-hidden="true">
          ·
        </span>
        {!closed && (
          <>
            <span className="badge badge-primary badge-lg">
              <i className="ic ic-clock" aria-hidden="true" />
              지금 {now}
            </span>
            <span className="muted" aria-hidden="true">
              ·
            </span>
          </>
        )}
        <span>
          <span className="muted">공연 시작</span> <span className="fw-b num">18:00</span>
        </span>
        <span className="muted" aria-hidden="true">
          ·
        </span>
        {closed ? (
          <span className="badge badge-success badge-lg">
            <i className="ic ic-check" aria-hidden="true" />
            입장 기록 마감 23:12 KST
          </span>
        ) : (
          <span>
            <span className="muted">입장 기록 마감 예정</span> <span className="fw-b num">23:00</span>
          </span>
        )}
      </p>
      {/* 휴대폰: 2열 격자 */}
      <div className="card md:hidden" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '10px 12px', padding: '12px 14px' }}>
        <span className="col" style={{ gap: 2 }}>
          <span className="t-xs muted">입장 시작</span>
          <span className="t-sm fw-b num">16:30</span>
        </span>
        {!closed && (
          <span className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
            <span className="t-xs muted">지금</span>
            <span className="badge badge-primary">
              <i className="ic ic-clock" aria-hidden="true" />
              {now}
            </span>
          </span>
        )}
        <span className="col" style={{ gap: 2 }}>
          <span className="t-xs muted">공연 시작</span>
          <span className="t-sm fw-b num">18:00</span>
        </span>
        {closed ? (
          <span className="col" style={{ gap: 2, alignItems: 'flex-start', gridColumn: '1/-1' }}>
            <span className="t-xs muted">입장 기록 마감</span>
            <span className="badge badge-success">
              <i className="ic ic-check" aria-hidden="true" />
              23:12 KST
            </span>
          </span>
        ) : (
          <span className="col" style={{ gap: 2 }}>
            <span className="t-xs muted">입장 기록 마감 예정</span>
            <span className="t-sm fw-b num">23:00</span>
          </span>
        )}
      </div>
    </>
  );
}

/* ---------- 준비 점검 ---------- */

function Readiness({ pre }: { pre: boolean }) {
  const sfx = pre ? '-p' : '';
  return (
    <section className="card pad col gap-3 md:gap-2.5" aria-labelledby="rd-h">
      <div className="row between wrap max-md:flex-col max-md:items-start" style={{ gap: '6px 8px' }}>
        <h3 className="t-md fw-b" id="rd-h">
          준비 점검(입장 30분 전 [가정])
        </h3>
        {pre ? (
          <span className="badge badge-warning">점검 전</span>
        ) : (
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            16:00 KST 점검 완료
          </span>
        )}
      </div>
      <div className="row wrap gap-y-2.5 gap-x-7 max-md:flex-col max-md:items-start max-md:gap-3">
        <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <i className="ic ic-check-circle tx-success" aria-hidden="true" />
          <span className="t-sm">
            모든 기기 준비 <span className="muted num">6/6대 · 스캐너 근무 준비 보고 기준</span>
          </span>
        </span>
        <label className="check-row" htmlFor={`rd-spare${sfx}`}>
          <input className="cb" id={`rd-spare${sfx}`} type="checkbox" defaultChecked={!pre} />
          예비 기기 로그인·목록 받기
        </label>
        <label className="check-row" htmlFor={`rd-booth${sfx}`}>
          <input className="cb" id={`rd-booth${sfx}`} type="checkbox" defaultChecked={!pre} />
          부스 회선 확인
        </label>
      </div>
    </section>
  );
}

/* ---------- 기기 배치 ---------- */

function PlaceButton({ index, device }: { index: number; device: string }) {
  return (
    <button
      className="btn btn-outline btn-sm"
      type="button"
      aria-haspopup="dialog"
      data-modal-open={placementDialogId(index)}
      aria-label={`${device} 배치 바꾸기`}
    >
      배치 바꾸기
    </button>
  );
}

function Placements() {
  return (
    <section className={`span-5 ${CARD_NOT_MD} col overflow-hidden md:max-lg:gap-2.5`} aria-labelledby="pl-h">
      <div className="col px-4 pb-3 pt-4 md:max-lg:p-0 lg:px-5 lg:py-4" style={{ gap: 8 }}>
        <div className="row between wrap" style={{ gap: 8 }}>
          <h3 className="t-md fw-b" id="pl-h">
            기기 배치
          </h3>
          <span className="badge">재입장 불허 회차</span>
        </div>
        <ul className="col gap-1 md:max-lg:flex-row md:max-lg:flex-wrap md:max-lg:gap-x-6 lg:gap-0.5">
          {zoneSummary.map((z) => (
            <li key={z.zone} className="t-sm">
              <span className="fw-b">{z.zone}</span> {z.tickets} · {z.recommend} · {z.placed}
            </li>
          ))}
        </ul>
      </div>

      {/* 태블릿·데스크톱: 표 */}
      <div className="table-wrap table-scroll max-md:hidden lg:rounded-none lg:border-0" role="region" aria-label="기기 배치 표" tabIndex={0}>
        <table className="table dense md:max-lg:min-w-[520px]">
          <caption className="sr-only">기기 배치(게이트 구역·모드)와 배치 바꾸기</caption>
          <thead>
            <tr>
              <th scope="col">기기</th>
              <th scope="col">구역</th>
              <th scope="col">모드</th>
              <th scope="col">
                <span className="sr-only">배치 바꾸기</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {placements.map((p, i) => (
              <tr key={p.device}>
                <td className="fw-b">{p.device}</td>
                <td className={p.zone ? undefined : 'muted'}>{p.zone ?? '배치 안 함'}</td>
                <td className={p.mode ? undefined : 'muted'}>{p.mode ?? '—'}</td>
                <td className="r">
                  <PlaceButton index={i} device={p.device} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 휴대폰: 기기 줄 목록 */}
      <div
        className="row t-xs muted fw-b md:hidden"
        style={{ gap: 8, padding: '8px 16px', background: 'var(--surface-muted)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}
        aria-hidden="true"
      >
        <span style={{ width: 56, flex: 'none' }}>기기</span>
        <span className="grow">구역 · 모드</span>
      </div>
      <ul className="col md:hidden" aria-label="기기별 구역과 모드">
        {placements.map((p, i) => (
          <li key={p.device} className="row" style={{ gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <span className="t-sm fw-b" style={{ width: 56, flex: 'none' }}>
              {p.device}
            </span>
            <span className={p.zone ? 't-sm grow' : 't-sm grow muted'}>{p.zone ? `${p.zone} · ${p.mode ?? '입장'}` : '배치 안 함'}</span>
            <PlaceButton index={i} device={p.device} />
          </li>
        ))}
      </ul>

      <p className="t-xs muted px-4 pb-3.5 pt-2.5 md:max-lg:p-0 lg:px-5 lg:py-2.5" id="pl-hint">
        재입장 불허 회차에서는 퇴장 모드를 쓸 수 없습니다
      </p>
    </section>
  );
}

/* ---------- 기기 준비 상태 ---------- */

function DeviceBadge({ d, warn }: { d: DeviceReadiness; warn: boolean }) {
  return (
    <span className={d.badge}>
      {warn && d.warn ? <i className="ic ic-alert" aria-hidden="true" /> : null}
      {d.label}
    </span>
  );
}

function Devices({ devices, warn }: { devices: readonly DeviceReadiness[]; warn: boolean }) {
  const hint =
    "미보고: 이 회차에서 아직 아무것도 보고하지 않은 기기입니다. 입장 기록 마감 때까지 업로드를 마쳤다고 보고하지 않은 기기는 CS 처리함에 '미보고 스캐너'로 올라갑니다.";
  return (
    <section className={`span-7 ${CARD_LG_ONLY} col gap-2.5 lg:gap-0 lg:overflow-hidden`} aria-labelledby="dv-h">
      <div className="row between wrap max-md:flex-col max-md:items-start gap-x-3 gap-y-1 max-md:gap-0.5 lg:gap-2 lg:px-5 lg:py-4">
        <h3 className="t-md fw-b" id="dv-h">
          기기 준비 상태
        </h3>
        <span className="t-xs muted">스태프 근무 10/25(일) 13:30 KST부터</span>
      </div>

      <div className="table-wrap table-scroll max-md:hidden lg:rounded-none lg:border-0" role="region" aria-label="기기 준비 상태 표" tabIndex={0}>
        <table className="table dense md:max-lg:min-w-[680px]">
          <caption className="sr-only">기기 준비 상태(로그인·목록 일련번호·마지막 동기화·업로드 대기)</caption>
          <thead>
            <tr>
              <th scope="col">기기</th>
              <th scope="col">로그인</th>
              <th scope="col">목록 일련번호</th>
              <th scope="col">마지막 동기화</th>
              <th scope="col" className="r">
                업로드 대기
              </th>
              <th scope="col">상태</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) =>
              d.login === null ? (
                <tr key={d.device}>
                  <td className="fw-b">{d.device}</td>
                  <td className="muted">—</td>
                  <td className="muted">—</td>
                  <td className="muted">—</td>
                  <td className="r muted">—</td>
                  <td>
                    <DeviceBadge d={d} warn={warn} />
                  </td>
                </tr>
              ) : (
                <tr key={d.device}>
                  <td className="fw-b">{d.device}</td>
                  <td>{d.login}</td>
                  <td className="mono">{d.serial}</td>
                  <td className="num">
                    {d.sync}
                    {d.ago ? <span className="t-xs muted">{d.ago}</span> : null}
                  </td>
                  <td className={d.queueBold ? 'r fw-b' : 'r'}>{d.queue}</td>
                  <td>
                    <DeviceBadge d={d} warn={warn} />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      <ul className="col md:hidden" style={{ gap: 8 }} aria-label="기기 준비 상태(로그인·목록 일련번호·마지막 동기화·업로드 대기)">
        {devices.map((d) => (
          <li key={d.device} className="card col" style={{ padding: '12px 14px', gap: 4 }}>
            <div className="row between" style={{ gap: 8 }}>
              <span className="fw-b">{d.device}</span>
              <DeviceBadge d={d} warn={warn} />
            </div>
            {d.login === null ? (
              <>
                <p className="t-xs muted">로그인 — · 목록 일련번호 —</p>
                <p className="t-xs muted">마지막 동기화 — · 업로드 대기 —</p>
              </>
            ) : (
              <>
                <p className="t-xs">
                  {d.login}
                  <span className="muted"> · 목록 일련번호 </span>
                  <span className="mono">{d.serial}</span>
                </p>
                <p className="t-xs">
                  <span className="muted">마지막 동기화 </span>
                  <span className="num">{d.sync}</span>
                  <span className="muted">{d.ago ?? ''} · 업로드 대기 </span>
                  <span className={d.queueBold ? 'num fw-b' : 'num'}>{d.queue}</span>
                </p>
              </>
            )}
          </li>
        ))}
      </ul>

      <p className="t-xs muted lg:px-5 lg:py-2.5">{hint}</p>
    </section>
  );
}

/* ---------- 구역별 입장 수 · 사유별 건수 ---------- */

function ZoneTile({ z }: { z: ZoneEntry }) {
  return (
    <div className="stat">
      <span className="stat-label">{z.zone} 입장</span>
      <span className="stat-value">{z.count}</span>
      <div
        className="progress"
        role="progressbar"
        aria-label={`${z.zone} 입장 비율`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={z.now}
        aria-valuetext={z.text}
      >
        <span style={{ width: `${z.bar}%` }} />
      </div>
      <span className="stat-meta">{z.meta}</span>
    </div>
  );
}

function Zones({ zones }: { zones: readonly [ZoneEntry, ZoneEntry] }) {
  return (
    <section className="col" style={{ gap: 10 }} aria-labelledby="en-h">
      <h3 className="t-md fw-b" id="en-h">
        구역별 입장 수
      </h3>
      <div className={`grid grid-cols-2 gap-3 ${TILES_M}`}>
        {zones.map((z) => (
          <ZoneTile key={z.zone} z={z} />
        ))}
      </div>
    </section>
  );
}

function Rejects({ counts }: { counts: readonly string[] }) {
  return (
    <section className="col" style={{ gap: 10 }} aria-labelledby="rj-h">
      <h3 className="t-md fw-b" id="rj-h">
        거부·확인 필요 사유
      </h3>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table dense">
          <caption className="sr-only">거부·확인 필요 사유별 판정과 건수</caption>
          <thead>
            <tr>
              <th scope="col">사유</th>
              <th scope="col">판정</th>
              <th scope="col" className="r">
                건수
              </th>
            </tr>
          </thead>
          <tbody>
            {REJECT_REASONS.map((r, i) => (
              <tr key={r.reason}>
                <td>{r.reason}</td>
                <td>{r.verdict}</td>
                <td className="r num">{counts[i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ---------- 이상 표시 ---------- */

function Flags({ flags, at }: { flags: readonly Flag[]; at: string }) {
  return (
    <section className={`${CARD_LG_ONLY} col gap-2.5 lg:gap-0 lg:overflow-hidden`} aria-labelledby="fl-h">
      <div className="row between wrap max-md:flex-col max-md:items-start gap-x-3 gap-y-1 max-md:gap-0.5 lg:gap-2 lg:px-5 lg:py-4">
        <h3 className="t-md fw-b" id="fl-h">
          이상 표시
        </h3>
        <span className="t-xs muted">
          10초 [가정]마다 갱신 · {at}
        </span>
      </div>
      {flags.length === 0 ? (
        <div className="card lg:rounded-none lg:border-x-0 lg:border-b-0 lg:bg-transparent">
          <div className="state" style={{ padding: '28px 20px' }}>
            <span className="state-icon is-success">
              <i className="ic ic-check-circle" aria-hidden="true" />
            </span>
            <h4 className="t-md fw-b">이상 표시가 없습니다</h4>
          </div>
        </div>
      ) : (
        <>
          <div className="table-wrap table-scroll max-md:hidden lg:rounded-none lg:border-0" role="region" aria-label="이상 표시 표" tabIndex={0}>
            <table className="table dense md:max-lg:min-w-[600px]">
              <caption className="sr-only">이상 표시 목록(좌석·종류·시각·처리 결과)</caption>
              <thead>
                <tr>
                  <th scope="col">좌석</th>
                  <th scope="col">종류</th>
                  <th scope="col">시각</th>
                  <th scope="col">처리 결과</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr key={`${f.seat}-${f.at}`}>
                    <td>{f.seat}</td>
                    <td>{f.kind}</td>
                    <td className="num">{f.at}</td>
                    <td>
                      <span className={FLAG_BADGE[f.result]}>{f.result}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="col md:hidden" style={{ gap: 8 }} aria-label="이상 표시 목록(좌석·종류·시각·처리 결과)">
            {flags.map((f) => (
              <li key={`${f.seat}-${f.at}`} className="card col" style={{ padding: '12px 14px', gap: 4 }}>
                <div className="row between" style={{ gap: 8 }}>
                  <span className="t-sm fw-b">{f.seat}</span>
                  <span className={FLAG_BADGE[f.result]}>{f.result}</span>
                </div>
                <p className="t-sm">{f.kind}</p>
                <p className="t-xs muted num">{f.at}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="t-xs muted lg:px-5 lg:py-2.5">
        처리(정상 확인·부정 의심·판단 불가)는 그 구역 현장 책임자가 스캐너의 현장 관리에서 기록하고, 파트너 콘솔은 읽기만 합니다. 퇴장 기록 없음은 재입장 허용
        회차에서, 마감 뒤 도착은 입장 기록 마감 뒤에 생깁니다.
      </p>
    </section>
  );
}

/* ---------- 입장 기록 마감 ---------- */

function CloseCard({ closed, counts }: { closed: boolean; counts: readonly [string, string, string] }) {
  return (
    <section className="card col p-4 lg:p-6" style={{ gap: 10 }} aria-labelledby="cl-h">
      <div className="row between">
        <h3 className="t-md fw-b" id="cl-h">
          입장 기록 마감
        </h3>
        {closed ? (
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            마감 23:12
          </span>
        ) : (
          <span className="badge">대기</span>
        )}
      </div>
      <p className="t-sm muted">스태프 권한이 끝나는 22:00 KST 뒤 모든 기기가 업로드를 마쳤다고 보고하면 바로, 아니면 24시간 [가정] 안에 마감합니다.</p>
      <dl className="kv">
        <dt>미처리 이상 표시</dt>
        <dd>{counts[0]}</dd>
        <dt>예외 통과</dt>
        <dd>{counts[1]}</dd>
        <dt>부스 재발급</dt>
        <dd>{counts[2]}</dd>
        <dt>미보고 스캐너</dt>
        <dd>1대(서문-03)</dd>
      </dl>
    </section>
  );
}
