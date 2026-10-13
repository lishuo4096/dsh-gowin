# dsh-gowin —— DSH 的高云 Gowin IDE 插件

把**高云 Gowin 1.9 工具链**（`gw_sh.exe` / `programmer_cli.exe` / `gao_analyzer.exe`）接进 DSH：
15 个工具 + 1 个技能（skill），让 DSH 会话里能直接**探测环境、建模、静态校验、编译、烧录、在线调试、读报告**，
并把它在真实闭环里踩到的坑写成机器可查的清单。

- 工具前缀统一 `gowin_`，全部只读优先、结论带**原始证据**（行号 / 语句 / 文件路径）。
- **不发明事实**：所有引脚、极性、器件配置码都来自 `FG202 GW1N-UV9LQ144` 原理图，并已与例程 `.cst` 逐脚交叉验证、上板跑通。
- 尚未上板验证的项（如外部 flash 烧录）在工具说明与文档里明确标注为**未验证**。

---

## 一、安装

```js
plugin_manager({ action: 'install_bundle', target: 'C:/Users/lishuo/Documents/deepseek-harness/default-workspace/dsh-gowin' })
```

`install_bundle` 会同时把 `"@local/dsh-gowin": "link:<该目录>"` 写进 profile 的 `dependencies`
和 `dsh.profile.bundles`。装完**新开一个会话**即可看到 `gowin_*` 工具与 `gowin-fpga` 技能。

卸载：`plugin_manager({ action: 'remove_bundle', target: '@local/dsh-gowin' })`。

---

## 二、15 个工具

| 工具 | 干什么 |
|---|---|
| `gowin_env` | 探测安装根（**多版本容忍**：本机同时有 V1.9.12.02_SP2 与 V1.9.11.03 Education）、三个入口程序、License 有效性。**任何高云任务的第一步** |
| `gowin_device` | 本板器件事实：`GW1N-9C` / `GW1N-UV9LQ144C6/I5` / `device_version C` / 配置码 `gw1n9c-019` |
| `gowin_board` | 引脚与极性速查（带 `pin` 可反查某脚在板上是什么） |
| `gowin_project` | 读 `.gprj` 全貌：器件、文件表（含「登记了但磁盘上没有」的）、`.cst` 引脚分配、`.sdc` 时钟 |
| `gowin_init` | 生成**能直接编译**的工程骨架：`.gprj` + `.cst` + `.sdc` + 可选顶层。默认不覆盖 |
| `gowin_cst` | 生成 / 校验物理约束。默认只打印，`write:true` 才落盘 |
| `gowin_check` | **编译前**机械校验，每条带行号与原始语句 |
| `gowin_build` | 调 `gw_sh.exe` 编译（`syn` / `pnr` / `all`），跑完自动汇总错误、警告、产物 |
| `gowin_program` | 烧录 / 扫描（`sram` / `flash` / `scan`） |
| `gowin_report` | 结构化读产物：资源占用、I/O Bank、时钟资源、逐端口引脚表、逐路径时序裕量、`cmd.do` / `device.cfg` |
| `gowin_artifacts` | 列 `impl\` 全部产物（大小 / 时间 / **哪个是要烧的**） |
| `gowin_tcl` | 在 `gw_sh` 里跑任意 TCL 命令串。**查权威用法的正确方式**（122 个命令，任何命令加 `-h`） |
| `gowin_gao` | GAO 在线逻辑分析仪：读 `.gao` / `.rao` 定义，`launch:true` 启动采集界面 |
| `gowin_docs` | 文档路标 + 在已抽出的中文文档文本里做关键词搜索 |
| `gowin_help` | 排错剧本（`build_failed` / `all_leds_off` / `gao_capture` / `wrong_pins` / `first_time`）与踩坑清单 |

**技能** `gowin-fpga`（`skills/gowin-fpga/SKILL.md`）是任务级入口：从零到上板的完整流程、
何时用哪个工具、以及必须停下来查手册的判据。references 里带三份原文
（`gowin-agent-guide.md` 手册全文、`gao-experiment.md` GAO 实验记录、`closed-loop-report-notes.md` 闭环报告笔记）。

---

## 三、典型流程

```
gowin_env                       # 1. 有没有工具链、License 行不行
gowin_board {peripheral:'led'}  # 2. 板子上 LED 接哪几个脚、什么极性
gowin_init  {dir:'...', demo:true}   # 3. 生成骨架（.gprj/.cst/.sdc/顶层）
gowin_check {file:'...gprj'}    # 4. 编译前机械校验 —— 省掉整轮编译时间
gowin_build {task:'all'}        # 5. 出码流
gowin_report{section:'timing'}  # 6. 时序裕量有没有违规
gowin_program {mode:'sram'}     # 7. 上板
```

在线调试：`gowin_cst` / 手写 `.gao` → `gowin_build`（**码流变成 `ao_0.fs`**）→ `gowin_program {fsFile:'...ao_0.fs'}` → `gowin_gao {launch:true}`。

---

## 四、设计约束（为什么这么写）

1. **成功判据是「退出码 0 且 `impl` 下出现 `.fs`」**，不是「stdout 里没有 ERROR」。
   `gw_sh` 中途失败也可能退出 0；而 stderr 里的 `alog error: failed to open log file`
   是本机 AppData 写不进去造成的**无害噪声**，已被 `cleanOutput` 过滤，绝不能拿它判失败。
2. **`programmer_cli` 的退出码不可靠**（失败也返回 0），判据只能看控制台文本
   （`Finished.` / `Verify Success` / `Error`）。且 `operation_index 4` 在本器件上
   **恒报假失败** `Error: Verify failed of at 0`，所以 SRAM 默认走 2。
3. **禁用三个入口**：`gw_ide.exe`（加 `-h` 也拉 GUI 并挂住）、`gao_sh.exe`
   （`argv[1]` 为 `-gao` 时**永久挂死**，定向实验证明它从不连 `\\.\pipe\gao1`）、`programmer.exe`（GUI）。
   `commandSpec()` 在调用前就把它们拦下并说明原因。
4. **不依赖宿主 asar 内的包**：用同目录的 `lib/define-tool.js` / `lib/frontmatter.js`
   （以 `link:` 装载时插件目录解析不到 `@deepseek-ai/dsh-tools`，直接 import 会
   `ERR_MODULE_NOT_FOUND`，整个插件行 `failed to import`）。
5. **技能注册失败不拖垮插件**：`apply()` 里对 `skills` 单独 `try/catch`，只打日志。
6. **`.fs` 不能比哈希**：逐字节不完全相同（内嵌路径与时间戳，差十几字节）。
   判两次构建等价要比 `cmd.do` / `device.cfg` / 资源报告。

---

## 五、目录结构

```
dsh-gowin/
├── index.js                 # cordis 插件入口：name / inject / apply
├── package.json             # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml         # insert: [{id: gowin, name: "@local/dsh-gowin"}]
├── lib/
│   ├── define-tool.js       # 本地化 defineTool（不依赖宿主 asar）
│   ├── frontmatter.js       # SKILL.md frontmatter 解析（含 YAML 块标量）
│   ├── env.js               # 安装根发现、命令规格、License、禁用清单
│   ├── board.js             # FG202 板级事实（引脚 / 极性 / 专用脚）
│   ├── gprj.js              # .gprj / .cst / .sdc 解析与生成
│   ├── check.js             # 静态机械校验规则
│   ├── build.js             # gw_sh 调用、日志判据、产物收集
│   ├── report.js            # pnr 报告 / timing_paths / cmd.do / device.cfg 解析
│   ├── tools.js             # 15 个工具定义 + 踩坑清单 + 剧本
│   └── skills.js            # skill provider
├── skills/gowin-fpga/SKILL.md
├── references/              # 手册全文、GAO 实验记录、闭环报告笔记
└── _selftest.mjs            # 零依赖自测（345 项断言，含真编译开关）
```

---

## 六、自测

```powershell
$node = 'C:\Users\lishuo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd C:\Users\lishuo\Documents\deepseek-harness\default-workspace\dsh-gowin
& $node _selftest.mjs            # 纯函数 + 真实工程夹具解析（不开工具链）
& $node _selftest.mjs --build    # 额外真跑一次 gw_sh 全链路（约 1-2 分钟）
```

夹具是 `gowin-build\07_LED_Flow\LED_Run\LED_Run.gprj`（一份真实编译过的工程）。
`--build` 实测结果：`gw_sh` 退出码 0、`verdict=ok`、生成 `LED_Run.fs`、日志尾行 `########## BUILD SUCCESS (all)`。

