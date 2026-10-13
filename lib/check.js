/**
 * 约束机械校验 —— 纯函数，给 `gowin_check` 工具用。
 *
 * 设计原则：**只报能给出证据的事，并且每条都说清"为什么这是问题"**。
 * 板级规则全部来自 `lib/board.js`（原理图逐网核对 + 原厂 `.cst` 交叉验证），
 * 不是猜的；未登记的引脚一律不判错，只在其"角色可疑"时提示。
 *
 * 分级：
 *   E = 会直接导致构建失败或上板必错（引脚冲突、器件配置码错、文件缺失）
 *   W = 能编译但与本板硬件不符（1.8V Bank、exclusive 加在配置脚/时钟脚、设备地址错）
 *   I = 值得看一眼的信息（缺 .sdc、缺 .gao 但工程里有 GAO 产物等）
 */

import { existsSync, readFileSync } from 'node:fs';
import { DEVICE, pinRole } from './board.js';
import { groupFiles } from './gprj.js';

const SEV_ORDER = { E: 0, W: 1, I: 2 };

function finding(sev, code, message, evidence) {
  return { sev, code, message, evidence: evidence ?? null };
}

/**
 * 校验一个已解析的 `.gprj`（含约束文件）。
 *
 * @param {object} parsed `parseGprj()` 的结果
 * @param {{cst?:object, cstPath?:string, sdc?:object, sdcPath?:string}} [extra]
 * @returns {{findings:Array, summary:{E:number,W:number,I:number}}}
 */
export function checkProject(parsed, extra = {}) {
  const f = [];
  const groups = groupFiles(parsed);

  // ---------------------------------------------------------- 器件
  if (!parsed.device?.name) {
    f.push(finding('E', 'DEVICE-MISSING', '`.gprj` 里没有 `<Device>` 元素，工程打不开或工程文件损坏。', parsed.path));
  } else {
    const known = DEVICE.name === parsed.device.name || DEVICE.alt.name === parsed.device.name;
    const expectedCode =
      parsed.device.name === DEVICE.name ? DEVICE.configCode : parsed.device.name === DEVICE.alt.name ? DEVICE.alt.configCode : null;
    if (!known) {
      f.push(
        finding(
          'W',
          'DEVICE-UNKNOWN',
          `工程器件是 \`${parsed.device.name}\`，不是本板实测过的 \`${DEVICE.name}\`（或 \`${DEVICE.alt.name}\`）。` +
            '本板 U7 = GW1N-UV9LQ144。若确实要换器件，请忽略本条。',
          `pn=${parsed.device.pn ?? '?'} configCode=${parsed.device.configCode ?? '?'}`,
        ),
      );
    } else if (expectedCode && parsed.device.configCode !== expectedCode) {
      f.push(
        finding(
          'E',
          'DEVICE-CODE-MISMATCH',
          `器件名是 \`${parsed.device.name}\`，但配置码是 \`${parsed.device.configCode}\`，应为 \`${expectedCode}\`。` +
            '配置码在 `<Device>` 的**元素文本**里，与 `name` 属性不匹配会导致综合/布局布线用错器件资源模型。',
          `<Device name="${parsed.device.name}" ...>${parsed.device.configCode}</Device>`,
        ),
      );
    }
    if (parsed.device.pn && parsed.device.pn !== DEVICE.pn) {
      f.push(
        finding(
          'W',
          'DEVICE-PN',
          `Part Number 是 \`${parsed.device.pn}\`，本板原理图/例程用的是 \`${DEVICE.pn}\`。` +
            '器件名与 pn 不匹配时工具链可能报错或选错封装。',
          parsed.device.path,
        ),
      );
    }
  }

  // ---------------------------------------------------------- 文件表
  const srcs = [...groups.verilog, ...groups.vhdl];
  if (srcs.length === 0) {
    f.push(finding('E', 'NO-SOURCE', '`.gprj` 的 FileList 里没有任何 Verilog/VHDL 源文件，无法综合。', parsed.path));
  }
  for (const file of parsed.files ?? []) {
    if (!file.exists) {
      f.push(
        finding('E', 'FILE-MISSING', `FileList 里登记了 \`${file.path}\`，但磁盘上不存在。`, `${file.abs}`),
      );
    }
  }
  const enabled = (parsed.files ?? []).filter((x) => x.enable);
  if (!enabled.some((x) => x.type === 'file.cst')) {
    f.push(
      finding(
        'W',
        'NO-CST',
        '工程里没有启用任何 `.cst` 物理约束 —— 引脚会由工具自动分配，上板几乎必然不工作。',
        '至少要给时钟和每个外设写 IO_LOC。',
      ),
    );
  }
  if (!enabled.some((x) => x.type === 'file.sdc')) {
    f.push(
      finding(
        'I',
        'NO-SDC',
        '工程里没有 `.sdc` 时序约束，会看到 `WARN (TA1132) : ... was determined to be a clock but was not created.`。' +
          '功能不受影响，但时序报告没有时钟定义。补一行即可：',
        "create_clock -name CLK_50M -period 20 -waveform {0 10} [get_ports {CLK_50M}]",
      ),
    );
  }

  // ---------------------------------------------------------- 约束内容
  if (extra.cst) {
    f.push(...checkCst(extra.cst, extra.cstPath ?? null, parsed));
  }

  // ---------------------------------------------------------- 顶层模块
  const tops = guessTopModules(groups);
  if (tops.length === 0) {
    f.push(finding('I', 'NO-TOP-GUESS', '无法从源码里猜出顶层模块（没找到 module 声明），构建前请确认顶层。', null));
  }

  const summary = { E: 0, W: 0, I: 0 };
  for (const x of f) summary[x.sev] += 1;
  f.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
  return { findings: f, summary, tops };
}

