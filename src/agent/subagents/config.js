/**
 * 子 Agent 配置管理
 *
 * 独立配置文件: ~/.chat2cli/subagents.json
 * 支持多个命名 profile，delegate 工具通过 profile 参数选择
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".chat2cli");
const CONFIG_FILE = join(DATA_DIR, "subagents.json");

// ── 默认 profile ──

const DEFAULT_SHELL_WHITELIST = [
  "ls", "cat", "grep", "find", "wc", "head", "tail",
  "sort", "uniq", "echo", "pwd", "which", "stat", "file",
  "du", "df", "env", "date", "dirname", "basename",
  "node", "npm", "npx", "python", "python3", "git"
];

const BUILTIN_PROFILES = {
  default: {
    tools: ["shell", "file-read", "file-search"],
    allowedShellCommands: [...DEFAULT_SHELL_WHITELIST],
    blockUnlistedCommands: true,
    maxTurns: 5,
    timeoutMs: 120000,
    requireApprovalForWrite: true
  },
  explorer: {
    tools: ["shell", "file-read", "file-search"],
    allowedShellCommands: [
      "ls", "find", "grep", "rg", "cat", "head", "tail", "wc",
      "stat", "file", "du", "tree", "locate", "which", "echo",
      "fd", "awk", "sed", "cut", "xargs", "dirname", "basename"
    ],
    blockUnlistedCommands: true,
    maxTurns: 10,
    timeoutMs: 60000,
    requireApprovalForWrite: true
  },
  builder: {
    tools: ["shell", "file-read", "file-search", "file-write"],
    allowedShellCommands: [
      "npm", "npx", "yarn", "pnpm", "node", "python", "python3", "pip",
      "git", "make", "cargo", "go", "ls", "cat", "grep", "rg",
      "mkdir", "touch", "cp", "mv", "rm", "chmod", "echo",
      "which", "pwd", "find", "fd", "sed", "awk", "cut",
      "sort", "uniq", "wc", "head", "tail", "diff", "patch"
    ],
    blockUnlistedCommands: true,
    maxTurns: 15,
    timeoutMs: 300000,
    requireApprovalForWrite: false
  }
};

// ── 读写 ──

mkdirSync(DATA_DIR, { recursive: true });

function normalizeProfile(config) {
  const base = BUILTIN_PROFILES.default;
  return {
    tools: Array.isArray(config?.tools) ? config.tools : [...base.tools],
    allowedShellCommands: Array.isArray(config?.allowedShellCommands)
      ? config.allowedShellCommands : [...base.allowedShellCommands],
    blockUnlistedCommands: config?.blockUnlistedCommands ?? base.blockUnlistedCommands,
    maxTurns: typeof config?.maxTurns === "number" ? config.maxTurns : base.maxTurns,
    timeoutMs: typeof config?.timeoutMs === "number" ? config.timeoutMs : base.timeoutMs,
    requireApprovalForWrite: config?.requireApprovalForWrite ?? base.requireApprovalForWrite
  };
}

function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    const defaults = {
      profiles: {
        default: { ...BUILTIN_PROFILES.default },
        explorer: { ...BUILTIN_PROFILES.explorer },
        builder: { ...BUILTIN_PROFILES.builder }
      }
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { profiles: {} };
  }
}

function writeConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── 公开 API ──

/**
 * 获取指定 profile 配置（合并内置默认值）
 * @param {string} [name="default"]
 * @returns {object}
 */
export function getProfile(name = "default") {
  const config = readConfig();
  const raw = config.profiles?.[name] || null;
  if (!raw && BUILTIN_PROFILES[name]) {
    return { ...BUILTIN_PROFILES[name] };
  }
  return normalizeProfile(raw);
}

/**
 * 列出所有 profile 名称
 * @returns {string[]}
 */
export function listProfiles() {
  const config = readConfig();
  const names = new Set([
    ...Object.keys(BUILTIN_PROFILES),
    ...Object.keys(config.profiles || {})
  ]);
  return [...names].sort();
}

/**
 * 保存/更新一个 profile
 * @param {string} name
 * @param {object} profileConfig
 */
export function saveProfile(name, profileConfig) {
  if (!name || typeof name !== "string") throw new Error("profile 名称不能为空");
  const config = readConfig();
  if (!config.profiles) config.profiles = {};
  config.profiles[name] = normalizeProfile(profileConfig);
  writeConfig(config);
  return config.profiles[name];
}

/**
 * 删除一个 profile（内置的不允许删除）
 * @param {string} name
 * @returns {boolean}
 */
export function deleteProfile(name) {
  if (BUILTIN_PROFILES[name]) {
    throw new Error(`不能删除内置 profile: ${name}`);
  }
  const config = readConfig();
  if (!config.profiles?.[name]) return false;
  delete config.profiles[name];
  writeConfig(config);
  return true;
}

/**
 * 重置为默认配置
 */
export function resetConfig() {
  const defaults = {
    profiles: {
      default: { ...BUILTIN_PROFILES.default },
      explorer: { ...BUILTIN_PROFILES.explorer },
      builder: { ...BUILTIN_PROFILES.builder }
    }
  };
  writeConfig(defaults);
  return defaults;
}

/**
 * 获取 profile 的完整配置（包含所有合并后的字段）
 * @param {string} [name="default"]
 * @returns {object}
 */
export function resolveProfile(name = "default") {
  return getProfile(name);
}
