// Job-title matching.
// LinkedIn's keyword search is fuzzy: "AI Engineer" also returns "Electrical Engineer" or
// "Machine Learning Engineer". These checks keep only titles that really contain the keyword.
//
// Modes:
//   exact    – the whole phrase appears in the title, words in order and next to each other
//              ("AI Engineer" → "Senior AI Engineer", "AI Engineer II"; not "AI Software Engineer").
//   allWords – every word of the phrase appears somewhere in the title, any order
//              ("AI Engineer" → "AI Software Engineer", "Senior AI/ML Engineer").
//   off      – keep everything LinkedIn returns.
//
// Spelling variants are treated as the same: "Full Stack" = "Full-Stack" = "Fullstack",
// "A.I." = "AI", "AI" = "Artificial Intelligence", "ML" = "Machine Learning", "Sr" = "Senior", etc.

const SYNONYMS = [
    ['ai', 'artificial intelligence'],
    ['ml', 'machine learning'],
    ['sr', 'senior'],
    ['jr', 'junior'],
    ['dev', 'developer'],
    ['eng', 'engineer'],
    ['mgr', 'manager'],
    ['qa', 'quality assurance'],
    ['ux', 'user experience'],
    ['ui', 'user interface'],
    ['hr', 'human resources'],
    ['pm', 'product manager'],
    ['devops', 'dev ops'],
    ['frontend', 'front end'],
    ['backend', 'back end'],
    ['fullstack', 'full stack'],
];

// Longest phrases first, so "product manager" becomes "pm" before "manager" alone is shortened.
const SYNONYMS_LONGEST_FIRST = [...SYNONYMS].sort((a, b) => b[1].length - a[1].length);

/** Lowercase, drop dots in abbreviations (A.I. → ai), turn every other symbol into a space. */
function tokenize(text) {
    return (text ?? '')
        .toLowerCase()
        .replace(/(\b\w)\.(?=\w\b|\s|$)/g, '$1') // a.i. → ai
        .replace(/\./g, '')
        .replace(/[^a-z0-9+#]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

/** Expands synonyms and joins compound words so all spellings compare equal. */
function canonical(tokens) {
    let s = ` ${tokens.join(' ')} `;
    for (const [short, long] of SYNONYMS_LONGEST_FIRST) {
        s = s.replaceAll(` ${long} `, ` ${short} `); // "artificial intelligence" → "ai"
    }
    return s.trim().split(/\s+/).filter(Boolean);
}

function containsSequence(hay, needle) {
    if (!needle.length) return true;
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return true;
    }
    return false;
}

// Boolean or quoted LinkedIn queries are passed through as typed; we don't second-guess them.
const isAdvancedQuery = (kw) => /["()]|\b(?:AND|OR|NOT)\b/.test(kw);

/** Strips LinkedIn query decoration so we compare against the plain phrase. */
const plainPhrase = (kw) => kw.replace(/["()]/g, ' ').replace(/\b(?:AND|OR|NOT)\b/g, ' ');

/**
 * Builds a matcher for one keyword.
 * @returns {(title: string) => boolean}
 */
export function makeTitleMatcher(keyword, mode = 'exact') {
    if (!keyword || mode === 'off') return () => true;
    if (isAdvancedQuery(keyword) && /\b(?:OR|NOT)\b/.test(keyword)) return () => true;

    const phrase = canonical(tokenize(plainPhrase(keyword)));
    if (!phrase.length) return () => true;

    // "python AND django": every term must appear, in any order.
    if (mode === 'allWords' || /\bAND\b/.test(keyword)) {
        return (title) => {
            const t = new Set(canonical(tokenize(title)));
            return phrase.every((w) => t.has(w));
        };
    }
    return (title) => containsSequence(canonical(tokenize(title)), phrase);
}
