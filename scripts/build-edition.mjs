#!/usr/bin/env node
/*
 * Builds today's edition of The Daily Fill-In.
 *
 *  1. Pulls English headlines from NewsData.io, by category, and keeps the ones published
 *     yesterday (Eastern time). Today's edition = yesterday's news.
 *  2. Throws out headlines that make a bad game (deaths, crime, live blogs, deals, etc.).
 *  3. Picks a varied set (different outlets, different stories).
 *  4. Splits each headline into an opening ("lead") and the real ending ("rest"),
 *     and writes three wrong endings ("decoys").
 *       - With ANTHROPIC_API_KEY set, Claude does the split and writes the decoys.
 *       - Without it (or if Claude fails), a simple splitter runs and decoys are
 *         endings borrowed from other headlines in today's feed.
 *  5. Writes site/edition.json and an archive copy in site/editions/YYYY-MM-DD.json.
 *
 * Usage:
 *   NEWSDATA_API_KEY=... [ANTHROPIC_API_KEY=...] node scripts/build-edition.mjs
 * Test options:
 *   --mock <newsdata.json>      read articles from a saved NewsData response instead of the API
 *   --claude-mock <reply.json>  use a saved Claude reply instead of calling the API
 *   --out <file.json>           write only this file (no archive copy)
 *   --date YYYY-MM-DD           build the edition for this date
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- Settings you may want to change ---------- */
const CONFIG = {
  headlinesPerEdition: 7,
  minHeadlines: 5,                 // fewer than this and the build fails, keeping yesterday's edition live
  secondsPerHeadline: 20,
  launchDate: "2026-11-15",        // the date of edition No. 1
  timeZone: "America/New_York",    // decides what "today" means
  language: "en",
  country: "us",                   // up to 5, comma-separated, e.g. "us,gb,ca"
  prioritydomain: "top",           // "top" = only NewsData's highest-ranked outlets
  // NewsData requests per category, in order of preference for the edition.
  categories: ["world", "business", "technology", "science", "sports", "entertainment", "top", "health", "politics"],
  // Pages of 10 articles per category, to reach back through all of yesterday.
  // 9 categories x 2 pages = up to 18 credits a day (free plan: 200 a day, 30 per 15 minutes).
  pagesPerCategory: 2,
  // Each edition uses news published this many days before the edition date (1 = yesterday).
  newsDaysBack: 1,
  minWords: 6,
  maxWords: 16,
  maxChars: 120,
  candidatesForClaude: 14,         // send a few extra so Claude can reject weak ones
  claudeModel: process.env.CLAUDE_MODEL || "claude-haiku-5-5",
};

const SECTION_LABELS = {
  world: "World", business: "Business", technology: "Tech", science: "Science", sports: "Sports",
  entertainment: "Entertainment", top: "Top story", health: "Health", politics: "Politics",
  environment: "Environment", education: "Education", lifestyle: "Lifestyle", food: "Food", tourism: "Travel",
  domestic: "National",
};

// Headlines about these topics make a poor game, so they are skipped.
const SENSITIVE = /\b(kill(s|ed|ing|er|ers)?|dead|dies|died|death|deaths|deadly|murder\w*|homicide|shoot(s|ing|ings|er)?|shot|gunman|stab\w*|rape\w*|sexual\w*|abuse\w*|abusing|suicide|overdose\w*|massacre\w*|terror\w*|hostage\w*|bomb(s|ing|ings|ed)?|explosion|victim\w*|funeral|obituar\w*|mourn\w*|tragic|tragedy|fatal\w*|assault\w*|arrest\w*|charged|convicted|sentenced|jailed|prison|manslaughter|kidnap\w*|missing (girl|boy|child|teen|woman|man)|genocide|war crimes?|corpse|body found|remains found)\b/i;
// Formats that aren't real headlines or can't be guessed.
const JUNK = /(^|\s)(live:|live updates|live blog|watch:|video:|photos?:|quiz:|opinion:|analysis:|podcast:|review:|horoscope|wordle|connections hint|crossword|strands hint|lottery|powerball|mega millions|promo code|coupon|% off|\bdeals\b|on sale|how to watch|where to watch|what time is|tv channel|live stream|livestream|newsletter|today in history|word of the day)/i;
const STOP = new Set("a an the of for in on at to by with and or is are was were be been it its as from that this do does we our you your they their how here into over after than up out but not has have had will can so says said".split(" "));
const BREAK_BEFORE = new Set("to for in on at with as after over amid by from into against about despite while than and but before during under without since until across toward towards near says said warns urges".split(" "));

