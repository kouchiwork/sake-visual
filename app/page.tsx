"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// ── 出力設定 ──────────────────────────────────────────
const OUTPUT_W = 800;
const OUTPUT_H = 1000;
const BOTTLE_MAX_H_RATIO = 0.80;
const BOTTLE_MAX_W_RATIO = 0.52;

// ── 型 ────────────────────────────────────────────────
type ImageItem = {
  id: string;
  file: File;
  previewUrl: string;
  status: "waiting" | "processing" | "done" | "error";
  resultUrl?: string;
  errorMessage?: string;
};

type RefBackground = {
  url: string;
  seamY: number;
  refBottleH: number;
  bgColor: [number, number, number];
};

// ── バウンディングボックス取得 ──────────────────────
function getBoundingBox(imageData: ImageData) {
  const { data, width, height } = imageData;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let visualMaxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a > 15) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (a > 128 && y > visualMaxY) visualMaxY = y;
    }
  }
  return { minX, minY, maxX, maxY, visualMaxY };
}

// ── Step1: リファレンス画像から瓶を消してスタジオ背景を抽出 ──
async function extractReferenceBackground(file: File): Promise<RefBackground> {
  const { removeBackground } = await import("@imgly/background-removal");

  // 元画像をOUTPUTサイズにスケール
  const origBitmap = await createImageBitmap(file);
  const origCanvas = document.createElement("canvas");
  origCanvas.width = OUTPUT_W;
  origCanvas.height = OUTPUT_H;
  const origCtx = origCanvas.getContext("2d")!;

  // coverスケール（800x1000を完全に埋める、はみ出した部分はクロップ）
  const scale = Math.max(OUTPUT_W / origBitmap.width, OUTPUT_H / origBitmap.height);
  const sw = origBitmap.width * scale;
  const sh = origBitmap.height * scale;
  const sx = (OUTPUT_W - sw) / 2;
  const sy = (OUTPUT_H - sh) / 2;

  // 背景色をサンプル（画像の左上隅付近）
  origCtx.drawImage(origBitmap, sx, sy, sw, sh);
  const sampleX = Math.round(Math.max(0, sx) + 4);
  const sampleY = Math.round(Math.max(0, sy) + 4);
  const edgePx = origCtx.getImageData(sampleX, sampleY, 1, 1).data;
  const bgR = edgePx[0], bgG = edgePx[1], bgB = edgePx[2];
  origCtx.clearRect(0, 0, OUTPUT_W, OUTPUT_H);
  origCtx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
  origCtx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
  origCtx.drawImage(origBitmap, sx, sy, sw, sh);

  // スケール済み画像をFileに変換して背景除去
  const scaledBlob = await new Promise<Blob>(r =>
    origCanvas.toBlob(b => r(b!), "image/jpeg", 0.95)
  );
  const scaledFile = new File([scaledBlob], "ref.jpg", { type: "image/jpeg" });
  const bottleBlob = await removeBackground(scaledFile);

  // 瓶マスク画像を作成
  const bottleImg = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(bottleBlob);
  });

  // 瓶のseamYと高さを検出
  const tmpC = document.createElement("canvas");
  tmpC.width = OUTPUT_W; tmpC.height = OUTPUT_H;
  const tmpCtx = tmpC.getContext("2d")!;
  tmpCtx.drawImage(bottleImg, 0, 0, OUTPUT_W, OUTPUT_H);
  const maskData = tmpCtx.getImageData(0, 0, OUTPUT_W, OUTPUT_H);
  const bb = getBoundingBox(maskData);
  const refSeamY = bb.maxY;
  const refBottleH = bb.maxY - bb.minY;

  // 瓶マスクのある画素を横方向インターポレーションでinpaint
  const origData = origCtx.getImageData(0, 0, OUTPUT_W, OUTPUT_H);
  const result = new Uint8ClampedArray(origData.data);
  for (let y = 0; y < OUTPUT_H; y++) {
    let bottleStart = -1, bottleEnd = -1;
    for (let x = 0; x < OUTPUT_W; x++) {
      if (maskData.data[(y * OUTPUT_W + x) * 4 + 3] > 5) {
        if (bottleStart < 0) bottleStart = x;
        bottleEnd = x;
      }
    }
    if (bottleStart < 0) continue;
    const leftX = Math.max(0, bottleStart - 1);
    const rightX = Math.min(OUTPUT_W - 1, bottleEnd + 1);
    const li = (y * OUTPUT_W + leftX) * 4;
    const ri = (y * OUTPUT_W + rightX) * 4;
    const lR = origData.data[li], lG = origData.data[li + 1], lB = origData.data[li + 2];
    const rR = origData.data[ri], rG = origData.data[ri + 1], rB = origData.data[ri + 2];
    const span = bottleEnd - bottleStart + 1;
    for (let x = bottleStart; x <= bottleEnd; x++) {
      const t = span > 1 ? (x - bottleStart) / (span - 1) : 0.5;
      const idx = (y * OUTPUT_W + x) * 4;
      result[idx]     = Math.round(lR + (rR - lR) * t);
      result[idx + 1] = Math.round(lG + (rG - lG) * t);
      result[idx + 2] = Math.round(lB + (rB - lB) * t);
      result[idx + 3] = 255;
    }
  }

  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = OUTPUT_W; bgCanvas.height = OUTPUT_H;
  const bgCtx = bgCanvas.getContext("2d")!;
  bgCtx.putImageData(new ImageData(result, OUTPUT_W, OUTPUT_H), 0, 0);

  const url = await new Promise<string>(r =>
    bgCanvas.toBlob(b => r(URL.createObjectURL(b!)), "image/png")
  );

  return { url, seamY: refSeamY, refBottleH, bgColor: [bgR, bgG, bgB] };
}

