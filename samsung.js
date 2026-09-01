// ═══════════════════════════════════════════════════════════
// samsung.js — סורק קטלוג Samsung Israel (samsung.com/il)
// שייך ל-repo: catalog-scraper
//
// ⚠️ טיוטה ראשונה — הסלקטורים מבוססים על מבנה סטנדרטי של אתרי
// Samsung אזוריים (pd19-* / data-testid) ולא אומתו בדפדפן אמיתי.
// יש להריץ workflow_dispatch ידני ולבדוק ב-DevTools (F12) בדיוק
// כמו שעשינו עם Semicom (.sku-preview) לפני ריצה יומית אוטומטית.
//
// samsung.com/il ככל הנראה מוגן ע"י Akamai/Cloudflare ברמה גבוהה,
// בדומה ל-semicom.co.il → אם GitHub Actions הענן נחסם, יש להריץ על
// ה-self-hosted runner (DESKTOP-T24MMUB), בדיוק כמו Semicom.
//
// עקרון "ללא מחירים": המוצרים נכתבים ל-KV בלי מחיר אמיתי
// (priceNum: 0). ה"צרו קשר בוואטסאפ" לא מטופל כאן — הוא מטופל
// ב-sync.js (comphone-admin) דרך noPriceMode:'contact' +
// noPriceText, שמוסיף את התווית לשם המוצר בזמן הסנכרון ל-iStores.
// כך שינוי מספר הוואטסאפ נעשה במקום אחד (הגדרות הסנכרון), לא כאן.
// ═══════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

// קטגוריות שורש — לפי מבנה תפריט טיפוסי של samsung.com/il.
// יש להשלים/לאמת כתובות מדויקות מול תפריט הניווט באתר עצמו,
// כמו שעשינו עם 229 ה-URLs של Semicom.
const SAMSUNG_CATEGORIES = [
  { url: 'https://www.samsung.com/il/smartphones/all-smartphones/', sub: 'סמארטפונים' },
  { url: 'https://www.samsung.com/il/smartphones/galaxy-tab/all-galaxy-tab/', sub: 'טאבלטים' },
  { url: 'https://www.samsung.com/il/watches/all-watches/', sub: 'שעונים חכמים' },
  { url: 'https://www.samsung.com/il/mobile-accessories/all-mobile-accessories/', sub: 'אביזרים לנייד' },
  { url: 'https://www.samsung.com/il/tvs/all-tvs/', sub: 'טלוויזיות' },
  { url: 'https://www.samsung.com/il/audio-devices/all-audio-devices/', sub: 'אודיו' },
  { url: 'https://www.samsung.com/il/monitors/all-monitors/', sub: 'מוניטורים' },
  { url: 'https://www.samsung.com/il/refrigerators/all-refrigerators/', sub: 'מקררים' },
  { url: 'https://www.samsung.com/il/washers-and-dryers/all-washers-and-dryers/', sub: 'מכונות כביסה וייבוש' },
  { url: 'https://www.samsung.com/il/air-conditioners/all-air-conditioners/', sub: 'מזגנים' },
  { url: 'https://www.samsung.com/il/vacuum-cleaners/all-vacuum-cleaners/', sub: 'שואבי אבק' },
  { url: 'https://www.samsung.com/il/cooking-appliances/all-cooking-appliances/', sub: 'מוצרי בישול' },
];

function mapType(sub) {
  if (/סמארטפונ|טאבלט|שעונ|אביז/.test(sub)) return 'מובייל';
  if (/טלוויז/.test(sub)) return 'טלוויזיה';
  if (/אודיו/.test(sub)) return 'אודיו';
  if (/מוניטור/.test(sub)) return 'מוניטור';
  return 'מוצרי בית';
}

async function scrapeSamsung(page) {
  console.log('🔍 Scraping Samsung Israel...');
  const products = [];

  for (const cat of SAMSUNG_CATEGORIES) {
    try {
      console.log(`  → קטגוריה: ${cat.sub} (${cat.url})`);
      await page.goto(cat.url, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(2500);

      // גלילה + לחיצה על "הצג עוד" עד שכמות המוצרים מתייצבת
      let lastCount = -1;
      let stableRounds = 0;
      for (let i = 0; i < 15 && stableRounds < 2; i++) {
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(b =>
            /הצג עוד|טען עוד|load more|show more/i.test(b.textContent || ''));
          if (btn) btn.click();
        });
        const count = await page.evaluate(() =>
          document.querySelectorAll('[data-testid="product-card"], .pd19-product-card, li.pd-list-item').length);
        stableRounds = count === lastCount ? stableRounds + 1 : 0;
        lastCount = count;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1200);
      }

      const items = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(
          '[data-testid="product-card"], .pd19-product-card, li.pd-list-item'
        )];
        return cards.map(el => {
          const titleEl = el.querySelector(
            '.pd19-product-card__name, [data-testid="product-card-title"], .pd-list-item__name, h3'
          );
          const imgEl = el.querySelector('img');
          const linkEl = el.querySelector('a[href]');
          const skuAttr = el.getAttribute('data-model-code') || el.getAttribute('data-model') || '';

          return {
            title: titleEl ? titleEl.textContent.trim() : '',
            img: imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || '') : '',
            url: linkEl ? linkEl.href : '',
            sku: skuAttr,
          };
        }).filter(p => p.title);
      });

      console.log(`    ${cat.sub}: ${items.length} מוצרים`);

      for (const item of items) {
        products.push({
          title: item.title,
          price: '',                 // אין מחיר — תווית "צרו קשר" מתווספת ב-sync.js
          priceNum: 0,
          img: item.img,
          url: item.url,
          sku: item.sku,
          type: mapType(cat.sub),
          category: 'samsung',       // קטגוריית שורש קבועה בחנות
          subCategory: cat.sub,
          supplier: 'Samsung',
          brand: 'Samsung',
          stock: 'זמין',
        });
      }

      await sleep(1500);
    } catch (e) {
      console.error(`  ❌ Samsung [${cat.sub}] error:`, e.message);
    }
  }

  // דדופ לפי SKU/כותרת (מוצר עלול לחזור בכמה קטגוריות)
  const seen = new Set();
  const unique = products.filter(p => {
    const key = p.sku || p.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  ✅ Samsung: ${unique.length} מוצרים ייחודיים`);
  return unique;
}

module.exports = { scrapeSamsung };
