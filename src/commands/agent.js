import inquirer from "inquirer";
import chalk from "chalk";
import { initProviders, getProvider } from "../providers/registry.js";
import { initExtensions } from "../extensions/index.js";
import { getConfig, getAgentConfig, setAgentConfigKey } from "../config.js";
import { printSuccess, printError, printInfo, printTable, formatDate, accountLabel } from "../utils/format.js";
import { listComposites, createComposite, getComposite, deleteComposite, setModels } from "../agent/storage/composite.js";
import { agentTui } from "../agent/tui.js";

// 扩展系统（延迟初始化）
let _extContext = null;
async function getExtContext() {
  if (!_extContext) {
    _extContext = await initExtensions({ cwd: process.cwd() }).catch((err) => {
      console.warn("[扩展] 初始化失败:", err.message);
      return { hooks: { emit: async () => ({}) }, loaded: [], promptSections: { main: [] } };
    });
  }
  return _extContext;
}

/**
 * 从已登录账号中选取一个 provider 和账号
 * @param {string} role - 显示名称
 * @param {string} preferredProvider - 配置中预设的 provider 名
 * @returns {{ provider, accountId, providerName }}
 */
async function selectProvider(role, preferredProvider) {
  initProviders();

  // 列出所有可用账号
  const accounts = [];
  for (const provider of [getProvider("deepseek"), getProvider("qwen")]) {
    if (!provider || !provider.isAuthenticated()) continue;
    const accs = provider.listAccounts ? provider.listAccounts() : [provider.getAccountInfo()];
    for (const acc of accs) {
      if (!acc) continue;
      accounts.push({
        name: `${provider.label}: ${accountLabel(acc)}`,
        value: { providerName: provider.name, accountId: acc.id }
      });
    }
  }

  if (accounts.length === 0) {
    printError("没有已登录的账号，请先运行 chat2cli login");
    process.exit(1);
  }

  // 如果有预设，尝试匹配
  if (preferredProvider) {
    const match = accounts.find((a) => a.value.providerName === preferredProvider);
    if (match) {
      printInfo(`${role}: ${match.name}`);
      return match.value;
    }
  }

  if (accounts.length === 1) {
    printInfo(`${role}: ${accounts[0].name}`);
    return accounts[0].value;
  }

  const ans = await inquirer.prompt([{
    type: "list",
    name: "selection",
    message: `选择${role}账号:`,
    choices: accounts
  }]);
  return ans.selection;
}

/** 为指定 provider 选取模型 */
async function selectModel(provider, role, preferredModel) {
  const models = provider.getModels();
  if (models.length === 0) return models[0]?.id || null;

  // 如果有偏好的模型且在列表中，直接使用
  if (preferredModel && models.some((m) => m.id === preferredModel)) {
    return preferredModel;
  }

  if (models.length === 1) {
    printInfo(`${role}模型: ${models[0].label || models[0].id}`);
    return models[0].id;
  }

  const ans = await inquirer.prompt([{
    type: "list",
    name: "model",
    message: `选择${role}模型 (${provider.label}):`,
    choices: models.map((m) => ({
      name: `${m.id}  ${chalk.gray(m.label || "")}`,
      value: m.id
    })),
    pageSize: 15
  }]);
  return ans.model;
}

