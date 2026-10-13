/**
 * 解析布局布线产物 —— `.rpt.txt`（资源/引脚/时钟）、`.timing_paths`（时序）、`cmd.do`、`device.cfg`。
 *
 * 这些都是**纯文本**，格式已在实测工程里核对过（`gowin-build\07_LED_Flow`）：
 *
 * `.rpt.txt` 节标题固定为：
 *   1. PnR Messages         —— `<Device>` / `<Part Number>` / `<Tool Version>` / `<Timing Constraints File>`
 *   2. PnR Details          —— 各阶段耗时 + `Total Time and Memory Usage … Peak memory usage = 280MB`
 *   3. Resource Usage Summary —— `Logic | 48/8640 | <1%` 这种三列表
 *   4. I/O Bank Usage Summary
 *   5. Clock Resource Usage Summary
 *   6. Global Clock Signals  —— `Signal | Global Clock | Location`
 *   7. Pinout by Port Name   —— 第一列是**端口名**（未用脚是 `-`）
 *   8. All Package Pins      —— 第一列是 `<pin>/<bank>`（全是物理脚）
 *
 * ⚠️ 第 7 节里第一列为 `-` 的行是**未使用的物理脚**，不是端口，过滤掉。
 *
 * `.timing_paths` 不是表格，是**分块文本**：每块以 `====` 开头、含 `SETUP`/`HOLD`、
 * 路径名、起始延迟、结束延迟、Slack，末尾再一个 `====`：
 *   ====
 *   SETUP
 *   11.110        ← 路径自身延迟
 *   13.220        ← 起始时钟路径延迟
 *   24.330        ← 所需时间
 *   CLK_50M_ibuf  ← 起点
 *   0.000
 *   2.088
 *   cnt_15_s0     ← 途经点
 *   …
 *   ====
 * 与 `report.html` 里的 `WNS/TNS` 不同，这里给的是**逐个路径的 slack**。
 */

import { readFileSync } from 'node:fs';

function readText(path) {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/** 从 `.rpt.txt` 里切出第 N 节正文（标题形如 `3. Resource Usage Summary`）。 */
function section(text, n) {
  const re = new RegExp(`^\\s*${n}\\.\\s+(.+)$`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = new RegExp(`^\\s*${n + 1}\\.\\s+\\S`, 'm');
  const rest = text.slice(start);
  const m2 = next.exec(rest);
  return { title: m[1].trim(), body: (m2 ? rest.slice(0, m2.index) : rest).trim() };
}

/** 切出全部 `<n>. <Title>` 节标题。 */
function sectionTitles(text) {
  const out = [];
  for (const m of text.matchAll(/^\s*(\d+)\.\s+(.+?)\s*$/gm)) out.push({ n: Number(m[1]), title: m[2].trim() });
  return out;
}

/** 解析三列 `名称 | x/y | p%` 表。 */
function parseThreeCol(body) {
  const rows = [];
  if (!body) return rows;
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z][\w (),/\-–]*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (/^-+$/.test(name)) continue;
    rows.push({ name, usage: m[2].trim(), utilization: m[3].trim() });
  }
  return rows;
}

/** 解析两列 `名称 | 值 | 值` 或 `名称 | 值` 表（Global Clock / Bank）。 */
function parseColumns(body, expected) {
  const rows = [];
  if (!body) return rows;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || /^-+$/.test(t.replace(/\|/g, ''))) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length !== expected) continue;
    if (cells.every((c) => c === '')) continue;
    // 跳过表头行
    if (/^(Signal|Clock Resource|Port Name|bank)$/i.test(cells[0])) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * 解析 `<顶层>.rpt.txt`。
 *
 * @param {string} path
 */
