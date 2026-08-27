// ═══════════════════════════════════════════════════════════
// catalog-scraper — סורק יומי אוטומטי
// מסרוק 4 אתרי ספקים ומעדכן Cloudflare KV
// ═══════════════════════════════════════════════════════════

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── הגדרות ──
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE = process.env.CF_KV_NAMESPACE;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const USD_RATE = 3.65;

// ── זיהוי מוצר ──
function detectType(title) {
  const t = title.toLowerCase();
  if (/notebook|laptop|נייד|lpt|nb |macbook/i.test(t)) return 'נייד';
  if (/aio|all.in.one|הכל.באחד/i.test(t)) return 'AIO';
  if (/workstation|תחנת.עבודה/i.test(t)) return 'תחנת עבודה';
  if (/desktop|נייח|tower|mini.pc|mff|sff/i.test(t)) return 'נייח';
  return 'נייח';
}

function detectBrand(title) {
  const brands = ['HP','Dell','ASUS','Apple','Lenovo','MSI','Acer','Samsung','Toshiba','LG','Microsoft','Gigabyte'];
  const t = title.toUpperCase();
  return brands.find(b => t.includes(b.toUpperCase())) || '';
}

function extractSpecs(title) {
  const t = title.toUpperCase();
  const ram = (t.match(/(\d+)GB\s*(RAM|DDR)/i) || t.match(/(\d+)G\s+RAM/i) || [])[1];
  const storage = (t.match(/(\d+(?:TB|GB))\s*(?:SSD|NVME|HDD|EMMC)/i) || [])[0];
  const cpu = (t.match(/(?:CORE\s+)?I[3579]-?\d{4,5}[A-Z]*/i) ||
               t.match(/ULTRA\s+[579]\s*\d{3}/i) ||
               t.match(/RYZEN\s+[3579]/i) ||
               t.match(/CELERON|PENTIUM|ATOM|N\d{4}/i) || [])[0];
  const gpu = (t.match(/RTX\s*\d{4}(?:\s*TI)?/i) ||
               t.match(/GTX\s*\d{4}/i) ||
               t.match(/RADEON\s+\w+/i) || [])[0];
  return { ram: ram ? ram+'GB' : '', storage: storage || '', cpu: cpu || '', gpu: gpu || '' };
}

function parsePrice(priceStr) {
  if (!priceStr) return 0;
  const clean = priceStr.replace(/[^\d.]/g, '');
  const num = parseFloat(clean);
  if (!num) return 0;
  // Dollar sign → convert to ILS
  if (priceStr.includes('$')) return Math.round(num * USD_RATE);
  return Math.round(num);
}

