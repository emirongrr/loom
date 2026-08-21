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

function scalarExample(parameter, caller) {
  const type = parameter.type;
  const name = String(parameter.name ?? "").toLowerCase();
  const array = /^(.*)\[(\d*)\]$/u.exec(type);
  if (array) {
    const length = array[2] ? Number(array[2]) : 1;
    if (!Number.isSafeInteger(length) || length > 256) throw new Error(`No example value is available for ${type}`);
    return Array.from({ length }, () => scalarExample({ ...parameter, type: array[1] }, caller));
  }
  if (type.startsWith("(") && type.endsWith(")")) {
    return splitTupleTypes(type.slice(1, -1)).map((componentType, index) => scalarExample({ name: `item${index}`, type: componentType }, caller));
  }
  if (type === "address") return caller || ZERO_ADDRESS;
  if (type === "bool") return true;
  if (type === "string") return "Loom example";
  if (type === "function") return `0x${"0".repeat(48)}`;
  if (type === "bytes") return "0x00";
  const fixedBytes = /^bytes(\d+)$/u.exec(type);
  if (fixedBytes) {
    const width = Number(fixedBytes[1]);
    if (width < 1 || width > 32) throw new Error(`No example value is available for ${type}`);
    return `0x${"0".repeat(width * 2 - 1)}1`;
  }
  if (/^u?int(?:\d+)?$/u.test(type)) return /(?:index|nonce|offset|version)/u.test(name) ? "0" : "1";
  throw new Error(`No example value is available for ${type}`);
}

export function defaultExecutionArgument(parameter, { caller } = {}) {
  const value = scalarExample(parameter, caller);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
