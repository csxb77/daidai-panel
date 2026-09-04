<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { defineMonacoTheme, resolveMonacoLanguage } from "@/utils/codeEditor";
import { PANEL_APPEARANCE_CHANGE_EVENT } from "@/utils/panelAppearance";
// ⚠️ 只能是 `import type`：MonacoApi 是纯类型，type 关键字保证这一行被 TS 完全擦掉、
// 不产生任何运行时导入。漏掉它就等于给本文件加了一条对 monacoEngine 的静态 import，
// monaco chunk 会被 Rollup 提升成入口的静态依赖 —— 构建全绿、页面能用，纯静默劣化。
// 真正的 Monaco 实例只在 onMounted 里通过 `await import('@/utils/monacoEngine')` 取。
import type { MonacoApi } from "@/utils/monacoEngine";

/**
 * 代码编辑器的 Monaco 实现（v3.2.2 起的**可选**第二引擎）。
 *
 * 定位：CodeMirror 6（CodeMirrorEditor.vue）仍是默认引擎与**移动端唯一**引擎。
 * Monaco 是自绘编辑器，触摸事件由它内部的手势层接管，
 * 「长按出系统菜单 / 双击出选择手柄 / 按住拖动光标」三条无论怎么配都做不到 ——
 * 这正是 v3.2.0 换引擎的全部理由，别在这里想办法「补回来」，补不了。
 * 它换来的是多光标、列选、代码折叠、JSON 语言服务那套重型能力，给桌面端用户按需选。
 *
 * 对外 props / emit / defineExpose 与 CodeMirrorEditor.vue **逐字相同**：
 * 两个实现是同一个契约的两份实现，由 CodeEditor.vue 按引擎偏好分发，
 * 调用点感知不到自己拿到的是哪一个。任何一边加 prop，另一边必须同步加，
 * 否则表现是「切个引擎某个开关就没反应了」，不报错。
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
    /** 自动换行。默认 'on'，与 CodeMirror 侧一致。 */
    wordWrap?: "on" | "off";
    /** 右侧代码缩略图。默认 false（默认值三条与 CodeMirror 侧逐字对齐）。 */
    minimap?: boolean;
    /** 缩进参考线。默认 false（偏好本身的默认值是开，由页面侧决定） */
    indentGuides?: boolean;
    /** 显示空白符：空格画灰点、Tab 画箭头。默认 false */
    showWhitespace?: boolean;
  }>(),
  {
    wordWrap: "on",
    minimap: false,
    indentGuides: false,
    showWhitespace: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

/**
 * 等宽字体栈。与 utils/codeEditor.ts 的 EDITOR_FONT_FAMILY **逐字相同**，改一边就要改另一边。
 * 没有直接引用那个常量是因为它没有导出（那边它只服务于 CodeMirror 的 EditorView.theme），
 * 而本文件宁可重复一行字符串，也不去改动 codeEditor.ts 的导出面。
 * 不一致的表现是「切个引擎字形就变了」，不报错。
 */
const EDITOR_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

// 从 create() 的返回值反推实例类型，而不是 import Monaco 的 IStandaloneCodeEditor：
// 全仓只有 utils/monacoEngine.ts 可以出现 `from 'monaco-editor/...'`（见那个文件顶部）。
type MonacoStandaloneEditor = ReturnType<MonacoApi["editor"]["create"]>;

const editorRef = ref<HTMLElement>();
let editor: MonacoStandaloneEditor | null = null;
// 存下 monaco 命名空间：换语言（setModelLanguage）与换主题（defineTheme/setTheme）
// 都是挂在命名空间上的模块级函数，不是实例方法，拿不到实例就够。
let monacoApi: MonacoApi | null = null;
// onDidChangeModelContent 的订阅句柄。类型写成结构化最小形状，理由同上（不引 IDisposable）。
let contentSubscription: { dispose(): void } | null = null;
// 组件是否已卸载。onMounted 是 async 的，见下面 create 前那道守卫。
let destroyed = false;

/**
 * 定义并应用主题。
 *
 * ⚠️ 必须整套重来，不能只在「明暗翻转了」时才跑：
 * Monaco 的 colors 表只吃字面 hex，塞不进 `var(--dd-editor-bg-color, ...)`
 * （塞了会被解析成 Color.red，一片正红），所以底色是被**烘进**主题数据里的。
 * 用户只改了编辑器底色、没切明暗时，CodeMirror 侧靠 var() 自动重绘、主题都不用动，
 * Monaco 侧却必须重新 defineTheme —— 少了这一步的表现是「设置里改了底色，
 * Monaco 编辑器纹丝不动」。详见 utils/codeEditor.ts 的 defineMonacoTheme 注释。
 *
 * defineTheme 同名覆盖后 Monaco 会自动刷新正在用该主题的实例；
 * 但明暗翻转时主题名会变（dd-editor-dark ⇄ dd-editor-light），所以 setTheme 那句不能省。
 */
function applyEditorTheme(monaco: MonacoApi) {
  const { themeName } = defineMonacoTheme(monaco);
  monaco.editor.setTheme(themeName);
}

// 明暗切换、以及用户在系统设置里改编辑器底色，都会走 PANEL_APPEARANCE_CHANGE_EVENT
// （切主题那一路见 stores/theme.ts：toggle 完立刻 applyPanelAppearance()）。
function syncEditorTheme() {
  if (!monacoApi) return;
  applyEditorTheme(monacoApi);
}

// 写回文档前先比一次：setValue 会触发 onDidChangeModelContent，
// 不比就和父组件转成回环（CodeMirror 侧的 replaceDoc 是同一个思路）。
function replaceValue(value: string) {
  if (!editor) return;
  if (editor.getValue() === value) return;
  editor.setValue(value);
}

onMounted(async () => {
  // 监听器在 await 之前就挂上，卸载时统一摘掉；即使 Monaco 最终没加载成也不会漏挂/漏摘。
  window.addEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);
  if (!editorRef.value) return;

  // 全仓唯一的 Monaco 取用姿势：动态 import。不切到 Monaco 的用户一个字节都不下载。
  const { monaco } = await import("@/utils/monacoEngine");

  // ⚠️ await 期间组件完全可能已经被卸载了（脚本页切文件、调试弹窗被关、引擎又切回 CodeMirror），
  // 那时 onBeforeUnmount 早就跑完了。少了这道守卫就会往一个已经从文档里摘掉的 DOM 节点上
  // create 出一个**永远不会被 dispose** 的实例：它的 ResizeObserver、全局事件监听、模型
  // 全都留在内存里，而页面上什么都看不到。
  if (destroyed || !editorRef.value) return;

  monacoApi = monaco;
  // 先定主题再 create：setTheme 是全局的、不需要实例，这样新实例第一帧就是对的颜色，
  // 不会先闪一下 Monaco 自带的 vs / vs-dark。
  applyEditorTheme(monaco);

  editor = monaco.editor.create(editorRef.value, {
    value: props.modelValue,
    language: resolveMonacoLanguage(props.language),
    readOnly: props.readonly || false,
    wordWrap: props.wordWrap,
    minimap: { enabled: props.minimap },
    guides: { indentation: props.indentGuides },
    // ⚠️ 必须显式给：renderWhitespace 的默认值是 'selection'（只在选中时显示），
    // 不写的话「显示空白符」这个开关关掉时看着正常、打开时也看着正常，
    // 但关掉的状态其实是「选中才显示」而不是「不显示」，等于功能没生效。
    renderWhitespace: props.showWhitespace ? "all" : "none",
    // ⚠️ 也必须显式给：renderLineHighlight 的默认值是 'line'，只涂内容区、**不涂行号栏那一格**。
    // 而 CodeMirror 侧同时开了 highlightActiveLine() 与 highlightActiveLineGutter()，
    // 主题里 .cm-activeLine 与 .cm-activeLineGutter 两处铺的是同一个底色。
    // 不给 'all' 的话，同一份脚本换个引擎当前行就少了行号栏那半截底色，观感对不上。
    // （写死的常量、不跟任何开关走，所以下面那批 watch 里没有它的份。）
    renderLineHighlight: "all",
    // 让 Monaco 自己装 ResizeObserver 盯容器尺寸：三个调用点的高度都由外层 flex 链决定
    // （撑满卡片 / 撑满弹窗），不给这条就得自己在每次布局变化时调 layout()。
    automaticLayout: true,
    // 缩进 2 空格，与 CodeMirror 侧的 indentUnit.of("  ") + EditorState.tabSize.of(2) 对齐
    tabSize: 2,
    insertSpaces: true,
    fontSize: 14,
    fontFamily: EDITOR_FONT_FAMILY,
    // 不允许滚到最后一行以下的空白区：编辑器本来就嵌在有限高度的卡片里，
    // 多出一屏空白只会让人以为内容没加载完
    scrollBeyondLastLine: false,
  });

  contentSubscription = editor.onDidChangeModelContent(() => {
    const value = editor?.getValue() ?? "";
    // 和外部 modelValue 相同，说明这次变更是 replaceValue 同步进来的，
    // 再 emit 一次就和父组件转成回环了。
    if (value === props.modelValue) return;
    // 每次输入即时 emit，不能等失焦：
    // 「未保存」角标、保存按钮 disabled、调试弹窗的 markDebugCodeChanged 全靠它。
    emit("update:modelValue", value);
  });
});

