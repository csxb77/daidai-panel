<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { Change, MergeView, diff, unifiedMergeView } from "@codemirror/merge";
import {
  buildCodeEditorTheme,
  resolveCodeEditorLanguage,
} from "@/utils/codeEditor";
import { PANEL_APPEARANCE_CHANGE_EVENT } from "@/utils/panelAppearance";

/**
 * 版本对比编辑器（CodeMirror 6 的 @codemirror/merge）。
 *
 * 对外 props 与被它取代的 MonacoDiffEditor.vue 逐字一致（含默认值），
 * 调用点（脚本页的「版本对比」弹窗）只需要换个组件名。
 */
const props = withDefaults(
  defineProps<{
    originalValue: string;
    modifiedValue: string;
    language?: string;
    readonly?: boolean;
    renderSideBySide?: boolean;
    ignoreTrimWhitespace?: boolean;
    hideUnchangedRegions?: boolean;
    contextLineCount?: number;
  }>(),
  {
    language: "plaintext",
    readonly: true,
    renderSideBySide: true,
    ignoreTrimWhitespace: false,
    hideUnchangedRegions: false,
    contextLineCount: 3,
  },
);

/** 行首尾要抹掉的空白。\r 也算：顺带让 CRLF 与 LF 两种换行不被判成差异。 */
function isEdgeWhitespace(char: string | undefined) {
  return char === " " || char === "\t" || char === "\r";
}

/**
 * 抹掉每一行**首尾**的空白，同时给出「抹掉后的下标 → 原文下标」的映射表。
 * 映射表长度是抹掉后文本长度 + 1：Change 的 to 是开区间右端，可能正好等于文本长度。
 *
 * 为什么是 trim（首尾都抹）而不是只抹行尾：这是在对齐 Monaco 的 ignoreTrimWhitespace 语义 ——
 * 它按 trim 比较，而缩进正是行首的空白。开关文案是「忽略空白差异」、说明写的是
 * 「只检测到空格、缩进或换行变化」，所以「一处真实改动 + 一段重新缩进」的版本对比里，
 * 只改了缩进的那段在开着开关时必须不算差异；只抹行尾会让它重新被标红，
 * 属于换引擎带来的、没在发布说明里声明过的行为回退。
 */
function stripLineEdgeWhitespace(text: string) {
  let stripped = "";
  const map: number[] = [];
  let lineStart = 0;

  for (;;) {
    const newlineAt = text.indexOf("\n", lineStart);
    const lineEnd = newlineAt === -1 ? text.length : newlineAt;
    let contentEnd = lineEnd;
    while (contentEnd > lineStart && isEdgeWhitespace(text[contentEnd - 1])) {
      contentEnd -= 1;
    }
    // 行首必须在 contentEnd 算完之后再往前收，且以 contentEnd 为界：
    // 整行都是空白时两个游标会停在同一处，slice 出空串、map 也不会塞进倒序下标，
    // 从而保住「map 单调递增、长度 = stripped.length + 1」这两条不变量。
    let contentStart = lineStart;
    while (contentStart < contentEnd && isEdgeWhitespace(text[contentStart])) {
      contentStart += 1;
    }
    // map 只记「被保留下来的字符」的原文下标，行首被抹掉的那几个下标直接跳过
    for (let i = contentStart; i < contentEnd; i += 1) {
      map.push(i);
    }
    stripped += text.slice(contentStart, contentEnd);
    if (newlineAt === -1) {
      break;
    }
    map.push(newlineAt);
    stripped += "\n";
    lineStart = newlineAt + 1;
  }

  map.push(text.length);
  return { text: stripped, map };
}

/**
 * 「忽略空白差异」的自定义 diff。
 *
 * CodeMirror 的 diff 没有 Monaco 那个内置的 ignoreTrimWhitespace 开关，
 * 只能通过 diffConfig.override 整个接管：先把两侧每行首尾的空白抹掉再比，
 * 再把结果下标映射回原文——这样显示出来的仍然是原文（不动用户的内容），
 * 但纯粹的缩进 / 行尾空白改动不会被算成差异。
 *
 * 这里刻意用 diff 而不是 presentableDiff：override 的返回值会被调用方
 * （Chunk.build）再跑一遍 makePresentable，先跑一次纯属重复劳动。
 */
function diffIgnoringLineEdgeWhitespace(a: string, b: string) {
  const strippedA = stripLineEdgeWhitespace(a);
  const strippedB = stripLineEdgeWhitespace(b);
  return diff(strippedA.text, strippedB.text, { scanLimit: 500 }).map(
    (change) =>
      new Change(
        strippedA.map[change.fromA]!,
        strippedA.map[change.toA]!,
        strippedB.map[change.fromB]!,
        strippedB.map[change.toB]!,
      ),
  );
}

const containerRef = ref<HTMLElement>();
let mergeView: MergeView | null = null;
let unifiedView: EditorView | null = null;

