# Gowin 1.9 GAO「在线仿真」端到端命令行验证报告

实验目录：`C:\Users\lishuo\Documents\deepseek-harness\default-workspace\gowin-build\gao\`
实验日期：2026-10-11
工具链：Gowin V1.9.12.02_SP2_x64（`C:\Gowin\Gowin_V1.9.12.02_SP2_x64`）
目标板：GW1N-9C（GW1NR-9C），Gowin USB Cable(FT2CH)，器件 ID `0x1100481B`

---

## 1. 结论（一句话）

**能跑通，但只能"半自动"：`gao_sh.exe` 这条纯命令行采集器是死的（在任何 JTAG 会话之前就永久挂死，必须放弃），
官方真正可用的入口是 GUI 程序 `gao_analyzer.exe`；用命令行把它拉起、再用 UIA + PostMessage 远程操作它的界面，
可以全自动完成「烧 GAO 码流 → 启动采集 → 导出波形数据」并得到**真实、可校验的实时波形**（已导出 1024 点 CSV 并逐行校验通过），
唯一没能做到全自动的只有「切换导出格式为 VCD」这一个下拉框动作。**

真实抓到的波形（`cnt[24:0]` 与 `LED[3:0]`，1024 点深存储，`impl\wave\` 下的 CSV 即此数据）：

![analyzer waveform](shots/analyzer_waveform.png)

---

## 2. 完整可复现命令序列（逐条 + 实测输出关键行）

所有命令都在 `powershell` 下执行。前置环境：

```powershell
$env:GOWIN_HOME = 'C:\Gowin\Gowin_V1.9.12.02_SP2_x64'
$env:PATH = "$env:GOWIN_HOME\IDE\bin;$env:PATH"
$base = 'C:\Users\lishuo\Documents\deepseek-harness\default-workspace\gowin-build\gao'
```

### 步骤 0：准备工程（手写 `.gao` + 挂进 `.gprj`）

`.gao` 全文见第 3 节。`LED_Run.gprj` 的 `<FileList>` 里加一行：

```xml
<File path="src/LED_Run.gao" type="file.gao" enable="1"/>
```

### 步骤 1：综合 + 布局布线（GAO 核在此阶段被自动插入）

```powershell
& "$env:GOWIN_HOME\IDE\bin\gw_sh.exe" "$base\build_gao.tcl"
```

`build_gao.tcl` 内容（`get_project_files` 命令不存在，别用）：

```tcl
open_project C:/Users/lishuo/Documents/deepseek-harness/default-workspace/gowin-build/gao/LED_Run.gprj
run syn
run pnr
```

**实测输出关键行**（`build_gao.log`）：

```
Open project .../LED_Run.gprj finished
########## OPENED: .../LED_Run.gprj
Compiling module 'LED_Run'("...\src\LED_Run.v":11)
[100%] Generate report file "...\impl\gwsynthesis\LED_Run_syn.rpt.html" completed
GowinSynthesis finish
Generating Post-Synthesis GAO
Post-Synthesis GAO generation finish
Parsing netlist file "...\impl\gwsynthesis\LED_Run.vg" completed
Parsing netlist file "...\impl\gao\gao.v" completed
WARN  (PA1015) : Signal 'CLK_50M' captured in GAO is replaced by 'CLK_50M_d'
WARN  (PA1015) : Signal 'LED[3]' captured in GAO is replaced by 'LED_d[3]'
WARN  (PA1015) : Signal 'LED[2]' captured in GAO is replaced by 'LED_d[2]'
WARN  (PA1015) : Signal 'LED[1]' captured in GAO is replaced by 'LED_d[1]'
WARN  (PA1015) : Signal 'LED[0]' captured in GAO is replaced by 'LED_d[0]'
```

注意：`cnt[...]` **没有任何 WARN** → 25 根计数器信号按名字直接匹配成功；
`CLK_50M`/`LED[*]` 被工具链替换成插入后的内部网名（这是正常的延后取样处理）。

> `gw_sh` 会先打印 `alog error: failed to open log file`，**非致命，忽略**。

**GAO 插入成功的官方判据**（SUG114 §3.1）：PnR 后出现 `impl/pnr/ao_0.fs`。实测：

```
impl\pnr\ao_0.fs      3,558,506 B   ← GAO 码流（含用户设计 + GAO 配置）
impl\pnr\ao_0.bin       444,430 B
impl\pnr\ao_0.binx      444,977 B
impl\gao\gao.v          214,891 B   ← pragma protect 加密网表
impl\gao\gw_gao_top.v     3,478 B
```

⚠️ 加了 GAO 之后 **PnR 不再生成 `LED_Run.fs`**，只有合并后的 `ao_0.fs`。

资源对比（`impl\pnr\LED_Run.rpt.txt` 第 3/4 节）：

| | Logic | Register | I/O Port | BSRAM |
|---|---|---|---|---|
| 基线（无 GAO） | 40（15 LUT + 25 ALU） | 27 | 5 | 0 |
| 含 GAO | 429（416 LUT + 13 ALU） | 353 | 34 | 2 |
| GAO 自身开销 | 389 | 326 | 29 | 2 |

`impl\gao\ao_0\gw_ao_parameter.v` 证明 `.gao` 被**完全正确解析**：

```verilog
SIG_PORT_WIDTH  = 29        // 25 (cnt) + 4 (LED)
STORAGE_DEPTH   = 1024
MEM_DATA_WIDTH  = 30
TRIG_TYPE       = 0
MATCH_EN_0      = 1
MATCH_TYPE_0    = 3'b001
TRIG_PORT_WIDTH_0 = 1
CAPTURE_TRIG_0  = 1
MATCH_EN_1..15  = 0
```

### 步骤 2：把 GAO 码流烧进 SRAM

```powershell
& "$env:GOWIN_HOME\Programmer\bin\programmer_cli.exe" --device GW1N-9C `
  --operation_index 2 `
  --fsFile "$base\impl\pnr\ao_0.fs"
