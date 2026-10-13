/**
 * dsh-gowin 冒烟测试：用假 ctx 注册全部工具，再**真调**一遍只读工具。
 *
 * 与 `_selftest.mjs` 的分工：自测验纯函数与解析器，冒烟验「注册面 + 工具 execute 真的跑得通、
 * 渲染出的文本是人能看的」—— 这两件事只有拼起来才知道插件在 DSH 里会不会当场炸。
 *
 *   node _smoke.mjs            # 只读工具（不碰工具链）
 *   node _smoke.mjs --toolchain  # 额外真跑 gw_sh 探针（约 10 s）
 */

import { registerGowinTools } from './lib/tools.js';
import { commandSpec, resolveGowinRoot } from './lib/env.js';

const WORKSPACE = 'C:\\Users\\lishuo\\Documents\\deepseek-harness\\default-workspace';
const FIXTURE = `${WORKSPACE}\\gowin-build\\07_LED_Flow\\LED_Run\\LED_Run.gprj`;
const WITH_TOOLCHAIN = process.argv.includes('--toolchain');

const registered = new Map();
const fakeCtx = {
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
      return tool;
    },
  },
};

const names = registerGowinTools(fakeCtx);
console.log(`注册了 ${names.length} 个工具：${names.join(', ')}\n`);

let bad = 0;

/** 调一个工具并打印其渲染结果的前几行。 */
async function call(tool, args = {}) {
  const t = registered.get(tool);
  if (!t) {
    console.log(`✗ ${tool} 未注册`);
    bad += 1;
    return null;
  }
  let value;
  try {
    value = await t.execute(args, { cwd: WORKSPACE });
  } catch (error) {
    console.log(`✗ ${tool} execute 抛异常：${error instanceof Error ? error.message : String(error)}`);
    bad += 1;
    return null;
  }
  let text;
  try {
    const blocks = t.output.render(args, value);
    text = blocks.map((b) => b.text).join('\n');
  } catch (error) {
    console.log(`✗ ${tool} render 抛异常：${error instanceof Error ? error.message : String(error)}`);
    bad += 1;
    return null;
  }
  if (!text || !text.trim()) {
    console.log(`✗ ${tool} 渲染出空文本`);
    bad += 1;
    return null;
  }
  const lines = text.split('\n');
  console.log(`✓ ${tool} → ${lines.length} 行`);
  for (const line of lines.slice(0, 6)) console.log(`    │ ${line}`);
  if (lines.length > 6) console.log(`    │ …（还有 ${lines.length - 6} 行）`);
  console.log('');
  return { value, text };
}

await call('gowin_env');
await call('gowin_device');
await call('gowin_board', { peripheral: 'led' });
await call('gowin_board', { pin: 'IO98' });
await call('gowin_board', { pin: 'IOR9[A]' });
await call('gowin_project', { file: FIXTURE });
await call('gowin_cst', { which: ['clk', 'led', 'key'] });
await call('gowin_check', { file: FIXTURE });
await call('gowin_report', { file: FIXTURE, section: 'resource' });
await call('gowin_report', { file: FIXTURE, section: 'timing' });
await call('gowin_artifacts', { file: FIXTURE });
await call('gowin_gao', { action: 'inspect', file: FIXTURE });
await call('gowin_docs', { topic: 'gao' });
await call('gowin_help', {});
await call('gowin_help', { topic: 'all_leds_off' });

// 不存在的工程：所有工具都必须给出可读原因，而不是抛异常或返回空白
await call('gowin_project', { file: `${WORKSPACE}\\nope.gprj` });
await call('gowin_check', { file: `${WORKSPACE}\\nope.gprj` });

// 被禁用的入口必须在调用前就被拦下（commandSpec 是唯一的出口，所以直接验它）
const gaoSh = commandSpec({ root: resolveGowinRoot({}).root, tool: 'gao_sh' });
if (gaoSh.ok !== false || !/挂死/.test(gaoSh.message ?? '')) {
  console.log(`✗ gao_sh 没有被拦下：${JSON.stringify(gaoSh)}`);
  bad += 1;
} else {
  console.log(`✓ gao_sh 被拦下 → ${gaoSh.message.slice(0, 60)}…\n`);
}
const ide = commandSpec({ root: resolveGowinRoot({}).root, tool: 'gw_ide' });
if (ide.ok !== false) {
  console.log(`✗ gw_ide 没有被拦下：${JSON.stringify(ide)}`);
  bad += 1;
} else {
  console.log(`✓ gw_ide 被拦下 → ${ide.message.slice(0, 60)}…\n`);
}

if (WITH_TOOLCHAIN) {
  await call('gowin_tcl', { commands: ['puts "tcl=[info patchlevel]"', 'puts "cmds=[llength [info commands]]"'] });
}

console.log('─'.repeat(64));
if (bad === 0) {
  console.log('冒烟通过 —— 全部工具注册且 execute/render 可用');
  process.exit(0);
}
console.log(`冒烟失败 ${bad} 项`);
process.exit(1);
