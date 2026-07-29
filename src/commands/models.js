import chalk from "chalk";
import { initProviders, getProvider, listProviders } from "../providers/registry.js";
import { getConfig } from "../config.js";
import { printError } from "../utils/format.js";

/**
 * models 命令：列出 / 刷新模型列表
 *
 * 用法:
 *   chat2cli models                      列出当前默认 provider 的模型
 *   chat2cli models list                 同上
 *   chat2cli models refresh              强制刷新当前 provider 的模型列表
 *   chat2cli models refresh -p qwen      指定 provider
 *   chat2cli models -p openai            列出指定 provider 的模型
 *
 * 仅支持 refreshModels() 的 provider（如 qwen）才能刷新；
 * 其它 provider（deepseek/glm/openai）使用静态列表，刷新会给出提示。
 */
export async function runModels(action, opts = {}) {
  initProviders();

  const cmd = (action || "list").toLowerCase();
  if (cmd !== "list" && cmd !== "refresh") {
    printError(`未知操作: ${action}（可用: list, refresh）`);
    process.exit(1);
  }

  const providerName = opts.provider || getConfig().defaultProvider;
  const provider = getProvider(providerName);
  if (!provider) {
    printError(`未知的服务商: ${providerName}`);
    process.stdout.write(chalk.gray("已注册的服务商: ") + listProviders().map((p) => p.name).join(", ") + "\n");
    process.exit(1);
  }

  if (cmd === "refresh") {
    if (typeof provider.refreshModels !== "function") {
      printError(`${provider.label} 不支持动态刷新模型列表（使用静态列表）`);
      process.exit(1);
    }
    if (!provider.isAuthenticated()) {
      printError(`${provider.label} 未登录，请先运行: chat2cli login`);
      process.exit(1);
    }
    try {
      const models = await provider.refreshModels({ force: true });
      process.stdout.write(chalk.green("✓ ") + `已刷新 ${provider.label} 模型列表，共 ${chalk.bold(models.length)} 个\n`);
      // 打印基础模型（不含后缀变体），便于确认
      const base = models.filter((m) => !/-(thinking|search|image|image-edit|video|deep-research)/.test(m.id));
      if (base.length > 0) {
        process.stdout.write(chalk.gray("\n基础模型:\n"));
        for (const m of base) {
          process.stdout.write(`  ${chalk.cyan(m.id)}  ${chalk.gray(m.label)}\n`);
        }
      }
      process.stdout.write("\n");
    } catch (err) {
      printError(`刷新模型列表失败: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // list
  const models = provider.getModels();
  process.stdout.write(chalk.bold(`\n${provider.label} 模型列表`) + chalk.gray(` （共 ${models.length} 个）\n\n`));
  for (const m of models) {
    process.stdout.write(`  ${chalk.cyan(m.id)}  ${chalk.gray(m.label)}\n`);
  }
  process.stdout.write(chalk.gray(`\n提示: 刷新列表运行 ${chalk.cyan(`chat2cli models refresh -p ${providerName}`)}\n\n`));
}
