/**
 * dsh-gowin —— 高云 Gowin FPGA 工具链插件（gw_sh 编译 / programmer_cli 烧录 / GAO 在线逻辑分析仪）。
 *
 * 把上一个「摸清高云 1.9 CLI 并跑通闭环」项目的可复用部分整理成一个 DSH 插件：
 *   - `ctx.tools`  注册 15 个工具：gowin_env / gowin_device / gowin_board /
 *                  gowin_project / gowin_init / gowin_cst / gowin_check / gowin_build /
 *                  gowin_program / gowin_report / gowin_artifacts / gowin_tcl /
 *                  gowin_gao / gowin_docs / gowin_help
 *   - `ctx.skills` 注册包内 `skills/**\/SKILL.md`
 *
 * **为什么这个插件有存在的价值**：高云 CLI 的坑几乎全在「判据」上 ——
 * `programmer_cli` 失败也返回 0；`gw_sh` 的 stderr 全是无害噪声；
 * `.fs` 不能比哈希；加了 GAO 码流会改名 `ao_0.fs`；`gao_sh.exe` 会永久挂死。
 * 这些全部固化进了工具实现里，而不是让模型每次重新踩。
 *
 * @module @local/dsh-gowin
 */

import { registerGowinTools } from './lib/tools.js';
import { createProvider, PROVIDER_NAME } from './lib/skills.js';

/** Cordis 插件 id（与 cordis.patch.yml 里的 insert.id 一致）。 */
export const name = 'gowin';

/** 依赖的 cordis 服务。 */
export const inject = ['tools', 'skills'];

export function apply(ctx) {
  const toolNames = registerGowinTools(ctx);
  console.log(`[gowin] 已注册 ${toolNames.length} 个工具: ${toolNames.join(', ')}`);
  try {
    ctx.skills.registerProvider((control) => createProvider(control));
    console.log(`[gowin] 已注册技能 provider: ${PROVIDER_NAME}（skills/ 下的 SKILL.md）`);
  } catch (error) {
    console.error('[gowin] 技能 provider 注册失败（工具仍可用）:', error instanceof Error ? error.message : String(error));
  }
}

export { registerGowinTools } from './lib/tools.js';
export { createProvider } from './lib/skills.js';
export { DEVICE, PERIPHERALS, CLOCK, DEFAULT_IO_PORT, boardSummary, cstSnippet, pinRole } from './lib/board.js';
export { resolveGowinRoot, probeTools, licenseInfo, commandSpec, discoverRoots } from './lib/env.js';
export { parseGprj, parseCst, parseSdc, groupFiles, renderGprj, renderCreateClock } from './lib/gprj.js';
export { runBuild, runTclCommands, collectArtifacts, findPnrReport, findSynReport } from './lib/build.js';
export { checkProject, checkCst } from './lib/check.js';
export { parsePnrReport, parseTimingPaths, parseCmdDo, parseDeviceCfg } from './lib/report.js';
