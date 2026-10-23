"use strict";
// Minimal Litematica writer (.litematic = gzipped NBT, format version 6).
const zlib = require("zlib");

const T = { BYTE: 1, INT: 3, LONG: 4, STRING: 8, LIST: 9, COMPOUND: 10, LONGARRAY: 12 };

class W {
  constructor() { this.parts = []; }
  b(n) { const x = Buffer.alloc(1); x.writeUInt8(n); this.parts.push(x); }
  s(n) { const x = Buffer.alloc(2); x.writeUInt16BE(n); this.parts.push(x); }
  i(n) { const x = Buffer.alloc(4); x.writeInt32BE(n); this.parts.push(x); }
  l(n) { const x = Buffer.alloc(8); x.writeBigInt64BE(BigInt.asIntN(64, BigInt(n))); this.parts.push(x); }
  str(v) { const x = Buffer.from(v, "utf8"); this.s(x.length); this.parts.push(x); }
  buf() { return Buffer.concat(this.parts); }
}

// Nodes are {t, v}. Compound = {t:COMPOUND, v:{key: node}}; List = {t:LIST, of, v:[...]}
const int = v => ({ t: T.INT, v });
const long = v => ({ t: T.LONG, v });
const string = v => ({ t: T.STRING, v });
const comp = v => ({ t: T.COMPOUND, v });
const list = (of, v) => ({ t: T.LIST, of, v });
const longArray = v => ({ t: T.LONGARRAY, v });

function payload(w, node) {
  switch (node.t) {
    case T.INT: w.i(node.v); break;
    case T.LONG: w.l(node.v); break;
    case T.STRING: w.str(node.v); break;
    case T.COMPOUND:
      for (const [k, c] of Object.entries(node.v)) { w.b(c.t); w.str(k); payload(w, c); }
      w.b(0);
      break;
    case T.LIST:
      w.b(node.v.length ? node.of : 0); w.i(node.v.length);
      node.v.forEach(c => payload(w, c));
      break;
    case T.LONGARRAY:
      w.i(node.v.length); node.v.forEach(x => w.l(x));
      break;
    default: throw new Error("unsupported tag " + node.t);
  }
}

function packStates(indices, paletteSize) {
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize)));
  const arr = new Array(Math.ceil(indices.length * bits / 64)).fill(0n);
  indices.forEach((val, i) => {
    const start = i * bits, a = Math.floor(start / 64), off = start % 64;
    const v = BigInt(val);
    arr[a] = BigInt.asUintN(64, arr[a] | (v << BigInt(off)));
    const e = Math.floor((start + bits - 1) / 64);
    if (e !== a) arr[e] = BigInt.asUintN(64, arr[e] | (v >> BigInt(64 - off)));
  });
  return arr;
}

// grid[row][col] = palette index (row 0 is the top). Flat wall, 1 block deep on the z axis.
function buildLitematic({ name, grid, blocks, author = "stone-faces" }) {
  const sx = grid[0].length, sy = grid.length, sz = 1;
  const used = [...new Set(grid.flat())];
  const map = new Map(used.map((g, i) => [g, i + 1])); // 0 = air
  const pal = [comp({ Name: string("minecraft:air") }),
    ...used.map(g => comp({ Name: string(blocks[g]) }))];

  const idx = [];
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) idx.push(map.get(grid[sy - 1 - y][x]));

  const xyz = (x, y, z) => comp({ x: int(x), y: int(y), z: int(z) });
  const now = Date.now();
  const root = comp({
    MinecraftDataVersion: int(3955), // 1.21.1
    Version: int(6),
    SubVersion: int(1),
    Metadata: comp({
      Name: string(name), Author: string(author), Description: string("Stone face of " + name),
      EnclosingSize: xyz(sx, sy, sz), RegionCount: int(1),
      TimeCreated: long(now), TimeModified: long(now),
      TotalBlocks: int(sx * sy * sz), TotalVolume: int(sx * sy * sz),
    }),
    Regions: comp({
      [name]: comp({
        Position: xyz(0, 0, 0), Size: xyz(sx, sy, sz),
        BlockStatePalette: list(T.COMPOUND, pal),
        BlockStates: longArray(packStates(idx, pal.length)),
        TileEntities: list(T.COMPOUND, []), Entities: list(T.COMPOUND, []),
        PendingBlockTicks: list(T.COMPOUND, []), PendingFluidTicks: list(T.COMPOUND, []),
      }),
    }),
  });

  const w = new W();
  w.b(T.COMPOUND); w.str(""); payload(w, root);
  return zlib.gzipSync(w.buf());
}

module.exports = { buildLitematic };
