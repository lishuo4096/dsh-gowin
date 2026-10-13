/**
 * dsh-gowin 零依赖自测 —— 不装 DSH、不跑编译也能验。
 *
 *   node _selftest.mjs              # 纯函数 + 环境探测（快）
 *   node _selftest.mjs --build      # 额外跑一次真编译（慢，约 1-2 分钟）
 *
 * 设计原则：**断言打在实测资产上**。纯函数用真工程的 `.gprj` / `.cst` / `.sdc` 当输入，
 * 报告解析器用 `07_LED_Flow` 已编译出来的 `impl\` 产物当输入 —— 这样自测同时
 * 也是「解析器对真实格式是否还有效」的回归。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { DEVICE, PERIPHERALS, CLOCK, POWER, pinRole, cstSnippet, boardSummary, DEFAULT_IO_PORT } from './lib/board.js';
import { parseGprj, parseCst, parseSdc, groupFiles, renderGprj, renderCreateClock, portAttrsText } from './lib/gprj.js';
import { checkProject, checkCst } from './lib/check.js';
import { parsePnrReport, parseTimingPaths, parseCmdDo, parseDeviceCfg } from './lib/report.js';
import { analyzeOutput, cleanOutput, collectArtifacts, findPnrReport, findSynReport, runBuild } from './lib/build.js';
import { resolveGowinRoot, probeTools, licenseInfo, commandSpec, discoverRoots, TOOLS, FORBIDDEN } from './lib/env.js';
import { parseFrontmatter } from './lib/frontmatter.js';
import { createProvider, PROVIDER_NAME } from './lib/skills.js';
import { TOOL_LIST, OP_INDEX, OP_BY_INDEX, PITFALLS, PLAYBOOKS, locateGprj, registerGowinTools } from './lib/tools.js';

// ─────────────────────────────────────────── 迷你测试框架

let pass = 0;
const failures = [];
let group = '(root)';

/** 每个 describe 的回调（可 async）都收进队列，跑完再统一 await。 */
const pending = [];

