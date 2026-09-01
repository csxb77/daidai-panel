<script lang="ts">
/**
 * 「自动换行」偏好的读写。
 *
 * 为什么放在这个组件文件里（而不是新起一个 utils 模块）：
 * 配置文件页与脚本页要共享同一份记忆（一处切换、另一处跟着变），读写范式就只能有一份；
 * 而这两个页面本来就都依赖本组件，偏好也只服务于下面那个 wordWrap prop，
 * 再抽一层通用存储封装属于「为通用性多套一层」，本仓约定是不做（见 AGENTS.md 写代码的风格）。
 *
 * 调试弹窗 / 代码运行器 / 版本对比这几个调用点不读这份偏好，
 * 它们不传 wordWrap，直接吃 prop 默认值 'on'，行为与改造前完全一致。
 *
 * 存储键与回落语义与 Monaco 时代逐字相同：换引擎不该让老用户的偏好丢一次。
 */
export type EditorWordWrap = "on" | "off";

const EDITOR_WORD_WRAP_STORAGE_KEY = "dd:editor:word_wrap";

export function readStoredEditorWordWrap(): EditorWordWrap {
  if (typeof window === "undefined") {
    return "on";
  }
  try {
    // 只认 'off'，其余（没写过、被人改成脏值、读不到）一律回落 'on'，
    // 'on' 就是改造前硬编码的行为，老用户升级后第一眼观感不变。
    return window.localStorage.getItem(EDITOR_WORD_WRAP_STORAGE_KEY) === "off"
      ? "off"
      : "on";
  } catch {
    // 隐私模式 / 禁用存储时 getItem 会抛错，不能让它把调用方的 setup 整块炸掉
    return "on";
  }
}

export function persistEditorWordWrap(value: EditorWordWrap) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(EDITOR_WORD_WRAP_STORAGE_KEY, value);
  } catch {
    // 写失败只是这次记不住，不影响本次切换效果，静默忽略
  }
}
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  buildCodeEditorTheme,
  resolveCodeEditorLanguage,
} from "@/utils/codeEditor";
import { PANEL_APPEARANCE_CHANGE_EVENT } from "@/utils/panelAppearance";

/**
 * 代码编辑器（CodeMirror 6）。
 *
 * 为什么不是 Monaco：Monaco 是自绘编辑器，文本画在 .view-lines 里、原生选择被关掉，
 * 触摸事件由它内部的手势层接管，所以「长按出系统菜单 / 双击出选择手柄 / 按住拖动光标」
 * 这三条在手机上**无论怎么配都做不到**。CodeMirror 的内容区是 contenteditable、
 * 选区就是原生 Selection，这三条天然可用。
 *
 * ⚠️ 正因如此，这里刻意**没有**启用 CodeMirror 的 drawSelection ——
 * 那个扩展会把原生选区藏起来改成自绘，等于把 Monaco 的毛病原样搬过来。
 * 后人要加多光标之类的功能时请先想清楚这一点。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: string;
    readonly?: boolean;
    minHeight?: string | number;
    /**
     * 撑满父容器高度。
     * 开启后外层容器改为 `flex: 1 1 auto; height: 100%`，高度由父级 flex 链决定，
     * `min-height` 退化为「下限」（默认 0，父级没有确定高度时可由调用方另行给下限）。
     */
    fillHeight?: boolean;
    /**
     * 自动换行。默认 'on'，与改造前一致，
     * 不传该 prop 的调用点（调试弹窗 / 代码运行器）行为零变化。
     */
    wordWrap?: "on" | "off";
  }>(),
  {
    wordWrap: "on",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const editorRef = ref<HTMLElement>();
let view: EditorView | null = null;

// 四个运行期可变的配置各占一个 Compartment。
// CodeMirror 的 extensions 只在 EditorState.create() 那一刻读一次，
// 想在挂载之后改就必须走 Compartment.reconfigure —— 直接改 prop 是**完全没反应且不报错**的，
// 构建和类型检查都发现不了（design-system.md 里专门为这条写过一则 Don't）。
const languageCompartment = new Compartment();
const readonlyCompartment = new Compartment();
const wordWrapCompartment = new Compartment();
const themeCompartment = new Compartment();

// 只读必须两条一起给：
// EditorState.readOnly 挡住事务写入，EditorView.editable 关掉 contenteditable。
// 只写前者的话光标仍能落进去、手机输入法照样弹出来，用户会以为能改，改不动又不知道为什么。
function buildReadonlyExtension(readonly: boolean) {
  return [EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)];
}

function buildWordWrapExtension(wordWrap: "on" | "off") {
  return wordWrap === "on" ? EditorView.lineWrapping : [];
}

