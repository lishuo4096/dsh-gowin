---
name: gowin-fpga
description: 高云 Gowin FPGA 全流程：器件/配置码、本板引脚表、.cst/.sdc 约束、gw_sh 编译、programmer_cli 烧录、GAO 在线逻辑分析仪、布局布线报告解读。当任务涉及高云 Gowin、GW1N、.gprj/.cst/.sdc/.fs/.gao、gw_sh、programmer_cli、GAO、或目标板 FG202 / GW1N-UV9LQ144 时使用。
user-invocable: true
---

# 高云 Gowin FPGA 开发

你手里有 **15 个 `gowin_*` 工具**，它们封住了高云 1.9 CLI 的全部已探明行为与坑。
**不要**直接去跑 `gw_sh.exe` / `programmer_cli.exe` / `gao_analyzer.exe` —— 用工具，
坑（尤其是「判据」类的坑）都已经写进实现里了。

## 一、动手顺序

```
gowin_env      →  确认安装根 / 三个入口程序 / License
gowin_board    →  本板引脚与极性（LED 与按键都是低电平有效）
gowin_project  →  看现有工程全貌（文件表 + 引脚分配 + 约束 + 已有产物）
gowin_check    →  ★ 编译前机械校验（引脚冲突 / 1.8V Bank / 专用脚 / 文件缺失）
gowin_build    →  gw_sh 编译（syn | pnr | all）
gowin_report   →  资源 / 引脚 / 时序裕量 / cmd.do / device.cfg
gowin_program  →  烧录（判据看控制台文本，不看退出码）
```

从零开始时，把 `gowin_project` + `gowin_check` 换成 `gowin_init`（生成骨架）。

## 二、四条必须刻在脑子里的判据

1. **编译成功 = 退出码 0 **且** `impl\` 下出现 `.fs`**。
   退出码 0 但没有 `.fs` 就是失败。stderr 里的
   `alog error: failed to open log file` 是**无害噪声**，绝不能用它判失败。

2. **`programmer_cli.exe` 的退出码不可靠 —— 失败也返回 0。**
   只能看控制台文本：`Finished.` / `Verify Success` / `Program Finished!` / `Error`。
   退出码 48 = 没扫到下载器，49 = 有下载器没器件。

3. **`operation_index 4`（SRAM Program+Verify）在本器件上恒报**
   `Error: Verify failed of at 0` —— 已知假失败。SRAM 用 **2**，掉电保持用 **6**。

4. **加了 GAO 之后码流会改名。** `run pnr` 会自动插入 GAO 核，
   `impl\pnr\` 里**不再生成 `<顶层>.fs`，只有 `ao_0.fs`**（约 3.5 MB）。烧录要烧 `ao_0.fs`。

## 三、目标板事实（FG202 / GW1N-UV9LQ144）

工具 `gowin_board` 会给出全部细节；记住这几条最容易出错的：

| 项 | 事实 |
|---|---|
| 器件 | `GW1N-9C` / `GW1N-UV9LQ144C6/I5` / version `C` / 配置码 `gw1n9c-019` |
| 时钟 | **只有一颗 50 MHz 晶振**，接 **pin98**（IOR9[A]/GCLKT_2，专用全局时钟脚） |
| LED ×4 | **IO27/28/29/30**，**低电平点亮（0=亮，1=灭）** |
| 按键 ×4 | IO75/76/97/99，**按下=0**，**无硬件消抖** |
| RST_N | **就是 IO75 = KEY1**，本板没有复位芯片，上电不会自动产生低脉冲 |
| UART | FPGA 发 **IO12**，收 **IO15** |
| EEPROM | SCL=**IO86**，SDA=**IO85**（**双向，必须 inout + 三态**） |
| SPI Flash | IO93/94/95/96（**同时是高云专用配置脚**，可复用，但别加 exclusive） |
| JTAG | IO13/14/16/18（**专用脚，不可当 GPIO**） |
| Bank 电压 | **3.3 V**（四个 Bank 由 0Ω 接 D3V3）。原厂 03/04/06 例程的 `.cst` 里写 `BANK_VCCIO=1.8`，**是错的，别照抄** |

`.gprj` 里器件写法（**器件名在属性、配置码是元素文本**，写反会用错器件）：

```xml
<Device name="GW1N-9C" pn="GW1N-UV9LQ144C6/I5">gw1n9c-019</Device>
```

## 四、`.cst` 与 `.sdc`

`.cst` 用 `gowin_cst` 生成（板级正确）；`.sdc` 至少要有：

```
create_clock -name CLK_50M -period 20 -waveform {0 10} [get_ports {CLK_50M}]
```

没有它就会看到 `WARN (TA1132)` —— 非致命，但时序报告没有时钟定义。

## 五、常见非致命警告（别慌）

`TA1132`（缺 .sdc 时钟定义）、`EX3012`（顺序块空语句）、
`EX3791`（32 位截断为 8 位）、`PA1015`（GAO 采样信号被替换为 `_d`，正常）。

## 六、排错剧本

`gowin_help` 里带主题剧本，直接调：

- `gowin_help { topic:"build_failed" }` —— 编译失败怎么查
- `gowin_help { topic:"all_leds_off" }` —— **上板四灯全灭怎么查**（本工程踩过：先怀疑了 RST_N，其实是 LED 极性 + 时钟脚）
- `gowin_help { topic:"gao_capture" }` —— GAO 采集流程
- `gowin_help { topic:"wrong_pins" }` —— 上板没反应 / 外设不工作
- `gowin_help { topic:"first_time" }` —— 从零到上板的最短路径
- `gowin_help { pitfalls:true }` —— 全部 22 条踩坑清单

## 七、必读资料

- 本插件 `references/gowin-agent-guide.md` —— 上一个任务的完整操作手册（10 章，含 22 条坑与全部实测数据）
- `references/gao-experiment.md` —— GAO 实验记录（含 Qt UIA 驱动的死路与绕法）
- `references/closed-loop-report-notes.md` —— 一次完整闭环的构建记录与「全灭」故障诊断过程
- `gowin_docs` —— 官方 PDF 路标（SUG1220=TCL 权威、SUG114=GAO 权威、UG114=逐脚 pinout）

## 八、明确不要做的事

- ❌ 不要跑 `gw_ide.exe`（加 `-h` 也拉 GUI 并挂住）
- ❌ 不要跑 `gao_sh.exe`（argv[1] 为 `-gao` 时**永久挂死**；GAO 只走 `gao_analyzer.exe`）
- ❌ 不要跑 `programmer.exe`（GUI；用 `programmer_cli.exe`）
- ❌ 不要在 `gao_analyzer.exe` 上用文档写的 `-fs`（实际是 `--fsFile`），也别漏掉 `-series` 与 `-device`（必须同时给）
- ❌ 不要把 `.fs` 哈希当成「两次构建是否等价」的判据（内嵌路径/时间戳，逐字节不同）