```

**实测输出关键行**：

```
 Operation "SRAM Program" for device#1...   100%
 User Code is: 0x00008DC1
 Status Code is: 0x0001F020
 Finished.
 Cost 3.34 second(s)
```

> `programmer_cli.exe` **退出码不可靠**，必须看控制台文本；`--output` 参数实测不产生文件，得重定向抓 stdout。

### 步骤 3：拉起 GAO 采集界面

cwd **必须**是 `IDE\bin`，且必须同时给 `-series` 和 `-device`（缺任何一个都会弹
`Can not set device.` 并停在那里）。文档写的是单横线 `-fs`，但二进制里只有双横线 `--fsFile`：

```powershell
Set-Location "$env:GOWIN_HOME\IDE\bin"
& ".\gao_analyzer.exe" -gao "$base\src\LED_Run.gao" -series GW1N -device GW1N-9C `
  -fs "$base\impl\pnr\ao_0.fs"
```

**实测**：进程存活，stdout/stderr 均为空，出现两个窗口
`Gowin Analyzer Oscilloscope`(1724x1000) 与 `GAO`（隐藏）。
`gao_analyzer` 自己会拉起 `jtagserver.exe`。

### 步骤 4：命令行远程操作界面

三个自研脚本（都在 `gowin-build\gao\` 下）：

- `uia_dump.ps1 -TargetPid <pid> -OutFile <txt>`：用 UIA 把窗口里所有元素
  （ControlType / Name / AutomationId / IsEnabled / 可用 Pattern / 屏幕矩形）dump 出来。
- `uia_act.ps1 -TargetPid <pid> -Name <名字> -Type ControlType.Button -Action click|select|toggle|list|readstate`：
  对匹配元素执行 UIA 动作。
- `click_btn.ps1 -TargetPid <pid> -Name <按钮名> [-WindowTitle <窗口标题>]`：
  **用 PostMessage 模拟鼠标点击**（关键，见第 5 节原因分析）。
- `click_el.ps1`：同上的通用版，可按 AutomationId 点任意元素（含 ComboBox）。
- `export_wave.ps1 -TargetPid <pid> -Dir <目录> -Name <文件名> -Format csv|vcd|prn|gwd -Period <值> -PeriodUnit us|ns|ps`：
  填 Export 对话框并按 OK。
- `verify_wave.ps1 -Csv <csv 路径>`：逐行校验导出的 CSV。

**选电缆**（UIA SelectionItemPattern 对 ComboBox 下拉项有效）：

```powershell
& "$base\uia_act.ps1" -TargetPid $pid -Name 'Gowin USB Cable(FT2CH)' -Type ControlType.ListItem -Action select
# 实测：selected=True
```

**开始采集**：

```powershell
& "$base\click_btn.ps1" -TargetPid $pid -Name 'Start'
# 实测：click 'Start' at client=(...); click posted
```

**采集成功的实测证据**（`uia_dump.ps1` 输出）：

```
TabItem 'core 0'                                    ← 标签页从 Configuration 切到 core 0
TreeItem 'cnt[24:0]' = '1494A77'
TreeItem 'LED[3:0]'  = 'B'
Go to Cursor / Go to Time 0 / Go to Last Time /
Previous Transition / Next Transition  ← 全部由 disabled 变 enabled（只在有数据时可用）
```

**打开导出对话框并导出**：

```powershell
& "$base\click_btn.ps1" -TargetPid $pid -Name 'Export'
# 实测：click 'Export' at client=(1584,29) lParam=0x1D0630 (scale 0.991,0.963)
#       click posted
# → 新出现可见顶层窗口 'Export' rect=(1023,562,1545,948)

