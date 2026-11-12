'use client';
// 템플릿으로 시작(ADR-0066, ADR-0264 결정 1·17, d5 §6.5): 공개된 10종 카드에서 고르고 변형·목표 좌석 수를 정한다.
// 만들기는 POST …/seatmap이고 서버가 구역 비율로 목표 수를 나눈다. 이미 좌석이 있으면 409면 지우고 다시 만들지 묻는다.
import { useEffect, useState } from 'react';
import { createSeatmapFromTemplate, getSeatmapTemplate, listSeatmapTemplates } from '../../model/seatmap-api';
import { LiveDialog } from './LiveDialog';

interface Variant {
  key: string;
  label: string;
  kind: 'CHOICE' | 'NUMBER' | 'BOOLEAN';
  options?: string[];
  min?: number;
  max?: number;
  defaultValue?: unknown;
}
interface Summary {
  templateId: string;
  code: string;
  name: string;
  family: string;
  defaultCapacity: number;
  levelCount: number;
  sectionCount: number;
  summary: string;
  variants: Variant[];
  schematicUrl: string;
  version: number;
}
interface Detail extends Summary {
  layout: unknown;
}

const valueOf = (v: Variant): string | number | boolean => {
  if (v.kind === 'BOOLEAN') return v.defaultValue === true;
  if (v.kind === 'NUMBER') return typeof v.defaultValue === 'number' ? v.defaultValue : (v.min ?? 0);
  return typeof v.defaultValue === 'string' ? v.defaultValue : (v.options?.[0] ?? '');
};

export function TemplatePicker({ productionId, onClose, onCreated }: { productionId: string; onClose: () => void; onCreated: (layout: unknown, etag: string | null) => void }) {
  const [items, setItems] = useState<Summary[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [variant, setVariant] = useState<Record<string, unknown>>({});
  const [target, setTarget] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  useEffect(() => {
    let live = true;
    void listSeatmapTemplates().then(
      (r) => {
        if (!live) return;
        const list = (r as { items?: Summary[] })?.items ?? [];
        setItems(list);
      },
      () => live && setItems([]),
    );
    return () => {
      live = false;
    };
  }, []);

  const pick = async (s: Summary) => {
    setBusy(true);
    setMessage(null);
    setConfirmReplace(false);
    try {
      const d = (await getSeatmapTemplate(s.templateId)) as Detail;
      setDetail(d);
      setTarget(d.defaultCapacity);
      setVariant(Object.fromEntries(d.variants.map((v) => [v.key, valueOf(v)])));
    } catch {
      setMessage('템플릿을 불러오지 못했습니다. 다시 골라 주세요');
    } finally {
      setBusy(false);
    }
  };

  const create = async (replace = false) => {
    if (!detail) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await createSeatmapFromTemplate(productionId, { templateId: detail.templateId, targetCapacity: target, variant, replace });
      onCreated(r.layout, r.etag);
      onClose();
    } catch (e) {
      const err = e as { status?: number; type?: string };
      if (err.status === 409 && String(err.type).includes('seatmap-replace-required') && !replace) setConfirmReplace(true);
      else if (err.status === 404) setMessage('템플릿 또는 공연을 찾을 수 없습니다');
      else if (err.status === 403) setMessage('판매 승인을 받은 공연의 좌석맵은 파트너 관리자만 만들 수 있습니다');
      else if (err.status === 422) setMessage('변형이나 목표 좌석 수를 확인해 주세요');
      else if (err.status === 409) setMessage('판매가 시작되어 좌석맵을 바꿀 수 없습니다');
      else setMessage('템플릿에서 만들지 못했습니다. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <LiveDialog id="template-picker" title="템플릿으로 시작" onClose={onClose} maxWidth={880}>
      <div className="col" style={{ gap: 12 }}>
        {items === null ? (
          <p className="t-sm muted" role="status">
            템플릿을 불러오는 중입니다
          </p>
        ) : items.length === 0 ? (
          <p className="t-sm muted" role="status">
            지금 쓸 수 있는 템플릿이 없습니다
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2" role="group" aria-label="좌석맵 템플릿">
            {items.map((s) => (
              <button key={s.templateId} className="card pad col" type="button" style={{ gap: 6, textAlign: 'left' }} aria-pressed={detail?.templateId === s.templateId} onClick={() => void pick(s)}>
                <img src={new URL(s.schematicUrl).pathname} alt={`${s.name} 개략도`} style={{ width: '100%', height: 110, objectFit: 'contain', background: '#f7f9fc', borderRadius: 6 }} />
                <span className="t-md fw-b">{s.name}</span>
                <span className="t-xs muted">{`${s.summary} · ${s.sectionCount}구역`}</span>
              </button>
            ))}
          </div>
        )}

        {detail ? (
          <section className="card-flat col" style={{ gap: 10 }} aria-label="템플릿 설정">
            <h3 className="t-md fw-b">{detail.name}</h3>
            <div className="field" style={{ gap: 4 }}>
              <label className="label" htmlFor="tpl-capacity">
                목표 좌석 수
              </label>
              <input id="tpl-capacity" className="input input-sm" type="number" min={detail.sectionCount} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
              <p className="t-xs muted">서버가 구역 비율대로 나눕니다. 구역마다 최소 1석입니다.</p>
            </div>
            {detail.variants.map((v) => (
              <div className="field" key={v.key} style={{ gap: 4 }}>
                <label className="label" htmlFor={`tpl-${v.key}`}>
                  {v.label}
                </label>
                {v.kind === 'BOOLEAN' ? (
                  <label className="check-row t-sm">
                    <input id={`tpl-${v.key}`} type="checkbox" checked={variant[v.key] === true} onChange={(e) => setVariant((x) => ({ ...x, [v.key]: e.target.checked }))} />
                    사용
                  </label>
                ) : v.kind === 'NUMBER' ? (
                  <input id={`tpl-${v.key}`} className="input input-sm" type="number" min={v.min} max={v.max} value={Number(variant[v.key] ?? 0)} onChange={(e) => setVariant((x) => ({ ...x, [v.key]: Number(e.target.value) }))} />
                ) : (
                  <select id={`tpl-${v.key}`} className="input input-sm" value={String(variant[v.key] ?? '')} onChange={(e) => setVariant((x) => ({ ...x, [v.key]: e.target.value }))}>
                    {(v.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
            {confirmReplace ? (
              <div className="banner banner-warning" role="alert">
                <div className="banner-body">이미 좌석이 있는 배치본입니다. 지금 좌석을 지우고 템플릿으로 다시 만들까요?</div>
                <button className="btn btn-danger btn-sm" type="button" disabled={busy} onClick={() => void create(true)}>
                  지우고 만들기
                </button>
              </div>
            ) : null}
            {message ? (
              <p className="error-msg" role="alert">
                {message}
              </p>
            ) : null}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary btn-sm" type="button" disabled={busy || target < detail.sectionCount} onClick={() => void create(false)}>
                이 템플릿으로 만들기
              </button>
              <button className="btn btn-text btn-sm" type="button" onClick={onClose}>
                취소
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </LiveDialog>
  );
}