watch(
  () => props.modelValue,
  (newValue) => {
    replaceValue(newValue);
  },
);

/**
 * ⚠️ 下面每一条 watch 都是必需的，理由与 CodeMirror 侧「必须用 Compartment」是同一条铁律的另一半：
 * Monaco 的 options 也只在 create() 那一刻读一次，挂载之后再点开关是**完全没反应且不报错**的，
 * 构建与 vue-tsc 全绿。运行期改配一律走 editor.updateOptions()，换语言走 setModelLanguage()。
 * 新增可配项时「create 的 options + updateOptions + watch」三处必须一起补。
 */

// 脚本页切换文件会换语言，必须重设，否则一直停在第一次打开那个文件的高亮上。
// 语言挂在**模型**上而不是编辑器上，所以不能走 updateOptions（那里的 language 只对 create 生效）。
watch(
  () => props.language,
  (newLanguage) => {
    const model = editor?.getModel();
    if (!model || !monacoApi) return;
    monacoApi.editor.setModelLanguage(model, resolveMonacoLanguage(newLanguage));
  },
);

// 漏了这条就是「只读态还能改」：改完污染 hasChanges，退出编辑时弹出幽灵「有未保存改动」
watch(
  () => props.readonly,
  (newReadonly) => {
    editor?.updateOptions({ readOnly: newReadonly || false });
  },
);

