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

// ── Step2: ターゲット瓶を処理してリファレンス背景に合成 ──
async function processImage(
  item: ImageItem,
  refBg: RefBackground | null
): Promise<string> {
  const { removeBackground } = await import("@imgly/background-removal");

  const blob = await removeBackground(item.file);

  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(blob);
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
    // 参照瓶と同じ高さにスケール（step-by-step.htmlと同じ方式）
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
    // リファレンス背景を使用
    const bgImg = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = refBg.url;
    });
    ctx.drawImage(bgImg, 0, 0, OUTPUT_W, OUTPUT_H);
  } else {
    // フォールバック: canvas描画背景
    drawFallbackBackground(ctx, seamY);
  }

  // 接地影
  const shadowRX = scaledW * 0.28;
  const shadowRY = scaledH * 0.022;
  if (refBg) {
    // 参照背景色ベースの影（step-by-step.html Step2方式）
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
    // 投射影（右方向）
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

  // ガラス暗化（ラベル下端をピクセル色で検出）
  const offPixels = offCtx.getImageData(0, 0, OUTPUT_W, OUTPUT_H);
  const pd = offPixels.data;
  const scanCX = Math.round(destX + scaledW * 0.5);
  const scanHalf = Math.round(scaledW * 0.25);
  let labelBottomY = Math.round(destY);
  for (let y = Math.round(destY); y < Math.round(seamY); y++) {
    let whiteCount = 0, opaqueCount = 0;
    for (let x = scanCX - scanHalf; x <= scanCX + scanHalf; x++) {
      const i = (y * OUTPUT_W + x) * 4;
      const a = pd[i + 3];
      if (a > 50) {
        opaqueCount++;
        if (pd[i] > 200 && pd[i + 1] > 200 && pd[i + 2] > 200) whiteCount++;
      }
    }
    if (opaqueCount > 0 && whiteCount / opaqueCount > 0.35) labelBottomY = y;
  }
  const labelDetected = labelBottomY > Math.round(destY) + Math.round(scaledH * 0.05);
  const glassTop = labelBottomY + 8;
  const glassH = seamY - glassTop + 20;
  if (glassH > 0 && labelDetected) {
    const glassLayer = document.createElement("canvas");
    glassLayer.width = OUTPUT_W;
    glassLayer.height = OUTPUT_H;
    const glCtx = glassLayer.getContext("2d")!;
    const darkGrad = glCtx.createLinearGradient(0, glassTop, 0, glassTop + glassH);
    darkGrad.addColorStop(0,    "rgba(30,15,5,0)");
    darkGrad.addColorStop(0.25, "rgba(30,15,5,0.30)");
    darkGrad.addColorStop(0.55, "rgba(30,15,5,0.45)");
    darkGrad.addColorStop(1.0,  "rgba(30,15,5,0.55)");
    glCtx.fillStyle = darkGrad;
    glCtx.fillRect(0, Math.floor(glassTop), OUTPUT_W, Math.ceil(glassH));
    glCtx.globalCompositeOperation = "destination-in";
    glCtx.drawImage(offscreen, 0, 0);
    ctx.drawImage(glassLayer, 0, 0);
  }

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
        const resultUrl = await processImage(item, refBg);
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
        <p className="text-xs text-gray-600 mt-1">出力: {OUTPUT_W}×{OUTPUT_H}px 固定　v1.25.0</p>
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
