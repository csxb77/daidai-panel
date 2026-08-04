<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import type * as MonacoType from "monaco-editor";
import { defineMonacoTheme, loadMonacoEditor } from "@/utils/monaco";
import { PANEL_APPEARANCE_CHANGE_EVENT } from "@/utils/panelAppearance";
import LoadingMotion from "./LoadingMotion.vue";

const props = defineProps<{
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
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const editorRef = ref<HTMLElement>();
const isLoading = ref(true);
const loadError = ref("");
let editor: MonacoType.editor.IStandaloneCodeEditor | null = null;
let monacoInstance: typeof MonacoType | null = null;
let resizeObserver: ResizeObserver | null = null;
let layoutFrame: number | null = null;

function scheduleEditorLayout() {
  if (layoutFrame !== null) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = null;
    editor?.layout();
  });
}

// 明暗主题切换或系统设置改色后，重新注册主题并切换过去。
// defineTheme 只在挂载时跑一次的话，已挂载的编辑器不会变色。
function syncEditorTheme() {
  if (!monacoInstance) return;
  const theme = defineMonacoTheme(monacoInstance);
  monacoInstance.editor.setTheme(theme.themeName);
}

onMounted(async () => {
  window.addEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);

  if (!editorRef.value) return;

  try {
    loadError.value = "";
    const { monaco, source } = await loadMonacoEditor();
    monacoInstance = monaco as typeof MonacoType;
    if (!editorRef.value) return;
    const container = editorRef.value;
    const theme = defineMonacoTheme(monacoInstance);

    editor = monacoInstance.editor.create(container, {
      value: props.modelValue,
      language: props.language || "javascript",
      theme: theme.themeName,
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      readOnly: props.readonly || false,
      tabSize: 2,
      wordWrap: "on",
    });

    // automaticLayout 已经会跟随容器尺寸，但撑满模式下高度来自 flex 链，
    // 这里再挂一层 ResizeObserver 兜底，避免拖窗口/折叠侧栏后编辑器错位。
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        scheduleEditorLayout();
      });
      resizeObserver.observe(container);
    }

    if (source === "cdn") {
      console.warn("Monaco 编辑器当前已回退到 CDN 资源。");
    }

    editor!.onDidChangeModelContent(() => {
      if (editor) {
        emit("update:modelValue", editor.getValue());
      }
    });
  } catch (error) {
    console.error("Monaco 编辑器初始化失败", error);
    loadError.value = "编辑器加载失败，请检查网络或稍后重试。";
  } finally {
    isLoading.value = false;
  }
});

watch(
  () => props.modelValue,
  (newValue) => {
    if (editor && newValue !== editor.getValue()) {
      editor.setValue(newValue);
    }
  },
);

watch(
  () => props.language,
  (newLang) => {
    if (editor && monacoInstance) {
      const model = editor.getModel();
      if (model) {
        monacoInstance.editor.setModelLanguage(model, newLang || "javascript");
      }
    }
  },
);

watch(
  () => props.readonly,
  (newReadonly) => {
    if (editor) {
      editor.updateOptions({ readOnly: newReadonly });
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);
  if (layoutFrame !== null) {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
  editor?.dispose();
  editor = null;
});

defineExpose({
  format: () => {
    if (editor) {
      editor.getAction("editor.action.formatDocument")?.run();
    }
  },
  focus: () => editor?.focus(),
  getValue: () => editor?.getValue() || "",
  setValue: (value: string) => editor?.setValue(value),
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
    class="monaco-editor-wrapper"
    :class="{ 'monaco-editor-wrapper--fill': props.fillHeight }"
    :style="{ '--monaco-editor-min-height': resolveMinHeight(props.minHeight) }"
  >
    <div v-if="isLoading" class="monaco-loading">
      <LoadingMotion
        variant="spinner"
        size="lg"
        label="编辑器加载中..."
        tone="primary"
      />
    </div>
    <div v-else-if="loadError" class="monaco-loading monaco-error">
      <span>{{ loadError }}</span>
    </div>
    <div
      ref="editorRef"
      class="monaco-editor-container"
      v-show="!isLoading && !loadError"
    ></div>
  </div>
</template>

<style scoped>
.monaco-editor-wrapper {
  width: 100%;
  min-height: var(--monaco-editor-min-height, 400px);
  height: var(--monaco-editor-min-height, 400px);
  position: relative;
}

/* 双类选择器：靠特异性压过上面的固定高度，不依赖样式表书写顺序 */
.monaco-editor-wrapper.monaco-editor-wrapper--fill {
  flex: 1 1 auto;
  height: 100%;
}

/* 撑满模式下 loading 占位跟随外层实际下限，避免调用方在窄屏补下限后加载态只剩一小条 */
.monaco-editor-wrapper--fill .monaco-loading {
  min-height: inherit;
}

.monaco-editor-container {
  width: 100%;
  height: 100%;
  /* Monaco 初始化时只读取容器 clientHeight。
     普通卡片没有固定父级高度时，内层容器必须继承最小高度，否则会被算成 0 高度，只剩一条横线且无法输入。 */
  min-height: inherit;
}

.monaco-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: var(--monaco-editor-min-height, 400px);
  gap: 12px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  background: var(--dd-editor-bg-color, #111827);
  color: var(--dd-editor-fg-color, #e5e7eb);
  border-radius: 0;
}

.monaco-error {
  color: #f56c6c;
  text-align: center;
}
</style>
