import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { initProviders, getProvider, listProviders } from "../providers/registry.js";
import { printSuccess, printError, printInfo } from "../utils/format.js";

async function loginDeepseek(provider) {
  // 显示已有账号
  const existing = provider.listAccounts();
  if (existing.length > 0) {
    printInfo(`当前已有 ${chalk.bold(existing.length)} 个 DeepSeek 账号:`);
    for (const a of existing) {
      process.stdout.write(chalk.gray(`  - ${a.displayName} (${a.loginValue})\n`));
    }
    process.stdout.write("\n");
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
    printSuccess(`已登录: ${chalk.bold(account.displayName)} (共 ${total} 个账号)`);
  } catch (err) {
    spinner.fail("登录失败");
    printError(err.message);
  }
}

async function loginOpenAI(provider) {
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
  } else {
    printError(`未知的服务商: ${providerName}`);
  }
}
