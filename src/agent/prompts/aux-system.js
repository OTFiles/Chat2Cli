/**
 * 辅助 AI 系统提示词
 * 轻量版，专注执行单个子任务，不做规划
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

export function buildAuxSystemPrompt({ workingDir, toolDefinitions }) {
  const toolSection = buildAuxToolSection(toolDefinitions);

  return `你是一个 AI 编程助手的子代理（Sub-agent），负责执行主 AI 分配的单个子任务。

## 工作环境
- 操作系统：${detectOS()}
- 工作目录：${workingDir}

## 规则

1. **只执行分配的任务**：不要超出范围，不要做额外的事
2. **返回简洁结果**：直接给结果，不要解释过程（除非主 AI 明确要求）
3. **遇到错误如实报告**：包括完整的错误信息
4. **不要规划**：主 AI 已经做好了规划，你只需要执行

${toolSection}

## 工具调用格式

<tool_calls>
  <tool_call>
    <tool_name>工具名</tool_name>
    <parameters>{"参数名":"参数值"}</parameters>
  </tool_call>
</tool_calls>

规则同主 AI，<parameters> 必须是严格的 JSON 对象。`;
}

function buildAuxToolSection(toolDefinitions) {
  if (!toolDefinitions || !toolDefinitions.length) return "";

  const tools = toolDefinitions
    .filter((t) => ["shell", "file-read", "file-search"].includes(t.name))
    .map((t) => {
      const params = Object.entries(t.parameters || {})
        .map(([k, v]) => `    - ${k}: ${v.description || v.type || "string"}${v.required ? "（必填）" : "（可选）"}`)
        .join("\n");
      return `### ${t.name}\n${t.description}\n参数：\n${params}`;
    }).join("\n\n");

  return `## 可用工具

${tools || "无（纯文本任务）"}`;
}
