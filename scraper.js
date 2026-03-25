// ═══════════════════════════════════════════════════════════
// catalog-scraper — סורק יומי אוטומטי
// מסרוק 4 אתרי ספקים ומעדכן Cloudflare KV
// ═══════════════════════════════════════════════════════════

const puppeteer = require('puppeteer');
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
// SCRAPER 1: C-Data
// ══════════════════════════════════════════
async function scrapeCData(page) {
  console.log('🔍 Scraping C-Data...');
  const products = [];

  try {
    // Login
    await page.goto('https://reseller.c-data.co.il/Login', { waitUntil: 'networkidle2' });
    await page.type('#Email', process.env.SCRAPER_USER);
    await page.type('#Password', process.env.CDATA_PASS || '200480903');
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('  ✅ C-Data logged in');

    // Categories to scrape
    const categories = [
      { url: 'https://reseller.c-data.co.il/laptops', type: 'נייד' },
      { url: 'https://reseller.c-data.co.il/computerization', type: null },
    ];

    for (const cat of categories) {
      let page_num = 1;
      let has_more = true;

      while (has_more) {
        const url = page_num === 1 ? cat.url : `${cat.url}?page=${page_num}`;
        await page.goto(url, { waitUntil: 'networkidle2' });

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('.product-item')].map(el => ({
            title: el.querySelector('.product-title a')?.textContent?.trim() || '',
            price: el.querySelector('span.actual-price')?.textContent?.trim() || '',
            img: el.querySelector('img.product-image')?.src || '',
            url: el.querySelector('.product-title a')?.href || '',
            stock: el.querySelector('.stock span.value')?.className || '',
            sku: el.querySelector('.sku')?.textContent?.trim() || '',
          }));
        });

        for (const item of items) {
          if (!item.title) continue;
          const specs = extractSpecs(item.title);
          const stockClass = item.stock;
          const stock = stockClass.includes('green') ? 'זמין' :
                        stockClass.includes('red') ? 'אזל' : 'מלאי בדרך';

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

        // Check pagination
        const hasNext = await page.$('.pager .next-page, .pager a[rel="next"]');
        has_more = !!hasNext;
        page_num++;
        if (page_num > 10) break; // Safety limit
        await new Promise(r => setTimeout(r, 1000));
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
    // Login
    await page.goto('https://www.morlevi.co.il/Login', { waitUntil: 'networkidle2' });
    await page.type('input[type="email"], input[name="email"]', process.env.CDATA_USER || process.env.SCRAPER_USER);
    await page.type('input[type="password"]', process.env.MORLEVI_PASS || '20042004');
    await page.click('button[type="submit"], .login-btn');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('  ✅ Morlevi logged in');

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
        await sleep(1500);

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('.col-6.col-lg-3, .col-6.col-md-4')].map(el => ({
            title: el.querySelector('h2')?.textContent?.trim() || '',
            price: el.querySelector('.price, .product-price')?.textContent?.trim() || '',
            img: el.querySelector('img.img-fluid')?.src || '',
            url: el.querySelector('a')?.href || '',
            stock: el.querySelector('.stockMsg')?.className || '',
          }));
        });

        for (const item of items) {
          if (!item.title || item.title.includes('מק"ט')) continue;
          const specs = extractSpecs(item.title);
          const stock = item.stock.includes('green') ? 'זמין' :
                       item.stock.includes('red') ? 'אזל' : '';

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

        const hasNext = await page.$('nav a[aria-label="Next"]');
        has_more = !!hasNext;
        page_num++;
        if (page_num > 10) break;
        await new Promise(r => setTimeout(r, 1000));
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
    await page.goto('https://www.amtel.co.il/', { waitUntil: 'networkidle2' });

    // Find login
    const loginLink = await page.$('a[href*="login"], a[href*="account"]');
    if (loginLink) {
      await loginLink.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }

    await page.type('input[type="email"], input[name="email"]', process.env.CDATA_USER || process.env.SCRAPER_USER);
    await page.type('input[type="password"]', process.env.AMTEL_PASS || '2a525e');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('  ✅ Amtel logged in');

    // Scrape laptops category
    const catUrls = [
      'https://www.amtel.co.il/category/laptops',
      'https://www.amtel.co.il/category/computers',
    ];

    for (const catUrl of catUrls) {
      await page.goto(catUrl, { waitUntil: 'networkidle2' });
      await sleep(2000);

      const items = await page.evaluate(() => {
        return [...document.querySelectorAll('.product, .product-item, .product-card')].map(el => ({
          title: el.querySelector('h2, h3, .product-name, .product-title')?.textContent?.trim() || '',
          price: el.querySelector('.price, .product-price')?.textContent?.trim() || '',
          img: el.querySelector('img')?.src || '',
          url: el.querySelector('a')?.href || '',
          stock: el.querySelector('.stock, .availability')?.textContent?.trim() || '',
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
          type: detectType(item.title),
          supplier: 'Amtel',
          brand: detectBrand(item.title),
          stock: item.stock.includes('אזל') ? 'אזל' : 'זמין',
          ...specs,
        });
      }
    }
  } catch (e) {
    console.error('  ❌ Amtel error:', e.message);
  }

  console.log(`  ✅ Amtel: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// SCRAPER 4: Techno Rezef
// ══════════════════════════════════════════
async function scrapeTechnoRezef(page) {
  console.log('🔍 Scraping Techno Rezef...');
  const products = [];

  try {
    await page.goto('https://techno-rezef.com/wp-login.php', { waitUntil: 'networkidle2' });
    await page.type('#user_login', process.env.CDATA_USER || process.env.SCRAPER_USER);
    await page.type('#user_pass', process.env.TECHNO_PASS || '200480903');
    await page.click('#wp-submit');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('  ✅ Techno Rezef logged in');

    const categories = [
      'https://techno-rezef.com/product-category/laptops/',
      'https://techno-rezef.com/product-category/desktops/',
    ];

    for (const catUrl of categories) {
      let pageNum = 1;
      let hasMore = true;

      while (hasMore) {
        const url = pageNum === 1 ? catUrl : `${catUrl}page/${pageNum}/`;
        await page.goto(url, { waitUntil: 'networkidle2' });

        const items = await page.evaluate(() => {
          return [...document.querySelectorAll('.type-product, .product')].map(el => ({
            title: el.querySelector('h2, .woocommerce-loop-product__title')?.textContent?.trim() || '',
            price: el.querySelector('.price .amount, .woocommerce-Price-amount')?.textContent?.trim() || '',
            img: el.querySelector('img')?.src || '',
            url: el.querySelector('a')?.href || '',
            inStock: !el.classList.contains('outofstock'),
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
            type: detectType(item.title),
            supplier: 'Techno-Rezef',
            brand: detectBrand(item.title),
            stock: item.inStock ? 'זמין' : 'אזל',
            ...specs,
          });
        }

        const hasNext = await page.$('.woocommerce-pagination .next, .next.page-numbers');
        hasMore = !!hasNext;
        pageNum++;
        if (pageNum > 35) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (e) {
    console.error('  ❌ Techno Rezef error:', e.message);
  }

  console.log(`  ✅ Techno Rezef: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// שמירה ב-Cloudflare KV
// ══════════════════════════════════════════
async function saveToKV(products) {
  console.log(`\n💾 Saving ${products.length} products to Cloudflare KV...`);

  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE}/values/catalog`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(products),
  });

  if (res.ok) {
    console.log('✅ Saved to KV successfully');
  } else {
    const err = await res.text();
    throw new Error(`KV save failed: ${err}`);
  }

  // Also save metadata
  const meta = {
    lastUpdate: new Date().toISOString(),
    count: products.length,
    bySupplier: products.reduce((acc, p) => {
      acc[p.supplier] = (acc[p.supplier] || 0) + 1;
      return acc;
    }, {}),
  };

  await fetch(url.replace('/catalog', '/catalog_meta'), {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });

  console.log('📊 Stats:', meta.bySupplier);
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
      let loadMore = true;
      while (loadMore) {
        const btn = await page.$('button:contains("טען עוד"), button:contains("Load more")');
        if (!btn) break;
        await btn.click();
        await sleep(2000);
        const stillHas = await page.$('button:contains("טען עוד"), button:contains("Load more")');
        loadMore = !!stillHas;
      }

      const items = await page.evaluate(() => {
        return [...document.querySelectorAll('a[href*="/products/"]')].map(el => ({
          title: el.querySelector('p.line-clamp-3, p.font-medium')?.textContent?.trim() || '',
          price: el.querySelector('span.text-\[14px\]')?.textContent?.trim() || '',
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
// SCRAPER 6: CMS
// ══════════════════════════════════════════
async function scrapeCMS(page) {
  console.log('🔍 Scraping CMS...');
  const products = [];

  try {
    await page.goto('https://cms.co.il/wp-login.php', { waitUntil: 'networkidle2' });
    await sleep(2000);
    await page.evaluate((user, pass) => {
      const u = document.querySelector('#user_login') || document.querySelector('input[name="log"]');
      const p = document.querySelector('#user_pass') || document.querySelector('input[name="pwd"]');
      if (u) u.value = user;
      if (p) p.value = pass;
    }, process.env.SCRAPER_USER || '', process.env.CMS_PASS || '');
    const cBtn = await page.$('#wp-submit') || await page.$('input[type="submit"]');
    if (cBtn) { await cBtn.click(); await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{}); }
    console.log('  ✅ CMS logged in');

    const categories = [
      { url: 'https://cms.co.il/product-category/laptop-pc/', type: 'נייד' },
      { url: 'https://cms.co.il/product-category/desktop-pc/', type: 'נייח' },
      { url: 'https://cms.co.il/product-category/all-in-one/', type: 'AIO' },
    ];

    for (const cat of categories) {
      let pageNum = 1;
      let hasMore = true;

      while (hasMore) {
        const url = pageNum === 1 ? cat.url : `${cat.url}page/${pageNum}/`;
        await page.goto(url, { waitUntil: 'networkidle2' });

        const items = await page.evaluate(() => {
          const cards = document.querySelectorAll('.type-product, .electron-loop-product, li.product');
          return [...cards].map(el => ({
            title: el.querySelector('.woocommerce-loop-product__title, h2, h3')?.textContent?.trim() || '',
            price: el.querySelector('.woocommerce-Price-amount, .price')?.textContent?.trim() || '',
            img: el.querySelector('img')?.src || '',
            url: el.querySelector('a')?.href || '',
            inStock: !el.classList.contains('outofstock'),
          })).filter(p => p.title);
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
            supplier: 'CMS',
            brand: detectBrand(item.title),
            stock: item.inStock ? 'זמין' : 'אזל',
            ...specs,
          });
        }

        const hasNext = await page.$('.next.page-numbers');
        hasMore = !!hasNext;
        pageNum++;
        if (pageNum > 35) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (e) {
    console.error('  ❌ CMS error:', e.message);
  }

  console.log(`  ✅ CMS: ${products.length} products`);
  return products;
}

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════
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

    const cms = await scrapeCMS(page);
    allProducts.push(...cms);

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
