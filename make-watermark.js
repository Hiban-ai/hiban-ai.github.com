// 執行：node make-watermark.js
// 產生 assets/watermark.png（半透明斜向文字浮水印）
// 需要：jimp（已安裝）

const Jimp = require('jimp');
const path = require('path');
const fs   = require('fs');

// ── 設定區 ────────────────────────────────────────
const TEXT      = '僅供希絆有限公司使用';
const W         = 1200;   // 畫布寬
const H         = 1200;   // 畫布高
const ROWS      = 4;      // 重複幾列
const COLS      = 3;      // 重複幾欄
const OPACITY   = 0.18;   // 透明度（0~1，越大越明顯）
const FONT_SIZE = 64;     // ← 這裡調大小（原本可能是 32 或更小）
// ─────────────────────────────────────────────────

// Jimp 只支援 ASCII 內建字型，中文要用 SVG 轉
// 做法：產生 SVG → 轉 PNG buffer → 用 Jimp 合成

const { execSync } = require('child_process');

async function main() {
  // 用 SVG 畫文字（支援中文）
  const svgItems = [];
  const stepX = W / COLS;
  const stepY = H / ROWS;

  for (let r = 0; r < ROWS + 1; r++) {
    for (let c = 0; c < COLS + 1; c++) {
      const cx = c * stepX - stepX * 0.3;
      const cy = r * stepY;
      svgItems.push(
        `<text x="${cx}" y="${cy}" transform="rotate(-35,${cx},${cy})"
          font-size="${FONT_SIZE}" fill="rgba(80,80,80,${OPACITY})"
          font-family="Microsoft JhengHei,Arial,sans-serif"
          font-weight="bold" letter-spacing="4">${TEXT}</text>`
      );
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
     viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="transparent"/>
  ${svgItems.join('\n  ')}
</svg>`;

  const svgPath = path.join(__dirname, 'assets', '_wm_tmp.svg');
  const outPath = path.join(__dirname, 'assets', 'watermark.png');

  fs.writeFileSync(svgPath, svg, 'utf8');

  // 嘗試用 Inkscape / ImageMagick 轉換，都沒有的話用 Jimp 備援
  let converted = false;

  // 嘗試 Inkscape
  try {
    execSync(`inkscape --export-type=png --export-filename="${outPath}" "${svgPath}"`, { stdio:'ignore' });
    if (fs.existsSync(outPath)) { converted = true; console.log('✅ 用 Inkscape 產生成功'); }
  } catch(e) {}

  // 嘗試 ImageMagick (magick / convert)
  if (!converted) {
    for (const cmd of ['magick', 'convert']) {
      try {
        execSync(`${cmd} -background none -density 150 "${svgPath}" "${outPath}"`, { stdio:'ignore' });
        if (fs.existsSync(outPath)) { converted = true; console.log(`✅ 用 ${cmd} 產生成功`); break; }
      } catch(e) {}
    }
  }

  // 都沒裝：用 Jimp 畫純色塊（ASCII only，中文會變 ？）
  if (!converted) {
    console.log('⚠️  找不到 Inkscape / ImageMagick，改用 Jimp 備援（中文會顯示為空白）');
    console.log('   建議安裝 ImageMagick：https://imagemagick.org/script/download.php#windows');
    const img = new Jimp(W, H, 0x00000000);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    for (let r = 0; r < ROWS + 1; r++) {
      for (let c = 0; c < COLS + 1; c++) {
        const x = Math.round(c * (W / COLS) - 80);
        const y = Math.round(r * (H / ROWS) - 20);
        img.print(font, x, y, TEXT);
      }
    }
    img.opacity(OPACITY);
    await img.writeAsync(outPath);
  }

  fs.unlinkSync(svgPath);
  console.log(`✅ 完成：${outPath}`);
  console.log(`   文字：${TEXT}`);
  console.log(`   字型大小：${FONT_SIZE}px  透明度：${Math.round(OPACITY * 100)}%`);
}

main().catch(e => { console.error('失敗：', e.message); process.exit(1); });
