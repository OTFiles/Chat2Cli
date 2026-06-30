import inquirer from "inquirer";
import chalk from "chalk";
import { getStore, updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import { printSuccess, printError, printInfo, printTable, printWarn, formatDate } from "../utils/format.js";

function generateApiKey() {
  return `dsr_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
}

export async function runApiKey(action, ...args) {
  switch (action) {
    case "create":
      await createKey();
      break;
    case "list":
      await listKeys();
      break;
    case "show":
      await showKey(args[0]);
      break;
    case "delete":
      await deleteKey(args[0]);
      break;
    case "bind":
      await bindKey(args[0]);
      break;
    case "unbind":
      await unbindKey(args[0]);
      break;
    default:
      await listKeys();
  }
}

// ── 获取可用的 DeepSeek 账号列表 ──

function getAvailableAccounts() {
  const state = getStore();
  const accounts = state.providers?.deepseek?.accounts || [];
  return accounts.map((a) => ({
    name: `${a.displayName || a.loginValue} (${a.emailMasked || a.mobileMasked || a.loginValue})`,
    value: a.id
  }));
}

// ── 选择 API Key（交互式）──

async function selectApiKey(keys, message) {
  if (!keys.length) return null;
  if (keys.length === 1) return keys[0];

  const ans = await inquirer.prompt([{
    type: "list",
    name: "keyIndex",
    message,
    choices: keys.map((k, i) => ({
      name: `${k.label}  [${k.key.slice(0, 12)}...${k.key.slice(-4)}]`,
      value: i
    }))
  }]);
  return keys[ans.keyIndex];
}

// ── 查找 Key（支持 ID 前缀模糊匹配）──

function findKeyById(keyId) {
  const state = getStore();
  return state.apiKeys.find((k) => k.id.startsWith(keyId));
}

// ═══════════════════════════════════════════════
//  create  — 创建 API Key（可选绑定账号）
// ═══════════════════════════════════════════════

async function createKey() {
  const state = getStore();
  const providerNames = [];

  if (state.providers?.deepseek?.accounts?.length > 0) {
    providerNames.push({ name: "DeepSeek", value: "deepseek" });
  }
  if (state.providers?.openai?.apiKey) {
    providerNames.push({ name: "OpenAI", value: "openai" });
  }

  if (!providerNames.length) {
    printError("没有已登录的服务商，请先运行 chat2cli login");
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "provider",
      message: "选择服务商:",
      choices: providerNames
    },
    {
      type: "input",
      name: "label",
      message: "API Key 备注（可选）:",
      default: ""
    },
    {
      type: "confirm",
      name: "bindNow",
      message: "是否立即绑定到此服务商的账号?",
      default: true
    }
  ]);

  let accountId = null;

  if (answers.bindNow) {
    if (answers.provider === "deepseek") {
      const accounts = getAvailableAccounts();
      if (accounts.length === 0) {
        printWarn("没有可用的 DeepSeek 账号（请先登录）");
      } else if (accounts.length === 1) {
        accountId = accounts[0].value;
      } else {
        const accAns = await inquirer.prompt([{
          type: "list",
          name: "accountId",
          message: "选择要绑定的 DeepSeek 账号:",
          choices: accounts
        }]);
        accountId = accAns.accountId;
      }
    }
    // OpenAI 暂不需要多账号绑定
  }

  const keyValue = generateApiKey();

  updateStore((state) => ({
    ...state,
    apiKeys: [...state.apiKeys, {
      id: createId(),
      key: keyValue,
      provider: answers.provider,
      accountId,
      label: answers.label || "未命名",
      createdAt: new Date().toISOString()
    }]
  }));

  printSuccess("API Key 已创建:");
  process.stdout.write(chalk.cyan(`\n  Key: ${chalk.bold(keyValue)}\n\n`));
  if (accountId) {
    const accounts = getAvailableAccounts();
    const acc = accounts.find((a) => a.value === accountId);
    if (acc) process.stdout.write(chalk.gray(`  已绑定账号: ${acc.name}\n\n`));
  } else {
    process.stdout.write(chalk.yellow(`  ⚠ 未绑定账号，使用前请先绑定: chat2cli apikey bind <keyId>\n\n`));
  }
  process.stdout.write(chalk.gray(`  使用方式: Authorization: Bearer ${keyValue}\n\n`));
}

// ═══════════════════════════════════════════════
//  bind  — 将 API Key 绑定到具体账号
// ═══════════════════════════════════════════════

async function bindKey(keyId) {
  const state = getStore();

  // 确定要操作的 Key
  let targetKey;
  if (keyId) {
    targetKey = findKeyById(keyId);
    if (!targetKey) {
      printError(`未找到 API Key: ${keyId}`);
      return;
    }
  } else {
    // 交互式选择未绑定的 Key
    const unbound = state.apiKeys.filter((k) => !k.accountId);
    if (!unbound.length) {
      printInfo("所有 API Key 已绑定账号");
      return;
    }
    targetKey = await selectApiKey(unbound, "选择要绑定的 API Key:");
    if (!targetKey) return;
  }

  if (targetKey.accountId) {
    const accounts = getAvailableAccounts();
    const curAcc = accounts.find((a) => a.value === targetKey.accountId);
    const name = curAcc?.name || targetKey.accountId;
    const { confirm } = await inquirer.prompt([{
      type: "confirm",
      name: "confirm",
      message: `此 Key 已绑定到 ${chalk.bold(name)}，是否重新绑定?`,
      default: false
    }]);
    if (!confirm) {
      printInfo("已取消");
      return;
    }
  }

  const accounts = getAvailableAccounts();
  if (!accounts.length) {
    printError("没有可用的 DeepSeek 账号，请先运行 chat2cli login");
    return;
  }

  let accountId;
  if (accounts.length === 1) {
    accountId = accounts[0].value;
  } else {
    const ans = await inquirer.prompt([{
      type: "list",
      name: "accountId",
      message: "选择要绑定的 DeepSeek 账号:",
      choices: accounts
    }]);
    accountId = ans.accountId;
  }

  updateStore((state) => {
    const idx = state.apiKeys.findIndex((k) => k.id === targetKey.id);
    if (idx < 0) return state;
    const updated = [...state.apiKeys];
    updated[idx] = { ...updated[idx], accountId };
    return { ...state, apiKeys: updated };
  });

  const boundAcc = accounts.find((a) => a.value === accountId);
  printSuccess(`已绑定: ${chalk.bold(targetKey.label)} → ${chalk.cyan(boundAcc?.name || accountId)}`);
}

// ═══════════════════════════════════════════════
//  unbind  — 解除 API Key 的账号绑定
// ═══════════════════════════════════════════════

async function unbindKey(keyId) {
  const state = getStore();

  let targetKey;
  if (keyId) {
    targetKey = findKeyById(keyId);
    if (!targetKey) {
      printError(`未找到 API Key: ${keyId}`);
      return;
    }
  } else {
    const bound = state.apiKeys.filter((k) => k.accountId);
    if (!bound.length) {
      printInfo("没有已绑定的 API Key");
      return;
    }
    targetKey = await selectApiKey(bound, "选择要解绑的 API Key:");
    if (!targetKey) return;
  }

  if (!targetKey.accountId) {
    printInfo("此 Key 未绑定账号，无需解绑");
    return;
  }

  updateStore((state) => {
    const idx = state.apiKeys.findIndex((k) => k.id === targetKey.id);
    if (idx < 0) return state;
    const updated = [...state.apiKeys];
    updated[idx] = { ...updated[idx], accountId: null };
    return { ...state, apiKeys: updated };
  });

  printSuccess(`已解绑: ${chalk.bold(targetKey.label)}`);
}

// ═══════════════════════════════════════════════
//  list  — 列出所有 API Key（含绑定状态）
// ═══════════════════════════════════════════════

async function listKeys() {
  const state = getStore();
  const keys = state.apiKeys;

  if (!keys.length) {
    printInfo("暂无 API Key。运行 chat2cli apikey create 创建。");
    return;
  }

  const accounts = getAvailableAccounts();
  const accountMap = new Map(accounts.map((a) => [a.value, a.name]));

  printInfo(`共 ${chalk.bold(keys.length)} 个 API Key\n`);
  printTable(
    ["ID", "服务商", "备注", "绑定账号", "Key（脱敏）", "创建时间"],
    keys.map((k) => {
      const boundName = k.accountId
        ? (accountMap.get(k.accountId) || k.accountId.slice(0, 8) + "...")
        : chalk.red("未绑定");
      return [
        k.id.slice(0, 8),
        k.provider,
        k.label || "-",
        boundName,
        `${k.key.slice(0, 12)}...${k.key.slice(-4)}`,
        formatDate(k.createdAt)
      ];
    })
  );

  // 如果存在未绑定的 key，给出提示
  const unboundCount = keys.filter((k) => !k.accountId).length;
  if (unboundCount > 0) {
    process.stdout.write(
      chalk.yellow(`  ⚠ ${unboundCount} 个 Key 未绑定账号，` +
        `运行 ${chalk.bold("chat2cli apikey bind <keyId>")} 绑定\n\n`));
  }
}

// ═══════════════════════════════════════════════
//  show  — 查看 Key 详情
// ═══════════════════════════════════════════════

async function showKey(keyId) {
  const state = getStore();
  const key = state.apiKeys.find((k) => k.id.startsWith(keyId));
  if (!key) {
    printError(`未找到 API Key: ${keyId}`);
    return;
  }

  const accounts = getAvailableAccounts();
  const boundAcc = key.accountId
    ? accounts.find((a) => a.value === key.accountId)
    : null;

  process.stdout.write(chalk.bold(`\nAPI Key 详情\n`));
  process.stdout.write(chalk.gray("─".repeat(50) + "\n"));
  process.stdout.write(`  服务商: ${key.provider}\n`);
  process.stdout.write(`  备  注: ${key.label || "-"}\n`);
  process.stdout.write(
    `  绑  定: ${boundAcc
      ? chalk.green(boundAcc.name)
      : chalk.red("未绑定")}\n`);
  process.stdout.write(`  创  建: ${formatDate(key.createdAt)}\n`);
  process.stdout.write(chalk.cyan(`  Key: ${chalk.bold(key.key)}\n`));
  process.stdout.write(chalk.gray("─".repeat(50) + "\n\n"));

  if (!key.accountId) {
    process.stdout.write(
      chalk.yellow(`  提示: 使用 ${chalk.bold("chat2cli apikey bind " + key.id.slice(0, 8))} 绑定账号\n\n`));
  }
}

// ═══════════════════════════════════════════════
//  delete  — 删除 API Key
// ═══════════════════════════════════════════════

async function deleteKey(keyId) {
  if (!keyId) {
    printError("请指定要删除的 API Key ID");
    return;
  }

  let deleted;
  updateStore((state) => {
    const idx = state.apiKeys.findIndex((k) => k.id.startsWith(keyId));
    if (idx < 0) return state;
    deleted = state.apiKeys[idx];
    return {
      ...state,
      apiKeys: state.apiKeys.filter((_, i) => i !== idx)
    };
  });

  if (deleted) {
    printSuccess(`已删除 API Key: ${chalk.bold(deleted.label)} (${chalk.dim(deleted.key.slice(0, 12) + "...")})`);
  } else {
    printError(`未找到 API Key: ${keyId}`);
  }
}
