<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from "vue";
import { subscriptionApi } from "@/api/subscription";
import { sshKeyApi } from "@/api/notification";
import { configApi } from "@/api/system";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  openAuthorizedEventStream,
  type EventStreamConnection,
} from "@/utils/sse";
import { useResponsive } from "@/composables/useResponsive";
import { ansiToHtml, normalizeAnsi } from "@/utils/ansi";
import { formatDuration } from "@/utils/duration";

const subList = ref<any[]>([]);
const loading = ref(false);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const keyword = ref("");
const selectedIds = ref<number[]>([]);
const selectedIdSet = computed(() => new Set(selectedIds.value));
const { isMobile, dialogFullscreen } = useResponsive();
const typeFilter = ref<"" | "git-repo" | "single-file" | "disabled">("");

const filteredSubList = computed(() => {
  if (!typeFilter.value) return subList.value;
  if (typeFilter.value === "disabled")
    return subList.value.filter((s) => !s.enabled);
  return subList.value.filter((s) => s.type === typeFilter.value);
});

const showEditDialog = ref(false);
const showLogDialog = ref(false);
const showSettingsDialog = ref(false);
const isCreate = ref(true);
const qlCommand = ref("");

const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsForm = ref({
  github_mirror: "",
  auto_add_cron: true,
  auto_del_cron: true,
  subscription_force_overwrite: true,
  default_cron_rule: "",
  repo_file_extensions: "",
});

const GITHUB_MIRROR_STORAGE_KEY = "subscription.github_mirror";
const DEFAULT_GITHUB_MIRROR = "https://gh-proxy.com/";
const githubMirror = ref(
  localStorage.getItem(GITHUB_MIRROR_STORAGE_KEY) || DEFAULT_GITHUB_MIRROR,
);

function normalizeMirror(u: string): string {
  const t = u.trim();
  if (!t) return "";
  return t.endsWith("/") ? t : t + "/";
}

const editForm = ref({
  id: 0,
  name: "",
  type: "git-repo",
  url: "",
  branch: "",
  schedule: "",
  whitelist: "",
  blacklist: "",
  depend_on: "",
  pre_script: "",
  hook_script: "",
  auto_add_task: false,
  auto_del_task: false,
  save_dir: "",
  sub_path: "",
  auth_type: "" as "" | "ssh" | "token",
  ssh_key_id: null as number | null,
  auth_username: "",
  auth_token: "",
  has_auth_token: false,
  alias: "",
});

const sshKeys = ref<any[]>([]);
const showSSHKeyManageDialog = ref(false);
const showSSHKeyDialog = ref(false);
const isCreateSSHKey = ref(true);
const sshKeyForm = ref({ id: 0, name: "", private_key: "" });
const sshKeyLoading = ref(false);

const logList = ref<any[]>([]);
const logTotal = ref(0);
const logPage = ref(1);
const logSubId = ref(0);
const logLoading = ref(false);

const showLogDetail = ref(false);
const logDetailContent = ref("");
const logDetailContentHtml = computed(() =>
  ansiToHtml(normalizeAnsi(logDetailContent.value || "(无日志内容)")),
);

const showPullLog = ref(false);
const pullLogLines = ref<string[]>([]);
const pullLogLineHtmlList = computed(() =>
  pullLogLines.value.map((line) => ansiToHtml(normalizeAnsi(line))),
);
const pullRunning = ref(false);
const pullingSubId = ref<number | null>(null);
let pullEventSource: EventStreamConnection | null = null;
const pullLogRef = ref<HTMLElement>();
let pullBuffer: string[] = [];
let pullFlushRaf = 0;

// 拉取结束后的「业务结果」。注意它和 pullRunning 是两回事：
// pullRunning 描述的是 SSE 连接/拉取是否还在进行，pullOutcome 描述的是跑完之后成没成。
// idle = 还没有可展示的终态；unknown = 判不出来（回退到改造前的「已完成」）。
type PullOutcome =
  | "idle"
  | "success"
  | "failed"
  | "aborted"
  | "disconnected"
  | "unknown";
const pullOutcome = ref<PullOutcome>("idle");

// 竞态守卫：每开始一次拉取会话就递增。异步查库回来时比对会话号，
// 对不上就整个丢弃 —— 覆盖「弹窗已关」「用户切到别的订阅」「又发起了一次拉取」三种情况。
let pullSessionSeq = 0;
let pullSession = 0;

// 本次拉取开始前，该订阅最新一条 sub_log 的 id（一条都没有时记 0）。
// null 表示基线没取到（查询失败），此时不做业务状态判定。
let pullBaselineLogId: number | null = null;

// 用户是否点过「停止」。后端把「拉取已停止」记成 status=1，跟真失败无法区分；
// 但前端知道是主动终止，所以本地打标记，done 之后直接显示「已终止」，不查库。
let pullStopRequested = false;

// footer 左侧状态指示：色标 tone + 文案。
// 恒返回对象而不是 `对象 | null`，是为了让模板里 v-if 和 :class 能挂在同一个元素上
// 而不依赖类型收窄 —— text 为空串即表示不渲染。
const pullStatusView = computed<{ tone: string; text: string }>(() => {
  if (pullRunning.value) return { tone: "running", text: "运行中" };
  switch (pullOutcome.value) {
    case "success":
      return { tone: "success", text: "成功" };
    case "failed":
      return { tone: "failed", text: "失败" };
    case "aborted":
      return { tone: "aborted", text: "已终止" };
    case "disconnected":
      return { tone: "disconnected", text: "连接中断" };
    default:
      // 判不出业务状态时严格回退到改造前的表现：有输出就「已完成」，没输出就什么都不显示。
      return {
        tone: "unknown",
        text: pullLogLines.value.length > 0 ? "已完成" : "",
      };
  }
});

async function loadData() {
  loading.value = true;
  try {
    const res = await subscriptionApi.list({
      keyword: keyword.value || undefined,
      type:
        typeFilter.value && typeFilter.value !== "disabled"
          ? typeFilter.value
          : undefined,
      enabled: typeFilter.value === "disabled" ? false : undefined,
      page: page.value,
      page_size: pageSize.value,
    });
    subList.value = res.data || [];
    total.value = res.total || 0;
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || "加载订阅列表失败");
  } finally {
    loading.value = false;
  }
}

async function loadSSHKeys() {
  sshKeyLoading.value = true;
  try {
    const res = await sshKeyApi.list();
    sshKeys.value = res.data || [];
  } catch {
    /* ignore */
  } finally {
    sshKeyLoading.value = false;
  }
}

onMounted(() => {
  loadData();
  loadSSHKeys();
});

onBeforeUnmount(() => {
  closePullStream();
  if (pullFlushRaf) {
    cancelAnimationFrame(pullFlushRaf);
    pullFlushRaf = 0;
  }
});

function handleSearch() {
  page.value = 1;
  loadData();
}

function handleTypeFilter(value: "" | "git-repo" | "single-file" | "disabled") {
  if (typeFilter.value === value) {
    return;
  }
  typeFilter.value = value;
  page.value = 1;
  loadData();
}

function openCreate() {
  isCreate.value = true;
  qlCommand.value = "";
  editForm.value = {
    id: 0,
    name: "",
    type: "git-repo",
    url: "",
    branch: "",
    schedule: "",
    whitelist: "",
    blacklist: "",
    depend_on: "",
    pre_script: "",
    hook_script: "",
    auto_add_task: false,
    auto_del_task: false,
    save_dir: "",
    sub_path: "",
    auth_type: "",
    ssh_key_id: null,
    auth_username: "",
    auth_token: "",
    has_auth_token: false,
    alias: "",
  };
  showEditDialog.value = true;
}

function addGithubMirror(url: string): string {
  if (!url) return url;
  const mirror = normalizeMirror(githubMirror.value);
  if (!mirror) return url;
  const githubPattern = /^https?:\/\/github\.com\//;
  // 已经包含镜像（任何协议）就不再重复包裹
  const mirrorHost = mirror.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (mirrorHost && url.includes(mirrorHost)) return url;
  if (githubPattern.test(url)) {
    return url.replace(
      /^https?:\/\/github\.com\//,
      mirror + "https://github.com/",
    );
  }
  return url;
}

