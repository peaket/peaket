'use client';
// CMP-070 서식 글 편집기(Lexical, ADR-0204, ADR-0247). 허용 서식(문단·줄바꿈·굵게·목록·제목 2·3)만 도구 막대에 둔다.
// 붙여넣기는 HTML을 먼저 걷어 내고(paste.ts) 해석 전용 Trusted Types 정책으로 해석해 등록한 노드만 넣는다(CleanPastePlugin).
// 바뀔 때마다 편집기 상태를 구조 문서로 바꿔 알린다(doc.ts fromLexical). 저장되지 않을 글자 모양은 편집기 안에서 지운다(AllowedFormatsPlugin).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { $insertGeneratedNodes } from '@lexical/clipboard';
import { $generateNodesFromDOM } from '@lexical/html';
import { $isListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode, REMOVE_LIST_COMMAND } from '@lexical/list';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { $createHeadingNode, $isHeadingNode, HeadingNode } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  FORMAT_TEXT_COMMAND,
  IS_BOLD,
  PASTE_COMMAND,
  TextNode,
  type EditorState,
  type LexicalEditor as Editor,
  type RangeSelection,
} from 'lexical';
import { docPlainText, fromLexical, MAX_CHARS, toLexical, type PeaketDoc } from './doc';
import { normalizePastedLists, pasteHtml } from './paste';

type BlockKind = 'p' | 'h2' | 'h3' | 'bullet' | 'number';
type ToolKey = 'bold' | Exclude<BlockKind, 'p'>;

const TOOLS: readonly { key: ToolKey; label: string; icon?: string }[] = [
  { key: 'bold', label: '굵게' },
  { key: 'h2', label: '제목' },
  { key: 'h3', label: '작은 제목' },
  { key: 'bullet', label: '글머리 목록', icon: 'ic-list' },
  { key: 'number', label: '번호 목록' },
];

function Toolbar({ controls }: { controls: string }) {
  const [editor] = useLexicalComposerContext();
  const [bold, setBold] = useState(false);
  const [block, setBlock] = useState<BlockKind>('p');
  const [focusIndex, setFocusIndex] = useState(0);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const s = $getSelection();
          if (!$isRangeSelection(s)) return;
          setBold(s.hasFormat('bold'));
          const top = s.anchor.getNode().getTopLevelElement();
          if ($isHeadingNode(top)) setBlock(top.getTag() === 'h3' ? 'h3' : 'h2');
          else if ($isListNode(top)) setBlock(top.getListType() === 'number' ? 'number' : 'bullet');
          else setBlock('p');
        });
      }),
    [editor],
  );

  const run = useCallback(
    (key: ToolKey, keyboardButton: HTMLButtonElement | null) => {
      // 편집 칸을 아직 누르지 않았으면 글 끝에서 시작한다
      editor.update(() => {
        if (!$isRangeSelection($getSelection())) $getRoot().selectEnd();
      });
      if (key === 'bold') editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
      else if (key === 'h2' || key === 'h3')
        editor.update(() => {
          const s = $getSelection();
          if ($isRangeSelection(s)) $setBlocksType(s, () => (block === key ? $createParagraphNode() : $createHeadingNode(key)));
        });
      else if (block === key) editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
      else editor.dispatchCommand(key === 'bullet' ? INSERT_UNORDERED_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined);
      // 키보드로 누르면 초점이 도구 막대에 남아야 한다(편집기가 반영하면서 초점을 가져가, 다음 Enter가 고른 글을 지운다)
      if (keyboardButton) editor.update(() => undefined, { onUpdate: () => keyboardButton.focus() });
    },
    [editor, block],
  );

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const last = TOOLS.length - 1;
    let next = focusIndex;
    if (e.key === 'ArrowRight') next = focusIndex === last ? 0 : focusIndex + 1;
    else if (e.key === 'ArrowLeft') next = focusIndex === 0 ? last : focusIndex - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    setFocusIndex(next);
    toolbarRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }

  return (
    <div
      ref={toolbarRef}
      className="toolbar"
      role="toolbar"
      aria-label="공연 설명 서식"
      aria-controls={controls}
      onKeyDown={onKey}
      style={{ gap: 2, padding: '4px 6px', borderBottom: '1px solid var(--border)', background: 'var(--surface-muted)' }}
    >
      {TOOLS.map((t, i) => (
        <button
          key={t.key}
          className="btn btn-ghost btn-sm"
          type="button"
          tabIndex={i === focusIndex ? 0 : -1}
          aria-pressed={t.key === 'bold' ? bold : block === t.key}
          // 마우스로 눌러도 글을 고른 자리가 풀리지 않게 한다
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            setFocusIndex(i);
            run(t.key, e.detail === 0 ? e.currentTarget : null);
          }}
        >
          {t.icon ? <i className={`ic ${t.icon}`} aria-hidden="true" /> : null}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** 저장되는 글자 모양은 굵게뿐이다. 다른 단축키(기울임·밑줄)를 막고, 붙여넣은 글의 다른 모양과 제목 단계를 저장될 모양으로 맞춘다 */
function AllowedFormatsPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const off = [
      editor.registerCommand(FORMAT_TEXT_COMMAND, (format) => format !== 'bold', COMMAND_PRIORITY_HIGH),
      editor.registerNodeTransform(TextNode, (node) => {
        const format = node.getFormat();
        if ((format & ~IS_BOLD) !== 0) node.setFormat(format & IS_BOLD);
      }),
      editor.registerNodeTransform(HeadingNode, (node) => {
        const tag = node.getTag();
        if (tag === 'h1') node.setTag('h2');
        else if (tag !== 'h2' && tag !== 'h3') node.setTag('h3');
      }),
    ];
    return () => off.forEach((f) => f());
  }, [editor]);
  return null;
}

