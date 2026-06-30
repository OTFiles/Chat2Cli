import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline";
import { initProviders, getProvider } from "../providers/registry.js";
import { getStore, updateStore } from "../storage/store.js";
import { printSuccess, printError, printInfo, printTable, printWarn, truncate, formatDate, printAiContent } from "../utils/format.js";

async function selectDsAccount(provider) {
  const accounts = provider.listAccounts();
  if (!accounts.length) return null;
  if (accounts.length === 1) return accounts[0];

  const { accountIndex } = await inquirer.prompt([{
    type: "list", name: "accountIndex", message: "选择 DeepSeek 账号:",
    choices: accounts.map((a, i) => ({ name: `${a.displayName} (${a.loginValue})`, value: i }))
  }]);
  return accounts[accountIndex];
}

export async function runHistory(subCommand, ...args) {
  initProviders();

  switch (subCommand) {
    case "show": await showConversation(args[0]); break;
    case "delete": await deleteConversation(args[0]); break;
    case "continue": await continueConversation(args[0]); break;
    case "clear": await clearHistory(); break;
    case "search": await searchHistory(args.join(" ")); break;
    case "ds": await listDsSessions(); break;
    case "ds-continue": await continueDsSession(args[0]); break;
    case "ds-delete": await deleteDsSession(args[0]); break;
    default: await listAll(); break;
  }
}

async function listAll() {
  // 先列出本地对话
  const state = getStore();
  const convs = state.conversations;

  if (convs.length) {
    printInfo(`本地对话 ${chalk.bold(convs.length)} 条\n`);
    printTable(
      ["ID", "类型", "标题", "更新时间"],
      convs.map((c) => [c.id.slice(0, 8), c.provider, truncate(c.title, 40), formatDate(c.updatedAt)])
    );
  }

  // 再提示 DS 会话
  const provider = getProvider("deepseek");
  if (provider?.isAuthenticated()) {
    process.stdout.write(chalk.gray("\n使用 chat2cli history ds 查看 DeepSeek 云端会话\n"));
  }
  if (!convs.length && !provider?.isAuthenticated()) {
    printInfo("暂无记录。运行 chat2cli chat 开始对话。");
  }
}

// --- 本地对话操作 ---

async function showConversation(convId) {
  const state = getStore();
  const conv = state.conversations.find((c) => c.id.startsWith(convId));
  if (!conv) { printError(`未找到对话: ${convId}`); return; }

  process.stdout.write(chalk.bold(`\n${conv.title}\n`));
  process.stdout.write(chalk.gray(`服务商: ${conv.provider}  模型: ${conv.model}  ID: ${conv.id}\n`));
  process.stdout.write("─".repeat(60) + "\n\n");

  for (const msg of conv.messages) {
    if (msg.role === "user") {
      process.stdout.write(chalk.cyan.bold("你:\n") + msg.content + "\n\n");
    } else {
      if (msg.thinking) {
        process.stdout.write(chalk.gray("[思考过程]\n" + msg.thinking + "\n\n"));
      }
      process.stdout.write(chalk.green.bold("AI:\n") + msg.content + "\n\n");
    }
  }
  process.stdout.write("─".repeat(60) + "\n");
}

async function deleteConversation(convId) {
  let deleted;
  updateStore((state) => {
    const idx = state.conversations.findIndex((c) => c.id.startsWith(convId));
    if (idx < 0) return state;
    deleted = state.conversations[idx];
    return { ...state, conversations: state.conversations.filter((_, i) => i !== idx) };
  });
  if (deleted) printSuccess(`已删除: ${chalk.bold(deleted.title)}`);
  else printError(`未找到对话: ${convId}`);
}

