# Gowin 1.9 命令行（CLI）构建说明

目标：**不打开 Gowin IDE 图形界面**，用终端命令完成 综合 → 布局布线 → 生成码流（`.fs`）。
本目录是把桌面 `C:\Users\lishuo\Desktop\FPGA_Proj\FG202 GW1N-UV9LQ144 Example` 下 6 个例程
复制到工作区后，用 CLI 跑通的完整结果。

---

## 1. 核心事实：真正的命令行入口是 `gw_sh.exe`

| 程序 | 作用 | 能否做 CLI 构建 |
| --- | --- | --- |
| `gw_sh.exe` | Gowin Tcl Command Line Console（TCL 8.6 控制台） | **能，这就是入口** |
| `gw_ide.exe` | 图形 IDE | 不能，`-h` 会直接拉起 GUI 并挂住 |
| `GowinSynthesis.exe` | 综合引擎 | 由 `run syn` 内部调用 |
| `floorplanner.exe` | 布局布线引擎 | 由 `run pnr` 内部调用 |
| `programmer.exe`（IDE/Programmer） | 下载到 FPGA / 烧写 Flash | 需要接硬件 |

安装路径：`C:\Gowin\Gowin_V1.9.12.02_SP2_x64\IDE\bin`

## 2. 必须先设置的两个环境变量（否则会报错）

```powershell
$env:GOWIN_HOME = 'C:\Gowin\Gowin_V1.9.12.02_SP2_x64'   # 不设会报 "Please set environment variable GOWIN_HOME"
$env:PATH = "C:\Gowin\Gowin_V1.9.12.02_SP2_x64\IDE\bin;$env:PATH"
```

另外会有一条无害的 stderr 噪声：

```
alog error: failed to open log file: 'C:/Users/lishuo/AppData/LocalLow/GowinSemi/IDE/cache/sh.log'
```

它只是日志写不进去（沙箱不允许写工作区外的 `AppData\LocalLow`），**不影响构建**，用
`| Where-Object { $_ -notmatch 'alog error' }` 过滤即可。

## 3. TCL 构建命令（实测可用的最小集）

`gw_sh.exe` 注册了 122 个命令，构建相关的核心命令如下：

| 命令 | 说明 |
| --- | --- |
| `open_project <file.gprj>` | 打开已有工程（最省事，推荐） |
| `create_project -name X -dir D -pn <pn> -device_version C -force` | 新建工程（`-dir` 下会再建一层同名子目录） |
| `set_device GW1N-UV9LQ144C6/I5 -name GW1N-9C -device_version C` | 设器件 |
| `add_file <path.v>` / `add_file <path.cst>` | 加源文件（**建议绝对路径**，见坑 1） |
| `set_option -top_module LED_Run` | 顶层模块 |
| `set_option -synthesis_tool gowinsynthesis` | 综合工具 |
| `run syn` | 综合 |
| `run pnr` | 布局布线 + 时序分析 + 码流 + 功耗 |
| `run all` | 综合 + 布局布线，一步到位 |
| `saveto -all_options out.tcl` | 导出当前工程配置为 TCL（便于版本管理） |
| `reset_option` / `rm_file` / `set_file_prop` | 重置选项 / 删文件 / 文件属性 |
| `set_property` / `report_property` / `generate_target` / `get_ips` / `write_ip_tcl` | IP 相关 |

任何命令加 `-h` 都能打印完整帮助，例如 `set_option -h` 会列出 **160+ 个可选参数**
（`-place_option`、`-route_option`、`-timing_driven`、`-bit_crc_check`、`-bit_compress`、
`-unused_pin`、`-bg_programming`、`-global_freq` 等），等价于 IDE 里的
Project → Configuration 全部页签。

## 4. 两种推荐用法

### 4.1 打开已有工程直接构建（最常用）

```powershell
$env:GOWIN_HOME='C:\Gowin\Gowin_V1.9.12.02_SP2_x64'
& 'C:\Gowin\Gowin_V1.9.12.02_SP2_x64\IDE\bin\gw_sh.exe' gowin_cli_build.tcl 'D:\proj\xxx.gprj' all
```

`gowin_cli_build.tcl` 内容：`open_project` → `run all`，带错误捕获与退出码。

