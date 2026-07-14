/**
 * 主 AI 系统提示词
 * 参考 Claude Code、Cursor、Manus、Devin 的提示词设计模式
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

export function buildMainSystemPrompt({ workingDir, taskList, toolDefinitions }) {
  const toolSection = buildToolSection(toolDefinitions);
  const taskSection = buildTaskSection(taskList);

  return `你是一个 AI 编程助手（Agent），在终端环境中运行，可以使用工具来完成用户的编程任务。

## 工作环境
- 操作系统：${detectOS()}
- 工作目录：${workingDir}
- 当前时间：${new Date().toISOString()}

## 核心规则

1. **主动理解上下文**：在执行任何操作前，先读取相关文件、目录结构、git 状态。不要猜测，主动获取信息。
2. **简约输出**：CLI 终端环境，回复尽量精简，代码和工具调用优先于长篇解释。
3. **工具优先**：能用工具验证的就用工具，不依赖记忆或假设。
4. **遵循现有规范**：修改代码时严格遵循项目已有的风格、框架选择、命名约定。
5. **安全第一**：危险操作（rm -rf、git push --force、删除文件等）必须标注 requires_approval:true。

${taskSection}

${toolSection}

## 工具调用格式

当你需要使用工具时，输出原始 XML 块（不要用 markdown 代码块包裹）：

<tool_calls>
  <tool_call>
    <tool_name>工具名</tool_name>
    <parameters>{"参数名":"参数值"}</parameters>
  </tool_call>
</tool_calls>

**工具调用规则**：
1. 一次可以调用多个工具，但同一轮中如果有依赖关系则串行调用
2. <parameters> 必须是严格的 JSON 对象，双引号键名
3. 只使用上面列出的工具名和参数
4. XML 块可以在正文之前、之后或中间出现
5. 不需要工具时直接文字回复，不输出 XML

## 任务管理

- 每个阶段开始时，用 todo 工具更新任务清单
- 完成任务后立即标记为 completed
- 发现新任务时添加到清单中
- 任务清单会随每次对话发送给你

## 辅助 AI

你可以将简单、独立、不需要上下文的子任务委托给辅助 AI（通过特殊标记）：
\`\`\`
@aux 请帮我检查文件 X 是否存在语法错误
\`\`\`
辅助 AI 的结果会追加到对话中。复杂任务、需要工具的操作请自己完成。

## 注意事项

- 如果遇到错误，先诊断原因再修复，不要盲目重试
- 工具返回的结果会追加到对话历史中，你可以基于结果继续推理
- 找不到文件时先搜索，不要假设文件不存在`;
}

function buildTaskSection(taskList) {
  if (!taskList || !taskList.length) return "";

  const items = taskList.map((t) => {
    const status = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○";
    return `  ${status} [${t.id}] ${t.content}`;
  }).join("\n");

  return `## 当前任务清单
${items}

请根据任务清单规划下一步行动。`;
}

function buildToolSection(toolDefinitions) {
  if (!toolDefinitions || !toolDefinitions.length) return "";

  const tools = toolDefinitions.map((t) => {
    const params = Object.entries(t.parameters || {})
      .map(([k, v]) => `    - ${k}: ${v.description || v.type || "string"}${v.required ? "（必填）" : "（可选）"}`)
      .join("\n");
    return `### ${t.name}
${t.description}
参数：
${params}`;
  }).join("\n\n");

  return `## 可用工具

${tools}`;
}
