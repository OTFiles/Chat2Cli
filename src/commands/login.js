import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { initProviders, getProvider, listProviders } from "../providers/registry.js";
import { setConfigKey } from "../config.js";
import { printSuccess, printError, printInfo, accountLabel } from "../utils/format.js";

/** 交互式删除账号（多账号 provider） */
async function interactiveDeleteAccount(provider) {
  const accounts = provider.listAccounts();
  if (!accounts.length) {
    printInfo("没有可删除的账号");
    return;
  }

  const { default: inquirer } = await import("inquirer");
  const { target } = await inquirer.prompt([{
    type: "list",
    name: "target",
    message: "选择要删除的账号:",
    choices: [
      ...accounts.map((a, i) => ({
        name: `${i + 1}. ${accountLabel(a)}`,
        value: a.id
      })),
      { name: "取消", value: null }
    ]
  }]);

  if (!target) { printInfo("已取消"); return; }

  const { confirm } = await inquirer.prompt([{
    type: "confirm",
    name: "confirm",
    message: `确认删除账号 "${accountLabel(accounts.find(a => a.id === target))}"？`,
    default: false
  }]);

  if (!confirm) { printInfo("已取消"); return; }

  const removed = provider.removeAccount(target);
  if (removed) {
    printSuccess(`已删除账号: ${accountLabel(removed)}`);
  }
}

/** 登录成功后自动切换默认服务商（并写入配置） */
function autoSwitchProvider(providerName) {
  setConfigKey("defaultProvider", providerName);
  printInfo(`默认服务商已切换为: ${chalk.bold(providerName)}`);
}

async function loginDeepseek(provider) {
  // 显示已有账号
  const existing = provider.listAccounts();
  if (existing.length > 0) {
    printInfo(`当前已有 ${chalk.bold(existing.length)} 个 DeepSeek 账号:`);
    for (const a of existing) {
      process.stdout.write(chalk.gray(`  - ${accountLabel(a)}\n`));
    }
    process.stdout.write("\n");

    const { default: inquirer } = await import("inquirer");
    const { action } = await inquirer.prompt([{
      type: "list",
      name: "action",
      message: "选择操作:",
      choices: [
        { name: "添加新账号", value: "add" },
        { name: "删除已有账号", value: "delete" },
        { name: "取消", value: "cancel" }
      ]
    }]);
    if (action === "cancel") return;
    if (action === "delete") {
      await interactiveDeleteAccount(provider);
      return;
    }
  }

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "loginValue",
      message: "邮箱或手机号:",
      validate: (v) => v.trim() ? true : "必填项"
    },
    {
      type: "password",
      name: "password",
      message: "密码:",
      mask: "*",
      validate: (v) => v.length > 0 ? true : "密码不能为空"
    }
  ]);

  const spinner = ora("正在登录 DeepSeek...").start();
  try {
    const account = await provider.login(answers);
    spinner.succeed("登录成功");

    const total = provider.listAccounts().length;
    printSuccess(`已登录: ${chalk.bold(accountLabel(account))} (共 ${total} 个账号)`);
    autoSwitchProvider(provider.name);
  } catch (err) {
    spinner.fail("登录失败");
    printError(err.message);
  }
}

