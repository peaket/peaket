'use client';
// 서식 글 편집기 PoC 화면(FE-T41, BUILD_ORDER HOT-322). ?editor=lexical|tiptap으로 후보 하나를 늦게 싣고(next/dynamic, ssr: false),
// [저장]하면 구조 문서(JSON)·검사 결과·다시 그린 화면(DocView)을 나란히 보인다. tools/web-checks/rich-text가 이 화면을 연다.
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { validateDoc, type PeaketDoc } from './doc';
import { DocView } from './DocView';

const LOADING = () => (
  <p className="t-sm muted" role="status">
    편집기를 불러오는 중
  </p>
);
const Lexical = dynamic(() => import('./LexicalEditor'), { ssr: false, loading: LOADING });
const Tiptap = dynamic(() => import('./TiptapEditor'), { ssr: false, loading: LOADING });

export function RichTextPoc({ editor }: { editor: 'lexical' | 'tiptap' }) {
  const [doc, setDoc] = useState<PeaketDoc | null>(null);
  const Editor = editor === 'lexical' ? Lexical : Tiptap;
  return (
    <main className="col" id="main" style={{ gap: 16, padding: 24, maxWidth: 880, margin: '0 auto' }}>
      <h1 className="t-lg">서식 글 편집기 PoC · {editor}</h1>
      <Editor onSave={setDoc} />
      {doc ? (
        <>
          <section aria-label="다시 그린 화면" data-testid="rendered" className="card" style={{ padding: 16 }}>
            <DocView doc={doc} />
          </section>
          <pre data-testid="doc" className="t-sm" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(doc)}
          </pre>
          <pre data-testid="errors">{JSON.stringify(validateDoc(doc))}</pre>
        </>
      ) : null}
    </main>
  );
}
