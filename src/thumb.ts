/** 居中裁方缩略图：在 Obsidian 的 Electron 渲染进程里用 canvas 生成。
 *
 * 纯 Node（单元测试）环境没有 DOM，直接返回 null；调用方据此退回原图引用，
 * 于是老测试与「裁图能力不可用」的设备都不会崩，只是没有方图效果。
 */

function guessMime(data: Buffer): string {
  if (
    data.length > 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (
    data.length > 6 &&
    data.slice(0, 6).toString("ascii").toUpperCase() === "GIF89A"
  )
    return "image/gif";
  if (
    data.length > 12 &&
    data.slice(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return "image/jpeg";
}

export async function makeSquareThumb(
  data: Buffer,
  px: number
): Promise<Buffer | null> {
  const g = globalThis as any;
  if (
    typeof g.document === "undefined" ||
    typeof g.document.createElement !== "function" ||
    typeof g.createImageBitmap !== "function"
  )
    return null;

  try {
    const blob = new Blob([new Uint8Array(data)], { type: guessMime(data) });
    const bmp: ImageBitmap = await g.createImageBitmap(blob);
    try {
      const side = Math.min(bmp.width, bmp.height);
      if (side <= 0) return null;
      // 源图比目标小就不放大，避免小图被撑大发虚
      const out = Math.min(px, side);
      const canvas: HTMLCanvasElement = g.document.createElement("canvas");
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(
        bmp,
        (bmp.width - side) / 2,
        (bmp.height - side) / 2,
        side,
        side,
        0,
        0,
        out,
        out
      );
      const outBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.82)
      );
      if (!outBlob) return null;
      return Buffer.from(await outBlob.arrayBuffer());
    } finally {
      if (typeof bmp.close === "function") bmp.close();
    }
  } catch {
    return null;
  }
}