---

## 七、环境前提

| 项 | 值 |
|---|---|
| 安装根 | `C:\Gowin\Gowin_V1.9.12.02_SP2_x64`（`PREFERRED_ROOTS` 里另列了 `V1.9.11.03_Education_x64`） |
| 编译 | `<root>\IDE\bin\gw_sh.exe` |
| 烧录 | `<root>\Programmer\bin\programmer_cli.exe` |
| 在线调试 | `<root>\IDE\bin\gao_analyzer.exe`（**cwd 必须是 `IDE\bin`**） |
| License | `<root>\IDE\bin\gwlicense.ini` → `gowin_E_1413338ED23B.lic` |
| `GOWIN_HOME` | 每次调用都由插件显式注入（不设会直接报 `Please set environment variable GOWIN_HOME`） |

本机没有 `pwsh`（只有 Windows PowerShell 5.1）、执行策略 `Restricted`；插件不依赖 PowerShell，
所有进程调用走 `spawnSync`。

---

## 八、已知未验证 / 受限项

- **外部 SPI Flash 烧录**（`operation_index 9`）：示例脚本写了但**未实机验证**。
- **GAO 导出 VCD/GWD**：Qt QComboBox 在该 build 下 `List` rect 为空，`SelectionItemPattern.Select()`
  报成功但读回不变，键盘 `VK_DOWN` 因窗口无焦点无效 → 目前只能全自动到 CSV。
- **`jtagserver.exe` 无头旁路**：协议已逆向（命名管道 `gao1` + TCP 36548），但 GAO 核寄存器时序
  在服务端之外，成本过高，**已放弃**。
- **RTL 功能仿真**：本机未装 ModelSim/Questa，`IDE\simlib` 是空壳，不可行。
- **`.sdc` 时序约束**：原厂例程都没加（故有 `TA1132`）；`gowin_init` 生成的工程会带上
  `create_clock -name CLK_50M -period 20`。