// ══════════════════════════════════════════
// SCRAPER 1: C-Data (via HTTP fetch — bypass WAF)
// ══════════════════════════════════════════
async function scrapeCData(page) {
  console.log('🔍 Scraping C-Data...');
  const products = [];

  try {
    // Login via direct HTTP POST (bypass Puppeteer WAF block)
    await page.goto('https://reseller.c-data.co.il/Login', { waitUntil: 'load', timeout: 30000 });
    await sleep(3000);

    const emailFound = await page.$('#Email');
    console.log('    #Email found:', !!emailFound);

    if (!emailFound) {
      console.log('  ⚠️ C-Data: WAF blocking GitHub IP, skipping');
      return products;
    }

    await page.click('#Email');
    await page.type('#Email', process.env.SCRAPER_USER || '');
    await page.click('#Password');
    await page.type('#Password', process.env.CDATA_PASS || '');
    await page.click('button.login-button');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{});
    await sleep(2000);

    console.log('  ✅ C-Data logged in, URL:', page.url());

    const categories = [
      { url: 'https://reseller.c-data.co.il/laptops', type: 'נייד' },
      { url: 'https://reseller.c-data.co.il/asus-laptops', type: 'נייד' },
      { url: 'https://reseller.c-data.co.il/hp-laptops', type: 'נייד' },
      { url: 'https://reseller.c-data.co.il/dell-laptops', type: 'נייד' },
    ];

    for (const cat of categories) {
      let page_num = 1;
      let has_more = true;

      while (has_more) {
        const url = page_num === 1 ? cat.url : `${cat.url}?page=${page_num}`;
        await page.goto(url, { waitUntil: 'networkidle2' });
        await sleep(2000);

        const itemCount = await page.evaluate(() => document.querySelectorAll('.product-item').length);
        console.log(`    C-Data ${cat.url.split('/').pop()} page ${page_num}: ${itemCount} items`);

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('.product-item')].map(el => ({
            title: el.querySelector('.product-title a')?.textContent?.trim() || '',
            price: el.querySelector('span.actual-price')?.textContent?.trim() || '',
            img: el.querySelector('img.product-image')?.src || '',
            url: el.querySelector('.product-title a')?.href || '',
            stock: el.querySelector('.stock span.value')?.className || '',
            sku: el.querySelector('.sku')?.textContent?.trim() || '',
          })).filter(p => p.title);
        });

        for (const item of items) {
          const specs = extractSpecs(item.title);
          const stock = item.stock.includes('green') ? 'זמין' :
                        item.stock.includes('red') ? 'אזל' : 'מלאי בדרך';
          products.push({
            title: item.title,
            price: item.price.startsWith('$') ? item.price : `$${item.price}`,
            priceNum: parsePrice(item.price),
            img: item.img,
            url: item.url,
            type: cat.type || detectType(item.title),
            supplier: 'C-Data',
            brand: detectBrand(item.title),
            stock,
            ...specs,
          });
        }

        const hasNext = await page.$('.pager .next-page, .pager a[rel="next"]');
        has_more = !!hasNext && items.length > 0;
        page_num++;
        if (page_num > 10) break;
        await sleep(1000);
      }
    }
  } catch (e) {
    console.error('  ❌ C-Data error:', e.message);
  }

  console.log(`  ✅ C-Data: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// SCRAPER 2: Morlevi
// ══════════════════════════════════════════
async function scrapeMorelevi(page) {
  console.log('🔍 Scraping Morlevi...');
  const products = [];

  try {
    // Step 1: Get login token via API
    // Morlevi - login via modal popup
    await page.goto('https://www.morlevi.co.il', { waitUntil: 'networkidle2' });
    await sleep(2000);

    // Click login button to open modal
    const loginBtn = await page.$('a[href*="login"], button[data-target*="login"], .login-btn, a.nav-link[href*="login"]');
    if (loginBtn) {
      await loginBtn.click();
      await sleep(1500);
    } else {
      // Try finding by text
      await page.evaluate(() => {
        const links = [...document.querySelectorAll('a, button')];
        const btn = links.find(l => l.textContent.trim().includes('התחבר') || l.textContent.toLowerCase().includes('login'));
        if (btn) btn.click();
      });
      await sleep(1500);
    }

    // Fill modal form
    await page.waitForSelector('#email', { timeout: 5000 }).catch(()=>{});
    await page.type('#email', process.env.SCRAPER_USER || '');
    await page.type('#Password', process.env.MORLEVI_PASS || '');
    await page.click('button[type="submit"].btn-primary');
    await sleep(3000);

    const afterUrl = page.url();
    console.log('    Morlevi URL after login:', afterUrl);
    await sleep(2000);

    const categories = [
      { url: 'https://www.morlevi.co.il/Cat/195', type: 'נייד' },
      { url: 'https://www.morlevi.co.il/Cat/4', type: 'נייח' },
      { url: 'https://www.morlevi.co.il/Cat/201', type: 'AIO' },
    ];

    for (const cat of categories) {
      let page_num = 1;
      let has_more = true;

      while (has_more) {
        const url = page_num === 1 ? cat.url : `${cat.url}?page=${page_num}`;
        await page.goto(url, { waitUntil: 'networkidle2' });
        await sleep(2000);

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('div.product-thumb')].map(el => {
            const wrap = el.closest('[class*="col"]') || el.parentElement;
            return {
              title: wrap?.querySelector('h5.title, h5, h2')?.textContent?.trim() || '',
              price: wrap?.querySelector('small.price, .price')?.textContent?.trim() || '',
              img: (() => { const src = el.querySelector('a#mainpic img, .product-thumb img, img.img-fluid')?.src || ''; return src.startsWith('/') ? 'https://www.morlevi.co.il' + src : src; })(),
              url: wrap?.querySelector('a[href*="/product/"]')?.href || '',
              stock: wrap?.querySelector('.stockMsg')?.className || '',
            };
          }).filter(p => p.title && p.title.length > 3 && !p.title.includes('מק"ט'));
        });

        console.log(`    Morlevi ${cat.url.split('/').pop()} page ${page_num}: ${items.length} products`);

        for (const item of items) {
          if (!item.title) continue;
          const specs = extractSpecs(item.title);
          // stockMsg classes: green=זמין, red=אזל, yellow=מוגבל
          const stockClass = item.stock.toLowerCase();
          const stock = stockClass.includes('red') ? 'אזל' :
                        stockClass.includes('green') ? 'זמין' :
                        stockClass.includes('yellow') ? 'מוגבל' : '';
          if (stock === 'אזל') continue; // דלג על מוצרים שאזלו
          products.push({
            title: item.title,
            price: item.price || '',
            priceNum: parsePrice(item.price),
            img: item.img,
            url: item.url,
            type: cat.type,
            supplier: 'Morlevi',
            brand: detectBrand(item.title),
            stock,
            ...specs,
          });
        }

        const hasNext = await page.$('nav a[aria-label="Next"], .next-page, a[rel="next"]');
        has_more = !!hasNext && items.length > 0;
        page_num++;
        if (page_num > 10) break;
        await sleep(1500);
      }
    }
  } catch (e) {
    console.error('  ❌ Morlevi error:', e.message);
  }

  console.log(`  ✅ Morlevi: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// SCRAPER 3: Amtel
// ══════════════════════════════════════════
async function scrapeAmtel(page) {
  console.log('🔍 Scraping Amtel...');
  const products = [];

  try {
    await page.goto('https://www.amtel.co.il/customer_login', { waitUntil: 'networkidle2' });
    await sleep(2000);
    await page.waitForSelector('#customer_session_username', { timeout: 10000 });
    await page.type('#customer_session_username', process.env.SCRAPER_USER || '');
    await page.type('#customer_session_password', process.env.AMTEL_PASS || '');
    // Submit via form (link submits to /customer_sessions)
    await page.evaluate(() => {
      const form = document.querySelector('form[action*="customer_session"]');
      if (form) form.submit();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{});
    await sleep(2000);
    console.log('  ✅ Amtel logged in, URL:', page.url());

    const categories = [
      'https://www.amtel.co.il/90097-מחשבים-ניידים',
      'https://www.amtel.co.il/90098-מחשבים-נייחים',
      'https://www.amtel.co.il/90099-מחשבים-הכל-באחד',
    ];

    for (const catUrl of categories) {
      let pageNum = 1;
      let hasMore = true;

      while (hasMore) {
        const url = pageNum === 1 ? catUrl : `${catUrl}?page=${pageNum}`;
        await page.goto(url, { waitUntil: 'networkidle2' });
        await sleep(2000);

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('.layout_list_item')].map(el => ({
            title: el.querySelector('.list_item_title_with_brand, .list_item_title')?.textContent?.trim() || '',
            price: el.querySelector('.list_item_show_price')?.textContent?.trim() || '',
            img: el.querySelector('.list_item_image img, img')?.src || '',
            url: el.querySelector('a')?.href || '',
            stock: el.querySelector('[class*="stock"], [class*="avail"]')?.textContent?.trim() || 'זמין',
          })).filter(p => p.title);
        });

        console.log(`    Amtel ${catUrl.split('/').pop()} page ${pageNum}: ${items.length} products`);
        if (items.length === 0) break;

        for (const item of items) {
          products.push({
            title: item.title,
            price: item.price,
            priceNum: parsePrice(item.price),
            img: item.img,
            url: item.url,
            type: detectType(item.title),
            supplier: 'Amtel',
            brand: detectBrand(item.title),
            stock: item.stock.includes('אזל') ? 'אזל' : 'זמין',
            ...extractSpecs(item.title),
          });
        }

        const hasNext = await page.$('div.pagination a.next_page');
        hasMore = !!hasNext;
        pageNum++;
        if (pageNum > 20) break;
        await sleep(1000);
      }
    }
  } catch (e) {
    console.error('  ❌ Amtel error:', e.message);
  }

  console.log(`  ✅ Amtel: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// SCRAPER 4: Techno Rezef (Shopify)
// ══════════════════════════════════════════
async function scrapeTechnoRezef(page) {
  console.log('🔍 Scraping Techno Rezef...');
  const products = [];

  try {
    await page.goto('https://techno-rezef.com/account/login', { waitUntil: 'networkidle2' });
    await sleep(2000);
    await sleep(3000);
    await page.waitForSelector('#customer-email', { timeout: 20000 });
    await page.type('#customer-email', process.env.SCRAPER_USER || '');
    await page.type('#customer-password', process.env.TECHNO_PASS || '');
    await page.click('button.btn--primary');
    await sleep(4000);
    // Wait for redirect to /account
    await page.waitForFunction(() => !window.location.href.includes('/account/login'), { timeout: 15000 }).catch(()=>{});
    await sleep(1000);
    console.log('  ✅ Techno logged in, URL:', page.url());

    const categories = [
      { url: 'https://techno-rezef.com/collections/all', type: null },
    ];

    for (const cat of categories) {
      let pageNum = 1;
      let hasMore = true;

      while (hasMore) {
        const url = `${cat.url}?page=${pageNum}`;
        await page.goto(url, { waitUntil: 'networkidle2' });
        await sleep(2000);

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('.product-item, .grid__item, .card-wrapper, [class*="product"]')]
            .filter(el => el.querySelector('h2, h3, .card__heading'))
            .map(el => ({
              title: el.querySelector('h2, h3, .card__heading, .product-item__title')?.textContent?.trim() || '',
              price: el.querySelector('.price, .price__regular, [class*="price"]')?.textContent?.trim() || '',
              img: el.querySelector('img')?.src || '',
              url: (() => { const a = el.querySelector('a'); return a ? 'https://techno-rezef.com' + a.getAttribute('href') : ''; })(),
              inStock: !el.querySelector('[class*="sold-out"], [class*="unavailable"]'),
            })).filter(p => p.title);
        });

        console.log(`    Techno page ${pageNum}: ${items.length} products`);
        if (items.length === 0) break;

        for (const item of items) {
          products.push({
            title: item.title,
            price: item.price,
            priceNum: parsePrice(item.price),
            img: item.img,
            url: item.url,
            type: cat.type || detectType(item.title),
            supplier: 'Techno-Rezef',
            brand: detectBrand(item.title),
            stock: item.inStock ? 'זמין' : 'אזל',
            ...extractSpecs(item.title),
          });
        }

        // Shopify stops returning items when page exceeds total
        pageNum++;
        if (pageNum > 50) break;
        await sleep(1000);
      }
    }
  } catch (e) {
    console.error('  ❌ Techno Rezef error:', e.message);
  }

  console.log(`  ✅ Techno Rezef: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// SCRAPER 5: Atomic Online
// ══════════════════════════════════════════
async function scrapeAtomic(page) {
  console.log('🔍 Scraping Atomic...');
  const products = [];

  try {
    await page.goto('https://atomiconline.co.il/login', { waitUntil: 'networkidle2' });
    await sleep(2000);

    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="mail"]');
    if (emailInput) await emailInput.type(process.env.SCRAPER_USER);
    const passInput = await page.$('input[type="password"]');
    if (passInput) await passInput.type(process.env.ATOMIC_PASS || '');

    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) { await submitBtn.click(); await page.waitForNavigation({ waitUntil: 'networkidle2' }); }
    console.log('  ✅ Atomic logged in');

    const categories = [
      { url: 'https://atomiconline.co.il/categories/laptops', type: 'נייד' },
      { url: 'https://atomiconline.co.il/categories/desktops', type: 'נייח' },
    ];

    for (const cat of categories) {
      await page.goto(cat.url, { waitUntil: 'networkidle2' });
      await sleep(3000);

      // Load more products
      for (let i = 0; i < 5; i++) {
        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')].find(b =>
            b.textContent.includes('טען עוד') || b.textContent.toLowerCase().includes('load more'));
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!clicked) break;
        await sleep(2000);
      }
      const items = await page.evaluate(() => {
        return [...document.querySelectorAll('a[href*="/products/"]')].map(el => ({
          title: el.querySelector('p.line-clamp-3, p.font-medium')?.textContent?.trim() || '',
          price: (() => { for(const s of el.querySelectorAll('span')) { if(s.textContent.includes('₪')||s.textContent.includes('$')) return s.textContent.trim(); } return ''; })(),
          img: el.querySelector('img')?.src || '',
          url: el.href || '',
          stock: el.querySelector('.badge-clearance') ? 'חיסול' : 'זמין',
        }));
      });

      for (const item of items) {
        if (!item.title) continue;
        const specs = extractSpecs(item.title);
        products.push({
          title: item.title,
          price: item.price,
          priceNum: parsePrice(item.price),
          img: item.img,
          url: item.url,
          type: cat.type,
          supplier: 'Atomic',
          brand: detectBrand(item.title),
          stock: item.stock,
          ...specs,
        });
      }
    }
  } catch (e) {
    console.error('  ❌ Atomic error:', e.message);
  }

  console.log(`  ✅ Atomic: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// SCRAPER: Semicom (Magento) — כל האתר, מסודר לפי קטגוריות + 30% רווח
//
// לא נדרשת התחברות. מאתר את כל הקטגוריות מתפריט הניווט הראשי
// (ולא רק appliances/tools כמו קודם), וסורק כל קטגוריה בנפרד -
// כך שסדר המוצרים ב-KV הולך קטגוריה-קטגוריה, לפי סדר התפריט של סמיקום.
// לכל מוצר מתווסף שדה category. המחיר מחושב מ-data-price-amount
// (attribute מדויק של Magento) בתוספת 30% רווח.
// ══════════════════════════════════════════
// שימו לב: אין כאן תוספת רווח בכוונה. המחיר שנשמר כאן הוא מחיר הספק הגולמי
// (ישירות מ-data-price-amount). הרווח מחושב במקום מרוכז אחד — ב-sync.js
// של comphone-admin — בדיוק כמו אצל אטומיק, כדי שיהיה ניתן לשנות אותו
// מהגדרות בלי לגעת בסורק או לחכות לריצה הבאה.

async function collectSemicomCategoryUrls(page) {
  console.log('  🔎 Semicom: מאתר קטגוריות מתפריט הניווט...');
  let categories = [];

  try {
    await page.goto('https://www.semicom.co.il/', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    categories = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const navRoots = document.querySelectorAll('nav.navigation, nav ul.navigation, .navigation');
      const anchors = navRoots.length
        ? [...navRoots].flatMap(nav => [...nav.querySelectorAll('a[href]')])
        : [...document.querySelectorAll('header a[href]')];

      anchors.forEach(a => {
        const href = a.href;
        const name = a.textContent.trim();
        if (!href || !name) return;
        if (seen.has(href)) return;
        // דילוג על עמודים שאינם קטגוריות מוצרים
        if (/account|checkout|cart|search|contact|about|blog|wishlist|compare|login|register|javascript:|#$/i.test(href)) return;
        if (!href.includes('semicom.co.il')) return;
        seen.add(href);
        results.push({ url: href, name });
      });
      return results;
    });

    console.log(`  ✅ Semicom: נמצאו ${categories.length} קטגוריות בתפריט`);
  } catch (e) {
    console.error('  ❌ Semicom category discovery error:', e.message);
  }

  return categories;
}

async function scrapeSemicomCategory(page, categoryUrl, categoryName) {
  const products = [];
  let pageNum = 1;
  let hasMore = true;
  const seenPageUrls = new Set(); // הגנת לולאה אינסופית

  while (hasMore) {
    const url = pageNum === 1 ? categoryUrl : `${categoryUrl}${categoryUrl.includes('?') ? '&' : '?'}p=${pageNum}`;
    if (seenPageUrls.has(url)) break;
    seenPageUrls.add(url);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(1500);
    } catch (e) {
      console.error(`    ⚠️ Semicom "${categoryName}" עמוד ${pageNum} שגיאת טעינה:`, e.message);
      break;
    }

    const items = await page.evaluate(() => {
      return [...document.querySelectorAll('li.item.product.product-item')].map(card => {
        const linkEl = card.querySelector('.product-item-name a.product-item-link');
        const priceEl = card.querySelector('.price-wrapper[data-price-amount]');
        const imgEl = card.querySelector('img.product-image-photo');
        const skuEl = card.querySelector('.sku-preview-text');
        return {
          title: linkEl?.textContent?.trim() || '',
          url: linkEl?.href || '',
          priceAmount: priceEl?.getAttribute('data-price-amount') || '',
          img: imgEl?.src || imgEl?.getAttribute('data-src') || '',
          sku: skuEl?.textContent?.trim() || '',
        };
      }).filter(p => p.title);
    });

    console.log(`    Semicom "${categoryName}" עמוד ${pageNum}: ${items.length} מוצרים`);
    if (items.length === 0) break;

    for (const item of items) {
      const priceNum = Math.round(parseFloat(item.priceAmount) || 0); // מחיר ספק גולמי, בלי רווח
      products.push({
        title: item.title,
        price: priceNum ? `${priceNum} ₪` : '',
        priceNum,
        img: item.img,
        url: item.url,
        type: detectType(item.title),
        supplier: 'Semicom',
        brand: detectBrand(item.title),
        stock: 'זמין',
        category: categoryName,
        sku: item.sku,
        ...extractSpecs(item.title),
      });
    }

    const hasNext = await page.$('.pages a.action.next');
    hasMore = !!hasNext && items.length > 0;
    pageNum++;
    if (pageNum > 30) break; // הגנת לולאה אינסופית
    await sleep(1000);
  }

  return products;
}

async function scrapeSemicom(page) {
  console.log('🔍 Scraping Semicom (כל האתר, לפי קטגוריות)...');
  const allProducts = [];
  let categories = [];

  try {
    categories = await collectSemicomCategoryUrls(page);

    for (const cat of categories) {
      const catProducts = await scrapeSemicomCategory(page, cat.url, cat.name);
      allProducts.push(...catProducts);
      await sleep(800);
    }
  } catch (e) {
    console.error('  ❌ Semicom error:', e.message);
  }

  // דדופ: קודם לפי SKU, ואם אין - לפי שם+URL
  const seen = new Set();
  const unique = allProducts.filter(p => {
    const key = p.sku ? `sku:${p.sku}` : `${p.supplier}:${p.title}:${p.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  ✅ Semicom: ${unique.length} מוצרים ייחודיים מתוך ${categories.length} קטגוריות`);
  return unique;
}

// ══════════════════════════════════════════
// SCRAPER 6: CMS
// ══════════════════════════════════════════
async function scrapeCMS(page) {
  console.log('🔍 Scraping CMS...');
  console.log('  ⚠️ CMS: Protected by CAPTCHA — skipping');
  return [];
}


// ══════════════════════════════════════════
// SCRAPER 7: הראל (Hareli) — סריקת DOM לפי קטגוריה
//
// תיקון: היו כאן בעבר שתי פונקציות scrapeHareli באותו שם - גרסת ה-DOM
// (שכיסתה את כל הקטגוריות כולל 5017="מכשירים") וגרסת API ישיר
// (harelserver778.herokuapp.com, שמכסה רק "רמקולים ואוזניות" ו"סוללות").
// ב-JS ההגדרה השנייה "דורסת" את הראשונה בשקט - בפועל רק גרסת ה-API
// רצה כל הזמן, ולכן קטגוריית "מכשירים" (5017) מעולם לא הגיעה ל-KV.
// זו הפונקציה המאוחדת היחידה עכשיו - מבוססת DOM (מכסה גם 5017),
// עם תוספת מחיר קבועה של 400 ₪ לכל מוצר בקטגוריית "מכשירים" בלבד.
// ══════════════════════════════════════════
async function scrapeHareli(page) {
  console.log('🔍 Scraping Hareli...');
  const products = [];

  // תוספת מחיר קבועה לקטגוריית "מכשירים" (ID 5017) בלבד.
  // המחיר אצל הראל מוצג "כולל מע"מ" - לכן זו תוספת שקלית פשוטה,
  // בלי מכפיל מע"מ נוסף (בשונה מנוסחת Atomic/Lenovo).
  const HARELI_MACHINES_CATEGORY_ID = 5017;
  const HARELI_MACHINES_MARKUP = 400;

  try {
    // כל המוצרים נטענים ב-JS bundle — סורק קטגוריה קטגוריה
    const categoryIds = [5001,5002,5003,5004,5005,5006,5007,5008,5009,
                         5010,5011,5012,5013,5014,5017,5018,5030];

    for (const catId of categoryIds) {
      await page.goto(`https://catalog.hareli.co.il/products/${catId}`,
        { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(3000);

      // גלילה למטה עד שכמות המוצרים מתייצבת - תופס גם מוצרים ב-lazy load
      let lastCount = -1;
      let stableRounds = 0;
      for (let i = 0; i < 15 && stableRounds < 2; i++) {
        const count = await page.evaluate(() => document.querySelectorAll('.singleProduct').length);
        stableRounds = count === lastCount ? stableRounds + 1 : 0;
        lastCount = count;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(700);
      }

      const catItems = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('.singleProduct').forEach(card => {
          const spans = [...card.querySelectorAll('span')];
          const img = card.querySelector('img');

          // שם המוצר — span ראשון עם טקסט
          const nameSpan = spans.find(s => s.textContent.trim().length > 5
            && !s.textContent.includes('₪'));

          // מחיר — span עם מספר בלבד
          const priceSpan = spans.find(s => /^[\d,]+$/.test(s.textContent.trim()));

          // קטגוריה
          const catSpans = spans.filter(s => s.className.includes('border-bottom'));

          if (nameSpan) {
            results.push({
              title: nameSpan.textContent.trim(),
              price: priceSpan ? priceSpan.textContent.trim() : '',
              img: img ? img.src : '',
              category: catSpans[0]?.textContent?.trim() || '',
              subCategory: catSpans[1]?.textContent?.trim() || '',
            });
          }
        });
        return results;
      });

      console.log(`    Hareli cat ${catId}: ${catItems.length} products`);

      for (const item of catItems) {
        if (!item.title || item.title.length < 3) continue;
        let priceNum = parseInt(item.price.replace(/[^\d]/g,'')) || 0;

        // תוספת 400 ₪ רק למוצרים בקטגוריית "מכשירים" (5017)
        if (catId === HARELI_MACHINES_CATEGORY_ID && priceNum > 0) {
          priceNum += HARELI_MACHINES_MARKUP;
        }

        products.push({
          title: item.title,
          price: priceNum ? `${priceNum} ₪` : '',
          priceNum,
          img: item.img,
          url: `https://catalog.hareli.co.il/products/${catId}`,
          type: detectType(item.title),
          supplier: 'Hareli',
          brand: detectBrand(item.title),
          stock: 'זמין',
          category: item.category,
          subCategory: item.subCategory,
          ...extractSpecs(item.title),
        });
      }
      await sleep(1000);
    }
  } catch (e) {
    console.error('  ❌ Hareli error:', e.message);
  }

  console.log(`  ✅ Hareli: ${products.length} products`);
  return products;
}