function describe(name, fn) {
  pending.push({ name, run: fn });
}
function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(`${group} → ${label}${extra === undefined ? '' : `  [${JSON.stringify(extra)}]`}`);
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra === undefined ? '' : `  got ${JSON.stringify(extra)}`}`);
  }
}
const eq = (actual, expected, label) => ok(Object.is(actual, expected), `${label} = ${JSON.stringify(expected)}`, actual);
const has = (haystack, needle, label) => {
  const s = Array.isArray(haystack) ? JSON.stringify(haystack) : String(haystack ?? '');
  ok(s.includes(needle), `${label} 含 ${JSON.stringify(needle)}`, s.slice(0, 240));
};
const anyFinding = (findings, re) => findings.filter((f) => re.test(`${f.code ?? ''} ${f.message ?? ''}`));

// ─────────────────────────────────────────── 夹具

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(HERE, '..');
const GOWIN_BUILD = join(WORKSPACE, 'gowin-build');
const FIXTURE = join(GOWIN_BUILD, '07_LED_Flow'); // 编过、上过板、带 GAO 的工程
const FIXTURE_GPRJ = join(FIXTURE, 'LED_Run', 'LED_Run.gprj');
const FIXTURE_ROOT = dirname(FIXTURE_GPRJ);
const FIXTURE_PNR = join(FIXTURE_ROOT, 'impl', 'pnr', 'LED_Run');
const HAVE_FIXTURE = existsSync(FIXTURE_GPRJ);
const HAVE_PNR = existsSync(`${FIXTURE_PNR}.rpt.txt`);

console.log('dsh-gowin 自测');
console.log(`  插件目录: ${HERE}`);
console.log(`  实测夹具: ${HAVE_FIXTURE ? FIXTURE : '（缺失，跳过依赖夹具的断言）'}`);
console.log(`  pnr 产物: ${HAVE_PNR ? '有' : '（缺失，跳过报告解析断言）'}`);

/** 读文件文本（夹具用）；读不动返回 null 而不是抛。 */
const readFile = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

// ─────────────────────────────────────────── 1. 板级事实

describe('1. 板级事实（FG202 / GW1N-UV9LQ144）', () => {
  eq(DEVICE.name, 'GW1N-9C', 'DEVICE.name');
  eq(DEVICE.pn, 'GW1N-UV9LQ144C6/I5', 'DEVICE.pn（.gprj 的 pn 属性）');
  eq(DEVICE.configCode, 'gw1n9c-019', 'DEVICE.configCode（<Device> 的元素文本）');
  eq(DEVICE.deviceVersion, 'C', 'DEVICE.deviceVersion');
  eq(DEVICE.package, 'LQFP144', 'DEVICE.package');
  eq(DEVICE.bankVccio, 3.3, 'DEVICE.bankVccio');

  // LED：低电平点亮，且引脚顺序必须逐颗对上（check.js 靠这个顺序判「绑错脚」）
  const ledPins = PERIPHERALS.led.items.map((p) => p.pin);
  eq(ledPins.join(','), '27,28,29,30', 'LED 引脚序 IO27/28/29/30');
  eq(PERIPHERALS.led.polarity, 'low', 'LED 低电平有效');
  eq(PERIPHERALS.led.activeLow, true, 'LED activeLow');
  has(PERIPHERALS.led.hardware, '0 = 亮', 'LED 极性说明写了「0 = 亮」');
  has(PERIPHERALS.led.warning, '全灭', 'LED 警告里记了「全灭」这个坑');
  has(PERIPHERALS.led.warning, 'POWER', 'LED 警告里提醒丝印 POWER 的灯不受控');

  // 按键：按下=0，RST_N 就是 KEY1 所在的 IO75 —— 这是踩过的坑，必须写死在数据里
  eq(PERIPHERALS.key.items.map((p) => p.pin).join(','), '75,76,97,99', '按键引脚序');
  eq(PERIPHERALS.key.polarity, 'low', '按键按下为 0');
  eq(PERIPHERALS.key.resetPin, 75, 'RST_N 复用 IO75（不是复位芯片）');
  has(PERIPHERALS.key.warning, '没有专用复位芯片', '按键警告里写清没有复位芯片');

  // 时钟：只有一颗 50 MHz 晶振，pin98 = IOR9[A]/GCLKT_2
  eq(CLOCK.freqMHz, 50, 'CLOCK.freqMHz');
  eq(CLOCK.periodNs, 20, 'CLOCK.periodNs');
  eq(CLOCK.pin, 98, 'CLOCK.pin');
  eq(CLOCK.name, 'CLK_50M', 'CLOCK.name');
  eq(CLOCK.single, true, 'CLOCK.single（板上无第二晶振）');
  has(CLOCK.note, 'GCLKT', '时钟说明写出专用脚名');

  // 外设引脚（原厂 03/04/06 例程的 .cst 写 1.8V —— 本板是 3.3V）
  eq(PERIPHERALS.uart.items[0].pin, 12, 'UART FPGA 发送 = IO12');
  eq(PERIPHERALS.uart.items[1].pin, 15, 'UART FPGA 接收 = IO15');
  const eepromPins = Object.fromEntries(PERIPHERALS.eeprom.items.map((i) => [i.signal, i.pin]));
  eq(eepromPins.SCL, 86, 'EEPROM SCL = IO86');
  eq(eepromPins.SDA, 85, 'EEPROM SDA = IO85');
  eq(PERIPHERALS.eeprom.bidirectional, true, 'EEPROM SDA 是双向');
  const flashPins = Object.fromEntries(PERIPHERALS.spiFlash.items.map((i) => [i.signal, i.pin]));
  eq(flashPins['MCLK/WDCLK'], 93, 'SPI Flash CLK = IO93');
  eq(flashPins['MCS_N/MCS0N'], 94, 'SPI Flash CS = IO94');
  eq(flashPins['MO/WASDO'], 95, 'SPI Flash MOSI = IO95');
  eq(flashPins['MI/WDATA0'], 96, 'SPI Flash MISO = IO96');
  eq(PERIPHERALS.spiFlash.dedicatedConfigPins, true, 'SPI Flash 兼配置脚');
  has(PERIPHERALS.spiFlash.warning, 'exclusive', 'SPI Flash 警告里写了别加 exclusive');
  eq(PERIPHERALS.jtag.items.map((p) => p.pin).join(','), '13,14,16,18', 'JTAG 引脚 13/14/16/18');
  eq(PERIPHERALS.config.items[0].pin, 20, 'nCONFIG = pin20');

  has(POWER.banks, 'D3V3', 'POWER 记录 Bank 接 D3V3');
  has(DEFAULT_IO_PORT, 'LVCMOS33', '默认 IO_PORT 是 LVCMOS33');
  has(DEFAULT_IO_PORT, 'BANK_VCCIO=3.3', '默认 IO_PORT Bank 3.3V');

  // pinRole 反查（check.js 的板级规则全靠它）
  eq(pinRole(27)[0].role, 'led', 'pinRole(27) 认 LED');
  eq(pinRole(27)[0].activeLow, true, 'pinRole(27) 带 activeLow');
  eq(pinRole(75)[0].role, 'key', 'pinRole(75) 认按键');
  eq(pinRole(98)[0].role, 'clock', 'pinRole(98) 认时钟');
  eq(pinRole(13)[0].role, 'jtag', 'pinRole(13) 认 JTAG');
  eq(pinRole(13)[0].dedicated, true, 'pinRole(13) 标 dedicated');
  eq(pinRole(93)[0].dedicatedConfigPin, true, 'pinRole(93) 标专用配置脚');
  eq(pinRole(85)[0].bidirectional, true, 'pinRole(85) 标双向');
  eq(pinRole(9999).length, 0, 'pinRole(未知脚) = 空数组');

  // .cst 片段：生成的文本要能被自家 parseCst 读回（往返一致）
  const snippet = cstSnippet(['clk', 'led']);
  const back = parseCst(snippet);
  eq(back.locs.length, 5, 'cstSnippet(clk+led) 产 5 条 IO_LOC');
  eq(back.ports.length, 5, 'cstSnippet(clk+led) 产 5 条 IO_PORT');
  eq(back.locs.find((l) => l.name === 'CLK_50M')?.pin, 98, 'CLK_50M → pin98');
  eq(back.locs.find((l) => l.name === 'LED[0]')?.pin, 27, 'LED[0] → IO27');
  eq(back.locs.find((l) => l.name === 'LED[3]')?.pin, 30, 'LED[3] → IO30');
  eq(back.locs.find((l) => l.name === 'CLK_50M')?.flags, 'exclusive', '时钟脚带 exclusive');
  eq(back.ports.find((p) => p.name === 'CLK_50M')?.attrs.BANK_VCCIO, '3.3', '时钟 IO_PORT 写 3.3V');
  eq(back.ports.find((p) => p.name === 'LED[0]')?.attrs.DRIVE, '8', 'LED IO_PORT 写 DRIVE=8');
  eq(back.errors.length, 0, 'cstSnippet 无解析错误');

  const summary = boardSummary();
  ok(Array.isArray(summary), 'boardSummary() 返回数组');
  eq(summary.length, Object.keys(PERIPHERALS).length, 'boardSummary 覆盖全部外设');
  const ledRow = summary.find((r) => r.key === 'led');
  eq(ledRow.pins, '27, 28, 29, 30', 'boardSummary 的 LED 行给出引脚');
  eq(ledRow.polarity, 'low', 'boardSummary 的 LED 行给出极性');
  ok(summary.every((r) => r.label && r.pins !== undefined), 'boardSummary 每行都有 label 与 pins');
});

// ─────────────────────────────────────────── 2. 工程 / 约束解析

describe('2. .gprj / .cst / .sdc 解析（真实工程）', () => {
  if (!HAVE_FIXTURE) {
    console.log('  （跳过：夹具缺失）');
    return;
  }
  const parsed = parseGprj(FIXTURE_GPRJ);
  eq(parsed.ok, true, 'parseGprj ok');
  eq(parsed.device.name, 'GW1N-9C', 'gprj 器件名');
  eq(parsed.device.pn, 'GW1N-UV9LQ144C6/I5', 'gprj pn');
  eq(parsed.device.configCode, 'gw1n9c-019', 'gprj 配置码（元素文本）');
  ok(parsed.files.length >= 3, `gprj 文件数 ≥ 3（实际 ${parsed.files.length}）`, parsed.files.length);
  ok(parsed.files.every((f) => f.exists), 'FileList 里全部文件都真实存在');
  ok(parsed.files.every((f) => /^file\./.test(String(f.type))), '每个文件都有 file.* 类型');

  const groups = groupFiles(parsed);
  ok(groups.verilog.length >= 1, `识别出 verilog 源（${groups.verilog.length}）`);
  ok(groups.cst.length >= 1, `识别出 .cst（${groups.cst.length}）`);
  ok(groups.sdc.length >= 1, `识别出 .sdc（${groups.sdc.length}）`);
  console.log(
    `  文件表: ${parsed.files.map((f) => `${f.path}[${f.type.replace('file.', '')}]`).join('  ')}`,
  );

  // 渲染回来的 .gprj 必须还能被自己解析（往返一致 —— 保证 gowin_init 不会写出坏工程）
  const rendered = renderGprj({
    deviceName: DEVICE.name,
    pn: DEVICE.pn,
    configCode: DEVICE.configCode,
    files: parsed.files.map((f) => ({ path: f.path, type: f.type, enable: f.enable })),
  });
  has(rendered, 'GW1N-9C', 'renderGprj 写出器件名');
  has(rendered, 'GW1N-UV9LQ144C6/I5', 'renderGprj 写出 pn');
  has(rendered, 'gw1n9c-019', 'renderGprj 写出配置码');
  const reparsed = parseGprj2(rendered);
  eq(reparsed.device.name, 'GW1N-9C', 'renderGprj 产物可被解析回器件名');
  eq(reparsed.device.configCode, 'gw1n9c-019', 'renderGprj 产物配置码往返一致');
  eq(reparsed.files.length, parsed.files.length, 'renderGprj 产物文件数往返一致');

  // .cst（parseCst 吃文本，不吃路径）
  const cstFile = groups.cst[0];
  const cstText = readFile(cstFile.abs);
  ok(cstText !== null, `读得到 ${cstFile.path}`);
  const cst = parseCst(cstText);
  eq(cst.errors.length, 0, '真实 .cst 解析无错误');
  const locNames = cst.locs.map((l) => l.name);
  ok(locNames.includes('CLK_50M'), `cst 里有 CLK_50M（实际: ${locNames.join(',')}）`);
  ok(locNames.some((n) => /^LED/.test(n)), 'cst 里有 LED 端口');
  const oneEight = cst.ports.filter((p) => String(p.attrs.BANK_VCCIO) === '1.8');
  eq(oneEight.length, 0, '本板 .cst 不应有 BANK_VCCIO=1.8');
  const clkLoc = cst.locs.find((l) => l.name === 'CLK_50M');
  eq(clkLoc.pin, 98, '真实 .cst 里 CLK_50M 绑 pin98');

  // .sdc（parseSdc 也吃文本）
  const sdcFile = groups.sdc[0];
  const sdc = parseSdc(readFile(sdcFile.abs));
  const clk = sdc.clocks.find((c) => c.name === 'CLK_50M');
  ok(clk, `sdc 里有 CLK_50M（${JSON.stringify(sdc.clocks)}）`);
  eq(clk?.period, 20, 'sdc 时钟周期 20 ns');

  has(renderCreateClock({ name: 'CLK_50M', periodNs: 20 }), 'create_clock', 'renderCreateClock 产 create_clock');
  has(renderCreateClock({ name: 'CLK_50M', periodNs: 20 }), '-period 20', 'renderCreateClock 带周期 20');
  has(renderCreateClock({ name: 'CLK_50M', periodNs: 20 }), 'get_ports {CLK_50M}', 'renderCreateClock 带 get_ports');
  eq(parseSdc(renderCreateClock({ name: 'X', periodNs: 25 })).clocks[0].period, 25, 'renderCreateClock 往返一致');
});

/** 不带文件系统地把 `.gprj` 文本解析回来（复用一个临时文件，保证走同一条代码路径）。 */
function parseGprj2(text) {
  const tmp = join(HERE, `.selftest-tmp.gprj`);
  try {
    writeFileSync(tmp, text, 'utf8');
    const r = parseGprj(tmp);
    unlinkSync(tmp);
    return r;
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

// ─────────────────────────────────────────── 3. 机械校验

describe('3. gowin_check 机械校验（能抓真问题）', () => {
  if (!HAVE_FIXTURE) {
    console.log('  （跳过：夹具缺失）');
    return;
  }
  const parsed = parseGprj(FIXTURE_GPRJ);
  const groups = groupFiles(parsed);
  const cst = parseCst(readFile(groups.cst[0].abs));

  const good = checkProject(parsed, { cst, cstPath: groups.cst[0].abs });
  eq(good.findings.filter((f) => f.sev === 'E').length, 0, `真实工程 E（error）级发现 = 0（实际: ${good.findings.filter((f) => f.sev === 'E').map((f) => f.code).join(',')}）`);
  eq(good.summary.E, 0, 'summary.E = 0');
  ok(good.tops.length >= 1, `能猜出顶层模块（${good.tops.map((t) => t.name).join(',')}）`);
  eq(good.tops.some((t) => /LED_Run/i.test(t.name)), true, '顶层是 LED_Run');
  console.log(`  真实工程发现项: ${good.findings.map((f) => `${f.sev}/${f.code}`).join(' ') || '（无）'}`);

  // 造坏约束，逐条验证抓得住
  const bad = parseCst(
    [
      'IO_LOC "A" 27 exclusive;',
      'IO_PORT "A" IO_TYPE=LVCMOS33 BANK_VCCIO=1.8;', // ① 电压错
      'IO_LOC "B" 27 exclusive;', // ② 与 A 抢同一个脚
      'IO_PORT "B" IO_TYPE=LVCMOS33 BANK_VCCIO=3.3;',
      'IO_LOC "TMS" 13 exclusive;', // ③ JTAG 专用脚当 GPIO
      'IO_PORT "TMS" IO_TYPE=LVCMOS33 BANK_VCCIO=3.3;',
      'IO_LOC "CLK" 12 exclusive;', // ④ 时钟名绑到 IO12
      'IO_PORT "CLK" IO_TYPE=LVCMOS33 BANK_VCCIO=3.3;',
      'IO_LOC "LED[2]" 27 exclusive;', // ⑤ LED[2] 应在 IO29
      'IO_PORT "LED[2]" IO_TYPE=LVCMOS33 BANK_VCCIO=3.3;',
      'IO_PORT "ORPHAN" IO_TYPE=LVCMOS33;', // ⑥ 有 IO_PORT 没 IO_LOC
      'IO_LOC "SPI_CLK" 93 exclusive;', // ⑦ 配置脚加 exclusive
      'IO_PORT "SPI_CLK" IO_TYPE=LVCMOS33;',
    ].join('\n'),
  );
  const findings = checkCst(bad, 'fake.cst', null);
  const codes = findings.map((f) => f.code);

  ok(codes.includes('PIN-DOUBLE-BOUND'), `抓到引脚冲突 PIN-DOUBLE-BOUND`, codes);
  ok(codes.includes('BANK-VCCIO-MISMATCH'), '抓到 Bank 电压与本板 3.3V 不符', codes);
  ok(codes.includes('PIN-DEDICATED-JTAG'), '抓到 JTAG 专用脚被当 GPIO', codes);
  ok(codes.includes('CLOCK-WRONG-PIN'), '抓到时钟绑错脚', codes);
  ok(codes.includes('LED-WRONG-PIN'), '抓到 LED 绑错脚', codes);
  ok(codes.includes('PORT-WITHOUT-LOC'), '抓到有 IO_PORT 没 IO_LOC', codes);
  ok(codes.includes('EXCLUSIVE-ON-CONFIG-PIN'), '抓到在专用配置脚上加 exclusive', codes);
  ok(findings.every((f) => ['E', 'W', 'I'].includes(f.sev)), '发现项分级只用 E/W/I');
  ok(findings.some((f) => f.evidence && /L\d+:/.test(f.evidence)), '发现项带行号证据');
  ok(findings.some((f) => f.sev === 'E'), '分级里确实有 E 级（引脚冲突）');

  // 反向：干净约束不该报这些
  const cleanText = cstSnippet(['clk', 'led', 'key', 'uart']);
  const clean = checkCst(parseCst(cleanText), 'clean.cst', parsed);
  const cleanCodes = clean.map((f) => f.code);
  for (const c of ['PIN-DOUBLE-BOUND', 'BANK-VCCIO-MISMATCH', 'CLOCK-WRONG-PIN', 'LED-WRONG-PIN', 'KEY-WRONG-PIN', 'UART-TX-WRONG-PIN', 'UART-RX-WRONG-PIN']) {
    ok(!cleanCodes.includes(c), `干净 cstSnippet 不报 ${c}`);
  }
  console.log(`  干净片段发现项: ${cleanCodes.join(' ') || '（无）'}`);

  // 器件配置码写错必须报 E
  const wrongDevice = checkProject({ ...parsed, device: { ...parsed.device, configCode: 'gw1n9-026' } }, {});
  eq(anyFinding(wrongDevice.findings, /DEVICE-CODE-MISMATCH/).length, 1, '抓到器件名与配置码不匹配');

  // 没接 .cst 时应降级为 W 提示，而不是崩
  const noCst = checkProject({ ...parsed, files: parsed.files.map((f) => (f.type === 'file.cst' ? { ...f, enable: false } : f)) }, {});
  eq(noCst.findings.filter((f) => f.sev === 'E').length, 0, '无启用 .cst 时不报 E');
  eq(anyFinding(noCst.findings, /NO-CST/).length, 1, '无启用 .cst 时报 NO-CST');
});

// ─────────────────────────────────────────── 4. 报告解析

describe('4. pnr 报告 / timing_paths / cmd.do / device.cfg 解析', () => {
  if (!HAVE_PNR) {
    console.log('  （跳过：07_LED_Flow 尚未编译，无 impl 产物）');
    return;
  }
  const rpt = parsePnrReport(`${FIXTURE_PNR}.rpt.txt`);
  eq(rpt.ok, true, 'parsePnrReport ok');
  // 这个例程是按 GW1N-9 编的（07_LED_Flow 用的是 GW1N-9 / gw1n9-026 那一组）
  eq(rpt.device, 'GW1N-9', 'rpt <Device>');
  eq(rpt.partNumber, 'GW1N-UV9LQ144C6/I5', 'rpt <Part Number>');
  has(rpt.toolVersion, '1.9.', 'rpt <Tool Version> 是 1.9.x');
  ok(rpt.sections.length >= 8, `rpt 节数 ≥ 8（实际 ${rpt.sections.length}）`, rpt.sections.map((s) => `${s.n}.${s.title}`));
  has(rpt.sections[2].title, 'Resource Usage', '第 3 节是 Resource Usage Summary');

  const logic = rpt.resources.find((r) => /^Logic$/i.test(r.name));
  ok(logic, `资源表里有 Logic（${rpt.resources.map((r) => r.name).join(' | ')}）`);
  ok(/^\d+\/8640$/.test(logic.usage), `Logic 用量形如 n/8640（实际 ${logic.usage}）`, logic.usage);
  const reg = rpt.resources.find((r) => /^Register$/i.test(r.name));
  ok(/^\d+\/6843$/.test(reg?.usage ?? ''), `Register 用量形如 n/6843（实际 ${reg?.usage}）`, reg?.usage);

  eq(rpt.banks.length, 4, `4 个 Bank（实际 ${rpt.banks.length}）`);
  ok(rpt.globalClocks.length >= 1, `Global Clock 非空（${JSON.stringify(rpt.globalClocks)}）`);

  const names = rpt.ports.map((p) => p.name);
  ok(names.includes('CLK_50M'), `端口表含 CLK_50M（${names.join(',')}）`);
  eq(names.filter((n) => n === '-').length, 0, '端口表已过滤未用物理脚（无 "-" 行）');
  ok(rpt.ports.find((p) => /^LED/.test(p.name)), '端口表含 LED 端口');
  ok(rpt.packagePins.length > 0, `物理脚表非空（${rpt.packagePins.length} 脚）`);
  eq(rpt.packagePins.filter((p) => p.pin === 98).length, 1, '物理脚表里有 pin98');
  ok(rpt.peakMemory, `解析到峰值内存（${rpt.peakMemory}）`);
  ok(rpt.ports.every((p) => p.locBank && p.ioType !== undefined), '每个端口都有 locBank 与 ioType');

  // timing_paths
  const tp = parseTimingPaths(`${FIXTURE_PNR}.timing_paths`);
  eq(tp.ok, true, 'parseTimingPaths ok');
  ok(tp.setupCount > 0, `SETUP 路径数 > 0（实际 ${tp.setupCount}）`);
  eq(tp.setupViolations, 0, 'SETUP 违规 0');
  eq(tp.holdViolations, 0, 'HOLD 违规 0');
  ok(tp.worstSetup && tp.worstSetup.slack >= 0, `最差 SETUP slack ≥ 0（实际 ${tp.worstSetup?.slack}）`);
  has(tp.worstSetup?.start ?? '', 'CLK_50M', '最差路径起点是 CLK_50M');
  eq(tp.paths.length, tp.setupCount + tp.holdCount, 'paths 数 = SETUP + HOLD');

  // cmd.do
  const pnrDir = dirname(`${FIXTURE_PNR}.rpt.txt`);
  const cmd = parseCmdDo(join(pnrDir, 'cmd.do'));
  eq(cmd.ok, true, 'parseCmdDo ok');
  eq(cmd.device, 'GW1N-9C-LQFP144-6', 'cmd.do -p');
  eq(cmd.partNumber, 'GW1N-UV9LQ144C6/I5', 'cmd.do -pn');
  eq(cmd.globalFreqMHz, 50, 'cmd.do -global_freq = 50');
  has(cmd.cst, 'LED_Run.cst', 'cmd.do -cst 指向工程 .cst');
  has(cmd.sdc, '.sdc', 'cmd.do -sdc 存在');
  has(cmd.netlist, '.vg', 'cmd.do -d 指向综合网表');

  // device.cfg
  const cfg = parseDeviceCfg(join(pnrDir, 'device.cfg'));
  eq(cfg.ok, true, 'parseDeviceCfg ok');
  eq(cfg.vcc, '3.3', 'device.cfg vcc');
  eq(cfg.vccx, '3.3', 'device.cfg vccx');
  eq(cfg.jtagAsGpio, false, 'device.cfg JTAG regular_io = false（JTAG 没被当 GPIO）');
  eq(cfg.unusedPin, 'default', 'device.cfg unused_pin');
});

// ─────────────────────────────────────────── 5. 产物与判据

describe('5. 产物收集与编译判据', () => {
  if (HAVE_FIXTURE) {
    const arts = collectArtifacts(FIXTURE_GPRJ); // 收 .gprj 路径，不是 parsed 对象
    eq(arts.implExists, true, 'collectArtifacts 找到 impl\\');
    eq(arts.topName, 'LED_Run', '从 .fs 名推出顶层名');
    eq(arts.hasGaoBitstream, false, '这个工程没挂 .gao，所以没有 ao_0.fs');
    const bits = arts.bitstreams.map((b) => b.name);
    const reps = arts.reports.map((r) => r.name);
    const syn = arts.synthesis.map((s) => s.name);
    ok(bits.includes('LED_Run.fs'), `impl 里有 LED_Run.fs（${bits.join(',')}）`);
    ok(bits.includes('LED_Run.bin'), 'impl 里有 .bin');
    ok(bits.includes('LED_Run.binx'), 'impl 里有 .binx');
    ok(bits.every((b) => !/^ao_\d+/.test(b)), '没挂 .gao 时不应有 ao_*.fs');
    ok(reps.includes('LED_Run.rpt.txt'), `impl 里有 .rpt.txt（${reps.join(',')}）`);
    ok(reps.includes('LED_Run.pin.html'), 'impl 里有引脚报告 .pin.html');
    ok(reps.includes('LED_Run.timing_paths'), 'impl 里有 .timing_paths');
    ok(syn.some((n) => /_syn\.rpt\.html$/.test(n)), 'impl 里有综合报告 _syn.rpt.html');
    ok(syn.some((n) => /\.vg$/.test(n)), 'impl 里有综合网表 .vg');
    ok([...arts.bitstreams, ...arts.reports, ...arts.synthesis].every((i) => i.size > 0 && i.path), '每个产物都有 path 与 size');
    eq(findPnrReport(FIXTURE_GPRJ)?.replace(/.*[\\/]/, ''), 'LED_Run.rpt.txt', 'findPnrReport 找到 LED_Run.rpt.txt');
    ok(findSynReport(FIXTURE_GPRJ) !== null, 'findSynReport 非空');
  } else {
    console.log('  （跳过：夹具缺失）');
  }

  // ★ 核心判据：成功 = exit 0 且出现 .fs；stderr 的 alog 噪声不能算失败
  const alog = 'ERROR: alog error: failed to open log file\n';
  const good = analyzeOutput('GowinSynthesis\nFinished.\n', alog, 0, { fsFiles: ['x.fs'] });
  eq(good.ok, true, 'exit 0 + alog 噪声 + 有 .fs → 判成功');
  eq(analyzeOutput('Finished.\n', '', 0, { fsFiles: [] }).ok, false, 'exit 0 但没有 .fs → 判失败');
  const err = analyzeOutput('something\nERROR: cannot open file top.v\n', '', 0, { fsFiles: [] });
  eq(err.ok, false, '有 ERROR 行 → 判失败');
  ok(err.errors.some((e) => /cannot open file top\.v/.test(e)), '错误行被提取出来', err.errors);
  eq(analyzeOutput('Finished.\n', alog, 0, { fsFiles: ['a.fs'] }).ok, true, '只有 alog 噪声时仍判成功');
  eq(cleanOutput(alog + 'real line\n').includes('alog error'), false, 'cleanOutput 滤掉 alog 噪声');
  eq(cleanOutput(alog + 'real line\n').includes('real line'), true, 'cleanOutput 保留正常行');
  eq(analyzeOutput('', '', 0, { fsFiles: ['a.fs'], timedOut: true }).ok, false, '超时 → 判失败');
  const warn = analyzeOutput('WARN (TA1132): CLK_50M was determined to be a clock but was not created\nFinished.\n', '', 0, { fsFiles: ['a.fs'] });
  eq(warn.ok, true, 'TA1132 只是 WARN，不影响成功判定');
  ok(warn.warnings.some((w) => /TA1132/.test(w)), 'WARN 行被单独收集', warn.warnings);
});

// ─────────────────────────────────────────── 6. 环境探测

describe('6. 环境探测（多版本安装容错）', () => {
  const roots = discoverRoots();
  console.log(`  发现安装根: ${roots.length ? roots.map((r) => `${r.root}${r.hasGwSh ? '' : '(无 gw_sh)'}`).join(' , ') : '（无）'}`);
  ok(Array.isArray(roots), 'discoverRoots 返回数组');
  if (roots.length === 0) {
    console.log('  （本机没装高云，跳过后面的环境断言）');
    return;
  }
  const usable = roots.filter((r) => r.hasGwSh);
  ok(usable.length >= 1, `至少一个安装含 gw_sh.exe（${usable.length}）`);

  const picked = resolveGowinRoot({});
  ok(picked.root !== null, `resolveGowinRoot 选到根（${picked.root}）`);
  has(picked.reason, picked.root ?? '', 'resolveGowinRoot 给出理由');
  eq(usable.some((r) => r.root === picked.root), true, '选中的根确实是可用安装之一');
  eq(resolveGowinRoot({ gowinRoot: roots[0].root }).root, roots[0].root, '显式 gowinRoot 优先');

  const probe = probeTools(picked.root);
  ok(Array.isArray(probe), 'probeTools 返回数组');
  const byTool = Object.fromEntries(probe.map((r) => [r.tool, r]));
  for (const t of ['gw_sh', 'programmer_cli', 'gao_analyzer', 'GowinSynthesis', 'floorplanner', 'gvio_analyzer']) {
    eq(byTool[t]?.exists, true, `${t}.exe 存在`);
  }
  eq(Object.keys(TOOLS).length, probe.length, 'probeTools 覆盖 TOOLS 全部条目');

  const lic = licenseInfo(picked.root);
  eq(lic.ok, true, `License 有效（${lic.licenses.join(', ')}）`);
  eq(lic.iniExists, true, 'gwlicense.ini 存在');

  // 命令封装：gao_analyzer 的 cwd 必须是 IDE\bin
  const spec = commandSpec({ root: picked.root, tool: 'gw_sh' });
  eq(spec.ok, true, 'commandSpec(gw_sh) ok');
  has(spec.exe, 'gw_sh.exe', 'spec.exe 指向 gw_sh.exe');
  eq(spec.env.GOWIN_HOME, picked.root, 'spec 注入 GOWIN_HOME');
  has(spec.env.PATH, join(picked.root, 'IDE', 'bin'), 'spec 把 IDE\\bin 放进 PATH');
  has(spec.env.PATH, join(picked.root, 'Programmer', 'bin'), 'spec 把 Programmer\\bin 放进 PATH');
  const gaoSpec = commandSpec({ root: picked.root, tool: 'gao_analyzer' });
  const cwdNorm = gaoSpec.cwd.replace(/\//g, '\\').toLowerCase();
  eq(cwdNorm.endsWith('ide\\bin'), true, `gao_analyzer cwd 必须是 IDE\\bin（${gaoSpec.cwd}）`);
  eq(gaoSpec.mustCwd, 'IDE\\bin', 'gao_analyzer mustCwd 标注出来');
  has(commandSpec({ root: picked.root, tool: 'gao_sh' }).message, '挂死', 'gao_sh 直接被拦下并说明原因');

  // 禁用清单：这三个入口绝不能被执行
  for (const k of ['gw_ide', 'gao_sh', 'programmer']) {
    eq(typeof FORBIDDEN[k], 'string', `${k} 在禁用清单里`);
    const s = commandSpec({ root: picked.root, tool: k });
    eq(s.ok, false, `commandSpec(${k}) 被拦下`);
  }
  has(FORBIDDEN.gao_sh, '挂死', 'gao_sh 的禁用理由记的是「会挂死」');
  has(FORBIDDEN.gw_ide, 'GUI', 'gw_ide 的禁用理由记的是 GUI');
  eq(commandSpec({ root: picked.root, tool: 'no_such_tool' }).ok, false, '未知工具被拒绝');
  eq(commandSpec({ root: null, tool: 'gw_sh' }).ok, false, '没有安装根时被拒绝');
});

// ─────────────────────────────────────────── 7. 工具注册面

describe('7. 工具注册面', () => {
  eq(TOOL_LIST.length, 15, 'TOOL_LIST 长度 = 15');
  const names = TOOL_LIST.map((t) => t.name);
  for (const n of names) ok(/^gowin_[a-z]+$/.test(n), `工具名合规: ${n}`);
  eq(new Set(names).size, names.length, '无重名工具');
  console.log(`  工具: ${names.join(', ')}`);

  for (const t of TOOL_LIST) {
    ok(typeof t.description === 'string' && t.description.length > 40, `${t.name} 有像样的 description（${t.description.length} 字符）`);
    ok(t.parameters && typeof t.parameters === 'object', `${t.name} 有 parameters`);
    ok(typeof t.execute === 'function', `${t.name} 有 execute`);
  }

  // 描述里必须带坑，否则模型会绕开工具自己去踩
  const byName = Object.fromEntries(TOOL_LIST.map((t) => [t.name, t]));
  has(byName.gowin_build.description, 'fs', 'gowin_build 说明里提到 .fs 判据');
  has(byName.gowin_program.description, '退出码', 'gowin_program 说明里警告退出码不可靠');
  has(byName.gowin_gao.description, 'ao_0', 'gowin_gao 说明里提到 ao_0.fs');
  has(byName.gowin_check.description, '1.8', 'gowin_check 说明里点出 1.8 V 这个抄错电压的坑');
  has(byName.gowin_check.description, 'JTAG', 'gowin_check 说明里提到专用 JTAG 脚');
  has(byName.gowin_env.description, 'GOWIN_HOME', 'gowin_env 说明里提到 GOWIN_HOME');

  // 假装一个 ctx，验证 registerGowinTools 真的调了 ctx.tools.register
  const registered = [];
  const fakeCtx = { tools: { register: (t) => registered.push(t) } };
  const returned = registerGowinTools(fakeCtx);
  eq(registered.length, 15, 'registerGowinTools 注册了 15 个');
  eq(returned.length, 15, 'registerGowinTools 返回 15 个名字');
  ok(registered.every((t) => t && typeof t.execute === 'function' && typeof t.name === 'string'), '注册对象都带 name/execute');
  eq(registered.map((t) => t.name).join(','), names.join(','), '注册顺序与 TOOL_LIST 一致');

  // 操作码表必须覆盖常用项且标出假失败的那个
  has(JSON.stringify(OP_BY_INDEX[4]), 'Verify failed', 'OP_BY_INDEX[4] 标注了已知假失败');
  has(JSON.stringify(OP_BY_INDEX[6]), 'embFlash', 'OP_BY_INDEX[6] 是 embFlash 写入');
  has(JSON.stringify(OP_BY_INDEX[2]), 'SRAM', 'OP_BY_INDEX[2] 是 SRAM Program');
  eq(OP_INDEX.length, OP_BY_INDEX && Object.keys(OP_BY_INDEX).length, 'OP_INDEX 与 OP_BY_INDEX 条目数一致');
  eq(
    OP_INDEX.map((o) => o.i).join(','),
    '0,1,2,4,5,6,8,9,16,17,24,36,37,38,39,51,73,74',
    'operation_index 表覆盖实测过的码',
  );

  ok(Array.isArray(PITFALLS) && PITFALLS.length >= 20, `PITFALLS ≥ 20 条（实际 ${PITFALLS.length}）`);
  const pitText = JSON.stringify(PITFALLS);
  for (const kw of ['低电平', 'ao_0', '退出码', 'GOWIN_HOME', 'exclusive']) {
    has(pitText, kw, `踩坑清单覆盖关键字 ${kw}`);
  }

  const pbKeys = Object.keys(PLAYBOOKS);
  ok(pbKeys.length >= 5, `PLAYBOOKS ≥ 5 个剧本（${pbKeys.join(',')}）`);
  for (const k of ['build_failed', 'all_leds_off', 'gao_capture', 'wrong_pins', 'first_time']) {
    ok(PLAYBOOKS[k] !== undefined, `剧本存在: ${k}`);
  }
  has(JSON.stringify(PLAYBOOKS.all_leds_off), 'LED', '全灭剧本谈 LED 极性');
  has(JSON.stringify(PLAYBOOKS.all_leds_off), 'RST_N', '全灭剧本澄清 RST_N 这个误判');
  has(JSON.stringify(PLAYBOOKS.gao_capture), 'ao_0', 'GAO 剧本提到码流改名 ao_0');
  has(JSON.stringify(PLAYBOOKS.gao_capture), 'cwd', 'GAO 剧本提醒 gao_analyzer 的 cwd 限制');
});

// ─────────────────────────────────────────── 8. 技能 provider

describe('8. 技能 provider（frontmatter + 目录发现）', async () => {
  const fm = parseFrontmatter('---\nname: x\ndescription: |\n  第一行\n  第二行\n---\n正文');
  eq(fm.fm.name, 'x', 'frontmatter name');
  has(fm.fm.description, '第二行', '块标量 description 是多行正文而不是字面量 "|"');
  eq(fm.body.trim(), '正文', 'frontmatter body');

  const folded = parseFrontmatter('---\nname: y\ndescription: >\n  折\n  叠\n---\nB');
  eq(folded.fm.description.includes('|'), false, '折叠标量不残留 "|"');
  has(folded.fm.description, '折', '折叠标量内容保留');

  const noFm = parseFrontmatter('裸正文\n第二行');
  eq(noFm.fm.name, undefined, '无 frontmatter 时不伪造 name');
  has(noFm.body, '裸正文', '无 frontmatter 时正文原样保留');

  const provider = createProvider({ signal: undefined });
  eq(provider.name, PROVIDER_NAME, 'provider.name');
  eq(PROVIDER_NAME, 'gowin', 'PROVIDER_NAME 与插件 id 呼应');

  const catalog = await provider.list();
  eq(catalog.complete, true, 'skills 目录可读 → complete');
  const skill = catalog.candidates.find((c) => c.name === 'gowin-fpga');
  ok(skill, `发现技能 gowin-fpga（${catalog.candidates.map((c) => c.name).join(',')}）`);
  eq(skill.provider, PROVIDER_NAME, 'candidate.provider');
  eq(skill.source, 'bundled', 'candidate.source = bundled');
  eq(skill.resourceBase.kind, 'directory', 'candidate.resourceBase.kind');
  eq(skill.invocation.modelInvocable, true, '技能可被模型调用');
  ok(skill.description.length > 30, `技能 description 有内容（${skill.description.length} 字符）`);
  has(skill.description, 'GW1N', '技能 description 提到 GW1N（便于检索命中）');

  const got = await provider.get(skill);
  eq(got.name, 'gowin-fpga', 'get().name');
  eq(got.content.includes('\n---\n'), false, 'get().content 已剥离 frontmatter');
  for (const kw of ['gowin_env', '低电平', 'ao_0.fs', 'programmer_cli', 'BANK_VCCIO=1.8', 'gao_sh.exe']) {
    has(got.content, kw, `技能正文覆盖 ${kw}`);
  }
  ok(got.resourceBase.path.endsWith('gowin-fpga'), `resourceBase 指向技能目录（${got.resourceBase.path}）`);
  eq(got.path.replace(/.*[\\/]/, ''), 'SKILL.md', 'get().path 指向 SKILL.md');

  // 取消信号必须让 list 抛，而不是返回残缺结果
  const aborted = createProvider({ signal: { aborted: true, reason: new Error('cancelled') } });
  try {
    await aborted.list();
    ok(false, '已取消的 provider 调 list 应抛错');
  } catch (error) {
    has(String(error?.message ?? error), 'cancelled', '已取消的 provider 调 list 抛取消原因');
  }
});

// ─────────────────────────────────────────── 9. 工程定位

describe('9. 工程定位', () => {
  if (!existsSync(GOWIN_BUILD)) {
    console.log('  （跳过：gowin-build 缺失）');
    return;
  }
  // locateGprj(file, cwd) 返回 {ok, path} —— 命中多个候选时 ok:false 并把候选列出来
  const explicit = locateGprj(FIXTURE_GPRJ, FIXTURE);
  eq(explicit.ok, true, 'locateGprj 认可显式 .gprj 路径');
  eq(explicit.path, FIXTURE_GPRJ, 'locateGprj 回的就是夹具工程');
  const fromRoot = locateGprj(null, FIXTURE_ROOT);
  eq(fromRoot.ok, true, 'cwd 顶层只有一份 .gprj 时直接命中');
  eq(fromRoot.path, FIXTURE_GPRJ, `从工程目录命中（${fromRoot.path}）`);
  const fromDeep = locateGprj(null, join(FIXTURE_ROOT, 'impl', 'pnr'));
  eq(fromDeep.ok, true, '从 impl\\pnr 这种深目录也能逐级上溯找到工程');
  eq(fromDeep.path, FIXTURE_GPRJ, `上溯结果（${fromDeep.path}）`);
  const missing = locateGprj(join(WORKSPACE, 'nonexistent-dir-xyz.gprj'), WORKSPACE);
  eq(missing.ok, false, '不存在的显式路径 → ok:false');
  has(missing.message, '找不到', '不存在的路径给出可读原因');
  const multi = locateGprj(null, GOWIN_BUILD);
  eq(multi.ok, false, 'gowin-build 下有多份 .gprj → 要求显式指定');
  ok(Array.isArray(multi.candidates) && multi.candidates.length > 1, `多候选时列出候选（${multi.candidates?.length} 个）`);
});

// ─────────────────────────────────────────── 10.（可选）真编译

if (process.argv.includes('--build')) {
  describe('10. 真编译（--build）', () => {
    const picked = resolveGowinRoot({});
    if (!picked.root || !HAVE_FIXTURE) {
      console.log('  （跳过：无安装或无工程）');
      return;
    }
    console.log(`  … 正在用 ${picked.root} 跑 gw_sh，约 1-2 分钟`);
    const res = runBuild({ root: picked.root, gprj: FIXTURE_GPRJ, task: 'all', timeoutMs: 20 * 60 * 1000 });
    eq(res.status, 0, `gw_sh 退出码 0（实际 ${res.status}${res.timedOut ? ', 超时' : ''}）`);
    eq(res.ok, true, `判据通过（verdict=${res.verdict}）`);
    const arts = collectArtifacts(FIXTURE_GPRJ);
    const fsList = arts.bitstreams.filter((b) => /\.fs$/i.test(b.name));
    ok(fsList.length > 0, `生成了 .fs（${fsList.map((b) => b.name).join(',')}）`);
    eq(res.timedOut, false, '没有超时');
    const tail = (res.stdout ?? '').split('\n').filter((l) => /SUCCESS|FAILED|Finished/i.test(l)).slice(-2).join(' | ');
    ok(true, `日志摘要: ${tail || '(无 SUCCESS 行，单工程构建属正常)'}`);
  });
} else {
  console.log('\n\x1b[2m（未跑真编译；加 --build 可验 gw_sh 全链路）\x1b[0m');
}

// ─────────────────────────────────────────── 结果

for (const d of pending) {
  group = d.name;
  console.log(`\n\x1b[1m${d.name}\x1b[0m`);
  try {
    await d.run();
  } catch (error) {
    failures.push(`${d.name} → 抛异常: ${error instanceof Error ? error.stack : String(error)}`);
    console.log(`  \x1b[31m✗ 抛异常\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m全部通过\x1b[0m —— ${pass} 项断言`);
  process.exit(0);
}
console.log(`\x1b[31m失败 ${failures.length} 项\x1b[0m / 共 ${pass + failures.length} 项断言`);
for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
process.exit(1);
