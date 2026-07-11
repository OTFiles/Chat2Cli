import inquirer from "inquirer";
import chalk from "chalk";
import { initProviders, getProvider } from "../providers/registry.js";
import { getConfig, getAgentConfig, setAgentConfigKey } from "../config.js";
import { printSuccess, printError, printInfo, printTable, formatDate, accountLabel } from "../utils/format.js";
import { listComposites, createComposite, getComposite, deleteComposite } from "../agent/storage/composite.js";
import { agentTui } from "../agent/tui.js";

/**
 * 从已登录账号中选取一个 provider 和账号
 * @param {string} role - "主AI" 或 "辅助AI"
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

export async function runAgent(opts = {}) {
  initProviders();

  // ── 列表模式 ──
  if (opts.list) {
    return listAgents();
  }

  // ── 删除模式 ──
  if (opts.delete) {
    return deleteAgent(opts.delete);
  }

  // ── 获取配置 ──
  const agentPrefs = getAgentConfig();

  // 选取主 AI
  const main = await selectProvider("主AI", agentPrefs.mainProvider);
  const mainProvider = getProvider(main.providerName);
  if (!mainProvider) {
    printError(`未找到主 AI provider: ${main.providerName}`);
    return;
  }

  // 选取辅助 AI
  const aux = await selectProvider("辅助AI", agentPrefs.auxProvider);
  const auxProvider = getProvider(aux.providerName);
  if (!auxProvider) {
    printError(`未找到辅助 AI provider: ${aux.providerName}`);
    return;
  }

  // ── 复合对话 ──
  let composite;

  if (opts.continue) {
    composite = getComposite(opts.continue);
    if (!composite) {
      printError(`未找到复合对话: ${opts.continue}`);
      return;
    }
    printInfo(`继续复合对话: ${chalk.bold(composite.name)}`);

    // 更新 main/aux session 信息（如果 provider 变了）
    if (composite.main.provider !== main.providerName || composite.main.accountId !== main.accountId) {
      composite.main = { provider: main.providerName, accountId: main.accountId, sessionId: null };
    }
    if (composite.aux.provider !== aux.providerName || composite.aux.accountId !== aux.accountId) {
      composite.aux = { provider: aux.providerName, accountId: aux.accountId, sessionId: null };
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

  // 设置 main/aux 的初始 session（若尚未设置）
  if (!composite.main.provider) {
    composite.main = { provider: main.providerName, accountId: main.accountId, sessionId: null };
  }
  if (!composite.aux.provider) {
    composite.aux = { provider: aux.providerName, accountId: aux.accountId, sessionId: null };
  }

  // 保存首次组装完毕的 composite
  const { saveComposite } = await import("../agent/storage/composite.js");
  saveComposite(composite);

  // 设置模型（取 main provider 的默认模型）
  if (!composite.model) {
    const models = mainProvider.getModels();
    composite.model = models[0]?.id || "deepseek-chat-fast";
    saveComposite(composite);
  }

  // 保存 agent 配置偏好（下次默认使用相同配置）
  const agentConfig = getAgentConfig();
  if (!agentConfig.mainProvider) {
    setAgentConfigKey("mainProvider", main.providerName);
    setAgentConfigKey("auxProvider", aux.providerName);
  }

  // ── 启动 TUI ──
  await agentTui({
    mainProvider,
    auxProvider,
    composite,
    workingDir: composite.workingDir || process.cwd()
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
    ["ID", "名称", "主AI", "辅助AI", "消息数", "更新时间"],
    composites.map((c) => [
      c.id.slice(0, 8),
      c.name || "-",
      c.main.provider || "-",
      c.aux.provider || "-",
      String(c.messages?.length || 0),
      formatDate(c.updatedAt)
    ])
  );
}

// ── 删除 ──

async function deleteAgent(id) {
  const composite = getComposite(id);
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

  deleteComposite(id);
  printSuccess(`已删除: ${composite.name}`);
}