// ── 白背景をAI用に置換（Sobelエッジ検出で瓶輪郭をバリアにする）──
async function preprocessForAI(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const w = bitmap.width, h = bitmap.height;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // コーナー4点で背景色を推定
  const ci = [0, (w-1)*4, (h-1)*w*4, ((h-1)*w+w-1)*4];
  const bgR = ci.reduce((s,i) => s + d[i],   0) / 4;
  const bgG = ci.reduce((s,i) => s + d[i+1], 0) / 4;
  const bgB = ci.reduce((s,i) => s + d[i+2], 0) / 4;
  const avgBg = (bgR + bgG + bgB) / 3;
  if (avgBg < 200) return file; // 暗い背景はスキップ

  if (avgBg < 240) {
    // グレー系背景（200〜240）: 彩度ベースのブライトニング
    // 低彩度かつ背景色に近い画素を白に近づける → flood-fill漏れなし
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const dist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      if (sat < 25 && dist < 75) {
        const t = 0.8;
        d[i]   = Math.round(r + (255 - r) * t);
        d[i+1] = Math.round(g + (255 - g) * t);
        d[i+2] = Math.round(b + (255 - b) * t);
      }
    }
    ctx.putImageData(imgData, 0, 0);
    const blob = await new Promise<Blob>(res => c.toBlob(b => res(b!), "image/png"));
    return new File([blob], file.name, { type: "image/png" });
  }

  // 純白背景（>= 240）: Sobel + フラッドフィル（既存処理）
  // Sobel勾配を計算（瓶の輪郭 = 高勾配 = フラッドフィルのバリア）
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2];
  }
  const grad = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = (
        -gray[(y-1)*w+(x-1)] + gray[(y-1)*w+(x+1)] +
        -2*gray[y*w+(x-1)]   + 2*gray[y*w+(x+1)] +
        -gray[(y+1)*w+(x-1)] + gray[(y+1)*w+(x+1)]
      );
      const gy = (
        -gray[(y-1)*w+(x-1)] - 2*gray[(y-1)*w+x] - gray[(y-1)*w+(x+1)] +
         gray[(y+1)*w+(x-1)] + 2*gray[(y+1)*w+x] + gray[(y+1)*w+(x+1)]
      );
      grad[y * w + x] = Math.sqrt(gx*gx + gy*gy);
    }
  }

  // 動的置換色選択（瓶の色と被らない色を選ぶ）
  const CANDIDATES: [number, number, number][] = [
    [255, 0, 255], [0, 255, 255], [255, 128, 0],
    [0, 180, 80],  [0, 0, 255],  [255, 0, 0],
  ];
  const STEP = 4;
  let bestColor = CANDIDATES[0], bestMinDist = -1;
  for (const [cr, cg, cb] of CANDIDATES) {
    let minDist = Infinity;
    for (let y = Math.floor(h*0.25); y < Math.floor(h*0.75); y += STEP) {
      for (let x = Math.floor(w*0.25); x < Math.floor(w*0.75); x += STEP) {
        const i = (y * w + x) * 4;
        const dr = d[i]-cr, dg = d[i+1]-cg, db = d[i+2]-cb;
        const dist = dr*dr + dg*dg + db*db;
        if (dist < minDist) minDist = dist;
      }
    }
    if (minDist > bestMinDist) { bestMinDist = minDist; bestColor = [cr, cg, cb]; }
  }
  const [REPL_R, REPL_G, REPL_B] = bestColor;

  // エッジ考慮フラッドフィル
  // 広がる条件: 背景色に近い かつ 輪郭（Sobel勾配）をまたがない
  const COLOR_TOL = 35;
  const EDGE_THRESH = 25;
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qHead = 0, qTail = 0;
  const enq = (x: number, y: number) => {
    const idx = y * w + x;
    if (visited[idx]) return;
    visited[idx] = 1;
    queue[qTail++] = idx;
  };
  enq(0, 0); enq(w-1, 0); enq(0, h-1); enq(w-1, h-1);
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % w, y = (idx / w) | 0;
    const pi = idx * 4;
    d[pi] = REPL_R; d[pi+1] = REPL_G; d[pi+2] = REPL_B;
    for (const [nx, ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]] as [number,number][]) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      const ni = nIdx * 4;
      // 条件1: 背景色に近い
      if (Math.abs(d[ni]-bgR)+Math.abs(d[ni+1]-bgG)+Math.abs(d[ni+2]-bgB) >= COLOR_TOL*3) continue;
      // 条件2: 輪郭をまたがない
      if (Math.max(grad[idx], grad[nIdx]) > EDGE_THRESH) continue;
      enq(nx, ny);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), "image/png"));
  return new File([blob], file.name, { type: "image/png" });
}