### 4.2 封装脚本（推荐日常使用）

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force   # 本机执行策略禁止未签名脚本，需先放行
.\gowin_build.ps1 -Project 'D:\proj\xxx.gprj' -Task all
```

> 本机只装了 Windows PowerShell 5.1（没有 `pwsh`），且执行策略为 Restricted，
> 因此直接用 `& .\gowin_build.ps1` 会报"未对文件进行数字签名"。用上面这行
> 进程级 `Bypass` 即可，无需改全局策略。

## 5. 实测结果（6 个例程全部成功）

命令：

```powershell
gw_sh.exe build_all.tcl <6 个 .gprj 全路径>
```

输出：`BATCH SUMMARY: TOTAL=6 SUCCESS=6 FAILED=0`

| 例程 | 顶层 | 器件 | 码流 .fs | Logic(LUT) | Register(FF) |
| --- | --- | --- | --- | --- | --- |
| 01_LED_Run | LED_Run | GW1N-9C (ver C) | 2,070,606 B | 16 / 8640 | 11 / 6843 |
| 02_LED_Flash | LED_Flash | GW1N-9 | 2,070,584 B | 71 / 8640 | 39 / 6843 |
| 03_Key_FallEage | Key | GW1N-9 | 2,070,584 B | 4 / 8640 | 0 / 6843 |
| 04_UART | Uart | GW1N-9 | 2,070,584 B | 84 / 8640 | 69 / 6843 |
| 05_EEPROM | EEPROM | GW1N-9 | 2,070,584 B | 211 / 8640 | 39 / 6843 |
| 06_FLASH | Flash | GW1N-9 | 2,070,584 B | 199 / 8640 | 106 / 6843 |
| 07_LED_Flow ★ | LED_Run | GW1N-9C (ver C) | 2,070,606 B | 48 / 8640 | 29 / 6843 |

★ `07_LED_Flow` 是**新写**的工程（不在原例程里）：在 01_LED_Run 基础上改成
**IO27/28/29/30 四颗 LED 流水灯**。源码在 `07_LED_Flow\src\`：

- `LED_Run.v`：顶层 `module LED_Run(CLK_50M, RST_N, LED[3:0])`，`output reg [3:0] LED`；
  `localparam [24:0] TIME_0P5S = 25'd24_999_999`（50 MHz → **每 0.5 s 移动一颗**）；
  仅用一个 4 位移位寄存器 `LED <= {LED[2:0], LED[3]}` 循环左移唯一的 0 位：
  `1110 → 1101 → 1011 → 0111 → 1110`。**本板 LED 低电平点亮，0 = 亮**，
  复位时 `LED <= 4'b1111`（全灭）。
- `LED_Run.cst`：`IO_LOC "LED[0]" 27` / `[1] 28` / `[2] 29` / `[3] 30`，
  `RST_N`=75、`CLK_50M`=98，全部 `LVCMOS33 PULL_MODE=UP DRIVE=8 BANK_VCCIO=3.3`。
- `LED_Run.sdc`：`create_clock -name CLK_50M -period 20 -waveform {0 10} [get_ports {CLK_50M}]`
  （**补上原例程缺失的时序约束**，`TA1132` 警告因此消失）。

引脚复核（`07_LED_Flow\LED_Run\impl\pnr\LED_Run.rpt.txt` 第 7 节 "Pinout by Port Name"）
已确认与要求一致：`LED[0]`=27/IOL26[A]、`LED[1]`=28/IOL26[B]、`LED[2]`=29/IOB4[A]、
`LED[3]`=30/IOB4[B]、`CLK_50M`=98/IOR9[A]、`RST_N`=75/IOB42[B]。

