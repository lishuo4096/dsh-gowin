# 高云 Gowin 1.9 工具链 Agent 操作手册

> **用途**：让下一个 AI agent（或人）在**不打开 Gowin IDE 图形界面**的前提下，完整驱动高云 FPGA 工具链：
> **编写 → 编译（综合 + 布局布线 + 码流）→ 烧录 → 在线逻辑分析（GAO）→ 波形解析**。
>
> **本手册所有内容均已在本机实测通过**（Gowin V1.9.12.02_SP2_x64 + 板卡 FG202 / GW1N-9C）。
> 凡未经实测的都明确标注了「未验证」。
>
> 最后更新：2026-10-11

---

## 0. 30 秒速查：最短可用路径

```powershell
# 0) 环境（每次都必设）
$env:GOWIN_HOME = 'C:\Gowin\Gowin_V1.9.12.02_SP2_x64'
$env:PATH = "$env:GOWIN_HOME\IDE\bin;$env:GOWIN_HOME\Programmer\bin;$env:PATH"

# 1) 编译（综合 + 布局布线 + 码流）
& "$env:GOWIN_HOME\IDE\bin\gw_sh.exe" .\build.tcl      # build.tcl: open_project X.gprj; run syn; run pnr

# 2) 烧录到片内 Flash（掉电保持）
& "$env:GOWIN_HOME\Programmer\bin\programmer_cli.exe" --device GW1N-9C `
    --operation_index 6 --fsFile .\impl\pnr\LED_Run.fs

# 3) 在线调试（GAO）—— 见第 6 节
```

三个入口，记住就够：**`gw_sh.exe`（编译）→ `programmer_cli.exe`（烧录）→ `gao_analyzer.exe`（在线调试）**。

> 📌 **要写新设计，先翻 §3.5「板载外设引脚表」** —— LED / 按键 / UART / EEPROM / SPI Flash / JTAG 的引脚号、上下拉、有效电平都在那里，已按实物原理图逐网核对并与原厂例程 `.cst` 交叉验证。
> ⚠️ 两个最容易写错的：**LED 是 `0` 亮**；**按键是按下为 `0`**。

---

## 1. 环境与硬约束

### 1.1 安装路径

| 项 | 路径 |
|---|---|
| 安装根 | `C:\Gowin\Gowin_V1.9.12.02_SP2_x64` |
| 编译工具 | `…\IDE\bin\` |
| 烧录工具 | `…\Programmer\bin\` |
| License | `…\gowin_E_1413338ED23B.lic`，由 `IDE\bin\gwlicense.ini` 指向 |
| 文档 | `…\IDE\doc\CN\`（40+ 份 PDF）、`…\IDE\doc\EN\` |

**License 是有效的**，综合/布局布线/GAO 全程没有报过 license 错误。

### 1.2 必须设置的环境变量

```powershell
$env:GOWIN_HOME = 'C:\Gowin\Gowin_V1.9.12.02_SP2_x64'
$env:PATH = "$env:GOWIN_HOME\IDE\bin;$env:GOWIN_HOME\Programmer\bin;$env:PATH"
```

不设 `GOWIN_HOME` 会报 `Please set environment variable GOWIN_HOME`，并且找不到 device/lib 资源。
**`gao_analyzer.exe` 额外要求 cwd 必须是 `IDE\bin`**（见 6.4），否则无论带不带参数都立刻退出码 1。

### 1.3 本机环境事实（踩过的坑）

| 事实 | 影响 / 对策 |
|---|---|
| 本机**没有 `pwsh` 命令**，只有 Windows PowerShell 5.1 | 脚本要写成 PS 5.1 兼容；不要用 `??`、`?:` 等 PS7 语法 |
| 执行策略默认 Restricted | 跑 `.ps1` 前先 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`，否则报「未对文件 … 进行数字签名」 |
| `Get-Content` 默认按 ANSI 读 | **读本工程的 UTF-8 文件必须加 `-Encoding UTF8`**，否则中文全是乱码（不是文件坏了） |
| `gw_sh.exe` 会往 `AppData\LocalLow\GowinSemi\IDE\cache\sh.log` 写日志 | stderr 出现 `alog error: failed to open log file` —— **非致命，忽略**（沙箱下写不进去而已）。用 `\| Where-Object { $_ -notmatch 'alog error' }` 过滤 |
| DPI 150% | UIA 给的是物理像素、Win32 给虚拟像素，坐标换算必须除缩放比（见 6.5） |

### 1.4 绝不能用的东西

| 程序 | 原因 |
|---|---|
| `gw_ide.exe` | GUI。加 `-h` 也会直接拉起图形界面并**挂住**，不能当 CLI |
| `gao_sh.exe` | **已证实是死路**，见 6.7 与第 8 节 |
| `programmer.exe`（GUI） | 用 `programmer_cli.exe` 代替 |

---

## 2. 工具链地图

| 程序 | 位置 | 角色 |
|---|---|---|
| **`gw_sh.exe`** | `IDE\bin` | **Gowin TCL 命令控制台**（TCL 8.6.4）。**这是编译的唯一入口** |
| `GowinSynthesis.exe` | `IDE\bin` | 综合引擎，由 `run syn` 内部调用 |
| `floorplanner.exe` | `IDE\bin` | 布局布线引擎，由 `run pnr` 内部调用 |
| **`programmer_cli.exe`** | `Programmer\bin` | **烧录**（SRAM / embFlash / 外部 SPI Flash / 扫描 JTAG 链） |
| `jtagserver.exe` | `Programmer\bin` | JTAG 服务端（`gao_analyzer.exe` 会自动拉起） |
| **`gao_analyzer.exe`** | `IDE\bin` | **在线逻辑分析仪（GAO）采集界面**。官方命令行入口 |
| `gvio_analyzer.exe` / `gvio_sh.exe` | `IDE\bin` | 虚拟输入输出（GVIO），可给设计注入激励 |
| `gao_sh.exe` | `IDE\bin` | ❌ **死路，别碰**（详见 6.7） |

---

## 3. 工程结构

### 3.1 目录布局

```
MyProject/
├── LED_Run.gprj          # 工程文件（XML）
├── LED_Run.gprj.user     # 用户配置（可选）
├── src/
│   ├── LED_Run.v         # Verilog 源
│   ├── LED_Run.cst       # 物理约束（引脚/电平）
│   └── LED_Run.gao       # GAO 在线调试配置（可选，见第 6 节）
└── impl/
    ├── gwsynthesis/      # 综合产物：*.vg 网表、*.prj、*_syn.rpt.html
    ├── pnr/              # 布局布线产物：*.fs 码流、*.rpt.txt 报告、cmd.do、device.cfg
    ├── gao/              # GAO 自动插入产物：gao.v、gw_gao_top.v、ao_0/gw_ao_parameter.v
    └── wave/             # GAO 波形导出目录（默认）
```

### 3.2 `.gprj` 格式（完整示例）

```xml
<?xml version="1" encoding="UTF-8"?>
<!DOCTYPE gowin-fpga-project>
<Project>
    <Template>FPGA</Template>
    <Version>5</Version>
    <Device name="GW1N-9C" pn="GW1N-UV9LQ144C6/I5">gw1n9c-019</Device>
    <FileList>
        <File path="src/LED_Run.v"   type="file.verilog" enable="1"/>
        <File path="src/LED_Run.cst" type="file.cst"     enable="1"/>
        <File path="src/LED_Run.gao" type="file.gao"     enable="1"/>
    </FileList>
</Project>
```