export async function runAgent(opts = {}) {
  initProviders();

  // ── 初始化扩展（加载工具、钩子、提示词片段）──
  const extCtx = await getExtContext();

  // ── 列表模式 ──
  if (opts.list) {
    return listAgents();
  }

  // ── 批量删除模式 ──
  if (opts.batch) {
    return batchDeleteAgents();
  }

  // ── 删除模式 ──
  if (opts.delete) {
    return deleteAgent(opts.delete);
  }

  // ── 获取配置 ──
  const agentPrefs = getAgentConfig();

  // 选取 AI
  const main = await selectProvider("AI", agentPrefs.mainProvider);
  const mainProvider = getProvider(main.providerName);
  if (!mainProvider) {
    printError(`未找到 AI provider: ${main.providerName}`);
    return;
  }

  // 选取模型（仅新建时选择，继续对话时从 composite 恢复）
  let mainModel = null;

  // ── 复合对话 ──
  let composite;

  if (opts.continue) {
    composite = getComposite(opts.continue);
    if (!composite) {
      printError(`未找到复合对话: ${opts.continue}`);
      return;
    }
    printInfo(`继续复合对话: ${chalk.bold(composite.name)}`);

    // 更新 session 信息（如果 provider 变了）
    if (composite.main.provider !== main.providerName || composite.main.accountId !== main.accountId) {
      composite.main = { provider: main.providerName, accountId: main.accountId, sessionId: null };
    }
  } else if (opts.new) {
    composite = createComposite({
      name: opts.new === true ? undefined : opts.new,
      workingDir: opts.dir || process.cwd()
    });
    printSuccess(`新建复合对话: ${chalk.bold(composite.name)}`);
  } else {
    // 选择已有或新建
    const composites = listComposites();
    if (composites.length > 0 && !opts.forceNew) {
      const choices = [
        { name: chalk.green("+ 新建复合对话"), value: "__new__" },
        ...composites.map((c) => ({
          name: `${c.name}  ${chalk.gray(formatDate(c.updatedAt))}  ${chalk.dim(`(${c.messages?.length || 0} 条消息)`)}`,
          value: c.id
        }))
      ];

      const ans = await inquirer.prompt([{
        type: "list",
        name: "id",
        message: "选择复合对话:",
        choices,
        pageSize: 15
      }]);

      if (ans.id === "__new__") {
        composite = createComposite({ workingDir: opts.dir || process.cwd() });
        printSuccess(`新建复合对话: ${chalk.bold(composite.name)}`);
      } else {
        composite = getComposite(ans.id);
        printInfo(`继续复合对话: ${chalk.bold(composite?.name || ans.id)}`);
      }
    } else {
      composite = createComposite({
        name: opts.new || undefined,
        workingDir: opts.dir || process.cwd()
      });
      printSuccess(`新建复合对话: ${chalk.bold(composite.name)}`);
    }
  }

  if (!composite) {
    printError("无法创建/加载复合对话");
    return;
  }

  // 设置初始 session（若尚未设置）
  if (!composite.main.provider) {
    composite.main = { provider: main.providerName, accountId: main.accountId, sessionId: null };
  }

  // 选取模型：已有 composite 则恢复，否则交互选择
  mainModel = composite.mainModel || null;

  if (!mainModel) {
    mainModel = await selectModel(mainProvider, "AI", null);
  }

  setModels(composite, mainModel);

  // 保存首次组装完毕的 composite
  const { saveComposite } = await import("../agent/storage/composite.js");
  saveComposite(composite);

  // 保存 agent 配置偏好
  const agentConfig = getAgentConfig();
  if (!agentConfig.mainProvider) {
    setAgentConfigKey("mainProvider", main.providerName);
  }

  // ── 启动 TUI ──
  await agentTui({
    mainProvider,
    composite,
    mainModel,
    workingDir: composite.workingDir || process.cwd(),
    shellTimeout: opts.timeout ?? 120000,
    maxTokens: opts.maxTokens ?? 1000000,
    hooks: extCtx?.hooks,
    extTuiCommands: await (async () => {
      const { getExtensionTuiCommands } = await import("../extensions/index.js");
      return getExtensionTuiCommands();
    })()
  });
}

// ── 列表 ──

async function listAgents() {
  const composites = listComposites();
  if (composites.length === 0) {
    printInfo("暂无复合对话。运行 chat2cli agent 创建。");
    return;
  }

  printInfo(`共 ${chalk.bold(composites.length)} 个复合对话\n`);
  printTable(
    ["ID", "名称", "AI", "消息数", "更新时间"],
    composites.map((c) => [
      c.id.slice(0, 8),
      c.name || "-",
      c.main.provider || "-",
      String(c.messages?.length || 0),
      formatDate(c.updatedAt)
    ])
  );
}

// ── 批量删除 ──

async function batchDeleteAgents() {
  const composites = listComposites();
  if (composites.length === 0) {
    printInfo("暂无复合对话。");
    return;
  }

  const entries = composites.map((c) => ({
    id: c.id,
    label: `${c.name || "未命名"}  ${c.main.provider || "-"}  (${c.messages?.length || 0} 条)`
  }));

  // 行内实现 multiSelectPicker（避免跨文件依赖）
  const selected = await multiSelect(entries, "选择要删除的复合对话");
  if (!selected) { printInfo("已取消"); return; }
  if (selected.length === 0) { printInfo("未选择任何对话"); return; }

  const ans = await inquirer.prompt([{
    type: "confirm",
    name: "ok",
    message: `确认删除 ${chalk.bold(selected.length)} 个复合对话?`,
    default: false
  }]);

  if (!ans.ok) { printInfo("已取消"); return; }

  for (const id of selected) deleteComposite(id);
  printSuccess(`已删除 ${selected.length} 个复合对话`);
}

