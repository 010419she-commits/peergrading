import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";

const { ICON_SIZES, encodeIco } = createRequire(import.meta.url)("../desktop/icon-assets.cjs");

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length);
  result.write(type, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

function rgbaPng(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  // Include transparent and opaque pixels so byte equality also covers alpha.
  scanlines[4] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("ICO directory exposes every native size and preserves each RGBA PNG payload", () => {
  const entries = ICON_SIZES.map((size: number) => ({ size, png: rgbaPng(size) }));
  const ico = encodeIco(entries);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  let expectedOffset = 6 + entries.length * 16;
  for (const [index, { size, png }] of entries.entries()) {
    const position = 6 + index * 16;
    assert.equal(ico[position] || 256, size);
    assert.equal(ico[position + 1] || 256, size);
    assert.equal(ico[position + 2], 0);
    assert.equal(ico[position + 3], 0);
    assert.equal(ico.readUInt16LE(position + 4), 1);
    assert.equal(ico.readUInt16LE(position + 6), 32);
    assert.equal(ico.readUInt32LE(position + 8), png.length);
    assert.equal(ico.readUInt32LE(position + 12), expectedOffset);
    assert.deepEqual(ico.subarray(expectedOffset, expectedOffset + png.length), png);
    expectedOffset += png.length;
  }
  assert.equal(ico.length, expectedOffset);
});

test("ICO rejects duplicate, invalid, mismatched, and alpha-free entries", () => {
  const png = rgbaPng(32);
  assert.throws(() => encodeIco([]), /requires/);
  assert.throws(() => encodeIco([{ size: 257, png }]), /sizes/);
  assert.throws(() => encodeIco([{ size: 32, png }, { size: 32, png }]), /unique/);
  assert.throws(() => encodeIco([{ size: 16, png }]), /matching/);
  assert.throws(() => encodeIco([{ size: 32, png: Buffer.from("not a PNG") }]), /RGBA/);
  const rgb = Buffer.from(png);
  rgb[25] = 2;
  assert.throws(() => encodeIco([{ size: 32, png: rgb }]), /RGBA/);
});
