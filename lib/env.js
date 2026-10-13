/**
 * 高云工具链环境探针。
 *
 * 事实来源（实测，见 references/`GOWIN_AGENT_GUIDE.md`）：
 *   - 本机装了两个版本：
 *       C:\Gowin\Gowin_V1.9.11.03_Education_x64
 *       C:\Gowin\Gowin_V1.9.12.02_SP2_x64   ← 实测通过，默认优先
 *   - 不设 `GOWIN_HOME` 会报 `Please set environment variable GOWIN_HOME`，
 *     并且定位不到 device/lib 资源 —— 所以每次调用外部程序都必须显式注入。
 *   - `gao_analyzer.exe` 额外要求 **cwd == IDE\bin**，否则无论带不带参数都立刻退出码 1。
 *   - `gw_sh.exe` 会往 `%LocalAppData%\..\LocalLow\GowinSemi\IDE\cache\sh.log` 写日志，
 *     写不进去就在 stderr 喷 `alog error: failed to open log file` —— **无害噪声，必须过滤**，
 *     绝不能拿 stderr 判断构建失败。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 默认安装根（实测可用、优先选中）。 */
export const DEFAULT_GOWIN_ROOT = 'C:\\Gowin\\Gowin_V1.9.12.02_SP2_x64';

/** 已知被实测跑通的版本，排在自动发现结果前面。 */
const PREFERRED_ROOTS = [
  DEFAULT_GOWIN_ROOT,
  'C:\\Gowin\\Gowin_V1.9.11.03_Education_x64',
];

/** gw_sh stderr 里必须被当成噪声丢掉的行。 */
export const ALGO_NOISE = /alog error:\s*failed to open log file/i;

/** 工具链里每个可执行文件的角色 + 相对安装根的位置。 */
export const TOOLS = {
  gw_sh: {
    rel: 'IDE\\bin\\gw_sh.exe',
    role: 'Gowin TCL 命令控制台 —— **编译的唯一入口**。用法 `gw_sh.exe <script.tcl> [args…]`',
    mustCwd: null,
  },
  GowinSynthesis: { rel: 'IDE\\bin\\GowinSynthesis.exe', role: '综合引擎（由 `run syn` 内部调用），一般不用直接跑' },
  floorplanner: { rel: 'IDE\\bin\\floorplanner.exe', role: '布局布线引擎（由 `run pnr` 内部调用），一般不用直接跑' },
  programmer_cli: {
    rel: 'Programmer\\bin\\programmer_cli.exe',
    role: '烧录 / 扫描 JTAG 链。**退出码不可靠**，判据看控制台文本里的 `Finished.`',
  },
  jtagserver: { rel: 'Programmer\\bin\\jtagserver.exe', role: 'JTAG 服务端（gao_analyzer 会自动拉起，一般不用手动跑）' },
  gao_analyzer: {
    rel: 'IDE\\bin\\gao_analyzer.exe',
    role: 'GAO 在线逻辑分析仪采集界面。**cwd 必须是 IDE\\bin**，且 `-series` 与 `-device` 必须同时给',
    mustCwd: 'IDE\\bin',
  },
  gvio_analyzer: { rel: 'IDE\\bin\\gvio_analyzer.exe', role: 'GVIO 虚拟输入输出（未实测）' },
  gao_sh: { rel: 'IDE\\bin\\gao_sh.exe', role: '❌ **死路，别碰**：第一个位置参数必须是 .gao 文件；只要 argv[1] 是 `-gao` 就永久挂死' },
  gw_ide: { rel: 'IDE\\bin\\gw_ide.exe', role: '❌ **不能当 CLI**：加 `-h` 也会拉起 GUI 并挂住' },
};

/** 绝对不能当命令行用的程序（工具会主动拦下它们）。 */
export const FORBIDDEN = {
  gw_ide: '`gw_ide.exe` 是 GUI，加 `-h` 也会直接拉起图形界面并挂住，不能当 CLI。',
  gao_sh: '`gao_sh.exe` 已实测为死路（argv[1] 为 `-gao` 时永久挂死）；GAO 只走 `gao_analyzer.exe`。',
  programmer: '`programmer.exe` 是 GUI，请改用 `programmer_cli.exe`。',
};

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 判断一个目录是不是高云安装根（有 IDE\bin\gw_sh.exe）。 */
function looksLikeGowinRoot(dir) {
  return isFile(join(dir, 'IDE', 'bin', 'gw_sh.exe'));
}