- `<Device name="…">` 的内容是配置码：`GW1N-9C` → `gw1n9c-019`，`GW1N-9` → `gw1n9-026`。
- 文件类型字符串：`file.verilog` / `file.vhdl` / `file.cst` / `file.gao` / `file.rao` / `file.sdc`。
- **路径是相对 `.gprj` 所在目录的**，用正斜杠。
- 手工复制/新增文件时，只要保证 `.gprj` 的 FileList 与 `src\` 下实际文件一致即可。

### 3.3 `.cst` 物理约束格式

```
IO_LOC "CLK_50M" 98;
IO_PORT "CLK_50M" IO_TYPE=LVCMOS33 PULL_MODE=UP BANK_VCCIO=3.3;
IO_LOC "LED[0]" 27 exclusive;
IO_PORT "LED[0]" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;
```

- `IO_LOC` 绑定引脚；加 `exclusive` 表示该 IO 不含其他复用。
- `IO_PORT` 设置电气属性：`IO_TYPE`（`LVCMOS33` / `LVCMOS18` / …）、`PULL_MODE`（`UP`/`DOWN`/`NONE`）、`DRIVE`（mA）、`BANK_VCCIO`。

### 3.4 目标板事实（FG202 V1.0 / GW1N-UV9LQ144C6/I5）

原理图：`C:\Users\lishuo\Documents\BOOK\FG202 GW1N-UV9LQ144 核心板原理图.pdf`（2 页 A4，2023.06 V1.0）。
下表全部来自该原理图，并已与原厂例程的 `.cst` **逐引脚交叉验证一致**。

**器件**
- `U7 = GW1N-UV9LQ144`（LQFP144；原理图分 `U7A`/`U7B`/`U7C`/`U7D`/`U7E` 五个单元）
- 工程器件配置：`GW1N-9C` / `GW1N-UV9LQ144C6/I5` / device_version `C` / `gw1n9c-019`
  （桌面 `02`~`06` 例程用的是 `GW1N-9` / `gw1n9-026`，两者都可正常编译）
- ⚠️ 原理图标题栏写的是 "GW1N-LV4LQ144核心板 / FW202 核心板 V1.0"，是原厂模板残留，**以 `U7` 的型号为准**

**时钟**
- `Y1` = 50 MHz **有源晶振**（XTAL-50M），输出经 `R20`（22 Ω 串联）→ 网络 `CLK_IN` → U7 pin98
- pin98 = `IOR9[A] / GCLKT_2`（BANK1，**专用全局时钟脚**）→ `CLK_50M = IO98`
- 板上**没有第二个晶振**；`06_FLASH` 里的 `clock25M` 是从 50 MHz 分频出来的

**电源与 Bank 电压**
- `U1 = 1117-3.3` → `D3V3`；`U2 = 1117-2.5` → `D2V5`；`U4 = 1117-1.2` → `D1V2`；输入 `D5V`（USB Type-C 5 V）
- 四个 Bank 电压网 `B0_VCC` / `B1_VCC` / `B2_VCC` / `B3_VCC` **出厂由 0 Ω 电阻（R31~R34）接到 `D3V3`**
- 板背面另有"BANK 电源切换电路"，预留 2.5 V / 1.2 V 方案（需拆 0 Ω + 飞线）
- ✅ **本板按 3.3 V Bank 写约束**：`IO_TYPE=LVCMOS33 ... BANK_VCCIO=3.3`（已在 `07_LED_Flow` 上板验证）
- ⚠️ **陷阱**：原厂 `03_Key_FallEage.cst` / `04_UART.cst` / `06_FLASH.cst` 里写的是 `BANK_VCCIO=1.8` 且不带 `IO_TYPE`，与本板实际 3.3 V 不符。**照抄这几个例程的 `IO_PORT` 行有风险；以 `01_LED_Run.cst` / `02_LED_Flash.cst` 的 `LVCMOS33 / 3.3` 为准。**

### 3.5 板载外设引脚表

**LED（4 颗，低电平点亮）**

| 原理图 | 例程常用名 | FPGA 引脚 | 串阻 | 封装位置 |
|---|---|---|---|---|
| LED1 | `LED[0]` / `LED0` | **IO27** | R1 1 K | `IOL26[A]` |
| LED2 | `LED[1]` / `LED1` | **IO28** | R2 1 K | `IOL26[B]` |
| LED3 | `LED[2]` / `LED2` | **IO29** | R3 1 K | `IOB4[A]` |
| LED4 | `LED[3]` / `LED3` | **IO30** | R4 1 K | `IOB4[B]` |

- 接法：`D3V3` → 串阻 1 K → LED 阳极，LED 阴极 → FPGA IO。**IO 输出 `0` = 亮，`1` = 灭。**
- 另有一颗与 FPGA 无关的电源指示灯（`D5V` → R5 1 K → `POWER` LED），**不要把它当成可控 LED。**
- ⚠️ **LED 极性是本工程踩过的最大坑**。曾把复位值写成 `4'b1111`（全灭），上板后四颗灯全不亮，而例程那颗常亮 —— 因为例程复位值是 `1'b0`（亮）。写 LED 逻辑时务必记住：**`0` 亮**；更稳的做法是让**"全灭"不成为任何合法状态**（见 §8 第 1 条的诊断设计）。

**按键（4 个）**

| 原理图 | 例程常用名 | FPGA 引脚 | 上拉 |
|---|---|---|---|
| KEY1 | `KEY0` / `RST_N` | **IO75** | R6 10 K → D3V3 |
| KEY2 | `KEY1` | **IO76** | R7 10 K → D3V3 |
| KEY3 | `KEY2` | **IO97** | R8 10 K → D3V3 |
| KEY4 | `KEY3` | **IO99** | R9 10 K → D3V3 |

- 接法：`D3V3` → 10 K 上拉 → FPGA IO，按键另一端 → GND。**按下 = `0`，松开 = `1`。**
- **无硬件消抖（无 RC）**，必须自己在 Verilog 里做消抖；可参考 `03_Key_FallEage` 的下降沿检测写法。
- ⚠️ 例程里的 `RST_N` 就是 **IO75 = KEY1**：本板**没有专用复位芯片**，复位就是一颗按键。上电时没人按 → 10 K 上拉为高 → `!RST_N` 恒假，设计照常运行。**（"四灯全灭"排查时我一度以为是复位没释放，其实这个脚一直是高 —— 别重复这个误判。）**

**UART（USB 转串口，与烧录共用同一个 Type-C 口）**

| CH340N (`U3`) 引脚 | 网络名 | FPGA 引脚 | 方向 |
|---|---|---|---|
| TXD (pin6) | `RXD` | **IO15** | PC → FPGA |
| RXD (pin7) | `TXD` | **IO12** | FPGA → PC |

- 即 **IO12 = FPGA 发送，IO15 = FPGA 接收**（`04_UART.cst` 里 `UART_TX=12` / `UART_RX=15`，与原理图一致）。
- 无硬件流控（`RTS#` 悬空）。波特率由 FPGA 内 `Uart_Bps_Module` 从 50 MHz 分频产生。

