export function createSseParser(onEvent) {
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  function emit() {
    if (!dataLines.length) {
      eventName = "message";
      return;
    }
    onEvent({
      event: eventName,
      data: dataLines.join("\n")
    });
    eventName = "message";
    dataLines = [];
  }

  return {
    push(chunk) {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line) {
          emit();
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    },
    flush() {
      if (buffer.trim()) {
        dataLines.push(buffer.trim());
        buffer = "";
      }
      emit();
    }
  };
}

const FRAGMENT_KIND_BY_TYPE = Object.freeze({
  THINK: "thinking",
  RESPONSE: "response"
});

/** 从 DeepSeek SSE payload 中收集所有含 text 的条目（fragment → 普通对象） */
function collectFragments(payload) {
  const items = [];

  // 1. 初始响应：v.response.fragments（取全部，不止最后一个）
  const initFrags = payload.v?.response?.fragments;
  if (Array.isArray(initFrags)) items.push(...initFrags);

  // 2. 增量追加：p="response/fragments" + o="APPEND"（取全部）
  if (payload.p === "response/fragments" && payload.o === "APPEND" && Array.isArray(payload.v)) {
    items.push(...payload.v);
  }

  // 3. 内容补丁：p="response/fragments/{N}/content"
  if (typeof payload.p === "string" && /^response\/fragments\/-?\d+\/content$/.test(payload.p) && typeof payload.v === "string") {
    items.push({ content: payload.v });
  }

  // 4. 简单文本：无 "p" 字段，v 是字符串
  if (!("p" in payload) && typeof payload.v === "string") {
    items.push({ content: payload.v });
  }

  // 5-6. 兜底格式
  if (items.length === 0 && typeof payload.text === "string") {
    items.push({ content: payload.text });
  }
  if (items.length === 0 && typeof payload.content === "string") {
    items.push({ content: payload.content });
  }

  return items;
}

/**
 * DeepSeek SSE delta 解码器。
 * 遍历一个 SSE message 事件中的所有 fragment，返回 delta 数组。
 * 单个事件可能包含多个 fragment（如 AI 先说话再出工具调用时），全部保留。
 */
export function createDeepseekDeltaDecoder() {
  let currentKind = "response";
  return {
    consume(payloadText) {
      const payload = JSON.parse(payloadText);
      const results = [];

      for (const item of collectFragments(payload)) {
        // 更新当前 kind（仅当 fragment 明确标注了类型）
        if (item.type && FRAGMENT_KIND_BY_TYPE[item.type]) {
          currentKind = FRAGMENT_KIND_BY_TYPE[item.type];
        }
        if (typeof item.content === "string" && item.content) {
          results.push({ kind: currentKind, text: item.content });
        }
      }

      return results;
    }
  };
}