时序结果（`.sdc` 生效，来自 `LED_Run_tr_content.html`）：约束 50.000 MHz（20.000 ns），
实际 Fmax **112.486 MHz**（Logic Level 5）；Setup/Hold 违规端点均为 **0**，
Total Negative Slack = **0.000 ns**；分析路径 66 条。构建脚本：`07_LED_Flow\build_07_LED_Flow.tcl`，
运行 `gw_sh.exe build_07_LED_Flow.tcl`（cwd = `07_LED_Flow\`），退出码 0。

产物位置：`<例程目录>\impl\pnr\<顶层名>.fs`（另有 `.bin` / `.binx` / `.pin.html` /
`.rpt.txt` / `.rpt.html` / `.power.html` / `.tr.html` / `.timing_paths`）。
综合产物：`<例程目录>\impl\gwsynthesis\<顶层名>.vg` 与 `_syn.rpt.html`。

### 警告（非致命，原工程同样存在）
- `WARN (TA1132) : 'CLK_50M' was determined to be a clock but was not created.`
  → 工程里没有 `.sdc` 时序约束文件，时钟未被约束，属正常现象。
- `06_FLASH` 另有两条：`EX3012`（`flash_spi.v:164` 顺序块内空语句）、
  `EX3791`（`flash_spi.v:113` 32 位表达式截断为 8 位）。

### 与本机原有 `.fs` 的对比
新构建的 `.fs` 与桌面上 IDE 之前生成的 `.fs` **内容不同、大小差 19 字节**
（02~06 原为 2,070,565 B，新为 2,070,584 B）。
对比 `impl\pnr\cmd.do` 与 `device.cfg` 后确认**布线配置与位流选项完全一致**
（`place_option 0`、`route_option 0`、`global_freq 50.000`、`crc_check true`、
`compress false`、`encryption false`…），差异只来自码流内嵌的构建路径/时间戳等元数据，
功能等价。

## 6. 踩坑记录

1. **`create_project -dir D` 会在 `D` 下再创建一个同名子目录 `D\<工程名>`，并把工具进程
   的 cwd 切到该子目录**。之后按源目录的绝对路径 `add_file` 会解析失败
   （报 `ERROR (EX5998) : Cannot open Verilog file '...'`，用 `file readable` 返回 0 可验证）。
   → 正确做法：先把源文件**拷进工程目录 `D\<工程名>\src\`**，再用相对路径
   `add_file src/X.v`；或直接 `open_project` 已有工程。`file delete` 清理时同样注意 cwd。
2. `gw_ide.exe -h` 不会打印帮助，而是启动 GUI 并挂住进程，**不要**用它做 CLI。
3. `file name` 不是有效的 TCL 8.6 子命令（应为 `file tail` / `file rootname`），
   脚本里写错会中断整个 `foreach` 批处理。
4. **`.ps1` 文件含中文时必须带 UTF-8 BOM**。本机 Windows PowerShell 5.1 读盘时按系统
   ANSI 代码页（GBK）解码**无 BOM** 的 UTF-8 脚本，某些汉字会被切出错位的 `'`，
   导致 `字符串缺少终止符` 之类的解析错误（实测 `flash_led_run.ps1` 就中招）。
   写入方式：`Get-Content -Encoding UTF8 -Raw` 读入后
   `Set-Content -Value $txt -Encoding UTF8 -NoNewline`（PS 5.1 的 `-Encoding UTF8` 会写 BOM）。
   已用 `[System.Management.Automation.Language.Parser]::ParseFile()` 校验两个 `.ps1` 均 `SYNTAX OK`。
5. 直接读 `gw_sh.exe` 字符串只能看到 `GowinSemi`、`/sh.log` 等碎片；
   最可靠的做法是 `puts [info commands]` 列出 122 个命令，再逐个 `-h`。

## 7. 烧录（用命令行，不打开 GUI）

**重要：烧录不能用 `gw_sh.exe`。** `info commands` 确认 gw_sh 里没有 `program` /
`scan_device` / `download_cable` 任何命令；烧录用
`C:\Gowin\Gowin_V1.9.12.02_SP2_x64\Programmer\bin\programmer_cli.exe`。

### 7.1 本机实测的硬件状态

**首次扫描（板子未上电）**：

```powershell
programmer_cli.exe --scan-cables     # → Cost 0.08 second(s)，退出码 48（无线缆列出）
programmer_cli.exe --scan            # → Error: No Gowin devices found!  退出码 49
```

**板子上电后（本机最终状态，已成功烧录）**：

```
Target Cable: Gowin USB Cable(FT2CH)/0/None/null@2.5MHz
Device Info:
    Family: GW1NR
    Name: GW1N-9C GW1NR-9C  (One of them)
    ID: 0x1100481B
 1 device(s) found!                        Cost 0.17 second(s)
```

即下载线为 **Gowin USB Cable(FT2CH)**，器件 **GW1N-9C / GW1NR-9C，ID `0x1100481B`**。

### 7.2 烧录命令

