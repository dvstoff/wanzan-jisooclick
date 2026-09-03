// Hourly scraper for the wanzan JISOO CLICK sales tracker.
// Visits every configured channel with a real (headless) browser — several of
// these sites render their sale counters client-side via JS/GraphQL, so a plain
// HTTP fetch is not enough. Extracts one number per item, assembles a "batch"
// (one shared timestamp across every channel), and appends it to data.json.
//
// Usage: node scripts/scrape.js
// Requires: npm install (installs the `playwright` package) + `npx playwright install chromium`

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DATA_PATH = path.join(__dirname, "..", "data.json");

// ---- channel definitions: how to reach each page and how to read its numbers ----
// `parse(text)` receives the page's plain text content and must return an object
// keyed by item id -> raw integer count (or null if it couldn't find a real number).
const CHANNELS = [
  {
    id: "ktown4u_echo",
    platform: "ktown4u",
    url: "https://cn.ktown4u.com/eventinfo?eve_no=44509156&biz_no=599",
    itemIds: ["set2cd", "photobook", "nfc", "vinyl"],
    parse: parseKtown4uChina,
    countPattern: /售销记录/,
    scrollToLoad: true,
    watchGraphql: true,
    retry: true,
  },
  {
    id: "ktown4u_stardust",
    platform: "ktown4u",
    url: "https://cn.ktown4u.com/eventinfo?eve_no=44509161&biz_no=599",
    itemIds: ["set2cd", "vinyl", "nfc", "photobook"],
    parse: parseKtown4uChina,
    countPattern: /售销记录/,
    scrollToLoad: true,
    watchGraphql: true,
    retry: true,
  },
  {
    id: "yetimall_echo",
    platform: "other",
    url: "https://m.yetimall.store/h5/#/goods?gid=32426",
    itemIds: ["main"],
    parse: parseYetimall,
    retry: true,
  },
  {
    id: "yetimall_stardust",
    platform: "other",
    url: "https://m.yetimall.store/h5/#/goods?gid=32425",
    itemIds: ["main"],
    parse: parseYetimall,
    retry: true,
  },
  {
    id: "namilmarket_main",
    platform: "other",
    url: "https://www.namilmarket.com/2608jslz0825-2",
    itemIds: ["main"],
    parse: parseNamilmarket,
    retry: true,
  },
  {
    id: "ktown4u_jp",
    platform: "ktown4u",
    url: "https://jp.ktown4u.com/eventinfo?eve_no=42960704&biz_no=783",
    itemIds: ["photobook", "nfc", "vinyl"],
    parse: parseKtown4uJapan,
    countPattern: /注文履歴/,
    scrollToLoad: true,
    watchGraphql: true,
    retry: true,
  },
  {
    id: "ktown4u_heifen",
    platform: "ktown4u",
    url: "https://cn.ktown4u.com/eventinfo?eve_no=44511290&biz_no=599",
    itemIds: ["set2cd", "vinyl", "nfc", "photobook"],
    parse: parseKtown4uChina,
    countPattern: /售销记录/,
    scrollToLoad: true,
    watchGraphql: true,
    retry: true,
  },
  {
    id: "yetimall_heifen",
    platform: "other",
    url: "https://m.yetimall.store/h5/#/goods?gid=32423",
    itemIds: ["main"],
    parse: parseYetimall,
    retry: true,
  },
  {
    id: "ktown4u_bp",
    platform: "ktown4u",
    url: "https://cn.ktown4u.com/eventinfo?eve_no=44511274&biz_no=599",
    itemIds: ["set2cd", "photobook", "nfc", "vinyl"],
    parse: parseKtown4uChina,
    countPattern: /售销记录/,
    scrollToLoad: true,
    watchGraphql: true,
    retry: true,
  },
  {
    id: "yetimall_bp",
    platform: "other",
    url: "https://m.yetimall.store/h5/#/goods?gid=32424",
    itemIds: ["main"],
    parse: parseYetimall,
    retry: true,
  },
  {
    id: "yetimall_featured",
    platform: "other",
    url: "https://m.yetimall.store/h5/#/goods?gid=32422",
    itemIds: ["main"],
    parse: parseYetimall,
    retry: true,
  },
];

