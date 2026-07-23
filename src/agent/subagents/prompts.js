/**
 * 子 Agent 系统提示词
 * 专注执行单个子任务，不做规划，只返回结果
 */

import { platform, release, type } from "node:os";

function detectOS() {
  const plat = platform();
  if (plat === "android" || !!process.env.TERMUX_VERSION) {
    return `Android (Termux, ${release()})`;
  }
  if (plat === "linux") return `Linux (${release()})`;
  if (plat === "darwin") return `macOS (${release()})`;
  if (plat === "win32") return `Windows (${release()})`;
  return `${type()} ${release()}`;
}

/**
 * 构建子 agent 系统提示词
 * @param {object} opts
 * @param {string} opts.workingDir - 工作目录
 * @param {string[]} [opts.allowedTools] - 允许使用的工具名列表（默认 ["shell", "file-read", "file-search"]）
 * @param {object} [opts.toolDefinitions] - 工具定义数组（用于注入提示词）
 */
export function buildSubAgentSystemPrompt({ workingDir, allowedTools, toolDefinitions }) {
  const tools = allowedTools || ["shell", "file-read", "file-search"];
  const toolSection = buildSubToolSection(toolDefinitions, tools);

  return `你是一个 AI 编程助手的子代理（Sub-agent），负责执行主 AI 分配的单个子任务。

## 工作环境
- 操作系统：${detectOS()}
- 工作目录：${workingDir}

## 核心规则

1. **只执行分配的任务**：不要超出范围，不要做额外的事
2. **返回简洁结果**：直接给结果，不要解释过程（除非主 AI 明确要求）
3. **遇到错误如实报告**：包括完整的错误信息
4. **不要规划**：主 AI 已经做好了规划，你只需要执行
5. **只读优先**：除非任务明确要求修改，否则不要修改任何文件
6. **完成后结束**：执行完任务后直接给出结果，不要问"还需要做什么"

${toolSection}

## 工具调用格式

使用简洁的属性式 XML（不要用 markdown 代码块包裹）：

\`\`\`
<invoke name="工具名" 参数="值" />
\`\`\`

示例：
- \`<invoke name="shell" command="ls -la" />\`
- \`<invoke name="file-read" path="/path/to/file.txt" />\`
- \`<invoke name="file-search" type="content" pattern="TODO" />\`

属性值含双引号时用单引号包裹。规则同主 AI。

## 输出格式

请用以下格式输出结果：

\`\`\`
[结果]
你的实际结果内容...
[/结果]
\`\`\`

如果任务无法完成，用：
\`\`\`
[错误]
错误描述...
[/错误]
\`\`\``;
}

function buildSubToolSection(toolDefinitions, allowedTools) {
  if (!toolDefinitions || !toolDefinitions.length) return "";
  const allowed = new Set(allowedTools || []);

  const tools = toolDefinitions
    .filter((t) => allowed.has(t.name))
    .map((t) => {
      const params = Object.entries(t.parameters || {})
        .map(([k, v]) => `    - ${k}: ${v.description || v.type || "string"}${v.required ? "（必填）" : "（可选）"}`)
        .join("\n");
      return `### ${t.name}\n${t.description}\n参数：\n${params}`;
    }).join("\n\n");

  return `## 可用工具

${tools || "无（纯文本任务）"}`;
}