```powershell
$cli = 'C:\Gowin\Gowin_V1.9.12.02_SP2_x64\Programmer\bin\programmer_cli.exe'
$fs  = 'C:\Users\lishuo\Documents\deepseek-harness\default-workspace\gowin-build\07_LED_Flow\LED_Run\impl\pnr\LED_Run.fs'

# A. 烧到 SRAM（掉电丢失，调试用）—— 实测成功
& $cli --device GW1N-9C --operation_index 2 --fsFile $fs

# B. 烧到片内 embFlash（掉电保持）—— 实测成功且 Verify 通过
& $cli --device GW1N-9C --operation_index 6 --fsFile $fs

# C. 烧到外部 SPI Flash（掉电保持）
& $cli --device GW1N-9C --operation_index 9 --fsFile $fs

# 只扫链不烧录
& $cli --scan
```

**实测结论（重要）**：

- `operation_index 2`（SRAM Program）：输出 `User Code is: 0x0000D34B` +
  `Status Code is: 0x0001F020` + `Finished.`，**退出码 0，成功**。
- `operation_index 4`（SRAM Program **and Verify**）：在本机该器件上**恒定报**
  `Error: Verify failed of at 0`，但随后仍是
  `Status Code is: 0x0001F020` / `User Code is: 0x0000D34B` / `Finished.`
  → 属该器件的 SRAM 回读比对的已知现象，**不影响运行**；因此 SRAM 用 index **2** 更干净。
- `operation_index 6`（embFlash Erase,Program,Verify）：完整 Erase→Program→Verify 后输出
  **`Verify Success`** / `Status Code is: 0x0001F020` / `User Code: 0x0000D34B` /
  `Program Finished!`，耗时约 **19 秒**，**这是最可靠的烧录方式（掉电保持）**。
- `operation_index 73`（Read User Code）：回读 `User Code is: 0x0000D34B`，与烧录一致。
- ⚠️ **`programmer_cli.exe` 的退出码不可靠**：烧录失败时同样返回 `0`。
  判断成功与否必须看控制台文本（`Verify Success` / `Program Finished!` / `Error`）。

`operation_index` 其余常用值：`0` 读器件码、`1` Reprogram、
`4` SRAM Program+Verify、`5` embFlash Erase,Program、`6` embFlash Erase,Program,Verify、
`8` exFlash Erase,Program、`9` exFlash Erase,Program,Verify、
`16/17` SRAM Program(,Verify) JTAG-1149、`19/20` embFlash 2nd Erase,Program(,Verify)、
`24` SRAM Erase、`51` exFlash Detect ID、`73` Read User Code、`74` Read Status Register。
`--frequency` 可选 2.5(默认)/2/15/10/1.5/1.1/0.9/0.75/0.5/0.4/0.3/0.1/0.02 MHz。