// ── Step2: ターゲット瓶を処理してリファレンス背景に合成 ──
async function processImage(
  item: ImageItem,
  refBg: RefBackground | null,
  opts: { dark: boolean; blue: boolean; grad: boolean } = { dark: true, blue: true, grad: true }
): Promise<string> {
  const { removeBackground } = await import("@imgly/background-removal");

  // AIのアルファマスクを取得してオリジナルRGBと合成
  // → AIが色を変えてしまう問題を回避し、元写真の色をそのまま使う
  const aiInputFile = await preprocessForAI(item.file);
  const extractedBlob = await removeBackground(aiInputFile);
  const extractedBitmap = await createImageBitmap(extractedBlob);
  const mW = extractedBitmap.width, mH = extractedBitmap.height;

  const maskC = document.createElement("canvas");
  maskC.width = mW; maskC.height = mH;
  const maskCtx = maskC.getContext("2d")!;
  maskCtx.drawImage(extractedBitmap, 0, 0);
  const maskPx = maskCtx.getImageData(0, 0, mW, mH).data;

  // ===== 10x スケール マスクエロージョン（白縁除去） =====
  // 10倍に拡大してエロージョンし、バイリニア縮小でアンチエイリアスをかける
  // キャンバスサイズ上限(4096)を超えないようスケールを動的に決定
  const ERODE_SCALE = Math.max(1, Math.min(10, Math.floor(4096 / Math.max(mW, mH))));
  const ERODE_ITERS = Math.max(1, Math.round(1.5 * ERODE_SCALE)); // 有効エロージョン ≈ 1.5px

  const mW10 = mW * ERODE_SCALE;
  const mH10 = mH * ERODE_SCALE;

  const maskC10 = document.createElement("canvas");
  maskC10.width = mW10;
  maskC10.height = mH10;
  const ctx10 = maskC10.getContext("2d")!;
  ctx10.imageSmoothingEnabled = false;
  ctx10.drawImage(maskC, 0, 0, mW10, mH10);
  const rawMask10 = ctx10.getImageData(0, 0, mW10, mH10).data;

  let alpha10 = new Uint8Array(mW10 * mH10);
  for (let i = 3; i < rawMask10.length; i += 4) {
    alpha10[i >> 2] = rawMask10[i] > 127 ? 1 : 0;
  }

  for (let iter = 0; iter < ERODE_ITERS; iter++) {
    const next = new Uint8Array(mW10 * mH10);
    for (let y = 1; y < mH10 - 1; y++) {
      for (let x = 1; x < mW10 - 1; x++) {
        const idx = y * mW10 + x;
        if (alpha10[idx] &&
            alpha10[idx - 1] && alpha10[idx + 1] &&
            alpha10[idx - mW10] && alpha10[idx + mW10]) {
          next[idx] = 1;
        }
      }
    }
    alpha10 = next;
  }

  const eroded10Data = ctx10.createImageData(mW10, mH10);
  for (let i = 0; i < mW10 * mH10; i++) {
    eroded10Data.data[i * 4 + 3] = alpha10[i] ? 255 : 0;
  }
  ctx10.putImageData(eroded10Data, 0, 0);

  const erodedC = document.createElement("canvas");
  erodedC.width = mW;
  erodedC.height = mH;
  const erodedCtx = erodedC.getContext("2d")!;
  erodedCtx.imageSmoothingEnabled = true;
  erodedCtx.imageSmoothingQuality = "high";
  erodedCtx.drawImage(maskC10, 0, 0, mW, mH);
  const erodedPx = erodedCtx.getImageData(0, 0, mW, mH).data;
  // =====================================================

  const origBitmap = await createImageBitmap(item.file);
  const origC = document.createElement("canvas");
  origC.width = mW; origC.height = mH;
  const origCtx2 = origC.getContext("2d")!;
  origCtx2.drawImage(origBitmap, 0, 0, mW, mH);
  const origPx = origCtx2.getImageData(0, 0, mW, mH).data;

  const combined = new ImageData(mW, mH);
  const cd = combined.data;
  for (let i = 0; i < origPx.length; i += 4) {
    const a = erodedPx[i + 3];
    if (a === 0) { cd[i + 3] = 0; continue; }
    const t = a / 255;
    cd[i]     = Math.round(Math.max(0, Math.min(255, (origPx[i]     - 255 * (1 - t)) / t)));
    cd[i + 1] = Math.round(Math.max(0, Math.min(255, (origPx[i + 1] - 255 * (1 - t)) / t)));
    cd[i + 2] = Math.round(Math.max(0, Math.min(255, (origPx[i + 2] - 255 * (1 - t)) / t)));
    cd[i + 3] = a;
  }
  origCtx2.putImageData(combined, 0, 0);

  const img = await new Promise<HTMLImageElement>((res, rej) => {
    origC.toBlob(b => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = URL.createObjectURL(b!);
    }, "image/png");
  });

  // バウンディングボックス検出
  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = img.naturalWidth;
  tmpCanvas.height = img.naturalHeight;
  const tmpCtx = tmpCanvas.getContext("2d")!;
  tmpCtx.drawImage(img, 0, 0);
  const { minX, minY, maxX, maxY } = getBoundingBox(
    tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height)
  );

  const bw = maxX - minX;
  const bh = maxY - minY;

  // 瓶のスケール・配置を計算
  // リファレンスがある場合: 参照瓶のseamYに合わせて瓶底を配置
  // リファレンスがない場合: 従来通り中央配置
  let destX: number, destY: number, scaledW: number, scaledH: number, seamY: number;

  if (refBg) {
    const targetSeamY = refBg.seamY;
    const maxH = Math.min(refBg.refBottleH, OUTPUT_H * BOTTLE_MAX_H_RATIO);
    const maxW = OUTPUT_W * BOTTLE_MAX_W_RATIO;
    const scale = Math.min(maxW / bw, maxH / bh);
    scaledW = bw * scale;
    scaledH = bh * scale;
    destX = (OUTPUT_W - scaledW) / 2;
    destY = targetSeamY - scaledH;
    seamY = targetSeamY;
  } else {
    const maxW = OUTPUT_W * BOTTLE_MAX_W_RATIO;
    const maxH = OUTPUT_H * BOTTLE_MAX_H_RATIO;
    const scale = Math.min(maxW / bw, maxH / bh);
    scaledW = bw * scale;
    scaledH = bh * scale;
    destX = (OUTPUT_W - scaledW) / 2;
    destY = (OUTPUT_H - scaledH) / 2;
    seamY = destY + scaledH;
  }

  const centerX = OUTPUT_W / 2;

  // 最終キャンバス
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_W;
  canvas.height = OUTPUT_H;
  const ctx = canvas.getContext("2d")!;

  // 背景を描く
  if (refBg) {
    const bgImg = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = refBg.url;
    });
    ctx.drawImage(bgImg, 0, 0, OUTPUT_W, OUTPUT_H);
    // グラデーション
    if (opts.grad) {
      const grad = ctx.createLinearGradient(0, 0, 0, OUTPUT_H);
      grad.addColorStop(0, "rgba(0,0,0,0.08)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
    }
    // ランダム濃淡（0〜10%）
    if (opts.dark) {
      const darkness = Math.random() * 0.10;
      ctx.fillStyle = `rgba(0,0,0,${darkness})`;
      ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
    }
    // ランダム青み（0〜5%）
    if (opts.blue) {
      const blue = Math.random() * 0.05;
      ctx.fillStyle = `rgba(60,120,255,${blue})`;
      ctx.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
    }
  } else {
    drawFallbackBackground(ctx, seamY);
  }

  // 接地影
  const shadowRX = scaledW * 0.28;
  const shadowRY = scaledH * 0.022;
  if (refBg) {
    const [bgR, bgG, bgB] = refBg.bgColor;
    const shadowGrad = ctx.createRadialGradient(centerX, seamY, 0, centerX, seamY, shadowRX);
    shadowGrad.addColorStop(0, `rgba(${bgR * 0.3 | 0},${bgG * 0.3 | 0},${bgB * 0.3 | 0},0.55)`);
    shadowGrad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.scale(1, shadowRY / shadowRX);
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.arc(centerX, seamY * (shadowRX / shadowRY), shadowRX, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    ctx.save();
    ctx.filter = "blur(8px)";
    ctx.beginPath();
    ctx.ellipse(centerX, seamY + 1, scaledW * 0.46, 8, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fill();
    ctx.restore();
    const shX1 = destX + scaledW * 0.3;
    const shX2 = OUTPUT_W * 0.95;
    const shCX = (shX1 + shX2) / 2;
    const shRx = (shX2 - shX1) / 2;
    ctx.save();
    ctx.filter = "blur(14px)";
    ctx.beginPath();
    ctx.ellipse(shCX, seamY + 2, shRx, 18, 0, 0, Math.PI * 2);
    const castGrad = ctx.createLinearGradient(shX1, 0, shX2, 0);
    castGrad.addColorStop(0,    "rgba(0,0,0,0.95)");
    castGrad.addColorStop(0.20, "rgba(0,0,0,0.75)");
    castGrad.addColorStop(0.45, "rgba(0,0,0,0.50)");
    castGrad.addColorStop(0.70, "rgba(0,0,0,0.25)");
    castGrad.addColorStop(1.0,  "rgba(0,0,0,0)");
    ctx.fillStyle = castGrad;
    ctx.fill();
    ctx.restore();
  }

  // 瓶をオフスクリーンに描く
  const offscreen = document.createElement("canvas");
  offscreen.width = OUTPUT_W;
  offscreen.height = OUTPUT_H;
  const offCtx = offscreen.getContext("2d")!;
  offCtx.drawImage(img, minX, minY, bw, bh, destX, destY, scaledW, scaledH);

  ctx.drawImage(offscreen, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(URL.createObjectURL(b!)), "image/png");
  });
}