function readCfgBool(
  cfgs: Record<string, any>,
  key: string,
  fallback: boolean,
): boolean {
  const entry = cfgs[key];
  const raw = String(
    entry?.value ?? entry?.default_value ?? (fallback ? "true" : "false"),
  )
    .trim()
    .toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return fallback;
}

function readCfgStr(
  cfgs: Record<string, any>,
  key: string,
  fallback = "",
): string {
  const entry = cfgs[key];
  const raw = entry?.value ?? entry?.default_value ?? fallback;
  return raw === null || raw === undefined ? fallback : String(raw);
}

async function handleOpenSettings() {
  showSettingsDialog.value = true;
  settingsForm.value.github_mirror = githubMirror.value;
  settingsLoading.value = true;
  try {
    const res = await configApi.list();
    const cfgs = res.data || {};
    settingsForm.value.auto_add_cron = readCfgBool(cfgs, "auto_add_cron", true);
    settingsForm.value.auto_del_cron = readCfgBool(cfgs, "auto_del_cron", true);
    settingsForm.value.subscription_force_overwrite = readCfgBool(
      cfgs,
      "subscription_force_overwrite",
      true,
    );
    settingsForm.value.default_cron_rule = readCfgStr(
      cfgs,
      "default_cron_rule",
      "",
    );
    settingsForm.value.repo_file_extensions = readCfgStr(
      cfgs,
      "repo_file_extensions",
      "",
    );
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || "加载订阅设置失败");
  } finally {
    settingsLoading.value = false;
  }
}

async function handleSaveSettings() {
  const mirrorRaw = (settingsForm.value.github_mirror || "").trim();
  if (mirrorRaw && !/^https?:\/\/.+/.test(mirrorRaw)) {
    ElMessage.warning("镜像地址需以 http:// 或 https:// 开头");
    return;
  }
  settingsSaving.value = true;
  try {
    await configApi.batchSet({
      auto_add_cron: settingsForm.value.auto_add_cron ? "true" : "false",
      auto_del_cron: settingsForm.value.auto_del_cron ? "true" : "false",
      subscription_force_overwrite: settingsForm.value
        .subscription_force_overwrite
        ? "true"
        : "false",
      default_cron_rule: settingsForm.value.default_cron_rule,
      repo_file_extensions: settingsForm.value.repo_file_extensions,
    });
    const mirror = mirrorRaw || DEFAULT_GITHUB_MIRROR;
    githubMirror.value = normalizeMirror(mirror);
    localStorage.setItem(GITHUB_MIRROR_STORAGE_KEY, githubMirror.value);
    ElMessage.success("订阅设置已保存");
    showSettingsDialog.value = false;
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || "保存失败");
  } finally {
    settingsSaving.value = false;
  }
}

function deriveSubscriptionSaveDir(url: string): string {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1];
    if (owner && repo) {
      return `${owner}_${repo}`;
    }
  }
  return parts[parts.length - 1] || "";
}

function normalizeRecognizedHookScript(raw: string): string {
  return raw
    .replace(
      /(?:\$\{?QL_DIR\}?|%QL_DIR%)[/\\]data[/\\](?:repo|scripts)[/\\][^/\\"'\s;]+/g,
      "$SUB_DIR",
    )
    .trim();
}

function parseQLCommand() {
  const cmd = qlCommand.value.trim();
  if (!cmd) return;

  const lines = cmd
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const qlLine = lines.find((line) => /^ql\s+(repo|raw)\b/.test(line)) || cmd;
  const hookScript = normalizeRecognizedHookScript(
    lines
      .filter((line) => line !== qlLine && !/^ql\s+(repo|raw)\b/.test(line))
      .join(" ; "),
  );

  const repoMatch = qlLine.match(
    /ql\s+repo\s+"?([^\s"]+)"?\s*"?([^"]*)"?\s*"?([^"]*)"?\s*"?([^"]*)"?\s*"?([^"]*)"?/,
  );
  if (repoMatch) {
    const [, url = "", whitelist, blacklist, dependOn, branch] = repoMatch;
    const repoName =
      url
        .replace(/\.git$/, "")
        .split("/")
        .pop() || "repo";
    editForm.value.type = "git-repo";
    editForm.value.url = addGithubMirror(url);
    editForm.value.name = repoName;
    editForm.value.save_dir = deriveSubscriptionSaveDir(url);
    editForm.value.whitelist = whitelist || "";
    editForm.value.blacklist = blacklist || "";
    editForm.value.branch = branch || "";
    editForm.value.depend_on = dependOn || "";
    if (hookScript) editForm.value.hook_script = hookScript;
    editForm.value.auto_add_task = true;
    ElMessage.success("已识别 ql repo 命令");
    qlCommand.value = "";
    return;
  }

  const rawMatch = qlLine.match(/ql\s+raw\s+"?([^\s"]+)"?/);
  if (rawMatch) {
    const url = rawMatch[1] || "";
    const fileName = url.split("/").pop() || "file";
    editForm.value.type = "single-file";
    editForm.value.url = addGithubMirror(url);
    editForm.value.name = fileName.replace(/\.[^/.]+$/, "");
    editForm.value.save_dir = deriveSubscriptionSaveDir(url) || "downloads";
    if (hookScript) editForm.value.hook_script = hookScript;
    editForm.value.auto_add_task = true;
    ElMessage.success("已识别 ql raw 命令");
    qlCommand.value = "";
    return;
  }

  if (
    cmd.includes("github.com") ||
    cmd.includes(".git") ||
    cmd.startsWith("http")
  ) {
    editForm.value.url = addGithubMirror(cmd);
    const repoName =
      cmd
        .replace(/\.git$/, "")
        .split("/")
        .pop() || "";
    if (repoName) editForm.value.name = repoName;
    editForm.value.save_dir = deriveSubscriptionSaveDir(cmd);
    editForm.value.type =
      cmd.endsWith(".js") ||
      cmd.endsWith(".py") ||
      cmd.endsWith(".ts") ||
      cmd.endsWith(".sh")
        ? "single-file"
        : "git-repo";
    ElMessage.success("已识别链接");
    qlCommand.value = "";
    return;
  }

  ElMessage.warning("无法识别命令格式，支持 ql repo/raw 命令或直接粘贴链接");
}

function openEdit(row: any) {
  isCreate.value = false;
  editForm.value = {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    branch: row.branch || "",
    schedule: row.schedule || "",
    whitelist: row.whitelist || "",
    blacklist: row.blacklist || "",
    depend_on: row.depend_on || "",
    pre_script: row.pre_script || "",
    hook_script: row.hook_script || "",
    auto_add_task: row.auto_add_task,
    auto_del_task: row.auto_del_task,
    save_dir: row.save_dir || "",
    sub_path: row.sub_path || "",
    auth_type: row.auth_type || "",
    ssh_key_id: row.ssh_key_id,
    auth_username: row.auth_username || "",
    auth_token: "",
    has_auth_token: !!row.has_auth_token,
    alias: row.alias || "",
  };
  showEditDialog.value = true;
}

async function handleSave() {
  if (!editForm.value.name.trim() || !editForm.value.url.trim()) {
    ElMessage.warning("名称和 URL 不能为空");
    return;
  }
  const mirror = normalizeMirror(githubMirror.value);
  const mirrorHost = mirror.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const githubDirect =
    /^https?:\/\/github\.com\//.test(editForm.value.url) &&
    mirrorHost &&
    !editForm.value.url.includes(mirrorHost);
  if (githubDirect) {
    try {
      await ElMessageBox.confirm(
        "检测到 GitHub 直连地址，是否自动添加镜像加速？\n加速地址: " + mirror,
        "镜像加速",
        {
          confirmButtonText: "添加加速",
          cancelButtonText: "保持原样",
          type: "info",
        },
      );
      editForm.value.url = addGithubMirror(editForm.value.url);
    } catch {
      /* keep original */
    }
  }
  try {
    const data = { ...editForm.value };
    if (data.type !== "git-repo") {
      data.auth_type = "";
      data.ssh_key_id = null;
      data.auth_username = "";
      data.auth_token = "";
    } else if (data.auth_type === "ssh") {
      data.auth_username = "";
      data.auth_token = "";
    } else if (data.auth_type === "token") {
      data.ssh_key_id = null;
    } else {
      data.ssh_key_id = null;
      data.auth_username = "";
      data.auth_token = "";
    }
    delete (data as any).has_auth_token;
    if (isCreate.value) {
      await subscriptionApi.create(data);
      ElMessage.success("创建成功");
    } else {
      await subscriptionApi.update(data.id, data);
      ElMessage.success("更新成功");
    }
    showEditDialog.value = false;
    loadData();
  } catch (err: any) {
    ElMessage.error(
      err?.response?.data?.error || (isCreate.value ? "创建失败" : "更新失败"),
    );
  }
}