/* ---------- Small helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const argValue = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
const alnum = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const words = s => s.trim().split(/\s+/).filter(Boolean);

function cleanTitle(raw, sourceName, sourceId) {
  let t = decodeEntities(String(raw || "")).replace(/\s+/g, " ").trim();
  // Drop a trailing " - Outlet" / " | Outlet" tag.
  const m = t.match(/^(.*\S)\s+[-|–—:]\s+([^-|–—]{2,48})$/);
  if (m) {
    const tail = alnum(m[2]);
    const names = [alnum(sourceName || ""), alnum(sourceId || "")].filter(Boolean);
    if (tail && names.some(n => n.includes(tail) || tail.includes(n))) t = m[1];
  }
  return t;
}

function isUsable(title) {
  if (!title) return false;
  const w = words(title);
  if (w.length < CONFIG.minWords || w.length > CONFIG.maxWords) return false;
  if (title.length > CONFIG.maxChars) return false;
  if (SENSITIVE.test(title) || JUNK.test(title)) return false;
  if (/[|]/.test(title)) return false;
  const letters = title.replace(/[^A-Za-z]/g, "");
  if (letters.length < 15) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  if (upper / letters.length > 0.6) return false; // ALL CAPS
  if (/[^\x00-ɏ‘-‟–—…]/.test(title)) return false; // non-Latin scripts, emoji
  return true;
}

function sigWords(s) {
  return new Set(words(s.toLowerCase()).map(w => w.replace(/[^a-z0-9]/g, "")).filter(w => w.length >= 4 && !STOP.has(w)));
}
function similar(a, b) {
  const A = sigWords(a), B = sigWords(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.4;
}

function isTitleCase(s) {
  const w = words(s).filter(x => /^[A-Za-z]/.test(x) && x.replace(/[^A-Za-z]/g, "").length > 3);
  if (!w.length) return false;
  return w.filter(x => /^[A-Z]/.test(x)).length / w.length >= 0.7;
}

function dateParts(d, timeZone) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(d);
  const shortDate = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(d);
  return { key, dateLabel, shortDate };
}
// NewsData pubDate is "YYYY-MM-DD HH:MM:SS" in UTC unless a timezone was requested.
function parsePubDate(pubDate) {
  if (!pubDate) return null;
  const d = new Date(String(pubDate).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(pubDate) ? "" : "Z"));
  return isNaN(d) ? null : d;
}
function shortDay(pubDate, timeZone) {
  const d = parsePubDate(pubDate);
  return d ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d) : "";
}
function dayKey(pubDate, timeZone) {
  const d = parsePubDate(pubDate);
  return d ? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : "";
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}
function shiftKey(key, days) {
  return new Date(Date.parse(key + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

/* ---------- 1. Fetch ---------- */
async function requestNewsData(apiKey, params, label) {
  const url = `https://newsdata.io/api/1/latest?${params}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res, body;
    try {
      res = await fetch(url, { headers: { "X-ACCESS-KEY": apiKey, Accept: "application/json" } });
      body = await res.json().catch(() => null);
    } catch (err) {
      console.warn(`NewsData ${label}: network error ${err.message}`);
      await sleep(3000);
      continue;
    }
    if (res.ok && body?.status === "success" && Array.isArray(body.results)) return body;
    const msg = body?.results?.message || res.statusText;
    console.warn(`NewsData ${label}: HTTP ${res.status} ${body?.results?.code || ""} ${msg}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`NewsData.io refused the request (${body?.results?.code || res.status}: ${msg}). Check NEWSDATA_API_KEY.`);
    }
    if ([400, 422, 429].includes(res.status)) break; // retrying soon won't help
    await sleep(3000);
  }
  return null;
}

// Results come newest first, so keep paging until we're past the start of the news day.
async function fetchCategory(apiKey, category, newsKey) {
  const out = [];
  let page = null;
  for (let p = 1; p <= CONFIG.pagesPerCategory; p++) {
    const params = new URLSearchParams({
      language: CONFIG.language, country: CONFIG.country, category,
      prioritydomain: CONFIG.prioritydomain, removeduplicate: "1", size: "10",
    });
    if (page) params.set("page", page);
    const body = await requestNewsData(apiKey, params, `${category} p${p}`);
    if (!body || !body.results.length) break;
    out.push(...body.results.map(a => ({ ...a, _category: category })));
    page = body.nextPage;
    const oldest = dayKey(body.results[body.results.length - 1].pubDate, CONFIG.timeZone);
    if (!page || (oldest && oldest < newsKey)) break;
    await sleep(400);
  }
  return out;
}