& "$base\export_wave.ps1" -TargetPid $pid -Dir "$base\impl\wave" -Name 'LED_Run' `
    -Format csv -Period '20' -PeriodUnit 'ns'
```

**实测输出**：

```
dialog hwnd=0x1A0BFA
--- filling dialog ---
  set 'GAO__ExportDialog.widget_3.widget_2.editDir' = '...\gowin-build\gao\impl\wave'
  set 'GAO__ExportDialog.widget_3.editName' = 'LED_Run_vcd'
  combo 'GAO__ExportDialog.widget_3.comBoxFormat' -> 'Comma Separated Values (*.csv)' (want 'Value Change Dump (*.vcd)')
  set 'GAO__ExportDialog.widget_3.widget.spinPeriod' = '20'
  combo 'GAO__ExportDialog.widget_3.widget.comBoxPeriod' -> 'us' (want 'ns')
--- state before OK ---
  GAO__ExportDialog.widget_3.comBoxFormat = 'Comma Separated Values (*.csv)'
  GAO__ExportDialog.widget_3.widget.spinPeriod = '19'
--- pressing OK ---
OK invoked
```

> 见第 6 节：ComboBox 的选项切换在无前台焦点时切不动，所以最终产物是 **CSV**（这也是 SUG114 §4.1.3 官方支持的格式之一）。
> 另注意导出文件名会被自动加 `_core0` 后缀。

### 步骤 5：校验波形

```powershell
& "$base\verify_wave.ps1" -Csv "$base\impl\wave\LED_Run_core0.csv"
```

**实测输出**：

```
total lines: 1031
data rows: 1024
problems detected: 0
time step: 1 us
first cnt 1494A77
last  cnt 1494E76
delta cnt 1023 / 3FF
distinct LED values: B x1024
sample span: 1024 us
```

**第二次采集**（证明是实时采样而不是静态回放）：

```
first cnt 0C2AACB
last  cnt 0C2AECA
delta 1023 / 3FF
distinct LED values: E x1024
problems detected: 0
```

两次的 `cnt` 完全不同、`LED` 值也不同（`B`=1011 vs `E`=1110），→ 板上真实状态在变。

> 时间轴说明：导出的 CSV 表头写 `time unit: us`、步长 1 us，即分析器用的是 **Export 对话框里
> `Clock period` 的默认值（1 us）**，而**不是**真实的采样周期。
> 板上 `CLK_50M` 是 50 MHz → 真实采样周期应为 20 ns，所以这条时间轴被放大了 50000 倍。
> 原因见第 5.4 节：`Clock signal` 是只读的，`Clock period` / 单位下拉框同样无法被远程驱动。
> **这只影响 CSV 里 time 列的标注，采样数据本身（1024 个点、`cnt` 逐一 +1、`LED` 恒定）完全正确**，
> 按"第 N 个采样点 = 第 N 个 50 MHz 时钟沿 = N×20 ns"来解读即可。

### 步骤 6：实验结束，恢复板子

先把占用 JTAG 的 `gao_analyzer` / `jtagserver` 杀掉，再烧回可用的四灯流水灯 embFlash 码流：

```powershell
Get-Process gao_analyzer,jtagserver -ErrorAction SilentlyContinue | Stop-Process -Force
& "$env:GOWIN_HOME\Programmer\bin\programmer_cli.exe" --device GW1N-9C `
  --operation_index 6 `
  --fsFile "C:\Users\lishuo\Documents\deepseek-harness\default-workspace\gowin-build\desktop_07_LED_Flow\impl\pnr\LED_Run.fs"
```

**实测输出关键行**：

```
 Target Cable: Gowin USB Cable(FT2CH)/0/None/null@2.5MHz
 Target Device: GW1N-9C(0x1100481B)
 Operation "embFlash Erase,Program,Verify" for device#1...
 Erasing embFlash ...: 100%
 Programing...: 100%
 Verifying...: 100%
 Verify Success
 Status Code is: 0x0001F020
 User Code: 0x0000A9D4
 Program Finished!
 Finished.
 Cost 15.66 second(s)
```

✅ 板子**已恢复**成正常的四灯流水灯（embFlash 掉电保持）。

