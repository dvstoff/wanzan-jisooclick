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
    url: "https://cn.ktown4u.com/eventinfo?eve_no=44509156&biz_no=599",
    itemIds: ["set2cd", "photobook", "nfc", "vinyl"],
    parse: parseKtown4uChina,
    countPattern: /售销记录/,
    scrollToLoad: true,
  },
  {
    id: "ktown4u_stardust",
    url: "https://cn.ktown4u.com/eventinfo?eve_no=44509161&biz_no=599",
    itemIds: ["set2cd", "vinyl", "nfc", "photobook"],
    parse: parseKtown4uChina,
    countPattern: /售销记录/,
    scrollToLoad: true,
  },
  {
    id: "yetimall_echo",
    url: "https://m.yetimall.store/h5/#/goods?gid=32426",
    itemIds: ["main"],
    parse: parseYetimall,
    retry: true,
  },
  {
    id: "yetimall_stardust",
    url: "https://m.yetimall.store/h5/#/goods?gid=32425",
    itemIds: ["main"],
    parse: parseYetimall,
    retry: true,
  },
  {
    id: "namilmarket_main",
    url: "https://www.namilmarket.com/2608jslz0825-2",
    itemIds: ["main"],
    parse: parseNamilmarket,
  },
  {
    id: "ktown4u_jp",
    url: "https://jp.ktown4u.com/eventinfo?eve_no=42960704&biz_no=783",
    itemIds: ["photobook", "nfc", "vinyl"],
    parse: parseKtown4uJapan,
    countPattern: /注文履歴/,
    scrollToLoad: true,
  },
];

// Ktown4u China: item cards read "...\nRMB123.00\n售销记录 1,234" in document order,
// matching each channel's declared itemIds order (2CD/Vinyl/NFC/Photobook order
// differs between the two China group-buy pages, hence itemIds per channel above).
function parseKtown4uChina(text, itemIds) {
  const matches = [...text.matchAll(/售销记录\s*([\d,]+)/g)].map((m) => parseInt(m[1].replace(/,/g, ""), 10));
  return matchInOrder(itemIds, matches);
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
    try {
      // networkidle never resolves on these pages (continuous analytics beacons),
      // so we wait for DOM content only, then poll for the actual data ourselves.
      await page.goto(channel.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (channel.scrollToLoad) {
        // ktown4u lazy-loads its sale-count widget via IntersectionObserver as the
        // goods list scrolls into view — step down incrementally rather than jumping,
        // since a single scrollTo(bottom) doesn't reliably fire the observer
        for (let y = 250; y <= 2500; y += 250) {
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          await page.waitForTimeout(300);
        }
      }
      if (channel.countPattern) {
        await page.waitForFunction(
          (src) => new RegExp(src).test(document.body.innerText),
          channel.countPattern.source,
          { timeout: 12000 }
        ).catch(() => {});
      }
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
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
      console.log(`  [diag] ${channel.id} body snippet: "${flatText.slice(0, 200)}"`);
      if (/访问限制|异常流量|检测到.*可疑|blocked|forbidden/i.test(text)) {
        console.log(`  [diag] ${channel.id} looks like an access-restriction page`);
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
  const browser = await chromium.launch();
  const values = {};
  const failed = [];
  try {
    for (const channel of CHANNELS) {
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

  console.log(`\nWrote batch with ${Object.keys(values).length}/${CHANNELS.length} channels.`);
  if (failed.length) console.log(`Channels missing this run: ${failed.join(", ")}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