async function saveToKV(newProducts) {
  console.log(`\n💾 Merging ${newProducts.length} scraped products with existing KV...`);
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE}/values`;
  const headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' };

  // Load existing products from KV (both parts)
  const [r1, r2] = await Promise.all([
    fetch(`${baseUrl}/catalog_1`, { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } }),
    fetch(`${baseUrl}/catalog_2`, { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } }),
  ]);
  const existing1 = r1.ok ? await r1.json() : [];
  const existing2 = r2.ok ? await r2.json() : [];
  const existing = [...existing1, ...existing2];
  console.log(`  Existing: ${existing.length} products`);

  // Which suppliers were scraped this run
  const scrapedSuppliers = [...new Set(newProducts.map(p => p.supplier))];
  console.log('  Scraped suppliers:', scrapedSuppliers);

  // Merge: update existing, mark missing as אזל
  const merged = existing.map(p => {
    // Only update stock for suppliers that were scraped
    if (!scrapedSuppliers.includes(p.supplier)) return p;

    const found = newProducts.find(np => np.title === p.title && np.supplier === p.supplier);
    if (found) {
      return { ...p, ...found }; // עדכן מחיר ומלאי
    } else {
      return { ...p, stock: 'אזל' }; // לא נמצא בסריקה = אזל
    }
  });

  // Add brand new products
  for (const np of newProducts) {
    const exists = merged.find(p => p.title === np.title && p.supplier === np.supplier);
    if (!exists) merged.push(np);
  }

  console.log(`  Merged: ${merged.length} products (${merged.filter(p=>p.stock==='אזל').length} אזל)`);

  // Split and save
  const mid = Math.ceil(merged.length / 2);
  const [s1, s2] = await Promise.all([
    fetch(`${baseUrl}/catalog_1`, { method:'PUT', headers, body: JSON.stringify(merged.slice(0, mid)) }),
    fetch(`${baseUrl}/catalog_2`, { method:'PUT', headers, body: JSON.stringify(merged.slice(mid)) }),
  ]);

  if (s1.ok && s2.ok) {
    console.log('✅ Saved to KV successfully');
  } else {
    throw new Error('KV save failed');
  }

  const meta = { lastUpdate: new Date().toISOString(), count: merged.length,
    bySupplier: merged.reduce((a,p) => { a[p.supplier]=(a[p.supplier]||0)+1; return a; }, {}) };
  await fetch(`${baseUrl}/catalog_meta`, { method:'PUT', headers, body: JSON.stringify(meta) });
  console.log('📊 Stats:', meta.bySupplier);
}


async function main() {
  console.log('🚀 Starting catalog scrape:', new Date().toLocaleString('he-IL'));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const allProducts = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    // Scrape each supplier
    const cdata = await scrapeCData(page);
    allProducts.push(...cdata);

    const morlevi = await scrapeMorelevi(page);
    allProducts.push(...morlevi);

    const amtel = await scrapeAmtel(page);
    allProducts.push(...amtel);

    const techno = await scrapeTechnoRezef(page);
    allProducts.push(...techno);

    const atomic = await scrapeAtomic(page);
    allProducts.push(...atomic);

    const semicom = await scrapeSemicom(page);
    allProducts.push(...semicom);

    const cms = await scrapeCMS(page);
    allProducts.push(...cms);

    const hareli = await scrapeHareli(page);
    allProducts.push(...hareli);

  } finally {
    await browser.close();
  }

  // Remove duplicates (by title+supplier)
  const seen = new Set();
  const unique = allProducts.filter(p => {
    const key = `${p.supplier}:${p.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n📦 Total unique products: ${unique.length}`);

  // Save to KV
  await saveToKV(unique);

  console.log('✅ Scrape complete!');
}

main().catch(e => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
