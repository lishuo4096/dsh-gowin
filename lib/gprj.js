/**
 * `.gprj` 工程文件与 `.cst` / `.sdc` 约束文件的**解析**（纯函数，不落盘）。
 *
 * 格式来源：实测工程文件 + 手册 §3.2 / §3.3。
 *
 * `.gprj` 的关键点（踩过）：
 *   - `<Device name="GW1N-9C" pn="GW1N-UV9LQ144C6/I5">gw1n9c-019</Device>`
 *     —— 器件名在**属性**里，而**元素文本**是配置码。两者都要，且不能互换。
 *   - `<File path="src/x.v" type="file.verilog" enable="1"/>`，路径**相对 `.gprj` 所在目录**，
 *     用正斜杠。
 *   - 文件类型字符串：`file.verilog` / `file.vhdl` / `file.cst` / `file.gao` / `file.rao` / `file.sdc`。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// ------------------------------------------------------------ 极简 XML 解析

const TAG_RE = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\/([A-Za-z_][\w.:-]*)>/g;

function parseAttrs(text) {
  const attrs = {};
  const re = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(text)) !== null) attrs[m[1]] = m[2] ?? m[3] ?? '';
  return attrs;
}

/**
 * 把一个扁平 XML 文本解析成元素列表（够用即可，不追求通用）。
 * 返回 `[{tag, attrs, text}]`，`text` 是元素自身的文本内容。
 */
export function parseFlatXml(xml) {
  const src = String(xml ?? '').replace(/^\uFEFF/, '');
  const elements = [];
  const stack = [];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src)) !== null) {
    // 元素开标签之前的文本归给栈顶元素
    if (stack.length > 0) {
      const between = src.slice(last, m.index);
      if (between.trim()) stack[stack.length - 1].text += between.trim();
    }
    last = TAG_RE.lastIndex;
    if (m[4] !== undefined) {
      // 闭标签
      const open = stack.pop();
      if (open) elements.push(open);
      continue;
    }
    const node = { tag: m[1], attrs: parseAttrs(m[2] ?? ''), text: '' };
    if (m[3] === '/') elements.push(node);
    else stack.push(node);
  }
  while (stack.length > 0) elements.push(stack.pop());
  return elements;
}

// ------------------------------------------------------------ .gprj

const FILE_TYPE_BY_EXT = {
  '.v': 'file.verilog',
  '.sv': 'file.verilog',
  '.vh': 'file.verilog',
  '.vhd': 'file.vhdl',
  '.vhdl': 'file.vhdl',
  '.cst': 'file.cst',
  '.sdc': 'file.sdc',
  '.gao': 'file.gao',
  '.rao': 'file.rao',
  '.fs': 'file.fs',
  '.ipc': 'file.ipc',
  '.vg': 'file.verilog',
};

/** 按扩展名猜 `.gprj` 的 `type` 字符串。 */
export function fileTypeOf(path) {
  const m = /(\.[A-Za-z0-9]+)$/.exec(String(path));
  return m ? FILE_TYPE_BY_EXT[m[1].toLowerCase()] ?? null : null;
}

/**
 * 解析 `.gprj`。
 *
 * @param {string} path `.gprj` 绝对路径
 * @returns 解析结果；文件读不动时 `ok:false`
 */