async function continueConversation(convId) {
  const state = getStore();
  const conv = state.conversations.find((c) => c.id.startsWith(convId));
  if (!conv) { printError(`未找到对话: ${convId}`); return; }
  const provider = getProvider(conv.provider);
  if (!provider || !provider.isAuthenticated()) { printError("服务商未登录"); return; }

  printSuccess(`继续对话: ${chalk.bold(conv.title)}\n`);
  const messages = [...conv.messages];
  let currentModel = conv.model;
  const sessionId = conv.dsSessionId || null;

  // 回显已有消息
  for (const msg of messages) {
    if (msg.role === "user") process.stdout.write(chalk.cyan("你: ") + msg.content + "\n");
    else {
      if (msg.thinking) process.stdout.write(chalk.gray(msg.thinking));
      process.stdout.write(chalk.green("AI: ") + msg.content + "\n\n");
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = () => new Promise((r) => rl.question(chalk.cyan("你: "), r));

  try {
    while (true) {
      const input = (await ask()).trim();
      if (input === "/exit") { process.stdout.write(chalk.gray("再见。\n")); rl.close(); break; }
      if (!input) continue;

      const spinner = ora("思考中...").start();
      messages.push({ role: "user", content: input });
      let thinking = "", response = "", firstChunk = true;

      try {
        for await (const delta of provider.chat(messages, { model: currentModel, sessionId })) {
          if (firstChunk) { spinner.stop(); process.stdout.write(chalk.green("AI: ")); firstChunk = false; }
          if (delta.kind === "thinking") { thinking += delta.text; printAiContent(delta.text, true); }
          else { response += delta.text; printAiContent(delta.text, false); }
        }
        spinner.stop();
        process.stdout.write("\n\n");
        const amsg = { role: "assistant", content: response };
        if (thinking) amsg.thinking = thinking;
        messages.push(amsg);
      } catch (err) {
        spinner.stop();
        process.stdout.write("\n");
        printError(err.message);
        messages.pop();
      }
    }
  } finally {
    rl.close();
    // 保存
    updateStore((state) => ({
      ...state,
      conversations: state.conversations.map((c) => c.id === conv.id
        ? { ...c, model: currentModel, messages, updatedAt: new Date().toISOString() }
        : c)
    }));
  }
}

async function clearHistory() {
  const { confirm } = await inquirer.prompt([{ type: "confirm", name: "confirm", message: "确定删除全部本地对话吗？", default: false }]);
  if (!confirm) { printInfo("已取消。"); return; }
  updateStore((state) => ({ ...state, conversations: [] }));
  printSuccess("所有本地对话已清空。");
}

async function searchHistory(keyword) {
  if (!keyword) { printError("请输入搜索关键词。"); return; }
  const state = getStore();
  const lower = keyword.toLowerCase();
  const results = state.conversations.filter((c) =>
    c.title.toLowerCase().includes(lower) || c.messages.some((m) => m.content.toLowerCase().includes(lower)));
  if (!results.length) { printInfo(`未找到匹配 "${chalk.bold(keyword)}" 的对话。`); return; }
  printInfo(`找到 ${chalk.bold(results.length)} 条对话\n`);
  printTable(["ID", "类型", "标题", "更新时间"], results.map((c) => [c.id.slice(0, 8), c.provider, truncate(c.title, 40), formatDate(c.updatedAt)]));
}

// --- DS 云端会话 ---

async function listDsSessions() {
  const provider = getProvider("deepseek");
  if (!provider?.isAuthenticated()) { printError("未登录 DeepSeek"); return; }

  const account = await selectDsAccount(provider);
  if (!account) { printError("没有 DeepSeek 账号"); return; }

  const spinner = ora("正在获取 DeepSeek 会话列表...").start();
  try {
    const { sessions } = await provider.fetchSessions(account.id);
    spinner.stop();

    if (!sessions.length) { printInfo("该账号暂无云端会话。"); return; }
    printInfo(`${account.displayName} 的云端会话 ${chalk.bold(sessions.length)} 条\n`);
    printTable(
      ["ID", "置顶", "标题", "更新时间"],
      sessions.map((s) => [s.id.slice(0, 16), s.pinned ? "★" : "", truncate(s.title, 30), s.updatedAt ? formatDate(typeof s.updatedAt === "number" ? new Date(s.updatedAt * 1000).toISOString() : s.updatedAt) : "-"])
    );

    process.stdout.write(chalk.gray("\nchat2cli history ds-continue <id>  继续云端会话\n"));
    process.stdout.write(chalk.gray("chat2cli history ds-delete <id>    删除云端会话\n"));
  } catch (err) {
    spinner.fail(err.message);
  }
}

async function continueDsSession(sessionId) {
  if (!sessionId) { printError("请指定会话 ID"); return; }

  const provider = getProvider("deepseek");
  if (!provider?.isAuthenticated()) { printError("未登录 DeepSeek"); return; }

  const account = await selectDsAccount(provider);
  if (!account) { printError("没有 DeepSeek 账号"); return; }

  // 先获取会话列表，用前缀匹配找到完整 UUID
  let listSpinner = ora("正在查找会话...").start();
  let fullSessionId;
  try {
    const { sessions } = await provider.fetchSessions(account.id);
    const match = sessions.find((s) => s.id.startsWith(sessionId));
    if (!match) {
      listSpinner.fail(`未找到匹配的会话: ${sessionId}`);
      return;
    }
    fullSessionId = match.id;
    listSpinner.succeed(`找到会话: ${chalk.bold(match.title || fullSessionId.slice(0, 12))}`);
  } catch (err) {
    listSpinner.fail(err.message);
    return;
  }

  const spinner = ora("正在获取会话消息...").start();
  let dsMessages;
  try {
    dsMessages = await provider.fetchMessages(account.id, fullSessionId);
    spinner.succeed("已加载");
  } catch (err) {
    spinner.fail(err.message);
    return;
  }

  if (!dsMessages.length) { printWarn("该会话无消息记录"); return; }

  printSuccess(`继续云端会话: ${chalk.bold(fullSessionId.slice(0, 12))}\n`);

  // 回显已有消息
  for (const msg of dsMessages) {
    if (msg.role === "user") process.stdout.write(chalk.cyan("你: ") + msg.content + "\n");
    else {
      if (msg.thinking) process.stdout.write(chalk.gray(msg.thinking));
      process.stdout.write(chalk.green("AI: ") + msg.content + "\n\n");
    }
  }

  const messages = [...dsMessages];
  const currentModel = "deepseek-chat-fast";

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = () => new Promise((r) => rl.question(chalk.cyan("你: "), r));

  try {
    while (true) {
      const input = (await ask()).trim();
      if (input === "/exit") { process.stdout.write(chalk.gray("再见。\n")); rl.close(); break; }
      if (!input) continue;

      const s = ora("思考中...").start();
      messages.push({ role: "user", content: input });
      let thinking = "", response = "", firstChunk = true;

      try {
        for await (const delta of provider.continueSession(account.id, fullSessionId, currentModel, messages)) {
          if (firstChunk) { s.stop(); process.stdout.write(chalk.green("AI: ")); firstChunk = false; }
          if (delta.kind === "thinking") { thinking += delta.text; printAiContent(delta.text, true); }
          else { response += delta.text; printAiContent(delta.text, false); }
        }
        s.stop();
        process.stdout.write("\n\n");
        messages.push({ role: "assistant", content: response, thinking: thinking || undefined });
      } catch (err) {
        s.stop();
        process.stdout.write("\n");
        printError(err.message);
        messages.pop();
      }
    }
  } finally {
    rl.close();
  }
}

async function deleteDsSession(sessionId) {
  if (!sessionId) { printError("请指定会话 ID"); return; }

  const provider = getProvider("deepseek");
  if (!provider?.isAuthenticated()) { printError("未登录 DeepSeek"); return; }

  const account = await selectDsAccount(provider);
  if (!account) return;

  // 先用前缀匹配找到完整 UUID
  let listSpinner = ora("正在查找会话...").start();
  let fullSessionId;
  try {
    const { sessions } = await provider.fetchSessions(account.id);
    const match = sessions.find((s) => s.id.startsWith(sessionId));
    if (!match) {
      listSpinner.fail(`未找到匹配的会话: ${sessionId}`);
      return;
    }
    fullSessionId = match.id;
    listSpinner.succeed(`找到会话: ${chalk.bold(match.title || fullSessionId.slice(0, 12))}`);
  } catch (err) {
    listSpinner.fail(err.message);
    return;
  }

  const { confirm } = await inquirer.prompt([{ type: "confirm", name: "confirm", message: `确定从云端删除会话 ${fullSessionId.slice(0, 12)}... 吗？`, default: false }]);
  if (!confirm) { printInfo("已取消。"); return; }

  const spinner = ora("正在删除...").start();
  try {
    await provider.deleteSession(account.id, fullSessionId);
    spinner.succeed("已删除");
  } catch (err) {
    spinner.fail(err.message);
  }
}
