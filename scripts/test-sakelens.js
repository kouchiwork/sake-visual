#!/usr/bin/env node
/**
 * SakeLens テストスクリプト
 * 使い方: node scripts/test-sakelens.js
 *
 * 1. localhost:3000を開く
 * 2. 背景ロード完了を待つ（キャッシュ or AI抽出）
 * 3. test-bottle.jpgをアップロードして変換
 * 4. 結果画像を test-result-{version}.png として保存
 * 5. 直前バージョンとMD5比較
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = 'http://localhost:3000';
const PUBLIC_DIR = path.join(__dirname, '../public');
const TEST_BOTTLE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(PUBLIC_DIR, 'test-bottle.jpg');

function md5(filepath) {
  const buf = fs.readFileSync(filepath);
  return crypto.createHash('md5').update(buf).digest('hex');
}

function getLatestResult() {
  const files = fs.readdirSync(PUBLIC_DIR)
    .filter(f => f.startsWith('test-result-') && f.endsWith('.png'))
    .sort();
  return files.length ? path.join(PUBLIC_DIR, files[files.length - 1]) : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('→ localhost:3000 を開いています...');
  await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });

  // バージョン番号を取得
  const version = await page.locator('text=/v\\d+\\.\\d+\\.\\d+/').first().textContent()
    .then(t => t?.match(/v[\d.]+/)?.[0] ?? 'unknown')
    .catch(() => 'unknown');
  console.log(`→ バージョン: ${version}`);

  // 背景ロード完了を待つ（data-bg-ready="true"になるまで）
  console.log('→ 背景ロード待機中...');
  await page.waitForFunction(
    () => document.querySelector('main')?.dataset.bgReady === 'true',
    null,
    { timeout: 180000 }
  );
  console.log('→ 背景ロード完了');

  // test-bottle.jpgをアップロード
  console.log('→ test-bottle.jpg をアップロード中...');
  const fileInput = page.locator('input[type="file"][multiple]');
  await fileInput.setInputFiles(TEST_BOTTLE);
  await page.waitForTimeout(500);

  // 濃淡・青系チェックボックスをOFFに（引数で制御）
  const darkOff = process.argv.includes('--no-dark');
  const blueOff = process.argv.includes('--no-blue');
  if (darkOff || blueOff) {
    const checkboxes = await page.locator('input[type="checkbox"]').all();
    if (darkOff && checkboxes[0]) await checkboxes[0].uncheck();
    if (blueOff && checkboxes[1]) await checkboxes[1].uncheck();
  }

  // 変換開始ボタンをクリック
  const startBtn = page.locator('button', { hasText: '変換開始' });
  await startBtn.click();
  console.log('→ 変換中...');

  // 完了を待つ
  await page.waitForSelector('.bg-green-900', { timeout: 180000 });
  console.log('→ 変換完了');

  // 結果画像のblob URLを取得してバイナリで保存
  const resultSrc = await page.evaluate(() => {
    const card = document.querySelector('.bg-green-900')?.closest('.rounded-xl');
    return card?.querySelector('img[alt="変換後"]')?.src ?? null;
  });

  if (!resultSrc) {
    console.error('✗ 結果画像が見つかりませんでした');
    await browser.close();
    process.exit(1);
  }

  const imageBuffer = await page.evaluate(async (src) => {
    const res = await fetch(src);
    const ab = await res.arrayBuffer();
    return Array.from(new Uint8Array(ab));
  }, resultSrc);

  const outFile = path.join(PUBLIC_DIR, `test-result-${version}.png`);
  fs.writeFileSync(outFile, Buffer.from(imageBuffer));
  console.log(`→ 保存: ${path.basename(outFile)}`);

  // MD5比較
  const newHash = md5(outFile);
  const prev = getLatestResult();
  const prevFile = prev && prev !== outFile ? prev : null;
  if (prevFile) {
    const prevHash = md5(prevFile);
    if (prevHash === newHash) {
      console.warn(`⚠ 警告: 直前の結果 (${path.basename(prevFile)}) と同一ファイルです！テストが正しく実行されていない可能性があります。`);
    } else {
      console.log(`✓ MD5確認: 前回 (${path.basename(prevFile)}) と異なる新しい画像です`);
    }
  }

  console.log(`\n✅ テスト完了`);
  console.log(`   バージョン : ${version}`);
  console.log(`   出力ファイル: ${outFile}`);
  console.log(`   MD5        : ${newHash}`);

  await browser.close();
})();