/**
 * 校验 `.cst` 内容。
 *
 * @param {object} cst `parseCst()` 的结果
 * @param {string|null} cstPath
 * @param {object} parsed 为了知道哪些信号名在源码里真的存在
 */
export function checkCst(cst, cstPath = null, parsed = null) {
  const f = [];
  const where = cstPath ?? '.cst';

  // ---- 1. 同一引脚被多个信号占用
  const pinUse = new Map();
  for (const l of cst.locs) {
    const key = String(l.pin);
    if (!pinUse.has(key)) pinUse.set(key, []);
    pinUse.get(key).push(l);
  }
  for (const [pin, list] of pinUse) {
    if (list.length > 1) {
      f.push(
        finding(
          'E',
          'PIN-DOUBLE-BOUND',
          `引脚 ${pin} 被 ${list.length} 个信号同时绑定：${list.map((x) => x.name).join(', ')}。布局布线必然失败。`,
          list.map((x) => `L${x.line}: ${x.text}`).join('\n'),
        ),
      );
    }
    const roles = pinRole(pin);
    if (roles.length > 0) {
      const names = list.map((x) => x.name).join(', ');
      const jtag = roles.some((r) => r.role === 'jtag');
      if (jtag) {
        f.push(
          finding(
            'W',
            'PIN-DEDICATED-JTAG',
            `引脚 ${pin} 是本板**专用 JTAG 脚**（${roles.map((r) => r.signal).join('/')}），现在绑给了 \`${names}\`。` +
              '这 4 个脚不可当 GPIO 用；除非 `set_option -use_jtag_as_gpio 1`（代价是失去烧录/在线调试）。',
            list.map((x) => `L${x.line}: ${x.text}`).join('\n'),
          ),
        );
      }
    }
  }

  // ---- 2. 每个 IO_PORT 都必须有对应的 IO_LOC（否则属性没有落点）
  for (const p of cst.ports) {
    if (!cst.locs.some((l) => l.name === p.name)) {
      f.push(
        finding(
          'W',
          'PORT-WITHOUT-LOC',
          `\`${p.name}\` 写了 IO_PORT 但没有 IO_LOC —— 电气属性不知道落在哪个引脚上，等于没写。`,
          `L${p.line}: ${p.text}`,
        ),
      );
    }
  }

  // ---- 3. Bank 电压：本板是 3.3V
  for (const p of cst.ports) {
    const v = p.attrs.BANK_VCCIO;
    const ioType = p.attrs.IO_TYPE;
    if (v !== undefined && String(v) !== String(DEVICE.bankVccio)) {
      f.push(
        finding(
          'W',
          'BANK-VCCIO-MISMATCH',
          `\`${p.name}\` 写的是 BANK_VCCIO=${v}，但**本板四个 Bank 由 0Ω 电阻接到 D3V3，实际是 3.3V**。` +
            '已硬件验证必须写 `IO_TYPE=LVCMOS33 ... BANK_VCCIO=3.3`。' +
            '（原厂 03_Key_FallEage / 04_UART / 06_FLASH 的 .cst 里错写成 1.8，别照抄。）',
          `L${p.line}: ${p.text}`,
        ),
      );
    }
    if (ioType === undefined) {
      f.push(
        finding(
          'I',
          'IO-TYPE-MISSING',
          `\`${p.name}\` 没有写 IO_TYPE —— 会退到器件默认电平标准，本板建议显式写 \`IO_TYPE=LVCMOS33\`。`,
          `L${p.line}: ${p.text}`,
        ),
      );
    }
  }

  // ---- 4. exclusive 加在专用配置脚上
  for (const l of cst.locs) {
    if (!/\bexclusive\b/i.test(l.flags ?? '')) continue;
    const roles = pinRole(l.pin);
    const isCfg = roles.some((r) => r.dedicatedConfigPin);
    if (isCfg) {
      f.push(
        finding(
          'W',
          'EXCLUSIVE-ON-CONFIG-PIN',
          `引脚 ${l.pin}（外部 Flash 的 SPI，同时是高云**专用配置脚**）被标了 \`exclusive\`。` +
            '这几个脚要留给配置通路，**不要加 exclusive**，也别叠加冲突的 IO_PORT 属性。',
          `L${l.line}: ${l.text}`,
        ),
      );
    }
  }

  // ---- 5. 板级角色 vs 信号名（最省事的一类误接线）
  for (const l of cst.locs) {
    const roles = pinRole(l.pin);
    if (roles.length === 0) continue;
    const role = roles[0].role;
    const name = String(l.name);
    if (role === 'clock' && !/clk|clock/i.test(name)) {
      f.push(
        finding(
          'I',
          'CLOCK-PIN-NAME',
          `引脚 ${l.pin} 是板上的 50MHz 有源晶振输入（专用全局时钟脚 GCLKT_2），但信号名叫 \`${name}\`。` +
            '若这是给别的信号用的，上板就拿不到时钟。',
          `L${l.line}: ${l.text}`,
        ),
      );
    }
    if (role === 'led' && /^(rst|reset|key|btn)/i.test(name)) {
      f.push(
        finding(
          'W',
          'LED-PIN-AS-KEY',
          `引脚 ${l.pin} 接的是**LED**（${roles[0].sch}，低电平点亮），但信号名像按键/复位：\`${name}\`。` +
            'LED 是输出，拿它当输入会看不出任何反应。',
          `L${l.line}: ${l.text}`,
        ),
      );
    }
    if (role === 'key' && /^led/i.test(name)) {
      f.push(
        finding(
          'W',
          'KEY-PIN-AS-LED',
          `引脚 ${l.pin} 接的是**按键**（${roles[0].sch}，按下为 0），但信号名像 LED：\`${name}\`。` +
            '按键是输入，当输出去驱动不会有任何现象。',
          `L${l.line}: ${l.text}`,
        ),
      );
    }
    if (role === 'i2c' && roles[0].bidirectional && !/sda/i.test(name)) {
      f.push(
        finding(
          'I',
          'I2C-SDA-NAME',
          `引脚 ${l.pin} 是 EEPROM 的 I²C **SDA**（双向），信号名叫 \`${name}\`。` +
            'SDA 在 Verilog 里必须是 `inout` + 三态，别写成纯输出。',
          `L${l.line}: ${l.text}`,
        ),
      );
    }
  }

  // ---- 6. 板级引脚 ↔ 信号名（名字暗示了角色，就按板级事实核对引脚号）
  for (const l of cst.locs) {
    if (/^(clk_50m|clk|clock|sys_clk)$/i.test(l.name) && Number(l.pin) !== 98) {
      f.push(
        finding(
          'W',
          'CLOCK-WRONG-PIN',
          `\`${l.name}\` 绑到了引脚 ${l.pin}，但**本板唯一的 50MHz 晶振接在 IO98**（IOR9[A]/GCLKT_2）。` +
            '绑错脚就拿不到时钟，综合后会看到时钟脚悬空。',
          `L${l.line}: ${l.text}`,
        ),
      );
    }
  }
  for (const l of cst.locs) {
    const m = /^led\[(\d+)\]$/i.exec(l.name) ?? /^led_?(\d+)$/i.exec(l.name);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx >= 0 && idx <= 3) {
      const expectPin = [27, 28, 29, 30][idx];
      if (Number(l.pin) !== expectPin) {
        f.push(
          finding(
            'W',
            'LED-WRONG-PIN',
            `\`${l.name}\` 绑到了引脚 ${l.pin}，但本板 LED${idx + 1} 接的是 **IO${expectPin}**。` +
              '（IO27/28/29/30 → LED1..LED4，低电平点亮。）',
            `L${l.line}: ${l.text}`,
          ),
        );
      }
    }
  }
  const keyPins = [75, 76, 97, 99];
  for (const l of cst.locs) {
    const m = /^key\[(\d+)\]$/i.exec(l.name) ?? /^key_?(\d+)$/i.exec(l.name);
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx >= 0 && idx <= 3 && Number(l.pin) !== keyPins[idx]) {
      f.push(
        finding(
          'W',
          'KEY-WRONG-PIN',
          `\`${l.name}\` 绑到了引脚 ${l.pin}，但本板 KEY${idx + 1} 接的是 **IO${keyPins[idx]}**。` +
            '（IO75/76/97/99，按下为 0。注意 RST_N 在例程里就是 IO75 = KEY1，本板没有专用复位芯片。）',
          `L${l.line}: ${l.text}`,
        ),
      );
    }
  }
  for (const l of cst.locs) {
    if (/^uart_tx$/i.test(l.name) && Number(l.pin) !== 12) {
      f.push(finding('W', 'UART-TX-WRONG-PIN', `\`${l.name}\` 绑到 ${l.pin}，本板 FPGA 发送是 **IO12**。`, `L${l.line}: ${l.text}`));
    }
    if (/^uart_rx$/i.test(l.name) && Number(l.pin) !== 15) {
      f.push(finding('W', 'UART-RX-WRONG-PIN', `\`${l.name}\` 绑到 ${l.pin}，本板 FPGA 接收是 **IO15**。`, `L${l.line}: ${l.text}`));
    }
    if (/^(scl|i2c_scl)$/i.test(l.name) && Number(l.pin) !== 86) {
      f.push(finding('W', 'I2C-SCL-WRONG-PIN', `\`${l.name}\` 绑到 ${l.pin}，本板 EEPROM SCL 是 **IO86**。`, `L${l.line}: ${l.text}`));
    }
    if (/^(sda|i2c_sda)$/i.test(l.name) && Number(l.pin) !== 85) {
      f.push(finding('W', 'I2C-SDA-WRONG-PIN', `\`${l.name}\` 绑到 ${l.pin}，本板 EEPROM SDA 是 **IO85**（双向）。`, `L${l.line}: ${l.text}`));
    }
  }

  // ---- 7. 约束里的信号在源码里找不到（大概率拼错）
  if (parsed) {
    const names = new Set(cst.locs.map((l) => l.name));
    const declared = collectPortNames(parsed);
    if (declared.size > 0) {
      for (const n of names) {
        const bare = n.replace(/\[[^\]]*\]$/, '');
        if (!declared.has(n) && !declared.has(bare)) {
          f.push(
            finding(
              'I',
              'CST-NAME-NOT-DECLARED',
              `约束里的 \`${n}\` 在所有源码顶层端口的名字列表里找不到 —— 可能拼错，也可能是子模块信号。` +
                '拼错的约束通常只在布局布线跑完看引脚报告时才发现。',
              null,
            ),
          );
        }
      }
    }
  }

  return f;
}

