/**
 * `ctx.tools` 工具注册 —— agent 直接调用的那一层。
 *
 * 设计约定（沿用 dsh-enet-review 的形状）：
 *  - 每个工具返回纯数据 `{ok, message, …}`；`output.render` 把它拼成给模型看的文本。
 *  - **只读**工具（env/device/board/project/cst/report/artifacts/docs/help/gao）绝不改文件。
 *  - **写**工具只有两个：`gowin_build`（产出 impl\ 与 .dsh-gowin\ 下的临时 tcl）与
 *    `gowin_init`（生成工程骨架，默认不覆盖已有文件）、`gowin_cst`（默认只打印，`write:true` 才落盘）。
 *  - 每个涉及外部进程的工具都必须把**判据**和**判据为什么不是退出码**说清楚。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { defineTool } from './define-tool.js';
import { DEFAULT_GOWIN_ROOT, FORBIDDEN, commandSpec, licenseInfo, probeTools, resolveGowinRoot } from './env.js';
import { DEVICE, PERIPHERALS, POWER, CLOCK, EXPANSION, DEFAULT_IO_PORT, boardSummary, cstSnippet, pinRole } from './board.js';
import { groupFiles, parseCst, parseGprj, parseSdc, portAttrsText, renderCreateClock, renderGprj } from './gprj.js';
import { analyzeOutput, cleanOutput, collectArtifacts, findPnrReport, findSynReport, readTextSafe, runBuild, runTclCommands, TASKS } from './build.js';
import { checkProject, checkCst } from './check.js';
import { parseCmdDo, parseDeviceCfg, parsePnrReport, parseTimingPaths } from './report.js';

// ---------------------------------------------------------------- 通用小工具

const textRender = (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }];
const output = { schema: { type: 'json' }, render: textRender };

function clip(list, limit, def = 60, max = 400) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), max) : def;
  return { shown: list.slice(0, n), total: list.length, n, truncated: list.length > n };
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} m ${Math.round((ms % 60000) / 1000)} s`;
}

/** 把 `file` 解析成绝对路径：绝对路径直用，相对路径按 cwd。 */
function absPath(file, cwd) {
  if (!file) return null;
  return isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file);
}

/** 在目录（及上一层）里找 `*.gprj`。 */
function findGprjIn(dir) {
  try {
    return readdirSync(dir).filter((f) => /\.gprj$/i.test(f)).sort();
  } catch {
    return [];
  }
}

/**
 * 定位 `.gprj`：显式 file > cwd 顶层 > cwd 下一层 > 逐级上溯（最多 6 层）。
 * 命中多个时返回候选，让调用方重指定（照抄 enet 的 `enet_net` 做法）。
 *
 * 上溯是必要的：agent 常在 `impl\pnr`、`src` 这种深目录里干活。
 */
function locateGprj(file, cwd = process.cwd()) {
  if (file) {
    const p = absPath(file, cwd);
    if (existsSync(p)) return { ok: true, path: p };
    return { ok: false, message: `找不到工程文件 ${p}` };
  }
  const direct = findGprjIn(cwd);
  if (direct.length === 1) return { ok: true, path: join(cwd, direct[0]) };
  if (direct.length > 1) return { ok: false, message: `当前目录有多个 .gprj：${direct.join(', ')}。请用 file 指定。`, candidates: direct.map((f) => join(cwd, f)) };

  // 只在起点看一层子目录：上溯时再进别人的子目录容易误命中
  const nested = [];
  try {
    for (const e of readdirSync(cwd, { withFileTypes: true })) {
      if (!e.isDirectory() || /^(impl|\.dsh-gowin|node_modules|\.git)$/i.test(e.name)) continue;
      for (const f of findGprjIn(join(cwd, e.name))) nested.push(join(cwd, e.name, f));
    }
  } catch {
    /* 读不动就当没有 */
  }
  if (nested.length === 1) return { ok: true, path: nested[0] };
  if (nested.length > 1) return { ok: false, message: `在工作区下一层找到多个 .gprj（共 ${nested.length} 个），请用 file 指定：`, candidates: nested.slice(0, 20) };

  let dir = cwd;
  for (let up = 0; up < 6; up += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const hits = findGprjIn(dir);
    if (hits.length === 1) return { ok: true, path: join(dir, hits[0]) };
    if (hits.length > 1) return { ok: false, message: `上级目录 ${dir} 有多个 .gprj：${hits.join(', ')}。请用 file 指定。`, candidates: hits.map((f) => join(dir, f)) };
  }
  return {
    ok: false,
    message: `在 ${cwd}、其下一层、以及各级上级目录都没找到 .gprj 工程文件。请用 file 指定绝对路径，或用 gowin_init 建一个新工程。`,
  };
}

/** 读一个工程的 `.gprj` + 第一份 `.cst` + 第一份 `.sdc`。 */
function loadProject(gprjPath) {
  const parsed = parseGprj(gprjPath);
  if (!parsed.ok) return parsed;
  const g = groupFiles(parsed);
  const enabled = (f) => f.enable && f.exists;
  const cstFile = g.cst.find(enabled) ?? null;
  const sdcFile = g.sdc.find(enabled) ?? null;
  const cst = cstFile ? parseCst(readTextSafe(cstFile.abs) ?? '') : null;
  const sdc = sdcFile ? parseSdc(readTextSafe(sdcFile.abs) ?? '') : null;
  return { ok: true, parsed, groups: g, cst, cstFile, sdc, sdcFile };
}

// ---------------------------------------------------------------- 高云环境

const toolEnv = {
  name: 'gowin_env',
  description:
    '探测本机高云 Gowin 工具链：安装根（**自动发现，多版本容忍**）、三个入口程序是否存在、License 状态。' +
    '任何高云任务的第一步 —— 没设 GOWIN_HOME 时工具会直接报 "Please set environment variable GOWIN_HOME"。' +
    '本机装了两个版本（V1.9.12.02_SP2 实测优先、V1.9.11.03 Education），返回体里会全列出来。',
  parameters: {
    gowinRoot: { type: 'string', description: '手动指定安装根（优先级最高），如 C:\\Gowin\\Gowin_V1.9.12.02_SP2_x64' },
    all: { type: 'boolean', description: 'true = 列出所有候选安装根，而不只报选中的那个' },
  },
  output,
  async execute(args) {
    const picked = resolveGowinRoot({ gowinRoot: args.gowinRoot });
    const parts = [];
    if (!picked.root) {
      parts.push(`❌ ${picked.reason}`);
      parts.push('装好高云 IDE 后重试，或用 gowinRoot 参数指明安装根。');
      if (picked.candidates.length) parts.push(`\n候选目录：\n${picked.candidates.map((c) => `  ${c.root}`).join('\n')}`);
      return { ok: false, message: parts.join('\n') };
    }
    parts.push(`✅ 高云安装根：${picked.root}`);
    parts.push(`   选取依据：${picked.reason}`);
    parts.push(`   default（插件内置）= ${DEFAULT_GOWIN_ROOT}${picked.root === DEFAULT_GOWIN_ROOT ? '（命中）' : ''}`);

    const tools = probeTools(picked.root);
    parts.push('\n== 工具链 ==');
    for (const t of tools) {
      const mark = t.exists ? '✅' : '—';
      const guard = FORBIDDEN[t.tool] ? ' 🚫' : '';
      parts.push(`  ${mark} ${t.tool.padEnd(14)}${guard} ${t.mustCwd ? `[cwd 必须是 ${t.mustCwd}] ` : ''}${t.role}`);
    }

    const lic = licenseInfo(picked.root);
    parts.push(`\n== License ==\n  ${lic.ok ? '✅' : '⚠️'} ${lic.message}`);
    if (lic.iniExists) parts.push(`   gwlicense.ini = ${lic.ini}`);

    if (args.all || picked.candidates.length > 1) {
      parts.push(`\n== 所有候选安装根（${picked.candidates.length}）==`);
      for (const c of picked.candidates) {
        parts.push(`  ${c.hasGwSh ? '✅' : '⚠️ '} ${c.root}${c.preferred ? '  [已实测]' : ''}`);
      }
    }
    parts.push('\n🚫 禁用清单：');
    for (const [k, v] of Object.entries(FORBIDDEN)) parts.push(`  ${k}: ${v}`);
    parts.push('\n下一步：gowin_device（器件配置码）/ gowin_board（引脚表）/ gowin_project（看现有工程）。');
    return { ok: true, message: parts.join('\n'), root: picked.root, candidates: picked.candidates };
  },
};

const toolDevice = {
  name: 'gowin_device',
  description:
    '查本板目标器件与配置码：GW1N-9C / GW1N-UV9LQ144C6/I5 / device_version C / 配置码 gw1n9c-019。' +
    '写 `.gprj` 的 `<Device>` 元素时用 —— **器件名在属性里、配置码是元素文本**，写反了综合会用错器件。' +
    '另外给出 create_project / set_device 的权威 TCL 用法。',
  parameters: {
    name: { type: 'string', description: '可选：只查某个器件名（GW1N-9C / GW1N-9）' },
  },
  output,
  async execute(args) {
    const rows = [
      { name: DEVICE.name, configCode: DEVICE.configCode, note: '本板例程实测（01_LED_Run / 07_LED_Flow）' },
      { name: DEVICE.alt.name, configCode: DEVICE.alt.configCode, note: '同族另一组合，桌面 02~06 例程在用，编译同样通过' },
    ];
    const parts = [`本板 U7 = ${DEVICE.pn}（${DEVICE.package}）`];
    parts.push(`Part Number（.gprj 的 pn 属性）= ${DEVICE.pn}`);
    parts.push(`Device Version = ${DEVICE.deviceVersion}`);
    parts.push(`Bank 电压 = ${DEVICE.bankVccio} V（四个 Bank 由 0Ω R31~R34 接 D3V3）\n`);
    parts.push('== 器件名 ↔ 配置码 ==');
    for (const r of rows) {
      if (args.name && r.name.toLowerCase() !== String(args.name).toLowerCase()) continue;
      parts.push(`  ${r.name.padEnd(10)} → ${r.configCode.padEnd(14)} ${r.note}`);
    }
    parts.push('\n== `.gprj` 里的写法 ==');
    parts.push(`  <Device name="${DEVICE.name}" pn="${DEVICE.pn}">${DEVICE.configCode}</Device>`);
    parts.push('  ⚠️ name 是属性、配置码是元素文本。两者都必需且不能互换。');
    parts.push('\n== 等价的 TCL（gw_sh 里跑）==');
    parts.push(`  set_device -name ${DEVICE.name} -part ${DEVICE.pn} -version ${DEVICE.deviceVersion}`);
    parts.push(`  # 新建工程时：create_project -name <名> -dir <目录> -pn ${DEVICE.pn} -device_version ${DEVICE.deviceVersion} -force`);
    parts.push('  ⚠️ `create_project -dir D` 会**多建一层** `D\\<name>\\`，路径要按这个预期写。');
    parts.push(`\n== 布局布线产物里的器件串 ==\n  cmd.do 的 -p 是 \`${DEVICE.name}-LQFP144-6\`（器件名-封装-速度等级）`);
    return { ok: true, message: parts.join('\n'), device: DEVICE, rows };
  },
};