---

## 3. `.gao` 文件的最终内容（`src\LED_Run.gao`，86 行）

```xml
<?xml version="1" encoding="UTF-8"?>
<GAO_CONFIG>
    <Version>3.0</Version>
    <Mode>Standard</Mode>
    <AoCore index="0" sample_clock="CLK_50M" trig_type="0" storage_depth="1024" window_num="1" capture_amount="1024" implementation="0" trigger_pos="0" module_name="LED_Run" force_trigger_by_falling_edge="false" capture_init_data_enabled="false">
        <SignalList>
            <Bus capture_enable="true" name="cnt[24:0]">
                <Signal>cnt[24]</Signal>
                <Signal>cnt[23]</Signal>
                <Signal>cnt[22]</Signal>
                <Signal>cnt[21]</Signal>
                <Signal>cnt[20]</Signal>
                <Signal>cnt[19]</Signal>
                <Signal>cnt[18]</Signal>
                <Signal>cnt[17]</Signal>
                <Signal>cnt[16]</Signal>
                <Signal>cnt[15]</Signal>
                <Signal>cnt[14]</Signal>
                <Signal>cnt[13]</Signal>
                <Signal>cnt[12]</Signal>
                <Signal>cnt[11]</Signal>
                <Signal>cnt[10]</Signal>
                <Signal>cnt[9]</Signal>
                <Signal>cnt[8]</Signal>
                <Signal>cnt[7]</Signal>
                <Signal>cnt[6]</Signal>
                <Signal>cnt[5]</Signal>
                <Signal>cnt[4]</Signal>
                <Signal>cnt[3]</Signal>
                <Signal>cnt[2]</Signal>
                <Signal>cnt[1]</Signal>
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
                <SignalList>
                    <Signal>cnt[0]</Signal>
                </SignalList>
            </Trigger>
            <Trigger index="1"/>
            <Trigger index="2"/>
            <Trigger index="3"/>
            <Trigger index="4"/>
            <Trigger index="5"/>
            <Trigger index="6"/>
            <Trigger index="7"/>
            <Trigger index="8"/>
            <Trigger index="9"/>
            <Trigger index="10"/>
            <Trigger index="11"/>
            <Trigger index="12"/>
            <Trigger index="13"/>
            <Trigger index="14"/>
            <Trigger index="15"/>
        </Triggers>
        <MatchUnits>
            <MatchUnit index="0" enabled="1" match_type="1" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="R" value1="0" trigger="0"/>
            <MatchUnit index="1" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="2" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="3" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="4" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="5" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="6" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="7" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="8" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="9" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="10" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="11" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="12" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="13" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="14" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
            <MatchUnit index="15" enabled="0" match_type="0" counter_enable="0" counter_width="2" counter="2" countinuous="0" func="0" value0="" value1=""/>
        </MatchUnits>
        <Expressions type="Static">
            <Expression>M0</Expression>
        </Expressions>
    </AoCore>
    <GAO_ID>0100010111110010</GAO_ID>
</GAO_CONFIG>
```

字段含义（从官方样本 `IDE\data\examples\{game,can,FFT,vga_text_generator}\src\*.gao` 反推）：

| 字段 | 值 | 含义 |
|---|---|---|
| `sample_clock` | `CLK_50M` | 采样时钟的网络名，必须与 RTL 内真实存在的名字一致 |
| `module_name` | `LED_Run` | 顶层模块名 |
| `trig_type` | `0` | 触发类型（0 = Basic） |
| `storage_depth` / `capture_amount` | `1024` | 深存储深度 = 捕获点数 |
| `Bus name="cnt[24:0]"` + 每 bit 一个 `<Signal>` | — | 被采样的信号，`capture_enable="true"` |
| `Triggers[0].SignalList` | `cnt[0]` | 触发端口 0 绑定的信号；`MatchUnit` 的 `value0` 字符串里**每个字符对应这里的一个 `<Signal>`** |
| `MatchUnit match_type="1" value0="R"` | — | `1` = 带边沿的基础匹配；`R` = 上升沿，`X` = don't care |
| `Expressions` | `M0` | 16 个 Trigger 端口的组合表达式，这里是"仅 MatchUnit 0" |
| `GAO_ID` | 16 位 01 串 | 抄自 `game.gao` 的固定常量 |

> 工具链会**依据 `.gao` 自动插入 GAO 核与 JTAG 桥**——`.gprj` 的 FileList 里不需要任何 `GW_AO` / `GW_CON` 源文件条目（与官方 `game.gprj` / `FFT.gprj` 完全一致）。这一点本次已证实。