/** 从工程源码里收集所有 `module … ( … )` 端口名（顶层候选）。 */
export function collectPortNames(parsed) {
  const out = new Set();
  const groups = groupFiles(parsed);
  for (const file of [...groups.verilog, ...groups.vhdl]) {
    if (!file.exists || !file.abs || !existsSync(file.abs)) continue;
    let text = '';
    try {
      // 同步读，校验路径本来就是"读一点看一眼"的性质
      text = readSrc(file.abs);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s*(?:input|output|inout)\s+(?:wire|reg|logic)?\s*(\[[^\]]*\]\s*)?([A-Za-z_]\w*)/gm)) {
      out.add(m[2]);
    }
    for (const m of text.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) out.add(m[1]);
  }
  return out;
}

function readSrc(p) {
  return readFileSync(p, 'utf8');
}

/** 猜顶层模块：`.v` 里的 `module X (...)`，排除常见子模块命名。 */
export function guessTopModules(groups) {
  const mods = [];
  for (const file of [...groups.verilog, ...groups.vhdl]) {
    if (!file.exists || !file.abs) continue;
    let text = '';
    try {
      text = readSrc(file.abs);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^\s*module\s+([A-Za-z_]\w*)/gm)) mods.push({ name: m[1], file: file.path });
  }
  return mods;
}
