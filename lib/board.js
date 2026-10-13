/**
 * FG202 核心板（GW1N-UV9LQ144）板级事实表 —— 引脚、电平、极性、器件配置码。
 *
 * **来源与可信度**：全部来自原理图 `C:\Users\lishuo\Documents\BOOK\FG202 GW1N-UV9LQ144 核心板原理图.pdf`
 * （2 页 A4，2023.06 V1.0），并已与高云原厂例程的 `.cst` **逐引脚交叉验证一致**，
 * 且在真实板卡上跑通过（`07_LED_Flow` 四灯流水灯）。
 *
 * 原理图标题栏写的是 "GW1N-LV4LQ144核心板 / FW202 核心板 V1.0"，**是原厂模板残留**，
 * 以 U7 丝印型号 `GW1N-UV9LQ144` 为准。
 *
 * 只放**已交叉验证**的事实。任何未验证项一律不写进这张表 —— 这张表会被工具用来
 * 判「约束写错了」，不能有猜测。
 */

/** 目标器件。 */
export const DEVICE = {
  name: 'GW1N-9C',
  pn: 'GW1N-UV9LQ144C6/I5',
  deviceVersion: 'C',
  /** `.gprj` 里 `<Device>` 的**元素文本**就是这个配置码，不是属性。 */
  configCode: 'gw1n9c-019',
  package: 'LQFP144',
  /** 同族另一个可用组合（桌面 02~06 例程用的），编译同样正常。 */
  alt: { name: 'GW1N-9', pn: 'GW1N-UV9LQ144C6/I5', configCode: 'gw1n9-026' },
  bankVccio: 3.3,
};

/**
 * 默认 IO 电气属性。
 *
 * ⚠️ **本板四个 Bank 由 0 Ω 电阻（R31~R34）接到 D3V3，按 3.3 V 写约束**，已硬件验证。
 * 原厂 `03_Key_FallEage.cst` / `04_UART.cst` / `06_FLASH.cst` 里写的是 `BANK_VCCIO=1.8`
 * 且不带 `IO_TYPE` —— 照抄那几行有风险。
 */
export const DEFAULT_IO_PORT = 'IO_TYPE=LVCMOS33 PULL_MODE=UP BANK_VCCIO=3.3';

/** 50 MHz 有源晶振（Y1）→ R20 22 Ω → CLK_IN → pin98。板上没有第二个晶振。 */
export const CLOCK = {
  name: 'CLK_50M',
  pin: 98,
  freqMHz: 50,
  periodNs: 20,
  /** pin98 是 BANK1 的专用全局时钟脚 IOR9[A]/GCLKT_2。 */
  note: 'pin98 = IOR9[A]/GCLKT_2，是 BANK1 的专用全局时钟脚，不要挪到普通 IO',
  /** 板上只有这一颗晶振；任何其它频率必须由它分频得到。 */
  single: true,
};

/** 引脚序（低电平有效器件的引脚顺序是硬事实，工具按序号判「绑错脚」）。 */
export const LED_PINS = [27, 28, 29, 30];
export const KEY_PINS = [75, 76, 97, 99];
/** RST_N 在例程里就是 KEY1，落在 IO75 —— 本板**没有**专用复位芯片。 */
export const RESET_PIN = 75;

/**
 * 板载外设：每一项都带 `pin`（FPGA 球号）、`polarity`（有效电平）、`hardware`（板上接法）。
 * `polarity: 'low'` = 低电平有效。
 */