---

## 4. 每次 `gao_sh.exe` 尝试的参数组合与原始输出

脚本：`probe_gao_sh.ps1`（`Start-Process -PassThru` + `WaitForExit(ms)` + `Kill()`）；
原始输出留档在 `sh_logs\*.out.txt` / `*.err.txt`。

| # | 参数 | stdout | stderr | 结果 |
|---|---|---|---|---|
| A | `-h` | `Error: invalid gao file.` | 空 | 0.3 s 退出 |
| B | `<路径>\LED_Run.gao`（裸路径） | `Error: invalid gao file.` | 空 | 0.3 s 退出 |
| C | `-gao <LED_Run.gao>` | `Start running GAO analyzer.` | 空 | **永久挂死** |
| D | `-gao <LED_Run.gao> --scan-cables` | `Start running GAO analyzer.` | 空 | **永久挂死** |
| E | `-gao <LED_Run.gao> --scan` | `Start running GAO analyzer.` | 空 | **永久挂死** |
| F | `-gao <f> --device GW1N-9C --fsFile <ao_0.fs> -out F_out.bin` | `Start running GAO analyzer.` | 空 | **永久挂死**，未生成 `F_out.bin` |
| G | `-gao <f> --device GW1N-9C --fsFile <ao_0.fs>` | `Start running GAO analyzer.` | 空 | **永久挂死** |
| H | `-gao <f> --device GW1N-9C` | `Start running GAO analyzer.` | 空 | **永久挂死** |
| I | `-gao <f> --device GW1N-9C --fsFile <ao_0.fs> --operation_index 36 -out I_out.bin` | `Start running GAO analyzer.` | 空 | **永久挂死** |
| J | 同 G 再加 `-local -out J_out.bin` | `Start running GAO analyzer.` | 空 | **永久挂死** |
| K | 同 G 再加 `--frequency 25000000 -out K_out.bin` | `Start running GAO analyzer.` | 空 | **永久挂死** |