// ── フォールバック背景（リファレンスなし時） ──────────
function drawFallbackBackground(ctx: CanvasRenderingContext2D, seamY: number) {
  const w = OUTPUT_W, h = OUTPUT_H;
  const floorY = seamY - 55;
  ctx.fillStyle = "#a8aaac";
  ctx.fillRect(0, 0, w, h);
  const softbox = ctx.createRadialGradient(w * 0.38, h * 0.10, 0, w * 0.38, h * 0.10, w * 1.0);
  softbox.addColorStop(0,    "rgba(255,255,255,0.62)");
  softbox.addColorStop(0.18, "rgba(255,255,255,0.34)");
  softbox.addColorStop(0.45, "rgba(255,255,255,0.10)");
  softbox.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.fillStyle = softbox;
  ctx.fillRect(0, 0, w, h);
  const floor = ctx.createLinearGradient(0, floorY, 0, h);
  floor.addColorStop(0,    "rgba(0,0,0,0.05)");
  floor.addColorStop(0.48, "rgba(0,0,0,0.24)");
  floor.addColorStop(1,    "rgba(0,0,0,0.32)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, floorY, w, h - floorY);
}

// ── コンポーネント ────────────────────────────────────
export default function Home() {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [refBg, setRefBg] = useState<RefBackground | null>(null);
  const [darkRandom, setDarkRandom] = useState(false);
  const [blueRandom, setBlueRandom] = useState(true);
  const [gradEnabled, setGradEnabled] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const CACHE_KEY = "sakelens_default_bg_v1";
      try {
        // キャッシュがあれば即ロード（AI不要）
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { bgDataUrl, seamY, refBottleH, bgColor } = JSON.parse(cached);
          const res = await fetch(bgDataUrl);
          const blob = await res.blob();
          setRefBg({ url: URL.createObjectURL(blob), seamY, refBottleH, bgColor });
          return;
        }
      } catch {}

      // 初回のみAI抽出を実行してキャッシュに保存
      try {
        const res = await fetch("/gion-hanabi.jpg");
        const blob = await res.blob();
        const file = new File([blob], "gion-hanabi.jpg", { type: "image/jpeg" });
        const result = await extractReferenceBackground(file);
        setRefBg(result);

        // 結果をlocalStorageにキャッシュ
        const bgRes = await fetch(result.url);
        const bgBlob = await bgRes.blob();
        const bgDataUrl = await new Promise<string>(r => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result as string);
          fr.readAsDataURL(bgBlob);
        });
        const prevRes = await fetch("/gion-hanabi.jpg");
        const prevBlob = await prevRes.blob();
        try {
          localStorage.setItem("sakelens_default_bg_v1", JSON.stringify({
            bgDataUrl,
            seamY: result.seamY,
            refBottleH: result.refBottleH,
            bgColor: result.bgColor,
          }));
        } catch {}
      } catch (e) {
        console.error("default bg load failed:", e);
      }
    })();
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const newItems: ImageItem[] = files
      .filter((f) => f.type.startsWith("image/"))
      .map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: "waiting",
      }));
    setImages((prev) => [...prev, ...newItems]);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const processAll = async () => {
    setIsProcessing(true);
    const waiting = images.filter((i) => i.status === "waiting");
    for (const item of waiting) {
      setImages((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: "processing" } : i))
      );
      try {
        const resultUrl = await processImage(item, refBg, { dark: darkRandom, blue: blueRandom, grad: gradEnabled });
        setImages((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, status: "done", resultUrl } : i
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setImages((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, status: "error", errorMessage: msg } : i
          )
        );
      }
    }
    setIsProcessing(false);
  };

  const downloadAll = () => {
    images.forEach((item) => {
      if (item.resultUrl) {
        const a = document.createElement("a");
        a.href = item.resultUrl;
        a.download = `sake_${item.file.name.replace(/\.[^.]+$/, "")}.png`;
        a.click();
      }
    });
  };

  const waitingCount = images.filter((i) => i.status === "waiting").length;
  const doneCount = images.filter((i) => i.status === "done").length;

  return (
    <main className="max-w-5xl mx-auto px-4 py-10" data-bg-ready={refBg ? "true" : "false"}>
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-widest mb-2">SakeLens</h1>
        <p className="text-gray-400 text-sm">日本酒ボトルをスタジオ撮影風に自動変換</p>
        <p className="text-xs text-gray-600 mt-1">出力: {OUTPUT_W}×{OUTPUT_H}px 固定　v1.42.0</p>
      </div>

      {/* ターゲット画像ドロップゾーン */}
      <div
        className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-colors mb-6
          ${isDragging ? "border-amber-500 bg-amber-950/20" : "border-gray-700 hover:border-gray-500"}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="text-4xl mb-3">🍶</div>
        <p className="text-gray-300">日本酒の画像をドラッグ＆ドロップ</p>
        <p className="text-xs text-gray-500 mt-1">複数枚まとめてOK</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && addFiles(Array.from(e.target.files))}
        />
      </div>

      <div className="flex gap-5 mb-4 text-sm text-gray-400 select-none">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={darkRandom}
            onChange={(e) => setDarkRandom(e.target.checked)}
            className="w-4 h-4 accent-amber-500"
          />
          濃淡ランダム
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={blueRandom}
            onChange={(e) => setBlueRandom(e.target.checked)}
            className="w-4 h-4 accent-blue-500"
          />
          青系ランダム
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={gradEnabled}
            onChange={(e) => setGradEnabled(e.target.checked)}
            className="w-4 h-4 accent-gray-400"
          />
          グラデ
        </label>
      </div>

      {images.length > 0 && (
        <div className="flex gap-3 mb-6 flex-wrap items-center">
          {waitingCount > 0 && (
            <button
              onClick={processAll}
              disabled={isProcessing}
              className="px-6 py-2.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 rounded-lg font-semibold transition tracking-wide"
            >
              {isProcessing ? "⏳ 処理中..." : `▶ 変換開始（${waitingCount}枚）`}
            </button>
          )}
          {doneCount > 0 && (
            <button
              onClick={downloadAll}
              className="px-6 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg font-semibold transition"
            >
              ⬇ 全ダウンロード（{doneCount}枚）
            </button>
          )}
          <button
            onClick={() => setImages([])}
            className="px-4 py-2.5 text-gray-500 hover:text-gray-300 rounded-lg transition ml-auto text-sm"
          >
            クリア
          </button>
        </div>
      )}

      {images.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {images.map((item) => (
            <div key={item.id} className="rounded-xl overflow-hidden bg-gray-900 border border-gray-800 relative group">
              <button
                onClick={() => setImages((p) => p.filter((i) => i.id !== item.id))}
                className="absolute top-2 right-2 z-10 bg-black/70 hover:bg-red-700 rounded-full w-6 h-6 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
              >✕</button>
              <div className="aspect-[4/5] relative bg-black">
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-500
                    ${item.status === "done" ? "opacity-0" : "opacity-100"}`}
                />
                {item.resultUrl && (
                  <img src={item.resultUrl} alt="変換後" className="absolute inset-0 w-full h-full object-contain" />
                )}
                {item.status === "processing" && (
                  <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
                    <div className="w-7 h-7 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-amber-300">変換中</span>
                  </div>
                )}
                {item.status === "error" && (
                  <div className="absolute inset-0 bg-red-900/70 flex items-center justify-center p-2">
                    <span className="text-xs text-red-200 text-center break-all line-clamp-4">
                      {item.errorMessage ?? "エラー"}
                    </span>
                  </div>
                )}
              </div>
              <div className="px-2 py-2 flex items-center justify-between">
                <span className={`text-xs px-2 py-0.5 rounded-full
                  ${item.status === "waiting"    ? "bg-gray-700 text-gray-300" : ""}
                  ${item.status === "processing" ? "bg-amber-800 text-amber-200" : ""}
                  ${item.status === "done"       ? "bg-green-900 text-green-300" : ""}
                  ${item.status === "error"      ? "bg-red-900 text-red-300" : ""}
                `}>
                  {item.status === "waiting"    && "待機"}
                  {item.status === "processing" && "変換中"}
                  {item.status === "done"       && "完了"}
                  {item.status === "error"      && "エラー"}
                </span>
                {item.resultUrl && (
                  <a
                    href={item.resultUrl}
                    download={`sake_${item.file.name.replace(/\.[^.]+$/, "")}.png`}
                    className="text-xs text-amber-500 hover:text-amber-300 transition"
                  >DL</a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {images.length === 0 && (
        <p className="text-center text-gray-700 mt-12 text-sm">画像を追加してください</p>
      )}
    </main>
  );
}
