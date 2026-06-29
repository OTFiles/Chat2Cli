import chalk from "chalk";
import { initProviders, getProvider, listProviders } from "../providers/registry.js";
import { getConfig, setConfigKey } from "../config.js";
import { printSuccess, printError, printInfo } from "../utils/format.js";

export async function runConfig(cmd, key, value) {
  initProviders();

  switch (cmd) {
    case "set":
      await configSet(key, value);
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
      // 多账号服务商（DeepSeek）列出所有账号
      if (p.name === "deepseek" && typeof p.listAccounts === "function") {
        const accounts = p.listAccounts();
        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          process.stdout.write(`     账号${i + 1}: ${chalk.dim(a.displayName)}  (${chalk.dim(a.loginValue)})\n`);
        }
      } else {
        const info = p.getAccountInfo();
        if (info) {
          if (info.displayName) {
            process.stdout.write(`     账号: ${chalk.dim(info.displayName)}\n`);
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