async function loginQwen(provider) {
  // 显示已有账号
  const existing = provider.listAccounts();
  if (existing.length > 0) {
    printInfo(`当前已有 ${chalk.bold(existing.length)} 个 Qwen 账号:`);
    for (const a of existing) {
      process.stdout.write(chalk.gray(`  - ${accountLabel(a)}\n`));
    }
    process.stdout.write("\n");

    const { default: inquirer } = await import("inquirer");
    const { action } = await inquirer.prompt([{
      type: "list",
      name: "action",
      message: "选择操作:",
      choices: [
        { name: "添加新账号", value: "add" },
        { name: "删除已有账号", value: "delete" },
        { name: "取消", value: "cancel" }
      ]
    }]);
    if (action === "cancel") return;
    if (action === "delete") {
      await interactiveDeleteAccount(provider);
      return;
    }
  }

  // 选择登录方式
  const { loginType } = await inquirer.prompt([{
    type: "list",
    name: "loginType",
    message: "选择登录方式:",
    choices: [
      { name: "邮箱 + 密码登录（推荐）", value: "password" },
      { name: "手动输入 Bearer Token", value: "token" },
    ]
  }]);

  if (loginType === "token") {
    process.stdout.write(chalk.gray("如何获取 Bearer Token:\n"));
    process.stdout.write(chalk.gray("  1. 浏览器打开 https://chat.qwen.ai 并登录\n"));
    process.stdout.write(chalk.gray("  2. 打开开发者工具 (F12) → Application → Local Storage\n"));
    process.stdout.write(chalk.gray("  3. 查找 key 为 'token' 的项\n\n"));

    const answers = await inquirer.prompt([
      {
        type: "password",
        name: "token",
        message: "Bearer Token:",
        mask: "*",
        validate: (v) => v.trim().length > 0 ? true : "Token 不能为空"
      },
      {
        type: "input",
        name: "email",
        message: "备注（如邮箱，可选）:",
        default: ""
      }
    ]);

    const spinner = ora("正在验证 Qwen token...").start();
    try {
      const account = await provider.login(answers);
      spinner.succeed("登录成功");

      const total = provider.listAccounts().length;
      printSuccess(`已登录: ${chalk.bold(accountLabel(account))} (共 ${total} 个账号)`);
      autoSwitchProvider(provider.name);
    } catch (err) {
      spinner.fail("登录失败");
      printError(err.message);
    }
    return;
  }

  // 邮箱 + 密码登录
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "email",
      message: "邮箱:",
      validate: (v) => v.trim().includes("@") ? true : "请输入有效邮箱"
    },
    {
      type: "password",
      name: "password",
      message: "密码:",
      mask: "*",
      validate: (v) => v.length > 0 ? true : "密码不能为空"
    }
  ]);

  const spinner = ora("正在登录 Qwen...").start();
  try {
    const account = await provider.login(answers);
    spinner.succeed("登录成功");

    const total = provider.listAccounts().length;
    printSuccess(`已登录: ${chalk.bold(accountLabel(account))} (共 ${total} 个账号)`);
    autoSwitchProvider(provider.name);
  } catch (err) {
    spinner.fail("登录失败");
    printError(err.message);
  }
}

async function loginOpenAI(provider) {
  const existing = provider.getAccountInfo();
  if (existing?.apiKey) {
    printInfo(`当前已配置 OpenAI:`);
    process.stdout.write(chalk.gray(`  - ${accountLabel(existing)}\n\n`));

    const { default: inquirer } = await import("inquirer");
    const { action } = await inquirer.prompt([{
      type: "list",
      name: "action",
      message: "选择操作:",
      choices: [
        { name: "重新配置", value: "add" },
        { name: "删除配置", value: "delete" },
        { name: "取消", value: "cancel" }
      ]
    }]);
    if (action === "cancel") return;
    if (action === "delete") {
      const { confirm } = await inquirer.prompt([{
        type: "confirm",
        name: "confirm",
        message: "确认删除 OpenAI 配置？",
        default: false
      }]);
      if (confirm) {
        provider.removeAccount();
        printSuccess("OpenAI 配置已删除");
      }
      return;
    }
  }

  const answers = await inquirer.prompt([
    {
      type: "password",
      name: "apiKey",
      message: "OpenAI API Key:",
      mask: "*",
      validate: (v) => v.trim().length > 0 ? true : "API Key 不能为空"
    },
    {
      type: "input",
      name: "baseUrl",
      message: "Base URL（直接回车使用默认地址）:",
      default: "https://api.openai.com"
    }
  ]);

  const spinner = ora("正在保存 OpenAI 配置...").start();
  try {
    const account = await provider.login(answers);
    spinner.succeed("保存成功");
    printSuccess(`OpenAI 已配置。使用地址: ${chalk.bold(account.baseUrl)}`);
    autoSwitchProvider(provider.name);
  } catch (err) {
    spinner.fail("保存失败");
    printError(err.message);
  }
}

export async function runLogin() {
  initProviders();
  const providers = listProviders();

  const { providerName } = await inquirer.prompt([
    {
      type: "list",
      name: "providerName",
      message: "选择 AI 服务商:",
      choices: providers.map((p) => ({ name: p.label, value: p.name }))
    }
  ]);

  const provider = getProvider(providerName);

  if (providerName === "deepseek") {
    await loginDeepseek(provider);
  } else if (providerName === "openai") {
    await loginOpenAI(provider);
  } else if (providerName === "qwen") {
    await loginQwen(provider);
  } else {
    printError(`未知的服务商: ${providerName}`);
  }
}
