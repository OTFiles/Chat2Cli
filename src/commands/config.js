import chalk from "chalk";
import { initProviders, getProvider, listProviders } from "../providers/registry.js";
import { getConfig, setConfigKey } from "../config.js";
import { getStore, updateStore } from "../storage/store.js";
import { printSuccess, printError, printInfo, accountLabel } from "../utils/format.js";

export async function runConfig(cmd, key, value) {
  initProviders();

  switch (cmd) {
    case "set":
      await configSet(key, value);
      break;
    case "account-name":
      await configSetAccountName(key, value);
      break;
    default:
      await configShow();
  }
}

async function configShow() {
  const config = getConfig();
  const providers = listProviders();

  process.stdout.write(chalk.bold("\n当前配置:\n\n"));
  process.stdout.write(`  默认服务商: ${chalk.cyan(config.defaultProvider)}\n`);
  process.stdout.write(`  默认模型:   ${chalk.cyan(config.defaultModel)}\n\n`);

  process.stdout.write(chalk.bold("可用服务商:\n\n"));
  for (const p of providers) {
    const isDefault = p.name === config.defaultProvider;
    const marker = isDefault ? chalk.green(" * ") : "   ";
    const authenticated = p.isAuthenticated() ? chalk.green("[已登录]") : chalk.yellow("[未登录]");
    process.stdout.write(`${marker}${chalk.bold(p.label)} (${p.name}) ${authenticated}\n`);

    if (p.isAuthenticated()) {
      // 多账号服务商列出所有账号
      if (typeof p.listAccounts === "function") {
        const accounts = p.listAccounts();
        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          const nickname = a.nickname ? chalk.cyan(a.nickname) + " " : "";
          process.stdout.write(`     账号${i + 1}: ${nickname}${chalk.dim(accountLabel(a))}\n`);
        }
      } else {
        const info = p.getAccountInfo();
        if (info) {
          if (info.nickname) {
            process.stdout.write(`     名称: ${chalk.cyan(info.nickname)}\n`);
          }
          if (info.apiKey) {
            process.stdout.write(`     API Key: ${chalk.dim(info.apiKey.slice(0, 8) + "..." + info.apiKey.slice(-4))}\n`);
          }
          if (info.baseUrl) {
            process.stdout.write(`     地址: ${chalk.dim(info.baseUrl)}\n`);
          }
        }
      }
    }
  }
  process.stdout.write("\n");
}

async function configSet(key, value) {
  if (!key || !value) {
    printError("用法: chat2cli config set <键> <值>");
    printInfo("可用的键: defaultProvider, defaultModel");
    return;
  }

  if (key === "defaultProvider") {
    const provider = getProvider(value);
    if (!provider) {
      printError(`未知的服务商: ${value}`);
      printInfo(`可选: ${listProviders().map((p) => p.name).join(", ")}`);
      return;
    }
  }

  setConfigKey(key, value);
  printSuccess(`已设置 ${chalk.bold(key)} = ${chalk.cyan(value)}`);
}