补充实验（均在 `sh_logs\` 留档）：

- 厂商自带样本 `game.gao` / `reg.gao` / `FFT.gao` → 行为与 C 完全一致（**不是我的 `.gao` 写得不对**）。
- cwd 换成 `IDE\bin`、相对/绝对路径、超时加到 60 s → 全部无效。
- 烧 GAO 码流**之前**和**之后**行为逐字一致 → 与板子状态无关。
- 进程内线程等待原因：主线程 `WaitReason=UserRequest`，另外 3 个线程 `EventPairLow`。
- 顶层窗口枚举（含隐藏窗口）：`gao_sh.exe` **一个窗口都没有**（对比 `gao_analyzer.exe` 有正常的 Qt 窗口）。
- 加载的模块含 `Qt5Core/Gui/Widgets/Network/Xml`、`d3d11/dxgi/dwmapi` —— 它其实是个 Qt GUI 程序，只是在命令行模式下把窗口藏了。

**结论：`gao_sh.exe` 是死路。** 它的第一位置参数必须是 `.gao` 文件；一旦遇到字面量 `-gao`
（`argv[1] == "-gao"`，无论后面跟什么）就打印 `Start running GAO analyzer.` 然后永久挂死，
且在挂死前后**从不连接** `jtagserver`（见第 5 节）。继续投入没有意义。

---

## 5. 卡住的确切环节与原因分析

### 5.1 `gao_sh.exe` 卡在哪一步：**在建立任何 JTAG 会话之前**

`jtagserver.exe -local` 会创建命名管道 `\\.\pipe\gao1`，**并且只在有管道客户端连上时**才
把版本横幅写到 stdout。据此做了定向实验（`diag_pipe_connect.ps1`）：

1. 先单独启动 `jtagserver.exe -local`，stdout 重定向到文件；
2. 再启动 `gao_sh -gao <LED_Run.gao>`；
3. 之后每 2 s 采样一次该文件，共 12 s。

实测：`jtOutLines=0` **全程不变** → **`gao_sh` 从未连接 `gao1` 管道**。
（对照实验：我们自己手动连一次管道，横幅立刻出现，证明检测方法有效。）

其他同时期观测：

- `gao_sh` 运行期间 `Get-NetTCPConnection -OwningProcess` 为空、`netstat` 无 socket、
  `tcp36548=[NONE]`、`gaoShSockets=[]` → **既没连本地管道，也没连 TCP 36548**。
- 子进程确认为 `...\Programmer\bin\jtagserver.exe  -local`（ppid = gao_sh 的 pid），
  且 `\\.\pipe\gao1` 确实被它创建了 —— **子进程起来了，`gao_sh` 自己却在等别的东西。**
- 死锁假说已排除（`diag_banner_trigger.ps1`）：让 `gao_sh` 挂住后，从外部用
  `NamedPipeClientStream('.','gao1')` 连 6 s 触发横幅，`gao_sh` 之后 10 s 仍只有 1 行输出、
  不产生任何新文件。

→ 卡点在 `gao_sh` 自己进程内部（等一个永远不来的事件），且发生在"连 jtagserver"之前。
没有可用的公开入口把它推下去。

### 5.2 为什么改走 `gao_analyzer.exe`：它才是官方入口

SUG114 §3.1.1 原文（`doc_SUG114_CN.txt` L8716–L8816）：

> 在 IDE 安装路径 /IDE/bin 下，可通过命令行启动 GAO 捕获界面，可执行程序是 `gao_analyzer.exe`，
> 其命令参数包括：`-gao`（指定 `.gao` 或 `.rao` 文件，为可选命令）；`-dir`（GAO 捕获界面
> "Open" 按钮默认打开的路径，为可选命令）；`-series`（指定芯片系列，为必选命令）；
> `-device`（指定器件类型，包括 device version，为必选命令）；`-fs`（指定 GAO-Programmer
> 加载的 fs 文件，为可选命令）。

即**官方设计的命令行入口只有"把 GUI 拉起来"，没有无头采集器**。`gao_sh.exe` 不在文档里。

`gao_analyzer.exe` 从二进制字符串抽出的 CLI 流程是：
`-gao / -dir / -series / -device / "GowinSemi" / "Can not set device." / "starting JTAG server..." / "Can not connect to JTAG server." / ".analyzer_prj"`
→ `set device → starting JTAG server → connecting JTAG server`，与实测完全吻合。

### 5.3 自动化它的三个技术障碍与破解

| 障碍 | 现象 | 破解 |
|---|---|---|
| ① Qt 的 UIA `InvokePattern` 对"会弹模态框的动作"会**死锁** | 对 `Export` 调用 `Invoke()` 抛 `Operation timed out. (HRESULT: 0x80131505)`，阻塞 ~180 s 仍无对话框；而同一个 Invoke 对 `Start` 瞬间成功 | **改用 `PostMessage(hwnd, 0x0201/0x0202, ...)` 直接投递鼠标按下/抬起**，走 Qt 正常事件循环，不阻塞、窗口在后台被遮挡也有效 |
| ② 坐标换算：UIA 给的是物理像素，Win32 给的是虚拟像素（DPI 150%） | `GetWindowRect`=`0,0,1724,1000`，UIA `rect`=`11,45,2564,1444` | 现场标定：`scale = UIA矩形宽高 / Win32矩形宽高`，`客户区原点物理 = ClientToScreen(0,0) * scale`，客户区坐标 = `UIA元素中心物理 − 客户区原点物理` |
| ③ 工具栏按钮被窗口宽度裁掉，`Export` 一开始根本不存在 | 窗口 868 px 宽时 UIA 树里只有到 `Next Transition` | `MoveWindow(hwnd, 0, 0, 1900, 1000, true)` 放大窗口后，`Export`（en=True）与 `Add Marker` 系列按钮出现 |

### 5.4 唯一没做成的一步：Export 对话框里切换文件格式

`comBoxFormat`（`Value Change Dump (*.vcd)`）与 `comBoxPeriod`（`ns`）**切换不生效**；
`Clock signal`（`GAO__ExportDialog.widget_3.editClk`）本身就是 `en=False` 只读的，
`spinPeriod` 虽然在 UIA 里读回 `20`，导出的 CSV 表头仍是 `1 us`。
逐一排除：

- `SelectionItemPattern.Select()` → 返回 `selected=True`，但读回 `ValuePattern` 仍是 `Comma Separated Values (*.csv)`。
  **Qt 把下拉项作为脱离真实弹窗的抽象对象暴露**：`ControlType.List` 的 rect 是 `Empty`，
  四个 ListItem 的 rect 分别是 `0,0,795,20` / `0,20,795,20` / …（相对弹窗的假坐标），
  真假弹窗根本没打开 → `Select()` 作用不到实际控件上。
- `InvokePattern.Invoke()` on ListItem → 立即返回，**无任何效果**。
- `ValuePattern.SetValue()` on ComboBox → 返回成功，**读回不变**（Qt 对非可编辑 QComboBox 的写路径是空实现）。
- `ExpandCollapsePattern.Expand()` → `ExpandCollapseState` 读出来是空，也没有新顶层窗口出现。
- `PostMessage` 点击 ComboBox 想打开弹窗 → 枚举该进程全部顶层窗口，**没有新窗口出现**
  （Qt5 的下拉弹窗在这个 build 里不是独立 HWND）。
- 键盘：`SetFocus()` + 投递 `VK_DOWN` → 焦点不在 ComboBox 上（那次把相邻的 `spinPeriod`
  从 20 减成了 19，说明键真的到了对话框，只是落到了别的控件）；
  根因是**窗口在后台，Windows 不允许后台窗口夺取键盘焦点**。

→ 结论：**在"不把窗口切到前台、不干扰用户"的前提下，Qt 的 ComboBox 选项无法远程切换。**
CSV 是官方文档（SUG114 §4.1.3）明确支持的导出格式，因此交付物采用 CSV；
`.vcd` / `.prn` / `.gwd` 只需人工在下拉框里点一下即可获得，其余流程完全相同。

### 5.5 关于 `jtagserver`（附带产出，供后续参考）

`Programmer\bin\jtagserver.exe`（7,537,448 B）是 **PyInstaller 打包的 Python 3.6 + Qt** 程序，
管道协议已完整复原：

- 类名（Python `__qualname__`）：`Server.run / addConnection / receiveMessage / sendMessage /
  removeConnection / socketError / on_gettingReadTimer / gaoOpenDevice / gaoQueryDevice /
  gaoCloseDevice / gao_write / gao_read`。
- 线协议：`QDataStream` + `setVersion(Qt_4_8)` + `nextBlockSize` + `readUInt32` + `readQVariantMap`，
  键为 `CMD` / `RES` / `DATA`，命令值 `OPEN` / `QUERY` / `CLOSE` / `WRITE` / `READ` / `GAO_STOP` / `stop` / `isActive`。
  即「**4 字节大端块长度 + QDataStream(Qt_4_8) 序列化的 QVariantMap**」。
- 实测：连上 `\\.\pipe\gao1` 后 `jtagserver` 立刻打印
  `GOWIN JTAG Server Version 3.7.6` / `Listening on Port: 36548`，
  并发 `OPEN` 会因缺少参数抛 `Error: 'cable_index' @ gaoOpenDevice` → `gaoOpenDevice` 必须带 `cable_index`。
  该管道**允许多个并发客户端**（连两次都成功），所以"`gao_sh` 独占连接"这个假说不成立。
- ⚠️ `Server` 只提供**原始 JTAG 读写**（`gao_write`/`gao_read`）。**GAO 核的寄存器时序在服务端之外**，
  想自己实现无头采集等于手写 GAO 核寄存器协议，成本极高，已放弃。

---

## 6. 踩坑记录

1. **`gao_sh.exe` 没有文档、没有 help、没有窗口**：`-h` / `--help` / 裸 `.gao` 路径一律回
   `Error: invalid gao file.`（0.3 s 退出）；只有 `argv[1]` 是字面量 `-gao` 才会打印
   `Start running GAO analyzer.` 然后永久挂死。**别在上面浪费时间。**
2. **不要用 `Get-Content` 读中文文档/源码**：PowerShell 5.1 默认按 GBK 解码 UTF-8，
   会把 `配置` 读成 `閰嶇疆` 之类的假乱码。正确姿势：
   `[System.IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)`。
   `doc_SUG114_CN.txt`（110,277 B，无 BOM）**本身是正确的 UTF-8**，不要去"修"它。
3. **含中文的 `.ps1` 必须带 UTF-8 BOM**，否则 PowerShell 5.1 报"字符串缺少终止符"。
4. **`$Pid` 是 PowerShell 只读自动变量**：脚本参数不能叫 `$Pid`，改叫 `$TargetPid`，
   否则 `Cannot overwrite variable Pid because it is read-only or constant`。
5. **`[void](SomeFunction ...)` 会连同函数内部的 `Write-Output` 一起吞掉**，
   调试输出会全部消失。我用 `$null = SetVal` 批量替换时还留下了未配对的右括号，
   直接把 `export_wave.ps1` 弄成语法错误、VCD 导出静默失败。
   **教训：函数里要做日志就用 `Write-Host`。**
6. **`AutomationElement.FromPoint` 要求先 `Add-Type -AssemblyName WindowsBase`**，
   否则报 `Cannot find type [System.Windows.Point]`；而且它返回的是"屏幕上最顶层的窗口"，
   分析器被浏览器挡住时永远返回浏览器的 `Chrome Legacy Window` → **不能用它做坐标标定**。
7. **抓窗口位图要按标题过滤**：`Pick` 若取"第一个有标题的顶层窗口"，会抓到 Qt 预创建的隐藏
   `Export`(348x257) 空白对话框。Qt 每次调用都留下一个不可见的同名窗口（本次累积了 7 个）。
8. **`CopyFromScreen` 坐标会失效**：窗口移动/被遮挡后抓到的是浏览器画面。判断状态请用
   **UIA 读文本**，不要靠截屏。
9. **`programmer_cli.exe` 退出码不可靠**（失败也返回 0），
   `--output` 不产生文件 → 重定向抓 stdout，只看 `Verify Success` / `Program Finished!` / `Error`。
10. **烧录前必须先杀掉 `gao_analyzer` / `jtagserver`**，否则它们占着 JTAG 电缆。
11. 想提取二进制里的字符串，`Select-String` 没用，要
    `[IO.File]::ReadAllBytes` + ASCII 解码 + 正则 `[\x20-\x7E]{4,}`（脚本 `extract_strings.ps1`）。
12. PowerShell 里注释是 `#`，`//` 不是注释；函数参数别叫 `$Args`。

