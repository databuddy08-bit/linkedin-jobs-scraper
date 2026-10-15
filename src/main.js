import { Actor, log } from 'apify';
import { CheerioCrawler, sleep } from 'crawlee';
import { buildFilterParams, buildSearchUrl, paramsFromSearchUrl, detailUrl, publicJobUrl, PAGE_SIZE } from './urls.js';
import { parseSearchCards, parseJobDetail, inferWorkType } from './parsers.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    jobTitles = [],
    locations = [],
    searchUrls = [],
    maxResultsPerSearch = 100,
    maxResultsTotal = 0,
    scrapeJobDetails = true,
    excludeKeywords = [],
    excludeCompanies = [],
    maxConcurrency = 10,
    proxyConfiguration,
} = input;

// ---------- Build the search matrix (titles × locations + raw URLs) ----------
const filters = buildFilterParams(input);
const titles = jobTitles.map((s) => s.trim()).filter(Boolean);
const locs = locations.map((s) => s.trim()).filter(Boolean);
const searches = [];

for (const keywords of titles.length ? titles : ['']) {
    for (const location of locs.length ? locs : ['Worldwide']) {
        if (!keywords && !locs.length) continue;
        searches.push({ label: `${keywords || '(any)'} @ ${location}`, params: { keywords, location, ...filters } });
    }
}
for (const url of searchUrls.filter(Boolean)) {
    try {
        searches.push({ label: url, params: { sortBy: 'DD', ...paramsFromSearchUrl(url) } });
    } catch {
        log.warning(`Skipping invalid search URL: ${url}`);
    }
}

if (!searches.length) {
    await Actor.fail('Provide at least one job title, location, or LinkedIn search URL.');
}
log.info(`Running ${searches.length} search(es): ${searches.map((s) => s.label).join(' | ')}`);

// ---------- State (survives migrations / restarts) ----------
const state = await Actor.useState('STATE', { seen: {}, pushed: 0, enqueuedTotal: 0, perSearch: {}, skipped: 0 });
// ---------- Monetization (pay-per-event) ----------
// Two billable events, configured in Apify Console > Publication > Monetization:
//   job-with-details  – a job with its full detail page
//   job-listing       – a job from search results only (fast mode)
// Locally or without PPE pricing, charging is a no-op and limits are Infinity.
const EVENT = scrapeJobDetails ? 'job-with-details' : 'job-listing';
const charging = Actor.getChargingManager();
const affordable = charging.calculateMaxEventChargeCountWithinLimit(EVENT);
const userCap = maxResultsTotal > 0 ? maxResultsTotal : Infinity;
const totalCap = Math.min(userCap, affordable);
let budgetReached = false;

if (totalCap <= 0) {
    log.warning('Your maximum cost per run is too low to save any jobs. Raise "Max cost per run" and try again.');
    await Actor.exit();
}
if (affordable < userCap && Number.isFinite(affordable)) {
    log.info(`Your cost limit allows up to ${affordable} jobs in this run; stopping there.`);
}

const exKw = excludeKeywords.map((s) => s.toLowerCase()).filter(Boolean);
const exCo = excludeCompanies.map((s) => s.toLowerCase()).filter(Boolean);
const isExcluded = (job) =>
    exKw.some((k) => job.title?.toLowerCase().includes(k)) ||
    exCo.some((c) => job.companyName?.toLowerCase().includes(c));

const singleWorkType = input.workTypes?.length === 1 ? input.workTypes[0] : null;

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

async function pushJob(base, detail, search) {
    if (budgetReached || state.pushed >= totalCap) return;
    const merged = { ...base, ...Object.fromEntries(Object.entries(detail ?? {}).filter(([, v]) => v !== null && v !== undefined)) };
    if (isExcluded(merged)) {
        state.skipped++;
        return;
    }
    state.pushed++;
    const charge = await Actor.pushData({
        jobId: base.jobId,
        title: merged.title,
        companyName: merged.companyName,
        companyUrl: merged.companyUrl,
        companyLogo: merged.companyLogo,
        location: merged.location,
        workType: singleWorkType ?? inferWorkType(merged.location, merged.title, detail?.descriptionText?.slice(0, 600)),
        postedAt: base.postedAt,
        postedTimeAgo: merged.postedTimeAgo,
        applicantsCount: detail?.applicantsCount ?? null,
        applicantsText: detail?.applicantsText ?? null,
        salary: merged.salary,
        benefits: base.benefits,
        seniorityLevel: detail?.seniorityLevel ?? null,
        employmentType: detail?.employmentType ?? null,
        jobFunctions: detail?.jobFunctions ?? [],
        industries: detail?.industries ?? [],
        applyType: detail?.applyType ?? null,
        applyUrl: detail?.applyUrl ?? null,
        jobUrl: publicJobUrl(base.jobId),
        descriptionText: detail?.descriptionText ?? null,
        descriptionHtml: detail?.descriptionHtml ?? null,
        emailsInDescription: detail?.emailsInDescription ?? [],
        recruiterName: detail?.recruiterName ?? null,
        recruiterTitle: detail?.recruiterTitle ?? null,
        recruiterProfileUrl: detail?.recruiterProfileUrl ?? null,
        isPromoted: base.isPromoted,
        isClosed: detail?.isClosed ?? false,
        searchKeywords: search.params.keywords ?? null,
        searchLocation: search.params.location ?? null,
        scrapedAt: new Date().toISOString(),
    }, EVENT);
    if (charge?.eventChargeLimitReached) {
        budgetReached = true;
        log.info('Cost limit reached. Finishing the run with the jobs saved so far.');
        crawler.stop('Cost limit reached');
    }
    if (state.pushed % 50 === 0) log.info(`Saved ${state.pushed} jobs so far`);
}

