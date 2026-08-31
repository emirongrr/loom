import { encodeDeployData } from "viem";

export function materializeInitCode(artifact, constructorArgs, label = "artifact") {
  const object = artifact?.bytecode?.object;
  if (typeof object !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(object)) {
    throw new Error(`${label} missing creation bytecode`);
  }
  if (!Array.isArray(constructorArgs)) throw new Error(`${label}.constructorArgs must be an array`);
  try {
    return encodeDeployData({ abi: artifact.abi ?? [], bytecode: object, args: constructorArgs });
  } catch (error) {
    throw new Error(`${label}.constructorArgs do not encode against the artifact ABI: ${error.message}`);
  }
}

export function materializeImmutableRuntime(artifact, immutableValues, label = "artifact") {
  const object = artifact?.deployedBytecode?.object;
  if (typeof object !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(object)) {
    throw new Error(`${label} missing deployed bytecode`);
  }
  const references = artifact.deployedBytecode?.immutableReferences ?? {};
  const ids = Object.keys(references);
  if (ids.length === 0) {
    if (immutableValues !== undefined && Object.keys(immutableValues).length > 0) {
      throw new Error(`${label}.immutableValues supplied for bytecode with no immutable references`);
    }
    return object;
  }
  if (!immutableValues || typeof immutableValues !== "object" || Array.isArray(immutableValues)) {
    throw new Error(`${label}.immutableValues is required for immutable runtime bytecode`);
  }
  const supplied = Object.keys(immutableValues);
  for (const id of ids) {
    const value = immutableValues[id];
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
      throw new Error(`${label}.immutableValues[${id}] must be one 32-byte runtime word`);
    }
  }
  for (const id of supplied) if (!references[id]) throw new Error(`${label}.immutableValues contains unknown immutable id ${id}`);

  const runtime = Buffer.from(object.slice(2), "hex");
  const occupied = new Set();
  for (const [id, slots] of Object.entries(references)) {
    const word = Buffer.from(immutableValues[id].slice(2), "hex");
    if (!Array.isArray(slots) || slots.length === 0) {
      throw new Error(`${label} has no immutable reference slots for id ${id}`);
    }
    for (const slot of slots) {
      if (!Number.isSafeInteger(slot.start) || !Number.isSafeInteger(slot.length) || slot.length <= 0 || slot.length > 32) {
        throw new Error(`${label} has an invalid immutable reference for id ${id}`);
      }
      if (slot.start < 0 || slot.start + slot.length > runtime.length) {
        throw new Error(`${label} immutable reference for id ${id} is outside runtime bytecode`);
      }
      for (let offset = slot.start; offset < slot.start + slot.length; offset += 1) {
        if (occupied.has(offset)) throw new Error(`${label} has overlapping immutable references`);
        occupied.add(offset);
      }
      word.copy(runtime, slot.start, 32 - slot.length);
    }
  }
  return `0x${runtime.toString("hex")}`;
}
