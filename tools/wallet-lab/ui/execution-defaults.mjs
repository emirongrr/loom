const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function splitTupleTypes(value) {
  const types = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (value[index] === "," && depth === 0) {
      types.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (value || start) types.push(value.slice(start));
  return types.filter(Boolean);
}

function addressExample(name, context) {
  const roles = [
    [/entrypoint/u, "entryPoint"],
    [/(?:new)?validator/u, "validator"],
    [/recovery/u, "recovery"],
    [/factory/u, "factory"],
    [/hook/u, "hook"],
    [/verifier/u, "verifier"],
    [/(?:target|recipient|destination|counterparty|token)/u, "target"],
    [/(?:account|wallet|sender)/u, "account"]
  ];
  const role = roles.find(([pattern]) => pattern.test(name))?.[1];
  const value = role ? context.addresses?.[role] : null;
  return value
    ? { value, source: `${role} address from the selected deployment` }
    : { value: context.caller || ZERO_ADDRESS, source: "current simulation caller" };
}

function integerExample(name, context) {
  if (/chain.?id/u.test(name) && context.chainId) return { value: String(context.chainId), source: "selected network chain ID" };
  if (/(?:expires|deadline|validuntil|validto)/u.test(name)) return { value: String((context.nowSeconds ?? 1_800_000_000) + 7 * 24 * 60 * 60), source: "seven days after the studio reference time" };
  if (/(?:validafter|starttime|notbefore)/u.test(name)) return { value: String(context.nowSeconds ?? 1_800_000_000), source: "studio reference time" };
  if (/(?:delay|window|duration|period)/u.test(name)) return { value: "259200", source: "three-day example window in seconds" };
  if (/threshold/u.test(name)) return { value: "2", source: "two-guardian example threshold" };
  if (/newvalue/u.test(name)) return { value: "42", source: "recognizable non-zero state-change example" };
  if (/(?:amount|spend|limit|stake|valuewei)/u.test(name)) return { value: "1000000000000000", source: "0.001 native-unit example expressed in wei" };
  if (/(?:gas|verificationgas|callgas)/u.test(name)) return { value: "100000", source: "representative local gas allowance" };
  if (/(?:index|nonce|offset|version)/u.test(name)) return { value: "0", source: "initial sequence value" };
  return { value: "1", source: "small non-zero ABI example" };
}

function scalarExample(parameter, context) {
  const type = parameter.type;
  const name = String(parameter.name ?? "").toLowerCase();
  const array = /^(.*)\[(\d*)\]$/u.exec(type);
  if (array) {
    const length = array[2] ? Number(array[2]) : 1;
    if (!Number.isSafeInteger(length) || length > 256) throw new Error(`No example value is available for ${type}`);
    const child = { ...parameter, type: array[1] };
    const values = Array.from({ length }, () => scalarExample(child, context).value);
    return { value: values, source: `${array[2] ? `fixed ${length}-item` : "one-item"} ABI array example` };
  }
  if (type.startsWith("(") && type.endsWith(")")) {
    const componentTypes = splitTupleTypes(type.slice(1, -1));
    const components = parameter.components?.length === componentTypes.length
      ? parameter.components.map((component, index) => ({ ...component, type: componentTypes[index] }))
      : componentTypes.map((componentType, index) => ({ name: `item${index}`, type: componentType }));
    return { value: components.map(component => scalarExample(component, context).value), source: "ABI tuple populated with role-aware examples" };
  }
  if (type === "address") return addressExample(name, context);
  if (type === "bool") return { value: true, source: "enabled example state" };
  if (type === "string") return { value: "Loom example", source: "readable example text" };
  if (type === "function") return { value: `0x${"0".repeat(48)}`, source: "zeroed 24-byte external function pointer" };
  if (type === "bytes") return { value: "0x00", source: "minimal non-empty byte payload; not an authorization proof" };
  const fixedBytes = /^bytes(\d+)$/u.exec(type);
  if (fixedBytes) {
    const width = Number(fixedBytes[1]);
    if (width < 1 || width > 32) throw new Error(`No example value is available for ${type}`);
    if (width === 4 && /selector/u.test(name) && context.targetSelector) return { value: context.targetSelector, source: "call selector from the local scenario target" };
    return { value: `0x${"0".repeat(width * 2 - 1)}1`, source: `deterministic non-zero ${type} example` };
  }
  if (/^u?int(?:\d+)?$/u.test(type)) return integerExample(name, context);
  throw new Error(`No example value is available for ${type}`);
}

export function executionArgumentExample(parameter, context = {}) {
  const example = scalarExample(parameter, context);
  return {
    value: Array.isArray(example.value) ? JSON.stringify(example.value) : String(example.value),
    source: example.source
  };
}

export function defaultExecutionArgument(parameter, context = {}) {
  return executionArgumentExample(parameter, context).value;
}