// CLI filter: `node scripts/scrape.js --only=ktown4u` runs just those channels.
// Lets ktown4u run on its own tighter schedule without touching the reliable
// hourly run for the other channels.
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY_PLATFORM = onlyArg ? onlyArg.split("=")[1] : null;

// Ktown4u China: used to just take the Nth "售销记录 N" match in document order and
// assign it to the Nth itemId — worked until Ktown4u started listing extra variants
// alongside the 4 real ones (a discounted "补贴专" tier, a "拆卡专" card-pull version,
// "定金-补款" deposit/final-payment splits), each with its own "售销记录" counter. Those
// extra counters shifted every position by one, silently mislabeling every item's count
// (caught 2026-09-03 ~13:00 KST — the site's total dropped ~22k because ktown4u_echo's
// set2cd count got replaced by an unrelated variant's much smaller number).
// Fixed by anchoring on the "[全款 裸专]" (full-payment, bare-album) tag that only the
// 4 real listings carry, plus a keyword unique to each one, then reading the very next
// "售销记录" after that — order-independent, and immune to extra variants being
// inserted anywhere on the page.
const KTOWN4U_ITEM_KEYWORDS = {
  set2cd: "2CD 套装",
  // the "] " prefix matters: the 2CD combo's own name also contains the bare phrases
  // "PHOTOBOOK VER." / "BABY BEAR NFC VER." (as part of "...NFC VER.+PHOTOBOOK VER.)"),
  // so without it those keywords would match inside the 2CD card instead of skipping past it
  photobook: "] PHOTOBOOK VER.",
  nfc: "] CLICK BABY BEAR NFC VER.",
  vinyl: "Vinyl Ver.",
};
function parseKtown4uChina(text, itemIds) {
  const out = {};
  itemIds.forEach((id) => {
    const kw = KTOWN4U_ITEM_KEYWORDS[id];
    if (!kw) { out[id] = null; return; }
    const kwEsc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cardRe = new RegExp("\\[全款\\s*裸专\\][\\s\\S]{0,200}?" + kwEsc + "[\\s\\S]{0,200}?售销记录\\s*([\\d,]+)", "i");
    const m = text.match(cardRe);
    out[id] = m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  });
  return out;
}

// Ktown4u Japan: same idea, label is "注文履歴".
function parseKtown4uJapan(text, itemIds) {
  const matches = [...text.matchAll(/注文履歴\s*([\d,]+)/g)].map((m) => parseInt(m[1].replace(/,/g, ""), 10));
  return matchInOrder(itemIds, matches);
}

// Yetimall: single "已售NNN件" counter. The page is known to be slow and often
// shows a "已售0件" placeholder before the real number loads — caller retries.
function parseYetimall(text, itemIds) {
  const m = text.match(/已售\s*([\d,]+)\s*件/);
  const n = m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  return { [itemIds[0]]: n && n > 0 ? n : null };
}

// Namilmarket: "已 售： N" (traditional server-rendered page, loads fast/reliably).
function parseNamilmarket(text, itemIds) {
  const m = text.match(/已\s*售\s*[:：]\s*([\d,]+)/);
  const n = m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  return { [itemIds[0]]: n };
}

function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }

function matchInOrder(itemIds, numbers) {
  const out = {};
  itemIds.forEach((id, i) => { out[id] = Number.isFinite(numbers[i]) ? numbers[i] : null; });
  return out;
}

