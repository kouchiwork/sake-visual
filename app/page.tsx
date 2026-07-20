"use client";

import { useState, useCallback, useRef } from "react";

// ── 出力設定 ──────────────────────────────────────────
const OUTPUT_W = 800;
const OUTPUT_H = 1000;
const BOTTLE_MAX_H_RATIO = 0.80; // 参考画像に合わせた高さ比率
const BOTTLE_MAX_W_RATIO = 0.48; // 参考画像に合わせた幅比率
const BOTTLE_BOTTOM_Y    = 0.84; // 瓶の底を置くY位置（比率）

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
// seamY = 瓶の底位置。壁→床の色変化をここを基準に配置する。
// 実際のスイープ紙は「ライン」ではなくグラデーションで変化する。
function drawStudioBackground(ctx: CanvasRenderingContext2D, seamY: number) {
  const w = OUTPUT_W, h = OUTPUT_H;

  // 1. ベース（参考画像の壁面グレー）
  ctx.fillStyle = "#bfc2c7";
  ctx.fillRect(0, 0, w, h);

  // 2. ソフトボックス（左上から大きく広がる拡散光）
  //    中心を左上寄りにすることで自然なライティング感
  const softbox = ctx.createRadialGradient(
    w * 0.40, h * 0.12, 0,
    w * 0.40, h * 0.12, w * 1.15
  );
  softbox.addColorStop(0,    "rgba(255,255,255,0.55)");
  softbox.addColorStop(0.22, "rgba(255,255,255,0.28)");
  softbox.addColorStop(0.50, "rgba(255,255,255,0.08)");
  softbox.addColorStop(0.80, "rgba(255,255,255,0.01)");
  softbox.addColorStop(1,    "rgba(255,255,255,0)");
  ctx.fillStyle = softbox;
  ctx.fillRect(0, 0, w, h);

  // 3. 床面の暗化（スイープ紙カーブ）
  //    seamY の少し上から始まり、下に向かって徐々に暗くなる。
  //    これだけで「壁と床の別れ目」が自然に見える。
  const transStart = seamY - h * 0.18;
  const floor = ctx.createLinearGradient(0, transStart, 0, h);
  floor.addColorStop(0,    "rgba(0,0,0,0)");
  floor.addColorStop(0.20, "rgba(0,0,0,0.07)");
  floor.addColorStop(0.50, "rgba(0,0,0,0.15)");
  floor.addColorStop(1,    "rgba(0,0,0,0.22)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, transStart, w, h - transStart);

  // 4. 左右端の軽いシェーディング（スタジオの壁が画面端で暗くなる）
  const sideL = ctx.createLinearGradient(0, 0, w * 0.25, 0);
  sideL.addColorStop(0, "rgba(0,0,0,0.10)");
  sideL.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sideL;
  ctx.fillRect(0, 0, w, h);

  const sideR = ctx.createLinearGradient(w, 0, w * 0.75, 0);
  sideR.addColorStop(0, "rgba(0,0,0,0.07)");
  sideR.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sideR;
  ctx.fillRect(0, 0, w, h);
}

// ── 影（楕円変形で自然なキャストシャドウ）
// 台形パスを使わず、canvas の scale 変換で楕円を横に引き伸ばす。
// これが実際のスタジオ写真の影に最も近い表現。
function drawShadow(
  ctx: CanvasRenderingContext2D,
  centerX: number, seamY: number, scaledW: number
) {
  // ── 1. 接地影（瓶底直下・タイト）
  ctx.save();
  ctx.translate(centerX, seamY);
  ctx.scale(1, 0.18);
  ctx.filter = "blur(4px)";
  const contact = ctx.createRadialGradient(0, 0, 0, 0, 0, scaledW * 0.30);
  contact.addColorStop(0,   "rgba(0,0,0,0.55)");
  contact.addColorStop(0.5, "rgba(0,0,0,0.25)");
  contact.addColorStop(1,   "rgba(0,0,0,0)");
  ctx.fillStyle = contact;
  ctx.beginPath();
  ctx.arc(0, 0, scaledW * 0.30, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── 2. キャストシャドウ（右方向へ伸びる・拡散）
  //    原点を瓶底に置き、X方向に大きく引き伸ばし、右にオフセット
  const castOffX = scaledW * 0.55;   // 右へのオフセット
  const castScaleX = 2.8;            // 横への引き伸ばし倍率
  const castScaleY = 0.12;           // 縦の圧縮（床に寝た楕円）

  ctx.save();
  ctx.translate(centerX + castOffX, seamY + 2);
  ctx.scale(castScaleX, castScaleY);
  ctx.filter = "blur(18px)";
  const cast = ctx.createRadialGradient(0, 0, 0, 0, 0, scaledW * 0.45);
  cast.addColorStop(0,    "rgba(0,0,0,0.38)");
  cast.addColorStop(0.40, "rgba(0,0,0,0.18)");
  cast.addColorStop(0.75, "rgba(0,0,0,0.06)");
  cast.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = cast;
  ctx.beginPath();
  ctx.arc(0, 0, scaledW * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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

  // 上下余白を均等に（垂直中央揃え）
  const destX = (OUTPUT_W - scaledW) / 2;
  const destY = (OUTPUT_H - scaledH) / 2;

  const seamY    = destY + scaledH;       // 瓶の底 = 壁と床の境目
  const centerX  = OUTPUT_W / 2;

  // 最終キャンバス
  const canvas = document.createElement("canvas");
  canvas.width  = OUTPUT_W;
  canvas.height = OUTPUT_H;
  const ctx = canvas.getContext("2d")!;

  // 背景（壁・床・境目）
  drawStudioBackground(ctx, seamY);

  // 影（先に描いてから瓶を乗せる）
  drawShadow(ctx, centerX, seamY, scaledW);

  // 瓶本体
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
