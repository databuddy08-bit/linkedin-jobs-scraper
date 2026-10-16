import { Actor, log } from 'apify';
import { CheerioCrawler, sleep } from 'crawlee';
import { buildFilterParams, buildSearchUrl, paramsFromSearchUrl, detailUrl, publicJobUrl, PAGE_SIZE } from './urls.js';
import { parseSearchCards, parseJobDetail } from './parsers.js';
import { detectWorkType } from './worktype.js';
import { makeTitleMatcher } from './titlematch.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    jobTitles = [],
    locations = [],
    searchUrls = [],
    maxResultsPerSearch = 100,
    maxResultsTotal = 0,
    excludeKeywords = [],
    excludeCompanies = [],
    includeUnclearJobs = false,
    titleMatch = 'exact',
    maxConcurrency = 25,
    proxyConfiguration,
} = input;

// ---------- Filters LinkedIn ignores for logged-out visitors: we verify them ourselves ----------
const SENIORITY = { internship: 'internship', entry: 'entry level', associate: 'associate', 'mid-senior': 'mid-senior level', director: 'director', executive: 'executive' };
const EMPLOYMENT = { fulltime: 'full-time', parttime: 'part-time', contract: 'contract', temporary: 'temporary', internship: 'internship', volunteer: 'volunteer', other: 'other' };
const URL_WT = { 1: 'onsite', 2: 'remote', 3: 'hybrid' };
const URL_E = { 1: 'internship', 2: 'entry', 3: 'associate', 4: 'mid-senior', 5: 'director', 6: 'executive' };
const URL_JT = { F: 'fulltime', P: 'parttime', C: 'contract', T: 'temporary', I: 'internship', V: 'volunteer', O: 'other' };

function makeVerify({ workTypes = [], experienceLevels = [], jobTypes = [] }) {
    const v = {
        workTypes: new Set(workTypes),
        seniority: new Set(experienceLevels.map((e) => SENIORITY[e]).filter(Boolean)),
        employment: new Set(jobTypes.map((j) => EMPLOYMENT[j]).filter(Boolean)),
    };
    v.active = v.workTypes.size > 0 || v.seniority.size > 0 || v.employment.size > 0;
    return v;
}
const fromUrlCodes = (val, map) => (val ? val.split(',').map((c) => map[c.trim()]).filter(Boolean) : []);

/** Returns null when the job matches, or the reason it was rejected. */
const UNSTATED = new Set(['', 'not applicable']);
function rejectReason(job, verify) {
    if (!verify.active) return null;
    // A value the employer did not state can't be verified: keep it only if the user allows it.
    const check = (set, value, name) => {
        if (!set.size) return null;
        const v = (value ?? '').toLowerCase();
        if (UNSTATED.has(v)) return includeUnclearJobs ? null : `${name} not stated`;
        return set.has(v) ? null : `${name} ${value}`;
    };
    return check(verify.workTypes, job.workType, 'workType')
        ?? check(verify.seniority, job.seniorityLevel, 'seniority')
        ?? check(verify.employment, job.employmentType, 'employment');
}

// ---------- Build the search matrix (titles × locations + raw URLs) ----------
const filters = buildFilterParams(input);
const inputVerify = makeVerify(input);
const titles = jobTitles.map((s) => s.trim()).filter(Boolean);
const locs = locations.map((s) => s.trim()).filter(Boolean);
const searches = [];

// With exactly one work type, add it to LinkedIn's keyword search ("Data Analyst remote") so LinkedIn
// returns posts that mention it. Every job is still verified individually before it is saved.
const WT_KEYWORD = { remote: 'remote', hybrid: 'hybrid', onsite: '' };
const wtBoost = input.workTypes?.length === 1 ? WT_KEYWORD[input.workTypes[0]] : '';