export const PERIPHERALS = {
  led: {
    label: 'LED ×4（低电平点亮）',
    items: [
      { sch: 'LED1', pin: 27, net: 'IOL26[A]', series: 'R1 1K' },
      { sch: 'LED2', pin: 28, net: 'IOL26[B]', series: 'R2 1K' },
      { sch: 'LED3', pin: 29, net: 'IOB4[A]', series: 'R3 1K' },
      { sch: 'LED4', pin: 30, net: 'IOB4[B]', series: 'R4 1K' },
    ],
    polarity: 'low',
    activeLow: true,
    /** 板上只要 IO 输出 0 就亮。复位值写 4'b1111 是最容易犯的错。 */
    hardware: 'D3V3 → 串阻 1K → LED 阳极，LED 阴极 → FPGA IO。**IO 输出 0 = 亮，1 = 灭。**',
    warning:
      'LED 极性是本工程踩过的最大坑：复位值写成 4\'b1111（全灭）会导致上板四颗灯全不亮。' +
      '另有一颗丝印 POWER 的灯接在 D5V 上（R5 1K），**不受 FPGA 控制**，别当成可控 LED。',
  },
  key: {
    label: '按键 ×4（按下为 0，无硬件消抖）',
    items: [
      { sch: 'KEY1', pin: 75, pullup: 'R6 10K → D3V3', alias: 'RST_N（例程里这么叫，但本板没有复位芯片）' },
      { sch: 'KEY2', pin: 76, pullup: 'R7 10K → D3V3' },
      { sch: 'KEY3', pin: 97, pullup: 'R8 10K → D3V3' },
      { sch: 'KEY4', pin: 99, pullup: 'R9 10K → D3V3' },
    ],
    polarity: 'low',
    activeLow: true,
    /** 本板没有复位芯片；例程把 KEY1 叫 RST_N，但它只是一颗按键。 */
    resetPin: 75,
    hardware: 'D3V3 → 10K 上拉 → FPGA IO，按键另一端 → GND。**按下 = 0，松开 = 1。**',
    warning:
      '**无硬件消抖（无 RC）**，必须自己在 Verilog 里做消抖。' +
      'KEY1 = IO75 在例程里叫 RST_N —— 本板没有专用复位芯片，上电时没人按，10K 把它拉为高，' +
      '**不会自动产生低脉冲**；设计若依赖"上电复位"必须自己写。',
  },
  uart: {
    label: 'UART（USB 转串口 CH340N U3，与烧录共用同一个 Type-C 口）',
    items: [
      { signal: 'FPGA TX → PC RX', ctrlPin: 'RXD pin6', pin: 12 },
      { signal: 'PC TX → FPGA RX', ctrlPin: 'TXD pin7', pin: 15 },
    ],
    hardware: '**IO12 = FPGA 发送，IO15 = FPGA 接收**。无硬件流控（RTS# 悬空）。波特率由 FPGA 内从 50 MHz 分频。',
  },
  eeprom: {
    label: 'EEPROM（I²C，U5 = AT24C02，256 Byte）',
    items: [
      { signal: 'SCL', pin: 86, pullup: 'R11 10K → D3V3' },
      { signal: 'SDA', pin: 85, pullup: 'R12 10K → D3V3', note: '**双向**，Verilog 里要 inout + 三态' },
    ],
    hardware: 'A0/A1/A2 全部接地 → 7 位地址固定 0x50（写 0xA0 / 读 0xA1）；WP 接地（写保护未使能）。',
    /** SDA 必须 inout + 三态，这是最容易写错的一根线。 */
    bidirectional: true,
    warning: '页大小 **8 Byte**，写周期 ≤ 5 ms —— 跨页写要留延时。',
  },
  spiFlash: {
    label: 'SPI Flash（U6 = W25Q32JVSQ，4 MByte，同时是 FPGA 的配置 Flash）',
    items: [
      { signal: 'MCLK/WDCLK', pin: 93, gowinPin: 'IOR12[B]/MCLK/D4', u6: 'C (6)' },
      { signal: 'MCS_N/MCS0N', pin: 94, gowinPin: 'IOR12[A]/MCS_N/D5', u6: 'S# (1)' },
      { signal: 'MO/WASDO', pin: 95, gowinPin: 'IOR11[B]/MO/D6', u6: 'DQ0 (5)' },
      { signal: 'MI/WDATA0', pin: 96, gowinPin: 'IOR11[A]/MI/D7', u6: 'DQ1 (2)' },
    ],
    warning:
      'IO93~IO96 既是外部 Flash 的 SPI，又是高云的**专用配置脚**。' +
      '用户逻辑可以复用（原厂 06_FLASH 实测可行），但**别加 exclusive、别叠加冲突的 IO_PORT 属性**。' +
      '另注意：`programmer_cli --operation_index 6` 烧的是**片内 embFlash**；这颗**外部** W25Q32 要写数据得另走逻辑或 index 9。',
    /** 这 4 个脚同时是配置通路，加 exclusive 会把配置通路占掉。 */
    dedicatedConfigPins: true,
  },
  jtag: {
    label: 'JTAG（J1，9 pin 排针）',
    items: [
      { signal: 'TMS', pin: 13, series: 'R18 22Ω' },
      { signal: 'TCK', pin: 14, series: 'R15 22Ω' },
      { signal: 'TDI', pin: 16, series: 'R16 22Ω' },
      { signal: 'TDO', pin: 18, series: 'R17 22Ω' },
    ],
    warning:
      '这 4 个是**专用 JTAG 脚，不可当 GPIO 用**（除非 `set_option -use_jtag_as_gpio 1`，代价是失去烧录/在线调试）。',
  },
  config: {
    label: '重新配置',
    items: [{ signal: 'nCONFIG / RECONFIG_N', pin: 20, note: 'IOL13[B]，经 R19 22Ω，R35 4.7K 上拉到 D3V3' }],
    warning: '这是**重新加载配置**用的脚，**不是通用复位**。',
  },
};

