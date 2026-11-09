'use client';
// CMP-070 서식 글 편집기 후보 Lexical(FE-T41 PoC). 허용 서식(문단·줄바꿈·굵게·목록·제목 2·3)만 도구 막대에 둔다.
// 붙여넣기는 HTML을 먼저 걷어 내고(paste.ts) 해석 전용 Trusted Types 정책으로 해석해 등록한 노드만 넣는다(CleanPastePlugin).
// 저장은 editorState.toJSON()을 구조 문서로 바꾼다(doc.ts fromLexical).
import { useCallback, useEffect } from 'react';
import { $insertGeneratedNodes } from '@lexical/clipboard';
import { $generateNodesFromDOM } from '@lexical/html';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { $createHeadingNode, HeadingNode } from '@lexical/rich-text';
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode } from '@lexical/list';
import { $setBlocksType } from '@lexical/selection';
import { $createParagraphNode, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, FORMAT_TEXT_COMMAND, PASTE_COMMAND } from 'lexical';
import { fromLexical, type PeaketDoc } from './doc';
import { pasteHtml } from './paste';

function Toolbar({ onSave }: { onSave: (doc: PeaketDoc) => void }) {
  const [editor] = useLexicalComposerContext();
  const block = useCallback(
    (kind: 'h2' | 'p') =>
      editor.update(() => {
        const s = $getSelection();
        if ($isRangeSelection(s)) $setBlocksType(s, () => (kind === 'h2' ? $createHeadingNode('h2') : $createParagraphNode()));
      }),
    [editor],
  );
  return (
    <div className="row wrap" role="toolbar" aria-label="서식" style={{ gap: 6 }}>
      <button className="btn btn-outline btn-sm" type="button" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}>
        굵게
      </button>
      <button className="btn btn-outline btn-sm" type="button" onClick={() => block('h2')}>
        제목
      </button>
      <button className="btn btn-outline btn-sm" type="button" onClick={() => block('p')}>
        문단
      </button>
      <button className="btn btn-outline btn-sm" type="button" onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}>
        글머리 목록
      </button>
      <button className="btn btn-outline btn-sm" type="button" onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}>
        번호 목록
      </button>
      <button className="btn btn-primary btn-sm" type="button" data-testid="save" onClick={() => onSave(fromLexical(editor.getEditorState().toJSON()))}>
        저장
      </button>
    </div>
  );
}

/** HTML 붙여넣기: 걷어 낸 뒤 해석하고 등록한 노드(문단·제목·목록)만 넣는다. 글자판만 있으면 기본 처리로 넘긴다 */
function CleanPastePlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const html = event instanceof ClipboardEvent ? event.clipboardData?.getData('text/html') : undefined;
          if (!html || !(event instanceof ClipboardEvent)) return false;
          event.preventDefault();
          const safe = pasteHtml(html);
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            // 해석 전용 정책을 만들지 못했으면(막는 모드 허용 목록에 이름이 없음) HTML을 해석하지 않고 글자판으로 넣는다
            if (safe === null) selection.insertRawText(event.clipboardData?.getData('text/plain') ?? '');
            else $insertGeneratedNodes(editor, $generateNodesFromDOM(editor, new DOMParser().parseFromString(safe as string, 'text/html')), selection);
          });
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );
  return null;
}

export default function LexicalEditor({ onSave }: { onSave: (doc: PeaketDoc) => void }) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'peaket-description',
        nodes: [HeadingNode, ListNode, ListItemNode],
        onError: (e) => {
          throw e;
        },
        theme: { text: { bold: 'fw-b' } },
      }}
    >
      <div className="col" style={{ gap: 8 }}>
        <Toolbar onSave={onSave} />
        <RichTextPlugin
          contentEditable={<ContentEditable className="input" aria-label="공연 설명" aria-multiline role="textbox" data-testid="editor" style={{ minHeight: 160 }} />}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CleanPastePlugin />
      </div>
    </LexicalComposer>
  );
}
