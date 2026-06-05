const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, HeadingLevel, LevelFormat, BorderStyle, WidthType,
  ShadingType, VerticalAlign
} = require('docx');
const fs = require('fs');

const border = { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, bold: true, size: 32, font: 'Arial' })],
    spacing: { before: 300, after: 150 },
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, bold: true, size: 26, font: 'Arial' })],
    spacing: { before: 200, after: 100 },
  });
}
function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, font: 'Arial', size: 22, ...opts })],
    spacing: { before: 60, after: 60 },
  });
}
function bullet(text) {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    children: [new TextRun({ text, font: 'Arial', size: 22 })],
    spacing: { before: 40, after: 40 },
  });
}
function tableRow(cells, isHeader = false) {
  return new TableRow({
    children: cells.map((txt, i) => new TableCell({
      borders,
      margins: cellMargins,
      width: { size: [3000, 6360][i] || 3000, type: WidthType.DXA },
      shading: isHeader ? { fill: '1A8AC0', type: ShadingType.CLEAR } : (i === 0 ? { fill: 'EBF7FD', type: ShadingType.CLEAR } : undefined),
      children: [new Paragraph({
        children: [new TextRun({
          text: txt, font: 'Arial', size: 22,
          bold: isHeader, color: isHeader ? 'FFFFFF' : '000000',
        })],
      })],
    })),
  });
}
function featureTable(rows) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [3000, 6360],
    rows: [
      tableRow(['功能', '說明'], true),
      ...rows.map(r => tableRow(r)),
    ],
  });
}

