import inquirer from "inquirer";
import chalk from "chalk";
import { getStore, updateStore } from "../storage/store.js";
import { createId } from "../utils/id.js";
import { printSuccess, printError, printInfo, printTable, formatDate } from "../utils/format.js";

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
    default:
      await listKeys();
  }
}

async function createKey() {
  const state = getStore();
  const providerNames = [];

  // 检测已登录的服务商
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
    }
  ]);

  const keyValue = generateApiKey();
  const apiKey = {
    id: createId(),
    key: keyValue,
    provider: answers.provider,
    label: answers.label || "未命名",
    createdAt: new Date().toISOString()
  };

  updateStore((state) => ({
    ...state,
    apiKeys: [...state.apiKeys, apiKey]
  }));

  printSuccess("API Key 已创建:");
  process.stdout.write(chalk.cyan(`\n  Key: ${chalk.bold(keyValue)}\n\n`));
  process.stdout.write(chalk.gray(`  请妥善保存，此 Key 仅显示一次。\n`));
  process.stdout.write(chalk.gray(`  使用方式: Authorization: Bearer ${keyValue}\n\n`));
}

async function listKeys() {
  const state = getStore();
  const keys = state.apiKeys;

  if (!keys.length) {
    printInfo("暂无 API Key。运行 chat2cli apikey create 创建。");
    return;
  }

  printInfo(`共 ${chalk.bold(keys.length)} 个 API Key\n`);
  printTable(
    ["ID", "服务商", "备注", "Key（脱敏）", "创建时间"],
    keys.map((k) => [
      k.id.slice(0, 8),
      k.provider,
      k.label || "-",
      `${k.key.slice(0, 12)}...${k.key.slice(-4)}`,
      formatDate(k.createdAt)
    ])
  );
}

async function showKey(keyId) {
  const state = getStore();
  const key = state.apiKeys.find((k) => k.id.startsWith(keyId));
  if (!key) {
    printError(`未找到 API Key: ${keyId}`);
    return;
  }

  process.stdout.write(chalk.bold(`\nAPI Key 详情\n`));
  process.stdout.write(chalk.gray("─".repeat(50) + "\n"));
  process.stdout.write(`  服务商: ${key.provider}\n`);
  process.stdout.write(`  备  注: ${key.label || "-"}\n`);
  process.stdout.write(`  创  建: ${formatDate(key.createdAt)}\n`);
  process.stdout.write(chalk.cyan(`  Key: ${chalk.bold(key.key)}\n`));
  process.stdout.write(chalk.gray("─".repeat(50) + "\n\n"));
}

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
