/**
 * `gw_sh.exe` 编译驱动 —— 所有外部进程调用都收敛在这里。
 *
 * 硬事实（实测，见 references/GOWIN_AGENT_GUIDE.md）：
 *   - `gw_sh.exe <script.tcl> [args…]`，脚本内用 `$argc` / `$argv` 取参数。
 *   - **`run` 只接受 `syn` / `pnr` / `all` 三个进程名**。
 *   - `open_project <file.gprj>` 打开已有工程；`create_project` 从零新建。
 *   - `get_project_files` **不存在**；TCL 8.6 里**没有 `file name` 子命令**，用 `file tail`。
 *   - 成功判据：**退出码 0 + impl 下出现 `.fs`**；
 *     失败判据：输出里出现 `ERROR (` 或 `run` 抛异常。
 *   - stderr 的 `alog error: failed to open log file` 是**无害噪声**，必须过滤，
 *     绝不能拿 stderr 非空判断失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { commandSpec, ALGO_NOISE } from './env.js';

const BUILD_TASKS = ['syn', 'pnr', 'all'];

/** `run` 的合法进程名 → 说明。 */
export const TASKS = {
  syn: '只综合（快，产出 .vg 网表 + 综合报告）',
  pnr: '只布局布线 + 生成码流（要求已有综合网表）',
  all: '综合 → 布局布线 → 码流（最常用）',
};

/** 过滤 gw_sh 的无害 stderr 噪声，返回干净的输出行。 */
export function cleanOutput(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !ALGO_NOISE.test(l))
    .join('\n')
    .trim();
}

/**
 * 从工具输出里提取结论。
 *
 * @param {string} stdout
 * @param {string} stderr
 * @param {number|null} status
 * @param {{fsFiles?:string[]|null, timedOut?:boolean}} [opts]
 *   `fsFiles` 给 `[]` 表示"这一步本该产出码流但一个都没有" → 判失败（手册陷阱：退出码 0
 *   但综合/布线中途失败时不会有 .fs）。给 `null`/省略表示这一步本来就不产出码流（如 `syn`）。
 */