export function parsePnrReport(path) {
  const text = readText(path);
  if (text === null) return { ok: false, message: `读不了 ${path}` };

  const header = {};
  for (const m of text.matchAll(/^\s*<([^>]+)>:\s*(.*?)\s*$/gm)) header[m[1].trim()] = m[2].trim();

  const mem = /Peak memory usage\s*=\s*(\S+)/i.exec(text);
  const total = /Total Time and Memory Usage:\s*CPU time\s*=\s*([^,]+),\s*Elapsed time\s*=\s*([^,]+)/i.exec(text);

  const sec3 = section(text, 3);
  const sec4 = section(text, 4);
  const sec5 = section(text, 5);
  const sec6 = section(text, 6);
  const sec7 = section(text, 7);
  const sec8 = section(text, 8);

  // ---- 端口表：只保留第一列是端口名（非 '-'）的行
  const ports = [];
  for (const cells of parseColumns(sec7?.body, 17)) {
    if (cells[0] === '-') continue;
    ports.push({
      name: cells[0],
      diffPair: cells[1],
      locBank: cells[2],
      constraint: cells[3],
      dir: cells[4],
      site: cells[5],
      cfg: cells[6],
      ioType: cells[7],
      drive: cells[8],
      pullMode: cells[9],
      bankVccio: cells[16],
    });
  }

  // ---- 物理脚表：第一列形如 `27/3`
  const packagePins = [];
  for (const cells of parseColumns(sec8?.body, 15)) {
    const m = /^(\d+)\/(\d+)$/.exec(cells[0]);
    if (!m) continue;
    packagePins.push({ pin: Number(m[1]), bank: Number(m[2]), dir: cells[2], site: cells[3], cfg: cells[4], ioType: cells[5], bankVccio: cells[14] });
  }

  const banks = [];
  for (const m of (sec4?.body ?? '').matchAll(/^\s*bank\s+(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/gim)) {
    banks.push({ bank: Number(m[1]), usage: m[2].trim(), utilization: m[3].trim() });
  }

  const clockResources = parseThreeCol(sec5?.body);
  const globalClocks = parseColumns(sec6?.body, 3).map((c) => ({ signal: c[0], kind: c[1], location: c[2] }));

  return {
    ok: true,
    path,
    sections: sectionTitles(text),
    header,
    device: header['Device'] ?? null,
    partNumber: header['Part Number'] ?? null,
    deviceVersion: header['Device Version'] ?? null,
    toolVersion: header['Tool Version'] ?? null,
    physicalConstraints: header['Physical Constraints File'] ?? null,
    timingConstraints: header['Timing Constraints File'] ?? null,
    peakMemory: mem ? mem[1] : null,
    elapsed: total ? total[2].trim() : null,
    resources: parseThreeCol(sec3?.body),
    banks,
    clockResources,
    globalClocks,
    ports,
    packagePins,
  };
}

/**
 * 解析 `<顶层>.timing_paths`。
 *
 * 返回 `{ok, paths: [{kind:'SETUP'|'HOLD', slack, values:number[], points:string[]}]}`。
 * `slack` 的第 3 个数值（每块最后一行数字）是**裕量**：正=满足，负=违规。
 */
export function parseTimingPaths(path) {
  const text = readText(path);
  if (text === null) return { ok: false, message: `读不了 ${path}` };
  const blocks = text.split(/^=+\s*$/m).map((b) => b.trim()).filter(Boolean);
  const paths = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 4) continue;
    const kind = /^(SETUP|HOLD)$/i.exec(lines[0])?.[1]?.toUpperCase();
    if (!kind) continue;
    const values = [];
    const points = [];
    for (const l of lines.slice(1)) {
      if (/^-?\d+(\.\d+)?$/.test(l)) values.push(Number(l));
      else points.push(l);
    }
    if (values.length < 3) continue;
    paths.push({ kind, values, points, slack: values[values.length - 1], start: points[0] ?? null, end: points[points.length - 1] ?? null });
  }
  const setup = paths.filter((p) => p.kind === 'SETUP');
  const hold = paths.filter((p) => p.kind === 'HOLD');
  const worst = (list) => (list.length ? list.reduce((a, b) => (a.slack < b.slack ? a : b)) : null);
  return {
    ok: true,
    path,
    paths,
    setupCount: setup.length,
    holdCount: hold.length,
    worstSetup: worst(setup),
    worstHold: worst(hold),
    setupViolations: setup.filter((p) => p.slack < 0).length,
    holdViolations: hold.filter((p) => p.slack < 0).length,
  };
}

/** 解析 `cmd.do`（布局布线的完整命令行，用来核对器件/约束文件/时钟频率）。 */
export function parseCmdDo(path) {
  const text = readText(path);
  if (text === null) return { ok: false, message: `读不了 ${path}` };
  const opts = {};
  const args = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^-(\S+)\s+(.*)$/.exec(t);
    if (m) opts[m[1]] = m[2].trim();
    else args.push(t);
    const flag = /^-(bit|tr|ph|timing|cst_error)$/.exec(t);
    if (flag) opts[flag[1]] = true;
  }
  return {
    ok: true,
    path,
    options: opts,
    device: opts.p ?? null,
    partNumber: opts.pn ?? null,
    cst: opts.cst ?? null,
    sdc: opts.sdc ?? null,
    netlist: opts.d ?? null,
    globalFreqMHz: opts.global_freq ? Number(opts.global_freq) : null,
  };
}

/** 解析 `device.cfg`（器件配置位，`set key = value` 逐行）。 */
export function parseDeviceCfg(path) {
  const text = readText(path);
  if (text === null) return { ok: false, message: `读不了 ${path}` };
  const settings = {};
  for (const line of text.split('\n')) {
    const m = /^set\s+(\S+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) settings[m[1]] = m[2].trim();
  }
  return {
    ok: true,
    path,
    settings,
    vcc: settings.vcc ?? null,
    vccx: settings.vccx ?? null,
    jtagAsGpio: settings['JTAG regular_io'] === 'true',
    unusedPin: settings.unused_pin ?? null,
    compress: settings.compress ?? null,
    encryption: settings.encryption ?? null,
  };
}

/** 汇总一次构建的全部报告，给 `gowin_report` 用。 */
export function summarizeBuild(gprj, { findPnrReport, findSynReport }) {
  const pnrPath = findPnrReport(gprj);
  const report = pnrPath ? parsePnrReport(pnrPath) : { ok: false, message: '没找到 impl\\pnr\\*.rpt.txt —— 布局布线可能没跑完' };
  return { report, synPath: findSynReport(gprj) };
}
