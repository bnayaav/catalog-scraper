// ═══════════════════════════════════════════════════════════
// samsung.js — קטלוג Samsung Israel, נטען מקובץ HTML מקומי
// שייך ל-repo: catalog-scraper
//
// שינוי גישה (אחרי שניסיון סריקה חיה מול samsung.com/il החזיר 0
// מוצרים בכל הקטגוריות): לא סורקים יותר את האתר החי. במקום זה,
// קטלוג המוצרים (448 מוצרים, 19 קטגוריות, 4 קבוצות) שמור כקובץ
// HTML סטטי ב-repo עצמו: data/samsung_il_catalog.html — אתה מעדכן
// אותו ידנית מתי שתרצה (למשל פעם ברבעון), וה-scraper רק *קורא*
// אותו בכל ריצה יומית ומייצא ל-KV. אין תלות ברשת/בהגנת בוט בכלל,
// אז זה גם לא צריך את ה-self-hosted runner מבחינת סמסונג עצמו
// (עדיין ירוץ שם כי סמיקום צריך את זה).
//
// מבנה הקובץ (מאומת מול הקובץ שהעלית):
//   div.group          → קבוצה עליונה (מובייל / טלוויזיה ואודיו / ...)
//     h2                 שם הקבוצה + מונה, למשל "מובייל(220)"
//     section.category → קטגוריה (19 בסך הכול)
//       h3                שם הקטגוריה + מונה, למשל "סמארטפונים(34)"
//       a.card          → כרטיס מוצר (448 בסך הכול)
//         .card-img img   תמונת המוצר
//         .card-name      שם המוצר
//         .card-price     מחיר (מתעלמים ממנו בכוונה — ראו הערה למטה)
//
// עקרון "ללא מחירים": בכוונה **מתעלמים** משדה card-price בקובץ,
// גם אם יש שם מחיר אמיתי — כל מוצר סמסונג יוצא מכאן עם priceNum:0.
// התווית שמוצגת בפועל בחנות ("לבדיקת זמינות ומחיר...") מוגדרת
// במקום מרוכז אחד: SAMSUNG_SETTINGS_OVERRIDES.noPriceText, בקובץ
// samsung.js של comphone-admin — לא כאן. כך שינוי הטקסט/הטלפון
// לא דורש נגיעה בסורק או בקובץ הקטלוג.
// ═══════════════════════════════════════════════════════════

const path = require('path');

const CATALOG_FILE = path.join(__dirname, 'data', 'samsung_il_catalog.html');

async function scrapeSamsung(page) {
  console.log('🔍 Loading Samsung Israel catalog (local file)...');
  const products = [];

  try {
    await page.goto('file://' + CATALOG_FILE, { waitUntil: 'load', timeout: 15000 });

    const raw = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s*\(\d+\)\s*$/, '').trim();
      const groups = [...document.querySelectorAll('.group')];
      const out = [];
      for (const g of groups) {
        const groupName = clean(g.querySelector('h2')?.textContent || '');
        const cats = [...g.querySelectorAll('section.category')];
        for (const cat of cats) {
          const catName = clean(cat.querySelector('h3')?.textContent || '');
          const cards = [...cat.querySelectorAll('a.card')];
          for (const card of cards) {
            const img = card.querySelector('.card-img img');
            const nameEl = card.querySelector('.card-name');
            out.push({
              title: nameEl?.textContent?.trim() || img?.getAttribute('alt') || '',
              url: card.href || '',
              img: img?.src || '',
              group: groupName,
              category: catName,
            });
          }
        }
      }
      return out;
    });

    console.log(`  📄 נקראו ${raw.length} מוצרים מהקובץ המקומי`);

    for (const item of raw) {
      if (!item.title) continue;
      products.push({
        title: item.title,
        price: '',                   // בכוונה — התווית מתווספת ב-sync.js
        priceNum: 0,                  // תמיד 0, גם אם בקובץ יש מחיר אמיתי
        img: item.img,
        url: item.url,
        category: 'samsung',          // קטגוריית שורש קבועה בחנות
        subCategory: item.category,   // אחת מ-19 הקטגוריות (סמארטפונים, טלוויזיות...)
        group: item.group,            // רמת קיבוץ נוספת, לשימוש עתידי אם תרצה
        supplier: 'Samsung',
        brand: 'Samsung',
        stock: 'זמין',
      });
    }
  } catch (e) {
    console.error('  ❌ Samsung error:', e.message);
  }

  // דדופ לפי URL (מוצר לא אמור לחזור פעמיים בקובץ, אבל ליתר ביטחון)
  const seen = new Set();
  const unique = products.filter(p => {
    const key = p.url || p.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  ✅ Samsung: ${unique.length} מוצרים ייחודיים`);
  return unique;
}

module.exports = { scrapeSamsung };