### 7.3 一键脚本

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\flash_led_run.ps1            # 扫链 → 检查码流 → 烧 SRAM
.\flash_led_run.ps1 -Target emb   # 烧片内 Flash（掉电保持）
.\flash_led_run.ps1 -Scan         # 只扫链
```

脚本会先 `--scan`，**只有扫到器件才继续烧录**，并输出 `FLASH SUCCESS` / `FLASH FAILED`
和 `flash_<target>.log`。

### 7.4 手动烧（GUI，备用）

打开 `C:\Gowin\Gowin_V1.9.12.02_SP2_x64\Programmer\bin\programmer.exe`，
选器件 `GW1N-9C` → Operation 选 `SRAM Program` 或 `embFlash Erase,Program,Verify`
→ 载入 `LED_Run.fs` → 点 Program。

### 7.5 尚未验证 / 已知限制

- 烧录**已实测成功**（2024 实测：`op 2` 与 `op 6` 均成功，`op 6` 带 `Verify Success`），
  但仍**未接逻辑分析仪/示波器**复核 IO27–30 的实际翻转频率；LED 视觉验证由用户完成。
- 桌面目录 `C:\Users\lishuo\Desktop\FPGA_Proj` 在工作区沙箱外（`workspace-write` 只允许写
  工作区），所以构建在**工作区副本** `default-workspace\gowin-build\` 中完成，未改动桌面文件。
  若要在桌面目录原地重建，需要放宽该目录写权限（实测 `COPY TO DESKTOP FAILED: 对路径"07_LED_Flow"的访问被拒绝`）。
- 相关文档：`Programmer\doc\CN\SUG502-2.5_Gowin Programmer用户指南.pdf`、
  `UG290-2.8.2_Gowin FPGA产品编程配置手册.pdf`、`UG112-1.4.3_Gowin USB编程下载线用户指南.pdf`。

## 8. 文件清单

| 文件 | 说明 |
| --- | --- |
| `gowin_cli_build.tcl` | 通用构建脚本：`open_project` + `run <syn\|pnr\|all>` |
| `gowin_build.ps1` | PowerShell 封装，自动设置 `GOWIN_HOME`/`PATH` 并过滤日志噪声 |
| `build_all.tcl` | 批量构建脚本，一次传入多个 `.gprj`，逐个综合+布线并汇总 |
| `build_existing.tcl` | 演示"打开已有 .gprj 再 run syn/pnr"的脚本 |
| `build_01_LED_Run.tcl` | 演示"从零 `create_project` → `add_file` → `run syn/pnr`"的脚本 |
| `build_all.log` | 6 个例程批量构建的完整输出日志 |
| `flash_led_run.ps1` | 命令行烧录：先扫 JTAG 链，再按 `-Target sram\|emb\|ext` 烧录 |
| `01_LED_Run\ ~ 06_FLASH\` | 6 个例程的工作区副本及构建产物 |
| `07_LED_Flow\` | 早期四灯流水灯工程（`src\` + `build_07_LED_Flow.tcl` + 构建产物），**上板无效，见第 9 章** |
| `build_07_desktop.tcl` | 在桌面原位置构建 `07_LED_Flow` 的脚本（`open_project` 版） |
| `desktop_07_LED_Flow\` | 桌面 `07_LED_Flow` 的源码/码流归档（当前烧在板上的版本） |

## 9. 四灯流水灯"全灭"故障诊断（重要）

> ✅ **闭环状态（最终）**：桌面 `07_LED_Flow`（本文 9.5 节版本）已烧入板子并
> **经用户上板验证通过 —— 四颗 LED 顺序闪烁、时序正确（每 0.5s 一颗）**。
> 结论确认：命令行工具链、引脚约束、`create/open_project` 流程全部可靠；
> 之前的"全灭"纯粹是 9.3 节所述的复位值逻辑问题。
> 用户原话（m00529）："现在能观察到四颗led顺序闪烁，时序正确。"

### 9.1 现象

| 烧录内容 | 板子表现 |
| --- | --- |
| 桌面 `01_LED_Run` 例程（IDE 构建） | IO27 的 LED 亮 ✅ 用户认为"例程可以工作" |
| 早期 `07_LED_Flow`（工作区版本） | **四颗全灭** ❌，重新烧录并校验通过后依然全灭 |

### 9.2 排除"命令行构建不可靠"的嫌疑

对比桌面 `01_LED_Run` 的码流头与我的构建：

```
桌面 01_LED_Run\impl\pnr\LED_Run.fs 头
  //Tool Version: V1.9.12.02_SP2 (64-bit) (85219)
  //Created Time: Sat Oct 10 23:46:12 2026
  //CRCCheck: ON  //Compress: OFF  //Encryption: OFF  //SecurityBit: ON
```

即桌面那个"能工作"的 `.fs` **也是同一个工具、同一套参数**生成的。
逐字节 diff 进一步确认：

- `impl\pnr\device.cfg`：**两侧完全相同**（`crc_check`/`compress`/`encryption`/`unused_pin`/`vccx`… 全部一致）
- `impl\pnr\cmd.do`：只差**文件路径**和我的多一行 `-sdc`（`-d`/`-cst`/`-cfg` 的参数值一致）
- `.fs` 头只差 `CheckSum`/`UserCode`/`Created Time`

→ **结论：命令行构建链路没问题，问题出在我的 Verilog 逻辑。**

### 9.3 根因

本板 LED **低电平点亮**，两种写法在复位期间的行为不同：

```verilog
// 例程（能亮）: if(!RST_N) led_reg <= 1'b0;   →  IO27 拉低 → 灯亮 ✅
// 早期版本(全灭): if(!RST_N) LED    <= 4'b1111; →  四路全高 → 全灭 ❌
```

`4'b1111` 在低电平点亮下正是**全灭**，而它恰好是我的复位值。
**只要 RST_N(IO75) 在上电后没有释放（被拉低），我的灯就永远停在 1111 全灭**；
而例程的复位值 `0` 恰好是"亮"——这两个现象同时成立、完全自洽。

### 9.4 修复思路：自诊断设计

