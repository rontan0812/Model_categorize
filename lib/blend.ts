import { decompress as zstdDecompress } from "fzstd";

/**
 * Blender (.blend) ファイルから、保存時に埋め込まれたサムネイル画像を取り出す。
 *
 * .blend は Blender 内部データをそのまま書き出した形式で、ブラウザで 3D として
 * 再現する方法が無い。そのかわり、ファイル選択画面用のサムネイル（"TEST" ブロック）を
 * 読んで表示する。
 */

export type BlendThumbnail = { width: number; height: number; pixels: Uint8ClampedArray };

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 圧縮して保存された .blend（3.0 以降は zstd、それ以前は gzip）を展開する */
async function decompress(data: Uint8Array): Promise<Uint8Array> {
  if (data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) return zstdDecompress(data);
  if (data[0] === 0x1f && data[1] === 0x8b) return gunzip(data);
  return data;
}

const ascii = (data: Uint8Array, start: number, len: number) => String.fromCharCode(...data.subarray(start, start + len));

/** サムネイルが見つからなければ null。.blend でなければ例外。 */
export async function readBlendThumbnail(file: Blob): Promise<BlendThumbnail | null> {
  const data = await decompress(new Uint8Array(await file.arrayBuffer()));
  if (ascii(data, 0, 7) !== "BLENDER") throw new Error("Blender のファイルとして読み込めませんでした");

  // ヘッダーは2種類ある
  //  旧形式: "BLENDER" + ポインタ幅('_'=4 / '-'=8) + エンディアン('v'=little / 'V'=big) + "402"  … 12 バイト
  //  新形式(Blender 5.0〜): "BLENDER" + ヘッダー長"17" + '-' + 形式"01" + エンディアン + "0500" … 17 バイト
  let pos: number;
  let pointerSize: number;
  let little: boolean;
  let large = false;
  const c7 = ascii(data, 7, 1);
  if (c7 === "_" || c7 === "-") {
    pointerSize = c7 === "_" ? 4 : 8;
    little = ascii(data, 8, 1) === "v";
    pos = 12;
  } else {
    const headerLen = Number(ascii(data, 7, 2));
    if (!Number.isFinite(headerLen) || headerLen < 17) throw new Error("対応していない Blender ファイルの形式です");
    pointerSize = 8;
    little = ascii(data, 12, 1) === "v";
    large = true;
    pos = headerLen;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const int32 = (p: number) => view.getInt32(p, little);
  const int64 = (p: number) => Number(view.getBigInt64(p, little));

  // ブロックを順に読んで "TEST"（サムネイル）を探す
  while (pos + 16 <= data.length) {
    const code = ascii(data, pos, 4);
    let len: number;
    let headSize: number;
    if (large) {
      // code(4) SDNAnr(4) old(8) len(8) nr(8)
      len = int64(pos + 16);
      headSize = 32;
    } else {
      // code(4) len(4) old(ポインタ幅) SDNAnr(4) nr(4)
      len = int32(pos + 4);
      headSize = 16 + pointerSize;
    }
    const body = pos + headSize;
    if (code === "ENDB" || len < 0 || body + len > data.length) break;
    if (code === "TEST") {
      const width = int32(body);
      const height = int32(body + 4);
      if (width <= 0 || height <= 0 || 8 + width * height * 4 > len) return null;
      // 行が下から上の順に並んでいるので、上下を入れ替える
      const src = data.subarray(body + 8, body + 8 + width * height * 4);
      const pixels = new Uint8ClampedArray(width * height * 4);
      const row = width * 4;
      for (let y = 0; y < height; y++) pixels.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
      return { width, height, pixels };
    }
    // サムネイルは先頭近くにあるので、ジオメトリなど本体のブロックまで来たら打ち切る
    if (code === "GLOB" || code === "DNA1") break;
    pos = body + len;
  }
  return null;
}

/** 画面表示用に PNG の data URL にする */
export function thumbnailToDataUrl(t: BlendThumbnail): string {
  const canvas = document.createElement("canvas");
  canvas.width = t.width;
  canvas.height = t.height;
  canvas.getContext("2d")!.putImageData(new ImageData(t.pixels as Uint8ClampedArray<ArrayBuffer>, t.width, t.height), 0, 0);
  return canvas.toDataURL("image/png");
}