async function scrapeChannel(browser, channel) {
  const maxAttempts = channel.retry ? 6 : 2;
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // locale matters: without it these sites can render an English build where the
    // Chinese "售销记录"/"已售...件" labels we match on never appear
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    });
    // Read straight from ktown4u's own API response instead of scraped DOM text —
    // more robust than text-matching, since the number can arrive before the text
    // label finishes re-rendering (seen on the Japan page: the API call succeeds
    // but "注文履歴" hadn't painted yet when we checked innerText).
    const apiCalls = [];
    const salesFromApi = [];
    if (channel.watchGraphql) {
      page.on("response", async (res) => {
        if (!res.url().includes("graphql")) return;
        let json = null;
        let bodySnippet = "";
        try {
          json = await res.json();
          bodySnippet = JSON.stringify(json).replace(/\s+/g, " ").slice(0, 150);
        } catch (e) { /* non-JSON or already consumed */ }
        apiCalls.push({ url: res.url().split("?")[0], status: res.status(), body: bodySnippet });
        const sales = json && json.data && json.data.fanClubProductSales && json.data.fanClubProductSales.sales;
        if (Number.isFinite(sales)) salesFromApi.push(sales);
      });
    }
    try {
      // networkidle never resolves on these pages (continuous analytics beacons),
      // so we wait for DOM content only, then poll for the actual data ourselves.
      await page.goto(channel.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (channel.scrollToLoad) {
        // Two-stage load: fanClubEventProductsV2 fetches the product list first (fast),
        // then each rendered product CARD independently fetches its own sale count
        // (fanClubProductSales) once *that specific card* scrolls into view. Scrolling
        // before the cards exist in the DOM triggers nothing, so wait for a real price
        // to appear — proof the cards have mounted — before scrolling. China pages price
        // in RMB, Japan in ¥ — matching only "RMB" meant this wait silently timed out
        // on every ktown4u_jp attempt (¥ never matches /RMB/), so scrolling started
        // before the cards existed and never picked anything up — same failure shape as
        // fanClubProductSales quietly returning real numbers while document.body.innerText
        // never grows past the boilerplate terms text, attempt after attempt.
        await page.waitForFunction(
          () => /RMB\s*[\d.]+|¥\s*[\d,]+/.test(document.body.innerText),
          { timeout: 10000 }
        ).catch(() => {});
        // move the mouse across the page first — a page that's only ever been
        // scrolled programmatically, never pointed at, is itself a bot tell
        await page.mouse.move(200 + rand(0, 100), 200 + rand(0, 100));
        await page.mouse.move(600 + rand(0, 200), 400 + rand(0, 150), { steps: rand(8, 20) });
        // Ceiling used to be a fixed 3000px, sized for the original two China event
        // pages. Newer events (added fan stations, the Japan page) carry noticeably more
        // terms-and-conditions text above the product grid, so a fixed 3000px stopped
        // short of the cards entirely — same symptom as above: fanClubProductSales came
        // back with real numbers, but the cards' own text never rendered because they
        // were never scrolled into view in the first place.
        // A single scrollHeight read *before* scrolling starts isn't enough either — on
        // 职业黑粉操盘手吧/BLACKPINK吧官博 specifically, the page still measured a short
        // scrollHeight at that point (product grid not mounted yet) and every attempt
        // scrolled to that same too-low ceiling and stopped, body text frozen the whole
        // time. Re-read scrollHeight periodically *while* scrolling instead, so the
        // ceiling grows once the grid actually mounts further down than the page
        // initially reported.
        let y = 250;
        let scrollCeiling = await page.evaluate(() => document.body.scrollHeight).catch(() => 3000);
        for (let i = 0; y <= scrollCeiling && i < 60; i++) {
          await page.mouse.wheel(0, rand(140, 260));
          await page.waitForTimeout(rand(220, 480));
          y += 200;
          if (i % 4 === 3) {
            scrollCeiling = await page.evaluate(() => document.body.scrollHeight).catch(() => scrollCeiling);
          }
        }
        // settle near the bottom, then sweep back up slowly — some cards' observers
        // only fire on the way past a second time
        await page.waitForTimeout(rand(400, 900));
        for (let i = 0; i < 12; i++) {
          await page.mouse.wheel(0, -rand(180, 320));
          await page.waitForTimeout(rand(180, 400));
        }
        // Belt-and-suspenders for 职业黑粉操盘手吧/BLACKPINK吧官博 specifically: even
        // with the fixes above, plain wheel-scrolling never got every card's real text
        // to render on these two — body text stayed frozen across every attempt despite
        // scrollTop genuinely moving. Rather than keep hoping continuous scrolling
        // sweeps over each card, scroll every price element into view directly via
        // Playwright's own scrollIntoViewIfNeeded (goes through CDP, not a synthesized
        // wheel event) — deterministic per-card instead of relying on scroll coverage.
        try {
          const priceLocators = await page.locator("text=/^(RMB|¥)$/").all();
          for (const loc of priceLocators) {
            await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(rand(300, 600));
          }
        } catch (e) { /* best-effort, never fatal to the attempt */ }
      }
      if (channel.watchGraphql) {
        // the exact call that carries sale counts, confirmed by manual inspection earlier
        await page.waitForResponse((res) => res.url().includes("operationName=fanClubProductSales"), { timeout: 15000 }).catch(() => {});
        // one call per product card — give the rest a moment to land too
        for (let i = 0; i < 10 && salesFromApi.length < channel.itemIds.length; i++) {
          await page.waitForTimeout(400);
        }
      }
      if (channel.countPattern) {
        await page.waitForFunction(
          (src) => new RegExp(src).test(document.body.innerText),
          channel.countPattern.source,
          { timeout: 8000 }
        ).catch(() => {});
      }
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => document.body.innerText);
      // DOM text order was verified correct across repeated runs (NFC always > Vinyl,
      // as expected). The API responses arrive in non-deterministic order per request —
      // matching them by arrival order silently swapped NFC/Vinyl between two otherwise-
      // identical runs, so API values are diagnostic-only here, never authoritative.
      const result = channel.parse(text, channel.itemIds);
      const values = Object.values(result);
      const complete = values.length > 0 && values.every((v) => v !== null && v !== undefined);
      lastResult = result;
      if (complete) {
        console.log(`  [ok] ${channel.id} (attempt ${attempt}):`, JSON.stringify(result));
        return result;
      }
      console.log(`  [retry] ${channel.id} attempt ${attempt} incomplete:`, JSON.stringify(result));
      // diagnostic: show what the page actually contains when parsing comes up empty,
      // so failures can be told apart (rate-limit notice vs. genuinely different markup vs. blank page)
      const flatText = text.replace(/\s+/g, " ").trim();
      console.log(`  [diag] ${channel.id} body length: ${text.length}, snippet: "${flatText.slice(0, 200)}"`);
      if (/访问限制|异常流量|检测到.*可疑|blocked|forbidden/i.test(text)) {
        console.log(`  [diag] ${channel.id} looks like an access-restriction page`);
      }
      if (channel.watchGraphql) {
        console.log(`  [diag] ${channel.id} graphql calls seen: ${apiCalls.length}, sales values captured: ${JSON.stringify(salesFromApi)}`);
        apiCalls.forEach((c, i) => console.log(`    #${i + 1} ${c.status} ${c.url} :: ${c.body}`));
      }
    } catch (err) {
      console.log(`  [error] ${channel.id} attempt ${attempt}: ${err.message}`);
    } finally {
      await page.close();
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(`  [give up] ${channel.id}: keeping best partial result`, JSON.stringify(lastResult));
  return lastResult;
}