async function loadArticles(newsKey) {
  const mock = argValue("--mock");
  if (mock) {
    const body = JSON.parse(await readFile(mock, "utf8"));
    return (body.results || body).map(a => ({ ...a, _category: a._category || (a.category || ["top"])[0] }));
  }
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) throw new Error("NEWSDATA_API_KEY is not set. Add it as an environment variable or repository secret.");
  const all = [];
  for (const cat of CONFIG.categories) {
    all.push(...await fetchCategory(apiKey, cat, newsKey));
    await sleep(400);
  }
  return all;
}

/* ---------- 2–3. Filter and pick ---------- */
function toCandidates(articles) {
  const seenIds = new Set();
  const out = [];
  for (const a of articles) {
    if (!a || seenIds.has(a.article_id)) continue;
    seenIds.add(a.article_id);
    if (a.duplicate === true) continue;
    const title = cleanTitle(a.title, a.source_name, a.source_id);
    if (!isUsable(title) || !a.link) continue;
    out.push({
      id: a.article_id,
      title,
      category: a._category,
      section: SECTION_LABELS[a._category] || "News",
      outlet: (a.source_name || a.source_id || "Unknown outlet").trim(),
      sourceId: a.source_id || a.source_name || a.link,
      url: a.link,
      date: shortDay(a.pubDate, CONFIG.timeZone),
      day: dayKey(a.pubDate, CONFIG.timeZone),
      priority: Number(a.source_priority) || 1e9, // lower = more prominent outlet
    });
  }
  return out;
}

// Round-robin through categories, best outlets first, one story per outlet, no near-duplicate stories.
function pickVaried(candidates, count, already = []) {
  const chosen = [...already];
  const byCat = new Map();
  for (const c of [...candidates].sort((a, b) => a.priority - b.priority)) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const order = [...CONFIG.categories, ...[...byCat.keys()].filter(k => !CONFIG.categories.includes(k))];
  const ok = c => !chosen.some(x => x.id === c.id || x.sourceId === c.sourceId || similar(x.title, c.title));
  let progress = true;
  while (chosen.length < count && progress) {
    progress = false;
    for (const cat of order) {
      if (chosen.length >= count) break;
      const list = byCat.get(cat) || [];
      const idx = list.findIndex(ok);
      if (idx >= 0) { chosen.push(list.splice(idx, 1)[0]); progress = true; }
    }
  }
  return chosen.slice(already.length);
}

/* ---------- 4a. Claude: split + decoys ---------- */
function claudePrompt(items) {
  const list = items.map(c => ({ id: c.id, section: c.section, headline: c.title }));
  return `You make puzzles for "The Daily Fill-In", a daily news game. Players see the opening words of a real headline and pick the real ending out of four choices.

For each headline below:
1. Split it into "lead" (the opening words shown to the player) and "rest" (the real ending), so that lead + " " + rest is exactly the headline. Split somewhere between 35% and 65% of the way through, so the ending is guessable but not obvious. Never split inside a name, number, or quoted phrase.
2. Write exactly 3 "decoys": wrong endings that
   - read naturally right after the lead,
   - match the real ending's capitalization style, tone, and length (within 3 words),
   - are believable but clearly different from what the real headline says,
   - do not reuse the real ending's key words,
   - say nothing defamatory, criminal, sexual, or medical about a real person or company, and avoid death, violence, and disasters.
3. Set "ok" to false (and leave the other fields empty) if the headline is about death, violence, crime or tragedy, is clickbait, an ad, a listicle, or can't be understood without the article.

Headlines:
${JSON.stringify(list, null, 2)}

Reply with only a JSON array, no other text:
[{"id": "...", "ok": true, "lead": "...", "rest": "...", "decoys": ["...", "...", "..."]}]`;
}

async function askClaude(items) {
  const mock = argValue("--claude-mock");
  let text;
  if (mock) {
    text = await readFile(mock, "utf8");
  } else {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: CONFIG.claudeModel,
          max_tokens: 4000,
          messages: [{ role: "user", content: claudePrompt(items) }],
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        console.warn(`Claude API: HTTP ${res.status} ${body?.error?.message || ""}`);
        return null;
      }
      text = (body.content || []).map(b => b.text || "").join("");
    } catch (err) {
      console.warn(`Claude API: ${err.message}`);
      return null;
    }
  }
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end < start) { console.warn("Claude reply had no JSON array."); return null; }
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return new Map(arr.filter(x => x && x.id).map(x => [String(x.id), x]));
  } catch (err) {
    console.warn(`Claude reply was not valid JSON: ${err.message}`);
    return null;
  }
}