const doc = new Document({
  numbering: {
    config: [{
      reference: 'bullets',
      levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
    }],
  },
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 32, bold: true, font: 'Arial', color: '1A8AC0' },
        paragraph: { spacing: { before: 300, after: 150 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, font: 'Arial', color: '1A5278' },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: [
      // 標題
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: '希絆雲作所', font: 'Arial', size: 48, bold: true, color: '1A8AC0' })],
        spacing: { before: 200, after: 100 },
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: '系統功能清單', font: 'Arial', size: 36, bold: true })],
        spacing: { before: 0, after: 100 },
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: '版本日期：2026年6月', font: 'Arial', size: 22, color: '666666' })],
        spacing: { before: 0, after: 400 },
      }),

      // ── 1. 系統架構
      h1('1. 系統架構'),
      featureTable([
        ['後端',     'Node.js + Express'],
        ['資料庫',   'Firebase Firestore（Google 雲端）'],
        ['認證',     'Express Session（Cookie）'],
        ['密碼',     'bcryptjs 雜湊加密'],
        ['前端',     '純 HTML / CSS / JavaScript'],
        ['版本控制', 'GitHub（hiban-ai.github.com）'],
        ['對外分享', 'ngrok 穿透隧道'],
      ]),

      // ── 2. 角色與帳號
      h1('2. 角色與帳號'),
      h2('預設帳號'),
      featureTable([
        ['admin（系統管理員）', '密碼：1234，系統最高權限'],
        ['staff01',            '密碼：0000，管理人員'],
        ['sv_001001（吳建國）', '密碼：0000，督導人員，負責2名夥伴'],
        ['sv_002002（蔡淑芬）', '密碼：0000，督導人員，負責1名夥伴'],
        ['sv_003003（林志明）', '密碼：0000，督導人員，負責3名夥伴'],
        ['partner01–06',       '密碼：0000，已核可工作夥伴（各有督導）'],
        ['partner07–10',       '密碼：0000，待核可工作夥伴'],
      ]),
      h2('系統管理者權限'),
      bullet('admin 帳號或 is_admin=true 的管理人員可見、可管理 admin 帳號'),
      bullet('新增管理人員時可勾選「設定成系統管理者」（僅系統管理者可設定）'),
      bullet('一般管理人員看不到 admin 帳號的操作按鈕'),

      // ── 3. 登入系統
      h1('3. 登入系統'),
      featureTable([
        ['三角色分頁',   '工作夥伴、督導人員、管理人員（下拉選帳號）'],
        ['首次登入',     '強制修改密碼（不可與舊密碼相同）'],
        ['忘記密碼',     '輸入姓名、身分證、生日核對身份後送出申請'],
        ['自動跳轉',     '已登入狀態開啟登入頁自動導向對應介面'],
      ]),

      // ── 4. 申請帳號
      h1('4. 申請帳號（工作夥伴）'),
      featureTable([
        ['三步驟表單',   '基本資料 → 身份文件 → 匯款資料'],
        ['基本資料',     '姓名、身分證、生日（下拉年月日）、電話、電子信箱（必填）、地址、身份別'],
        ['身份文件',     '身份證正面/反面上傳、選填證明文件'],
        ['匯款資料',     '銀行名稱、分行、帳號、戶名、存摺封面上傳'],
        ['帳號產生',     '系統自動產生帳號，顯示於完成頁'],
        ['申請後',       '狀態為「待核可」，等待管理人員審核並指定督導'],
      ]),

      // ── 5. 工作夥伴介面
      h1('5. 工作夥伴介面'),
      h2('總覽儀表板'),
      featureTable([
        ['統計卡',       '累計收入、本月完成、連續天數'],
        ['進行中任務',   '靜態示範任務卡片'],
        ['可接任務',     '同步顯示督導派案的待回覆任務（唯讀，無按鈕）'],
      ]),
      h2('任務頁面'),
      featureTable([
        ['待回覆',       '督導指派的派案，卡片含任務/數量/單價/總價/期限/說明'],
        ['接案',         '點「✅ 接案」→ 移至進行中'],
        ['拒絕',         '點「❌ 拒絕」→ 立即拒絕，任務消失'],
        ['進行中',       '已接案任務，顯示補充說明（90px）和督導意見（90px）格子'],
        ['審核中狀態',   '送出回報後，標籤改為「🔍 審核中」，回報按鈕反灰不可按'],
        ['督導意見',     '退回後顯示在卡片底部，格式：日期 時間　意見，可累加'],
        ['已完成',       '督導同意後移至此，含年份/月份下拉篩選'],
      ]),
      h2('任務回報'),
      featureTable([
        ['完成數量',     '必填，預設為 1'],
        ['網址',         '選填'],
        ['上傳圖片',     '支援多張，上傳後顯示縮圖（最多6張，自動壓縮至900px）'],
        ['補充說明',     '選填，多行文字'],
        ['送出',         '回報傳給督導進行審核'],
      ]),
      h2('個人資料'),
      featureTable([
        ['基本資料',     '姓名、身分證、生日（不可改）；電話、地址（可修改）'],
        ['銀行資料',     '銀行名稱、帳號（可修改）'],
        ['頭像上傳',     '點擊頭像可更換圖片，儲存於本機 localStorage'],
        ['修改密碼',     '橫排表單樣式'],
      ]),
      h2('其他頁面'),
      bullet('💰 錢包：收支明細'),
      bullet('🏆 成長：職業升級路線、勳章'),
      bullet('📝 回報：回報進度（靜態）'),
      bullet('📢 公告：公告列表'),

      // ── 6. 督導人員介面
      h1('6. 督導人員介面'),
      featureTable([
        ['總覽儀表板',   '負責夥伴數、完成任務數、待審 WorkLog、預警夥伴統計'],
        ['預警通知',     '顯示異常夥伴（靜態示範）'],
        ['夥伴管理',     '只顯示被指派給此督導的工作夥伴'],
        ['任務派案',     '指派給（個別夥伴）、任務類型（口碑/SEO/廣告）、數量、單價、總價自動計算、完成期限（天）、補充說明；派案後顯示紀錄'],
        ['任務審核',     '顯示夥伴回報（姓名、任務、數量、完成數量、網址、說明、圖片縮圖）'],
        ['任務審核-同意', '點「✓ 同意」→ 夥伴任務移至已完成'],
        ['任務審核-退回', '點「✎ 退回」→ 彈出原因視窗 → 傳回夥伴卡片（含日期時間）'],
        ['圖片放大',     '點擊圖片縮圖可全螢幕放大，再點關閉'],
        ['督導紀錄',     '新增督導紀錄（選夥伴、輔導類型、內容）'],
        ['個人資料',     '基本資料顯示（姓名、身分證、生日、電話），可修改電話和地址；修改密碼'],
      ]),

      // ── 7. 管理人員介面
      h1('7. 管理人員介面'),
      h2('帳號管理（三分頁）'),
      featureTable([
        ['工作夥伴分頁',   '姓名、角色、身分證、生日、狀態、申請時間、督導人員、操作'],
        ['督導人員分頁',   '姓名、角色、身分證、生日、狀態、申請時間、操作'],
        ['管理人員分頁',   '姓名、角色、身分證、生日、狀態、申請時間、操作'],
      ]),
      h2('操作按鈕規則'),
      featureTable([
        ['夥伴-待核可',     '詳細、核可（須選督導）、刪除'],
        ['夥伴-啟用',       '詳細、停用、密碼重設、刪除'],
        ['夥伴-停用',       '詳細、啟用、刪除'],
        ['督導-啟用',       '詳細、停用、密碼重設、刪除'],
        ['督導-停用',       '詳細、啟用、刪除'],
        ['管理人員（admin登入）', '詳細、停用/啟用、密碼重設、刪除'],
        ['管理人員（一般）',      '詳細、停用/啟用、刪除（無密碼重設）'],
        ['admin 帳號（非admin登入）', '僅顯示詳細'],
      ]),
      h2('核可工作夥伴'),
      bullet('必須選擇負責督導人員才能完成核可'),
      bullet('未選督導則顯示錯誤訊息'),
      bullet('核可後督導欄顯示指派的督導，可點「更換」調整'),
      h2('詳細資料彈窗'),
      featureTable([
        ['工作夥伴',   '姓名、負責督導、角色、身分證、生日、電話、電子信箱、地址、身份別、銀行名稱、銀行帳號、狀態、申請時間'],
        ['督導/管理人員', '姓名、角色、身分證、生日、電話、電子信箱、地址、狀態、申請時間'],
      ]),
      h2('新增帳號'),
      featureTable([
        ['新增督導人員', '姓名、身分證、生日（下拉）、電話、電子信箱、地址'],
        ['新增管理人員', '同上欄位；系統管理者登入時多一個「設定成系統管理者」勾選框'],
        ['預設密碼',     '0000，首次登入需修改'],
      ]),
      h2('忘記密碼管理'),
      bullet('顯示申請清單（姓名、帳號、申請時間）'),
      bullet('點「重設密碼」→ 密碼改為 0000，夥伴下次登入需修改'),
      h2('個人資料'),
      bullet('基本資料顯示，可修改電話和地址'),
      bullet('修改密碼'),

      // ── 8. 即時同步
      h1('8. 即時同步'),
      featureTable([
        ['派案同步',     '工作夥伴每3秒輪詢，有新派案自動更新總覽和任務頁'],
        ['接案通知',     '總覽儀表板的可接任務與任務頁待回覆同步顯示'],
        ['切頁更新',     '切換頁面立即重新拉取資料'],
        ['分頁可見更新', '從其他程式切回網頁時立即更新'],
      ]),

      // ── 9. 版本紀錄
      h1('9. 版本紀錄'),
      featureTable([
        ['stable-v1', '帳號管理、個人資料、三角色介面完整版'],
        ['stable-v2', '派案系統完整版（督導派案/夥伴接拒/Firebase）'],
        ['目前版本',  '任務審核、圖片回報、督導意見、系統管理者'],
      ]),
    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync('D:\\html\\網頁-公司\\希絆雲作所_功能清單.docx', buffer);
  console.log('✅ 文件已產生：希絆雲作所_功能清單.docx');
}).catch(e => console.error(e));