async function main() {
  // ktown4u's sale-count widget appears to withhold data from headless browsers
  // (navigator.webdriver === true is a dead giveaway). Running headed — real Chrome,
  // real rendering pipeline — presents like an actual browser instead. On CI this
  // needs a virtual display (see the "xvfb-run" wrapper in the workflow); locally,
  // headed just opens a real window.
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const values = {};
  const failed = [];
  const targets = ONLY_PLATFORM ? CHANNELS.filter((c) => c.platform === ONLY_PLATFORM) : CHANNELS;
  if (ONLY_PLATFORM) console.log(`Filtering to platform="${ONLY_PLATFORM}": ${targets.map((c) => c.id).join(", ")}`);
  try {
    for (const channel of targets) {
      console.log(`Scraping ${channel.id} ...`);
      const result = await scrapeChannel(browser, channel);
      const ok = result && Object.values(result).every((v) => v !== null && v !== undefined);
      if (ok) {
        values[channel.id] = result;
      } else {
        failed.push(channel.id);
        console.log(`  [skip] ${channel.id} — no complete reading this run, omitted from this batch`);
      }
    }
  } finally {
    await browser.close();
  }

  if (Object.keys(values).length === 0) {
    console.error("No channel produced a usable reading this run — not writing a batch.");
    process.exit(1);
  }

  const data = fs.existsSync(DATA_PATH) ? JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) : { batches: [] };
  data.batches.push({ ts: new Date().toISOString(), values });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");

  console.log(`\nWrote batch with ${Object.keys(values).length}/${targets.length} channels.`);
  if (failed.length) console.log(`Channels missing this run: ${failed.join(", ")}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
