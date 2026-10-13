/**
 * `defineTool` 的本地实现 —— 让插件**不依赖任何 `@deepseek-ai/*` 包**。
 *
 * 为什么要自己实现：本插件以 `link:` 方式装进 profile 时，Node 会按插件目录的
 * **真实路径**向上找 `node_modules`，而 `@deepseek-ai/dsh-tools` 只存在于宿主
 * 自己的模块图里（Desktop 下它在 app.asar 内，磁盘上没有）——
 * 于是 `import { defineTool } from '@deepseek-ai/dsh-tools'` 会以
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'` 失败，
 * 整行插件 `failed to import`。实测：安装后 `dsh: warning: 1 entry did not activate /
 * enet-review (@local/dsh-enet-review): failed to import`。
 *
 * 宿主侧真正的机制在 `dsh-tools` 的 `defineTool`（lib/index.js:838）：
 * 它把作者侧 DSL 编译成原始 JSON Schema、给 `execute` 包一层参数校验、
 * 并把可选钩子原样透传。这里做等价的事，只依赖内置能力。
 *
 * 作者侧 DSL 兼容（`lib/tools.js` 就在用）：
 *   - 标量简写：`{ type: 'string', description, required, enum, default }`
 *   - `type: 'json'` → 一个 **开放/无约束** schema（`{}`），等价于
 *     `assertSupportedJsonSchema` 接受的空对象；`validateJsonSchemaValue` 对空
 *     schema 恒通过，所以「只返回被声明的 JSON 值」这一约束不被削弱。
 *   - 复合：`{ type: 'object', properties: {...} }` / `{ type: 'array', items: {...} }` /
 *     `{ oneOf: [...] }` —— 直接递归编译。
 *   - 已是原始 JSON Schema（含 `additionalProperties` / `oneOf` 等）的节点原样保留。
 */

/** 不需要额外关键字的简单类型。 */
const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** 已编译过的节点（原始 JSON Schema 特征）：带这些键就认为不必再编译。 */
const RAW_HINTS = ['properties', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', 'items'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 把一个作者侧节点编译成原始 JSON Schema。
 *
 * @param node 作者侧节点，或已是原始 schema 的节点
 * @returns 原始 JSON Schema 节点
 */
export function compileNode(node) {
  if (node === undefined || node === null) return {};       // 无约束
  if (node === true || node === false) return {};           // JSON Schema 布尔根：放开
  if (!isPlainObject(node)) return {};

  // 显式 type:'json' = 任意 JSON 值 = 开放 schema
  if (node.type === 'json') return {};

  // 已含复合关键字又没声明类型的，视为原始 schema，原样返回
  if (node.type === undefined && RAW_HINTS.some((k) => k in node)) {
    return { ...node };
  }

  const out = {};
  if (node.type === 'object') {
    out.type = 'object';
    const props = isPlainObject(node.properties) ? node.properties : {};
    const compiled = {};
    const required = [];
    for (const [key, child] of Object.entries(props)) {
      compiled[key] = compileNode(child);
      if (isPlainObject(child) && child.required === true) required.push(key);
    }
    out.properties = compiled;
    if (node.additionalProperties !== undefined) {
      out.additionalProperties = node.additionalProperties;
    }
    if (node.required !== undefined && Array.isArray(node.required)) {
      out.required = [...new Set([...node.required, ...required])];
    } else if (required.length) {
      out.required = required;
    }
    if (node.description !== undefined) out.description = node.description;
    return out;
  }

  if (node.type === 'array') {
    out.type = 'array';
    out.items = compileNode(node.items);
    if (node.minItems !== undefined) out.minItems = node.minItems;
    if (node.maxItems !== undefined) out.maxItems = node.maxItems;
    if (node.description !== undefined) out.description = node.description;
    return out;
  }

  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length === 1) return compileNode(node.oneOf[0]);
    out.oneOf = node.oneOf.map(compileNode);
    if (node.description !== undefined) out.description = node.description;
    return out;
  }

  if (PRIMITIVES.has(node.type)) {
    out.type = node.type;
    if (Array.isArray(node.enum)) out.enum = [...node.enum];
    if (node.default !== undefined) out.default = node.default;
    if (node.description !== undefined) out.description = node.description;
    return out;
  }

  // 没有可识别的类型 —— 原样保留剩余关键字，总比丢信息好
  return { ...node };
}

/**
 * 把参数描述表编译成对象根的原始 JSON Schema。
 *
 * 与 `dsh-tools` 的 `parameterSchemaSpecToJsonSchema` 同名同义：
 * 隐式开放（不写 `additionalProperties: false`），`required` 取显式 `required: true`。
 */
