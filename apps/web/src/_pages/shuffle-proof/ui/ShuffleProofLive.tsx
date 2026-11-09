'use client';
// SCR-019의 실제 공시 기록(d5 §5.19, ADR-0232). 셔플 검증 정보 API를 읽어 본문을 그리고, ⑥ 다시 계산은 결과 파일을 모아 브라우저에서 한다(토큰 해시는 서버로 보내지 않는다).
import { useCallback, useEffect, useState } from 'react';
import { getQueueShuffleProof } from '@peaket/api-client/endpoints/queue';
import { SORT_MODE_LABEL } from '@/entities/production';
import type { ShuffleProof } from '@/entities/shuffle-proof';
import { ensureBrowserApi } from '@/shared/api';
import { ORIGINS } from '@/shared/config/origins';
import { dateTimeText } from '@/shared/lib/kst';
import { dateTimeSecText, timeSecText } from '../model/proof-time';
import { buildProofView, NO_FILE_FLAGS, type ProofDto, type ProofFlags, sortModeOf } from '../model/proof-view';
import { runVerification } from '../model/verify-client';
import { estimateDownload, pickStoredToken } from '../model/verify-flow';
import { ProofHeading, ProofNoFile, ShuffleProofBody } from './ShuffleProofBody';

const sha256Hex = async (text: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');

/** 대기실이 둔 회차 저장값(docs/frontend.md §3.12)에서 실제로 보낸 토큰의 해시를 만든다. 못 만들면 자동으로 채우지 않는다 */
async function storedHash(eventId: string, fifo: boolean): Promise<string | undefined> {
  try {
    const token = pickStoredToken(JSON.parse(localStorage.getItem(`peaket.queue.${eventId}`) ?? 'null'), fifo);
    return token && crypto.subtle ? await sha256Hex(token) : undefined;
  } catch {
    return undefined;
  }
}

type Loaded = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; api: ProofDto; proof: ShuffleProof; flags: ProofFlags };

export function ShuffleProofLive({ eventId, title, perfLabel, backHref }: { eventId: string; title?: string; perfLabel?: string; backHref: string }) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' });
  const [autofill, setAutofill] = useState<string | undefined>();
  const load = useCallback(() => {
    setState({ kind: 'loading' });
    ensureBrowserApi();
    getQueueShuffleProof(eventId)
      .then((r) => {
        const api = r.data as unknown as ProofDto;
        const { proof, flags } = buildProofView(api, { nowMs: Date.now(), filesOrigin: ORIGINS.queueFiles, fmt: { dateTime: dateTimeText, dateTimeSec: dateTimeSecText, timeSec: timeSecText } });
        setState({ kind: 'ready', api, proof, flags });
        void storedHash(eventId, api.lobby === null).then(setAutofill);
      })
      .catch(() => setState({ kind: 'error' }));
  }, [eventId]);
  useEffect(load, [load]);

  if (state.kind === 'loading') {
    return (
      <p className="t-md muted p-6" role="status">
        검증 정보를 불러오는 중입니다
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <>
        <ProofHeading {...(title ? { title } : {})} {...(perfLabel ? { perfLabel } : {})} backHref={backHref} sortLabel="" v={NO_FILE_FLAGS} openText="" seedAt="" />
        <ProofNoFile retryHref={backHref} onRetry={load} />
      </>
    );
  }
  const { api, proof, flags } = state;
  const groups = [api.lobby, api.batch].filter((g) => g?.seed);
  const largest = groups.reduce((a, g) => ((g?.participantCount ?? 0) > (a?.participantCount ?? 0) ? g : a), groups[0] ?? null);
  const sizeNotice = largest ? estimateDownload(largest) : null;
  return (
    <>
      <ProofHeading {...(title ? { title } : {})} {...(perfLabel ? { perfLabel } : {})} backHref={backHref} sortLabel={SORT_MODE_LABEL[sortModeOf(api)]} v={flags} openText={proof.open.at} seedAt={proof.seed.at} />
      <ShuffleProofBody
        proof={proof}
        v={flags}
        verifierKey="live"
        {...(autofill ? { autofill } : {})}
        {...(sizeNotice ? { sizeNotice } : {})}
        onVerify={(h, ctx) => runVerification(api, h, ORIGINS.queueFiles, ctx)}
      />
    </>
  );
}
