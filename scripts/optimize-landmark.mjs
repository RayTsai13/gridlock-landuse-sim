// Rebuild the runtime GLB from the untouched source; retain geometry/materials.
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const source = new URL('../public/seattle/SPACE NEEDLE.glb', import.meta.url);
const target = new URL('../public/seattle/space-needle.optimized.glb', import.meta.url);
const input = await readFile(source);
if (input.readUInt32LE(0) !== 0x46546c67 || input.readUInt32LE(4) !== 2) {
  throw new Error('Expected a glTF 2.0 binary');
}
const jsonLength = input.readUInt32LE(12);
const document = JSON.parse(input.subarray(20, 20 + jsonLength).toString());
const binOffset = 28 + jsonLength;
const image = document.images?.[0];
const view = document.bufferViews?.[image?.bufferView];
if (document.images.length !== 1 || image.mimeType !== 'image/png' ||
    image.bufferView !== document.bufferViews.length - 1 || view.buffer !== 0) {
  throw new Error('Source layout changed; inspect before rebuilding');
}
const texture = input.subarray(binOffset + view.byteOffset, binOffset + view.byteOffset + view.byteLength);
const resized = await sharp(texture).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 85, alphaQuality: 100 }).toBuffer();
image.mimeType = 'image/webp';
document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), 'EXT_texture_webp'])];
document.extensionsRequired = [...new Set([...(document.extensionsRequired ?? []), 'EXT_texture_webp'])];
for (const texture of document.textures ?? []) {
  if (texture.source === 0) {
    texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: 0 } };
    delete texture.source;
  }
}
view.byteLength = resized.length;
document.buffers[0].byteLength = view.byteOffset + resized.length;
const json = Buffer.from(JSON.stringify(document));
const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
json.copy(paddedJson);
const bin = Buffer.alloc(Math.ceil(document.buffers[0].byteLength / 4) * 4);
input.copy(bin, 0, binOffset, binOffset + view.byteOffset);
resized.copy(bin, view.byteOffset);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + paddedJson.length + bin.length, 8);
header.writeUInt32LE(paddedJson.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
const output = Buffer.concat([header, paddedJson, binHeader, bin]);
await writeFile(target, output);
console.log(`Landmark: ${input.length} → ${output.length} bytes (2048px WebP, unchanged geometry)`);