for (const keywords of titles.length ? titles : ['']) {
    for (const location of locs.length ? locs : ['Worldwide']) {
        if (!keywords && !locs.length) continue;
        // In exact mode, send the phrase in quotes so LinkedIn ranks exact-phrase jobs first.
        const advanced = /["()]|\b(?:AND|OR|NOT)\b/.test(keywords);
        let kw = titleMatch === 'exact' && keywords && !advanced && /\s/.test(keywords) ? `"${keywords}"` : keywords;
        if (wtBoost && !new RegExp(`\\b${wtBoost}\\b`, 'i').test(keywords)) kw = `${kw} ${wtBoost}`.trim();
        searches.push({
            label: `${keywords || '(any)'} @ ${location}`,
            params: { keywords: kw, location, ...filters },
            verify: inputVerify,
            titleOk: makeTitleMatcher(keywords, titleMatch),
        });
    }
}
for (const url of searchUrls.filter(Boolean)) {
    try {
        const params = { sortBy: 'DD', ...paramsFromSearchUrl(url) };
        const verify = makeVerify({
            workTypes: fromUrlCodes(params.f_WT, URL_WT),
            experienceLevels: fromUrlCodes(params.f_E, URL_E),
            jobTypes: fromUrlCodes(params.f_JT, URL_JT),
        });
        searches.push({ label: url, params, verify, titleOk: makeTitleMatcher(params.keywords, titleMatch) });
    } catch {
        log.warning(`Skipping invalid search URL: ${url}`);
    }
}

if (!searches.length) {
    await Actor.fail('Provide at least one job title, location, or LinkedIn search URL.');
}

// Verification needs the job page, so these filters switch on full details.
const needsDetails = searches.some((s) => s.verify.active);
const scrapeJobDetails = input.scrapeJobDetails !== false || needsDetails;
if (input.scrapeJobDetails === false && needsDetails) {
    log.info('Work type / experience / job type filters are checked on each job page, so full details are turned on.');
}
// Safety valve: how many jobs to inspect per search when filters reject most of them.
const maxChecksPerSearch = Math.min(1000, Math.max(maxResultsPerSearch * 20, 200));

log.info(`Running ${searches.length} search(es): ${searches.map((s) => s.label).join(' | ')}`);

// ---------- State (survives migrations / restarts) ----------
const state = await Actor.useState('STATE', { seen: {}, pushed: 0, accepted: {}, checked: {}, excluded: 0, rejected: 0, rejectedBy: {}, titleMismatch: {}, titleRejected: 0, done: {} });

// ---------- Monetization (pay-per-event) ----------
// Billable events, configured in Apify Console > Publishing > Monetization:
//   job-with-details  – a job with its full detail page
//   job-listing       – a job from search results only (fast mode)
// Only jobs that are saved are charged: duplicates, excluded and non-matching jobs are free.
const EVENT = scrapeJobDetails ? 'job-with-details' : 'job-listing';
const affordable = Actor.getChargingManager().calculateMaxEventChargeCountWithinLimit(EVENT);
const userCap = maxResultsTotal > 0 ? maxResultsTotal : Infinity;
const totalCap = Math.min(userCap, affordable);
let stopped = false;
const startedAt = Date.now();

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

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
// With a proxy every retry gets a fresh IP, so we can go fast and retry quickly.
// Without one, stay gentle: LinkedIn throttles a single IP hard.
const maxRequestsPerMinute = input.maxRequestsPerMinute ?? (proxy ? 400 : 60);

// Finish cleanly before the run's time limit, so the run ends as SUCCEEDED with everything saved.
const timeoutAt = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : null;
let timeoutTimer;
if (timeoutAt) {
    const ms = timeoutAt - Date.now() - 45_000;
    if (ms > 0) {
        timeoutTimer = setTimeout(() => {
            stopped = true;
            log.warning(`The run is about to reach its time limit, so it is finishing now with ${state.pushed} jobs saved. `
                + 'For more jobs in one run, raise "Timeout" in the run options.');
            crawler.stop('Run time limit reached');
        }, ms);
    }
}

const acceptedFor = (i) => state.accepted[i] ?? 0;
const searchFull = (i) => acceptedFor(i) >= maxResultsPerSearch;

function buildRecord(base, detail, search) {
    const pick = (k) => detail?.[k] ?? base[k] ?? null;
    const title = pick('title');
    const location = pick('location');
    const wt = detail
        ? detectWorkType({ title, location, description: detail.descriptionText })
        : detectWorkType({ title, location, description: null });
    return {
        jobId: base.jobId,
        title,
        companyName: pick('companyName'),
        companyUrl: pick('companyUrl'),
        companyLogo: pick('companyLogo'),
        location,
        workType: wt.workType,
        workTypeSource: wt.workTypeSource,
        workTypeEvidence: wt.workTypeEvidence,
        postedAt: base.postedAt,
        postedTimeAgo: pick('postedTimeAgo'),
        applicantsCount: detail?.applicantsCount ?? null,
        applicantsText: detail?.applicantsText ?? null,
        salary: pick('salary'),
        benefits: base.benefits ?? null,
        seniorityLevel: detail?.seniorityLevel ?? null,
        employmentType: detail?.employmentType ?? null,
        jobFunction: detail?.jobFunctions?.join(', ') || null,
        industries: detail?.industries?.join(', ') || null,
        applyType: detail?.applyType ?? null,
        applyUrl: detail?.applyUrl ?? null,
        jobUrl: publicJobUrl(base.jobId),
        descriptionText: detail?.descriptionText ?? null,
        descriptionHtml: detail?.descriptionHtml ?? null,
        emailsInDescription: detail?.emailsInDescription?.join(', ') || null,
        recruiterName: detail?.recruiterName ?? null,
        recruiterTitle: detail?.recruiterTitle ?? null,
        recruiterProfileUrl: detail?.recruiterProfileUrl ?? null,
        isPromoted: base.isPromoted ?? false,
        isClosed: detail?.isClosed ?? false,
        searchKeywords: search.label.includes(' @ ') ? search.label.split(' @ ')[0] : (search.params.keywords ?? null),
        searchLocation: search.params.location ?? null,
        scrapedAt: new Date().toISOString(),
    };
}

async function saveJob(base, detail, searchIndex) {
    const search = searches[searchIndex];
    if (stopped || searchFull(searchIndex) || state.pushed >= totalCap) return;

    const record = buildRecord(base, detail, search);
    if (isExcluded(record)) { state.excluded++; return; }
    const reason = rejectReason(record, search.verify);
    if (reason) {
        state.rejected++;
        state.rejectedBy[reason] = (state.rejectedBy[reason] ?? 0) + 1;
        return;
    }

    state.pushed++;
    state.accepted[searchIndex] = acceptedFor(searchIndex) + 1;
    const charge = await Actor.pushData(record, EVENT);

    if (charge?.eventChargeLimitReached) {
        stopped = true;
        log.info('Cost limit reached. Finishing the run with the jobs saved so far.');
        crawler.stop('Cost limit reached');
    } else if (state.pushed >= totalCap) {
        stopped = true;
        crawler.stop('Requested number of jobs reached');
    }
    if (state.pushed % 50 === 0) {
        const perMin = Math.round(state.pushed / Math.max(1, (Date.now() - startedAt) / 60_000));
        log.info(`Saved ${state.pushed} jobs so far (~${perMin} jobs/min)`);
    }
}

// ---------- Crawler ----------
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxConcurrency,
    maxRequestsPerMinute,
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
    async errorHandler({ request, session }) {
        // LinkedIn throttles with 429 / 999: rotate identity and back off exponentially (with jitter).
        session?.retire();
        const wait = proxy
            ? 500 + Math.random() * 1500 // new IP on retry: a short pause is enough
            : Math.min(60_000, 1500 * 2 ** request.retryCount) + Math.random() * 1000;
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
            if (stopped || searchFull(searchIndex)) return;
            const cards = parseSearchCards($);
            if (!cards.length) {
                if (!state.done[searchIndex]) log.info(`[${search.label}] no more results (${acceptedFor(searchIndex)} jobs)`);
                state.done[searchIndex] = true;
                return;
            }

            const details = [];
            for (const card of cards) {
                if (state.seen[card.jobId]) continue; // dedupe across all searches
                // Title must contain the keyword. Not marked as seen: another keyword may still match it.
                if (!search.titleOk(card.title ?? '')) {
                    state.checked[searchIndex] = (state.checked[searchIndex] ?? 0) + 1;
                    if (!state.titleMismatch[card.jobId]) {
                        state.titleMismatch[card.jobId] = true;
                        state.titleRejected++;
                    }
                    continue;
                }
                state.seen[card.jobId] = true;
                if (isExcluded(card)) { state.excluded++; continue; } // skip before fetching details
                state.checked[searchIndex] = (state.checked[searchIndex] ?? 0) + 1;

                if (scrapeJobDetails) {
                    details.push({
                        url: detailUrl(card.jobId),
                        uniqueKey: `detail-${card.jobId}`,
                        userData: { label: 'DETAIL', searchIndex, base: card },
                    });
                } else {
                    await saveJob(card, null, searchIndex);
                }
            }
            if (details.length) await c.addRequests(details, { forefront: true });

            const more = !stopped
                && !searchFull(searchIndex)
                && (state.checked[searchIndex] ?? 0) < maxChecksPerSearch
                && start + PAGE_SIZE < 1000;
            if (more) {
                const next = start + PAGE_SIZE;
                await c.addRequests([{
                    url: buildSearchUrl(search.params, next),
                    uniqueKey: `search-${searchIndex}-${next}`,
                    userData: { label: 'SEARCH', searchIndex, start: next },
                }]);
            } else if (!searchFull(searchIndex) && !state.done[searchIndex] && !stopped) {
                state.done[searchIndex] = true;
                log.info(`[${search.label}] checked ${state.checked[searchIndex]} jobs, ${acceptedFor(searchIndex)} matched your filters`);
            }
            return;
        }

        if (label === 'DETAIL') {
            if (stopped || searchFull(searchIndex)) return;
            const detail = parseJobDetail($);
            if (!detail.title && !detail.descriptionText) {
                session?.retire();
                throw new Error('Empty detail page (likely soft block), retrying');
            }
            await saveJob(request.userData.base, detail, searchIndex);
        }
    },

    async failedRequestHandler({ request }, error) {
        log.warning(`Gave up on ${request.url}: ${error.message}`);
        const { label, searchIndex, base } = request.userData;
        // Without the job page we cannot verify filters; otherwise keep the search-card data.
        if (label === 'DETAIL' && !searches[searchIndex].verify.active) await saveJob(base, null, searchIndex);
    },
});

await crawler.run(
    searches.map((s, i) => ({
        url: buildSearchUrl(s.params, 0),
        uniqueKey: `search-${i}-0`,
        userData: { label: 'SEARCH', searchIndex: i, start: 0 },
    })),
);

clearTimeout(timeoutTimer);
const summary = {
    searches: searches.length,
    jobsSaved: state.pushed,
    uniqueJobsChecked: Object.keys(state.seen).length,
    excludedByTitleOrCompany: state.excluded,
    titleDidNotMatchKeyword: state.titleRejected,
    notMatchingFilters: state.rejected,
    notMatchingBreakdown: state.rejectedBy,
    perSearch: Object.fromEntries(searches.map((s, i) => [s.label, acceptedFor(i)])),
};
await Actor.setValue('RUN_SUMMARY', summary);
log.info(`Finished. ${JSON.stringify(summary)}`);

await Actor.exit();