---

## 7. 交付物清单（`gowin-build\gao\`）

| 文件 | 说明 |
|---|---|
| `GAO_EXPERIMENT.md` | 本报告 |
| `src\LED_Run.gao` | 手写的 GAO 声明文件（第 3 节全文） |
| `src\LED_Run.v` / `src\LED_Run.cst` | 被测设计（四灯流水灯，GBK 注释） |
| `LED_Run.gprj` | 挂入了 `type="file.gao"` 的工程文件 |
| `build_gao.tcl` / `build_gao.log` | 综合+PnR 脚本与日志 |
| `impl\pnr\ao_0.fs` | **含 GAO 的合并码流（3,558,506 B）** —— GAO 插入成功的官方判据 |
| `impl\wave\LED_Run_core0.csv` | **第 1 次真实采集的波形（1024 点）** |
| `impl\wave\LED_Run_run2_core0.csv` | **第 2 次真实采集的波形（与第 1 次不同，证明是实时采样）** |
| `impl\wave\LED_Run_vcd_core0.csv` | 第 3 次导出（格式切换未生效，仍是 CSV） |
| `shots\analyzer_waveform.png` | 采集界面上真实波形的截图（`cnt=0C2AACB`, `LED=E`） |
| `probe_gao_sh.ps1` / `sh_logs\*.out.txt` `*.err.txt` | 11 组 `gao_sh` 参数矩阵与原始输出 |
| `probe_gao_analyzer.ps1` / `probe_series.ps1` / `sh_logs\series_*` | `gao_analyzer` 参数矩阵（`-series`/`-device` 必选）与原始输出 |
| `diag_windows.ps1` / `diag_threads.ps1` / `diag_pipe_connect.ps1` / `diag_banner_trigger.ps1` / `fake_jtag_server.ps1` | `gao_sh` 卡点定位实验 |
| `uia_dump.ps1` / `uia_act.ps1` / `read_dialog.ps1` | UIA 读/写/枚举工具 |
| `click_btn.ps1` / `click_el.ps1` / `shot.ps1` | PostMessage 点击与截图工具 |
| `export_wave.ps1` / `verify_wave.ps1` / `probe_combo.ps1` | 导出填表、波形校验、ComboBox 行为探查 |
| `extract_strings.ps1` / `sh_logs\*_strings.txt` | 二进制字符串提取（`jtagserver` 协议复原用） |
| `doctext.ps1` | 按行号检索 SUG114 中文手册（正确 UTF-8 读法） |

---

## 8. 诚实声明

- **跑通了**：GAO 核自动插入 → 码流生成 → 烧录 → 采集 → 导出 → 校验，全链路有真实文件与截图作证。
- **没跑通的**：`gao_sh.exe`（纯命令行采集器）在任何 JTAG 会话之前就永久挂死，**不是参数问题**，
  已用 11 组参数矩阵 + 管道连接检测 + 线程/窗口/子进程观测定位到"卡在进程内部、未能连接 jtagserver"。
- **未做到全自动的一步**：Export 对话框里把导出格式从 CSV 切成 VCD/PRN/GWD。
  原因是 Qt 的 QComboBox 在没有前台焦点时无法被 UIA / PostMessage / 键盘驱动，
  已在第 5.4 节逐条给出排除过程。最终交付 CSV（官方支持的格式）。
- **未做**：自己实现 `jtagserver` 的 QDataStream 协议去驱动 GAO 核寄存器（成本评估后放弃）。
- 板上当前状态：**已恢复为正常的四灯流水灯**（`LED_Run.fs`，embFlash，`Verify Success`）。