export function parseGprj(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, message: `读不了 ${path}：${error instanceof Error ? error.message : String(error)}` };
  }
  const root = dirname(path);
  const elements = parseFlatXml(text);

  const deviceEl = elements.find((e) => e.tag === 'Device');
  const templateEl = elements.find((e) => e.tag === 'Template');
  const versionEl = elements.find((e) => e.tag === 'Version');
  const files = elements
    .filter((e) => e.tag === 'File')
    .map((e) => {
      const rel = e.attrs.path ?? '';
      const abs = rel ? (isAbsolute(rel) ? rel : resolve(root, rel.replace(/\//g, '\\'))) : '';
      return {
        path: rel,
        abs,
        type: e.attrs.type ?? fileTypeOf(rel),
        enable: e.attrs.enable === undefined ? true : e.attrs.enable === '1',
        exists: abs ? existsSync(abs) : false,
      };
    });

  return {
    ok: true,
    path,
    root,
    template: templateEl?.text ?? null,
    version: versionEl?.text ?? null,
    device: {
      name: deviceEl?.attrs.name ?? null,
      pn: deviceEl?.attrs.pn ?? null,
      configCode: deviceEl?.text?.trim() || null,
    },
    files,
  };
}

/** 一个已解析工程里的源文件，按类型分组。 */
export function groupFiles(parsed) {
  const g = { verilog: [], vhdl: [], cst: [], sdc: [], gao: [], rao: [], other: [] };
  for (const f of parsed.files ?? []) {
    const t = String(f.type ?? '');
    if (t === 'file.verilog') g.verilog.push(f);
    else if (t === 'file.vhdl') g.vhdl.push(f);
    else if (t === 'file.cst') g.cst.push(f);
    else if (t === 'file.sdc') g.sdc.push(f);
    else if (t === 'file.gao') g.gao.push(f);
    else if (t === 'file.rao') g.rao.push(f);
    else g.other.push(f);
  }
  return g;
}

/** 生成一份 `.gprj` 文本。 */
export function renderGprj({ deviceName, pn, configCode, files }) {
  const rows = files
    .map((f) => `        <File path="${f.path}" type="${f.type}" enable="${f.enable === false ? 0 : 1}"/>`)
    .join('\n');
  return `<?xml version="1" encoding="UTF-8"?>
<!DOCTYPE gowin-fpga-project>
<Project>
    <Template>FPGA</Template>
    <Version>5</Version>
    <Device name="${deviceName}" pn="${pn}">${configCode}</Device>
    <FileList>
${rows}
    </FileList>
</Project>
`;
}

// ------------------------------------------------------------ .cst

/**
 * 解析 `.cst` 物理约束。
 *
 * 语句形态：
 *   IO_LOC "NAME" <pin>[ other|exclusive];
 *   IO_PORT "NAME" KEY=VALUE KEY=VALUE …;
 *   IO_LOC "LED[0]" 27 exclusive;
 */
export function parseCst(text) {
  const src = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');

  const locs = [];
  const ports = [];
  const other = [];
  const errors = [];

  // 先去掉 // 与 /* */ 注释（注释里常含 Part Number 之类，别当约束解析）
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  // 按分号切语句，保留行号用于报错定位
  let line = 1;
  let buf = '';
  let bufLine = 1;
  const statements = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '\n') {
      line += 1;
      if (buf.trim() === '') bufLine = line;
    }
    if (ch === ';') {
      if (buf.trim()) statements.push({ text: buf.trim(), line: bufLine });
      buf = '';
      bufLine = line;
      continue;
    }
    if (buf.trim() === '' && /\S/.test(ch)) bufLine = line;
    buf += ch;
  }
  if (buf.trim()) statements.push({ text: buf.trim(), line: bufLine });

  for (const st of statements) {
    const t = st.text.replace(/\s+/g, ' ').trim();
    let m = /^IO_LOC\s+"([^"]+)"\s+(\S+)(?:\s+(.*))?$/i.exec(t);
    if (m) {
      const pin = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
      locs.push({ name: m[1], pin, rawPin: m[2], flags: (m[3] ?? '').trim(), line: st.line, text: t });
      continue;
    }
    m = /^IO_PORT\s+"([^"]+)"\s+(.*)$/i.exec(t);
    if (m) {
      const attrs = {};
      for (const kv of m[2].split(/\s+/)) {
        const eq = kv.indexOf('=');
        if (eq > 0) attrs[kv.slice(0, eq)] = kv.slice(eq + 1);
        else if (kv) attrs[kv] = true;
      }
      ports.push({ name: m[1], attrs, line: st.line, text: t });
      continue;
    }
    if (t) other.push({ line: st.line, text: t });
  }

  return {
    locs,
    ports,
    other,
    errors,
    byPin: groupByPin(locs, ports, other),
  };
}

/** 把 IO_LOC / IO_PORT / 其它语句归到同一个信号名下，便于逐信号检查。 */
function groupByPin(locs, ports, other) {
  const map = new Map();
  const ensure = (name) => {
    if (!map.has(name)) map.set(name, { name, loc: null, port: null, extra: [] });
    return map.get(name);
  };
  for (const l of locs) ensure(l.name).loc = l;
  for (const p of ports) ensure(p.name).port = p;
  for (const o of other) {
    const m = /"([^"]+)"/.exec(o.text);
    if (m) ensure(m[1]).extra.push(o);
  }
  return map;
}

/** `IO_PORT` 的属性对象 → 一行可读文本。 */
export function portAttrsText(attrs = {}) {
  const order = ['IO_TYPE', 'PULL_MODE', 'DRIVE', 'BANK_VCCIO'];
  const keys = [...order.filter((k) => k in attrs), ...Object.keys(attrs).filter((k) => !order.includes(k))];
  return keys.map((k) => (attrs[k] === true ? k : `${k}=${attrs[k]}`)).join(' ');
}

// ------------------------------------------------------------ .sdc

/**
 * 解析 `.sdc` 时序约束（只认最常见的那几条，够判「有没有时钟定义」）。
 */
export function parseSdc(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const clocks = [];
  const lines = [];
  src.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    lines.push({ line: i + 1, text: line });
    const m = /create_clock\b(.*)/i.exec(line);
    if (m) {
      const args = m[1];
      const name = /-name\s+(\S+)/i.exec(args)?.[1] ?? null;
      const period = /-period\s+([\d.]+)/i.exec(args)?.[1] ?? null;
      const target = /\[get_ports\s+\{?([^}\]]+)\}?\]/i.exec(args)?.[1]?.trim() ?? null;
      clocks.push({ name, period: period === null ? null : Number(period), target, line: i + 1 });
    }
  });
  return { clocks, lines };
}

/** 生成一条最常用的 `create_clock`（消除 `WARN (TA1132)`）。 */
export function renderCreateClock({ name = 'CLK_50M', periodNs = 20 } = {}) {
  return `create_clock -name ${name} -period ${periodNs} -waveform {0 ${periodNs / 2}} [get_ports {${name}}]\n`;
}

export { join, isAbsolute };
