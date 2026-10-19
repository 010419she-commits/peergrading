const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ICO supports complete PNG payloads, including their alpha channel.
function encodeIco(images) {
  if (!Array.isArray(images) || images.length === 0 || images.length > 65535) {
    throw new Error("ICO requires between 1 and 65535 images");
  }
  const seen = new Set();
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  for (const [index, { size, png }] of images.entries()) {
    if (!Number.isInteger(size) || size < 1 || size > 256 || seen.has(size)) {
      throw new Error("ICO sizes must be unique integers from 1 to 256");
    }
    seen.add(size);
    if (!Buffer.isBuffer(png) || png.length < 33 ||
        !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
        png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR" ||
        png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size ||
        png[24] !== 8 || png[25] !== 6) {
      throw new Error("ICO entries must be matching square 8-bit RGBA PNGs");
    }
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

module.exports = { ICON_SIZES, encodeIco };
