// Work-type detection.
// LinkedIn does not show the official workplace label (on-site / remote / hybrid) to logged-out
// visitors and ignores the work-type search filter for them, so we read it from the job itself.
//
// Rules:
//  - Only label a job when the text says so clearly; otherwise return null (never guess).
//  - Evidence is checked in priority tiers; the first tier with a clear answer wins.
//    Within a tier, contradictory answers give null.
//  - Every label carries the exact phrase that decided it, so users can verify it.

const T = { onsite: 'onsite', remote: 'remote', hybrid: 'hybrid' };

// Words that may follow "hybrid"/"remote"/"on-site" when they describe a work arrangement.
const ARR = '(?:working|work|role|position|job|model|mode|schedule|arrangement|set-?up|policy|basis|opportunity|environment|pattern|employment|contract)';
const ONSITE_WORDS = '(?:on[- ]?site|in[- ]office|office[- ]based|in[- ]person)';
// "Working model: Hybrid", "Workplace type - Remote", "Work location: In person" …
const labelled = (word) => new RegExp(`\\b(?:working model|work model|work(?:ing)? arrangement|work location|location type|workplace(?: type)?|work style|work setting|work type|office policy|working pattern|location)\\s*[:\\-–]?\\s*(?:fully\\s+|100%\\s+)?${word}\\b`, 'i');
// A standalone tag such as "London | Hybrid | £80k" or "Hybrid – 3 days in office".
const tag = (word) => new RegExp(`(?:^|[|•·:(\\[\\n]|\\s[-–—]\\s)\\s*${word}\\s*(?:$|[|•·)\\],\\n]|\\s[-–—(]\\s?)`, 'i');
const roleIs = (word) => new RegExp(`\\b(?:this|the) (?:role|position|job|opportunity) (?:is|will be) (?:an? )?(?:full[- ]time |fully |100% )?${word}\\b`, 'i');
const classedAs = (word) => new RegExp(`\\b(?:categori[sz]ed|classified|considered|designated) as (?:an? )?(?:fully )?${word}\\b`, 'i');