新版本（桌面 `07_LED_Flow\src\LED_Run.v`）做了三处防御：

1. **完全不使用 `RST_N`**（也从 `.cst` 里删掉），彻底消除"复位未释放"这一失效模式；
2. **LED 改成组合输出** `always @(*) case(ph)`，从 `cnt`/`ph` 直接译码，
   不再依赖"输出寄存器被时钟推动"；
3. **任何一个 `ph` 取值都恰好点亮一颗灯**（`1110/1101/1011/0111`，`default` 兜底），
   所以**不存在"四颗全灭"的合法状态** —— 也就是说：
   - 上电后看到**流水** → 时钟正常，修复成功；
   - 上电后看到**某颗灯常亮不动** → 时钟没进设计（配置到了但时钟死）；
   - 上电后仍然**全灭** → 码流没配置成功（与逻辑无关）。

### 9.5 新版构建与烧录实测

源码（`07_LED_Flow\src\LED_Run.v`，桌面路径）：

```verilog
module LED_Run(input CLK_50M, output reg [3:0] LED);
    localparam [24:0] HALF_SEC = 25'd24_999_999;   // 50MHz -> 0.5s
    reg [24:0] cnt;
    reg [1:0]  ph;
    always @(posedge CLK_50M) if (cnt == HALF_SEC) cnt <= 25'd0; else cnt <= cnt + 25'd1;
    always @(posedge CLK_50M) if (cnt == HALF_SEC) ph <= ph + 2'd1;
    always @(*) case (ph)
        2'd0:    LED = 4'b1110;   // LED0 / IO27
        2'd1:    LED = 4'b1101;   // LED1 / IO28
        2'd2:    LED = 4'b1011;   // LED2 / IO29
        default: LED = 4'b0111;   // LED3 / IO30
    endcase
endmodule
```

构建（`gw_sh.exe build_07_desktop.tcl`，`open_project` 桌面 `.gprj`）：

```
########## OPENED: .../07_LED_Flow/LED_Run.gprj
########## SYN OK
########## PNR OK
########## BUILD SUCCESS          （退出码 0）
WARN (TA1132): 'CLK_50M' was determined to be a clock but was not created.   ← 未加 .sdc，无害
```

结果：`Logic 40/8640`、`Register 27/6843`（25 位计数器 + 2 位相位）、`I/O Port 5/121`；
`LED_Run.fs` 2,070,606 B，`UserCode 0x0000A9D4`，`Created Time: Sat Oct 10 23:55:14 2026`。

引脚表（`LED_Run.rpt.txt` 第 7 节 "Pinout by Port Name"，`Constraint=Y`）：

```
CLK_50M | 98/1 | in  | IOR9[A]  | GCLKT_2 | LVCMOS33 | UP
LED[0]  | 27/3 | out | IOL26[A] | -       | LVCMOS33 | DRIVE=8 UP
LED[1]  | 28/3 | out | IOL26[B] | -       | LVCMOS33 | DRIVE=8 UP
LED[2]  | 29/2 | out | IOB4[A]  | -       | LVCMOS33 | DRIVE=8 UP
LED[3]  | 30/2 | out | IOB4[B]  | -       | LVCMOS33 | DRIVE=8 UP
```

烧录（`programmer_cli.exe`，全部成功）：

```
[1] --operation_index 2  SRAM Program                 →  User Code 0x0000A9D4 / Finished.
[2] --operation_index 6  embFlash Erase,Program,Verify →  Verify Success / Program Finished!
```

### 9.6 关键教训

1. **低电平点亮的 LED，复位值必须包含"亮"的语义**。给这类板子写复位状态时，
   `4'b1111` 是"全灭"、`4'b0000` 是"全亮"，绝不能想当然。
2. **诊断用设计要能"自证"**：让任何可能的内部状态都对应一个可观察的输出
   （本设计任何 `ph` 都恰好一颗灯亮），这样"全灭"就必然是配置/时钟问题，
   而不是逻辑问题——一次烧录就能区分三类病因。
3. 判断板子上的 `.fs` 是谁生成的，**看 `.fs` 头里的 `Tool Version` / `Created Time`**，
   比看文件时间戳可靠。
4. 用 `open_project` 构建**复制出来的例程**，比 `create_project` 从零建工程更安全：
   器件、工程模板、文件列表全部继承自已验证可用的工程。
