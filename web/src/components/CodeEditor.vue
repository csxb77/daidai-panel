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

/**
 * 三个「视图类」开关（issue #114-1/2/3）：缩略图、缩进参考线、空白符。
 *
 * 这三个和上面的自动换行是同一类东西（个人编辑习惯、每浏览器独立、脚本页与配置文件页共享），
 * 但**没有**照抄成三组「常量 + 读 + 写」—— 那是 6 个逐字雷同的函数。
 * 上面自动换行那组保持原样不动，是因为它的具名导出写进了组件契约（见
 * spec/frontend/component-guidelines.md），不能改签名。
 *
 * 默认值刻意各不相同，判据是「打开它会不会打扰到不需要它的人」：
 *   - 缩进参考线：默认开。它就是为了让缩进层级一眼看清，噪声极低。
 *   - 缩略图：默认关。它要占掉正文右侧 64px，窄屏尤其肉疼。
 *   - 空白符：默认关。每个空格一个灰点，读配置文件时纯属干扰。
 */
export type EditorViewOption = "minimap" | "indent_guides" | "whitespace";

const EDITOR_VIEW_OPTION_KEYS: Record<EditorViewOption, string> = {
  minimap: "dd:editor:minimap",
  indent_guides: "dd:editor:indent_guides",
  whitespace: "dd:editor:whitespace",
};

const EDITOR_VIEW_OPTION_DEFAULTS: Record<EditorViewOption, boolean> = {
  minimap: false,
  indent_guides: true,
  whitespace: false,
};

export function readStoredEditorViewOption(name: EditorViewOption): boolean {
  const fallback = EDITOR_VIEW_OPTION_DEFAULTS[name];
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    // 只认写死的 'on' / 'off' 两个值，其余（没写过、被人改成脏值、读不到）一律回落默认，
    // 这样「用户从没碰过这个开关」和「存储被清掉了」表现一致。
    const raw = window.localStorage.getItem(EDITOR_VIEW_OPTION_KEYS[name]);
    if (raw === "on") return true;
    if (raw === "off") return false;
    return fallback;
  } catch {
    // 隐私模式 / 禁用站点存储时 getItem 会抛错，不能让它把调用方的 setup 整块炸掉
    return fallback;
  }
}

export function persistEditorViewOption(name: EditorViewOption, value: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      EDITOR_VIEW_OPTION_KEYS[name],
      value ? "on" : "off",
    );
  } catch {
    // 写失败只是这次记不住，不影响本次切换效果，静默忽略
  }
}
</script>

<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
} from "vue";
import CodeMirrorEditor from "./CodeMirrorEditor.vue";
import {
  EDITOR_ENGINE_CHANGE_EVENT,
  readStoredEditorEngine,
  resolveEditorEngine,
} from "@/utils/editorEngine";

/**
 * 代码编辑器（引擎分发层）。
 *
 * 本组件自己**不渲染任何编辑器**，只负责按用户的引擎偏好在两份实现之间二选一：
 *   - CodeMirrorEditor.vue：默认引擎，也是**移动端唯一**引擎。内容区是 contenteditable、
 *     选区就是原生 Selection，「长按出系统菜单 / 双击出选择手柄 / 按住拖动光标」天然可用。
 *   - MonacoEditor.vue：桌面端可选。多光标、列选、JSON 语言服务那套更强，
 *     但它是自绘编辑器，上面三条**无论怎么配都做不到**。
 * 两份实现的 props / emit / defineExpose / 根 class 逐字相同，调用点感知不到拿到的是哪一个。
 *
 * 上面那个普通 `<script>` 块里的 6 个具名导出（自动换行与三个视图开关各一组「类型 + 读 + 写」）
 * 刻意**留在本文件**：
 * 它们是写进 spec/frontend/component-guidelines.md 的组件契约，两个页面按名字引用。
 * 两个引擎实现**不从这里 import 任何东西**（这些偏好的值是页面读出来、当 prop 传进去的），
 * 所以「分发层 import 实现、实现 import 分发层」的循环依赖不存在。
 *
 * 🔴 模板是**单个** `<component :is>` 根节点，不套 wrapper `<div>`、也不在根上放注释
 * （dev 构建会保留注释节点，根就变成 Fragment，透传要靠 DEV_ROOT_FRAGMENT 那套 dev 专用机制兜，
 * 平白让 dev 与 prod 走两条不同的路径）。理由：
 *   - 三个调用点靠 $attrs 穿透给编辑器根节点加样式 —— ScriptsEditorPane 传
 *     `class="code-editor"`（scoped 规则 `.code-editor { flex: 1; height: 100%; min-height: 0 }`），
 *     调试弹窗与代码运行器传内联 `style="height: 100%; min-height: 0"`。
 *     套一层 div 之后这些 class / style 会落在那层 div 上，真正的编辑器根节点一点样式都拿不到，
 *     表现是编辑器高度塌陷，而构建与类型检查全绿。
 *   - 同理本文件刻意**没有** `<style>` 块：scoped 样式只能命中子组件的根节点，
 *     `.code-editor-container` 和那几条 `:deep(.cm-*)` 都命中不到，它们必须跟着各自的实现走。
 *
 * 模板里 props 一个个显式列出而不是 `v-bind="props"`：逐个列 vue-tsc 才能逐个查类型，
 * 一把梭传下去的话，两边 prop 名写歪了也发现不了。
 */