const toolBoard = {
  name: 'gowin_board',
  description:
    '本板（FG202 / GW1N-UV9LQ144）**引脚与极性速查表**，全部来自原理图并已与例程 .cst 逐脚交叉验证、上板跑通。' +
    '查「某个外设接哪个 IO」「LED/按键是高有效还是低有效」「哪个脚是专用脚不能当 GPIO」时用它。' +
    '带 pin 参数可反查某个引脚号在板上是什么。',
  parameters: {
    pin: { type: 'string', description: '按引脚反查，脚号或丝印都行：27 / "IO27" / "IOR9[A]"' },
    peripheral: { type: 'string', enum: ['led', 'key', 'uart', 'eeprom', 'spiFlash', 'jtag', 'config'], description: '只看某一类外设' },
  },
  output,
  async execute(args) {
    const parts = [];

    // pin 宽进：`98` / `'98'` / `'IO98'` / `'io 98'` / `'IOR9[A]'` 都收 ——
    // 用户嘴边说的是丝印 `IO98`，而板级表里的键是数字 98。
    const pinRaw = args.pin;
    let pinNum = null;
    let pinSite = null;
    if (typeof pinRaw === 'number' && Number.isFinite(pinRaw)) {
      pinNum = pinRaw;
    } else if (typeof pinRaw === 'string' && pinRaw.trim()) {
      const s = pinRaw.trim();
      const m = /^(?:io)?\s*(\d{1,3})$/i.exec(s);
      if (m) pinNum = Number(m[1]);
      else pinSite = s; // 形如 IOR9[A] 的 site 名，交给下面的 site 反查
    }

    if (pinNum !== null) {
      const roles = pinRole(pinNum);
      parts.push(`引脚 IO${pinNum}（pin${pinNum}）在板上：`);
      if (!roles.length) parts.push('  （未登记 —— 可能是排针带出的普通 IO，或该脚本板未用）');
      for (const r of roles) {
        const bits = [`role=${r.role}`];
        if (r.sch) bits.push(r.sch);
        if (r.signal) bits.push(`signal=${r.signal}`);
        if (r.name) bits.push(`name=${r.name}`);
        if (r.dir) bits.push(`dir=${r.dir}`);
        if (r.activeLow) bits.push('低电平有效');
        if (r.bidirectional) bits.push('双向');
        if (r.dedicatedConfigPin) bits.push('专用配置脚');
        if (r.dedicated) bits.push('专用脚（不可当 GPIO）');
        parts.push(`  ${bits.join('  ')}`);
      }
      parts.push('');
    } else if (pinSite !== null) {
      // 按 site / 网络名反查：板级表里 pinRole 的键是脚号，这里对每条记录做一次包含匹配
      const needle = pinSite.toLowerCase();
      const hits = [];
      for (const [key, per] of Object.entries(PERIPHERALS)) {
        for (const it of per.items) {
          const hay = [it.sch, it.name, it.signal, it.role, it.note].filter(Boolean).join(' ').toLowerCase();
          if (hay.includes(needle)) hits.push(`[${key}] IO${it.pin} — ${Object.entries(it).filter(([k]) => k !== 'pin').map(([k, v]) => `${k}=${v}`).join(' ')}`);
        }
      }
      for (const [key, p] of Object.entries(PERIPHERALS)) {
        const hay = [p.label, p.hardware, p.warning].filter(Boolean).join(' ').toLowerCase();
        if (hay.includes(needle)) hits.push(`[${key}] ${p.label} — ${p.hardware ?? ''}`);
      }
      parts.push(`按 "${pinSite}" 反查命中 ${hits.length} 条：`);
      if (!hits.length) parts.push(`  （没命中。pin 也可以直接给脚号，如 pin:98）`);
      for (const h of hits) parts.push(`  ${h}`);
      parts.push('');
    }

    parts.push('== 时钟 ==');
    parts.push(`  ${CLOCK.name} = pin${CLOCK.pin}（${CLOCK.freqMHz} MHz 有源晶振，周期 ${CLOCK.periodNs} ns）—— ${CLOCK.note}`);
    parts.push('  板上没有第二个晶振；要别的频率就在 FPGA 里分频（例：06_FLASH 的 clock25M）。');

    const per = boardSummary().filter((r) => !args.peripheral || r.key.toLowerCase() === String(args.peripheral).toLowerCase());
    parts.push('\n== 外设 ==');
    for (const r of per) {
      parts.push(`\n[${r.key}] ${r.label}`);
      parts.push(`  引脚: ${r.pins}`);
      if (r.polarity) parts.push(`  有效电平: ${r.polarity === 'low' ? '低（0 有效）' : '高（1 有效）'}`);
      if (r.warning) parts.push(`  ⚠️ ${r.warning}`);
    }

    parts.push('\n== 逐脚明细 ==');
    for (const [k, p] of Object.entries(PERIPHERALS)) {
      if (args.peripheral && k.toLowerCase() !== String(args.peripheral).toLowerCase()) continue;
      parts.push(`\n[${k}] ${p.label}`);
      for (const it of p.items) {
        const desc = Object.entries(it).filter(([kk]) => kk !== 'pin').map(([kk, vv]) => `${kk}=${vv}`).join(' ');
        parts.push(`  ${String(it.pin ?? '-').padStart(4)}  ${desc}`);
      }
      if (p.hardware) parts.push(`  接法: ${p.hardware}`);
      if (p.warning) parts.push(`  ⚠️ ${p.warning}`);
    }

    parts.push('\n== 电源 ==');
    parts.push(`  ${POWER.rails}`);
    parts.push(`  ${POWER.banks}`);
    parts.push(`  ${POWER.note}`);

    parts.push('\n== 扩展 ==');
    parts.push(`  ${EXPANSION.note}`);

    parts.push('\n== 默认 IO 电气属性 ==');
    parts.push(`  ${DEFAULT_IO_PORT}`);
    parts.push('  ⚠️ 原厂 03_Key_FallEage / 04_UART / 06_FLASH 的 .cst 里写的是 BANK_VCCIO=1.8，与本板不符，别照抄。');
    return { ok: true, message: parts.join('\n') };
  },
};

// ---------------------------------------------------------------- 工程

const toolProject = {
  name: 'gowin_project',
  description:
    '看一个高云工程的全貌：器件/配置码、文件表（源文件/约束/GAO，含「登记了但磁盘上没有」的）、' +
    '约束文件里的引脚分配、时序约束里的时钟。file 省略时自动在当前工作区找 .gprj。' +
    '这是「先看清现状再动手」的那一步。',
  parameters: {
    file: { type: 'string', description: '.gprj 路径（省略则自动查找）' },
  },
  output,
  async execute(args, exec) {
    const found = locateGprj(args.file, exec?.cwd);
    if (!found.ok) return found;
    const proj = loadProject(found.path);
    if (!proj.ok) return proj;
    const { parsed, groups } = proj;

    const parts = [`工程: ${found.path}`];
    parts.push(`器件: name=${parsed.device.name ?? '?'}  pn=${parsed.device.pn ?? '?'}  配置码=${parsed.device.configCode ?? '?'}`);
    const known = parsed.device.name === DEVICE.name || parsed.device.name === DEVICE.alt.name;
    if (!known) parts.push(`  ⚠️ 本板实测过的是 ${DEVICE.name} / ${DEVICE.alt.name}，当前是 ${parsed.device.name}。`);
    parts.push(`Version=${parsed.version ?? '?'}  Template=${parsed.template ?? '?'}`);

    parts.push(`\n== 文件表（${parsed.files.length} 条）==`);
    for (const f of parsed.files) {
      const mark = !f.exists ? '❌' : f.enable ? '✅' : '⏸';
      parts.push(`  ${mark} ${String(f.type ?? '?').padEnd(14)} ${f.path}${f.exists ? '' : '   ← 磁盘上不存在'}`);
    }
    const missing = parsed.files.filter((f) => !f.exists);
    if (missing.length) parts.push(`  ❌ ${missing.length} 个文件登记了但不存在 —— 综合前必须修掉。`);

    parts.push(`\n== 分组 ==`);
    parts.push(`  verilog/vhdl: ${groups.verilog.length + groups.vhdl.length}   cst: ${groups.cst.length}   sdc: ${groups.sdc.length}   gao/rao: ${groups.gao.length + groups.rao.length}`);

    if (proj.cstFile) {
      parts.push(`\n== 物理约束 ${proj.cstFile.path} ==`);
      parts.push(`  IO_LOC ${proj.cst.locs.length} 条   IO_PORT ${proj.cst.ports.length} 条   其它语句 ${proj.cst.other.length} 条`);
      const byPin = new Map();
      for (const l of proj.cst.locs) byPin.set(Number(l.pin), [...(byPin.get(Number(l.pin)) ?? []), l]);
      const sorted = [...proj.cst.locs].sort((a, b) => Number(a.pin) - Number(b.pin));
      for (const l of sorted) {
        const p = proj.cst.ports.find((x) => x.name === l.name);
        const roles = pinRole(l.pin);
        const tag = roles.length ? `  [板上=${roles.map((r) => r.sch ?? r.signal ?? r.role).join('/')}]` : '';
        const dup = (byPin.get(Number(l.pin)) ?? []).length > 1 ? '  ⚠️ 与其他信号共用该引脚' : '';
        parts.push(`  pin ${String(l.pin).padStart(4)}  ${l.name.padEnd(14)} ${p ? portAttrsText(p.attrs) : '(无 IO_PORT)'}${l.flags ? ` ${l.flags}` : ''}${tag}${dup}`);
      }
      const unlocated = proj.cst.ports.filter((p) => !proj.cst.locs.some((l) => l.name === p.name));
      if (unlocated.length) parts.push(`  ⚠️ ${unlocated.length} 个信号有 IO_PORT 但没有 IO_LOC：${unlocated.map((p) => p.name).join(', ')}`);
    } else {
      parts.push('\n== 物理约束 ==\n  ❌ 工程里没有启用的 .cst —— 布局布线会自己分配引脚，上板几乎必然不工作。');
      parts.push('  可用 gowin_cst 生成一份（本板板级正确的那版）。');
    }

    if (proj.sdcFile) {
      parts.push(`\n== 时序约束 ${proj.sdcFile.path} ==`);
      if (proj.sdc.clocks.length) {
        for (const c of proj.sdc.clocks) parts.push(`  create_clock name=${c.name} period=${c.period} ns → ${c.target}`);
      } else {
        parts.push('  没有任何 create_clock —— 会看到 WARN (TA1132)。');
      }
    } else {
      parts.push(`\n== 时序约束 ==\n  没有 .sdc（会有 WARN (TA1132)：时钟没被创建）。补一行即可：`);
      parts.push(`  ${renderCreateClock({ name: CLOCK.name, periodNs: CLOCK.periodNs }).trim()}`);
    }

    if (groups.gao.length + groups.rao.length > 0) {
      parts.push(`\n== GAO ==\n  挂了 ${groups.gao.length + groups.rao.length} 个在线逻辑分析仪文件。`);
      parts.push('  ⚠️ 一旦挂 GAO，`run pnr` 会自动插入 GAO 核，**`impl\\pnr\\` 里不再生成 <顶层>.fs，只有 `ao_0.fs`**（约 3.5 MB）。烧录要烧 ao_0.fs。');
    }

    const arts = collectArtifacts(found.path);
    parts.push(`\n== 已有产物 ==`);
    if (!arts.implExists) {
      parts.push('  （没有 impl\\ 目录 —— 还没编译过）');
    } else {
      for (const b of arts.bitstreams) parts.push(`  ${fmtSize(b.size).padStart(10)}  ${b.path}`);
      if (!arts.bitstreams.length) parts.push('  （没有找到 .fs 码流）');
      if (arts.note) parts.push(`  ℹ️ ${arts.note}`);
    }
    return { ok: true, message: parts.join('\n'), project: found.path };
  },
};

