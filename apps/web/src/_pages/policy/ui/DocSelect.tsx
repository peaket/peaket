'use client';
// SCR-057 ① 문서 선택(CMP-010 Select, 키트 .input-group select). 고르면 그 문서 주소(/policy/[slug])로 간다.
import { useRouter } from 'next/navigation';
import { useId } from 'react';
import type { PolicySlug } from '@/entities/policy-doc';

export interface DocSelectProps {
  docs: readonly { slug: PolicySlug; title: string }[];
  /** 없는 문서면 null(첫 줄 '문서를 고르세요') */
  current: PolicySlug | null;
  className?: string;
}

export function DocSelect({ docs, current, className }: DocSelectProps) {
  const router = useRouter();
  const id = useId();
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label className="label" htmlFor={id}>
        문서
      </label>
      <div className="input-group">
        <select id={id} value={current ?? ''} onChange={(e) => router.push(`/policy/${e.target.value}`)}>
          {current === null ? (
            <option value="" disabled>
              문서를 고르세요
            </option>
          ) : null}
          {docs.map((d) => (
            <option key={d.slug} value={d.slug}>
              {d.title}
            </option>
          ))}
        </select>
        <i className="ic ic-chevron-down" aria-hidden="true" />
      </div>
    </div>
  );
}