// 明暗切换、以及用户在系统设置里改编辑器底色，都会走 PANEL_APPEARANCE_CHANGE_EVENT
// （切主题那一路见 stores/theme.ts：toggle 完立刻 applyPanelAppearance()）。
// 底色本身是 CSS 变量、不用管；但行号色 / 选区色 / 语法配色是按明暗二选一的，必须重建主题。
function syncEditorTheme() {
  view?.dispatch({
    effects: themeCompartment.reconfigure(buildCodeEditorTheme()),
  });
}

function replaceDoc(value: string) {
  if (!view) return;
  if (view.state.doc.toString() === value) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
  });
}

onMounted(() => {
  window.addEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);
  if (!editorRef.value) return;

  view = new EditorView({
    parent: editorRef.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSpecialChars(),
        history(),
        indentOnInput(),
        bracketMatching(),
        // 下面这三条是 Monaco 时代默认就开着、换引擎时被顺手丢掉的编辑能力。
        // 它们都不碰选区绘制，与本组件「保住原生选区」的取舍毫无冲突，所以补回来：
        //   - foldGutter：行号右侧的折叠箭头。它自带 codeFolding()（见 @codemirror/language
        //     的 foldGutter 实现），不用再单独引折叠状态字段；放在 lineNumbers() 之后
        //     才会渲染在行号右侧，顺序不能随便挪。
        //   - closeBrackets：输入 ( [ { " ' 时自动补上右半边。
        //   - autocompletion：补全弹窗。补全项来自各语言扩展注册的 language data
        //     （js/ts/python/json/html/css 有，shell 走的是 legacy-modes 流式模式、没有源，
        //     表现就是不弹框，属于正常）。
        foldGutter(),
        closeBrackets(),
        autocompletion(),
        // 缩进 2 空格，与改造前 Monaco 的 tabSize: 2 对齐。
        // indentUnit 管「命令插入多少」，tabSize 管「已有的 \t 显示多宽」，两条都要。
        indentUnit.of("  "),
        EditorState.tabSize.of(2),
        search({ top: true }),
        highlightSelectionMatches(),
        keymap.of([
          // closeBracketsKeymap 只有一条 Backspace（在 `()` 正中间时把整对一起删掉），
          // 必须排在 defaultKeymap 前面，否则 Backspace 会先被 defaultKeymap 接走、这条永远不生效。
          // 它在非成对场景返回 false 会继续往下派发，所以不会挤掉 defaultKeymap 的删除行为。
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          // 折叠快捷键（Ctrl-Shift-[ / ]、Ctrl-Alt-[ / ]），与上面几套没有键位冲突
          ...foldKeymap,
          // completionKeymap 排在最后是安全的：autocompletion() 内部已经用 Prec.highest
          // 装了同一份绑定（默认 defaultKeymap: true），补全弹窗开着时 Enter / ↑↓ 一定先走它，
          // 不会被 defaultKeymap 的换行吃掉。这里再显式列一次是与官方 basicSetup 对齐，
          // 也兜住「日后给 autocompletion 传 defaultKeymap: false」时快捷键整套消失的情况。
          ...completionKeymap,
          indentWithTab,
        ]),
        // 移动端必补的三条：手机输入法默认句首大写 + 自动纠错 + 拼写检查，
        // 会**静默改坏脚本内容**（把 const 改成 Const、把变量名纠成英文单词），
        // 而且用户根本不会意识到是输入法干的。
        EditorView.contentAttributes.of({
          spellcheck: "false",
          autocapitalize: "off",
          autocorrect: "off",
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const value = update.state.doc.toString();
          // 和外部 modelValue 相同，说明这次变更是下面那个 watch 同步进来的，
          // 再 emit 一次就和父组件转成回环了。
          if (value === props.modelValue) return;
          // 每次输入即时 emit，不能等失焦：
          // 「未保存」角标、保存按钮 disabled、调试弹窗的 markDebugCodeChanged 全靠它。
          emit("update:modelValue", value);
        }),
        languageCompartment.of(resolveCodeEditorLanguage(props.language)),
        readonlyCompartment.of(buildReadonlyExtension(props.readonly || false)),
        wordWrapCompartment.of(buildWordWrapExtension(props.wordWrap)),
        themeCompartment.of(buildCodeEditorTheme()),
      ],
    }),
  });
});

watch(
  () => props.modelValue,
  (newValue) => {
    replaceDoc(newValue);
  },
);

// 脚本页切换文件会换语言，必须重配，否则一直停在第一次打开那个文件的高亮上
watch(
  () => props.language,
  (newLanguage) => {
    view?.dispatch({
      effects: languageCompartment.reconfigure(
        resolveCodeEditorLanguage(newLanguage),
      ),
    });
  },
);

