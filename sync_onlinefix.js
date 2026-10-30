const fs = require('fs');
const path = require('path');
let cheerio;
try {
  cheerio = require('cheerio');
} catch (_) {
  try {
    cheerio = require('E:/CharonTool/node_modules/cheerio');
  } catch (e) {
    throw new Error('cheerio is required');
  }
}

const ROMAN_TO_ARABIC = {
  'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5',
  'VI': '6', 'VII': '7', 'VIII': '8', 'IX': '9', 'X': '10'
};

function cleanTitle(str) {
  return String(str || '')
    .replace(/[™®©]/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\{.*?\}/g, '')
    .replace(/\s*по\s+сети.*$/i, '')
    .replace(/\s*po\s+seti.*$/i, '')
    .replace(/\s*online.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const normAlpha = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchSteamMap() {
  console.log('[Sync] Loading Steam games database for AppID resolution...');
  try {
    const ryuuRes = await fetchWithTimeout('https://generator.ryuu.lol/files/games.json', {}, 30000);
    const ryuuGames = await ryuuRes.json();
    const map = new Map();
    for (const g of ryuuGames) {
      if (!g.appid || !g.name) continue;
      const key = normAlpha(g.name);
      if (key && !map.has(key)) {
        map.set(key, { appid: String(g.appid), name: g.name });
      }
      const converted = g.name.replace(/\b(X|IX|VIII|VII|VI|V|IV|III|II|I)\b/gi, (m) => ROMAN_TO_ARABIC[m.toUpperCase()] || m);
      if (converted !== g.name) {
        const cKey = normAlpha(converted);
        if (cKey && !map.has(cKey)) {
          map.set(cKey, { appid: String(g.appid), name: g.name });
        }
      }
    }
    console.log(`[Sync] Loaded ${map.size} Steam title mappings.`);
    return map;
  } catch (err) {
    console.warn('[Sync] Could not fetch live Steam list:', err.message);
    return new Map();
  }
}

async function syncOnlineFixIndex() {
  const isFull = process.argv.includes('--full');
  const pagesToScan = isFull ? 69 : 3;

  const indexPath = path.join(__dirname, 'of_index.json');
  let indexData = {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalGames: 0,
    mappedAppIds: 0,
    by_appid: {},
    by_name: {}
  };

  if (fs.existsSync(indexPath)) {
    try {
      indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (_) {}
  }

  // Track existing games by online-fix article ID
  const existingArticleIds = new Set();
  for (const item of Object.values(indexData.by_appid || {})) {
    if (item.id) existingArticleIds.add(String(item.id));
  }
  for (const item of Object.values(indexData.by_name || {})) {
    if (item.id) existingArticleIds.add(String(item.id));
  }

  console.log(`[Sync] Current index has ${existingArticleIds.size} unique game articles.`);
  console.log(`[Sync] Crawling latest ${pagesToScan} page(s) of Online-Fix.me...`);

  const crawledGames = [];
  for (let page = 1; page <= pagesToScan; page++) {
    const url = page === 1 ? 'https://online-fix.me/games/' : `https://online-fix.me/games/page/${page}/`;
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }
      }, 15000);
      const buf = await res.arrayBuffer();
      const html = new TextDecoder('windows-1251').decode(buf);
      const $ = cheerio.load(html);

      $('.article').each((_, el) => {
        const titleLink = $(el).find('a[href*="/games/"]').filter((_, a) => {
          const text = $(a).text().trim();
          return text.length > 0 && !text.includes('comment') && !/^\d+$/.test(text);
        }).first();

        const href = titleLink.attr('href') || $(el).find('a.big-link').attr('href');
        const rawTitle = titleLink.text().trim();
        const img = $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || '';

        if (href && /\/games\/([^\/]+)\/(\d+)-([^\/]+)\.html/.test(href)) {
          const m = href.match(/\/games\/([^\/]+)\/(\d+)-([^\/]+)\.html/);
          const category = m[1];
          const id = m[2];
          const slug = m[3];
          const slugTitle = slug.replace(/-po-seti$/i, '').replace(/-/g, ' ');

          crawledGames.push({
            id,
            rawTitle,
            slugTitle,
            category,
            url: href,
            image: img.startsWith('http') ? img : (img ? `https://online-fix.me${img}` : '')
          });
        }
      });
    } catch (err) {
      console.warn(`[Sync] Failed fetching page ${page}:`, err.message);
    }
  }

  console.log(`[Sync] Fetched ${crawledGames.length} articles from pages 1-${pagesToScan}.`);

  // Detect newly added games
  const newGames = crawledGames.filter(g => !existingArticleIds.has(String(g.id)));

  if (newGames.length === 0 && !isFull) {
    console.log('[Sync] No new releases found. Index is already up to date!');
    return;
  }

  console.log(`[Sync] Found ${newGames.length} new game(s) to add to index.`);

  const steamMap = await fetchSteamMap();

  let newlyMappedCount = 0;
  for (const g of newGames) {
    const titleClean = cleanTitle(g.rawTitle || g.slugTitle);
    const slugClean = cleanTitle(g.slugTitle);

    let match = steamMap.get(normAlpha(titleClean)) || steamMap.get(normAlpha(slugClean));
    if (!match && titleClean.includes(':')) {
      match = steamMap.get(normAlpha(titleClean.split(':')[0].trim()));
    }
    if (!match && slugClean.includes(' ')) {
      const p = slugClean.split(' ')[0].trim();
      if (p.length > 5) match = steamMap.get(normAlpha(p));
    }

    const appid = match ? match.appid : null;
    const finalTitle = match ? match.name : (titleClean || g.slugTitle);

    const record = {
      id: g.id,
      title: finalTitle,
      originalTitle: g.rawTitle || g.slugTitle,
      url: g.url,
      category: g.category,
      image: g.image,
      appId: appid
    };

    if (appid) {
      indexData.by_appid[appid] = record;
      newlyMappedCount++;
    }

    const nameKey = titleClean.toLowerCase().trim();
    if (nameKey) indexData.by_name[nameKey] = record;
    const slugKey = slugClean.toLowerCase().trim();
    if (slugKey && slugKey !== nameKey) indexData.by_name[slugKey] = record;
  }

  indexData.generatedAt = new Date().toISOString();
  indexData.totalGames = Object.keys(indexData.by_name).length;
  indexData.mappedAppIds = Object.keys(indexData.by_appid).length;

  fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf8');

  console.log(`[Sync] Success! Added ${newGames.length} games (${newlyMappedCount} Steam AppIDs mapped).`);
  console.log(`[Sync] Index saved to ${indexPath} (Total: ${indexData.totalGames} titles, ${indexData.mappedAppIds} AppIDs)`);
}

syncOnlineFixIndex().catch(err => {
  console.error('[Sync] Fatal error:', err);
  process.exit(1);
});