/** 걷어 낸 HTML을 해석해 등록한 노드만 넣는다. 정책을 못 만들었거나(막는 모드 허용 목록에 이름이 없음) 글자가 남지 않으면 글자판을 넣는다 */
function insertCleaned(editor: Editor, selection: RangeSelection, html: string, plain: string) {
  const safe = pasteHtml(html);
  if (safe === null) {
    selection.insertRawText(plain);
    return;
  }
  const parsed = new DOMParser().parseFromString(safe as string, 'text/html');
  normalizePastedLists(parsed);
  const nodes = $generateNodesFromDOM(editor, parsed);
  if (nodes.every((n) => n.getTextContent().trim() === '')) selection.insertRawText(plain);
  else $insertGeneratedNodes(editor, nodes, selection);
}

/** 붙여넣기와 끌어다 놓기의 HTML은 같은 거름을 지난다. 글자판만 있으면 기본 처리로 넘긴다 */
function CleanPastePlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const insert = (data: DataTransfer | null | undefined): boolean => {
      const html = data?.getData('text/html');
      if (!html || !data) return false;
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) insertCleaned(editor, selection, html, data.getData('text/plain'));
      });
      return true;
    };
    const off = [
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent) || !insert(event.clipboardData)) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, (input) => typeof input !== 'string' && insert(input.dataTransfer), COMMAND_PRIORITY_HIGH),
    ];
    return () => off.forEach((f) => f());
  }, [editor]);
  return null;
}

/** 등록한 노드에 데코레이터(그림 등 React로 그리는 노드)가 없어 이 경계를 쓸 일이 없다. 늦게 싣는 덩어리 90KB(§5.6)를 지키려고 기본 부품을 싣지 않는다 */
const NoDecorators = ({ children }: { children: ReactElement }) => children;

export interface DescriptionEditorProps {
  id: string;
  labelledBy: string;
  /** 처음 내용. 처음 그릴 때만 읽는다(바뀌면 부르는 쪽이 key를 바꾼다) */
  initial: PeaketDoc | null;
  onChange: (doc: PeaketDoc) => void;
  error?: string;
}

export default function LexicalEditor({ id, labelledBy, initial, onChange, error }: DescriptionEditorProps) {
  const [remaining, setRemaining] = useState(() => MAX_CHARS - (initial ? docPlainText(initial).length : 0));
  const [startState] = useState(() => {
    const state = initial ? toLexical(initial) : null;
    return state ? JSON.stringify(state) : undefined;
  });
  const handleChange = useCallback(
    (state: EditorState) => {
      const doc = fromLexical(state.toJSON());
      setRemaining(MAX_CHARS - docPlainText(doc).length);
      onChange(doc);
    },
    [onChange],
  );
  const hintId = `${id}-h`;
  const counterId = `${id}-c`;
  const errorId = `${id}-e`;
  const describedBy = [hintId, counterId, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'peaket-description',
        nodes: [HeadingNode, ListNode, ListItemNode],
        editorState: startState,
        onError: (e) => {
          throw e;
        },
        theme: { text: { bold: 'fw-b' }, list: { ul: 'list-disc pl-5', ol: 'list-decimal pl-5' } },
      }}
    >
      <div className="col" style={{ gap: 6 }}>
        <div className="col" style={{ border: `1px solid ${error ? 'var(--danger)' : 'var(--border-input)'}`, borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--surface)' }}>
          <Toolbar controls={id} />
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className="prose"
                id={id}
                role="textbox"
                ariaLabelledBy={labelledBy}
                ariaDescribedBy={describedBy}
                ariaMultiline
                ariaInvalid={error ? true : undefined}
                data-testid="editor"
                style={{ minHeight: 128, maxHeight: '50vh', overflowY: 'auto', padding: '12px 14px', outlineOffset: -2 }}
              />
            }
            ErrorBoundary={NoDecorators}
          />
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <AllowedFormatsPlugin />
        <CleanPastePlugin />
        <OnChangePlugin ignoreSelectionChange onChange={handleChange} />
        {error ? (
          <span className="error-msg" id={errorId}>
            <i className="ic ic-alert-circle" aria-hidden="true" />
            {error}
          </span>
        ) : null}
        <div className="row between" style={{ gap: 12 }}>
          <span className="hint" id={hintId}>
            저장할 때 허용한 서식만 남기고 나머지는 지웁니다
          </span>
          <span className="counter nowrap" id={counterId}>
            {remaining >= 0 ? `남은 글자 ${remaining.toLocaleString('en-US')}자` : `${(-remaining).toLocaleString('en-US')}자를 넘었습니다`}
          </span>
          {/* 글자마다 읽지 않게 경계를 넘을 때만 알린다 */}
          <span className="sr-only" role="status">
            {remaining < 0 ? '글자 수 상한을 넘었습니다' : remaining <= 100 ? '남은 글자가 100자 이하입니다' : ''}
          </span>
        </div>
      </div>
    </LexicalComposer>
  );
}
