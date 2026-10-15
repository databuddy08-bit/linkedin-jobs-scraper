// Builds LinkedIn guest-API URLs (no login / cookies needed).
const SEARCH_API = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_API = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

export const PAGE_SIZE = 10; // guest API returns 10 cards per page

const POSTED = { '1h': 'r3600', '24h': 'r86400', week: 'r604800', month: 'r2592000' };
const WORK = { onsite: '1', remote: '2', hybrid: '3' };
const JOB = { fulltime: 'F', parttime: 'P', contract: 'C', temporary: 'T', internship: 'I', volunteer: 'V', other: 'O' };
const EXP = { internship: '1', entry: '2', associate: '3', 'mid-senior': '4', director: '5', executive: '6' };

const list = (vals = [], map) => vals.map((v) => map[v]).filter(Boolean).join(',');

/** Filter params shared by every title × location search. */
export function buildFilterParams(input) {
    const p = {};
    if (POSTED[input.postedWithin]) p.f_TPR = POSTED[input.postedWithin];
    if (input.workTypes?.length) p.f_WT = list(input.workTypes, WORK);
    if (input.jobTypes?.length) p.f_JT = list(input.jobTypes, JOB);
    if (input.experienceLevels?.length) p.f_E = list(input.experienceLevels, EXP);
    if (input.easyApplyOnly) p.f_AL = 'true';
    if (input.under10Applicants) p.f_EA = 'true';
    if (input.companyIds?.length) p.f_C = input.companyIds.map(String).join(',');
    if (Number.isInteger(input.distanceMiles)) p.distance = String(input.distanceMiles);
    p.sortBy = input.sortBy === 'relevant' ? 'R' : 'DD';
    for (const k of Object.keys(p)) if (!p[k]) delete p[k];
    return p;
}

export function buildSearchUrl(params, start) {
    const u = new URL(SEARCH_API);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
    u.searchParams.set('start', String(start));
    return u.href;
}

/** Converts a pasted linkedin.com/jobs/search URL into guest-API params. */
export function paramsFromSearchUrl(url) {
    const u = new URL(url);
    const p = {};
    const keep = ['keywords', 'location', 'geoId', 'f_TPR', 'f_WT', 'f_JT', 'f_E', 'f_AL', 'f_EA', 'f_C', 'f_I', 'f_F', 'f_SB2', 'distance', 'sortBy'];
    for (const k of keep) {
        const v = u.searchParams.get(k);
        if (v) p[k] = v;
    }
    return p;
}

export const detailUrl = (jobId) => `${DETAIL_API}${jobId}`;
export const publicJobUrl = (jobId) => `https://www.linkedin.com/jobs/view/${jobId}/`;
