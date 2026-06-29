// PoW challenge solver for DeepSeek API
const POW_WASM_URL = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

let wasmExportsPromise;
let cachedBytes;
let cachedView;
let writtenLength = 0;

const encoder = new TextEncoder();
const encodeInto =
  typeof encoder.encodeInto === "function"
    ? (value, view) => encoder.encodeInto(value, view)
    : (value, view) => {
        const bytes = encoder.encode(value);
        view.set(bytes);
        return { read: value.length, written: bytes.length };
      };

function getBytes() {
  if (!cachedBytes || cachedBytes.buffer !== wasm.memory.buffer) {
    cachedBytes = new Uint8Array(wasm.memory.buffer);
  }
  return cachedBytes;
}

function getView() {
  if (!cachedView || cachedView.buffer !== wasm.memory.buffer) {
    cachedView = new DataView(wasm.memory.buffer);
  }
  return cachedView;
}

function passString(value, malloc, realloc) {
  let length = value.length;
  let pointer = malloc(length, 1) >>> 0;
  let offset = 0;
  let bytes = getBytes();

  while (offset < length) {
    const code = value.charCodeAt(offset);
    if (code > 0x7f) break;
    bytes[pointer + offset] = code;
    offset += 1;
  }

  if (offset !== length) {
    if (offset !== 0) value = value.slice(offset);
    const nextLength = offset + value.length * 3;
    pointer = realloc(pointer, length, nextLength, 1) >>> 0;
    bytes = getBytes();
    const target = bytes.subarray(pointer + offset, pointer + offset + value.length * 3);
    const result = encodeInto(value, target);
    offset += result.written;
    length = offset;
    pointer = realloc(pointer, nextLength, length, 1) >>> 0;
  }

  writtenLength = offset;
  return pointer;
}

async function loadWasm() {
  if (wasmExportsPromise) return wasmExportsPromise;
  wasmExportsPromise = fetch(POW_WASM_URL)
    .then((response) => response.arrayBuffer())
    .then((bytes) => WebAssembly.instantiate(bytes, { wbg: {} }))
    .then(({ instance }) => instance.exports);
  return wasmExportsPromise;
}

let wasm;

export async function solvePowChallenge(challenge) {
  wasm = await loadWasm();
  const prefix = `${challenge.salt}_${challenge.expire_at ?? challenge.expireAt}_`;
  const stackPointer = wasm.__wbindgen_add_to_stack_pointer(-16);

  try {
    const challengePointer = passString(challenge.challenge, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const challengeLength = writtenLength;
    const prefixPointer = passString(prefix, wasm.__wbindgen_export_0, wasm.__wbindgen_export_1);
    const prefixLength = writtenLength;

    wasm.wasm_solve(stackPointer, challengePointer, challengeLength, prefixPointer, prefixLength, challenge.difficulty);

    const resultCode = getView().getInt32(stackPointer, true);
    const answer = getView().getFloat64(stackPointer + 8, true);

    if (resultCode === 0 || !Number.isFinite(answer)) {
      throw new Error("PoW 挑战求解失败");
    }

    return {
      algorithm: challenge.algorithm,
      answer,
      challenge: challenge.challenge,
      salt: challenge.salt,
      signature: challenge.signature
    };
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}
