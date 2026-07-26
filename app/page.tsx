"use client";

import { useState, useCallback, useRef } from "react";

// ── 出力設定 ──────────────────────────────────────────
const OUTPUT_W = 800;
const OUTPUT_H = 1000;
const BOTTLE_MAX_H_RATIO = 0.68;
const BOTTLE_MAX_W_RATIO = 0.46;

// ── 型 ────────────────────────────────────────────────
type ImageItem = {
  id: string;
  file: File;
  previewUrl: string;
  status: "waiting" | "processing" | "done" | "error";
  resultUrl?: string;
  errorMessage?: string;
};

// ── 透明ピクセルを除いたバウンディングボックスを取得 ──
function getBoundingBox(imageData: ImageData) {
  const { data, width, height } = imageData;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a > 15) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

// ── スタジオ背景
// seamY: 瓶底Y座標。壁→床の遷移をその少し上（約50px）に配置。
function drawStudioBackground(ctx: CanvasRenderingContext2D, seamY: number) {
  const w = OUTPUT_W, h = OUTPUT_H;
  const floorY = seamY - 55; // 瓶底より少し上を境界とする

  // 1. ベース壁面（全体を少し明るく）
  ctx.fillStyle = "#a8aaac";
  ctx.fillRect(0, 0, w, h);

  // 2. ソフトボックス（左上から瓶の背後を明るく照らす）
  const softbox = ctx.createRadialGradient(
    w * 0.38, h * 0.10, 0,
    w * 0.38, h * 0.10, w * 1.0
  );
  softbox.addColorStop(0,    "rgba(255,255,255,0.62)");
  softbox.addColorStop(0.18, "rgba(255,255,255,0.34)");
  softbox.addColorStop(0.45, "rgba(255,255,255,0.10)");
  softbox.addColorStop(0.70, "rgba(255,255,255,0.02)");
  softbox.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.fillStyle = softbox;
  ctx.fillRect(0, 0, w, h);

  // 3. 壁/床の境界をより明確に（境界付近に暗めのアクセント）
  const boundary = ctx.createLinearGradient(0, floorY - 25, 0, floorY + 55);
  boundary.addColorStop(0,    "rgba(0,0,0,0)");
  boundary.addColorStop(0.48, "rgba(0,0,0,0.09)");
  boundary.addColorStop(0.72, "rgba(0,0,0,0.04)");
  boundary.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = boundary;
  ctx.fillRect(0, floorY - 25, w, 80);

  // 4. 床面暗化（より急な勾配で壁との差を強調）
  const floor = ctx.createLinearGradient(0, floorY, 0, h);
  floor.addColorStop(0,    "rgba(0,0,0,0.05)");
  floor.addColorStop(0.18, "rgba(0,0,0,0.15)");
  floor.addColorStop(0.48, "rgba(0,0,0,0.24)");
  floor.addColorStop(1,    "rgba(0,0,0,0.32)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, floorY, w, h - floorY);

  // 5. 奥行き感（手前の床が暗くなる遠近法）
  const depth = ctx.createLinearGradient(0, h * 0.78, 0, h);
  depth.addColorStop(0, "rgba(0,0,0,0)");
  depth.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = depth;
  ctx.fillRect(0, h * 0.78, w, h - h * 0.78);

  // 6. 左右端シェーディング
  const sideL = ctx.createLinearGradient(0, 0, w * 0.22, 0);
  sideL.addColorStop(0, "rgba(0,0,0,0.10)");
  sideL.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sideL;
  ctx.fillRect(0, 0, w, h);

  const sideR = ctx.createLinearGradient(w, 0, w * 0.78, 0);
  sideR.addColorStop(0, "rgba(0,0,0,0.08)");
  sideR.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sideR;
  ctx.fillRect(0, 0, w, h);
}

// ── 画像1枚を処理 ────────────────────────────────────
async function processImage(item: ImageItem): Promise<string> {
  const { removeBackground } = await import("@imgly/background-removal");

  // 背景除去（publicPath はライブラリのデフォルト = staticimgly.com を使用）
  const blob = await removeBackground(item.file);

  // 透明PNG → HTMLImageElement
  const transparentUrl = URL.createObjectURL(blob);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = transparentUrl;
  });

  // バウンディングボックス検出
  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width  = img.naturalWidth;
  tmpCanvas.height = img.naturalHeight;
  const tmpCtx = tmpCanvas.getContext("2d")!;
  tmpCtx.drawImage(img, 0, 0);
  const { minX, minY, maxX, maxY } = getBoundingBox(
    tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height)
  );

  URL.revokeObjectURL(transparentUrl);

  const bw = maxX - minX;
  const bh = maxY - minY;

  // 統一スケール計算（瓶が常に同じ大きさに）
  const maxW = OUTPUT_W * BOTTLE_MAX_W_RATIO;
  const maxH = OUTPUT_H * BOTTLE_MAX_H_RATIO;
  const scale  = Math.min(maxW / bw, maxH / bh);
  const scaledW = bw * scale;
  const scaledH = bh * scale;

  // 水平中央・垂直中央
  const destX   = (OUTPUT_W - scaledW) / 2;
  const destY   = (OUTPUT_H - scaledH) / 2;
  const seamY   = destY + scaledH;  // 瓶底 = 床面ライン
  const centerX = OUTPUT_W / 2;
  const bottleRight = destX + scaledW; // = centerX + scaledW/2

  // 最終キャンバス
  const canvas = document.createElement("canvas");
  canvas.width  = OUTPUT_W;
  canvas.height = OUTPUT_H;
  const ctx = canvas.getContext("2d")!;

  // 背景（壁・床・境目：seamY基準）
  drawStudioBackground(ctx, seamY);

  // ── キャストシャドウ ──────────────────────────────────
  // クリップ一切なし。影の中心を seamY に置き、瓶を後から描く。
  // ・瓶の不透明部分 → 上から覆って隠される（影は見えない）
  // ・瓶底の半透明エッジ → 影と自然にブレンド → これが「接地感」の正体
  // ・床面（seamY 以下） → 影がそのまま表示 → 右に伸びるキャストシャドウ
  // y クリップすると瓶底と影の間に隙間が生まれ「浮き」の原因になる
  // 楕円の「頂点」を seamY に合わせ、中心を seamY + shadowVR にする。
  // これにより:
  //   seamY より上: 影がほぼ出ない（ブラーの極少量にじみのみ → 瓶底と自然融合）
  //   seamY より下: 縦半径分の高さを持つ影 → 切れない・奥行きがある
  // ── 接地影（Contact Shadow）─────────────────────────
  // 瓶底中央・小さく濃い。瓶が床に「乗っている」感の核心。
  // クリップなし → blur が seamY の上にもにじみ、瓶底エッジと自然融合する
  ctx.save();
  ctx.filter = "blur(9px)";
  ctx.beginPath();
  ctx.ellipse(centerX, seamY, scaledW * 0.22, 10, 0, 0, Math.PI * 2);
  const contactGrad = ctx.createRadialGradient(
    centerX, seamY, 0,
    centerX, seamY, scaledW * 0.22
  );
  contactGrad.addColorStop(0,   "rgba(0,0,0,0.70)");
  contactGrad.addColorStop(0.5, "rgba(0,0,0,0.40)");
  contactGrad.addColorStop(1,   "rgba(0,0,0,0)");
  ctx.fillStyle = contactGrad;
  ctx.fill();
  ctx.restore();

  // ── キャストシャドウ（Cast Shadow）──────────────────
  // 瓶右端から右方向へ伸びる影。床面（y > seamY）のみにクリップ。
  // 高さのある楕円（縦半径 0.22*scaledW）で床面に奥行きを表現。
  const castVR   = scaledW * 0.22;
  const castHR   = scaledW * 1.20;
  const peakFrac = scaledW / (OUTPUT_W - destX); // bottleRight の位置を fraction で表す

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, seamY, OUTPUT_W, OUTPUT_H - seamY);
  ctx.clip();
  ctx.filter = "blur(14px)";
  ctx.beginPath();
  ctx.ellipse(
    bottleRight + scaledW * 0.08, // 中心X: 瓶右端より少し外
    seamY + castVR * 0.85,        // 中心Y: 楕円上端が seamY 付近に来る
    castHR,
    castVR,
    0, 0, Math.PI * 2
  );
  // グラデーション: 瓶左端(透明) → bottleRight(最暗) → 右端(透明)
  // peakFrac を使って bottleRight に峰を合わせる
  const castGrad = ctx.createLinearGradient(destX, 0, OUTPUT_W, 0);
  castGrad.addColorStop(0,                                    "rgba(0,0,0,0)");
  castGrad.addColorStop(Math.max(peakFrac - 0.08, 0.02),      "rgba(0,0,0,0.42)");
  castGrad.addColorStop(Math.min(peakFrac,         0.92),      "rgba(0,0,0,0.58)");
  castGrad.addColorStop(Math.min(peakFrac + 0.14,  0.95),      "rgba(0,0,0,0.34)");
  castGrad.addColorStop(Math.min(peakFrac + 0.30,  0.97),      "rgba(0,0,0,0.14)");
  castGrad.addColorStop(Math.min(peakFrac + 0.48,  0.99),      "rgba(0,0,0,0.04)");
  castGrad.addColorStop(1.0,                                   "rgba(0,0,0,0)");
  ctx.fillStyle = castGrad;
  ctx.fill();
  ctx.restore();

  // 瓶本体：2種の影の後に描くことで瓶ボディ部分の影は自然に隠れる
  ctx.drawImage(img, minX, minY, bw, bh, destX, destY, scaledW, scaledH);

  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(URL.createObjectURL(b!)), "image/png");
  });
}