**EEPROM（I²C，`U5 = AT24C02`）**

| 信号 | FPGA 引脚 | 说明 |
|---|---|---|
| SCL | **IO86** | U5 pin6；`R11` 10 K 上拉到 D3V3 |
| SDA | **IO85** | U5 pin5；`R12` 10 K 上拉到 D3V3；**双向**，Verilog 里要 `inout` + 三态 |
| A0 / A1 / A2 | **接 GND** | 7 位地址固定 = **0x50**（写 `0xA0` / 读 `0xA1`）|
| WP | **接 GND** | 写保护未使能，可自由读写 |

- 容量 256 Byte，**页大小 8 Byte**，写周期 ≤ 5 ms（跨页写要留延时）。
- 与 `05_EEPROM.cst`（`SCL=86` / `SDA=85`）一致；例程里设备地址写死为 `{4'b1010, 3'b000, 1'b0}` = `0xA0`，与 A0~A2 接地吻合。

**SPI Flash（4 MByte，同时是 FPGA 的配置 Flash）**

| 功能 | 网络名 | FPGA 引脚 | Gowin 专用脚名 | `U6` 引脚 |
|---|---|---|---|---|
| 时钟 | `MCLK` / `WDCLK` | **IO93** | `IOR12[B]/MCLK/D4` | C (6) |
| 片选 | `MCS_N` / `MCS0N` | **IO94** | `IOR12[A]/MCS_N/D5` | S# (1) |
| 主机输出 | `MO` / `WASDO` | **IO95** | `IOR11[B]/MO/D6` | DQ0 (5) |
| 主机输入 | `MI` / `WDATA0` | **IO96** | `IOR11[A]/MI/D7` | DQ1 (2) |
| 写保护 `W#` | — | — | — | pin3（经 R13 24.9 Ω）|
| `HOLD#` | — | — | — | pin7（经 R14 49.9 Ω）|

- 型号 `U6 = W25Q32JVSQ`，32 Mbit = **4 MByte**。
- **同一颗芯片既是配置 Flash 又是用户 SPI 从机**，所以这 4 根线接在 Gowin 的**专用配置脚**上。
- ⚠️ 用它们做用户 SPI 主控要小心：这几个脚兼作配置脚，**不要叠加冲突的 `IO_PORT` 属性**，也不要指望普通 `exclusive` 约束。原厂 `06_FLASH` 例程实测可用，说明用户逻辑复用是允许的。
- 与 `06_FLASH.cst`（`flash_clk=93` / `flash_cs=94` / `flash_datain=95` / `flash_dataout=96`）一致。
- **别混淆**：`programmer_cli --operation_index 6` 烧的是**片内 embFlash**；这颗**外部** W25Q32 要写数据得另写逻辑（或走 Programmer 的 external flash 选项）。

**JTAG（`J1`，9 pin 排针）**

| 信号 | FPGA 引脚 | 串阻 |
|---|---|---|
| TMS | **IO13** | R18 22 Ω |
| TCK | **IO14** | R15 22 Ω |
| TDI | **IO16** | R16 22 Ω |
| TDO | **IO18** | R17 22 Ω |

- 这 4 个是**专用 JTAG 脚，不可当 GPIO 用**（除非 `set_option -use_jtag_as_gpio 1`，代价是失去 JTAG 烧录/在线调试）。

**重新配置**
- `nCONFIG` 网络 → U7 pin20（`IOL13[B]/RECONFIG_N`），经 R19 22 Ω，R35 4.7 K 上拉到 D3V3。
  这是**重新加载配置**用的脚，**不是通用复位**。

**扩展接口**
- `P1` / `P2` = 各 27×2 排针（2.54 mm），带出绝大多数 IO 以及 `D3V3` / `GND`。
- 引脚号 ↔ 排针位号的完整对应表可用 §7.3 的抽取脚本从原理图重新生成。

### 3.6 可直接复用的 `.cst` 片段

```tcl
# ── 时钟 + 4 灯（最常用）──
IO_LOC "CLK_50M" 98 exclusive;
IO_PORT "CLK_50M" IO_TYPE=LVCMOS33 PULL_MODE=UP BANK_VCCIO=3.3;
IO_LOC "LED[0]" 27 exclusive;
IO_PORT "LED[0]" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;
IO_LOC "LED[3]" 30 exclusive;
IO_PORT "LED[3]" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;

# ── 4 个按键 ──
IO_LOC "KEY[0]" 75 exclusive;
IO_PORT "KEY[0]" IO_TYPE=LVCMOS33 PULL_MODE=UP BANK_VCCIO=3.3;
IO_LOC "KEY[3]" 99 exclusive;
IO_PORT "KEY[3]" IO_TYPE=LVCMOS33 PULL_MODE=UP BANK_VCCIO=3.3;

# ── 串口（IO12 发 / IO15 收）──
IO_LOC "UART_TX" 12 exclusive;
IO_PORT "UART_TX" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;
IO_LOC "UART_RX" 15 exclusive;
IO_PORT "UART_RX" IO_TYPE=LVCMOS33 PULL_MODE=UP BANK_VCCIO=3.3;

# ── I²C EEPROM（IO86 = SCL / IO85 = SDA，SDA 要双向）──
IO_LOC "SCL" 86 exclusive;
IO_PORT "SCL" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;
IO_LOC "SDA" 85 exclusive;
IO_PORT "SDA" IO_TYPE=LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3;

# ── 外部 SPI Flash（配置脚复用，别加 exclusive）──
IO_LOC "flash_clk" 93;
IO_LOC "flash_cs" 94;
IO_LOC "flash_datain" 95;
IO_LOC "flash_dataout" 96;
```

---

## 4. 编译（`gw_sh.exe`）

### 4.1 用法

```
gw_sh.exe <script.tcl> [arg1] [arg2] ...
```

脚本内用 `$argc` / `$argv` 取参数。注册了 **122 个 TCL 命令**，但**对每个命令都可以加 `-h` / `--help` 查权威用法**，这是最可靠的文档来源。

### 4.2 两条流程

**流程 A：打开已有工程（最省事，推荐）**

```tcl
open_project C:/path/to/MyProject.gprj
run syn        ;# 综合
run pnr        ;# 布局布线 + 生成码流
```

**流程 B：从零新建**

```tcl
create_project -name MyProj -dir C:/work -pn GW1N-UV9LQ144C6/I5 -device_version C -force
set_device GW1N-UV9LQ144C6/I5 -name GW1N-9C -device_version C
add_file C:/work/src/top.v
add_file C:/work/src/top.cst
set_option -top_module top
set_option -synthesis_tool gowinsynthesis
run syn
run pnr
saveto -all_options out.tcl     ;# 把当前工程全部选项导出成 tcl，便于复现
```