watch(
  () => props.wordWrap,
  (newWordWrap) => {
    editor?.updateOptions({ wordWrap: newWordWrap });
  },
);

watch(
  () => props.minimap,
  (enabled) => {
    editor?.updateOptions({ minimap: { enabled } });
  },
);

watch(
  () => props.indentGuides,
  (enabled) => {
    editor?.updateOptions({ guides: { indentation: enabled } });
  },
);

// 同 create 时那条：关掉必须给 'none'，给回默认的 'selection' 等于没关干净
watch(
  () => props.showWhitespace,
  (enabled) => {
    editor?.updateOptions({ renderWhitespace: enabled ? "all" : "none" });
  },
);

onBeforeUnmount(() => {
  // 先立旗再做别的：onMounted 里的动态 import 可能还挂在 await 上，
  // 这面旗子是它 create 之前那道守卫的唯一依据。
  destroyed = true;
  window.removeEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);
  contentSubscription?.dispose();
  contentSubscription = null;
  // 模型必须在 dispose 编辑器**之前**取出来：dispose 之后 getModel() 返回 null，就没得回收了。
  const model = editor?.getModel() ?? null;
  editor?.dispose();
  // standalone editor 对「自己创建的」那个模型会在 detach 时顺手 dispose（内部的 _ownsModel），
  // 所以这里先问一句 isDisposed()，否则是一次重复 dispose。
  // 仍然显式写这一段，是因为「谁拥有模型」属于 Monaco 的内部实现细节：
  // 哪天它不再代管，漏掉的表现是每开一个文件泄漏一份全文加一整棵撤销树，用久了才吃内存。
  if (model && !model.isDisposed()) {
    model.dispose();
  }
  editor = null;
  monacoApi = null;
});