// ── コンポーネント ────────────────────────────────────
export default function Home() {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        const resultUrl = await processImage(item);
        setImages((prev) =>
          prev.map((i) =>
            i.id === item.id ? { ...i, status: "done", resultUrl } : i
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("processImage error:", msg);
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

  const waitingCount    = images.filter((i) => i.status === "waiting").length;
  const doneCount       = images.filter((i) => i.status === "done").length;

  return (
    <main className="max-w-5xl mx-auto px-4 py-10">
      {/* ヘッダー */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-widest mb-2">SakeLens</h1>
        <p className="text-gray-400 text-sm">
          日本酒ボトルをスタジオ撮影風に自動変換
        </p>
        <p className="text-xs text-gray-600 mt-1">
          出力: {OUTPUT_W}×{OUTPUT_H}px 固定 / 瓶サイズ・位置を自動統一
        </p>
      </div>

      {/* ドロップゾーン */}
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

      {/* アクションボタン */}
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

      {/* 画像グリッド */}
      {images.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {images.map((item) => (
            <div key={item.id} className="rounded-xl overflow-hidden bg-gray-900 border border-gray-800 relative group">
              {/* 削除ボタン */}
              <button
                onClick={() => setImages((p) => p.filter((i) => i.id !== item.id))}
                className="absolute top-2 right-2 z-10 bg-black/70 hover:bg-red-700 rounded-full w-6 h-6 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
              >✕</button>

              {/* プレビュー */}
              <div className="aspect-[2/3] relative bg-black">
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-500
                    ${item.status === "done" ? "opacity-0" : "opacity-100"}`}
                />
                {item.resultUrl && (
                  <img
                    src={item.resultUrl}
                    alt="変換後"
                    className="absolute inset-0 w-full h-full object-contain"
                  />
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

              {/* 下部情報 */}
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