export function parameterSchemaSpecToJsonSchema(spec) {
  const props = isPlainObject(spec) ? spec : {};
  const properties = {};
  const required = [];
  for (const [key, child] of Object.entries(props)) {
    properties[key] = compileNode(child);
    if (isPlainObject(child) && child.required === true) required.push(key);
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** 把输出 schema 描述编译成原始 JSON Schema。 */
export function valueSchemaSpecToJsonSchema(spec) {
  return compileNode(spec);
}

/**
 * 参数校验：对照编译后的原始 JSON Schema 走一遍。
 *
 * 只实现本插件参数表真正用得到的子集（type / enum / oneOf / 必需键），
 * 且**只报错不纠正** —— 与 `validateArgs` 的语义一致（返回违规列表，
 * 空数组 = 通过），调用方据此抛 `ToolArgsError`。
 */
export function validateArgs(schema, args) {
  const violations = [];
  const path = (p) => (p === '' ? '(root)' : p);

  function walk(node, value, p) {
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.oneOf) && node.oneOf.length) {
      const hits = node.oneOf.filter((sub) => {
        const probe = [];
        walkInto(sub, value, p, probe);
        return probe.length === 0;
      });
      if (hits.length === 0) violations.push(`${path(p)}: 不匹配 any oneOf 分支`);
      return;
    }
    walkInto(node, value, p, violations);
  }

  function walkInto(node, value, p, sink) {
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      sink.push(`${path(p)}: 取值 ${JSON.stringify(value)} 不在 ${JSON.stringify(node.enum)} 内`);
      return;
    }
    switch (node.type) {
      case 'string':
        if (typeof value !== 'string') sink.push(`${path(p)}: 需要 string，收到 ${typeof value}`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') sink.push(`${path(p)}: 需要 boolean，收到 ${typeof value}`);
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) sink.push(`${path(p)}: 需要 number`);
        break;
      case 'integer':
        if (!Number.isInteger(value)) sink.push(`${path(p)}: 需要 integer`);
        break;
      case 'null':
        if (value !== null) sink.push(`${path(p)}: 需要 null`);
        break;
      case 'array':
        if (!Array.isArray(value)) {
          sink.push(`${path(p)}: 需要 array`);
        } else if (isPlainObject(node.items)) {
          value.forEach((v, i) => walkInto(node.items, v, `${p}[${i}]`, sink));
        }
        break;
      case 'object': {
        if (!isPlainObject(value)) {
          sink.push(`${path(p)}: 需要 object`);
          break;
        }
        for (const key of Array.isArray(node.required) ? node.required : []) {
          if (!(key in value)) sink.push(`${path(p)}.${key}: 缺少必需参数`);
        }
        if (isPlainObject(node.properties)) {
          for (const [key, child] of Object.entries(node.properties)) {
            if (key in value) walkInto(child, value[key], p === '' ? key : `${p}.${key}`, sink);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // 参数根永远是对象
  if (!isPlainObject(args)) {
    violations.push('(root): 参数必须是对象');
    return violations;
  }
  for (const key of Array.isArray(schema?.required) ? schema.required : []) {
    if (!(key in args)) violations.push(`${key}: 缺少必需参数`);
  }
  for (const [key, child] of Object.entries(isPlainObject(schema?.properties) ? schema.properties : {})) {
    if (key in args) walk(child, args[key], key);
  }
  return violations;
}

/** 非法模型参数。与 `dsh-tools` 的 `ToolArgsError` 同名同码。 */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.code = 'INVALID_ARGS';
    this.violations = violations;
  }
}

/**
 * 构造一个可注册的工具定义。
 *
 * 与 `@deepseek-ai/dsh-tools` 的 `defineTool` 保持相同的调用形状，
 * 并额外允许 `parameters` 直接是**原始 JSON Schema**（带 `properties` 键时自动识别）。
 *
 * @param options 工具定义
 * @returns 传给 `ctx.tools.register()` 的定义对象
 */
export function defineTool(options) {
  const userExecute = options.execute;
  const userRender = options.output.render;
  const userPresentationMeta = options.output.presentationMeta;
  const userFinalizeContent = options.finalizeContent;
  const userProjectContent = options.projectContent;
  const userPresentCall = options.presentCall;
  const userPresentResult = options.presentResult;
  const userIsConcurrencySafe = options.isConcurrencySafe;

  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }

  // 已经是原始 JSON Schema 就直接用，否则按作者侧 DSL 编译
  const parameters = isPlainObject(options.parameters) && 'properties' in options.parameters
    ? { ...options.parameters }
    : parameterSchemaSpecToJsonSchema(options.parameters);
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value);
      },
      ...(userPresentationMeta !== undefined
        ? { presentationMeta(args, value) { return userPresentationMeta(args, value); } }
        : {}),
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args ?? {});
      if (violations.length > 0) throw new ToolArgsError(violations);
      return userExecute(args, exec);
    },
  };

  if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
  if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
  if (userPresentCall) {
    tool.presentCall = (args) => (validateArgs(parameters, args ?? {}).length > 0 ? undefined : userPresentCall(args));
  }
  if (userPresentResult) {
    tool.presentResult = (args, result) =>
      (validateArgs(parameters, args ?? {}).length > 0 ? undefined : userPresentResult(args, result));
  }
  if (userIsConcurrencySafe) {
    tool.isConcurrencySafe = (args) =>
      (validateArgs(parameters, args ?? {}).length > 0 ? false : userIsConcurrencySafe(args));
  }
  if (options.deferLoading === true) tool.deferLoading = true;
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;

  return tool;
}