async function handleDelete(id: number) {
  try {
    await ElMessageBox.confirm("确定要删除该订阅吗？", "确认删除", {
      type: "warning",
    });
    await subscriptionApi.delete(id);
    ElMessage.success("删除成功");
    loadData();
  } catch {
    /* cancelled */
  }
}

async function handleToggle(row: any) {
  try {
    const enabling = !row.enabled;
    await ElMessageBox.confirm(
      enabling
        ? `确认启用订阅「${row.name}」吗？`
        : `确认禁用订阅「${row.name}」吗？禁用后将停止后续自动拉取。`,
      enabling ? "启用确认" : "禁用确认",
      { type: enabling ? "info" : "warning" },
    );
    if (row.enabled) {
      await subscriptionApi.disable(row.id);
    } else {
      await subscriptionApi.enable(row.id);
    }
    ElMessage.success(row.enabled ? "已禁用" : "已启用");
    loadData();
  } catch (err: any) {
    if (err === "cancel" || err?.toString?.() === "cancel") return;
    ElMessage.error(err?.response?.data?.error || "操作失败");
  }
}

async function fetchLatestSubLog(subId: number) {
  const res = await subscriptionApi.logs(subId, { page: 1, page_size: 1 });
  // 后端按 created_at DESC 排序，page_size=1 拿到的就是最新一条。
  return (res.data || [])[0] || null;
}

// 取「当前最新一条日志的 id」当基线。取不到（网络/权限）返回 null，后续就不判业务状态。
async function readPullLogBaseline(subId: number): Promise<number | null> {
  try {
    const latest = await fetchLatestSubLog(subId);
    const id = Number(latest?.id);
    // 一条日志都没有时基线记 0：之后任何新记录的自增 id 都会大于 0。
    return Number.isFinite(id) ? id : 0;
  } catch {
    return null;
  }
}

// 「全新一次拉取」的会话初始化：基线、停止标记、业务结果全部重来。
// 重连（关掉弹窗后再打开）不能走这里，见下面的 reattachPullStream。
function beginPullSession(subId: number, baseline: number | null) {
  pullSession = ++pullSessionSeq;
  pullBaselineLogId = baseline;
  pullStopRequested = false;
  pullOutcome.value = "idle";
  pullRunning.value = true;
  pullingSubId.value = subId;
  showPullLog.value = true;
}

// 拉取途中关掉弹窗（handlePullDialogClose 切断了 SSE，但 pullRunning 保持 true），
// 再次点同一条订阅的「拉取」时走这里：把 SSE 重新接回来，而不是只把弹窗显示出来。
// PullStream 对新订阅者会先补发 broadcaster.history() 的全部历史行再进实时循环，
// 所以重连能拿回完整日志；广播器已经销毁（拉取早就结束）时后端直接回 done/not_running，
// 状态也能收敛掉，不会再永远卡在「运行中」。
function reattachPullStream(subId: number) {
  // 必须清空：后端会把 history() 整体重发一遍，不清的话弹窗里已有的行 + 补发的历史
  // 会整体重复一遍。顺带把还没 flush 的缓冲和在途的 rAF 也一起清掉，否则那一帧
  // 会把清空前的旧行再补回来。
  pullLogLines.value = [];
  pullBuffer = [];
  if (pullFlushRaf) {
    cancelAnimationFrame(pullFlushRaf);
    pullFlushRaf = 0;
  }

  // 只 bump 会话号，不碰其余状态 —— 这正是不能复用 beginPullSession 的原因：
  //   pullBaselineLogId 重读会把本次拉取已经落库的那条记录也算进基线，
  //     导致 latestId > baseline 不成立、降级成 unknown，白白丢掉成功/失败判定；
  //   pullStopRequested 清掉的话，用户停止后关弹窗再打开会显示成「失败」而不是「已终止」。
  // 关弹窗时 handlePullDialogClose 已经 bump 过一次（作废在途的查库结果），
  // 这里再 bump 出一个「当前有效」的会话号，让本次重连的 resolvePullOutcome 能写进状态。
  pullSession = ++pullSessionSeq;

  showPullLog.value = true;
  // connectPullStream 内部第一件事就是 closePullStream()，已有连接会先关再连，不会叠加。
  connectPullStream(subId);
}

// 拉取结束后去查最近一条 sub_log，拿 status 区分成功/失败。
async function resolvePullOutcome(subId: number, session: number) {
  if (pullBaselineLogId === null) {
    pullOutcome.value = "unknown";
    return;
  }
  const baseline = pullBaselineLogId;

  let latest: any = null;
  try {
    latest = await fetchLatestSubLog(subId);
  } catch {
    // 查库失败不弹错、也不让 UI 卡在运行中，直接回退成改造前的「已完成」。
    if (pullSession === session) pullOutcome.value = "unknown";
    return;
  }
  if (pullSession !== session) return;

  const latestId = Number(latest?.id);
  if (!latest || !Number.isFinite(latestId) || latestId <= baseline) {
    // 本次拉取压根没落下新记录。ExecuteSubscriptionPull 在「订阅不存在」和
    // 「该订阅正在拉取中」两条路径上直接 return，PullSubscriptionWithContext 又在
    // 「写 SSH 密钥失败」和「构建 git 鉴权配置失败」两处提前 return，
    // 这四条都走不到 database.DB.Create(&subLog)。此时查到的是上一次拉取的结果，
    // 拿来当本次状态就是误报，所以标成 unknown。
    pullOutcome.value = "unknown";
    return;
  }

  pullOutcome.value = Number(latest.status) === 0 ? "success" : "failed";
}