/** 电源事实。 */
export const POWER = {
  rails: 'U1 1117-3.3 → D3V3；U2 1117-2.5 → D2V5；U4 1117-1.2 → D1V2；输入 D5V（USB Type-C 5V）',
  banks: 'B0_VCC / B1_VCC / B2_VCC / B3_VCC 出厂由 0Ω（R31~R34）接到 D3V3',
  note: '板背另有 BANK 电源切换电路，预留 2.5V/1.2V 方案（需拆 0Ω + 飞线）。**本板按 3.3V Bank 写约束。**',
};

/** 扩展接口。 */
export const EXPANSION = {
  note: 'P1 / P2 = 各 27×2 排针（2.54mm），带出绝大多数 IO 以及 D3V3/GND。引脚号 ↔ 排针位号对应表需从原理图截图读取（抽出的文本丢失连线关系）。',
};

// ------------------------------------------------------------ 派生索引

/** 引脚号 → 该脚在板上的角色。用来判「约束写错了」。 */
export const PIN_ROLES = new Map();

function addPin(pin, role, extra = {}) {
  const list = PIN_ROLES.get(pin) ?? [];
  list.push({ role, ...extra });
  PIN_ROLES.set(pin, list);
}

addPin(CLOCK.pin, 'clock', { name: CLOCK.name, freqMHz: CLOCK.freqMHz });
for (const it of PERIPHERALS.led.items) addPin(it.pin, 'led', { sch: it.sch, activeLow: true });
for (const it of PERIPHERALS.key.items) addPin(it.pin, 'key', { sch: it.sch, activeLow: true });
addPin(12, 'uart', { dir: 'tx' });
addPin(15, 'uart', { dir: 'rx' });
addPin(85, 'i2c', { signal: 'SDA', bidirectional: true });
addPin(86, 'i2c', { signal: 'SCL' });
for (const it of PERIPHERALS.spiFlash.items) addPin(it.pin, 'spi_flash_config', { signal: it.signal, dedicatedConfigPin: true });
for (const it of PERIPHERALS.jtag.items) addPin(it.pin, 'jtag', { signal: it.signal, dedicated: true });
addPin(PERIPHERALS.config.items[0].pin, 'reconfig', { signal: 'nCONFIG' });

/**
 * 引脚号 → 角色数组。未知引脚返回空数组（不代表非法，只是本板没登记）。
 * @param {number|string} pin
 */
export function pinRole(pin) {
  return PIN_ROLES.get(Number(pin)) ?? [];
}

/** 器件配置码表：name → configCode。 */
export const DEVICE_CODES = {
  'GW1N-9C': 'gw1n9c-019',
  'GW1N-9': 'gw1n9-026',
};

/** 复位那段「最常用」的 .cst 片段（时钟 + 4 灯 + 4 键 + 串口），文档 §3.6 实测版。 */
export function cstSnippet(which = ['clk', 'led', 'key', 'uart']) {
  const lines = [];
  if (which.includes('clk')) {
    lines.push(`IO_LOC "${CLOCK.name}" ${CLOCK.pin} exclusive;`);
    lines.push(`IO_PORT "${CLOCK.name}" ${DEFAULT_IO_PORT};`);
  }
  if (which.includes('led')) {
    PERIPHERALS.led.items.forEach((_, i) => {
      lines.push(`IO_LOC "LED[${i}]" ${PERIPHERALS.led.items[i].pin} exclusive;`);
      lines.push(`IO_PORT "LED[${i}]" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;`);
    });
  }
  if (which.includes('key')) {
    PERIPHERALS.key.items.forEach((_, i) => {
      lines.push(`IO_LOC "KEY[${i}]" ${PERIPHERALS.key.items[i].pin} exclusive;`);
      lines.push(`IO_PORT "KEY[${i}]" ${DEFAULT_IO_PORT};`);
    });
  }
  if (which.includes('uart')) {
    lines.push('IO_LOC "UART_TX" 12 exclusive;');
    lines.push('IO_PORT "UART_TX" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;');
    lines.push('IO_LOC "UART_RX" 15 exclusive;');
    lines.push(`IO_PORT "UART_RX" ${DEFAULT_IO_PORT};`);
  }
  return lines.join('\n');
}

/** 板级速查表（给工具输出用）。 */
export function boardSummary() {
  const rows = [];
  for (const [key, p] of Object.entries(PERIPHERALS)) {
    rows.push({
      key,
      label: p.label,
      pins: p.items.map((i) => i.pin ?? i.signal).join(', '),
      polarity: p.polarity ?? null,
      warning: p.warning ?? null,
    });
  }
  return rows;
}