// ---------- Crawler ----------
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxConcurrency,
    maxRequestRetries: 6,
    requestHandlerTimeoutSecs: 60,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: { maxPoolSize: 50, sessionOptions: { maxUsageCount: 30 } },
    additionalMimeTypes: ['text/plain'],
    preNavigationHooks: [
        (_ctx, gotOptions) => {
            gotOptions.headers = {
                ...gotOptions.headers,
                'accept-language': 'en-US,en;q=0.9',
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            };
        },
    ],
    maxRequestsPerMinute: input.maxRequestsPerMinute ?? 120,
    async errorHandler({ request, session }) {
        // LinkedIn throttles with 429 / 999: rotate identity and back off exponentially (with jitter).
        session?.retire();
        const wait = Math.min(60_000, 1500 * 2 ** request.retryCount) + Math.random() * 1000;
        await sleep(wait);
    },

    async requestHandler({ request, $, response, session, crawler: c }) {
        if ([429, 999, 403].includes(response.statusCode)) {
            session?.retire();
            throw new Error(`Blocked (${response.statusCode}), retrying with a new session`);
        }
        const { label, searchIndex, start } = request.userData;
        const search = searches[searchIndex];

        if (label === 'SEARCH') {
            const cards = parseSearchCards($);
            const key = String(searchIndex);
            state.perSearch[key] ??= 0;

            if (!cards.length) {
                log.info(`[${search.label}] no more results at offset ${start} (${state.perSearch[key]} jobs)`);
                return;
            }

            const detailRequests = [];
            for (const card of cards) {
                if (state.perSearch[key] >= maxResultsPerSearch || state.enqueuedTotal >= totalCap) break;
                if (budgetReached) break;
                if (state.seen[card.jobId]) continue; // dedupe across all searches
                if (isExcluded(card)) { // skip before fetching details: saves requests, never billed
                    state.seen[card.jobId] = true;
                    state.skipped++;
                    continue;
                }
                state.seen[card.jobId] = true;
                state.perSearch[key]++;
                state.enqueuedTotal++;

                if (scrapeJobDetails) {
                    detailRequests.push({
                        url: detailUrl(card.jobId),
                        uniqueKey: `detail-${card.jobId}`,
                        userData: { label: 'DETAIL', searchIndex, base: card },
                    });
                } else {
                    await pushJob(card, null, search);
                }
            }
            if (detailRequests.length) await c.addRequests(detailRequests, { forefront: true });

            const more = !budgetReached && state.perSearch[key] < maxResultsPerSearch && state.enqueuedTotal < totalCap && start + PAGE_SIZE < 1000;
            if (more) {
                const next = start + PAGE_SIZE;
                await c.addRequests([{
                    url: buildSearchUrl(search.params, next),
                    uniqueKey: `search-${searchIndex}-${next}`,
                    userData: { label: 'SEARCH', searchIndex, start: next },
                }]);
            } else {
                log.info(`[${search.label}] done: ${state.perSearch[key]} jobs`);
            }
            return;
        }

        if (label === 'DETAIL') {
            const detail = parseJobDetail($);
            if (!detail.title && !detail.descriptionText) {
                session?.retire();
                throw new Error('Empty detail page (likely soft block), retrying');
            }
            await pushJob(request.userData.base, detail, search);
        }
    },

    async failedRequestHandler({ request }, error) {
        log.warning(`Gave up on ${request.url}: ${error.message}`);
        // Still save what we know from the search card rather than losing the job.
        if (request.userData.label === 'DETAIL') {
            await pushJob(request.userData.base, null, searches[request.userData.searchIndex]);
        }
    },
});

await crawler.run(
    searches.map((s, i) => ({
        url: buildSearchUrl(s.params, 0),
        uniqueKey: `search-${i}-0`,
        userData: { label: 'SEARCH', searchIndex: i, start: 0 },
    })),
);

const summary = {
    searches: searches.length,
    jobsSaved: state.pushed,
    uniqueJobsFound: Object.keys(state.seen).length,
    excludedByFilters: state.skipped,
    perSearch: Object.fromEntries(searches.map((s, i) => [s.label, state.perSearch[i] ?? 0])),
};
await Actor.setValue('RUN_SUMMARY', summary);
log.info(`Finished. ${JSON.stringify(summary)}`);

await Actor.exit();
