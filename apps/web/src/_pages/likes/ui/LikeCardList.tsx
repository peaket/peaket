'use client';
// SCR-054 관심 공연 카드 목록(d5 §5.28). 목업 카드와 실서버 찜 목록이 같은 마크업을 쓴다.
// 포스터는 서버 카드에 posterUrl이 있으면 파생본 <picture>, 없으면 캔버스 키트 예시 그림이다.
import Link from 'next/link';
import { useState } from 'react';
import { ProductionPoster } from '@/entities/production';
import { PicturePoster } from '@/shared/ui/PicturePoster';
import { useToast } from '@/shared/ui/toast';
import type { LiveCard } from '../model/lists';

export type { LiveCard };

export function LikeCardList({
  cards,
  offline,
  pendingCount,
  onToggle,
}: {
  cards: readonly LiveCard[];
  offline: boolean;
  pendingCount: number;
  /** 찜 저장·해제. 성공하면 true, 실패하면 보일 문구 */
  onToggle?: (productionId: string, next: boolean) => Promise<true | string>;
}) {
  return (
    <>
      {offline ? (
        <div className="banner banner-offline" role="status" style={{ marginBottom: 12 }}>
          <i className="ic ic-wifi-off" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">인터넷 연결이 없습니다</span>
            연결되면 저장됩니다(오프라인에서 누른 찜 {pendingCount}건)
          </div>
        </div>
      ) : null}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-6">
        {cards.map((c) => (
          <li key={c.id}>
            <article className="card flex gap-3.5 p-3.5 md:h-full lg:gap-4 lg:p-4">
              {c.posterUrl ? (
                <PicturePoster
                  src={c.posterUrl}
                  alt={c.posterAlt ?? `${c.title} 포스터`}
                  width={2}
                  height={3}
                  sizes="72px"
                  className="w-[72px] shrink-0 self-start md:w-[88px] lg:w-24"
                  fallbackLabel={c.posterShort}
                />
              ) : (
                <ProductionPoster
                  art={c.art ?? 'lumen'}
                  size="sm"
                  label={`${c.title} 포스터`}
                  title={c.posterShort ?? c.title}
                  className="w-[72px] md:w-[88px] lg:w-24"
                  style={{ alignSelf: 'flex-start' }}
                />
              )}
              <div className="col grow" style={{ gap: 6 }}>
                <h2 className="t-md fw-b">
                  {c.href ? (
                    <Link href={c.href} style={{ color: 'inherit' }}>
                      {c.title}
                    </Link>
                  ) : (
                    c.title
                  )}
                </h2>
                <p className="t-sm muted">{c.sub}</p>
                <div className="row between" style={{ gap: 8, marginTop: 'auto' }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className={c.badgeCls}>{c.badgeText}</span>
                    {c.pending ? (
                      <span className="badge badge-warning">
                        <i className="ic ic-clock" aria-hidden="true" />
                        저장 대기
                      </span>
                    ) : null}
                  </div>
                  <UnlikeButton title={c.title} {...(onToggle ? { onToggle: (next: boolean) => onToggle(c.id, next) } : {})} />
                </div>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 카드의 찜 해제(하트 아이콘 버튼). onToggle이 있으면 서버·대기열에 보내고 실패하면 되돌린다 */
export function UnlikeButton({ title, onToggle }: { title: string; onToggle?: (next: boolean) => Promise<true | string> }) {
  const [liked, setLiked] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      className="icon-btn"
      type="button"
      aria-label={liked ? `${title} 찜 해제` : `${title} 다시 찜하기`}
      aria-pressed={liked}
      aria-disabled={busy ? 'true' : undefined}
      style={{ margin: '-6px -10px -6px 0' }}
      onClick={() => {
        if (busy) return;
        const next = !liked;
        if (!onToggle) {
          setLiked(next);
          toast(next ? '찜했습니다' : '찜을 해제했습니다', next ? 'ic-heart-fill' : 'ic-heart');
          return;
        }
        setBusy(true);
        setLiked(next);
        void onToggle(next)
          .catch(() => false as const)
          .then((r) => {
            setBusy(false);
            if (r === true) toast(next ? '찜했습니다' : '찜을 해제했습니다', next ? 'ic-heart-fill' : 'ic-heart');
            else {
              setLiked(!next);
              toast(typeof r === 'string' && r ? r : '찜을 바꾸지 못했습니다. 잠시 뒤 다시 해 주세요', 'ic-heart');
            }
          });
      }}
    >
      <i className={liked ? 'ic ic-heart-fill tx-danger' : 'ic ic-heart'} aria-hidden="true" />
    </button>
  );
}