> `create_project -dir D` 会在 `D` 下**再建一层同名目录** `D\<name>\`，不是直接放在 `D` 里。

### 4.3 关键命令表

| 命令 | 说明 |
|---|---|
| `open_project <file.gprj>` | 打开工程。可用 `-pn` 覆盖器件 |
| `create_project -name X -dir D -pn <pn> -device_version <NA\|B\|C\|D> -force` | 新建工程 |
| `set_device <part number> [-name <name>] [-device_version <v>]` | 设置器件。同名多器件时用 `-name` 区分 |
| `add_file [-type <t>] [-disable] <file...>` | 加文件。**建议用绝对路径**；类型不指定则按扩展名自动判定 |
| `import_files -file <list> \| -dir <dir> \| -fileList <txt> [-force]` | 批量导入 |
| `rm_file` / `set_file_enable` / `set_file_prop -lib <library>` | 工程文件管理 |
| `set_option -<name> <value>` | 设置工程选项（见 4.4） |
| `run <syn\|pnr\|all>` | **`run` 只接受这三个进程名**。`all` = 综合 + 布局布线 + 码流，已验证可用 |
| `saveto [-all_options] <out.tcl>` | 导出工程信息为 tcl |
| `report_property` / `list_property` / `reset_option` / `set_property` / `set_csr` | 选项查询/复位 |
| `create_ipc` / `read_ipc` / `get_ips` / `generate_target` / `write_ip_tcl` | IP 核管理 |

**注意**：`get_project_files` **不存在**，别用。
**注意**：TCL 8.6 里**没有 `file name` 子命令**，取文件名要用 `file tail $path`（写错会中断整个 `foreach`）。

### 4.4 常用 `set_option` 选项（`set_option -h` 可看全表）

| 分类 | 选项 |
|---|---|
| 工程/顶层 | `-output_base_name`、`-top_module`、`-global_freq`、`-synthesis_tool`、`-include_path`、`-verilog_std v1995\|v2001\|sysv2017`、`-vhdl_std` |
| 综合 | `-frequency`、`-maxfan`、`-looplimit`、`-resource_sharing`、`-retiming`、`-symbolic_fsm_compiler`、`-default_enum_encoding default\|onehot\|gray\|sequential`、`-allow_duplicate_modules`、`-print_all_synthesis_warning`、`-write_apr_constraint` |
| 约束/IO | `-auto_constraint_io`、`-cst_warn_to_error`、`-use_jtag_as_gpio`、`-unused_pin default\|open_drain`、`-vccx`、`-vcc`、`-vccaux 2.5\|3.3` |
| 布局布线 | `-place_option 0..4`、`-route_option 0..2`、`-timing_driven`、`-clock_route_order`、`-route_maxfan`、`-correct_hold_violation`、`-inc_pnr 0\|auto\|file`、`-reg_in_iob` / `-ireg_in_iob` / `-oreg_in_iob` / `-ioreg_in_iob` |
| 码流 | `-bit_format txt\|bin`、`-bit_crc_check`、`-bit_compress`、`-bit_encrypt` / `-bit_encrypt_key`、`-bit_security`、`-bit_incl_bsram_init` |
| 上电配置 | `-bg_programming off\|jtag\|i2c\|internal\|goconfig\|…`、`-hotboot`、`-loading_rate`、`-wakeup_mode`、`-user_code default\|value`、`-spi_flash_addr`、`-multi_boot` / `-multiboot_*`、`-mspi_jump` / `-mspijump_*`、`-seu_handler` 系列 |
| 报告 | `-gen_sdf`、`-gen_io_cst`、`-gen_ibis`、`-gen_posp`、`-gen_text_timing_rpt`、`-gen_verilog_sim_netlist` |

### 4.5 产物与判据

| 产物 | 说明 |
|---|---|
| `impl\gwsynthesis\<顶层>.vg` | 综合后网表 |
| `impl\gwsynthesis\<顶层>_syn.rpt.html` | 综合报告 |
| `impl\pnr\<顶层>.fs` | **码流（`*.fs`）—— 编译成功的标志** |
| `impl\pnr\<顶层>.bin` / `.binx` | 二进制 / 带 CRC 的码流 |
| `impl\pnr\<顶层>.rpt.txt` | **布局布线报告**：资源占用、引脚表、时序。**最常读的文件** |
| `impl\pnr\<顶层>.pin.html` | 引脚分配可视化 |
| `impl\pnr\<顶层>.timing_paths` | 时序路径 |
| `impl\pnr\cmd.do` / `device.cfg` | 本次运行的实际参数（用于对比复现） |
| `impl\pnr\**ao_0.fs**` | **GAO 插入后的码流（注意顶层名变了！见第 6 节）** |

**成功判据**：退出码 0 + `impl\pnr\` 下出现 `.fs`。
**失败判据**：脚本输出里出现 `ERROR (` 或 `run` 抛异常。

### 4.6 常见非致命警告

```
WARN (TA1132) : 'CLK_50M' was determined to be a clock but was not created.
```
→ **工程没有 `.sdc` 时序约束文件**。功能不受影响，只是时序分析没有时钟定义。要消除它，加一个 `.sdc`：
```tcl
create_clock -name CLK_50M -period 20 -waveform {0 10} [get_ports {CLK_50M}]
```

```
WARN (EX3012) : Empty statement in sequential block(...)
WARN (EX3791) : Expression size 32 truncated to fit in target size 8(...)
```
→ 例程源码本身的写法问题，**原 IDE 工程编译时也会出现**，可忽略。

```
WARN (PA1015) : Signal 'CLK_50M' captured in GAO is replaced by 'CLK_50M_d'
```
→ 仅在使用 GAO 时出现，属正常的延后取样处理。

### 4.7 实测基线数据（可作为回归对比）

6 个官方例程，`BATCH SUMMARY: TOTAL=6 SUCCESS=6 FAILED=0`：

| 例程 | 顶层模块 | Logic | Register | 码流 |
|---|---|---|---|---|
| 01_LED_Run | `LED_Run` | 16/8640 | 11/6843 | 2,070,606 B |
| 02_LED_Flash | `LED_Flash` | 71/8640 | 39/6843 | 2,070,584 B |
| 03_Key_FallEage | `Key` | 4/8640 | 0 | 2,070,584 B |
| 04_UART | `Uart` | 84/8640 | 69/6843 | 2,070,584 B |
| 05_EEPROM | `EEPROM` | 211/8640 | 39/6843 | 2,070,584 B |
| 06_FLASH | `Flash` | 199/8640 | 106/6843 | 2,070,584 B |
| 07_LED_Flow（自制四灯流水灯） | `LED_Run` | 40/8640 | 27/6843 | 2,070,606 B |

> **`.fs` 逐字节对比的结论**：同一份源码、同一套参数，两次构建出的 `.fs` **字节不完全相同**（差十几字节），差异来自码流内嵌的**路径与时间戳元数据**；但 `impl\pnr\cmd.do` 与 `device.cfg` **逐行完全一致**。
> → **判断两次构建是否等价，要对比 `cmd.do` / `device.cfg` 和资源报告，而不是比对 `.fs` 的哈希。**

---

## 5. 烧录（`programmer_cli.exe`）

### 5.1 命令

```powershell
# 扫描 JTAG 链
& "$env:GOWIN_HOME\Programmer\bin\programmer_cli.exe" --scan

# 烧到 SRAM（掉电丢失，调试用）
& "$env:GOWIN_HOME\Programmer\bin\programmer_cli.exe" --device GW1N-9C `
    --operation_index 2 --fsFile .\impl\pnr\LED_Run.fs

# 烧到片内 embFlash（掉电保持）
& "$env:GOWIN_HOME\Programmer\bin\programmer_cli.exe" --device GW1N-9C `
    --operation_index 6 --fsFile .\impl\pnr\LED_Run.fs --frequency 2.5MHz
```

### 5.2 `operation_index` 速查

| index | 操作 | 掉电保持 |
|---|---|---|
| 2 | SRAM Program | ✗ |
| 4 | SRAM Program and Verify | ✗ |
| 6 | embFlash Erase, Program, Verify | ✓ |
| 9 | exFlash Erase, Program, Verify（外部 SPI Flash） | ✓ |
| 36–39 | thru GAO-Bridge 系列 | — |

### 5.3 判据与坑（**非常重要**）

1. **`programmer_cli.exe` 的退出码不可靠——失败时仍可能返回 0。判据必须看控制台文本：**
   - 成功：出现 `Finished.`，以及（带 Verify 的操作）`Verify Success` / `Program Finished!`
   - 还会打印 `User Code is: 0x…`、`Status Code is: 0x…`、`Cost N second(s)`
2. **`--output <file>` 参数实测不产生文件** → 要保存输出必须用重定向抓 stdout。
3. **`operation_index 4`（SRAM Program and Verify）在本器件上恒定报 `Error: Verify failed of at 0`**，但紧随其后 `Status Code = 0x0001F020`、`User Code` 正常 —— 实际已烧成功。**所以 SRAM 默认用 index 2（不带 Verify）**。
4. 实测成功样例：
   ```
   Operation "SRAM Program" for device#1...   100%
   User Code is: 0x00008DC1
   Status Code is: 0x0001F020
   Finished.
   Cost 3.34 second(s)
   ```
5. 必须**板子上电 + Gowin USB Cable(FT2CH) 接在板子的 JTAG 口**。链上找不到器件时报 `No Gowin devices found`。

---

## 6. 在线仿真：GAO 在线逻辑分析仪

> 高云语境下的「在线仿真」= **GAO（Gowin Analyzer Oscilloscope）**：FPGA 运行时用未使用的片内存储资源，按触发条件实时存信号，再通过 JTAG 读回显示。
>
> ⚠️ **RTL 功能仿真（ModelSim 波形）在本机不可行**：未安装 ModelSim/Questa（`where vsim` 退出码 1），`IDE\simlib` 只是空壳。

### 6.1 原理

GAO 内核 = **控制内核**（`GW_CON`，所有功能内核与 JTAG 扫描电路之间的通信控制器）+ **功能内核**（`GW_AO_0..15`，触发配置/采集/存储）。
IP 源码模板在 `IDE\data\ipcores\GAO\` 与 `IDE\data\ipcores\GAO_LITE\`。

两种模式：
- **Standard Mode**：最多 16 个功能内核；可配触发端口、触发等级、匹配单元；支持静态/动态触发表达式。
- **Lite Mode**：**无需触发条件**，可捕获初始值，用来看**上电瞬间**的状态。

触发匹配单元的 `Value` 支持 `X / 0 / 1 / R / F / B / N`（`R`=上升沿、`F`=下降沿、`B`=双边沿、`X`=任意）。

### 6.2 **关键：GAO 核是工具链自动插入的，不用手写例化**

只要工程里挂了 `.gao` 文件，**`run pnr` 阶段会自动插入 GAO 核**，日志里会出现：

```
Generating Post-Synthesis GAO
Post-Synthesis GAO generation finish
Parsing netlist file ".../impl/gao/gao.v" completed
```

自动生成的文件：
| 文件 | 说明 |
|---|---|
| `impl\gao\gao.v` | GAO 网表（`pragma protect` 加密，约 215 KB） |
| `impl\gao\gw_gao_top.v` | GAO 顶层包装 |
| `impl\gao\ao_0\gw_ao_parameter.v` | **从 `.gao` 解析出的参数，可用来验证配置是否正确** |
| `impl\pnr\ao_0.fs` | **合并后的码流** |

### 6.3 ⚠️ **码流文件名会变：`<顶层>.fs` → `ao_0.fs`**

这是 SUG114 §3.1 的官方定义：*「生成一个包含用户设计与 GAO 配置信息的码流文件，文件名默认为 `ao_0.fs`，默认放置在工程路径下的 `/impl/pnr/`」*。

→ **加了 GAO 之后，`impl\pnr\` 里不会再生成 `<顶层>.fs`，只有 `ao_0.fs`（约 3.5 MB）。**
→ **`impl\pnr\ao_0.fs` 出现 = GAO 插入成功的官方标志。** 烧录时也要烧 `ao_0.fs`。

验证配置是否被正确解析，看 `impl\gao\ao_0\gw_ao_parameter.v`（实测样例）：
```verilog
SIG_PORT_WIDTH  = 29        // 25 (cnt) + 4 (LED)
STORAGE_DEPTH   = 1024
MEM_DATA_WIDTH  = 30
MATCH_EN_0      = 1
MATCH_TYPE_0    = 3'b001
CAPTURE_TRIG_0  = 1
MATCH_EN_1..15  = 0
```

### 6.4 `.gao` 配置文件写法

**它是工程里的普通设计文件**，用 Design 窗口右键 New File…（New GAO Wizard）创建，或直接**手写 XML**（已实测可行）。
**扩展名由捕获信号来源决定**：`For RTL Design`（综合优化前 RTL 信号）→ **`.rao`**；`For Post-Synthesis Netlist`（综合后网表信号）→ **`.gao`**。

> 实测中用 RTL 名（`cnt`、`LED`）写 `.gao`（综合后路线）**也是可以的** —— `cnt[24:0]` 无任何 WARN，直配成功；`CLK_50M` / `LED[*]` 会被工具链替换成内部网名并给出 `WARN (PA1015)`，属正常。

**可直接复用的 `.gao` 模板**（把信号名换成你的）：

```xml
<?xml version="1" encoding="UTF-8"?>
<GAO_CONFIG>
    <Version>3.0</Version>
    <Mode>Standard</Mode>
    <AoCore index="0" sample_clock="CLK_50M" trig_type="0"
            storage_depth="1024" window_num="1" capture_amount="1024"
            implementation="0" trigger_pos="0" module_name="LED_Run"
            force_trigger_by_falling_edge="false" capture_init_data_enabled="false">
        <SignalList>
            <Bus capture_enable="true" name="cnt[24:0]">
                <Signal>cnt[24]</Signal>
                <!-- … 每一位一行，直到 cnt[0] … -->
                <Signal>cnt[0]</Signal>
            </Bus>
            <Bus capture_enable="true" name="LED[3:0]">
                <Signal>LED[3]</Signal>
                <Signal>LED[2]</Signal>
                <Signal>LED[1]</Signal>
                <Signal>LED[0]</Signal>
            </Bus>
        </SignalList>
        <Triggers>
            <Trigger index="0">
                <SignalList><Signal>cnt[0]</Signal></SignalList>
            </Trigger>
            <Trigger index="1"/>
            <!-- … index 2..15 全部自闭合 … -->
            <Trigger index="15"/>
        </Triggers>
        <MatchUnits>
            <MatchUnit index="0" enabled="1" match_type="1" counter_enable="0"
                       counter_width="2" counter="2" countinuous="0" func="0"
                       value0="R" value1="0" trigger="0"/>
            <MatchUnit index="1" enabled="0" match_type="0" counter_enable="0"
                       counter_width="2" counter="2" countinuous="0" func="0"
                       value0="" value1=""/>
            <!-- … index 2..15 同样自闭合 … -->
        </MatchUnits>
        <Expressions type="Static">
            <Expression>M0</Expression>
        </Expressions>
    </AoCore>
    <GAO_ID>0100010111110010</GAO_ID>
</GAO_CONFIG>
```

要点：
- `<Bus>` 必须**每一位单独一行**。
- `<Triggers>` / `<MatchUnits>` **必须各写满 16 个**（未用的自闭合）。
- `sample_clock` 必须是设计中**真实存在**的信号，且要求与触发/采样信号是 **2 倍频及以上**关系，建议同一时钟域。
- `storage_depth` 可选 4 / 8 / 16 / 32 / … / 65536；`capture_amount` ≤ `storage_depth`；`window_num` ≤ `storage_depth/4`。
- `implementation`：BSRAM / SSRAM / REG（只有 `storage_depth × (信号数+1) ≤ 512` 才能用 REG）。
- **不存在的信号会被配置窗口标红**；所以信号名必须与设计一致。

然后在 `.gprj` 里挂上：
```xml
<File path="src/LED_Run.gao" type="file.gao" enable="1"/>
```

### 6.5 完整 GAO 流程（实测通过）

```powershell
$env:GOWIN_HOME = 'C:\Gowin\Gowin_V1.9.12.02_SP2_x64'
$env:PATH = "$env:GOWIN_HOME\IDE\bin;$env:GOWIN_HOME\Programmer\bin;$env:PATH"
$base = 'C:\Users\lishuo\Documents\deepseek-harness\default-workspace\gowin-build\gao'

# ── 步骤 1：编译（GAO 核在这一步被自动插入）──
# build_gao.tcl: open_project <gprj>; run syn; run pnr
& "$env:GOWIN_HOME\IDE\bin\gw_sh.exe" "$base\build_gao.tcl"
# 判据：impl\pnr\ao_0.fs 出现（3,558,506 B）

# ── 步骤 2：把 GAO 码流烧进 SRAM ──
& "$env:GOWIN_HOME\Programmer\bin\programmer_cli.exe" --device GW1N-9C `
    --operation_index 2 --fsFile "$base\impl\pnr\ao_0.fs"

# ── 步骤 3：拉起采集界面 ──
#    ⚠️ cwd 必须是 IDE\bin！⚠️ -series 和 -device 必须同时给！
Set-Location "$env:GOWIN_HOME\IDE\bin"
$g = Start-Process '.\gao_analyzer.exe' -PassThru -ArgumentList @(
        '-gao',"$base\src\LED_Run.gao", '-series','GW1N', '-device','GW1N-9C',
        '--fsFile',"$base\impl\pnr\ao_0.fs")
# 出现窗口 'Gowin Analyzer Oscilloscope'；gao_analyzer 会自己拉起 jtagserver.exe

# ── 步骤 4：远程驱动界面（UIA + PostMessage，见 6.6）──
& "$base\click_btn.ps1"  -TargetPid $g.Id -Name 'Start'         # 开始采集
& "$base\click_btn.ps1"  -TargetPid $g.Id -Name 'Export'        # 打开导出对话框
& "$base\export_wave.ps1" -TargetPid $g.Id -Dir "$base\impl\wave" `
      -Name 'LED_Run' -Format csv -Period '20' -PeriodUnit 'ns'

# ── 步骤 5：校验波形 ──
& "$base\verify_wave.ps1" -Csv "$base\impl\wave\LED_Run_core0.csv"
```

**采集成功的证据**（用 `uia_dump.ps1` 读界面）：
```
TabItem 'core 0'                    ← 标签页从 Configuration 切到 core 0
TreeItem 'cnt[24:0]' = '1494A77'    ← 信号树里出现真实值
TreeItem 'LED[3:0]'  = 'B'
Go to Cursor / Go to Time 0 / Previous Transition …  ← 由 disabled 变 enabled（仅在无数据时禁用）
```
状态文案只有两档：`Please program the device first`（未烧录）→ `Ready to acquire`（可以采）。

### 6.6 三个非显然的技术要点

1. **Qt 的 UIA `InvokePattern` 对「会弹出模态框的动作」会死锁**
   `Export` 按钮用 `Invoke()` 会抛 `0x80131505` 并阻塞 180 s。
   → 改用 **`PostMessage(hwnd, WM_LBUTTONDOWN/UP, …, lParam)` 投递鼠标点击**，走正常 Qt 事件循环，不阻塞、窗口在后台也有效。

2. **坐标要用缩放比换算**（本机 DPI 150%）
   `scale = UIA矩形 / Win32矩形`，再用 `ClientToScreen(0,0) * scale` 得到客户区原点。

3. **工具栏按钮会被窗口宽度裁掉**
   窗口太窄时 `Export` 按钮**根本不在 UIA 树里**。先用 `MoveWindow` 把窗口放大到 1900×1000，按钮才出现（`en=True`）。

### 6.7 波形导出与解析

- 支持 **`*.csv` / `*.vcd`(Value Change Dump) / `*.prn`(Tab 分隔) / `*.gwd`(Gowin Waveform Data)** 四种格式。
- **默认导出目录 `impl\wave\`**（相对 `.gprj`），文件名会被自动加 `_core0` 后缀。
- 文档 §5 说明：`csv` / `prn` 可导入 Matlab，**`vcd` 可导入 ModelSim**。
- **CSV 结构**（可直接用脚本解析）：
  ```
  Groups:
  cnt[24:0] =, cnt[24], cnt[23], …, cnt[0], ,
  LED[3:0] =, LED[3], LED[2], LED[1], LED[0], ,
  Data:
  <time unit:…>
  <列标题行>
  0, 1494A77, 1,0,1,0,0,1,…, B, 1,0,1,1,
  …（1024 行，每行一拍）
  ```
  第 1 列是时间，第 2 列是 bus 的十六进制值，其后是每一位，bus 列后又重复一遍每一位。

**实测校验结果**（`verify_wave.ps1`，两次采集都是 1024 数据点、0 problems）：

| | 首点 cnt | 末点 cnt | Δ | LED |
|---|---|---|---|---|
| 第 1 次 | `1494A77` | `1494E76` | 1023 | `B`(1011) ×1024 |
| 第 2 次 | `0C2AACB` | `0C2AECA` | 1023 | `E`(1110) ×1024 |

两次数据完全不同 → **是实时采样，不是静态回放**。

> ⚠️ **导出 CSV 的时间轴单位来自 Export 对话框的 `Clock period` 默认值（默认 1 us），不是采样时钟的真实周期（20 ns）**。这只影响 time 列的标注，**采样数据本身是正确的**。

### 6.8 唯一没能全自动的一步

Export 对话框里把格式从 CSV 切成 VCD。Qt 的 `QComboBox` 下拉项在这个 build 里是**脱离真实弹窗的抽象对象**（`List` rect 为空、`ListItem` rect 全是 `0,0,795,20`），`SelectionItemPattern.Select()` 报 `selected=True` 但读回不变，`Invoke` / `ValuePattern.SetValue` / `Expand` / PostMessage 点击全部无效；键盘 `VK_DOWN` 因窗口在后台拿不到焦点。

→ **不把窗口切到前台就无法远程切这个 ComboBox。** 折中方案是导出 **CSV（官方支持格式）**。

### 6.9 ❌ `gao_sh.exe` 是死路（别再浪费时间）

- 它的**第一个位置参数必须是 `.gao` 文件**；传 `-h` 或 `.tcl` 只回 `Error: invalid gao file.`。
- **只要 `argv[1]` 是字面量 `-gao`，无论后面跟什么参数**（11 组矩阵实测：`--scan` / `--scan-cables` / `--device` / `--fsFile` / `-out` / `-local` / `--frequency` / `--operation_index 36` …），都只打印 `Start running GAO analyzer.` 然后**永久挂死**，stderr 恒空。
- 定向实验（`diag_pipe_connect.ps1`）证明：**它从未连接 `\\.\pipe\gao1`**（12 s 内 jtagserver stdout 始终 0 行），TCP 也无任何 socket；而它自己拉起的 `jtagserver.exe -local` 与命名管道都真实存在。
- → **卡点在 `gao_sh.exe` 进程内部、发生在「连 jtagserver」之前。** 官方自带例程的 `.gao` 行为一致。**结论：放弃。官方文档 SUG114 也从未提到 `gao_sh.exe`。**

### 6.10 旁路：`jtagserver.exe` 协议（仅供了解，未走通）

`jtagserver.exe` 是 **PyInstaller 打包的 Python 3.6 + Qt 程序**。它自建的命名管道 `gao1`（同时监听 TCP 36548）上跑的是：

- 4 字节大端长度 + `QDataStream(Qt_4_8)` 序列化的 `QVariantMap`
- 键：`CMD` / `RES` / `DATA`
- 命令值：`OPEN` / `QUERY` / `CLOSE` / `WRITE` / `READ` / `GAO_STOP`
- 分别派发到 `Server.gaoOpenDevice` / `gaoQueryDevice` / `gaoCloseDevice` / `gao_write` / `gao_read`；`gaoOpenDevice` **必须带 `cable_index`**
- 横幅版本：`GOWIN JTAG Server Version 3.7.6` / `Listening on Port: 36548`

（那份 `Error: 'cable_index' @ gaoOpenDevice` 其实是 Python 的 `KeyError('cable_index')`。）

→ 理论上可以自研无头采集，但 **GAO 核寄存器时序在服务端之外**，成本过高，**已放弃**。

---

## 7. 可复用脚本清单

全部在 `C:\Users\lishuo\Documents\deepseek-harness\default-workspace\gowin-build\`。

### 7.1 编译与烧录

| 脚本 | 用途 | 用法 |
|---|---|---|
| `gowin_cli_build.tcl` | 通用编译入口 | `gw_sh.exe gowin_cli_build.tcl <proj.gprj> [syn\|pnr\|all]` |
| `gowin_build.ps1` | 上面那个的 PowerShell 封装（自动设环境变量、过滤 alog 噪声、透传退出码） | `.\gowin_build.ps1 -Project <gprj> -Task all` |
| `build_all.tcl` | 批量编译多个 `.gprj` | `gw_sh.exe build_all.tcl <gprj1> <gprj2> …` |
| `build_existing.tcl` | 打开已有工程重跑 syn + pnr | `gw_sh.exe build_existing.tcl <gprj>` |
| `build_07_desktop.tcl` | 示例：直接构建桌面工程 | `gw_sh.exe build_07_desktop.tcl` |
| `flash_led_run.ps1` | 烧录四灯流水灯码流 | `.\flash_led_run.ps1 [-Target sram\|emb\|ext] [-Scan]` |

### 7.2 GAO 在线调试（在 `gowin-build\gao\`）

| 脚本 | 用途 |
|---|---|
| `build_gao.tcl` | 编译带 GAO 的工程（`open_project` → `run syn` → `run pnr`） |
| `uia_dump.ps1` | `-TargetPid <pid> [-OutFile <txt>]` 把窗口的完整 UIA 树 dump 出来（能穿透 Qt 控件） |
| `uia_act.ps1` | `-TargetPid <pid> -Name <名> [-Type <ControlType>] -Action list\|click\|select\|toggle\|readstate` |
| `click_btn.ps1` | `-TargetPid <pid> -Name <按钮名> [-WindowTitle <标题>]` **PostMessage 点击按钮**（避开 InvokePattern 死锁） |
| `click_el.ps1` | 同上但可点任意元素（按 AutomationId / Name / ControlType） |
| `export_wave.ps1` | `-TargetPid <pid> -Dir <目录> -Name <名> -Format csv\|vcd\|prn\|gwd -Period <值> -PeriodUnit us\|ns\|ps` 填 Export 对话框并点 OK |
| `verify_wave.ps1` | `-Csv <csv路径>` 逐行校验导出的波形 |
| `diag_pipe_connect.ps1` | 诊断脚本：证明 `gao_sh` 从不连接 jtagserver（死路结论的证据） |

### 7.3 文档 / 原理图处理

| 脚本 | 用途 |
|---|---|
| `pdf_extract.py` | **纯 Python 无依赖 PDF 文本抽取器**（FlateDecode + ObjStm + Type0/Identity-H 的 ToUnicode CMap）。用法 `python pdf_extract.py <in.pdf> <out.txt>` |
| `sch_render.py` | 用 PyMuPDF 把 PDF 页渲染成 PNG（可裁剪区域）。`python sch_render.py <in.pdf> <out.png> --page N --dpi 400 --crop x0,y0,x1,y1`（crop 用 0~1 分数）；`--info` 看页尺寸/文本量，`--text` 直接打印文本 |
| `sch_find.py` | **按关键字定位并放大截图**（读原理图最省事的办法）。`python sch_find.py <in.pdf> <out.png> <token> --page N --pad 120 --dpi 420` |

> ⚠️ `pdf_extract.py` 对本板原理图**抽不出文本**（该 PDF 的字体它解不了，输出全空）→ **原理图一律走 PyMuPDF**。
> 但 PyMuPDF 抽出的原理图文本**顺序是乱的、且丢失连线关系**：靠它只能拿到元件/网络名清单，**判断"哪个网络接哪个引脚"必须靠截图**（`sch_find.py`）或与例程 `.cst` 交叉验证。
> ⚠️ `pdf_extract.py` 抽取缺陷：破折号被映射成字母 `J`（`-gao` 显示成 `gaoJ`、`SUG114-3.4.3` 显示成 `SUG114J3.4.3`），部分图形化字体被吞（`GAO`→`dl`）。阅读时需自行还原。

**PyMuPDF 安装**：本机 python 是 uv 托管的（`pip install` 报 `externally-managed-environment`）。
已建好虚拟环境 `gowin-build\.venv\`，用 `gowin-build\.venv\Scripts\python.exe` 调用上述脚本。
（重建：`python -m venv .venv; .venv\Scripts\python.exe -m pip install pymupdf`）

---

## 8. 陷阱总清单（按踩坑频率排序）

1. **LED 低电平点亮** —— 复位值写成 `4'b1111` 会导致「四颗灯全灭」。写 `0` 才亮。（本工程实际踩过，浪费了一整轮上板验证）
2. **加了 GAO 后码流改名 `ao_0.fs`**，`impl\pnr\` 下不再有 `<顶层>.fs`。别再去找旧名。
3. **`programmer_cli.exe` 退出码不可靠**，判据看控制台文本里的 `Finished.` / `Verify Success`。
4. **`operation_index 4` 恒报 `Verify failed`（假失败）**，SRAM 用 index 2。
5. **`gao_analyzer.exe` 要求 cwd = `IDE\bin`**，且 `-series` + `-device` **必须同时给**（缺一个弹 `Can not set device.`）。参数写 `--fsFile`（不是文档里的 `-fs`）。
6. **`gao_sh.exe` 是死路**，别再试任何参数组合。
7. **`Get-Content` 读 UTF-8 文件要加 `-Encoding UTF8`**，否则误判文件编码坏掉。
8. **PS 5.1 执行策略 Restricted** —— 跑 `.ps1` 先 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。
9. **`gw_ide.exe` 不能当 CLI**，会挂住。
10. **`create_project -dir D` 会多建一层目录** `D\<name>\`。
11. **TCL 没有 `file name` 子命令**，用 `file tail`；**没有 `get_project_files`**。
12. **不要用 `gw_sh.exe` 的 stderr 判断失败** —— `alog error: failed to open log file` 是无害噪声。
13. **不要用 `.fs` 哈希判断构建等价性** —— 内嵌路径/时间戳会变；要比 `cmd.do` / `device.cfg` / 资源报告。
14. **Qt 的 UIA `InvokePattern` 会死锁**（模态框动作），用 PostMessage 投递鼠标事件。
15. **窗口太窄会裁掉工具栏按钮**（按钮不出现在 UIA 树里），先 `MoveWindow` 放大。
16. **DPI 缩放**：UIA 是物理像素、Win32 是虚拟像素，换算必须乘缩放比。
17. **想解析二进制里的命令名**：对 GB 级 DLL 提取字符串纯属噪声（`gowin.dll` 有 137 万条）。**正确做法是对每个 TCL 命令跑 `-h`**。
18. **Bank 电压本板是 3.3 V** —— 原厂 `03_Key_FallEage` / `04_UART` / `06_FLASH` 的 `.cst` 里写的是 `BANK_VCCIO=1.8`，与本板（四个 Bank 由 0 Ω 电阻接 `D3V3`）不符。**写 `IO_TYPE=LVCMOS33 ... BANK_VCCIO=3.3`**，已硬件验证。
19. **丝印 "POWER" 那颗灯不受 FPGA 控制** —— 它是 `D5V` 上的电源指示灯（R5 1 K）。受控的是接在 `IO27~IO30` 上的另外四颗。
20. **`RST_N = IO75 = KEY1`，是按键不是复位芯片** —— 本板没有专用复位脚。上电后 IO75 被 10 K 上拉为高，**不会自动产生低脉冲**；设计若依赖"上电复位"必须自己写。
21. **`IO93~IO96` 既是外部 Flash 的 SPI，又是 Gowin 的专用配置脚** —— 可以给用户逻辑复用（`06_FLASH` 实测可行），但**别加 `exclusive`、别叠加冲突的 `IO_PORT` 属性**。
22. **`pdf_extract.py` 啃不动本板原理图**（输出全空）—— 改用 PyMuPDF 走 `sch_render.py` / `sch_find.py` 截图读；**原理图抽取出的文本顺序不可信**，引脚归属要靠截图或与例程 `.cst` 交叉验证。

---

## 9. 文档入口

| 文档 | 路径 | 内容 |
|---|---|---|
| SUG1220 | `IDE\doc\CN\SUG1220-1.1_Gowin云源软件Tcl命令用户指南.pdf` | **TCL 命令权威手册** |
| SUG114 | `IDE\doc\CN\SUG114-3.4.3_Gowin在线逻辑分析仪用户指南.pdf` | **GAO 权威手册**（58 页） |
| SUG1189 | `IDE\doc\CN\SUG1189-1.4.2_Gowin虚拟输入输出调试工具用户指南.pdf` | GVIO |
| SUG918 | `IDE\doc\CN\SUG918-2.0_Gowin云源软件快速入门指南.pdf` | §3.11/3.12 GAO+GVIO 联合调试 |
| SUG100 | `IDE\doc\CN\SUG100-4.4.5_Gowin云源软件用户指南.pdf` | IDE 总用户指南 |
| SUG550 / SUG940 / SUG935 | 同目录 | GowinSynthesis / 时序约束 / 物理约束 |
| SUG502 | 同目录 | Programmer |
| **本板原理图** | `C:\Users\lishuo\Documents\BOOK\FG202 GW1N-UV9LQ144 核心板原理图.pdf` | **板级接线权威来源**（LED/按键/UART/EEPROM/SPI Flash/JTAG/时钟/电源）→ 已整理成 §3.4~§3.6 |

> 💡 **`C:\Users\lishuo\Documents\BOOK\` 里有比 IDE 安装目录更新版本的高云文档**，查资料优先去这里：
> `SUG114-3.5`（GAO）、`SUG1220-2.1`（Tcl）、`SUG1189-1.4.3`（GVIO）、
> `SUG1541-1.0_Gowin云源软件物理约束用户指南.pdf`、`SUG283-3.6.1_Gowin原语用户指南.pdf`、
> `UG114-1.5_GW1N-9器件Pinout手册.pdf`、`SUG100-4.4.7`、`DS100-3.3.3`。
> （该目录与 `C:\Users\李硕\Documents\BOOK\` 是同一个位置，两个用户名指向同一处。）

已抽取为文本（便于 grep）：`doc_SUG114_CN.txt`、`doc_SUG1189_CN.txt`、`doc_SUG918_CN.txt`、`doc_FG202_sch.txt`（原理图，仅元件/网络名清单，不含连线关系）。
**英文版 SUG114 的字体没有 ToUnicode，抽出来是乱码，不可用。**

---

## 10. 未验证 / 后续可做

- [ ] **RTL 功能仿真**：本机无 ModelSim/Questa，不可行。若将来安装，可生成 `-gen_verilog_sim_netlist` + SDF 做时序仿真。
- [ ] **`.sdc` 时序约束**：目前所有工程都没有，导致 `WARN (TA1132)`。补 `create_clock` 后时序报告才有意义。
- [ ] **GAO 导出的 VCD/GWD 格式切换**：受限于 Qt ComboBox 无法后台操作；把窗口切到前台或许可行。
- [ ] **封装 `gao_capture.ps1 -Signal <名> -Depth <N>`**：把 6.5 的五步合成一条命令。
- [ ] **GVIO（虚拟输入输出）**：`gvio_analyzer.exe` 参数与 GAO 同构（`-gvio` / `-gao` / `-dir` / `-series` / `-device` / `-fs`），可在没有物理激励源时给设计注入信号 —— **未实测**。
- [ ] **`gao_sh.exe`**：已定性为死路，不再尝试。
- [ ] **外部 SPI Flash 烧录**（`operation_index 9`）：脚本里已写，**未实机验证**。