/** 多选列表选择器（空格切换，上下导航，Enter 确认） */
function multiSelect(entries, title) {
  if (!entries.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    const PAGE = 20;
    let selected = new Set();
    let cursor = 0;
    let scroll = 0;
    let escState = 0;

    function clearScreen() {
      const lines = Math.min(PAGE, entries.length - scroll) + 2;
      process.stdout.write(`\x1b[${lines}A\x1b[J`);
    }

    function fitOneLine(text, maxW) {
      let w = 0;
      for (let i = 0; i < text.length; i++) {
        w += text.charCodeAt(i) > 127 ? 2 : 1;
        if (w > maxW) return text.slice(0, i) + "...";
      }
      return text;
    }

    function cjkWidth(t) {
      return [...t].reduce((s, c) => s + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
    }

    function render() {
      const maxCols = (process.stdout.columns || 80) - 1;
      const end = Math.min(scroll + PAGE, entries.length);
      process.stdout.write(chalk.gray(`${title}  [空格]选择  [Enter]确认  [Ctrl+C]取消  (已选 ${selected.size})\n`));
      process.stdout.write(`  ${chalk.gray("─".repeat(56))}\n`);
      for (let i = scroll; i < end; i++) {
        const e = entries[i];
        const sel = selected.has(e.id);
        const mark = sel ? chalk.green("✓") : " ";
        const label = fitOneLine(e.label, maxCols - 12);
        const blank = " ".repeat(Math.max(1, maxCols - 12 - cjkWidth(label)));
        process.stdout.write(i === cursor
          ? chalk.bgCyan.black(` ❯ [${mark}] ${label}${blank}`) + "\n"
          : `   [${mark}] ${label}${blank}\n`);
      }
    }

    function scrollTo() {
      if (cursor < scroll) scroll = cursor;
      else if (cursor >= scroll + PAGE) scroll = cursor - PAGE + 1;
    }

    function toggle() {
      if (selected.has(entries[cursor].id)) selected.delete(entries[cursor].id);
      else selected.add(entries[cursor].id);
    }

    function onData(chunk) {
      const str = chunk.toString("utf-8");
      for (const char of str) {
        const code = char.codePointAt(0);
        if (escState > 0) {
          if (char === "[" && escState === 1) { escState = 2; continue; }
          if (escState === 2) {
            if (char === "A") { if (cursor > 0) cursor--; }
            else if (char === "B") { if (cursor < entries.length - 1) cursor++; }
            escState = 0; scrollTo(); clearScreen(); render(); continue;
          }
          escState = 0; continue;
        }
        if (code === 27) { escState = 1; continue; }
        if (code === 32) { toggle(); clearScreen(); render(); continue; }
        if (code === 13) {
          cleanup();
          resolve(selected.size ? [...selected] : []);
          return;
        }
        if (code === 3) { cleanup(); resolve(null); return; }
      }
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

// ── 删除 ──

async function deleteAgent(id) {
  // 先尝试精确/前缀匹配
  let composite = getComposite(id);

  // 如果精确匹配失败，检查是否有多个前缀匹配 => 让用户选择
  if (!composite) {
    const { findCompositesByPrefix } = await import("../agent/storage/composite.js");
    const matches = findCompositesByPrefix(id);
    if (matches.length === 0) {
      printError(`未找到复合对话: ${id}`);
      return;
    }
    if (matches.length > 1) {
      const ans = await inquirer.prompt([{
        type: "list",
        name: "selection",
        message: `找到多个匹配的复合对话，请选择要删除的:`,
        choices: matches.map((c) => ({
          name: `${c.name}  ${chalk.gray(formatDate(c.updatedAt))}  ${chalk.dim(`(${c.messages?.length || 0} 条消息)`)}`,
          value: c.id
        }))
      }]);
      composite = getComposite(ans.selection);
    } else {
      composite = matches[0];
    }
  }

  if (!composite) {
    printError(`未找到复合对话: ${id}`);
    return;
  }

  const ans = await inquirer.prompt([{
    type: "confirm",
    name: "ok",
    message: `确认删除复合对话 "${composite.name}"?`,
    default: false
  }]);

  if (!ans.ok) {
    printInfo("已取消");
    return;
  }

  deleteComposite(composite.id);
  printSuccess(`已删除: ${composite.name}`);
}