const TIERS = [
    // Tier 1 — LinkedIn's own workplace hashtags that recruiters add for LinkedIn (#LI-Remote …).
    {
        [T.remote]: [/#?\bLI-Remote\b/i],
        [T.hybrid]: [/#?\bLI-Hybrid\b/i],
        [T.onsite]: [/#?\bLI-On-?site\b/i],
    },
    // Tier 2 — statements about this specific role.
    {
        [T.remote]: [
            roleIs('remote'), classedAs('remote'), labelled('remote'),
            /\b(?:full[- ]time|fully|100%) remote (?:role|position|job|opportunity)\b/i,
            /\b(?:this|the) (?:role|position|job) (?:can|may) be (?:performed|done|worked) (?:fully )?remotely\b/i,
        ],
        [T.hybrid]: [
            roleIs('hybrid'), classedAs('hybrid'), labelled('hybrid'),
            /\bthis is a hybrid (?:role|position|job)\b/i,
            /\b\d\s*(?:-|to)?\s*\d?\s*(?:core\s+)?(?:office\s+)?days?\s*(?:a|per|each)\s*week\s*(?:in|at|from)\s*(?:the|our)?\s*(?:office|site)\b/i,
            /\b\d\s*days?\s*(?:a|per)\s*week\s*(?:remote|from home|wfh)\b/i,
        ],
        [T.onsite]: [
            roleIs(ONSITE_WORDS), classedAs(ONSITE_WORDS), labelled(ONSITE_WORDS),
            /\b(?:required|expected) to work (?:full[- ]time,? )?(?:fully )?(?:on[- ]?site|in[- ]office|in the office|from (?:the|our) office)\b/i,
            /\b(?:not|no|isn't|is not|cannot be|can't be)\s+(?:a\s+|an?\s+option\s+for\s+)?(?:fully\s+)?remote\b(?![- ](?:only|first|friendly))/i,
            /\bremote work is not\b/i,
            /\bno (?:remote|work from home|wfh|telework)\b(?![- ](?:only|first|friendly))/i,
            /\b(?:fully|100%|five days|5 days)(?: a week)?\s+(?:on[- ]?site|in[- ]office|in the office)\b/i,
            /\bmust (?:be able to )?(?:commute|report to (?:the|our) office|work from (?:the|our) office|work on[- ]?site)\b/i,
        ],
    },
    // Tier 3 — general wording elsewhere in the post (company policy, benefits, header tags).
    {
        [T.remote]: [
            /\b(?:fully|100%|completely|entirely|permanently)\s+remote\b/i,
            /\bremote[- ](?:first|only|position|role|job|opportunity|based|eligible)\b/i,
            /\b(?:fully|100%|permanently|entirely)\s+work(?:ing)? from home\b/i,
            /\bwork[- ]from[- ]home (?:position|role|job|opportunity|basis)\b/i,
            /\b(?:you will|you'll|you can|able to) work remotely\b/i,
            /\bwork from anywhere\b/i,
            /\bremote\s*(?:\(|-|–|,)\s*(?:us|usa|united states|uk|europe|emea|india|canada|apac|latam|worldwide|global|anywhere)\b/i,
            tag('remote'),
        ],
        [T.hybrid]: [
            new RegExp(`\\bhybrid[- ](?:[a-z]+[- ]){0,2}${ARR}\\b`, 'i'),
            /\bsplit between (?:home|remote) and (?:the )?office\b/i,
            tag('hybrid'),
        ],
        [T.onsite]: [
            new RegExp(`\\b${ONSITE_WORDS}[- ]${ARR}\\b`, 'i'),
            tag('(?:on[- ]?site|in[- ]office)'),
        ],
    },
];

// In titles/locations, skip technical uses of the words ("Hybrid Cloud Engineer", "Remote Sensing Analyst").
const TITLE = {
    [T.hybrid]: /\bhybrid\b(?![- ](?:cloud|vehicles?|infrastructure|it|systems?|apps?|applications?|mobile|integration|energy|power|seeds?|cars?))/i,
    [T.remote]: /\bremote\b(?![- ](?:sensing|monitoring|patient|support|access|pilot|operations?|operator|desktop|systems?|surgery|vehicles?|control|services?|technician))/i,
    [T.onsite]: /\b(?:on[- ]?site|in[- ]office|in[- ]person)\b(?![- ](?:support|technician|engineer|services?|visits?|interviews?|events?|trainer|training))/i,
};

function snippet(text, m) {
    const from = Math.max(0, m.index - 40);
    const to = Math.min(text.length, m.index + m[0].length + 40);
    return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

function evaluateTier(text, tier) {
    const found = {};
    for (const [type, patterns] of Object.entries(tier)) {
        for (const re of patterns) {
            const m = re.exec(text);
            if (m) { found[type] = snippet(text, m); break; }
        }
    }
    return found;
}

const result = (workType, workTypeSource, workTypeEvidence) => ({ workType, workTypeSource, workTypeEvidence });
const NONE = result(null, null, null);

/**
 * @returns {{ workType: 'onsite'|'remote'|'hybrid'|null, workTypeSource: string|null, workTypeEvidence: string|null }}
 */
export function detectWorkType({ title, location, description }) {
    // 1. Title / location: employers put the workplace there deliberately.
    for (const [source, text] of [['title', title], ['location', location]]) {
        if (!text) continue;
        const hits = Object.keys(TITLE).filter((t) => TITLE[t].test(text) && !(t === T.remote && /\bnot remote\b/i.test(text)));
        if (hits.length === 1) return result(hits[0], source, text);
    }

    // 2. Description, tier by tier.
    if (!description) return NONE;
    for (const tier of TIERS) {
        const found = evaluateTier(description, tier);
        const types = Object.keys(found);
        if (types.length === 1) return result(types[0], 'description', found[types[0]]);
        if (types.length > 1) {
            // A specific hybrid statement explains the other mentions ("hybrid role, so you must be able
            // to commute to our office 1-2 times a week"), so hybrid wins; any other mix is contradictory.
            if (found[T.hybrid]) return result(T.hybrid, 'description', found[T.hybrid]);
            return NONE;
        }
    }
    return NONE;
}
