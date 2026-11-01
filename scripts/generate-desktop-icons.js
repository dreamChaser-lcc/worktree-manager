/**
 * 桌面端图标生成脚本（零依赖，node scripts/generate-desktop-icons.js）：
 * 手写 PNG（IHDR + IDAT + IEND，zlib deflate），生成蓝色圆角方块：
 * - desktop-electron/assets/tray.png   32x32 托盘图标
 * - desktop-electron/build/icon.png   256x256 应用图标（electron-builder 自动缩放各尺寸）
 * 产物已提交仓库，仅在需要改配色/尺寸时重新运行。
 */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function crc32(buffer) {
  if (!crc32.lookupTable) {
    crc32.lookupTable = [];
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crc32.lookupTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32.lookupTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildChunk(type, data) {
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function createRoundedSquarePng(size, filePath) {
  const brandColor = [9, 105, 218]; // #0969da 与前端主题一致
  const cornerRadius = Math.max(3, Math.round(size * 0.18));
  const bytesPerRow = size * 4 + 1; // 每行前置 1 字节 filter type（0 = none）
  const rawBuffer = Buffer.alloc(size * bytesPerRow);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * bytesPerRow;
    rawBuffer[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      let alpha = 255;
      const inCornerRegion = (x < cornerRadius || x >= size - cornerRadius) && (y < cornerRadius || y >= size - cornerRadius);
      if (inCornerRegion) {
        const cornerCenterX = x < cornerRadius ? cornerRadius : size - 1 - x;
        const cornerCenterY = y < cornerRadius ? cornerRadius : size - 1 - y;
        if (Math.hypot(cornerRadius - cornerCenterX, cornerRadius - cornerCenterY) > cornerRadius) {
          alpha = 0; // 圆角外透明
        }
      }
      const pixelOffset = rowStart + 1 + x * 4;
      rawBuffer[pixelOffset] = brandColor[0];
      rawBuffer[pixelOffset + 1] = brandColor[1];
      rawBuffer[pixelOffset + 2] = brandColor[2];
      rawBuffer[pixelOffset + 3] = alpha;
    }
  }

  const ihdrBuffer = Buffer.alloc(13);
  ihdrBuffer.writeUInt32BE(size, 0);
  ihdrBuffer.writeUInt32BE(size, 4);
  ihdrBuffer[8] = 8; // bit depth
  ihdrBuffer[9] = 6; // color type RGBA
  const pngBuffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    buildChunk('IHDR', ihdrBuffer),
    buildChunk('IDAT', zlib.deflateSync(rawBuffer)),
    buildChunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`[icons] 已生成 ${filePath} (${size}x${size})`);
}

const desktopDirectory = path.join(__dirname, '..', 'desktop-electron');
const assetsDirectory = path.join(desktopDirectory, 'assets');
const buildDirectory = path.join(desktopDirectory, 'build');
fs.mkdirSync(assetsDirectory, { recursive: true });
fs.mkdirSync(buildDirectory, { recursive: true });

createRoundedSquarePng(32, path.join(assetsDirectory, 'tray.png'));
createRoundedSquarePng(256, path.join(buildDirectory, 'icon.png'));