// Monaco 用异步组件引入，这是「不切过去的用户一个字节都不下载」的落点：
// 静态 import 会让 Rollup 把 MB 级的 monaco chunk 提升成入口的静态依赖，
// 构建全绿、页面能用，纯静默劣化。CodeMirror 是默认引擎、绝大多数会话都要用，静态引入即可。
// 刻意不给 loadingComponent：Monaco chunk 是同源本地资源，解析通常在一帧内完成，
// 塞个骨架屏反而会闪一下。
const MonacoEditor = defineAsyncComponent(() => import("./MonacoEditor.vue"));

// ⚠️ props 必须与两份实现**逐字相同**，并且下面模板里要一个个显式传下去。
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
    /**
     * 右侧代码缩略图。默认 false。
     * ⚠️ 下面三个 prop 的默认值一律等于「加这些功能之前的行为」，
     * 所以不传它们的调用点（调试弹窗 / 代码运行器）一个像素都不会变。
     * 脚本页与配置文件页会显式传各自记住的偏好。
     */
    minimap?: boolean;
    /** 缩进参考线。默认 false（同上，偏好本身的默认值是开，由页面侧决定） */
    indentGuides?: boolean;
    /** 显示空白符：空格画灰点、Tab 画箭头、行尾空白标底色。默认 false */
    showWhitespace?: boolean;
  }>(),
  {
    wordWrap: "on",
    minimap: false,
    indentGuides: false,
    showWhitespace: false,
  },
);

// emit 必须显式声明：不声明的话 update:modelValue 会退化成透传的 $attrs 事件，
// 调用点 v-model 的类型检查当场失效（值类型变成 any，写错了也查不出来）。
const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

/** 两个引擎实现共同暴露的方法集，与它们各自 defineExpose 的四个键逐字对应。 */
interface EditorEngineExposed {
  focus: () => void;
  getValue: () => string;
  setValue: (value: string) => void;
  format: () => void;
}

const engineRef = ref<EditorEngineExposed | null>(null);

// 挂载时解析一次。auto 的设备判定（coarse pointer / 窄屏硬回落 CodeMirror）在
// utils/editorEngine.ts 里，本文件不重复一份判断。
const engine = ref(resolveEditorEngine(readStoredEditorEngine()));

// 菜单里切引擎 → persistEditorEngine 派发 EDITOR_ENGINE_CHANGE_EVENT → 这里重新解析。
// 这就是「切一下，已经开着的编辑器跟着换」的全部机制；少了它的表现是
// 「菜单里选了、当前这个编辑器纹丝不动，要刷新页面才生效」，不报错。
// 重新读一遍 localStorage 而不是从事件里取值：偏好可能是在另一个组件里改的，
// 存储才是唯一真源。
function syncEngine() {
  engine.value = resolveEditorEngine(readStoredEditorEngine());
}

onMounted(() => {
  window.addEventListener(EDITOR_ENGINE_CHANGE_EVENT, syncEngine);
});

onBeforeUnmount(() => {
  window.removeEventListener(EDITOR_ENGINE_CHANGE_EVENT, syncEngine);
});

// 引擎变了 → 组件类型变了 → Vue 会卸载旧实例、挂载新实例（不用额外给 key）。
// 撤销历史与滚动位置会丢，这是换引擎不可避免的代价，也符合用户「我要换一个编辑器」的预期。
const engineComponent = computed(() =>
  engine.value === "monaco" ? MonacoEditor : CodeMirrorEditor,
);

// 显式转发而不是让 v-model 事件走 $attrs：上面声明了 emits，事件就不在 $attrs 里了。
// 写成具名函数（而不是模板里的 `emit('update:modelValue', $event)`）是为了给 $event 一个
// 确定的类型 —— 动态组件上的事件参数会被推成隐式 any。
function onInnerUpdate(value: string) {
  emit("update:modelValue", value);
}

defineExpose({
  focus: () => engineRef.value?.focus(),
  // ⚠️ 必须用 props.modelValue 兜底，不能写成 `?? ""`：
  // Monaco 是异步组件，chunk 还没 resolve 时 engineRef 是 null，返回空串会让调用方
  // 以为「文档是空的」并据此覆盖掉真实内容。回落到 modelValue 才是当下真正的文档。
  getValue: () => engineRef.value?.getValue() ?? props.modelValue,
  setValue: (value: string) => engineRef.value?.setValue(value),
  // 全仓没有调用点，两份实现里也都是空的；这里只做转发，保持对外契约不变。
  format: () => engineRef.value?.format(),
});
</script>

<template>
  <component
    :is="engineComponent"
    ref="engineRef"
    :model-value="props.modelValue"
    :language="props.language"
    :readonly="props.readonly"
    :min-height="props.minHeight"
    :fill-height="props.fillHeight"
    :word-wrap="props.wordWrap"
    :minimap="props.minimap"
    :indent-guides="props.indentGuides"
    :show-whitespace="props.showWhitespace"
    @update:model-value="onInnerUpdate"
  />
</template>
