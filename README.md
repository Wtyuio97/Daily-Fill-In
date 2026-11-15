# The Daily Fill-In

A daily news game. Players see the start of a real headline and pick the real ending from four choices. A new edition of 7 headlines is built automatically every morning from NewsData.io, using news published the day before.

```
site/index.html            the game (one page, no build step)
site/edition.json          today's edition, read by the game
site/editions/             an archive copy of every edition
scripts/build-edition.mjs  fetches headlines and builds edition.json
.github/workflows/         runs the build every morning and publishes the site
```

## How the daily build works

1. At about 5 a.m. Eastern, GitHub Actions runs `scripts/build-edition.mjs`.
2. The script asks NewsData.io for US English headlines in 9 categories (world, business, tech, science, sports, entertainment, top, health, politics), from NewsData's top-ranked outlets only, and keeps the ones **published yesterday**, Eastern time. Monday's game is Sunday's news.
3. It skips headlines that make a bad game: deaths, crime and violence, live blogs, deals, quizzes, headlines that are too short or too long.
4. It picks 7 from different outlets and different stories.
5. For each one it chooses where to cut the headline and writes 3 wrong endings:
   - **With an Anthropic API key:** Claude writes believable wrong endings in the same style. This makes a much better game.
   - **Without one:** the wrong endings are borrowed from other headlines in that day's feed. It works, but the right answer is often easy to spot.
6. It saves `site/edition.json`, commits it, and publishes the `site` folder to GitHub Pages.

If yesterday was a thin news day, the script widens to the day before as well and the game just says "real headlines from the news." If there are still too few usable headlines, the build stops and the previous edition stays up.

**About the free plan's 12-hour delay:** NewsData's free plan only shows articles once they're about 12 hours old. So the 5 a.m. build sees yesterday's news up to about 5 p.m. Evening stories miss out. If you'd rather cover the whole day, move the run to around 12:17 p.m. Eastern (`cron: "17 17 * * *"`), or upgrade to a paid NewsData plan, which has no delay.

## Setup (about 15 minutes)

### 1. Get a NewsData.io API key (free)
Sign up at https://newsdata.io and copy your API key from the dashboard. The free plan gives 200 credits a day; this game uses up to 18 (two pages of 10 headlines for each of 9 categories).

### 2. Get an Anthropic API key (optional, recommended)
Sign up at https://console.anthropic.com, add a small amount of credit, and create an API key. The game makes one short request a day with the default `claude-haiku-5-5` model, so the cost should be tiny. Check the current pricing on Anthropic's site.

### 3. Put the project on GitHub
1. Create a new repository on GitHub (it can be public or private).
2. Upload everything in this folder, including the hidden `.github` folder. The easiest way is to drag the files into **Add file → Upload files**, or use `git push`.

### 4. Add your keys as secrets
In the repository go to **Settings → Secrets and variables → Actions → New repository secret** and add:
- `NEWSDATA_API_KEY`: your NewsData.io key
- `ANTHROPIC_API_KEY`: your Anthropic key (skip this if you don't have one)

Never paste keys into the code. Secrets keep them private.

### 5. Turn on GitHub Pages
**Settings → Pages → Build and deployment → Source: GitHub Actions.**

### 6. Run it once by hand
**Actions → Daily edition → Run workflow.** When it finishes (about a minute), your site is live at the address shown on the Pages settings screen, usually `https://YOUR-USERNAME.github.io/REPO-NAME/`. After that it runs on its own every morning.

## Ads and your own domain

- **Custom domain:** buy one from any registrar, then add it under **Settings → Pages → Custom domain**. Ad networks usually want your own domain.
- **Ads:** once an ad network like Google AdSense approves your site, paste its code where `index.html` says `AD SETUP` (in the page head) and `AD SLOT` (start screen and results screen).
- **Hosting:** GitHub's rules say Pages isn't meant for running an online business. That's fine for getting started. If the site starts earning real money, move the `site` folder to a host like Netlify or Cloudflare Pages (both have free plans) and keep the daily build.

## Try it on your own computer

```bash
# Build a test edition from the sample data in scripts/fixtures (no API keys needed)
npm run test-build

# Build a real edition (writes site/edition.json)
NEWSDATA_API_KEY=your-key ANTHROPIC_API_KEY=your-key npm run build

# Play it at http://localhost:8080
npm run serve
```

Needs Node 20 or newer. There are no packages to install.

## Things you can change

At the top of `scripts/build-edition.mjs`, `CONFIG` holds the settings:

- `headlinesPerEdition`: how many headlines in a game (default 7)
- `secondsPerHeadline`: time per headline (default 20)
- `country`: news countries, e.g. `"us,gb,ca"`
- `categories`: which sections to draw from, in order of preference
- `timeZone`: decides when "today" and "yesterday" start
- `newsDaysBack`: how old the news is (1 = yesterday; 0 = today so far)
- `pagesPerCategory`: how far back to page through each category (each page is 1 credit)
- `claudeModel`: or set a `CLAUDE_MODEL` secret

The lists of skipped topics are `SENSITIVE` and `JUNK` in the same file.

To change the time it runs, edit the `cron` line in `.github/workflows/daily-edition.yml`. It's in UTC.

## Keep in mind

- Keep the outlet name and "Read it at…" link on every headline. Crediting and linking back to the source is part of what keeps headline use on the safe side.
- Wrong endings are invented statements next to real names. The page says they never ran. Glance at the day's edition now and then, and tighten the prompt in `claudePrompt()` if a wrong ending ever reads as a believable claim about a real person.
- NewsData.io's terms, Anthropic's terms, and your ad network's rules all apply. This isn't legal advice. Get a quick review before you rely on the site for income.
