<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import type * as MonacoType from "monaco-editor";
import { defineMonacoTheme, loadMonacoEditor } from "@/utils/monaco";
import { PANEL_APPEARANCE_CHANGE_EVENT } from "@/utils/panelAppearance";
import LoadingMotion from "./LoadingMotion.vue";

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

const editorRef = ref<HTMLElement>();
const isLoading = ref(true);
const loadError = ref("");
let editor: MonacoType.editor.IStandaloneDiffEditor | null = null;
let monacoInstance: typeof MonacoType | null = null;
let originalModel: MonacoType.editor.ITextModel | null = null;
let modifiedModel: MonacoType.editor.ITextModel | null = null;
let resizeObserver: ResizeObserver | null = null;
let layoutTimer: ReturnType<typeof setTimeout> | null = null;

// 明暗主题切换或系统设置改色后，重新注册主题并切换过去。
// defineTheme 只在挂载时跑一次的话，已挂载的编辑器不会变色。
function syncEditorTheme() {
  if (!monacoInstance) return;
  const theme = defineMonacoTheme(monacoInstance);
  monacoInstance.editor.setTheme(theme.themeName);
}

function disposeModels() {
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
}

function createModels() {
  if (!monacoInstance) return;

  disposeModels();
  originalModel = monacoInstance.editor.createModel(
    props.originalValue,
    props.language,
  );
  modifiedModel = monacoInstance.editor.createModel(
    props.modifiedValue,
    props.language,
  );
  editor?.setModel({
    original: originalModel,
    modified: modifiedModel,
  });
}

function clearLayoutTimer() {
  if (layoutTimer) {
    clearTimeout(layoutTimer);
    layoutTimer = null;
  }
}

function scheduleEditorLayout(delay = 0) {
  clearLayoutTimer();
  layoutTimer = setTimeout(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        editor?.layout();
      });
    });
  }, delay);
}

onMounted(async () => {
  window.addEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);

  if (!editorRef.value) return;

  try {
    loadError.value = "";
    const { monaco, source } = await loadMonacoEditor();
    monacoInstance = monaco as typeof MonacoType;
    if (!editorRef.value) return;
    isLoading.value = false;
    await nextTick();

    const theme = defineMonacoTheme(monacoInstance);

    editor = monacoInstance.editor.createDiffEditor(editorRef.value, {
      theme: theme.themeName,
      automaticLayout: true,
      readOnly: props.readonly,
      originalEditable: false,
      renderSideBySide: props.renderSideBySide,
      ignoreTrimWhitespace: props.ignoreTrimWhitespace,
      enableSplitViewResizing: true,
      scrollBeyondLastLine: false,
      fontSize: 14,
      minimap: { enabled: false },
      wordWrap: "on",
      diffWordWrap: "on",
      hideUnchangedRegions: {
        enabled: props.hideUnchangedRegions,
        contextLineCount: props.contextLineCount,
        minimumLineCount: 2,
      },
    });

    createModels();
    scheduleEditorLayout(30);

    if (typeof ResizeObserver !== "undefined" && editorRef.value) {
      resizeObserver = new ResizeObserver(() => {
        scheduleEditorLayout();
      });
      resizeObserver.observe(editorRef.value);
    }

    if (source === "cdn") {
      console.warn("Monaco Diff 编辑器当前已回退到 CDN 资源。");
    }
  } catch (error) {
    console.error("Monaco Diff 编辑器初始化失败", error);
    loadError.value = "对比编辑器加载失败，请检查网络或稍后重试。";
  } finally {
    if (loadError.value) {
      isLoading.value = false;
    }
  }
});

watch(
  () => props.originalValue,
  (newValue) => {
    if (originalModel && newValue !== originalModel.getValue()) {
      originalModel.setValue(newValue);
      scheduleEditorLayout();
    }
  },
);

watch(
  () => props.modifiedValue,
  (newValue) => {
    if (modifiedModel && newValue !== modifiedModel.getValue()) {
      modifiedModel.setValue(newValue);
      scheduleEditorLayout();
    }
  },
);

watch(
  () => props.language,
  (newLanguage) => {
    if (!monacoInstance) return;
    if (originalModel) {
      monacoInstance.editor.setModelLanguage(
        originalModel,
        newLanguage || "plaintext",
      );
    }
    if (modifiedModel) {
      monacoInstance.editor.setModelLanguage(
        modifiedModel,
        newLanguage || "plaintext",
      );
    }
    scheduleEditorLayout();
  },
);

watch(
  () => props.readonly,
  (newReadonly) => {
    editor?.updateOptions({ readOnly: newReadonly });
    scheduleEditorLayout();
  },
);

watch(
  () => props.renderSideBySide,
  (newValue) => {
    editor?.updateOptions({ renderSideBySide: newValue });
    scheduleEditorLayout(20);
  },
);

watch(
  () => props.ignoreTrimWhitespace,
  (newValue) => {
    editor?.updateOptions({ ignoreTrimWhitespace: newValue });
    scheduleEditorLayout(20);
  },
);

watch(
  () => props.hideUnchangedRegions,
  (newValue) => {
    editor?.updateOptions({
      hideUnchangedRegions: {
        enabled: newValue,
        contextLineCount: props.contextLineCount,
        minimumLineCount: 2,
      },
    });
    scheduleEditorLayout(20);
  },
);

watch(
  () => props.contextLineCount,
  (newValue) => {
    editor?.updateOptions({
      hideUnchangedRegions: {
        enabled: props.hideUnchangedRegions,
        contextLineCount: newValue,
        minimumLineCount: 2,
      },
    });
    scheduleEditorLayout(20);
  },
);

onBeforeUnmount(() => {
  window.removeEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);
  clearLayoutTimer();
  resizeObserver?.disconnect();
  resizeObserver = null;
  editor?.setModel(null);
  editor?.dispose();
  editor = null;
  disposeModels();
});
</script>

<template>
  <div class="monaco-diff-wrapper">
    <div ref="editorRef" class="monaco-diff-container"></div>
    <div v-if="isLoading" class="monaco-diff-loading monaco-diff-overlay">
      <LoadingMotion
        variant="spinner"
        size="lg"
        label="对比编辑器加载中..."
        tone="primary"
      />
    </div>
    <div
      v-else-if="loadError"
      class="monaco-diff-loading monaco-diff-error monaco-diff-overlay"
    >
      <span>{{ loadError }}</span>
    </div>
  </div>
</template>

<style scoped>
.monaco-diff-wrapper {
  width: 100%;
  height: 100%;
  min-height: 420px;
  position: relative;
  overflow: hidden;
}

.monaco-diff-container {
  width: 100%;
  height: 100%;
}

.monaco-diff-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 420px;
  gap: 12px;
  background: var(--dd-editor-bg-color, #111827);
  color: var(--dd-editor-fg-color, #e5e7eb);
  border-radius: 0;
  font-size: 14px;
}

.monaco-diff-overlay {
  position: absolute;
  inset: 0;
}

.monaco-diff-error {
  color: #f56c6c;
  text-align: center;
}
</style>