// 漏了这条就是「只读态还能改」：改完污染 hasChanges，退出编辑时弹出幽灵「有未保存改动」
watch(
  () => props.readonly,
  (newReadonly) => {
    view?.dispatch({
      effects: readonlyCompartment.reconfigure(
        buildReadonlyExtension(newReadonly || false),
      ),
    });
  },
);

// 漏了这条就是「点了自动换行按钮没反应」，且不报错、构建与类型检查都发现不了
watch(
  () => props.wordWrap,
  (newWordWrap) => {
    view?.dispatch({
      effects: wordWrapCompartment.reconfigure(
        buildWordWrapExtension(newWordWrap),
      ),
    });
  },
);

onBeforeUnmount(() => {
  window.removeEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);
  view?.destroy();
  view = null;
});

defineExpose({
  focus: () => view?.focus(),
  getValue: () => view?.state.doc.toString() || "",
  setValue: (value: string) => replaceDoc(value),
  // 全仓没有调用点：格式化走后端 scriptApi.format，前端不做本地格式化。
  // 保留同名方法只是为了不改动对外契约，故意留空。
  format: () => {},
});

function resolveMinHeight(value: string | number | undefined) {
  if (typeof value === "number") {
    return `${value}px`;
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  // 撑满模式下高度由父级决定，默认不设下限；普通模式仍需要一个固定高度兜底
  return props.fillHeight ? "0px" : "400px";
}
</script>

<template>
  <div
    class="code-editor-wrapper"
    :class="{ 'code-editor-wrapper--fill': props.fillHeight }"
    :style="{ '--code-editor-min-height': resolveMinHeight(props.minHeight) }"
  >
    <div ref="editorRef" class="code-editor-container"></div>
  </div>
</template>

<style scoped>
.code-editor-wrapper {
  width: 100%;
  min-height: var(--code-editor-min-height, 400px);
  height: var(--code-editor-min-height, 400px);
  position: relative;
  /* 编辑器基准字号写在这里而不是主题里：下面那条移动端媒体查询只要改这一处，
     行号、正文、滚动条度量会一起跟着变，不会出现字大了行号还是小的错位。 */
  font-size: 14px;
}

/* 双类选择器：靠特异性压过上面的固定高度，不依赖样式表书写顺序 */
.code-editor-wrapper.code-editor-wrapper--fill {
  flex: 1 1 auto;
  height: 100%;
}

.code-editor-container {
  width: 100%;
  height: 100%;
  /* 普通卡片没有固定父级高度时，内层容器必须继承最小高度，否则会被算成 0 高度，
     只剩一条横线且无法输入。 */
  min-height: inherit;
  overflow: hidden;
  background: var(--dd-editor-bg-color, #111827);
  /* 固定 0、不吃 --dd-radius-*：这是一整块代码面，四角由外层卡片自己裁，
     这里再加圆角只会和卡片的圆角叠出双层圆角。改造前也是 0，保持不变。 */
  border-radius: 0;
}

.code-editor-container :deep(.cm-editor) {
  height: 100%;
}

/* 触摸滚动惯性：手机上编辑长脚本时没有它会明显发涩 */
.code-editor-container :deep(.cm-scroller) {
  -webkit-overflow-scrolling: touch;
}

/* 折叠箭头：字色继承 .cm-gutters（主题里按明暗算好的行号色），
   这里只压一点不透明度，免得比行号本身还抢眼。故意不写具体颜色 —— 编辑器底色是用户可配项，
   写死的颜色在深色底或自定义底色上会串色。 */
.code-editor-container :deep(.cm-foldGutter span) {
  opacity: 0.65;
}

.code-editor-container :deep(.cm-foldGutter span:hover) {
  opacity: 1;
}

/* 折叠后的「…」占位块。必须自己覆盖：CodeMirror 基础主题把它写死成浅色
   （#eee 底 + #ddd 边 + #888 字，见 @codemirror/language 的 baseTheme），
   深色编辑器上会糊出一块亮斑。改成透明底 + currentColor 描边后，
   颜色完全跟着 --dd-editor-fg-color 走，明暗与用户自定义底色都不会串。 */
.code-editor-container :deep(.cm-foldPlaceholder) {
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  opacity: 0.7;
}

/* iOS Safari 在可编辑区字号小于 16px 时，聚焦会自动把整页放大。
   index.html 的 viewport 刻意没有 maximum-scale（加了会禁掉用户手动缩放，不可接受），
   所以只能反过来把移动端的编辑器字号提到 16px 来规避。 */
@media (max-width: 768px) {
  .code-editor-wrapper {
    font-size: 16px;
  }
}
</style>