async function handlePull(row: any) {
  // 同一条订阅、且前端认为还在拉取中：这次点击的语义是「回到那次拉取」而不是「再拉一次」，
  // 所以不弹确认、不重取基线，直接重连 SSE。
  // 只显示弹窗是不够的：弹窗关掉时 SSE 已经被切断，没有任何事件能把 pullRunning 置回 false，
  // 状态会永远停在「运行中」。点别的订阅不命中这条守卫，仍走下面的确认 + 拉取流程。
  if (pullingSubId.value === row.id && pullRunning.value) {
    reattachPullStream(row.id);
    return;
  }

  try {
    await ElMessageBox.confirm(
      `确认按订阅设置拉取订阅「${row.name}」吗？`,
      "拉取确认",
      {
        type: "warning",
        confirmButtonText: "立即拉取",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }

  // 基线必须在拉取真正开始「之前」取：sub_logs.id 是自增主键，本次拉取一旦落库，
  // 新记录的 id 必然大于基线，据此就能判断「这次到底有没有产生新记录」。
  const baseline = await readPullLogBaseline(row.id);

  try {
    await subscriptionApi.pull(row.id);
    pullLogLines.value = [];
    beginPullSession(row.id, baseline);
    connectPullStream(row.id);
  } catch (err: any) {
    if (err?.response?.data?.error?.includes("拉取中")) {
      // 已在拉取中：SubLog 是整个拉取跑完之后才 Create 的，
      // 所以此刻的最新记录仍然属于上一次，直接拿来当基线是准的。
      // 这里同样要清空 —— 后端会补发 history()，残留旧行会和补发的历史重复。
      pullLogLines.value = [];
      beginPullSession(row.id, baseline);
      connectPullStream(row.id);
      return;
    }
    ElMessage.error(err?.response?.data?.error || "拉取失败");
  }
}

async function handleStopPull() {
  if (!pullingSubId.value) {
    return;
  }

  try {
    await ElMessageBox.confirm("确认停止当前拉库任务吗？", "停止拉库", {
      type: "warning",
      confirmButtonText: "停止",
      cancelButtonText: "取消",
    });
    await subscriptionApi.stopPull(pullingSubId.value);
    // 后端把「拉取已停止」当成 pullErr，落库就是 status=1，跟真正的失败无法区分。
    // 这里打个本地标记，done 之后直接显示「已终止」，从而不必给 SubLog.Status
    // 加第三个取值、也不必跟着改订阅列表状态列和日志表格。
    pullStopRequested = true;
    ElMessage.success("已发送停止请求");
  } catch (err: any) {
    if (err === "cancel" || err?.toString?.() === "cancel") return;
    ElMessage.error(err?.response?.data?.error || "停止失败");
  }
}

function connectPullStream(id: number) {
  closePullStream();
  const base = import.meta.env.VITE_API_BASE || "/api/v1";
  const url = `${base}/subscriptions/${id}/pull-stream`;
  pullEventSource = openAuthorizedEventStream(url, {
    onMessage(data) {
      pullBuffer.push(data);
      if (!pullFlushRaf) {
        pullFlushRaf = requestAnimationFrame(() => {
          pullLogLines.value.push(...pullBuffer);
          pullBuffer = [];
          pullFlushRaf = 0;
          if (pullLogRef.value)
            pullLogRef.value.scrollTop = pullLogRef.value.scrollHeight;
        });
      }
    },
    onEvent(event) {
      if (event.event !== "done") return;

      const session = pullSession;
      pullRunning.value = false;
      pullingSubId.value = null;
      closePullStream();
      loadData();

      // done 只说明「这条 SSE 连接结束了」，是传输状态不是业务状态。
      // 真正区分靠 data（PullStream 只发这四种）：
      //   finished     收到 \x00DONE 哨兵，拉取确实跑完了
      //   not_running  广播器已不存在，拉取早就结束了
      //   closed       订阅 channel 被 close，只可能来自 removeSubBroadcaster
      //   timeout      5 分钟静默
      //
      // 前三种都代表「拉取已经返回」，SubLog 也已经 Create 完
      // （service 里 Create 在 done() 之前），可以查库拿成功/失败：
      //   - closed 之所以不是 finished，是因为 done() 往 64 槽缓冲 channel
      //     非阻塞发哨兵，槽满就丢；而 removeSubBroadcaster 只在
      //     handler 那个拉取 goroutine 的 defer 里调用，能收到 closed
      //     就说明 ExecuteSubscriptionPull 早已 return。
      //   - 唯独 timeout 是 5 分钟静默，拉取可能还在跑（大仓库 clone），
      //     此刻查库拿到的会是上一次的结果，所以只报「连接中断」。
      //
      // 查库本身有 pullBaselineLogId 主键基线守卫兜底：本次没落新记录就降级成
      // 「已完成」，不会把上一次的旧结果误报成本次结果。
      const reason = event.data.trim();

      // not_running 说明广播器已随拉取结束一起销毁，history 也跟着没了，
      // 这条流一行日志都补发不出来。空日志配一个孤零零的状态太突兀，补一行指路。
      // 放在 pullStopRequested 分支之前：用户点过停止后关掉弹窗再打开，同样是空日志。
      // 最常见的触发路径就是「拉取途中关掉弹窗，等跑完之后再打开」。
      if (
        reason === "not_running" &&
        pullLogLines.value.length === 0 &&
        pullBuffer.length === 0
      ) {
        pullLogLines.value.push(
          "[提示] 本次拉取已结束，完整日志请在订阅列表的「日志」中查看",
        );
      }

      if (pullStopRequested) {
        pullOutcome.value = "aborted";
        return;
      }
      if (
        reason === "finished" ||
        reason === "not_running" ||
        reason === "closed"
      ) {
        // 用闭包里的 id 而不是 pullingSubId：上面刚把它置空，且这条流本来就是为 id 开的。
        void resolvePullOutcome(id, session);
        return;
      }
      pullOutcome.value = "disconnected";
    },
    onError() {
      pullRunning.value = false;
      pullingSubId.value = null;
      closePullStream();
      // 断网 / 刷新 token 失败等：拉取多半还在后端跑着，同样不查库。
      pullOutcome.value = pullStopRequested ? "aborted" : "disconnected";
    },
  });
}

function closePullStream() {
  if (pullEventSource) {
    pullEventSource.close();
    pullEventSource = null;
  }
}

function handlePullDialogClose() {
  // 弹窗关掉之后，在途的日志查询回来不能再写状态（否则会盖到下一次拉取上）。
  // 递增会话号即可让 resolvePullOutcome 的守卫把结果整个丢弃。
  pullSession = ++pullSessionSeq;
  closePullStream();
  // 这里刻意不动 pullRunning / pullingSubId / pullBaselineLogId / pullStopRequested：
  // 后端拉取还在跑，这四个值是重新打开弹窗时 reattachPullStream 恢复现场的依据。
}

async function handleBatchDelete() {
  if (selectedIds.value.length === 0) return;
  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${selectedIds.value.length} 个订阅吗？`,
      "批量删除",
      { type: "warning" },
    );
    await subscriptionApi.batchDelete(selectedIds.value);
    ElMessage.success("批量删除成功");
    selectedIds.value = [];
    loadData();
  } catch {
    /* cancelled */
  }
}

function handleSelectionChange(rows: any[]) {
  selectedIds.value = rows.map((r) => r.id);
}

function isSelected(id: number) {
  return selectedIdSet.value.has(id);
}

function toggleSelected(id: number, checked: boolean | string | number) {
  const next = new Set(selectedIds.value);
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  selectedIds.value = [...next];
}

async function openLogs(subId: number) {
  logSubId.value = subId;
  logPage.value = 1;
  showLogDialog.value = true;
  await loadLogs();
}

async function loadLogs() {
  logLoading.value = true;
  try {
    const res = await subscriptionApi.logs(logSubId.value, {
      page: logPage.value,
      page_size: 10,
    });
    logList.value = res.data || [];
    logTotal.value = res.total || 0;
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.error || "加载日志失败");
  } finally {
    logLoading.value = false;
  }
}

function getStatusTag(status: number) {
  return status === 0 ? "success" : "danger";
}

function getStatusText(status: number) {
  return status === 0 ? "正常" : "失败";
}

function openCreateSSHKey() {
  isCreateSSHKey.value = true;
  sshKeyForm.value = { id: 0, name: "", private_key: "" };
  showSSHKeyDialog.value = true;
}

function openEditSSHKey(row: any) {
  isCreateSSHKey.value = false;
  sshKeyForm.value = { id: row.id, name: row.name, private_key: "" };
  showSSHKeyDialog.value = true;
}

async function handleSaveSSHKey() {
  if (!sshKeyForm.value.name.trim()) {
    ElMessage.warning("名称不能为空");
    return;
  }
  if (isCreateSSHKey.value && !sshKeyForm.value.private_key.trim()) {
    ElMessage.warning("私钥不能为空");
    return;
  }
  try {
    const data: any = { name: sshKeyForm.value.name };
    if (sshKeyForm.value.private_key) {
      data.private_key = sshKeyForm.value.private_key;
    }
    if (isCreateSSHKey.value) {
      await sshKeyApi.create(data);
      ElMessage.success("创建成功");
    } else {
      await sshKeyApi.update(sshKeyForm.value.id, data);
      ElMessage.success("更新成功");
    }
    showSSHKeyDialog.value = false;
    loadSSHKeys();
  } catch {
    ElMessage.error(isCreateSSHKey.value ? "创建失败" : "更新失败");
  }
}

async function handleDeleteSSHKey(id: number) {
  try {
    await ElMessageBox.confirm("确定要删除该 SSH 密钥吗？", "确认删除", {
      type: "warning",
    });
    await sshKeyApi.delete(id);
    ElMessage.success("删除成功");
    loadSSHKeys();
  } catch {
    /* cancelled */
  }
}

function viewLogDetail(log: any) {
  logDetailContent.value = log.content || "(无日志内容)";
  showLogDetail.value = true;
}
</script>

<template>
  <div class="subscriptions-page dd-fixed-page dd-page-hide-heading">
    <div class="toolbar">
      <div class="toolbar__left">
        <div class="status-tabs">
          <button
            :class="['status-tab', { active: typeFilter === '' }]"
            @click="handleTypeFilter('')"
          >
            全部
          </button>
          <button
            :class="['status-tab', { active: typeFilter === 'git-repo' }]"
            @click="handleTypeFilter('git-repo')"
          >
            仓库
          </button>
          <button
            :class="['status-tab', { active: typeFilter === 'single-file' }]"
            @click="handleTypeFilter('single-file')"
          >
            单文件
          </button>
          <button
            :class="['status-tab', { active: typeFilter === 'disabled' }]"
            @click="handleTypeFilter('disabled')"
          >
            已禁用
          </button>
        </div>
        <el-input
          v-model="keyword"
          placeholder="搜索订阅名称或 URL"
          clearable
          class="toolbar__search"
          @keyup.enter="handleSearch"
          @clear="handleSearch"
        >
          <template #prefix
            ><el-icon><Search /></el-icon
          ></template>
        </el-input>
      </div>
      <div class="toolbar__right">
        <el-button
          @click="
            showSSHKeyManageDialog = true;
            loadSSHKeys();
          "
          title="SSH 密钥管理"
        >
          <el-icon><Key /></el-icon> SSH 密钥
        </el-button>
        <el-button @click="handleOpenSettings" title="订阅设置">
          <el-icon><Setting /></el-icon>
        </el-button>
        <el-button
          v-if="selectedIds.length > 0"
          type="danger"
          plain
          size="small"
          @click="handleBatchDelete"
        >
          <el-icon><Delete /></el-icon> 批量删除
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon> 新建订阅
        </el-button>
      </div>
    </div>

    <div v-if="isMobile" class="dd-mobile-list">
      <div v-for="row in filteredSubList" :key="row.id" class="dd-mobile-card">
        <div class="dd-mobile-card__header">
          <div class="dd-mobile-card__title-wrap">
            <div class="subscription-card__title-row">
              <div class="dd-mobile-card__selection">
                <el-checkbox
                  :model-value="isSelected(row.id)"
                  @change="toggleSelected(row.id, $event)"
                />
                <span class="dd-mobile-card__title">{{ row.name }}</span>
              </div>
              <el-tag
                size="small"
                :type="row.type === 'git-repo' ? '' : 'warning'"
              >
                {{ row.type === "git-repo" ? "Git 仓库" : "单文件" }}
              </el-tag>
            </div>
            <div class="dd-mobile-card__subtitle">{{ row.url }}</div>
          </div>
        </div>

        <div class="dd-mobile-card__body">
          <div class="dd-mobile-card__grid">
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">分支</span>
              <span class="dd-mobile-card__value">{{ row.branch || "-" }}</span>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">状态</span>
              <div class="dd-mobile-card__value">
                <el-tag size="small" :type="getStatusTag(row.status)">{{
                  getStatusText(row.status)
                }}</el-tag>
              </div>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">定时拉取</span>
              <span class="dd-mobile-card__value">{{
                row.schedule || "手动拉取"
              }}</span>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">启用</span>
              <div class="dd-mobile-card__value">
                <el-switch
                  :model-value="row.enabled"
                  size="small"
                  @change="handleToggle(row)"
                />
              </div>
            </div>
            <div class="dd-mobile-card__field">
              <span class="dd-mobile-card__label">最后拉取</span>
              <span class="dd-mobile-card__value">{{
                row.last_pull_at
                  ? new Date(row.last_pull_at).toLocaleString()
                  : "-"
              }}</span>
            </div>
          </div>

          <div class="dd-mobile-card__actions subscription-card__actions">
            <el-button size="small" type="success" @click="handlePull(row)"
              >拉取</el-button
            >
            <el-button size="small" @click="openLogs(row.id)">日志</el-button>
            <el-button size="small" type="primary" plain @click="openEdit(row)"
              >编辑</el-button
            >
            <el-button
              size="small"
              type="danger"
              plain
              @click="handleDelete(row.id)"
              >删除</el-button
            >
          </div>
        </div>
      </div>

      <el-empty
        v-if="!loading && filteredSubList.length === 0"
        description="暂无订阅"
      />
    </div>

    <div v-else class="table-card">
      <el-table
        :data="filteredSubList"
        v-loading="loading"
        @selection-change="handleSelectionChange"
        style="width: 100%"
        :header-cell-style="{
          background: '#f8fafc',
          color: '#64748b',
          fontWeight: 600,
          fontSize: '13px',
        }"
      >
        <el-table-column type="selection" width="40" />
        <el-table-column prop="name" label="名称" min-width="120">
          <template #default="{ row }">
            <div class="sub-name-cell">
              <span class="sub-name-text">{{ row.name }}</span>
              <el-tag
                size="small"
                :type="row.type === 'git-repo' ? '' : 'warning'"
                round
              >
                {{ row.type === "git-repo" ? "Git" : "文件" }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column
          prop="url"
          label="URL"
          min-width="160"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <span class="url-text">{{ row.url }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="branch" label="分支" width="80" />
        <el-table-column prop="schedule" label="定时拉取" width="110">
          <template #default="{ row }">
            <code v-if="row.schedule" class="cron-text">{{
              row.schedule
            }}</code>
            <span v-else class="text-muted">手动</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="70" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="getStatusTag(row.status)" round>{{
              getStatusText(row.status)
            }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="60" align="center">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              size="small"
              @change="handleToggle(row)"
            />
          </template>
        </el-table-column>
        <el-table-column prop="last_pull_at" label="最后拉取" width="150">
          <template #default="{ row }">
            <span v-if="row.last_pull_at" class="time-text">{{
              new Date(row.last_pull_at).toLocaleString()
            }}</span>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <!--
          列宽 220：EP 的 .el-table .cell 是 padding:0 12px + overflow:hidden，可用内容宽 = 列宽 - 24。
          清掉 EP 的按钮相邻外边距后这四个按钮实测需要 172px，220 留出 24px 余量。
          原来的 200（可用 176）配上那份外边距要 208px，「拉取」和「删除」两头都会被裁掉一截。
        -->
        <el-table-column label="操作" width="220" fixed="right" align="center">
          <template #default="{ row }">
            <div class="action-btns">
              <el-button
                size="small"
                type="success"
                text
                @click="handlePull(row)"
                >拉取</el-button
              >
              <el-button size="small" text @click="openLogs(row.id)"
                >日志</el-button
              >
              <el-button size="small" text type="primary" @click="openEdit(row)"
                >编辑</el-button
              >
              <el-button
                size="small"
                text
                type="danger"
                @click="handleDelete(row.id)"
                >删除</el-button
              >
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="pagination-bar">
      <span class="pagination-total">共 {{ total }} 条数据</span>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="sizes, prev, pager, next"
        @current-change="loadData"
        @size-change="
          () => {
            page = 1;
            loadData();
          }
        "
      />
    </div>

    <el-dialog
      v-model="showEditDialog"
      :title="isCreate ? '新建订阅' : '编辑订阅'"
      width="800px"
      :fullscreen="dialogFullscreen"
    >
      <el-form
        class="subscription-form"
        :model="editForm"
        :label-width="dialogFullscreen ? 'auto' : '88px'"
        :label-position="dialogFullscreen ? 'top' : 'right'"
      >
        <el-form-item v-if="isCreate" label="一键识别" class="form-item--full">
          <div style="display: flex; gap: 8px; width: 100%">
            <el-input
              v-model="qlCommand"
              placeholder="粘贴 ql repo/raw 命令或仓库链接"
              clearable
              @keyup.enter="parseQLCommand"
            />
            <el-button type="primary" @click="parseQLCommand">识别</el-button>
          </div>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="editForm.name" placeholder="订阅名称" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="editForm.type">
            <el-radio value="git-repo">Git 仓库</el-radio>
            <el-radio value="single-file">单文件</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="URL" class="form-item--full">
          <el-input
            v-model="editForm.url"
            placeholder="仓库地址或文件下载链接"
          />
        </el-form-item>
        <el-form-item v-if="editForm.type === 'git-repo'" label="分支">
          <el-input
            v-model="editForm.branch"
            placeholder="默认分支 (留空使用默认)"
          />
        </el-form-item>
        <el-form-item label="定时拉取">
          <el-input
            v-model="editForm.schedule"
            placeholder="cron 表达式 (留空不自动拉取)"
          />
        </el-form-item>
        <el-form-item label="保存目录">
          <el-input
            v-model="editForm.save_dir"
            placeholder="保存到 scripts 下的子目录"
          />
        </el-form-item>
        <el-form-item v-if="editForm.type === 'git-repo'" label="指定子目录">
          <el-input
            v-model="editForm.sub_path"
            placeholder="仅拉取仓库中的指定子目录 (逗号分隔多个)"
          />
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            留空拉取全部内容，填写后仅检出指定子目录（如 scripts/daily, utils）
          </div>
        </el-form-item>
        <el-form-item
          v-if="editForm.type === 'git-repo'"
          label="仓库鉴权"
          class="form-item--full"
        >
          <el-radio-group v-model="editForm.auth_type">
            <el-radio value="">无鉴权</el-radio>
            <el-radio value="ssh">SSH 密钥</el-radio>
            <el-radio value="token">Access Token</el-radio>
          </el-radio-group>
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            私有仓库推荐使用权限更可控的 Token；公开仓库可留空。
          </div>
        </el-form-item>
        <el-form-item label="别名">
          <el-input v-model="editForm.alias" placeholder="目录/文件别名" />
        </el-form-item>
        <el-form-item
          v-if="editForm.type === 'git-repo' && editForm.auth_type === 'ssh'"
          label="SSH 密钥"
        >
          <el-select
            v-model="editForm.ssh_key_id"
            placeholder="选择 SSH 密钥 (可选)"
            clearable
            style="width: 100%"
          >
            <el-option
              v-for="key in sshKeys"
              :key="key.id"
              :label="key.name"
              :value="key.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="editForm.type === 'git-repo' && editForm.auth_type === 'token'"
          label="鉴权用户名"
          class="form-item--full"
        >
          <el-input
            v-model="editForm.auth_username"
            placeholder="留空默认 x-access-token（GitHub 适用）"
          />
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            GitHub 留空即可；Gitee 填用户名；GitLab 可填 oauth2 或
            private-token。
          </div>
        </el-form-item>
        <el-form-item
          v-if="editForm.type === 'git-repo' && editForm.auth_type === 'token'"
          label="Access Token"
          class="form-item--full"
        >
          <el-input
            v-model="editForm.auth_token"
            type="password"
            show-password
            :placeholder="
              editForm.has_auth_token
                ? '留空则保持当前已保存 Token'
                : '粘贴 Git 平台访问令牌'
            "
          />
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            {{
              editForm.has_auth_token
                ? "当前已保存 Token。若不需要更新，保持留空即可。"
                : "建议使用仅仓库读取权限的 Token。"
            }}
          </div>
        </el-form-item>
        <el-form-item label="白名单" class="form-item--full">
          <el-input
            v-model="editForm.whitelist"
            placeholder="文件名/路径片段（`,` 或 `|` 分隔，如 jd_|jx_）"
          />
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            匹配方式是「子串包含」，不是正则也不是
            glob。片段命中目录名时，该目录下的全部文件（含多级子目录）都算命中。命中白名单的文件会被检出落盘，并建成定时任务。主脚本
            require 的辅助库文件请填到下面的「依赖规则」，不必再塞进白名单。
          </div>
        </el-form-item>
        <el-form-item label="黑名单">
          <el-input
            v-model="editForm.blacklist"
            placeholder="文件名/路径片段（`,` 或 `|` 分隔，如 backUp）"
          />
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            匹配方式同白名单（子串包含）。片段命中目录名时，该目录下的全部文件都会被排除，既不落盘也不建任务；黑名单对白名单与依赖规则都生效。
          </div>
        </el-form-item>
        <el-form-item label="依赖规则" class="form-item--full">
          <el-input
            v-model="editForm.depend_on"
            placeholder="辅助库文件名/路径片段（`,` 或 `|` 分隔，如 sendNotify|utils）"
          />
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            对应青龙 ql repo 的第 4
            个参数。命中的文件会被拉取到脚本目录供主脚本调用，但<strong>不会</strong>建成定时任务——只有命中白名单的文件才建任务；黑名单对两者都生效。匹配方式同白名单（子串包含，片段命中目录名时目录下的全部文件一并检出，所以填
            utils 就能把 utils/date.js
            带下来）。含空格或中文的内容会被当作文字备注跳过，不参与检出。
          </div>
        </el-form-item>
        <el-form-item label="拉取前指令" class="form-item--full">
          <el-input
            v-model="editForm.pre_script"
            type="textarea"
            :rows="3"
            placeholder="拉取开始前执行的 Shell 命令。支持使用 $SUB_DIR、$SCRIPTS_DIR、$QL_DIR 等变量。"
          />
          <div
            style="
              color: var(--el-text-color-secondary);
              font-size: 12px;
              margin-top: 4px;
              line-height: 1.4;
            "
          >
            在 git 拉取之前执行，适合做「准备环境 / 挂载目录 / 换源 / 生成凭据」这类前置动作。<strong>执行失败（非
            0 退出）会中断本次拉取并记为失败</strong>，不会带着半成品环境继续拉。首次拉取时订阅目录还不存在，$SUB_DIR
            会退回脚本根目录。
          </div>
        </el-form-item>
        <el-form-item label="拉取后钩子" class="form-item--full">
          <el-input
            v-model="editForm.hook_script"
            type="textarea"
            :rows="4"
            placeholder="拉取成功后执行的 Shell 命令。支持使用 $SUB_DIR、$SCRIPTS_DIR、$QL_DIR 等变量。"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditDialog = false">取消</el-button>
        <el-button type="primary" @click="handleSave">{{
          isCreate ? "创建" : "保存"
        }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showLogDialog"
      title="拉取日志"
      width="700px"
      :fullscreen="dialogFullscreen"
    >
      <el-table :data="logList" v-loading="logLoading" max-height="400px">
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.status === 0 ? 'success' : 'danger'"
            >
              {{ row.status === 0 ? "成功" : "失败" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column
          prop="content"
          label="内容"
          class-name="log-content-cell"
        />
        <el-table-column prop="duration" label="耗时" width="100">
          <template #default="{ row }">{{ formatDuration(row.duration) }}</template>
        </el-table-column>
        <el-table-column prop="created_at" label="时间" width="170">
          <template #default="{ row }">{{
            new Date(row.created_at).toLocaleString()
          }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right" align="center">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="primary"
              @click="viewLogDetail(row)"
              >查看</el-button
            >
          </template>
        </el-table-column>
      </el-table>
      <div
        class="pagination-container"
        v-if="logTotal > 10"
        style="margin-top: 12px"
      >
        <el-pagination
          v-model:current-page="logPage"
          :total="logTotal"
          :page-size="10"
          layout="prev, pager, next"
          @current-change="loadLogs"
        />
      </div>
    </el-dialog>

    <el-dialog
      v-model="showLogDetail"
      title="日志详情"
      width="900px"
      :fullscreen="dialogFullscreen"
    >
      <pre
        class="pull-log-content dd-log-surface"
        style="min-height: 100px"
        v-html="logDetailContentHtml"
      ></pre>
    </el-dialog>

    <el-dialog
      v-model="showPullLog"
      title="拉取日志"
      width="900px"
      :fullscreen="dialogFullscreen"
      :close-on-click-modal="false"
      @close="handlePullDialogClose"
    >
      <div ref="pullLogRef" class="pull-log-content dd-log-surface">
        <div
          v-for="(line, i) in pullLogLineHtmlList"
          :key="i"
          class="pull-log-line"
          v-html="line"
        ></div>
        <div v-if="pullRunning" class="pull-log-line pull-running">
          <LoadingMotion
            variant="dots"
            size="sm"
            tone="warning"
            :stacked="false"
          />
          <span>拉取中...</span>
        </div>
        <el-empty
          v-if="!pullRunning && pullLogLines.length === 0"
          description="暂无输出"
          :image-size="60"
        />
      </div>
      <template #footer>
        <!--
          状态指示靠 `margin-right: auto` 推到最左，这依赖 .el-dialog__footer 是 flex 容器
          （已在 global.scss 的 .el-dialog 块里统一改为 flex；Element Plus 原生只有 text-align:right，
          在那种 inline 上下文里 auto 外边距不产生推挤，所以这里换回 el-tag 会重新贴到按钮上）。
        -->
        <span
          v-if="pullStatusView.text"
          class="pull-status"
          :class="`is-${pullStatusView.tone}`"
        >
          <span class="pull-status__mark" aria-hidden="true"></span
          >{{ pullStatusView.text }}
        </span>
        <el-button v-if="pullRunning" type="danger" @click="handleStopPull"
          >停止</el-button
        >
        <el-button @click="showPullLog = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showSettingsDialog"
      title="订阅设置"
      width="560px"
      :fullscreen="dialogFullscreen"
    >
      <el-form
        v-loading="settingsLoading"
        :label-width="dialogFullscreen ? 'auto' : '140px'"
        :label-position="dialogFullscreen ? 'top' : 'right'"
      >
        <el-form-item label="GitHub 镜像地址">
          <el-input
            v-model="settingsForm.github_mirror"
            :placeholder="DEFAULT_GITHUB_MIRROR"
          />
          <div class="settings-hint">
            留空使用默认值 {{ DEFAULT_GITHUB_MIRROR }}，拉取 GitHub
            仓库时自动加速
          </div>
        </el-form-item>
        <el-form-item label="自动添加定时任务">
          <el-switch
            v-model="settingsForm.auto_add_cron"
            inline-prompt
            active-text="开"
            inactive-text="关"
          />
          <div class="settings-hint">拉取后根据脚本内容自动同步定时任务</div>
        </el-form-item>
        <el-form-item label="自动删除失效任务">
          <el-switch
            v-model="settingsForm.auto_del_cron"
            inline-prompt
            active-text="开"
            inactive-text="关"
          />
          <div class="settings-hint">
            订阅源删除脚本后，自动删除对应定时任务
          </div>
        </el-form-item>
        <el-form-item label="覆盖拉取">
          <el-switch
            v-model="settingsForm.subscription_force_overwrite"
            inline-prompt
            active-text="开"
            inactive-text="关"
          />
          <div class="settings-hint">
            只作用于脚本文件：开启后拉取前丢弃本地改动，关闭则先暂存再恢复。<b>不影响任务配置</b>——手动改过名称/定时的任务会自动锁定，拉取不会覆盖
          </div>
        </el-form-item>
        <el-form-item label="默认 Cron 规则">
          <el-input
            v-model="settingsForm.default_cron_rule"
            placeholder="0 9 * * *"
          />
          <div class="settings-hint">匹配不到定时规则时使用，如 0 9 * * *</div>
        </el-form-item>
        <el-form-item label="拉取文件后缀">
          <el-input
            v-model="settingsForm.repo_file_extensions"
            placeholder="py js mjs ts sh"
          />
          <div class="settings-hint">
            空格分隔，如 py js mjs ts sh。订阅同步时只有这些后缀的脚本会被识别成定时任务
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showSettingsDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="settingsSaving"
          @click="handleSaveSettings"
          >保存</el-button
        >
      </template>
    </el-dialog>

    <!-- SSH Key Management Dialog -->
    <el-dialog
      v-model="showSSHKeyManageDialog"
      title="SSH 密钥管理"
      width="600px"
      :fullscreen="dialogFullscreen"
    >
      <div
        style="margin-bottom: 12px; display: flex; justify-content: flex-end"
      >
        <el-button type="primary" size="small" @click="openCreateSSHKey">
          <el-icon><Plus /></el-icon> 新建密钥
        </el-button>
      </div>
      <el-table :data="sshKeys" v-loading="sshKeyLoading" style="width: 100%">
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column prop="created_at" label="创建时间" width="170">
          <template #default="{ row }">
            <span class="time-text">{{
              new Date(row.created_at).toLocaleString()
            }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right" align="center">
          <template #default="{ row }">
            <div class="action-btns">
              <el-button
                size="small"
                text
                type="primary"
                @click="openEditSSHKey(row)"
                >编辑</el-button
              >
              <el-button
                size="small"
                text
                type="danger"
                @click="handleDeleteSSHKey(row.id)"
                >删除</el-button
              >
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-empty
        v-if="!sshKeyLoading && sshKeys.length === 0"
        description="暂无 SSH 密钥"
      />
    </el-dialog>

    <!-- SSH Key Edit Dialog -->
    <el-dialog
      v-model="showSSHKeyDialog"
      :title="isCreateSSHKey ? '新建 SSH 密钥' : '编辑 SSH 密钥'"
      width="550px"
      :fullscreen="dialogFullscreen"
      append-to-body
    >
      <el-form
        :model="sshKeyForm"
        :label-width="dialogFullscreen ? 'auto' : '80px'"
        :label-position="dialogFullscreen ? 'top' : 'right'"
      >
        <el-form-item label="名称">
          <el-input v-model="sshKeyForm.name" placeholder="密钥名称" />
        </el-form-item>
        <el-form-item label="私钥">
          <el-input
            v-model="sshKeyForm.private_key"
            type="textarea"
            :rows="8"
            :placeholder="isCreateSSHKey ? '粘贴 SSH 私钥内容' : '留空不修改'"
            spellcheck="false"
            style="font-family: monospace"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showSSHKeyDialog = false">取消</el-button>
        <el-button type="primary" @click="handleSaveSSHKey">{{
          isCreateSSHKey ? "创建" : "保存"
        }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.subscriptions-page {
  padding: 0;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 18px;
  gap: 16px;

  h2 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--el-text-color-primary);
    line-height: 1.3;
  }
  .page-subtitle {
    font-size: 13px;
    color: var(--el-text-color-secondary);
    margin: 4px 0 0;
  }
  .header-actions {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }
}

// 工具条：与定时任务页/执行日志页对齐——上下统一间距、左右两区一行排布、gap 一致
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 14px 0;
  gap: 12px;
  flex-wrap: wrap;
  &__left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }
  &__right {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  &__search {
    width: 260px;
  }
}

// 状态分段控件：与定时任务页/执行日志页一致的直角容器 + 选中态白底品牌色 + 1px 边框
.status-tabs {
  display: inline-flex;
  background: var(--el-fill-color-light);
  border-radius: 0;
  padding: 3px;
  gap: 2px;
}

.status-tab {
  padding: 6px 14px;
  border-radius: 0;
  // 未选中态用透明边框占位，选中态只换边框颜色，避免尺寸跳动
  border: 1px solid transparent;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    color var(--dd-motion-fast) var(--dd-ease-standard),
    background-color var(--dd-motion-fast) var(--dd-ease-standard),
    border-color var(--dd-motion-fast) var(--dd-ease-standard);
  white-space: nowrap;
  &:hover {
    color: var(--el-text-color-primary);
  }
  &.active {
    background: var(--el-bg-color);
    color: var(--el-color-primary);
    border-color: var(--el-border-color-lighter);
    font-weight: 600;
  }
}

// 表格卡：直角无阴影，仅用 1px 边框与页面底色区分（dd-fixed-page 下的 flex + 内部滚动由全局规则接管）
.table-card {
  background: var(--el-bg-color);
  border-radius: 0;
  border: 1px solid var(--el-border-color-lighter);
  overflow: hidden;
}

.sub-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sub-name-text {
  font-weight: 500;
  color: var(--el-text-color-primary);
}
.url-text {
  font-family: var(--dd-font-mono);
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.cron-text {
  font-family: var(--dd-font-mono);
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.time-text {
  font-family: var(--dd-font-mono);
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.text-muted {
  color: var(--el-text-color-placeholder);
}
// 操作列：与定时任务页/执行日志页一致的轻量行内按钮组
.action-btns {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;

  // EP 自带 `.el-button + .el-button { margin-left: 12px }` 会叠加在上面的 flex gap 上，
  // 四个按钮凭空多吃 36px、撑破「操作」列的可用内容宽，两端的按钮被 .cell 的 overflow:hidden 裁掉。
  // 间距统一交给 gap（与 tasks / deps 两页一致）。
  :deep(.el-button + .el-button) {
    margin-left: 0;
  }

  :deep(.el-button) {
    padding: 4px 8px;
  }
}

// 分页条：与定时任务页/执行日志页一致的间距收敛
.pagination-bar {
  margin-top: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
}
.pagination-total {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

:deep(.el-table) {
  // 边框统一走令牌，明暗自动适配（原写死浅灰会在暗色串色）
  --el-table-border-color: var(--el-border-color-lighter);
  .el-table__header-wrapper th {
    border-bottom: 1px solid var(--el-border-color-light);
  }
  .el-table__row td {
    border-bottom: 1px solid var(--el-border-color-lighter);
  }
  .el-table__cell {
    padding: 12px 0;
  }
  // 拉取日志「内容」列：已移除 show-overflow-tooltip（详情走「查看」按钮），
  // 需自行补回单行截断，否则会退回 .el-table .cell 的 white-space: normal 换行，
  // 长日志会把行高撑爆。
  .log-content-cell .cell {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.subscription-card__title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.subscription-card__actions > * {
  flex: 1 1 calc(50% - 4px);
}

.pull-log-content {
  font-family: var(--dd-font-mono, monospace);
  font-size: 13px;
  line-height: 1.6;
  padding: 12px 16px;
  border-radius: 0;
  max-height: 560px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.pull-log-line {
  white-space: pre-wrap;
  word-break: break-all;
}
.pull-running {
  color: var(--el-color-warning);
  display: flex;
  align-items: center;
  gap: 8px;
}

// 拉取日志弹窗底部的状态指示。
// 用「方形色标 + 次级文字」替代原来的 el-tag：颜色只落在 8px 色标上，
// 文字保持 --el-text-color-secondary，不跟右侧的「停止 / 关闭」抢视觉重量。
// 形状严格直角，无边框底色块、无阴影、无渐变。
.pull-status {
  // footer 已是 flex 容器，这条才真正把状态推到最左侧
  margin-right: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
  user-select: none;
}

// 色标默认就是 placeholder 灰，所以「连接中断」(is-disconnected) 和
// 判不出状态时的「已完成」(is-unknown) 不需要单独写规则，直接吃这个默认值。
.pull-status__mark {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  background: var(--el-text-color-placeholder);
}

.pull-status.is-running .pull-status__mark,
.pull-status.is-aborted .pull-status__mark {
  background: #f59e0b;
}

.pull-status.is-success .pull-status__mark {
  background: #10b981;
}

.pull-status.is-failed .pull-status__mark {
  background: #ef4444;
}

.settings-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-top: 4px;
  line-height: 1.4;
}

// ===== 新建 / 编辑订阅弹窗：桌面端双列 =====
// 只在 ≥769px 生效；≤768px 不套任何 grid，表单退回默认块级流（天然单列），
// 且此时 dialogFullscreen 为 true（useResponsive 的断点同为 768），label 走 top 布局，
// .form-item--full 的 grid-column 在块级流下不生效，对移动端零副作用。
//
// 用 Grid 而不是 el-row/el-col：表单里「分支 / 指定子目录 / 仓库鉴权 / SSH 密钥 /
// 鉴权用户名 / Access Token」都是条件字段，固定栅格在字段隐藏时会留下死格，
// 而 Grid 的自动流会让后面的字段自动补位。
@media (min-width: 769px) {
  .subscription-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 20px;
    // 行高不拉伸：同一行里矮的那个（如「保存目录」）不跟着带说明文字的那个一起变高，
    // 两列的 label 才能对齐在同一条基线上
    align-items: start;

    // 行间距沿用 el-form-item 自带的 margin-bottom，不再叠 row-gap，避免双倍间距
    :deep(.el-form-item) {
      min-width: 0;
      margin-bottom: 18px;
    }

    // 跨满两列的字段。判定口径：内容天然放不进半列（一键识别的输入框+按钮、URL、
    // 钩子 textarea、仓库鉴权的三个 radio），或说明文字在半列宽下会超过 2 行
    // （白名单、依赖规则、鉴权用户名）。「指定子目录」能在半列内放下，故不跨列。
    :deep(.form-item--full) {
      grid-column: 1 / -1;
    }

    // 800px 弹窗的可用宽度：800 − .el-dialog 自带 16px×2 − .el-dialog__body 24px×2 = 720px，
    // 两列减去 20px 列间距后每列 350px，减 88px 标签宽后输入框还有 262px。
    // 88px 标签宽可容下 5 个中文字（70px + 12px 右内边距 = 82px）不折行；
    // 但「Access Token」这类拉丁文标签更宽，而 EP 给 .el-form-item__label 写死了
    // height:32px / line-height:32px，一旦折行第二行会溢出压到下一行。
    //
    // 放开高度必须同时写下面三条，缺一不可：
    // 1) height:auto + min-height:32px —— 折行时由标签内容自然撑高，不再溢出。
    // 2) align-self:flex-start —— 【关键，删掉就会复发】.el-form-item 是 display:flex 且
    //    没有声明 align-items，因此 flex 子元素默认 align-self:stretch。EP 原本那个显式的
    //    height:32px 恰好压住了 stretch（stretch 只在 cross-size 为 auto 时才生效）；
    //    一旦改成 height:auto，stretch 立即恢复，label 盒子会被拉伸到整个表单项的高度
    //    （输入框 + 下方 12px 说明文字），第 3 条的 align-items:center 就会把标签文字居中到
    //    这个大盒子的正中，导致「仓库鉴权 / 白名单 / 鉴权用户名 / Access Token」等带说明
    //    文字的项标签明显下沉，两列并排时同一行左右两个标签还会错开。锚在顶部后，
    //    label 盒子高度 = max(内容高, 32px)，才能对齐输入框/radio 那一行；
    //    「拉取后钩子」的多行 textarea 同理，标签对齐 textarea 顶行而不是垂直居中。
    // 3) align-items:center —— label 自身是 inline-flex，且 EP 给它设了 align-items:flex-start，
    //    而这里把 line-height 从 32px 收成 1.4（≈19.6px），不居中的话单行标签会贴着盒子顶端。
    //
    // 仅限左右布局：全屏（dialogFullscreen）时 label-position 切成 top，EP 会给
    // .el-form-item--label-top 设 display:block，label 不再是 flex 子元素，
    // min-height:32px 反而会在标签与控件之间垫出多余空隙，故用 :not() 排除。
    // 常态下本媒体查询（≥769px）与全屏（≤768px）互斥，但 useResponsive 有 document.hidden
    // 守卫会让 width 滞后，后台放大窗口再切回来的瞬间两者可能同时成立，这里做兜底。
    :deep(.el-form-item:not(.el-form-item--label-top) .el-form-item__label) {
      align-self: flex-start;
      height: auto;
      min-height: 32px;
      line-height: 1.4;
      align-items: center;
    }
  }
}

@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    gap: 10px;
    margin-bottom: 14px;
    h2 {
      font-size: 18px;
    }
  }
  .toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    &__left {
      flex-direction: column;
      gap: 10px;
    }
    &__search {
      width: 100% !important;
    }
    &__right {
      justify-content: flex-end;
    }
  }
  .status-tabs {
    width: 100%;
    overflow-x: auto;
  }
  .subscription-card__title-row {
    flex-direction: column;
  }
}

// ===== 入场动画 =====
// 与定时任务页/执行日志页统一：只对卡片级容器（工具条 / 表格卡 / 移动列表）做克制的淡入上移 + 轻微错落；
// 不给表格每一行或每张移动卡做 stagger。时长走令牌，prefers-reduced-motion 时令牌自动降为 1ms 即等效关闭。
@keyframes dd-subs-rise-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.toolbar,
.table-card,
.dd-mobile-list {
  animation: dd-subs-rise-in var(--dd-motion-page) var(--dd-ease-decelerate) both;
}

// 轻微错落：工具条先入，表格卡/移动列表略晚
.table-card,
.dd-mobile-list {
  animation-delay: 60ms;
}
</style>