defineExpose({
  focus: () => editor?.focus(),
  getValue: () => editor?.getValue() ?? "",
  setValue: (value: string) => replaceValue(value),
  // 全仓没有调用点：格式化走后端 scriptApi.format，前端不做本地格式化。
  // ⚠️ 刻意与 CodeMirror 侧一样留空，**不要**改成
  // `editor.getAction('editor.action.formatDocument')?.run()` —— 那会让两个引擎在一个
  // 谁都不调的方法上行为不一致，而且只有 JSON 这类带语言服务的语言才真能格式化，
  // 其余语言静默什么都不做，将来谁真去调它反而更难查。
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
/* 🔴 根 class 与 --code-editor-min-height 这个变量名必须与 CodeMirrorEditor.vue **逐字相同**，
   不能叫 monaco-editor-wrapper / --monaco-editor-min-height：
   config-file/index.vue 有一条 `:deep(.code-editor-wrapper) { min-height: 560px }` 给窄屏兜下限，
   ScriptsEditorPane.vue 那条 `.code-editor { flex: 1 }` 也是穿透到这个根节点上的。
   换个名字之后两页的高度约束会一起失灵、编辑器高度塌陷，而构建与类型检查全绿。 */
.code-editor-wrapper {
  width: 100%;
  min-height: var(--code-editor-min-height, 400px);
  height: var(--code-editor-min-height, 400px);
  position: relative;
}

/* 双类选择器：靠特异性压过上面的固定高度，不依赖样式表书写顺序 */
.code-editor-wrapper.code-editor-wrapper--fill {
  flex: 1 1 auto;
  height: 100%;
}

/* 这里刻意**没有** CodeMirror 侧那条 `font-size: 14px` 与 ≤768px 提到 16px 的媒体查询：
   Monaco 是自绘编辑器，正文字号来自 JS 侧的 fontSize 选项，不吃容器的 CSS font-size，
   写了也只是死代码。iOS 那条「输入区小于 16px 会自动放大整页」的规避也就无从谈起 ——
   真正的答案是 Monaco 本来就不该出现在手机上（utils/editorEngine.ts 里 auto 在 coarse pointer
   与窄屏上硬回落 CodeMirror）；显式把引擎选成 monaco 的用户是自己做的选择。 */

.code-editor-container {
  width: 100%;
  height: 100%;
  /* 普通卡片没有固定父级高度时，内层容器必须继承最小高度，否则会被算成 0 高度，
     只剩一条横线且无法输入。 */
  min-height: inherit;
  overflow: hidden;
  /* 与 CodeMirror 侧同一条底色变量。Monaco 自己也会按主题涂底，
     但主题是在动态 import 落地之后才应用的，这条负责那之前那几帧不露出页面底色。 */
  background: var(--dd-editor-bg-color, #111827);
  /* 固定 0、不吃 --dd-radius-*：这是一整块代码面，四角由外层卡片自己裁，
     这里再加圆角只会和卡片的圆角叠出双层圆角。与 CodeMirror 侧保持一致。 */
  border-radius: 0;
}
</style>