const toolInit = {
  name: 'gowin_init',
  description:
    '在磁盘上生成一份**能直接编译**的高云工程骨架：.gprj（本板正确器件/配置码）+ .cst（板级正确的引脚）+ ' +
    '.sdc（create_clock，消掉 TA1132）+ 可选的 LED 流水灯顶层（已上板验证的那版）。' +
    '**默认不覆盖已有文件**（force:true 才覆盖）。生成后用 gowin_build 编译。',
  parameters: {
    dir: { type: 'string', description: '工程目录（绝对路径，或相对 cwd）。省略 = 当前工作区' },
    name: { type: 'string', description: '顶层模块名兼工程名，默认 LED_Run' },
    deviceName: { type: 'string', enum: ['GW1N-9C', 'GW1N-9'], description: '器件名，默认 GW1N-9C（本板实测）' },
    what: {
      type: 'array',
      items: { type: 'string', enum: ['gprj', 'cst', 'sdc', 'top'] },
      description: '要生成哪些，默认全部 [gprj, cst, sdc, top]',
    },
    demo: { type: 'string', enum: ['led_flow', 'led_blink', 'none'], description: '顶层源码内容，默认 led_flow（四灯流水，已上板验证）' },
    force: { type: 'boolean', description: 'true = 已存在的文件也覆盖（默认 false，只报冲突）' },
  },
  output,
  async execute(args, exec) {
    const cwd = exec?.cwd ?? process.cwd();
    const dir = args.dir ? absPath(args.dir, cwd) : cwd;
    const name = String(args.name ?? 'LED_Run').trim() || 'LED_Run';
    const deviceName = args.deviceName === 'GW1N-9' ? DEVICE.alt.name : DEVICE.name;
    const configCode = deviceName === DEVICE.name ? DEVICE.configCode : DEVICE.alt.configCode;
    const what = Array.isArray(args.what) && args.what.length ? args.what : ['gprj', 'cst', 'sdc', 'top'];
    const demo = args.demo ?? 'led_flow';
    const srcDir = join(dir, 'src');

    const made = [];
    const skipped = [];
    try {
      mkdirSync(srcDir, { recursive: true });
    } catch (error) {
      return { ok: false, message: `建不了目录 ${srcDir}：${error instanceof Error ? error.message : String(error)}` };
    }

    const put = (path, text) => {
      if (existsSync(path) && !args.force) {
        skipped.push(path);
        return;
      }
      writeFileSync(path, text, 'utf8');
      made.push(path);
    };

    const rel = (p) => p.slice(dir.length + 1).replace(/\\/g, '/');

    // ---- 顶层源码
    let topFile = null;
    if (what.includes('top') && demo !== 'none') {
      topFile = join(srcDir, `${name}.v`);
      put(topFile, demo === 'led_blink' ? LED_BLINK_SRC(name) : LED_FLOW_SRC(name));
    }

    // ---- .cst
    let cstFile = null;
    if (what.includes('cst')) {
      cstFile = join(srcDir, `${name}.cst`);
      const head = `// ${name}.cst —— 由 dsh-gowin 生成（板级事实来自 FG202 原理图，已与例程 .cst 交叉验证）\n` +
        `// 目标板: FG202 / ${DEVICE.pn}\n` +
        `// 器件: ${deviceName}   Bank 电压: 3.3 V\n` +
        `// ⚠️ LED 与按键都是低电平有效；按键无硬件消抖，必须在 Verilog 里消抖。\n\n`;
      put(cstFile, head + cstSnippet(['clk', 'led', 'key', 'uart']) + '\n');
    }

    // ---- .sdc
    let sdcFile = null;
    if (what.includes('sdc')) {
      sdcFile = join(srcDir, `${name}.sdc`);
      put(
        sdcFile,
        `# ${name}.sdc —— 由 dsh-gowin 生成\n` +
          `# 本板唯一晶振：Y1 50 MHz 有源晶振 → pin${CLOCK.pin}（IOR9[A]/GCLKT_2）。\n` +
          `# 没有这一行会看到 WARN (TA1132) : 'CLK_50M' was determined to be a clock but was not created.\n` +
          renderCreateClock({ name: CLOCK.name, periodNs: CLOCK.periodNs }),
      );
    }

    // ---- .gprj
    let gprjFile = null;
    if (what.includes('gprj')) {
      gprjFile = join(dir, `${name}.gprj`);
      const files = [];
      if (topFile) files.push({ path: rel(topFile), type: 'file.verilog', enable: true });
      if (cstFile) files.push({ path: rel(cstFile), type: 'file.cst', enable: true });
      if (sdcFile) files.push({ path: rel(sdcFile), type: 'file.sdc', enable: true });
      put(gprjFile, renderGprj({ deviceName, pn: DEVICE.pn, configCode, files }));
    }

    const parts = [`✅ 工程骨架已生成于 ${dir}`];
    parts.push(`   器件 ${deviceName} / 配置码 ${configCode} / ${DEVICE.pn}`);
    if (made.length) {
      parts.push('\n== 新建 ==');
      for (const p of made) parts.push(`  ${p}`);
    }
    if (skipped.length) {
      parts.push('\n== 已存在，**未覆盖**（要覆盖请加 force:true）==');
      for (const p of skipped) parts.push(`  ${p}`);
    }
    if (gprjFile) parts.push(`\n下一步：\n  gowin_project { file: "${gprjFile}" }   看全貌\n  gowin_check   { file: "${gprjFile}" }   机械校验\n  gowin_build   { file: "${gprjFile}", task: "all" }   编译`);
    if (demo === 'led_flow' && topFile) {
      parts.push('\nℹ️ 顶层是**四灯流水灯**（已上板验证那版）：四颗灯每次恰好亮一颗 —— 全灭=配置失败，某颗常亮=时钟死，流水=正常。');
    }
    return { ok: true, message: parts.join('\n'), dir, made, skipped, gprj: gprjFile };
  },
};