export function analyzeOutput(stdout, stderr, status, opts = {}) {
  const out = cleanOutput(stdout);
  const err = cleanOutput(stderr);
  const all = `${out}\n${err}`;

  const errors = [];
  for (const line of all.split('\n')) {
    if (/\bERROR\s*\(/.test(line) || /^##########\s*(BUILD FAILED|ERROR)/.test(line.trim()) || /^\s*ERR(OR)?:/i.test(line)) {
      errors.push(line.trim());
    }
  }
  const warns = [];
  for (const line of all.split('\n')) {
    if (/\bWARN\s*\(/.test(line)) warns.push(line.trim());
  }

  // run 抛的 TCL 异常也会以 "BUILD FAILED: <msg>" 形式出现
  const failMarker = /##########\s*BUILD FAILED:\s*(.*)$/m.exec(out);
  const okMarker = /##########\s*BUILD SUCCESS\s*\((\w+)\)/m.exec(out);

  const fsFiles = Array.isArray(opts.fsFiles) ? opts.fsFiles : null;
  const timedOut = opts.timedOut === true;
  const missingBitstream = fsFiles !== null && fsFiles.length === 0;

  // 判据顺序即优先级：超时 > 显式报错 > 退出码 > 该有码流却没有
  const verdict = timedOut || errors.length > 0 || failMarker || status !== 0 || missingBitstream ? 'failed' : 'ok';

  return {
    errors: [...new Set(errors)],
    warnings: [...new Set(warns)],
    failMessage: failMarker ? failMarker[1].trim() : null,
    successMarker: okMarker ? okMarker[1] : null,
    exitStatus: status,
    fsFiles,
    timedOut,
    verdict,
    ok: verdict === 'ok',
    // 注意：**不能**用 stderr 非空判失败 —— alog 噪声已被 cleanOutput 滤掉，
    // 但 gw_sh 也可能往 stderr 写别的非致命内容。
  };
}

/**
 * 跑一个自定义 TCL 脚本（把脚本内容写到磁盘再交给 gw_sh）。
 *
 * 脚本落在 `<workdir>\.dsh-gowin\` 下 —— 故意放在工作目录里而不是 %TEMP%，
 * 这样出问题后能直接翻到脚本内容复现。
 *
 * @param {{root:string, workdir:string, script:string, args?:string[], label?:string, timeoutMs?:number,
 *          analyze?:{fsFiles?:string[]|null, timedOut?:boolean}}} opts
 */
export function runTclScript({ root, workdir, script, args = [], label = 'script', timeoutMs = 30 * 60 * 1000, analyze = {} }) {
  const spec = commandSpec({ root, tool: 'gw_sh' });
  if (!spec.ok) return { ok: false, message: spec.message };

  const scriptDir = join(workdir, '.dsh-gowin');
  try {
    mkdirSync(scriptDir, { recursive: true });
  } catch (error) {
    return { ok: false, message: `建不了脚本目录 ${scriptDir}：${error instanceof Error ? error.message : String(error)}` };
  }
  const scriptPath = join(scriptDir, `${label}.tcl`);
  writeFileSync(scriptPath, script, 'utf8');

  const t0 = Date.now();
  const res = spawnSync(spec.exe, [scriptPath, ...args.map(String)], {
    cwd: workdir,
    env: spec.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - t0;

  if (res.error) {
    const killed = res.error.code === 'ETIMEDOUT';
    return {
      ok: false,
      timedOut: killed,
      elapsedMs,
      scriptPath,
      message: killed
        ? `gw_sh 超时 ${Math.round(timeoutMs / 1000)}s 被终止（脚本 ${scriptPath}）`
        : `跑 gw_sh 失败：${res.error.message}`,
      stdout: cleanOutput(res.stdout ?? ''),
      stderr: cleanOutput(res.stderr ?? ''),
    };
  }

  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  const analysis = analyzeOutput(stdout, stderr, res.status, analyze);
  return {
    ok: analysis.verdict === 'ok',
    elapsedMs,
    scriptPath,
    status: res.status,
    stdout: cleanOutput(stdout),
    stderr: cleanOutput(stderr),
    ...analysis,
  };
}

/**
 * 编译一个已有 `.gprj`。
 *
 * @param {{root:string, gprj:string, task:'syn'|'pnr'|'all', timeoutMs?:number}} opts
 */
export function runBuild({ root, gprj, task = 'all', timeoutMs }) {
  if (!BUILD_TASKS.includes(task)) {
    return { ok: false, message: `task 只能是 ${BUILD_TASKS.join(' / ')}，收到 ${task}` };
  }
  if (!existsSync(gprj)) return { ok: false, message: `找不到工程文件 ${gprj}` };

  const workdir = dirname(gprj);
  const script = `# 由 dsh-gowin 插件生成 —— Gowin CLI 编译入口
puts "=========== GOWIN CLI BUILD (dsh-gowin) ==========="
if {$argc < 1} {
    puts "USAGE: gw_sh.exe <script.tcl> <project.gprj> \\[syn|pnr|all\\]"
    exit 1
}
set gprj [lindex $argv 0]
set task [expr {$argc >= 2 ? [lindex $argv 1] : "all"}]
puts "project  = $gprj"
puts "task     = $task"
puts "CWD      = [pwd]"
puts "tool     = [info patchlevel]"

if {[catch {open_project $gprj} e]} {
    puts "########## BUILD FAILED: open_project -> $e"
    exit 1
}
puts "open_project OK"

# run 的合法进程名只有 syn | pnr | all
if {[catch {run $task} e]} {
    puts "########## BUILD FAILED: run $task -> $e"
    exit 1
}
puts "########## BUILD SUCCESS ($task)"
exit 0
`;
  const res = runTclScript({ root, workdir, script, args: [gprj, task], label: 'build', timeoutMs });
  const artifacts = collectArtifacts(gprj);
  if (!res.ok) return { ...res, artifacts };

  // 手册陷阱：`run all` 中途某步失败时可能 exit 0 且没有 ERROR 行 —— 码流在不在才是最终判据。
  // `syn` 本来就不产码流，只在 pnr / all 上判。
  if (task !== 'syn') {
    const fsFound = artifacts.bitstreams.filter((b) => /\.fs$/i.test(b.name));
    if (fsFound.length === 0) {
      return {
        ...res,
        ok: false,
        verdict: 'failed',
        artifacts,
        message: [
          `gw_sh 退出码 0、也没有 ERROR 行，但 impl 里没有 .fs 码流 —— ${task} 中途失败了。`,
          '去 impl/pnr/*.log 或 impl/gwsynthesis/*.log 看最后几行。',
        ].join('\n'),
      };
    }
    return { ...res, artifacts, bitstream: fsFound[0].path };
  }
  return { ...res, artifacts };
}

/**
 * 跑任意 TCL 命令串（用于 `gowin_tcl` 探针类工具）。
 *
 * @param {{root:string, workdir:string, commands:string[], label?:string, timeoutMs?:number}} opts
 */
export function runTclCommands({ root, workdir, commands, label = 'tcl', timeoutMs = 120000 }) {
  const body = commands.map((c) => String(c)).join('\n');
  const script = `# 由 dsh-gowin 插件生成 —— 临时 TCL 探针
puts "CWD = [pwd]"
puts "===BEGIN==="
${body}
puts "===END==="
exit 0
`;
  return runTclScript({ root, workdir, script, args: [], label, timeoutMs });
}

// ------------------------------------------------------------ 产物定位

/** 递归列出一个目录下匹配的文件（相对路径）。 */
function listMatching(dir, re, maxDepth = 4) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'wave' || e.name === 'ao_0') walk(p, depth + 1);
        else if (/^(pnr|gwsynthesis|gao)$/i.test(e.name)) walk(p, depth + 1);
      } else if (re.test(e.name)) {
        try {
          out.push({ path: p, name: e.name, size: statSync(p).size, mtimeMs: statSync(p).mtimeMs });
        } catch {
          /* 竞态，忽略 */
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * 找出一次构建的产物并判断成功与否。
 *
 * ⚠️ **关键坑**：工程一旦挂了 `.gao`，`run pnr` 阶段会自动插入 GAO 核，
 * `impl\pnr\` 里**不再生成 `<顶层>.fs`，只有 `ao_0.fs`**（约 3.5 MB）。
 * 这是官方定义（SUG114 §3.1），也是 GAO 插入成功的标志。
 *
 * @param {string} gprj
 */
export function collectArtifacts(gprj) {
  const root = dirname(gprj);
  const impl = join(root, 'impl');
  const result = {
    implExists: existsSync(impl),
    bitstreams: [],
    reports: [],
    synthesis: [],
    gao: [],
    topName: null,
    hasGaoBitstream: false,
    note: null,
  };
  if (!result.implExists) return result;

  result.bitstreams = listMatching(impl, /\.(fs|bin|binx)$/i);
  result.reports = listMatching(impl, /\.(rpt\.txt|rpt\.html|pin\.html|power\.html|timing_paths)$/i);
  result.synthesis = listMatching(impl, /(_syn\.rpt\.html|_syn_resource\.html|\.vg$|\.prj$|\.log$)$/i);
  result.gao = listMatching(impl, /^(ao_\d+\.fs|gw_gao_top\.v|gao\.v|gw_ao_parameter\.v)$/i);

  result.hasGaoBitstream = result.bitstreams.some((b) => /^ao_\d+\.fs$/i.test(b.name));
  const plain = result.bitstreams.find((b) => /\.fs$/i.test(b.name) && !/^ao_\d+/i.test(b.name));
  if (plain) result.topName = plain.name.replace(/\.fs$/i, '');
  const ao = result.gao.find((g) => /^ao_\d+\.fs$/i.test(g.name));
  if (ao && !plain) result.topName = 'ao_0';
  if (result.hasGaoBitstream && !plain) {
    result.note =
      '工程挂了 `.gao`，GAO 核已在 pnr 阶段自动插入 —— 码流文件名变成 `ao_0.fs`，' +
      '`impl\\pnr\\` 里**不会**再有 `<顶层>.fs`。烧录要烧 `ao_0.fs`。';
  }
  return result;
}

/** 读一个小文本文件（报告/日志），失败返回 null。 */
export function readTextSafe(path, maxBytes = 8 * 1024 * 1024) {
  try {
    const st = statSync(path);
    if (st.size > maxBytes) return readFileSync(path, 'utf8').slice(0, maxBytes);
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 找布局布线报告 `*.rpt.txt`（最常读的文件）。 */
export function findPnrReport(gprj) {
  const impl = join(dirname(gprj), 'impl');
  const hits = listMatching(impl, /\.rpt\.txt$/i);
  const pnr = hits.find((h) => /[\\/]pnr[\\/]/i.test(h.path)) ?? hits[0];
  return pnr ? pnr.path : null;
}

/** 找综合报告。 */
export function findSynReport(gprj) {
  const impl = join(dirname(gprj), 'impl');
  const hits = listMatching(impl, /_syn\.rpt\.html$/i);
  return hits.length ? hits[0].path : null;
}

export { tmpdir, resolve };
