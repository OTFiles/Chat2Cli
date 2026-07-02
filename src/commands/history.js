import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { initProviders, getProvider } from "../providers/registry.js";
import { getStore, updateStore } from "../storage/store.js";
import { printSuccess, printError, printInfo, printTable, printWarn, truncate, formatDate, accountLabel } from "../utils/format.js";
import { chatLoop, echoMessages } from "../commands/chat.js";
import { printChatHeader } from "../utils/format.js";

async function selectDsAccount(provider) {
  const accounts = provider.listAccounts();
  if (!accounts.length) return null;
  if (accounts.length === 1) return accounts[0];

  const { accountIndex } = await inquirer.prompt([{
    type: "list", name: "accountIndex", message: `选择 ${provider.label} 账号:`,
    choices: accounts.map((a, i) => ({ name: accountLabel(a), value: i }))
  }]);
  return accounts[accountIndex];
}

export async function runHistory(subCommand, opts = {}, ...args) {
  initProviders();
  const limit = Number(opts.limit) || 0;  // 0 表示使用默认值

  switch (subCommand) {
    case "show": await showConversation(args[0]); break;
    case "delete": await deleteConversation(args[0]); break;
    case "continue": await continueConversation(args[0]); break;
    case "clear": await clearHistory(); break;
    case "search": await searchHistory(args.join(" ")); break;
    case "ds": await listDsSessions(limit); break;
    case "ds-continue": await continueDsSession(args[0], limit); break;
    case "ds-delete": await deleteDsSession(args[0], limit); break;
    case "batch-local": await batchDeleteLocal(); break;
    case "batch-ds": await batchDeleteDs(limit); break;
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

async function listDsSessions(limit = 0) {
  const provider = getProvider("deepseek");
  if (!provider?.isAuthenticated()) { printError("未登录 DeepSeek"); return; }

  const account = await selectDsAccount(provider);
  if (!account) { printError("没有 DeepSeek 账号"); return; }

  const spinner = ora("正在获取 DeepSeek 会话列表...").start();
  try {
    const { sessions } = await provider.fetchSessions(account.id, limit);
    spinner.stop();

    if (!sessions.length) { printInfo("该账号暂无云端会话。"); return; }
    printInfo(`${accountLabel(account)} 的云端会话 ${chalk.bold(sessions.length)} 条\n`);
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

async function continueDsSession(sessionId, limit = 0) {
  if (!sessionId) { printError("请指定会话 ID"); return; }

  const provider = getProvider("deepseek");
  if (!provider?.isAuthenticated()) { printError("未登录 DeepSeek"); return; }

  const account = await selectDsAccount(provider);
  if (!account) { printError("没有 DeepSeek 账号"); return; }

  // 先获取会话列表，用前缀匹配找到完整 UUID
  let listSpinner = ora("正在查找会话...").start();
  let fullSessionId;
  try {
    const { sessions } = await provider.fetchSessions(account.id, limit);
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
  let dsMessages, currentMessageId;
  try {
    const result = await provider.fetchMessages(account.id, fullSessionId);
    dsMessages = result.messages;
    currentMessageId = result.currentMessageId;
    spinner.succeed("已加载");
  } catch (err) {
    spinner.fail(err.message);
    return;
  }

  if (!dsMessages.length) { printWarn("该会话无消息记录"); return; }

  const messages = [...dsMessages];
  const currentModel = "deepseek-chat-fast";

  printChatHeader(provider.label, currentModel, fullSessionId.slice(0, 8));
  echoMessages(messages, true);

  await chatLoop(provider, messages, currentModel, account.id, fullSessionId, currentMessageId, true);

  // 保存到本地
  if (messages.length > dsMessages.length) {
    import("../utils/id.js").then(({ createId }) => {
      const convId = createId();
      updateStore((state) => ({
        ...state,
        conversations: [{
          id: convId, provider: provider.name, model: currentModel,
          title: messages.find((m) => m.role === "user")?.content?.slice(0, 50) || "未命名",
          messages: [...messages],
          accountId: account.id || "", dsSessionId: fullSessionId,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }, ...state.conversations]
      }));
      process.stdout.write(chalk.green("✓ ") + `对话已保存\n`);
    });
  }
}

async function deleteDsSession(sessionId, limit = 0) {
  if (!sessionId) { printError("请指定会话 ID"); return; }

  const provider = getProvider("deepseek");
  if (!provider?.isAuthenticated()) { printError("未登录 DeepSeek"); return; }

  const account = await selectDsAccount(provider);
  if (!account) return;

  // 先用前缀匹配找到完整 UUID
  let listSpinner = ora("正在查找会话...").start();
  let fullSessionId;
  try {
    const { sessions } = await provider.fetchSessions(account.id, limit);
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

// ─── 多选终端 UI ───

function fitOneLine(text, maxLen) {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const cw = text.charCodeAt(i) > 127 ? 2 : 1;
    if (w + cw > maxLen) return text.slice(0, i) + "...";
    w += cw;
  }
  return text;
}

function cjkWidth(text) {
  return [...text].reduce((s, c) => s + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
}

/**
 * 多选列表选择器。空格切换选择，上下导航，Enter 确认。
 * @param {{ label: string, id: string }[]} entries 条目列表
 * @returns {string[]} 选中的 ID 列表，null 表示取消
 */
function multiSelectPicker(entries, title = "选择") {
  if (!entries.length) return Promise.resolve([]);

  return new Promise((resolve) => {
    const PAGE = 20;
    let selected = new Set();
    let cursor = 0;
    let scroll = 0;
    let escState = 0;

    function clearScreen() {
      const lines = Math.min(PAGE, entries.length - scroll) + 2;
      process.stdout.write(`\x1b[${lines}A\x1b[J`);
    }

    function render() {
      const maxCols = (process.stdout.columns || 80) - 1;
      const end = Math.min(scroll + PAGE, entries.length);
      process.stdout.write(chalk.gray(`${title}  [空格]选择  [Enter]确认删除  [Ctrl+C]取消  (已选 ${selected.size})\n`));
      process.stdout.write(`  ${chalk.gray("─".repeat(56))}\n`);
      for (let i = scroll; i < end; i++) {
        const e = entries[i];
        const sel = selected.has(e.id);
        // 用白色 ✓ 在深色背景上更显眼
        const mark = sel ? (i === cursor ? chalk.white("✓") : chalk.green("✓")) : " ";
        const label = fitOneLine(e.label, maxCols - 12);
        const blank = " ".repeat(Math.max(1, maxCols - 12 - cjkWidth(label)));
        const line = i === cursor
          ? chalk.bgCyan.black(` ❯ [${mark}] ${label}${blank}`)
          : `   [${mark}] ${label}${blank}`;
        process.stdout.write(line + "\n");
      }
    }

    function scrollTo() {
      if (cursor < scroll) scroll = cursor;
      else if (cursor >= scroll + PAGE) scroll = cursor - PAGE + 1;
    }

    function toggle() {
      if (selected.has(entries[cursor].id)) selected.delete(entries[cursor].id);
      else selected.add(entries[cursor].id);
    }

    function onData(chunk) {
      const str = chunk.toString("utf-8");
      for (const char of str) {
        const code = char.codePointAt(0);
        if (escState > 0) {
          if (char === "[" && escState === 1) { escState = 2; continue; }
          if (escState === 2) {
            if (char === "A") { if (cursor > 0) cursor--; }
            else if (char === "B") { if (cursor < entries.length - 1) cursor++; }
            escState = 0; scrollTo(); clearScreen(); render(); continue;
          }
          escState = 0; continue;
        }
        if (code === 27) { escState = 1; continue; }
        if (code === 32) { toggle(); clearScreen(); render(); continue; }
        if (code === 13) {
          cleanup();
          if (!selected.size) { process.stdout.write("\n"); resolve([]); return; }
          resolve([...selected]);
          return;
        }
        if (code === 3) { cleanup(); process.stdout.write("\n"); resolve(null); return; }
      }
    }

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

// ─── 批量删除 ───

async function batchDeleteLocal() {
  const state = getStore();
  const convs = state.conversations;
  if (!convs.length) { printInfo("没有本地对话。"); return; }

  const entries = convs.map((c) => ({
    id: c.id,
    label: `[${c.provider}] ${(c.title || "未命名").slice(0, 40)}  ${formatDate(c.updatedAt || c.createdAt)}`
  }));

  const selected = await multiSelectPicker(entries, "批量删除本地对话");
  if (!selected) { process.stdout.write(chalk.gray("已取消。\n")); return; }
  if (!selected.length) { printInfo("未选择任何对话。"); return; }

  process.stdout.write(`\n`);
  const { confirm } = await inquirer.prompt([{
    type: "confirm", name: "confirm",
    message: `确定删除 ${chalk.red(selected.length)} 条本地对话吗？此操作不可撤销！`,
    default: false
  }]);
  if (!confirm) { printInfo("已取消。"); return; }

  updateStore((s) => ({
    ...s,
    conversations: s.conversations.filter((c) => !selected.includes(c.id))
  }));
  printSuccess(`已删除 ${selected.length} 条本地对话。`);
}

async function batchDeleteDs(limit = 0) {
  const provider = getProvider("deepseek");
  if (!provider?.isAuthenticated()) { printError("未登录 DeepSeek"); return; }

  const account = await selectDsAccount(provider);
  if (!account) return;

  const spinner = ora("正在获取云端会话...").start();
  let sessions = [];
  try {
    const result = await provider.fetchSessions(account.id, limit);
    sessions = result.sessions || [];
    spinner.succeed(`获取到 ${sessions.length} 条云端会话`);
  } catch (err) {
    spinner.fail(err.message);
    return;
  }

  const entries = sessions.map((s) => ({
    id: s.id,
    label: `${s.pinned ? "★ " : ""}${(s.title || "未命名").slice(0, 40)}  ${formatDate(typeof s.updatedAt === "number" ? new Date(s.updatedAt * 1000).toISOString() : s.updatedAt)}`
  }));

  const selected = await multiSelectPicker(entries, "批量删除云端会话");
  if (!selected) { process.stdout.write(chalk.gray("已取消。\n")); return; }
  if (!selected.length) { printInfo("未选择任何会话。"); return; }

  process.stdout.write(`\n`);
  const { confirm } = await inquirer.prompt([{
    type: "confirm", name: "confirm",
    message: `确定从云端删除 ${chalk.red(selected.length)} 条会话吗？此操作不可撤销！`,
    default: false
  }]);
  if (!confirm) { printInfo("已取消。"); return; }

  let ok = 0, fail = 0;
  for (const sid of selected) {
    try {
      await provider.deleteSession(account.id, sid);
      ok++;
    } catch {
      fail++;
    }
  }
  if (fail) {
    printWarn(`删除完成: ${ok} 成功, ${fail} 失败`);
  } else {
    printSuccess(`已删除 ${ok} 条云端会话。`);
  }
}