function destroyView() {
  mergeView?.destroy();
  mergeView = null;
  unifiedView?.destroy();
  unifiedView = null;
  // destroy() 只负责拆编辑器自身，外层 DOM 是我们传 parent 时挂上去的，
  // 不清干净的话重建时会在同一个容器里叠出两份。
  if (containerRef.value) {
    containerRef.value.innerHTML = "";
  }
}

/**
 * 整体重建。
 *
 * 这里刻意不做「按 prop 逐项 reconfigure」：本组件是只读的一次性对比视图，
 * 每次 prop 变化基本都意味着换了一对要比的内容（选了另一个历史版本、切了移动端布局），
 * 重建比维护 6 个 Compartment 简单得多，代价只是丢掉滚动位置。
 */
function buildView() {
  destroyView();
  const container = containerRef.value;
  if (!container) return;

  const diffConfig = props.ignoreTrimWhitespace
    ? { scanLimit: 500, override: diffIgnoringLineEdgeWhitespace }
    : { scanLimit: 500 };
  // margin 对应 Monaco 的 contextLineCount（差异块上下各保留几行上下文）；
  // minSize 是 CodeMirror 独有的「至少这么多行才值得折叠」，取它的默认值 4。
  const collapseUnchanged = props.hideUnchangedRegions
    ? { margin: props.contextLineCount, minSize: 4 }
    : undefined;

  const shared = [
    lineNumbers(),
    highlightSpecialChars(),
    // 改造前 Monaco 侧是 wordWrap/diffWordWrap 都为 'on'，这里保持一致
    EditorView.lineWrapping,
    resolveCodeEditorLanguage(props.language),
    ...buildCodeEditorTheme(),
  ];

  if (props.renderSideBySide) {
    mergeView = new MergeView({
      parent: container,
      a: {
        doc: props.originalValue,
        // 左侧是历史版本，任何时候都不可编辑（改造前 Monaco 侧是 originalEditable: false）
        extensions: [
          ...shared,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: props.modifiedValue,
        extensions: [
          ...shared,
          EditorState.readOnly.of(props.readonly),
          EditorView.editable.of(!props.readonly),
        ],
      },
      gutter: true,
      highlightChanges: true,
      diffConfig,
      collapseUnchanged,
    });
    return;
  }

  // renderSideBySide=false（移动端）走统一视图：只有一个编辑器，
  // 删除的内容以只读小部件的形式插在新内容上方。
  unifiedView = new EditorView({
    parent: container,
    doc: props.modifiedValue,
    extensions: [
      ...shared,
      EditorState.readOnly.of(props.readonly),
      EditorView.editable.of(!props.readonly),
      unifiedMergeView({
        original: props.originalValue,
        // 只读的版本对比，不需要逐块「接受 / 拒绝」按钮
        mergeControls: false,
        gutter: true,
        highlightChanges: true,
        diffConfig,
        collapseUnchanged,
      }),
    ],
  });
}

onMounted(() => {
  // 明暗切换与「自定义编辑器底色」都走这个事件（见 stores/theme.ts 与 utils/panelAppearance.ts）。
  // 这里直接重建，理由同 buildView 的注释：代价只有滚动位置，而改主题时本来也没在滚。
  window.addEventListener(PANEL_APPEARANCE_CHANGE_EVENT, buildView);
  buildView();
});

watch(
  [
    () => props.originalValue,
    () => props.modifiedValue,
    () => props.language,
    () => props.readonly,
    () => props.renderSideBySide,
    () => props.ignoreTrimWhitespace,
    () => props.hideUnchangedRegions,
    () => props.contextLineCount,
  ],
  () => {
    buildView();
  },
);

onBeforeUnmount(() => {
  window.removeEventListener(PANEL_APPEARANCE_CHANGE_EVENT, buildView);
  destroyView();
});
</script>

<template>
  <div class="code-diff-wrapper">
    <div ref="containerRef" class="code-diff-container"></div>
  </div>
</template>

<style scoped>
.code-diff-wrapper {
  width: 100%;
  height: 100%;
  min-height: 420px;
  position: relative;
  overflow: hidden;
  font-size: 14px;
  background: var(--dd-editor-bg-color, #111827);
}

.code-diff-container {
  width: 100%;
  height: 100%;
}

/* 并排模式：滚动条在 .cm-mergeView 上（它自带 overflow-y: auto），
   内部两个 .cm-editor 被 merge 的基础主题强制成 height:auto !important，不用也不能再管。 */
.code-diff-container :deep(.cm-mergeView) {
  height: 100%;
}

/* 统一模式没有 .cm-mergeView 外壳，就是一个普通编辑器，得自己撑满 */
.code-diff-container :deep(.cm-editor) {
  height: 100%;
}

/* iOS Safari 在可编辑区字号小于 16px 时聚焦会放大整页。
   对比视图默认只读、一般不会聚焦，但移动端走的是统一视图、内容区仍是 contenteditable，
   与 CodeEditor.vue 保持同一套规避方式。 */
@media (max-width: 768px) {
  .code-diff-wrapper {
    font-size: 16px;
  }
}
</style>