/** 给指定账号设置昵称 */
async function configSetAccountName(providerName, nickname) {
  if (!providerName) {
    // 交互式选择
    const { default: inquirer } = await import("inquirer");
    const state = getStore();
    const allAccounts = [];

    for (const pName of ["deepseek", "qwen", "openai"]) {
      const accounts = state.providers?.[pName]?.accounts || [];
      // OpenAI 用单账号结构
      if (pName === "openai" && state.providers?.openai?.apiKey) {
        allAccounts.push({ provider: pName, account: state.providers.openai, label: accountLabel(state.providers.openai) });
        continue;
      }
      for (let i = 0; i < accounts.length; i++) {
        allAccounts.push({ provider: pName, account: accounts[i], label: accountLabel(accounts[i]), index: i });
      }
    }

    if (!allAccounts.length) {
      printError("没有已登录的账号");
      return;
    }

    const { selected } = await inquirer.prompt([{
      type: "list",
      name: "selected",
      message: "选择要命名的账号:",
      choices: allAccounts.map((a, i) => ({
        name: `[${a.provider}] ${a.label}${a.account.nickname ? chalk.cyan(" (" + a.account.nickname + ")") : ""}`,
        value: i
      }))
    }]);

    const target = allAccounts[selected];
    const { newName } = await inquirer.prompt([{
      type: "input",
      name: "newName",
      message: "输入昵称（留空取消）:",
      default: target.account.nickname || ""
    }]);

    if (!newName.trim()) {
      // 删除昵称
      updateStore((state) => {
        const providers = { ...state.providers };
        if (target.provider === "openai") {
          providers.openai = { ...providers.openai, nickname: "" };
        } else {
          const accs = [...(providers[target.provider]?.accounts || [])];
          if (accs[target.index]) {
            accs[target.index] = { ...accs[target.index], nickname: "" };
            providers[target.provider] = { ...providers[target.provider], accounts: accs };
          }
        }
        return { ...state, providers };
      });
      printSuccess(`已清除 ${chalk.bold(target.label)} 的昵称`);
      return;
    }

    updateStore((state) => {
      const providers = { ...state.providers };
      if (target.provider === "openai") {
        providers.openai = { ...providers.openai, nickname: newName.trim() };
      } else {
        const accs = [...(providers[target.provider]?.accounts || [])];
        if (accs[target.index]) {
          accs[target.index] = { ...accs[target.index], nickname: newName.trim() };
          providers[target.provider] = { ...providers[target.provider], accounts: accs };
        }
      }
      return { ...state, providers };
    });
    printSuccess(`已将 ${chalk.bold(target.label)} 命名为 ${chalk.cyan(newName.trim())}`);
    return;
  }

  // 非交互式：config account-name <provider> <index> <name>
  if (!nickname) {
    printError("用法: chat2cli config account-name [昵称]");
    printInfo("不带参数时交互式选择账号命名");
    return;
  }

  const providerNameLower = providerName.toLowerCase();
  const state = getStore();
  const providerData = state.providers?.[providerNameLower];

  if (!providerData) {
    printError(`未知的服务商: ${providerName}`);
    return;
  }

  if (providerNameLower === "openai") {
    if (!providerData.apiKey) { printError("未登录 OpenAI"); return; }
    updateStore((s) => ({
      ...s,
      providers: { ...s.providers, openai: { ...s.providers.openai, nickname: nickname } }
    }));
    printSuccess(`OpenAI 账号已命名为: ${chalk.cyan(nickname)}`);
    return;
  }

  const accounts = providerData.accounts || [];
  if (!accounts.length) { printError(`没有 ${providerName} 账号`); return; }

  if (accounts.length === 1) {
    updateStore((s) => {
      const p = { ...s.providers };
      const accs = [...(p[providerNameLower]?.accounts || [])];
      accs[0] = { ...accs[0], nickname };
      p[providerNameLower] = { ...p[providerNameLower], accounts: accs };
      return { ...s, providers: p };
    });
    printSuccess(`${providerName} 账号已命名为: ${chalk.cyan(nickname)}`);
    return;
  }

  // 多账号：第二个参数作为 index
  const idx = parseInt(nickname, 10);
  if (isNaN(idx) || idx < 1 || idx > accounts.length) {
    printError(`请指定账号序号 (1-${accounts.length}): config account-name ${providerName} <序号> <昵称>`);
    return;
  }

  const actualName = arguments[3]; // 第三个参数是昵称
  if (!actualName) {
    printError(`用法: config account-name ${providerName} ${idx} <昵称>`);
    return;
  }

  updateStore((s) => {
    const p = { ...s.providers };
    const accs = [...(p[providerNameLower]?.accounts || [])];
    accs[idx - 1] = { ...accs[idx - 1], nickname: actualName };
    p[providerNameLower] = { ...p[providerNameLower], accounts: accs };
    return { ...s, providers: p };
  });
  printSuccess(`${providerName} 账号${idx} 已命名为: ${chalk.cyan(actualName)}`);
}