// Check Claude's answer for one headline. Returns {lead, rest, decoys} or null.
function validateClaude(c, r) {
  if (!r || r.ok === false || typeof r.lead !== "string" || !Array.isArray(r.decoys)) return null;
  const titleWords = words(c.title);
  const n = words(r.lead).length;               // trust Claude's split point, not its spelling
  if (n < 2 || titleWords.length - n < 2) return null;
  const lead = titleWords.slice(0, n).join(" ");
  const rest = titleWords.slice(n).join(" ");
  if (alnum(r.lead) !== alnum(lead)) return null; // split didn't line up with the headline
  const restLen = words(rest).length;
  const decoys = [];
  for (const d of r.decoys.map(x => String(x || "").replace(/\s+/g, " ").trim())) {
    if (!d || SENSITIVE.test(d)) continue;
    if (alnum(d) === alnum(rest) || decoys.some(x => alnum(x) === alnum(d))) continue;
    if (Math.abs(words(d).length - restLen) > 5) continue;
    decoys.push(d);
  }
  if (decoys.length < 3) return null;
  return { lead, rest, decoys: decoys.slice(0, 3) };
}

/* ---------- 4b. Fallback: split + borrowed decoys ---------- */
// Quote marks that open or close a quoted phrase (apostrophes inside words like "Here’s" don't count).
function quotesBalanced(s) {
  const opens = (s.match(/(^|\s)["“'‘]/g) || []).length;
  const closes = (s.match(/["”'’](?=\s|$|[,.;:!?])/g) || []).length;
  return opens === closes;
}

function splitHeadline(title) {
  const w = words(title);
  const target = w.length * 0.5;
  let best = null;
  for (let i = 2; i <= w.length - 2; i++) {        // lead = w[0..i-1], rest = w[i..]
    const frac = i / w.length;
    if (frac < 0.3 || frac > 0.7) continue;
    let score = Math.abs(i - target);
    const prev = w[i - 1], next = w[i].toLowerCase().replace(/[^a-z]/g, "");
    if (/[:,?!;.—–]$/.test(prev)) score -= 3;
    else if (BREAK_BEFORE.has(next)) score -= 2;
    if (/^[A-Z][a-z]/.test(prev) && /^[A-Z][a-z]/.test(w[i]) && !isTitleCase(title)) score += 3; // keep names together
    if (/^\d/.test(w[i])) score += 2;
    if (!quotesBalanced(w.slice(0, i).join(" "))) score += 10;   // never split inside a quote
    if (!best || score < best.score) best = { i, score };
  }
  const i = best ? best.i : Math.max(2, Math.round(target));
  return { lead: w.slice(0, i).join(" "), rest: w.slice(i).join(" ") };
}

function firstWordClass(s) {
  const f = (words(s)[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  if (["a", "an", "the"].includes(f)) return "article";
  if (BREAK_BEFORE.has(f)) return "prep";
  if (/ing$/.test(f)) return "ing";
  return "other";
}

function borrowDecoys(item, pool) {
  const restLen = words(item.rest).length;
  const style = isTitleCase(item.title);
  const cls = firstWordClass(item.rest);
  const sig = sigWords(item.rest);
  const scored = pool
    .filter(p => p.id !== item.id && alnum(p.rest) !== alnum(item.rest) && quotesBalanced(p.rest))
    .filter(p => ![...sigWords(p.rest)].some(w => sig.has(w)))
    .map(p => ({
      text: p.rest,
      score: Math.abs(words(p.rest).length - restLen)
        + (isTitleCase(p.title) === style ? 0 : 3)
        + (firstWordClass(p.rest) === cls ? 0 : 2)
        + Math.random(),
    }))
    .sort((a, b) => a.score - b.score);
  const out = [];
  for (const s of scored) {
    if (out.some(x => alnum(x) === alnum(s.text))) continue;
    out.push(s.text);
    if (out.length === 3) break;
  }
  return out.length === 3 ? out : null;
}

/* ---------- 5. Build ---------- */
async function main() {
  const now = argValue("--date") ? new Date(argValue("--date") + "T12:00:00Z") : new Date();
  const { key, dateLabel, shortDate } = dateParts(now, CONFIG.timeZone);
  const newsKey = shiftKey(key, -CONFIG.newsDaysBack);
  const newsDateLabel = dateParts(new Date(newsKey + "T12:00:00Z"), "UTC").dateLabel;

  const articles = await loadArticles(newsKey);
  const usable = toCandidates(articles);
  // Keep only headlines published on the news day (Eastern time). If that day is too thin,
  // widen to the day before it too, then to everything fetched, rather than skip an edition.
  const enough = list => list.length >= CONFIG.headlinesPerEdition + 2;
  const fromNewsDay = usable.filter(c => c.day === newsKey);
  const onlyNewsDay = enough(fromNewsDay);
  const fromTwoDays = usable.filter(c => c.day === newsKey || c.day === shiftKey(newsKey, -1));
  const candidates = onlyNewsDay ? fromNewsDay : enough(fromTwoDays) ? fromTwoDays : usable;
  console.log(`Fetched ${articles.length} articles; ${usable.length} usable headlines, ${fromNewsDay.length} from ${newsKey}.`);
  if (!onlyNewsDay) console.warn(`Warning: too few usable headlines from ${newsKey}; widening to the most recent days available.`);
  if (candidates.length < CONFIG.minHeadlines) throw new Error("Not enough usable headlines today.");

  const shortlist = pickVaried(candidates, CONFIG.candidatesForClaude);
  const claude = await askClaude(shortlist);
  if (claude) console.log(`Claude returned ${claude.size} puzzle(s).`);
  else console.log("Claude not used; borrowing decoys from other headlines.");

  // Endings available to borrow as decoys: every usable headline, split the simple way.
  const pool = usable.map(c => ({ id: c.id, title: c.title, ...splitHeadline(c.title) }));

  const final = [];
  let usedClaude = 0, usedBorrowed = 0;
  const tryAdd = c => {
    if (final.length >= CONFIG.headlinesPerEdition) return;
    if (final.some(x => x._sourceId === c.sourceId || similar(x._title, c.title))) return;
    let puzzle = claude ? validateClaude(c, claude.get(String(c.id))) : null;
    if (claude && claude.get(String(c.id))?.ok === false) return; // Claude rejected it
    if (puzzle) usedClaude++;
    else {
      const split = splitHeadline(c.title);
      const decoys = borrowDecoys({ id: c.id, title: c.title, ...split }, pool);
      if (!decoys) return;
      puzzle = { ...split, decoys };
      usedBorrowed++;
    }
    final.push({
      section: c.section, outlet: c.outlet, date: c.date, url: c.url,
      lead: puzzle.lead, rest: puzzle.rest, decoys: puzzle.decoys,
      _sourceId: c.sourceId, _title: c.title,
    });
  };
  shortlist.forEach(tryAdd);
  if (final.length < CONFIG.headlinesPerEdition) {
    pickVaried(candidates.filter(c => !shortlist.includes(c)), CONFIG.headlinesPerEdition * 2).forEach(tryAdd);
  }
  if (final.length < CONFIG.minHeadlines) throw new Error(`Only ${final.length} headlines passed; keeping the previous edition.`);

  const edition = {
    number: daysBetween(CONFIG.launchDate, key) + 1,
    key, dateLabel, shortDate,
    newsKey: onlyNewsDay ? newsKey : null,
    newsDateLabel: onlyNewsDay ? newsDateLabel : null,
    seconds: CONFIG.secondsPerHeadline,
    decoySource: usedBorrowed === 0 ? "ai" : usedClaude === 0 ? "borrowed" : "mixed",
    generatedAt: new Date().toISOString(),
    headlines: final.map(({ _sourceId, _title, ...h }) => h),
  };

  const json = JSON.stringify(edition, null, 2) + "\n";
  const out = argValue("--out");
  if (out) {
    await writeFile(out, json);
    console.log(`Wrote ${out}`);
  } else {
    await mkdir(path.join(ROOT, "site", "editions"), { recursive: true });
    await writeFile(path.join(ROOT, "site", "edition.json"), json);
    await writeFile(path.join(ROOT, "site", "editions", `${key}.json`), json);
    console.log(`Wrote site/edition.json and site/editions/${key}.json`);
  }
  console.log(`Edition No. ${edition.number} (${key}), news from ${edition.newsKey || "the last two days"}: ${final.length} headlines, ${usedClaude} with AI decoys, ${usedBorrowed} with borrowed decoys.`);
  for (const h of edition.headlines) console.log(`  [${h.section}] ${h.lead} / ${h.rest}  (${h.outlet})`);
}

main().catch(err => {
  console.error(`Build failed: ${err.message}`);
  process.exit(1);
});