const toolCst = {
  name: 'gowin_cst',
  description:
    '生成/校验物理约束（.cst）。两种用法：' +
    '① 不带 cstPath：按本板板级事实生成正确的 IO_LOC/IO_PORT（可选 clock/led/key/uart/eeprom/spiFlash 分组）；' +
    '② 带 cstPath：读入并机械校验那份 .cst（引脚冲突、1.8V Bank、专用脚加 exclusive、引脚与信号名不匹配）。' +
    '默认**只打印不落盘**，要写文件得显式给 write:true（带 cstPath 时 write 表示把校验结果旁注写回不采用，永远不修改原文件）。',
  parameters: {
    cstPath: { type: 'string', description: '要校验的 .cst 路径（给了它就走校验模式）' },
    which: {
      type: 'array',
      items: { type: 'string', enum: ['clk', 'led', 'key', 'uart', 'eeprom', 'spiFlash'] },
      description: '生成模式下要包含哪些外设，默认 [clk, led, key, uart]',
    },
    write: { type: 'boolean', description: '生成模式下 true = 写到磁盘（需要 out 指定路径）' },
    out: { type: 'string', description: '生成模式的输出路径（默认 <cwd>\\src\\<名>.cst）' },
  },
  output,
  async execute(args, exec) {
    const cwd = exec?.cwd ?? process.cwd();

    // ---- 校验模式
    if (args.cstPath) {
      const p = absPath(args.cstPath, cwd);
      if (!existsSync(p)) return { ok: false, message: `找不到 ${p}` };
      const text = readTextSafe(p);
      if (text === null) return { ok: false, message: `读不了 ${p}` };
      const cst = parseCst(text);
      const findings = checkCst(cst, p, null);
      const parts = [`校验 ${p}`, `  IO_LOC ${cst.locs.length} 条 | IO_PORT ${cst.ports.length} 条 | 其它 ${cst.other.length} 条`, ''];
      if (!findings.length) {
        parts.push('✅ 机械校验没有发现问题（注意：这只覆盖引脚冲突/电平/极性/命名这几类）。');
      } else {
        const order = { E: 0, W: 1, I: 2 };
        findings.sort((a, b) => order[a.sev] - order[b.sev]);
        for (const f of findings) {
          parts.push(`[${f.sev}] ${f.code}`);
          parts.push(`     ${f.message}`);
          if (f.evidence) parts.push(`     ${String(f.evidence).split('\n').join('\n     ')}`);
        }
      }
      return { ok: true, message: parts.join('\n'), findings };
    }

    // ---- 生成模式
    const which = Array.isArray(args.which) && args.which.length ? args.which : ['clk', 'led', 'key', 'uart'];
    let body = cstSnippet(which.slice());
    if (which.includes('eeprom')) {
      body +=
        '\n// EEPROM AT24C02（U5）—— SDA 是双向，Verilog 里必须 inout + 三态\n' +
        'IO_LOC "SCL" 86 exclusive;\nIO_PORT "SCL" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;\n' +
        'IO_LOC "SDA" 85 exclusive;\nIO_PORT "SDA" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 OPEN_DRAIN=ON BANK_VCCIO=3.3;\n';
    }
    if (which.includes('spiFlash')) {
      body +=
        '\n// SPI Flash W25Q32（U6）—— IO93~96 同时是**高云专用配置脚**：不要加 exclusive，也别叠加冲突属性\n' +
        'IO_LOC "flash_clk" 93;\nIO_PORT "flash_clk" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;\n' +
        'IO_LOC "flash_cs" 94;\nIO_PORT "flash_cs" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;\n' +
        'IO_LOC "flash_datain" 95;\nIO_PORT "flash_datain" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;\n' +
        'IO_LOC "flash_dataout" 96;\nIO_PORT "flash_dataout" IO_TYPE=LVCMOS33 PULL_MODE=UP BANK_VCCIO=3.3;\n';
    }

    const parts = [`按本板板级事实生成 .cst（${which.join(', ')}）:`, '', body];
    if (args.write) {
      const out = args.out ? absPath(args.out, cwd) : join(cwd, 'src', 'board.cst');
      try {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, body, 'utf8');
        parts.push('', `✅ 已写入 ${out}`);
        parts.push('⚠️ 记得把它加进 .gprj 的 FileList（type="file.cst"），否则不会生效。');
      } catch (error) {
        parts.push('', `❌ 写入失败：${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, message: parts.join('\n') };
      }
    } else {
      parts.push('', '（只打印未落盘；要写文件加 write:true 与 out:"<路径>"）');
    }
    return { ok: true, message: parts.join('\n'), body };
  },
};

const toolCheck = {
  name: 'gowin_check',
  description:
    '**编译之前**的机械校验：器件/配置码是否匹配、文件表里有没有登记却不存在的文件、' +
    '有没有同时占用同一引脚的两个信号、Bank 电压是不是误抄成 1.8 V、专用 JTAG/配置脚有没有被当 GPIO、' +
    '约束里的信号名在源码里存不存在、缺不缺 .sdc。每条都带行号与原始语句作证据。' +
    '这是「先机械检查、再布局布线」的第一步 —— 能省掉整轮编译时间。',
  parameters: {
    file: { type: 'string', description: '.gprj 路径（省略则自动查找）' },
    severity: { type: 'string', enum: ['E', 'W', 'I'], description: '只输出该级别及以上（E=错误 / W=警告 / I=提示）' },
  },
  output,
  async execute(args, exec) {
    const found = locateGprj(args.file, exec?.cwd);
    if (!found.ok) return found;
    const proj = loadProject(found.path);
    if (!proj.ok) return proj;

    const { findings, summary } = checkProject(proj.parsed, {
      cst: proj.cst,
      cstPath: proj.cstFile?.abs ?? null,
      sdc: proj.sdc,
      sdcPath: proj.sdcFile?.abs ?? null,
    });

    const order = { E: 0, W: 1, I: 2 };
    const min = args.severity ? order[args.severity] : 0;
    const shown = findings.filter((f) => order[f.sev] >= min);

    const parts = [`校验 ${found.path}`];
    parts.push(`结论: ${summary.E} 个错误 / ${summary.W} 个警告 / ${summary.I} 个提示`);
    const verdict =
      summary.E > 0
        ? '❌ 有 ERROR 级问题 —— 先修掉再编译，否则必然浪费一整轮综合+布局布线时间。'
        : summary.W > 0
          ? '⚠️ 没有致命问题，但警告项里可能有「能编译、上板不对」的坑，建议逐条看过。'
          : '✅ 机械校验通过。';
    parts.push(verdict);

    if (!shown.length) {
      parts.push('\n（没有达到该级别的问题）');
    } else {
      const byCode = new Map();
      for (const f of shown) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
      parts.push(`\n== 按规则汇总 ==`);
      for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) parts.push(`  ${code.padEnd(28)} ×${n}`);
      parts.push(`\n== 明细 ==`);
      for (const f of shown) {
        parts.push(`\n[${f.sev}] ${f.code}`);
        parts.push(`    ${f.message}`);
        if (f.evidence) parts.push(`    证据: ${String(f.evidence).split('\n').join('\n          ')}`);
      }
    }
    parts.push('\nℹ️ 机械校验只覆盖能给出证据的规则；引脚是否与手册一致、时序是否收敛，仍要看布局布线报告（gowin_report）。');
    return { ok: true, message: parts.join('\n'), summary, findings: shown };
  },
};

// ---------------------------------------------------------------- 编译 / 烧录

const toolBuild = {
  name: 'gowin_build',
  description:
    '调 `gw_sh.exe <script.tcl>` 编译高云工程。task: syn=只综合 / pnr=只布局布线 / all=综合+布局布线+码流（默认）。' +
    '**成功判据是「退出码 0 且 impl 下出现 .fs」，不是 stdout 里没有 ERROR**；' +
    'stderr 里的 `alog error: failed to open log file` 是**无害噪声**（本机 AppData 目录写不进去），已被过滤，绝不能拿它判失败。' +
    '跑完会自动汇总错误/警告行与产物清单。工程挂了 .gao 时码流会变成 ao_0.fs，工具会提示。',
  parameters: {
    file: { type: 'string', description: '.gprj 路径（省略则自动查找）' },
    task: { type: 'string', enum: ['syn', 'pnr', 'all'], description: '要跑哪一步，默认 all' },
    gowinRoot: { type: 'string', description: '手动指定高云安装根（默认自动发现）' },
    timeoutSec: { type: 'number', description: '超时秒数，默认 1800（30 分钟）' },
  },
  output,
  async execute(args, exec) {
    const found = locateGprj(args.file, exec?.cwd);
    if (!found.ok) return found;
    const picked = resolveGowinRoot({ gowinRoot: args.gowinRoot });
    if (!picked.root) return { ok: false, message: `没有可用高云安装根：${picked.reason}` };

    const task = args.task ?? 'all';
    const timeoutMs = (Number.isFinite(args.timeoutSec) ? Math.max(30, Math.floor(args.timeoutSec)) : 1800) * 1000;
    const parts = [`工程: ${found.path}`, `安装根: ${picked.root}`, `任务: ${task} —— ${TASKS[task] ?? ''}`, ''];

    const before = collectArtifacts(found.path);
    const beforeFs = new Set(before.bitstreams.map((b) => b.path));

    const res = runBuild({ root: picked.root, gprj: found.path, task, timeoutMs });
    if (res.message && res.scriptPath === undefined) {
      parts.push(`❌ ${res.message}`);
      return { ok: false, message: parts.join('\n') };
    }

    // ---- 输出摘要：只留有信息的行
    const interesting = [];
    for (const line of (res.stdout ?? '').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^(##########|=====|USAGE|project\s*=|task\s*=|CWD|tool\s*=|open_project OK)/.test(t)) continue;
      if (/\b(ERROR|WARN)\s*\(/.test(t) || /^(Error|ERROR|Fatal)/i.test(t) || /failed/i.test(t)) interesting.push(t);
    }
    const errLines = (res.errors ?? []).length ? res.errors : interesting.filter((l) => /\bERROR\s*\(/i.test(l) || /^(Error|Fatal)/i.test(l));
    const warnLines = (res.warnings ?? []).length ? res.warnings : interesting.filter((l) => /\bWARN\s*\(/i.test(l));

    if (res.timedOut) parts.push(`⏱️ ${res.message}`);
    parts.push(`退出码: ${res.status ?? '(超时/被杀)'}    耗时: ${fmtMs(res.elapsedMs)}`);
    parts.push(`TCL 脚本: ${res.scriptPath}`);

    // ---- 产物
    const after = collectArtifacts(found.path);
    const newFs = after.bitstreams.filter((b) => !beforeFs.has(b.path));
    const fsList = after.bitstreams.filter((b) => /\.fs$/i.test(b.name));

    parts.push(`\n== 产物 ==`);
    if (!fsList.length) {
      parts.push('  ❌ impl 下没有任何 .fs 码流 —— 即使退出码是 0 也**不算成功**。');
    } else {
      for (const b of fsList) {
        parts.push(`  ${newFs.some((n) => n.path === b.path) ? '🆕' : '  '} ${fmtSize(b.size).padStart(10)}  ${b.path}`);
      }
    }
    for (const r of after.reports.slice(0, 8)) parts.push(`     ${fmtSize(r.size).padStart(10)}  ${r.path}`);
    if (after.note) parts.push(`\n  ℹ️ ${after.note}`);

    if (errLines.length) {
      parts.push(`\n== ERROR（${errLines.length}）==`);
      for (const l of errLines.slice(0, 40)) parts.push(`  ${l}`);
      if (errLines.length > 40) parts.push(`  … 其余 ${errLines.length - 40} 行略（完整输出见 ${res.scriptPath} 同目录）`);
    }
    if (warnLines.length) {
      parts.push(`\n== WARN（${warnLines.length}）==`);
      for (const l of warnLines.slice(0, 25)) parts.push(`  ${l}`);
      if (warnLines.length > 25) parts.push(`  … 其余 ${warnLines.length - 25} 行略`);
      parts.push('  非致命：TA1132=缺 .sdc 时钟定义；EX3012=顺序块空语句；EX3791=32 位截断为 8 位；PA1015=GAO 采样信号被替换为 _d（正常）。');
    }

    const ok = res.status === 0 && fsList.length > 0 && !res.timedOut;
    parts.push('');
    if (ok) {
      parts.push(`✅ 编译成功（退出码 0 且生成 .fs）。下一步：gowin_report 看资源/时序，gowin_program 烧录。`);
    } else if (res.timedOut) {
      parts.push(`⏱️ 超时被终止。加大 timeoutSec，或先只跑 task:"syn" 缩小范围。`);
    } else {
      parts.push(`❌ 编译未通过。常见的非致命警告（可忽略）：TA1132（缺 .sdc 时钟定义）、EX3012、EX3791、PA1015（GAO 采样信号被替换）。`);
    }
    return { ok, message: parts.join('\n'), scriptPath: res.scriptPath, errors: errLines, warnings: warnLines, bitstreams: after.bitstreams };
  },
};

// ------------------------------- 烧录

/** `programmer_cli --operation_index` 实测表。 */
const OP_INDEX = [
  { i: 0, name: '读器件码', note: '' },
  { i: 1, name: 'Reprogram', note: '' },
  { i: 2, name: 'SRAM Program', note: '**掉电即丢，但最常用**（本器件用它在 index 4 上会假失败）' },
  { i: 4, name: 'SRAM Program + Verify', note: '❌ 本器件**恒报** `Error: Verify failed of at 0` —— 是已知假失败，不要用它判问题' },
  { i: 5, name: 'embFlash Erase,Program', note: '片内 Flash，掉电保持' },
  { i: 6, name: 'embFlash Erase,Program,Verify', note: '✅ 最可靠，掉电保持，约 19 s，控制台出 `Verify Success`' },
  { i: 8, name: '(未用到)', note: '' },
  { i: 9, name: 'exFlash Erase,Program(,Verify)', note: '⚠️ 目标是**板上外挂的 W25Q32**，本插件未实机验证' },
  { i: 16, name: 'JTAG-1149 相关', note: '' },
  { i: 17, name: 'JTAG-1149 相关', note: '' },
  { i: 24, name: 'SRAM Erase', note: '' },
  { i: 36, name: 'thru GAO-Bridge', note: '' },
  { i: 37, name: 'thru GAO-Bridge', note: '' },
  { i: 38, name: 'thru GAO-Bridge', note: '' },
  { i: 39, name: 'thru GAO-Bridge', note: '' },
  { i: 51, name: 'exFlash Detect ID', note: '' },
  { i: 73, name: 'Read User Code', note: '' },
  { i: 74, name: 'Read Status Register', note: '' },
];

const FREQS = ['2.5', '2', '15', '10', '1.5', '1.1', '0.9', '0.75', '0.5', '0.4', '0.3', '0.1', '0.02'];

/** `operation_index` → 说明，按索引直接查（`OP_BY_INDEX[4]` 就是那个已知假失败的）。 */
const OP_BY_INDEX = Object.fromEntries(OP_INDEX.map((o) => [String(o.i), o]));

/**
 * 解析 programmer_cli 的控制台文本。
 *
 * ⚠️ **退出码不可靠**（失败也返回 0），所以判据只能看文本。
 */
function analyzeProgrammer(stdout, stderr, status) {
  const all = cleanOutput(`${stdout}\n${stderr}`);
  const devices = [];
  for (const m of all.matchAll(/^\s*(\d+)\s+(.+?)\s+([0-9A-Fa-f]{8})\s*$/gm)) {
    devices.push({ index: Number(m[1]), name: m[2].trim(), id: m[3].toUpperCase() });
  }
  if (!devices.length) {
    for (const m of all.matchAll(/Device\s*:\s*(.+?)\s*\(ID\s*[:=]?\s*(0x[0-9A-Fa-f]+|[0-9A-Fa-f]{8})\)/gim)) {
      devices.push({ index: -1, name: m[1].trim(), id: m[2].replace(/^0x/i, '').toUpperCase() });
    }
  }
  const noDevice = /No Gowin devices found/i.test(all);
  const noCable = /No (Gowin )?cable|can not find.*cable|Cable not found/i.test(all);
  const verifyFail = /Error:\s*Verify failed of at/i.test(all);
  const verifyOk = /Verify Success/i.test(all);
  const finished = /Finished\./i.test(all);
  const programDone = /Program (Finished|Success)|Programming (Finished|Success)/i.test(all);
  const hardError = /^(Error|ERROR)\b/m.exec(all)?.[0] ?? null;
  const errorLines = all.split('\n').map((l) => l.trim()).filter((l) => /^(Error|ERROR|Fatal)/.test(l));

  const suspicious =
    status === 48 ? '退出码 48 = 没扫到下载器（板子没上电 / USB 没插 / 驱动没装）'
      : status === 49 ? '退出码 49 = 扫到了下载器但没发现器件（同上的物理原因居多）'
        : null;

  return { devices, noDevice, noCable, verifyFail, verifyOk, finished, programDone, hardError, errorLines, suspicious, text: all, exitStatus: status };
}

function runProgrammer({ root, args, timeoutMs = 180000, cwd }) {
  const spec = commandSpec({ root, tool: 'programmer_cli' });
  if (!spec.ok) return { ok: false, message: spec.message };
  const t0 = Date.now();
  const res = spawnSync(spec.exe, args.map(String), {
    cwd: cwd ?? spec.cwd,
    env: spec.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    return { ok: false, timedOut: res.error.code === 'ETIMEDOUT', elapsedMs: Date.now() - t0, message: `跑 programmer_cli 失败：${res.error.message}` };
  }
  const a = analyzeProgrammer(res.stdout ?? '', res.stderr ?? '', res.status);
  return { ok: true, elapsedMs: Date.now() - t0, exe: spec.exe, args, ...a };
}

const toolProgram = {
  name: 'gowin_program',
  description:
    '烧录 / 扫描高云器件（`programmer_cli.exe`）。默认 `mode:"sram"`（operation_index 2，掉电即丢但最常用）、' +
    '`mode:"flash"`（index 6，片内 embFlash，掉电保持，约 19 s，出 Verify Success）、`mode:"scan"` 只扫器件。' +
    '⚠️ **programmer_cli 的退出码不可靠（失败也返回 0）**，判据只能看控制台文本（Finished. / Verify Success / Error）。' +
    '⚠️ 不要用 operation_index 4 —— 本器件恒报 `Error: Verify failed of at 0`，是已知假失败。',
  parameters: {
    mode: { type: 'string', enum: ['scan', 'sram', 'flash', 'verify', 'erase'], description: 'scan=只扫 / sram=index2 / flash=index6 / verify=读回 / erase=index24 SRAM Erase。默认 sram' },
    fsFile: { type: 'string', description: '.fs 码流路径（scan 模式可省；其余模式省略时自动找 impl\\pnr 下的码流）' },
    device: { type: 'string', description: '器件名，默认 GW1N-9C' },
    frequency: { type: 'string', enum: FREQS, description: 'JTAG 频率（MHz），默认 2.5' },
    scanCables: { type: 'boolean', description: 'true = 先列出所有下载器（--scan-cables）' },
    gowinRoot: { type: 'string', description: '手动指定高云安装根' },
    timeoutSec: { type: 'number', description: '超时秒数，默认 180' },
  },
  output,
  async execute(args, exec) {
    const cwd = exec?.cwd ?? process.cwd();
    const picked = resolveGowinRoot({ gowinRoot: args.gowinRoot });
    if (!picked.root) return { ok: false, message: `没有可用高云安装根：${picked.reason}` };
    const mode = args.mode ?? 'sram';
    const timeoutMs = (Number.isFinite(args.timeoutSec) ? Math.max(15, Math.floor(args.timeoutSec)) : 180) * 1000;
    const parts = [`安装根: ${picked.root}`, `模式: ${mode}`];

    if (args.scanCables) {
      const cab = runProgrammer({ root: picked.root, args: ['--scan-cables'], timeoutMs: 30000 });
      parts.push('\n== 下载器 ==');
      parts.push(cab.ok ? (cab.text || '（无输出）') : `❌ ${cab.message}`);
      if (cab.exitStatus === 48) parts.push('  退出码 48 = 没扫到下载器。');
    }

    if (mode === 'scan') {
      const res = runProgrammer({ root: picked.root, args: ['--scan'], timeoutMs: 60000, cwd });
      parts.push('\n== 扫描器件 ==');
      if (!res.ok) {
        parts.push(`❌ ${res.message}`);
        return { ok: false, message: parts.join('\n') };
      }
      parts.push(res.text || '（无输出）');
      if (res.devices.length) {
        parts.push(`\n✅ 发现 ${res.devices.length} 个器件：`);
        for (const d of res.devices) parts.push(`   ${d.name}  ID=${d.id}`);
      }
      if (res.noDevice) parts.push('\n❌ "No Gowin devices found!" —— 板子没上电 / USB 没插 / 下载器驱动没装，**不是软件问题**。');
      parts.push(`\n退出码 ${res.exitStatus}（仅参考：48=没下载器，49=有下载器没器件，但**成功失败都不能只看退出码**）`);
      return { ok: res.devices.length > 0, message: parts.join('\n'), devices: res.devices };
    }

    // ---- 需要码流的模式
    let fs = args.fsFile ? absPath(args.fsFile, cwd) : null;
    if (!fs) {
      const found = locateGprj(undefined, cwd);
      if (found.ok) {
        const arts = collectArtifacts(found.path);
        const cands = arts.bitstreams.filter((b) => /\.fs$/i.test(b.name));
        // GAO 工程优先 ao_0.fs（那时根本没有 <顶层>.fs）
        const pick = cands.find((b) => /^ao_0\.fs$/i.test(b.name)) ?? cands[0];
        if (pick) fs = pick.path;
      }
    }
    if (!fs || !existsSync(fs)) {
      return {
        ok: false,
        message: `${parts.join('\n')}\n\n❌ 找不到要烧的 .fs 码流。\n   请先 gowin_build，或用 fsFile 指定绝对路径。\n   注意：工程一旦挂了 .gao，码流文件名是 **ao_0.fs**，不在 impl\\pnr\\ 下找 <顶层>.fs。`,
      };
    }
    parts.push(`码流: ${fs}  (${fmtSize(statSync(fs).size)})`);

    const opIndex = { sram: 2, flash: 6, verify: 0, erase: 24 }[mode] ?? 2;
    const argv = [
      '--device', args.device ?? DEVICE.name,
      '--operation_index', String(opIndex),
      '--fsFile', fs,
      '--frequency', args.frequency ?? '2.5',
    ];
    parts.push(`命令: programmer_cli ${argv.join(' ')}`);
    parts.push('');

    const res = runProgrammer({ root: picked.root, args: argv, timeoutMs, cwd });
    if (!res.ok) {
      parts.push(`❌ ${res.message}`);
      return { ok: false, message: parts.join('\n') };
    }
    parts.push(res.text || '（无输出）');
    parts.push(`\n耗时 ${fmtMs(res.elapsedMs)}   退出码 ${res.exitStatus} ⚠️ 退出码不可靠`);

    const ok = res.verifyOk || (res.finished && res.programDone && !res.hardError);
    parts.push('');
    if (res.noDevice) {
      parts.push('❌ 没发现器件 —— 板子没上电 / USB 没插 / 驱动没装。');
    } else if (res.verifyFail) {
      parts.push('⚠️ 报 `Error: Verify failed of at 0`。**这是本器件在 SRAM Program+Verify(4) 上的已知假失败**；若你跑的就是 index 4，请改用 index 2。');
    } else if (ok) {
      parts.push(mode === 'flash' ? '✅ 烧录成功（片内 embFlash，掉电保持）。上板看现象。' : '✅ 烧录成功。⚠️ SRAM 模式掉电即丢，重新上电要重烧。');
    } else {
      parts.push('❌ 控制台里没有出现 Finished. / Program Finished! —— 判为失败（退出码不可信）。');
      if (res.errorLines.length) for (const l of res.errorLines.slice(0, 20)) parts.push(`   ${l}`);
      if (res.suspicious) parts.push(`   ${res.suspicious}`);
    }
    parts.push(`\n可用的 operation_index：${OP_INDEX.map((o) => o.i).join(' ')}（gowin_env 同名工具不带参数时也会提示）`);
    return { ok, message: parts.join('\n'), verifyOk: res.verifyOk, verifyFail: res.verifyFail };
  },
};

// ---------------------------------------------------------------- TCL / GAO

const toolTcl = {
  name: 'gowin_tcl',
  description:
    '在 `gw_sh.exe` 里跑任意 TCL 命令串（脚本写到 <cwd>\\.dsh-gowin\\tcl.tcl 再执行，方便复现）。' +
    '**这是查权威用法的正确方式**：gw_sh 注册了 122 个 TCL 命令，任何命令加 `-h` 都能打印官方用法。' +
    '⚠️ 常见坑：**`get_project_files` 不存在**；**TCL 8.6 没有 `file name` 子命令，要用 `file tail`**（写错会中断整个 foreach）。',
  parameters: {
    commands: { type: 'array', items: { type: 'string' }, description: '要依次执行的 TCL 明（如 ["help -category project", "open_project D:/x.gprj", "report_property"]）' },
    preset: { type: 'string', enum: ['list_commands', 'help_run', 'help_set_option', 'help_open_project', 'help_create_project', 'help_add_file', 'help_saveto'], description: '便捷预设，与 commands 二选一' },
    timeoutSec: { type: 'number', description: '超时秒数，默认 120' },
    gowinRoot: { type: 'string', description: '手动指定高云安装根' },
  },
  output,
  async execute(args, exec) {
    const cwd = exec?.cwd ?? process.cwd();
    const picked = resolveGowinRoot({ gowinRoot: args.gowinRoot });
    if (!picked.root) return { ok: false, message: `没有可用高云安装根：${picked.reason}` };

    const presets = {
      list_commands: ['puts "== info commands =="', 'puts [lsort [info commands]]'],
      help_run: ['run -h'],
      help_set_option: ['set_option -h'],
      help_open_project: ['open_project -h'],
      help_create_project: ['create_project -h'],
      help_add_file: ['add_file -h'],
      help_saveto: ['saveto -h'],
    };
    let commands = Array.isArray(args.commands) ? args.commands.filter((c) => String(c).trim()) : [];
    if (!commands.length && args.preset) commands = presets[args.preset] ?? [];
    if (!commands.length) {
      return {
        ok: false,
        message:
          '请给 commands（TCL 命令数组）或 preset。\n' +
          '可用 preset：' + Object.keys(presets).join(', ') + '\n\n' +
          '几个已验证的权威用法：\n' +
          '  run 只接受 syn | pnr | all\n' +
          '  open_project <file.gprj>            打开已有工程\n' +
          '  create_project -name X -dir D -pn GW1N-UV9LQ144C6/I5 -device_version C -force\n' +
          '  add_file <file> [-type file.verilog] 加文件（type 必须对）\n' +
          '  set_option -top_module <名>\n' +
          '  saveto -all_options out.tcl          把当前设置导出成可复现脚本',
      };
    }

    const timeoutMs = (Number.isFinite(args.timeoutSec) ? Math.max(10, Math.floor(args.timeoutSec)) : 120) * 1000;
    const res = runTclCommands({ root: picked.root, workdir: cwd, commands, timeoutMs });

    const parts = [`安装根: ${picked.root}`, `命令 ${commands.length} 条`, ''];
    if (!res.scriptPath) {
      parts.push(`❌ ${res.message ?? '跑 gw_sh 失败（没落到脚本文件）'}`);
      return { ok: false, message: parts.join('\n') };
    }
    parts.push(`耗时 ${fmtMs(res.elapsedMs)}  退出码 ${res.status}`);
    parts.push(`脚本: ${res.scriptPath}`);

    // 去掉 begin/end 标记之间的噪声，只留正文
    let body = String(res.stdout ?? '');
    const b = body.indexOf('===BEGIN===');
    const e = body.indexOf('===END===');
    if (b >= 0 && e > b) body = body.slice(b + '===BEGIN==='.length, e);
    body = body.trim();
    parts.push('\n== 输出 ==');
    parts.push(body || '（无输出）');
    if (res.stderr) parts.push(`\n== stderr ==\n${res.stderr}`);
    if (res.errors.length) {
      parts.push(`\n== ERROR ==`);
      for (const l of res.errors.slice(0, 20)) parts.push(`  ${l}`);
    }
    return { ok: res.status === 0, message: parts.join('\n'), commands, scriptPath: res.scriptPath };
  },
};

const toolGao = {
  name: 'gowin_gao',
  description:
    '在线逻辑分析仪（GAO）。两种用法：① 看/查 `.gao`/`.rao` 定义文件与采集产物；' +
    '② `launch:true` 时启动 `gao_analyzer.exe` 采集界面。' +
    '关键事实：**加了 .gao 后 `run pnr` 不再生成 <顶层>.fs，只生成 `ao_0.fs`（约 3.5 MB）**，烧录要烧 ao_0.fs；' +
    '`gao_analyzer.exe` 的 **cwd 必须是 IDE\\bin**，且 `-series` 与 `-device` **必须同时给**（缺一个弹 "Can not set device."）。' +
    '⚠️ `gao_sh.exe` 是死路（argv[1] 为 -gao 时永久挂死），本插件已禁用。',
  parameters: {
    action: { type: 'string', enum: ['inspect', 'launch'], description: 'inspect=看定义与产物（默认）/ launch=启动采集界面' },
    file: { type: 'string', description: 'inspect: .gprj 或 .gao/.rao 路径（省略则自动找）' },
    gaoFile: { type: 'string', description: 'launch: 要打开的 .gao 文件路径' },
    fsFile: { type: 'string', description: 'launch: 要连的码流（`--fsFile`，注意是双横线，不是文档里的 -fs）' },
    series: { type: 'string', description: 'launch: 系列名，默认 GW1N（**必须给**）' },
    device: { type: 'string', description: 'launch: 器件名，默认 GW1N-9C（**必须给**）' },
    gowinRoot: { type: 'string', description: '手动指定高云安装根' },
  },
  output,
  async execute(args, exec) {
    const cwd = exec?.cwd ?? process.cwd();
    const picked = resolveGowinRoot({ gowinRoot: args.gowinRoot });
    if (!picked.root) return { ok: false, message: `没有可用高云安装根：${picked.reason}` };
    const action = args.action ?? 'inspect';
    const parts = [];

    if (action === 'inspect') {
      const found = locateGprj(args.file, cwd);
      const gprj = found.ok ? found.path : null;
      parts.push(gprj ? `工程: ${gprj}` : `（没找到 .gprj：${found.message}）`);

      // 定义文件
      const defs = [];
      if (gprj) {
        const proj = loadProject(gprj);
        if (proj.ok) for (const f of [...proj.groups.gao, ...proj.groups.rao]) defs.push(f);
      }
      if (args.file && /\.(gao|rao)$/i.test(args.file)) {
        const p = absPath(args.file, cwd);
        if (existsSync(p)) defs.push({ path: p, abs: p, exists: true, type: /\.rao$/i.test(p) ? 'file.rao' : 'file.gao' });
      }
      parts.push(`\n== GAO 定义文件（${defs.length}）==`);
      if (!defs.length) {
        parts.push('  （没有）—— 要加 GAO 就在工程里挂一个 .gao/.rao 文件（它是普通设计文件，可以手写 XML）。');
        parts.push('  扩展名按信号来源分：For RTL Design → .rao；For Post-Synthesis Netlist → .gao。');
      }
      for (const d of defs) {
        parts.push(`  ${d.exists ? '✅' : '❌'} ${d.path}${d.exists ? `  (${fmtSize(statSync(d.abs).size)})` : '  ← 不存在'}`);
        if (d.exists) {
          const text = readTextSafe(d.abs, 512 * 1024);
          const buses = [...(text ?? '').matchAll(/<Bus>([\s\S]*?)<\/Bus>/g)].length;
          const depth = /<storage_depth>\s*(\d+)/i.exec(text ?? '')?.[1] ?? /storage_depth\s*=\s*"(\d+)"/i.exec(text ?? '')?.[1] ?? null;
          const clock = /<(?:sample_clock|sampleClock)>\s*([^<\s]+)/i.exec(text ?? '')?.[1] ?? null;
          const trig = [...(text ?? '').matchAll(/<Trigger>/g)].length;
          const mu = [...(text ?? '').matchAll(/<MatchUnit>/g)].length;
          parts.push(`     <Bus> 段 ${buses} 个 | <Trigger> ${trig} | <MatchUnit> ${mu} | storage_depth=${depth ?? '?'} | sample_clock=${clock ?? '?'}`);
          parts.push('     ⚠️ 模板要点：<Bus> **必须每位单独一行**；<Triggers>/<MatchUnits> 各写满 **16 个**（未用要自闭合）；');
          parts.push('        sample_clock 必须是设计里真实存在、且与采样信号有 2 倍频以上关系的时钟；capture_amount ≤ storage_depth；window_num ≤ storage_depth/4。');
        }
      }

      // 产物
      if (gprj) {
        const arts = collectArtifacts(gprj);
        parts.push(`\n== 采集产物 ==`);
        const gaoBits = arts.bitstreams.filter((b) => /^ao_\d+\.fs$/i.test(b.name));
        if (gaoBits.length) {
          for (const b of gaoBits) parts.push(`  🆕 ${fmtSize(b.size).padStart(10)}  ${b.path}`);
          parts.push('  ℹ️ 这就是**要烧的码流**（GAO 插入后 <顶层>.fs 不再生成）。');
        } else {
          parts.push('  （没有 ao_0.fs —— 工程可能还没编译过，或没挂 GAO）');
        }
        const gaoDir = arts.gao.filter((g) => /gw_ao_parameter\.v$/i.test(g.name))[0];
        const waveDir = join(dirname(gprj), 'impl', 'wave');
        if (existsSync(waveDir)) {
          const waves = readdirSync(waveDir).slice(0, 20);
          parts.push(`\n  波形目录 impl\\wave\\（${waves.length}${waves.length === 20 ? '+' : ''} 个文件）:`);
          for (const w of waves) parts.push(`    ${w}`);
        }
        if (gaoDir) parts.push(`\n  GAO 参数文件: ${gaoDir.path}`);
      }

      parts.push('\n== 采集流程（实测六步）==');
      parts.push('  1. gowin_build（task:"all"）—— 挂 GAO 的工程会生成 impl\\pnr\\ao_0.fs');
      parts.push('  2. gowin_program （烧 ao_0.fs；GAO 采集前**必须**先把带 GAO 核的码流烧进去）');
      parts.push('  3. gowin_gao { action:"launch" } —— 启动采集界面');
      parts.push('  4. 界面里把 TabItem 从 Configuration 切到 `core 0`，等状态从 "Please program the device first" 变成 "Ready to acquire"');
      parts.push('  5. 点采集，看 TreeItem 里的信号值（如 cnt[24:0]）');
      parts.push('  6. 导出波形：impl\\wave\\ 下的 csv/vcd/prn/gwd');
      parts.push('\n  ⚠️ 导出 CSV 的 **time 列单位来自 Export 对话框的 Clock period 默认值（1 us），不是采样时钟真实周期** —— 只影响标注，采样数据本身正确。');
      parts.push('  ⚠️ 格式切到 VCD 这一步**没能全自动**（Qt QComboBox 在该 build 下 List rect 为空，选中不生效），需要人工点。');
      return { ok: true, message: parts.join('\n'), gprj };
    }

    // ---- launch
    const gaoFile = args.gaoFile ? absPath(args.gaoFile, cwd) : null;
    let fs = args.fsFile ? absPath(args.fsFile, cwd) : null;
    if (!fs) {
      const found = locateGprj(undefined, cwd);
      if (found.ok) {
        const arts = collectArtifacts(found.path);
        fs = arts.bitstreams.find((b) => /^ao_\d+\.fs$/i.test(b.name))?.path ?? arts.bitstreams.find((b) => /\.fs$/i.test(b.name))?.path ?? null;
      }
    }
    const series = args.series ?? 'GW1N';
    const device = args.device ?? DEVICE.name;

    const spec = commandSpec({ root: picked.root, tool: 'gao_analyzer' });
    if (!spec.ok) return { ok: false, message: spec.message };
    const argv = [];
    if (gaoFile && existsSync(gaoFile)) argv.push('-gao', gaoFile);
    argv.push('-series', series, '-device', device);
    if (fs && existsSync(fs)) argv.push('--fsFile', fs);

    parts.push(`启动 ${spec.exe}`);
    parts.push(`cwd = ${spec.cwd}   ← **必须是 IDE\\bin**，否则无论带不带参数都立刻退出码 1`);
    parts.push(`参数: ${argv.join(' ')}`);
    parts.push('   ⚠️ `-series` 与 `-device` 必须同时给（缺一个会弹 "Can not set device."）');
    parts.push('   ⚠️ 码流参数是 `--fsFile`（双横线），不是用户指南里写的 `-fs`。');
    if (!gaoFile) parts.push('   ℹ️ 没给 gaoFile，只开界面（可从界面里再选 .gao）。');
    if (!fs) parts.push('   ⚠️ 没找到 .fs 码流 —— 不烧码流的话采集界面会停在 "Please program the device first"。');

    try {
      const child = spawnSync('cmd.exe', ['/c', 'start', '', spec.exe, ...argv], {
        cwd: spec.cwd,
        env: spec.env,
        windowsHide: false,
        timeout: 15000,
      });
      void child;
      parts.push('\n✅ 已请求启动（GUI 在你自己桌面上，窗口可能出现得慢几秒）。');
      parts.push('   采集：把 TabItem 切到 `core 0` → 等 "Ready to acquire" → 采集 → 导出到 impl\\wave\\。');
    } catch (error) {
      parts.push(`\n❌ 启动失败：${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, message: parts.join('\n') };
    }
    return { ok: true, message: parts.join('\n'), argv, cwd: spec.cwd, exe: spec.exe };
  },
};

// ---------------------------------------------------------------- 报告 / 产物

const toolReport = {
  name: 'gowin_report',
  description:
    '读布局布线产物并给出结构化结论：资源占用（Logic/Register/CLS/IO）、I/O Bank 电压、时钟资源、' +
    '**逐端口引脚表**（端口名/方向/实际 Site/电平/上下拉）、**逐路径时序裕量**（.timing_paths 里的 SETUP/HOLD slack，负值=违规）、' +
    '`cmd.do` 与 `device.cfg` 的器件与选项。' +
    '⚠️ `.fs` 码流**逐字节不完全相同**（内嵌路径/时间戳），判两次构建是否等价要比 cmd.do / device.cfg / 资源报告，**别比 .fs 哈希**。',
  parameters: {
    file: { type: 'string', description: '.gprj 路径（省略则自动查找）' },
    section: { type: 'string', enum: ['all', 'resource', 'pinout', 'timing', 'options'], description: '只看一部分，默认 all' },
    port: { type: 'string', description: '只查某个端口（支持唯一子串）' },
  },
  output,
  async execute(args, exec) {
    const found = locateGprj(args.file, exec?.cwd);
    if (!found.ok) return found;
    const gprj = found.path;
    const section = args.section ?? 'all';
    const parts = [`工程: ${gprj}`];

    const rptPath = findPnrReport(gprj);
    if (!rptPath) {
      parts.push('\n❌ 没找到 impl\\pnr\\*.rpt.txt —— 布局布线还没跑完。先 gowin_build { task:"all" }。');
      return { ok: false, message: parts.join('\n') };
    }
    const rpt = parsePnrReport(rptPath);
    if (!rpt.ok) return rpt;
    parts.push(`报告: ${rptPath}`);
    parts.push(`器件: ${rpt.device} / ${rpt.partNumber} / version ${rpt.deviceVersion}   工具: ${rpt.toolVersion}`);
    parts.push(`物理约束: ${rpt.physicalConstraints ?? '-'}`);
    parts.push(`时序约束: ${rpt.timingConstraints ?? '-'}${/^-+$/.test(rpt.timingConstraints ?? '') ? '  ← 没加 .sdc，所以会有 TA1132' : ''}`);
    parts.push(`耗时 ${rpt.elapsed ?? '-'}   峰值内存 ${rpt.peakMemory ?? '-'}   节: ${rpt.sections.map((s) => `${s.n}.${s.title}`).join(' | ')}`);

    if (section === 'all' || section === 'resource') {
      parts.push('\n== 资源占用 ==');
      if (!rpt.resources.length) parts.push('  （没解析出资源表）');
      for (const r of rpt.resources) parts.push(`  ${r.name.padEnd(28)} ${r.usage.padEnd(22)} ${r.utilization}`);
      if (rpt.banks.length) {
        parts.push('\n== I/O Bank ==');
        for (const b of rpt.banks) parts.push(`  bank ${b.bank}  ${b.usage.padEnd(12)} ${b.utilization}`);
      }
      parts.push('\n== 时钟资源 ==');
      for (const c of rpt.clockResources) parts.push(`  ${c.name.padEnd(14)} ${c.usage.padEnd(12)} ${c.utilization}`);
      if (rpt.globalClocks.length) {
        parts.push('\n== 全局时钟信号 ==');
        for (const g of rpt.globalClocks) parts.push(`  ${g.signal.padEnd(16)} ${g.kind.padEnd(14)} ${g.location}`);
      }
    }

    if (section === 'all' || section === 'pinout') {
      parts.push(`\n== 端口引脚表（${rpt.ports.length}）==`);
      const q = args.port ? String(args.port).toLowerCase() : null;
      const hit = q ? rpt.ports.filter((p) => p.name.toLowerCase().includes(q)) : rpt.ports;
      if (q && !hit.length) {
        parts.push(`  （没有端口名含 "${args.port}"；全部端口：${rpt.ports.map((p) => p.name).join(', ')}）`);
      }
      for (const p of hit) {
        const roles = /^\d+/.test(p.locBank) ? pinRole(Number(p.locBank.split('/')[0])) : [];
        const tag = roles.length ? `  [板上=${roles.map((r) => r.sch ?? r.signal ?? r.role).join('/')}]` : '';
        parts.push(`  ${p.name.padEnd(16)} ${p.dir.padEnd(5)} ${p.locBank.padEnd(12)} site=${p.site.padEnd(10)} ${p.ioType.padEnd(10)} pull=${p.pullMode.padEnd(4)} vccio=${p.bankVccio}${tag}`);
      }
      const wrongV = rpt.ports.filter((p) => Number(p.bankVccio) > 0 && Math.abs(Number(p.bankVccio) - DEVICE.bankVccio) > 0.01);
      if (wrongV.length) {
        parts.push(`\n  ⚠️ ${wrongV.length} 个端口的 BankVccio 不是 ${DEVICE.bankVccio} V：${wrongV.map((p) => `${p.name}=${p.bankVccio}`).join(', ')}`);
        parts.push('     本板四个 Bank 由 0Ω 接 D3V3，实际 3.3 V —— 写 1.8 通常是照抄了原厂 03/04/06 的 .cst。');
      }
    }

    if (section === 'all' || section === 'timing') {
      const stem = basename(rptPath).replace(/\.rpt\.txt$/i, '');
      const tp = join(dirname(rptPath), `${stem}.timing_paths`);
      const tpPath = existsSync(tp) ? tp : null;
      parts.push('\n== 时序 ==');
      if (!tpPath) {
        parts.push('  （没找到 .timing_paths —— 通常是没有 .sdc 时钟约束，或 -timing 没开）');
      } else {
        const t = parseTimingPaths(tpPath);
        if (!t.ok) {
          parts.push(`  ${t.message}`);
        } else {
          parts.push(`  文件: ${tpPath}`);
          parts.push(`  SETUP 路径 ${t.setupCount} 条，违规 ${t.setupViolations} 条   最差 slack = ${t.worstSetup ? t.worstSetup.slack.toFixed(3) : '-'} ns`);
          parts.push(`  HOLD  路径 ${t.holdCount} 条，违规 ${t.holdViolations} 条   最差 slack = ${t.worstHold ? t.worstHold.slack.toFixed(3) : '-'} ns`);
          if (t.setupViolations === 0 && t.holdViolations === 0) {
            parts.push('  ✅ 没有时序违规。');
          } else {
            parts.push('  ❌ 存在时序违规，最差几条：');
            const worst = [...t.paths].sort((a, b) => a.slack - b.slack).slice(0, 5);
            for (const w of worst) parts.push(`     ${w.kind} slack=${w.slack.toFixed(3)} ns   ${w.start} → ${w.end}`);
          }
          parts.push('  ⚠️ .timing_paths 里没有 Fmax 那一行；Fmax 要从 report.html 或界面里看。要判「两次构建等价」请比 cmd.do / device.cfg，**别比 .fs 哈希**。');
        }
      }
    }

    if (section === 'all' || section === 'options') {
      const cmdDoPath = join(dirname(rptPath), 'cmd.do');
      const cfgPath = join(dirname(rptPath), 'device.cfg');
      parts.push('\n== cmd.do ==');
      if (!existsSync(cmdDoPath)) {
        parts.push('  （没有）');
      } else {
        const c = parseCmdDo(cmdDoPath);
        parts.push(`  器件 ${c.device}  pn ${c.partNumber}  global_freq ${c.globalFreqMHz ?? '-'} MHz`);
        parts.push(`  -d  ${c.netlist}`);
        parts.push(`  -cst ${c.cst}`);
        parts.push(`  -sdc ${c.sdc}`);
        parts.push(`  选项: ${Object.entries(c.options).filter(([k]) => !['d', 'cst', 'sdc', 'p', 'pn', 'cfg'].includes(k)).map(([k, v]) => (v === true ? `-${k}` : `-${k} ${v}`)).join(' ')}`);
      }
      parts.push('\n== device.cfg ==');
      if (!existsSync(cfgPath)) {
        parts.push('  （没有）');
      } else {
        const d = parseDeviceCfg(cfgPath);
        parts.push(`  vcc=${d.vcc}  vccx=${d.vccx}  unused_pin=${d.unusedPin}  compress=${d.compress}  encryption=${d.encryption}`);
        parts.push(`  JTAG regular_io=${d.jtagAsGpio}  ← true 表示 JTAG 脚被当 GPIO 用（会失去烧录/在线调试）`);
        parts.push(`  全部设置: ${Object.entries(d.settings).map(([k, v]) => `${k}=${v}`).join('  ')}`);
      }
    }
    return { ok: true, message: parts.join('\n'), report: rpt };
  },
};

const toolArtifacts = {
  name: 'gowin_artifacts',
  description:
    '列出一个高云工程 impl\\ 下的全部产物（码流/报告/网表/GAO 产物/波形），带大小与修改时间，' +
    '并直接给出「哪个文件是要烧的」。判断编译是否成功、上次构建是什么时候跑的，用它最快。',
  parameters: {
    file: { type: 'string', description: '.gprj 路径（省略则自动查找）' },
    limit: { type: 'number', description: '每类最多列多少行，默认 40' },
  },
  output,
  async execute(args, exec) {
    const found = locateGprj(args.file, exec?.cwd);
    if (!found.ok) return found;
    const gprj = found.path;
    const parts = [`工程: ${gprj}`];
    const arts = collectArtifacts(gprj);
    if (!arts.implExists) {
      parts.push('\n（没有 impl\\ 目录 —— 还没编译过。先 gowin_build { task:"all" }）');
      return { ok: false, message: parts.join('\n') };
    }
    const { n } = clip([], args.limit);
    const show = (title, list, mark) => {
      if (!list.length) return;
      const cut = list.slice(0, n);
      parts.push(`\n== ${title}（${list.length}）==`);
      for (const f of cut) {
        const t = new Date(f.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
        parts.push(`  ${mark ?? ' '} ${fmtSize(f.size).padStart(10)}  ${t}  ${f.path}`);
      }
      if (list.length > cut.length) parts.push(`  … 其余 ${list.length - cut.length} 个略（加大 limit）`);
    };

    const fsFiles = arts.bitstreams.filter((b) => /\.fs$/i.test(b.name));
    const others = arts.bitstreams.filter((b) => !/\.fs$/i.test(b.name));
    parts.push('\n== 哪个是要烧的 ==');
    if (arts.hasGaoBitstream) {
      const ao = fsFiles.find((b) => /^ao_\d+\.fs$/i.test(b.name));
      parts.push(`  👉 ${ao.path}`);
      parts.push(`  ℹ️ ${arts.note}`);
    } else if (fsFiles.length) {
      parts.push(`  👉 ${fsFiles[0].path}`);
    } else {
      parts.push('  ❌ 没有 .fs 码流 —— 编译不成功（即使退出码是 0）。');
    }

    show('码流 .fs', fsFiles, '🔥');
    show('其它二进制 .bin/.binx', others);
    show('布局布线报告', arts.reports);
    show('综合产物', arts.synthesis);
    show('GAO 产物', arts.gao);
    return { ok: true, message: parts.join('\n'), bitstreams: arts.bitstreams };
  },
};

// ---------------------------------------------------------------- 文档

const DOC_HINTS = [
  { key: 'tcl', title: 'SUG1220 Gowin 云源软件 TCL 命令用户指南', where: 'IDE\\doc\\CN\\ 或 %USERPROFILE%\\Documents\\BOOK\\SUG1220-2.1', why: '**TCL 权威**：run/open_project/create_project/set_option/add_file/saveto 的准确参数。任何命令加 -h 也能打印用法。' },
  { key: 'gao', title: 'SUG114 Gowin 在线逻辑分析仪用户指南', where: 'IDE\\doc\\CN\\SUG114-3.4.3…… 或 BOOK\\SUG114-3.5', why: '**GAO 权威**（58 页）：.gao XML 模板、storage_depth/capture_amount 关系、BSRAM/SSRAM/REG 选择、MatchUnit 值格式。' },
  { key: 'gvio', title: 'SUG1189 Gowin 虚拟输入输出（GVIO）', where: 'IDE\\doc\\CN 或 BOOK\\SUG1189-1.4.3', why: 'gvio_analyzer.exe 参数与 GAO 同构（-gvio/-gao/-dir/-series/-device/-fs），**未实测**。' },
  { key: 'quick', title: 'SUG918 快速入门', where: 'IDE\\doc\\CN', why: '§3.11/3.12 讲 GAO 与 GVIO 联合调试。' },
  { key: 'primitives', title: 'SUG283 原语用户指南', where: 'BOOK\\SUG283-3.6.1', why: '原语（PLL/BSRAM/IO 缓冲）的实例化写法。' },
  { key: 'pinout', title: 'UG114 GW1N-9 器件 Pinout', where: 'BOOK\\UG114-1.5_GW1N-9', why: '**逐脚权威**：某个 IO 号对应哪个 Bank、哪个 Site、哪些是专用脚。判「本板引脚表对不对」要查它。' },
  { key: 'physical', title: 'SUG1541 物理约束用户指南', where: 'BOOK\\SUG1541-1.0', why: '.cst 里 IO_LOC / IO_PORT 全部属性的合法取值（IO_TYPE/PULL_MODE/DRIVE/OPEN_DRAIN/BANK_VCCIO…）。' },
  { key: 'user', title: 'SUG100 用户指南', where: 'IDE\\doc\\CN 或 BOOK\\SUG100-4.4.7', why: '综合/布局布线选项的完整说明。' },
  { key: 'programmer', title: 'SUG502 Programmer', where: 'IDE\\doc\\CN', why: '下载器与烧录流程。' },
  { key: 'datasheet', title: 'DS100 GW1N-9 数据手册', where: 'BOOK\\DS100-3.3.3', why: '电气参数、资源规模（8640 LUT / 6843 FF / 4320 CLS）。' },
];

const toolDocs = {
  name: 'gowin_docs',
  description:
    '高云文档路标：本机 IDE\\doc\\CN 与 %USERPROFILE%\\Documents\\BOOK 里的官方 PDF，按「要查什么」指到该看哪一本。' +
    '给 query 会在已抽出的文本里做关键词搜索（doc_SUG114_CN.txt / doc_SUG1189_CN.txt / doc_SUG918_CN.txt / doc_FG202_sch.txt）。' +
    '⚠️ 英文版 SUG114 字体没有 ToUnicode 表，抽出来是乱码，**只能用中文版**。',
  parameters: {
    topic: { type: 'string', enum: DOC_HINTS.map((d) => d.key), description: '只看某一本' },
    query: { type: 'string', description: '在已抽出的文档文本里搜关键词' },
  },
  output,
  async execute(args, exec) {
    const cwd = exec?.cwd ?? process.cwd();
    const parts = ['== 该看哪一本 =='];
    for (const d of DOC_HINTS) {
      if (args.topic && d.key !== args.topic) continue;
      parts.push(`\n[${d.key}] ${d.title}`);
      parts.push(`  位置: ${d.where}`);
      parts.push(`  用途: ${d.why}`);
    }

    if (args.query) {
      const q = String(args.query);
      parts.push(`\n== 在已抽出文本里搜 "${q}" ==`);
      const roots = [cwd, join(cwd, 'gowin-build'), resolve(cwd, '..', 'gowin-build')];
      const files = ['doc_SUG114_CN.txt', 'doc_SUG1189_CN.txt', 'doc_SUG918_CN.txt', 'doc_FG202_sch.txt'];
      let hits = 0;
      for (const root of roots) {
        for (const f of files) {
          const p = join(root, f);
          if (!existsSync(p)) continue;
          const text = readTextSafe(p, 4 * 1024 * 1024);
          if (!text) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits < 40; i += 1) {
            if (lines[i].includes(q)) {
              parts.push(`  ${p}:${i + 1}  ${lines[i].trim().slice(0, 200)}`);
              hits += 1;
            }
          }
          if (hits) break;
        }
        if (hits) break;
      }
      if (!hits) {
        parts.push('  （没命中。已抽出的文本只在 gowin-build\\ 下；原理图抽出的文本**丢失连线关系**，判「哪个网络接哪个引脚」必须看截图或与例程 .cst 交叉验证。）');
        parts.push('  抽取脚本: gowin-build\\pdf_extract.py（纯 Python 无依赖）；截图放大: gowin-build\\sch_render.py / sch_find.py（需要 gowin-build\\.venv\\Scripts\\python.exe，PyMuPDF 装在那里）。');
      }
    }
    return { ok: true, message: parts.join('\n') };
  },
};

// ---------------------------------------------------------------- 帮助 / 排错

const PITFALLS = [
  ['LED 低电平点亮', 'IO 输出 **0=亮、1=灭**。复位值写成 4\'b1111 就是全灭（本工程踩过：四灯全灭排查了半天）。更稳的做法是让"全灭"不成为任何合法状态。', 'board'],
  ['丝印 POWER 的灯不受 FPGA 控制', '它接在 D5V 上（R5 1K），别当成可控 LED 去驱动。', 'board'],
  ['RST_N = IO75 = KEY1', '本板**没有专用复位芯片**，上电时 10K 把它拉为高，不会自动产生低脉冲。设计若依赖"上电复位"必须自己写。', 'board'],
  ['按键无硬件消抖', 'KEY1~KEY4 = IO75/76/97/99，按下=0。没有 RC，必须 Verilog 里消抖。', 'board'],
  ['Bank 电压 1.8 是抄错的', '本板四个 Bank 由 0Ω（R31~R34）接 D3V3 = **3.3 V**。原厂 03_Key_FallEage / 04_UART / 06_FLASH 的 .cst 写的是 1.8，别照抄。', 'cst'],
  ['加 GAO 后码流改名', '一旦挂 .gao，`run pnr` 自动插入 GAO 核，**impl\\pnr\\ 里不再生成 <顶层>.fs，只有 ao_0.fs**（约 3.5 MB）。烧录要烧 ao_0.fs。', 'gao'],
  ['programmer_cli 退出码不可靠', '失败也返回 0。判据只能看控制台文本：`Finished.` / `Verify Success` / `Program Finished!` / `Error`。', 'program'],
  ['operation_index 4 恒假失败', '本器件在 SRAM Program+Verify (4) 上**恒报** `Error: Verify failed of at 0`。SRAM 烧录用 2，掉电保持用 6。', 'program'],
  ['gao_analyzer 两个硬要求', '**cwd 必须是 IDE\\bin**；`-series` 与 `-device` **必须同时给**（缺一个弹 "Can not set device."）。码流参数是 `--fsFile`，不是文档里的 `-fs`。', 'gao'],
  ['gao_sh.exe 是死路', '第一个位置参数必须是 .gao 文件；argv[1] 是 `-gao` 就**永久挂死**。定向实验证明它从不连 \\\\.\\pipe\\gao1。GAO 只走 gao_analyzer.exe。', 'gao'],
  ['gw_ide.exe 不能当 CLI', '加 `-h` 也会拉起 GUI 并挂住。编译只走 gw_sh.exe。', 'env'],
  ['GOWIN_HOME 必须设', '不设会直接报 `Please set environment variable GOWIN_HOME`，并定位不到 device/lib。插件每次调用都会显式注入。', 'env'],
  ['create_project -dir 多建一层', '`-dir D` 会多建一层 `D\\<name>\\`，路径要按这个预期写。', 'env'],
  ['TCL 的两个反直觉点', '**`get_project_files` 不存在**；**没有 `file name` 子命令，要用 `file tail`**（写错会中断整个 foreach）。', 'env'],
  ['gw_sh 的 stderr 是噪声', '`alog error: failed to open log file` 是无害的（AppData 写不进去），**绝不能拿 stderr 非空判失败**。', 'build'],
  ['.fs 不能比哈希', '.fs 逐字节不完全相同（内嵌路径与时间戳，差十几字节）。判两次构建等价要比 cmd.do / device.cfg / 资源报告。', 'report'],
  ['常见非致命警告', 'TA1132（时钟没被 create_clock 定义，缺 .sdc）、EX3012（顺序块空语句）、EX3791（32 位截断为 8 位）、PA1015（GAO 采样信号被替换为 _d，正常）。', 'build'],
  ['export_wave 只能全自动到 CSV', '把格式从 CSV 切成 VCD 这一步**没能全自动**：Qt QComboBox 在该 build 下 List rect 为空，SelectionItemPattern.Select() 报成功但读回不变，键盘 VK_DOWN 因窗口后台无焦点也无效。需要人工点。', 'gao'],
  ['CSV 的 time 列单位是假的', '导出 CSV 的 time 列单位来自 Export 对话框的 Clock period 默认值（1 us），**不是采样时钟的真实周期**。只影响标注，采样数据正确。', 'gao'],
  ['Qt UIA InvokePattern 会死锁', '会弹模态框的动作（如 Export）用 InvokePattern 会阻塞上百秒。改用 PostMessage WM_LBUTTONDOWN/UP。窗口太窄时工具栏按钮根本不在 UIA 树里，先 MoveWindow 放大到 1900×1000。', 'gao'],
  ['DPI 缩放换算', '本机 150% 缩放：UIA 给物理像素、Win32 给虚拟像素，scale = UIA矩形 / Win32矩形。', 'gao'],
  ['RTL 功能仿真本机不可行', '没装 ModelSim/Questa（`where vsim` 退出码 1），IDE\\simlib 是空壳。要功能仿真得先装仿真器。', 'env'],
  ['jtagserver 旁路成本过高', '协议已逆向（命名管道 gao1 + TCP 36548，4 字节大端长度 + QDataStream(Qt_4_8) 的 QVariantMap，键 CMD/RES/DATA，值 OPEN/QUERY/CLOSE/WRITE/READ/GAO_STOP），但 **GAO 核寄存器时序在服务端之外**，无头采集已放弃。', 'gao'],
  ['SPI Flash 那 4 根是配置脚，但可复用', 'MCLK=IO93 / MCS_N=IO94 / MO=IO95 / MI=IO96 同时是 Gowin 专用配置脚。**不要给它们加 `exclusive`，也不要叠加冲突的 IO_PORT 属性**；用户逻辑复用它们是被允许的（06_FLASH 实测可用）。另外 operation_index 6 烧的是片内 embFlash，跟这颗外部 W25Q32 不是一回事 —— 要写外部 Flash 数据得另写逻辑或走 Programmer 的 external flash 选项。', 'board'],
  ['原理图标题栏是模板残留', 'FG202 的 PDF 标题栏写着 "GW1N-LV4LQ144核心板 / FW202 核心板 V1.0"，是原厂模板没改。以 U7 丝印 **GW1N-UV9LQ144C6/I5** 为准。', 'board'],
  ['板上只有一颗时钟', 'Y1 = 50 MHz 有源晶振 → R20 22Ω → CLK_IN → **IO98** = IOR9[A]/GCLKT_2（BANK1 专用全局时钟脚）。没有第二颗晶振，别的频率只能自己分频。', 'board'],
  ['原理图文本抽不出连线关系', 'pdf_extract.py 啃不动本板原理图（输出全空），抽出的文本顺序也不可信、且丢连线。**判断"哪个网络接哪个引脚"必须靠截图或与例程 .cst 交叉验证**。', 'env'],
];

const PLAYBOOKS = {
  build_failed: {
    title: '编译失败怎么查',
    steps: [
      '先 gowin_check —— 一半的失败（引脚冲突、文件不存在、器件码不匹配）在编译前就能看出来。',
      '看 gowin_build 输出里的 ERROR( 行。**不要**因为 stdout 里有 "Error" 字样就慌，先确认是不是 `alog error:` 噪声（已过滤）。',
      '`ERROR (EX3xxx)` 是语法/可综合性问题，照行号改 Verilog。',
      '`ERROR (PR/PL/RT...)` 是布局布线问题：常见根因是引脚不存在、引脚被占两次、时序约束指向不存在的端口。',
      '`Please set environment variable GOWIN_HOME` → gowin_env 确认安装根，或给 gowinRoot 参数。',
      '退出码 0 但**没有 .fs**：`run all` 中途某步失败但没抛异常，去 impl\\pnr\\*.log 与 gwsynthesis\\*.log 里找最后几行。',
      '实在卡住：gowin_build { task:"syn" } 只跑综合，把问题范围缩到一半。',
    ],
  },
  all_leds_off: {
    title: '上板四灯全灭怎么查',
    steps: [
      '先确认配置成没成功：programmer_cli 控制台要有 `Finished.` 且没有 `Error:`。',
      '**LED 是低电平点亮的**。复位值 4\'b1111 就是全灭。检查 Verilog 里有没有把 LED 初值写成 1111。',
      '检查 .cst 里 LED[0..3] 是不是 27/28/29/30（本板），别写成别的脚。',
      '检查时钟：CLK_50M 必须绑 pin98（IOR9[A]/GCLKT_2）。绑错脚 → 时钟不动 → 所有计数逻辑不动。',
      '看 gowin_report 的端口引脚表确认 CLK_50M 的 site 是 IOR9[A]。',
      '**不要**先去怀疑 RST_N —— 本板 RST_N=IO75=KEY1，没人按时被 10K 拉高，!RST_N 恒假，这**不是**复位没释放的问题（本工程曾在此误判）。',
      '把顶层改成"任何状态都恰好亮一颗灯"的流水灯（gowin_init 默认生成的就是这版）：全灭=配置失败，某颗常亮=时钟死，流水=正常。这样一次就能定位。',
    ],
  },
  gao_capture: {
    title: 'GAO 无头/半自动采集流程',
    steps: [
      '把 .gao（或 .rao）作为普通设计文件加进 .gprj 的 FileList（type="file.gao"）。',
      'gowin_build { task:"all" } —— 日志里会出现 `Generating Post-Synthesis GAO`，产物变成 impl\\pnr\\ao_0.fs。',
      'gowin_program { fsFile:"...\\ao_0.fs" } —— 必须先烧带 GAO 核的码流，否则界面一直显示 "Please program the device first"。',
      'gowin_gao { action:"launch" } —— 它已处理好 cwd=IDE\\bin 与 -series/-device 同给。',
      '界面里：TabItem 从 Configuration 切到 `core 0` → 状态变 "Ready to acquire" → 采集 → 导出到 impl\\wave\\。',
      '导出 CSV 是**可全自动的**；导出 VCD/GWD 需要人工点（Qt ComboBox 的已知限制）。',
      '校验数据：gowin-build\\gao\\verify_wave.ps1 -Csv <path> 逐行校验。',
    ],
  },
  wrong_pins: {
    title: '上板没反应 / 外设不工作',
    steps: [
      'gowin_board —— 拿本板权威引脚表。',
      'gowin_project —— 看当前 .cst 实际绑了什么，工具会把每个引脚标注「板上是什么」。',
      '常见错配：LED 绑到按键脚（都是 IO，但一个输出一个输入）、时钟没绑 98、UART TX/RX 弄反（IO12=发、IO15=收）。',
      'EEPROM 的 SDA(IO85) 是**双向**：Verilog 里必须 inout + 三态，写成纯输出读不到数据。',
      'IO93~96 既是外部 SPI Flash 又是**专用配置脚**：可以复用，但**别加 exclusive、别叠加冲突属性**。',
      'JTAG 的 IO13/14/16/18 是**专用脚**，不能当 GPIO（除非 set_option -use_jtag_as_gpio 1，代价是失去烧录与在线调试）。',
    ],
  },
  first_time: {
    title: '从零到上板（最短路径）',
    steps: [
      'gowin_env —— 确认安装根与三个入口程序。',
      'gowin_init { dir:"<你的目录>", name:"LED_Run" } —— 生成器件/约束/时序/顶层四件套。',
      'gowin_check —— 机械校验（器件码、文件、引脚冲突、电平）。',
      'gowin_build { task:"all" } —— 综合 + 布局布线 + 出码流。',
      'gowin_report —— 看资源、引脚、时序裕量。',
      'gowin_program —— 烧录（先 sram 快速验证，确认后用 flash 掉电保持）。',
      '看到流水灯就成了。四灯全灭走 `all_leds_off` 剧本。',
    ],
  },
};

const toolHelp = {
  name: 'gowin_help',
  description:
    `高云开发的**排错剧本与踩坑总清单**（${PITFALLS.length} 条，来自一次完整的「建模→编译→烧录→在线调试→波形导出」闭环）。` +
    '主题：build_failed（编译失败怎么查）/ all_leds_off（四灯全灭怎么查）/ gao_capture（GAO 采集流程）/ ' +
    'wrong_pins（上板没反应）/ first_time（从零到上板）。不带参数时给出工具地图与全部踩坑清单。',
  parameters: {
    topic: { type: 'string', enum: Object.keys(PLAYBOOKS), description: '要看哪个剧本' },
    pitfalls: { type: 'boolean', description: `true = 输出全部 ${PITFALLS.length} 条踩坑清单` },
    tag: { type: 'string', enum: ['env', 'build', 'cst', 'program', 'gao', 'board', 'report'], description: '只看某一类坑' },
  },
  output,
  async execute(args) {
    const parts = [];

    if (!args.topic) {
      parts.push('== dsh-gowin 工具地图 ==');
      const map = [
        ['gowin_env', '探测安装根/工具/License —— 第一步'],
        ['gowin_device', '本板器件名 ↔ 配置码 ↔ .gprj 写法'],
        ['gowin_board', '本板引脚/极性速查（可反查引脚号）'],
        ['gowin_project', '看工程全貌：文件表 + 引脚分配 + 时序约束 + 已有产物'],
        ['gowin_init', '生成可编译的工程骨架（默认不覆盖）'],
        ['gowin_cst', '生成板级正确的 .cst / 校验一份 .cst'],
        ['gowin_check', '**编译前**机械校验：引脚冲突、1.8V Bank、专用脚、文件缺失'],
        ['gowin_build', 'gw_sh 编译（syn/pnr/all），自动汇总错误与产物'],
        ['gowin_program', 'programmer_cli 烧录/扫描（判据看文本，不看退出码）'],
        ['gowin_report', '读 .rpt.txt/.timing_paths/cmd.do/device.cfg'],
        ['gowin_artifacts', '列 impl\\ 产物 + 指出要烧哪个文件'],
        ['gowin_tcl', '跑任意 TCL（命令加 -h 查权威用法）'],
        ['gowin_gao', 'GAO 定义/产物检查 + 启动采集界面'],
        ['gowin_docs', '官方 PDF 路标 + 已抽文本关键词搜索'],
        ['gowin_help', '本工具：排错剧本 + 踩坑清单'],
      ];
      for (const [n, d] of map) parts.push(`  ${n.padEnd(16)} ${d}`);
      parts.push(`\n可用剧本（给 topic）：${Object.keys(PLAYBOOKS).join(', ')}`);
    }

    if (args.topic) {
      const p = PLAYBOOKS[args.topic];
      if (!p) return { ok: false, message: `没有剧本 "${args.topic}"。可用：${Object.keys(PLAYBOOKS).join(', ')}` };
      parts.push(`== ${p.title} ==`);
      p.steps.forEach((s, i) => parts.push(`  ${i + 1}. ${s}`));
    }

    if (args.pitfalls || args.topic) {
      const list = args.tag ? PITFALLS.filter((p) => p[2] === args.tag) : PITFALLS;
      parts.push(`\n== 踩坑清单（${list.length}${args.tag ? ` / ${args.tag}` : ` / 共 ${PITFALLS.length}`}）==`);
      for (const [title, body, tag] of list) parts.push(`  • [${tag}] ${title}\n      ${body}`);
    }
    return { ok: true, message: parts.join('\n') };
  },
};

// ---------------------------------------------------------------- 源码模板

function LED_FLOW_SRC(name) {
  return `/**
 * ${name} —— 四灯流水灯（FG202 / GW1N-UV9LQ144，已上板验证）
 *
 * 设计要点（这版是**为了自诊断**才这么写的）：
 *   - 不依赖 RST_N：本板 RST_N = IO75 = KEY1，没人按时被 10K 拉高，上电不会产生复位脉冲。
 *   - LED 组合输出，且**任何 ph 取值都恰好亮一颗灯**：
 *       全灭  ⇒ 配置没成功（或 LED 极性写反）
 *       某颗常亮 ⇒ 时钟没进来（CLK_50M 没绑 pin98？）
 *       流水  ⇒ 一切正常
 *   - LED 低电平点亮：0 = 亮，1 = 灭。
 */
module ${name} (
    input  wire       CLK_50M,   // 50 MHz 有源晶振 → pin98 (IOR9[A]/GCLKT_2)
    output reg  [3:0] LED        // LED1..4 = IO27/28/29/30，低电平点亮
);

    // 半秒 = 50_000_000 / 2 - 1
    localparam [24:0] HALF_SEC = 25'd24_999_999;

    reg [24:0] cnt;
    reg [1:0]  ph;

    always @(posedge CLK_50M) begin
        if (cnt == HALF_SEC) cnt <= 25'd0;
        else                 cnt <= cnt + 25'd1;
    end

    always @(posedge CLK_50M) begin
        if (cnt == HALF_SEC) ph <= ph + 2'd1;
    end

    always @(*) begin
        case (ph)
            2'd0:    LED = 4'b1110;  // 只亮 LED1
            2'd1:    LED = 4'b1101;  // 只亮 LED2
            2'd2:    LED = 4'b1011;  // 只亮 LED3
            default: LED = 4'b0111;  // 只亮 LED4
        endcase
    end

endmodule
`;
}

function LED_BLINK_SRC(name) {
  return `/**
 * ${name} —— 四灯同步闪烁（最小可编译例子，FG202 / GW1N-UV9LQ144）
 * LED 低电平点亮：0 = 亮，1 = 灭。
 */
module ${name} (
    input  wire       CLK_50M,   // pin98
    output reg  [3:0] LED        // IO27/28/29/30
);

    localparam [24:0] HALF_SEC = 25'd24_999_999;

    reg [24:0] cnt;
    reg        on;

    always @(posedge CLK_50M) begin
        if (cnt == HALF_SEC) begin
            cnt <= 25'd0;
            on  <= ~on;
        end else begin
            cnt <= cnt + 25'd1;
        end
    end

    always @(*) LED = on ? 4'b0000 : 4'b1111;

endmodule
`;
}

// ---------------------------------------------------------------- 注册

const TOOL_LIST = [
  toolEnv,
  toolDevice,
  toolBoard,
  toolProject,
  toolInit,
  toolCst,
  toolCheck,
  toolBuild,
  toolProgram,
  toolReport,
  toolArtifacts,
  toolTcl,
  toolGao,
  toolDocs,
  toolHelp,
];

/** 把全部高云工具注册到 `ctx.tools`。返回供日志用的工具名列表。 */
export function registerGowinTools(ctx) {
  const names = [];
  for (const t of TOOL_LIST) {
    ctx.tools.register(
      defineTool({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: t.output ?? output,
        execute: t.execute,
      }),
    );
    names.push(t.name);
  }
  return names;
}

export { TOOL_LIST, OP_INDEX, OP_BY_INDEX, PITFALLS, PLAYBOOKS, locateGprj, loadProject, analyzeProgrammer, runProgrammer, LED_FLOW_SRC };
