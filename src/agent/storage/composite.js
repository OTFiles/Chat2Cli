import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createId } from "../../utils/id.js";

const AGENT_DIR = join(homedir(), ".chat2cli", "agent");
mkdirSync(AGENT_DIR, { recursive: true });

function filePath(id) {
  // 安全：确保 id 不含路径穿越字符
  const safe = basename(String(id));
  return join(AGENT_DIR, `${safe}.json`);
}

/** 创建新的复合对话 */
export function createComposite({ name, description = "", workingDir = process.cwd() }) {
  const now = new Date().toISOString();
  const composite = {
    id: createId(),
    name: name || `agent_${now.slice(0, 10)}`,
    description,
    workingDir,
    main: { provider: null, accountId: null, sessionId: null },
    aux: { provider: null, accountId: null, sessionId: null },
    messages: [],
    taskList: [],
    mainModel: null,
    auxModel: null,
    createdAt: now,
    updatedAt: now
  };
  writeFileSync(filePath(composite.id), JSON.stringify(composite, null, 2));
  return composite;
}

/** 列出所有复合对话（按更新时间倒序） */
export function listComposites() {
  if (!existsSync(AGENT_DIR)) return [];
  return readdirSync(AGENT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const raw = readFileSync(join(AGENT_DIR, f), "utf8");
        return JSON.parse(raw);
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/** 获取单个复合对话 */
export function getComposite(id) {
  if (!id) return null;
  const p = filePath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

/** 保存/更新复合对话 */
export function saveComposite(composite) {
  if (!composite?.id) return null;
  composite.updatedAt = new Date().toISOString();
  writeFileSync(filePath(composite.id), JSON.stringify(composite, null, 2));
  return composite;
}

/** 添加消息到复合对话 */
export function appendMessage(composite, message) {
  if (!composite || !message) return composite;
  const msg = {
    id: createId(),
    role: message.role || "assistant",
    content: message.content || "",
    source: message.source || "main",    // "main" | "aux" | "user" | "tool"
    toolName: message.toolName || null,
    toolResult: message.toolResult || null,
    timestamp: new Date().toISOString()
  };
  composite.messages = [...(composite.messages || []), msg];
  return saveComposite(composite);
}

/** 设置主 AI 的远程会话信息 */
export function setMainSession(composite, provider, accountId, sessionId) {
  composite.main = { provider, accountId, sessionId };
  return saveComposite(composite);
}

/** 设置辅助 AI 的远程会话信息 */
export function setAuxSession(composite, provider, accountId, sessionId) {
  composite.aux = { provider, accountId, sessionId };
  return saveComposite(composite);
}

/** 更新任务清单 */
export function updateTaskList(composite, taskList) {
  composite.taskList = taskList || [];
  return saveComposite(composite);
}

/** 设置使用的模型 */
export function setModels(composite, mainModel, auxModel) {
  if (mainModel !== undefined) composite.mainModel = mainModel;
  if (auxModel !== undefined) composite.auxModel = auxModel;
  return saveComposite(composite);
}

/** 删除复合对话 */
export function deleteComposite(id) {
  const p = filePath(id);
  if (existsSync(p)) unlinkSync(p);
  return true;
}
