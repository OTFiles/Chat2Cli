import chalk from "chalk";
import { createApiServer } from "../server.js";
import { getStore } from "../storage/store.js";

export async function runServe(opts = {}) {
  const port = Number(opts.port || process.env.PORT || 3000);

  const server = createApiServer();

  server.listen(port, () => {
    const state = getStore();
    const apiKeys = state.apiKeys || [];

    const msg = [
      "",
      chalk.bold("chat2cli API 服务已启动"),
      "",
      `  地址:  ${chalk.cyan(`http://127.0.0.1:${port}`)}`,
      `  模型:  ${chalk.cyan(`GET  /v1/models`)}`,
      `  对话:  ${chalk.cyan(`POST /v1/chat/completions`)}`,
      "",
    ];

    if (apiKeys.length > 0) {
      msg.push(chalk.bold(`  API Keys (${apiKeys.length} 个):`));
      for (const k of apiKeys) {
        msg.push(chalk.gray(`    ${k.provider}  ${k.key.slice(0, 20)}...  (${k.label || "-"})`));
      }
    } else {
      msg.push(chalk.yellow("  ⚠ 尚未创建 API Key，请运行: chat2cli apikey create"));
    }

    msg.push(...[
      "",
      chalk.gray("使用示例:"),
      "",
      chalk.dim(`  curl http://127.0.0.1:${port}/v1/models`),
      "",
      chalk.dim(`  curl http://127.0.0.1:${port}/v1/chat/completions \\`),
      chalk.dim(`    -H "Authorization: Bearer <API_KEY>" \\`),
      chalk.dim(`    -H "Content-Type: application/json" \\`),
      chalk.dim(`    -d '{"model":"deepseek-chat-fast","messages":[{"role":"user","content":"你好"}]}'`),
      ""
    ]);

    for (const line of msg) {
      process.stdout.write(line + "\n");
    }
  });
}