function versionOf(root) {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/**
 * 发现本机所有高云安装。
 *
 * 顺序：`explicitRoot` > 已知优先根 > 字面量 `C:\Gowin\*` 目录扫描。
 * 每个候选都会实测 `IDE\bin\gw_sh.exe` 是否存在 —— **不靠目录名猜**。
 *
 * @param {string} [explicitRoot] 用户指定的安装根（优先级最高）
 * @returns {Array<{root:string,version:string,preferred:boolean}>}
 */
export function discoverRoots(explicitRoot) {
  const seen = new Set();
  const out = [];
  const push = (root, preferred) => {
    if (!root) return;
    const norm = root.replace(/[\\/]+$/, '');
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    if (!isDir(norm)) return;
    seen.add(key);
    out.push({ root: norm, version: versionOf(norm), preferred, hasGwSh: looksLikeGowinRoot(norm) });
  };

  push(explicitRoot, true);
  for (const r of PREFERRED_ROOTS) push(r, true);

  for (const base of ['C:\\Gowin', 'D:\\Gowin', join(process.env.USERPROFILE ?? '', 'Gowin')]) {
    if (!base || !isDir(base)) continue;
    let entries = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) push(join(base, name), false);
  }
  return out;
}

/**
 * 选一个可用的安装根：优先明确指定，其次已实测版本，再次任意能用 gw_sh 的。
 *
 * @param {{gowinRoot?: string}} [opts]
 * @returns {{root:string|null, candidates:Array, reason:string}}
 */
export function resolveGowinRoot(opts = {}) {
  const candidates = discoverRoots(opts.gowinRoot);
  const usable = candidates.filter((c) => c.hasGwSh);
  if (usable.length > 0) {
    return {
      root: usable[0].root,
      candidates,
      reason: opts.gowinRoot
        ? `按 gowinRoot 参数指定：${usable[0].root}`
        : `自动选中 ${usable[0].root}（${usable.length} 个可用安装）`,
    };
  }
  return {
    root: null,
    candidates,
    reason: candidates.length
      ? `找到 ${candidates.length} 个候选目录，但没有一个含 IDE\\bin\\gw_sh.exe —— 可能安装不完整`
      : '没找到任何高云安装目录（试过 C:\\Gowin\\*、D:\\Gowin\\*、%USERPROFILE%\\Gowin\\*）',
  };
}

/**
 * 构造一次外部命令调用的完整描述：绝对路径 + 注入 GOWIN_HOME 的 env + 正确的 cwd。
 *
 * @param {{root:string, tool:string, extraPath?:string[]}} opts
 * @returns {{ok:true, exe:string, cwd:string, env:Record<string,string>, note:string}
 *          |{ok:false, message:string}}
 */
export function commandSpec({ root, tool, extraPath = [] }) {
  const spec = TOOLS[tool];
  if (!spec) return { ok: false, message: `未知工具 ${tool}` };
  if (!root) {
    return {
      ok: false,
      message: '没有可用的高云安装根。先跑 gowin_env 看候选，再用 gowinRoot 参数指定安装根。',
    };
  }
  const base = FORBIDDEN[tool];
  if (base) return { ok: false, message: base };

  const exe = join(root, spec.rel);
  if (!isFile(exe)) return { ok: false, message: `找不到 ${exe}（${spec.role}）` };

  // gao_analyzer.exe 要求 cwd == IDE\bin；其余工具用安装根，保证相对路径稳定。
  const cwd = spec.mustCwd ? join(root, spec.mustCwd) : root;

  const env = {
    ...process.env,
    // 不设这个变量 gowin.dll 会直接拒绝工作
    GOWIN_HOME: root,
    PATH: [
      join(root, 'IDE', 'bin'),
      join(root, 'Programmer', 'bin'),
      ...extraPath,
      process.env.PATH ?? '',
    ].join(';'),
  };

  return { ok: true, exe, cwd, env, note: spec.role, mustCwd: spec.mustCwd ?? null };
}

/** License 文件探测（`IDE\bin\gwlicense.ini` 指向 .lic）。 */
export function licenseInfo(root) {
  if (!root) return { ok: false, message: '没有安装根' };
  const ini = join(root, 'IDE', 'bin', 'gwlicense.ini');
  const out = { ini, iniExists: isFile(ini), licPaths: [] };
  if (out.iniExists) {
    try {
      const text = readFileSync(ini, 'utf8');
      for (const m of text.matchAll(/[A-Za-z]:[\\/][^\r\n"']+\.lic/gi)) out.licPaths.push(m[0]);
    } catch {
      /* 读不动就算了，不是致命信息 */
    }
  }
  for (const p of [join(root, 'gowin_E_1413338ED23B.lic')]) {
    if (isFile(p) && !out.licPaths.includes(p)) out.licPaths.push(p);
  }
  const existing = out.licPaths.filter((p) => isFile(p));
  return {
    ok: existing.length > 0,
    ini: out.ini,
    iniExists: out.iniExists,
    licenses: existing,
    message: existing.length
      ? `License 有效：${existing.join(', ')}`
      : '没找到 .lic 文件（综合/布局布线可能报 license 错）',
  };
}

/** 报告一个安装根下所有工具的存在情况。 */
export function probeTools(root) {
  const rows = [];
  for (const [key, spec] of Object.entries(TOOLS)) {
    const exe = root ? join(root, spec.rel) : null;
    rows.push({
      tool: key,
      exe,
      exists: exe ? isFile(exe) : false,
      role: spec.role,
      mustCwd: spec.mustCwd ?? null,
    });
  }
  return rows;
}

export { looksLikeGowinRoot, isFile, isDir };
