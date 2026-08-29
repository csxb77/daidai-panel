<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import type * as MonacoType from "monaco-editor";
import {
  canRetryMonacoInPlace,
  defineMonacoTheme,
  getMonacoLoadErrorMessage,
  loadMonacoEditor,
} from "@/utils/monaco";
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
// @monaco-editor/loader 的 init() 单例一旦 reject 就永久失败，页内重试拿到的还是同一个错误。
// 这种情况下只能提示刷新页面，不能给一个点了没反应的「重新加载」按钮。
const canRetryInPlace = ref(true);
let editor: MonacoType.editor.IStandaloneDiffEditor | null = null;
let monacoInstance: typeof MonacoType | null = null;
let originalModel: MonacoType.editor.ITextModel | null = null;
let modifiedModel: MonacoType.editor.ITextModel | null = null;
let resizeObserver: ResizeObserver | null = null;
let layoutTimer: ReturnType<typeof setTimeout> | null = null;
// 防止「加载中又点重试」把编辑器初始化两遍
let initializing = false;

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

function reloadPage() {
  window.location.reload();
}

// 加载失败后是否允许页内重试，由 canRetryMonacoInPlace() 决定：
// 只有「底层 loader 还在跑、只是我们这边等超时」时重试才真的可能拿到不同结果；
// 底层已经 reject 时必须走整页刷新，否则重试只是把同一个错误再显示一遍。
async function setupEditor() {
  if (initializing) return;
  if (!editorRef.value) return;

  initializing = true;
  isLoading.value = true;
  loadError.value = "";

  try {
    const { monaco, source } = await loadMonacoEditor();
    monacoInstance = monaco as typeof MonacoType;
    if (!editorRef.value) return;
    isLoading.value = false;
    await nextTick();

    const theme = defineMonacoTheme(monacoInstance);

    // 重试路径上可能残留上一次的实例，先清干净再建
    editor?.setModel(null);
    editor?.dispose();
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
      resizeObserver?.disconnect();
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
    // 优先展示加载链路给出的具体原因（本地资源残缺 / CDN 连不上 / 超时）
    loadError.value =
      getMonacoLoadErrorMessage(error) ||
      "对比编辑器加载失败，请检查网络或稍后重试。";
    canRetryInPlace.value = canRetryMonacoInPlace();
  } finally {
    initializing = false;
    // 失败时必须退出 loading，否则会停在无限转圈
    if (loadError.value) {
      isLoading.value = false;
    }
  }
}

onMounted(() => {
  window.addEventListener(PANEL_APPEARANCE_CHANGE_EVENT, syncEditorTheme);
  void setupEditor();
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
      role="alert"
    >
      <span class="monaco-diff-error-text">{{ loadError }}</span>
      <el-button
        v-if="canRetryInPlace"
        class="monaco-diff-retry"
        size="small"
        @click="setupEditor"
      >
        重新加载编辑器
      </el-button>
      <el-button
        v-else
        class="monaco-diff-retry"
        size="small"
        @click="reloadPage"
      >
        刷新页面
      </el-button>
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
  /* 固定 0，不吃 --dd-radius-* 令牌：这个占位块和加载完成后的真实差异编辑器是同一个盒子，
     而 Monaco 自绘的编辑器 DOM 不受我们的圆角令牌控制、永远是直角。
     占位若在圆角模式下变圆，加载完成的一瞬间会看到角"弹"回直角。 */
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
  padding: 16px;
}

.monaco-diff-error-text {
  max-width: 520px;
  line-height: 1.6;
}

/* 重试按钮吃控件档令牌，与面板整体形状基调保持一致 */
.monaco-diff-retry {
  border-radius: var(--dd-radius-control);
}
</style>
