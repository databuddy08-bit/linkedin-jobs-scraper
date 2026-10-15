// HTML parsers for LinkedIn guest pages. Every field is optional: missing data becomes null.
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;
const stripQuery = (u) => (u ? u.split('?')[0] : null);

/** Parses one page of search cards. */
export function parseSearchCards($) {
    const jobs = [];
    $('li').each((_, li) => {
        const card = $(li).find('[data-entity-urn*="jobPosting"], .base-card').first();
        if (!card.length) return;
        const urn = card.attr('data-entity-urn') || '';
        const link = card.find('a.base-card__full-link').attr('href') || '';
        const jobId = urn.split(':').pop() || (link.match(/-(\d{6,})(?:\?|$)/) || [])[1];
        if (!jobId || !/^\d+$/.test(jobId)) return;
        const time = card.find('time');
        jobs.push({
            jobId,
            title: clean(card.find('.base-search-card__title').text()),
            companyName: clean(card.find('.base-search-card__subtitle').text()),
            companyUrl: stripQuery(card.find('.base-search-card__subtitle a').attr('href')),
            companyLogo: card.find('img.artdeco-entity-image').attr('data-delayed-url') || null,
            location: clean(card.find('.job-search-card__location').text()),
            postedAt: time.attr('datetime') || null,
            postedTimeAgo: clean(time.text()),
            salary: clean(card.find('.job-search-card__salary-info').text()),
            benefits: clean(card.find('.job-posting-benefits__text, .result-benefits__text').text()),
            isPromoted: /promoted/i.test(card.text()),
        });
    });
    return jobs;
}

function parseApplicants(text) {
    if (!text) return null;
    const m = text.replace(/,/g, '').match(/(\d+)/);
    if (!m) return null;
    return Number(m[1]);
}

/** LinkedIn hides the real external apply link inside an HTML comment, URL-encoded. */
function decodeApplyUrl($) {
    const raw = $('code#applyUrl').html() || '';
    const m = raw.match(/"(https?:[^"]+)"/);
    if (!m) return null;
    try {
        const outer = new URL(m[1].replace(/&amp;/g, '&'));
        const inner = outer.searchParams.get('url');
        return inner ? decodeURIComponent(inner) : outer.href;
    } catch {
        return null;
    }
}

/** Readable plain text: keeps paragraph and bullet breaks instead of gluing words together. */
function htmlToText(html) {
    if (!html) return null;
    const text = html
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<(br|\/p|\/div|\/ul|\/ol|\/h\d|\/li)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text || null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Parses a single job detail page. */
export function parseJobDetail($) {
    const criteria = {};
    $('.description__job-criteria-item').each((_, el) => {
        const k = clean($(el).find('.description__job-criteria-subheader').text());
        const v = clean($(el).find('.description__job-criteria-text').text());
        if (k) criteria[k.toLowerCase()] = v;
    });

    const descEl = $('.show-more-less-html__markup').first();
    const descriptionHtml = descEl.html()?.trim() || null;
    const descriptionText = htmlToText(descriptionHtml);

    const applicantsText = clean($('.num-applicants__caption').first().text());
    const externalApply = decodeApplyUrl($);
    const html = $.html();
    const isOffsite = !!externalApply || html.includes('apply-link-offsite');
    const easyApply = !isOffsite && (html.includes('apply-link-onsite') || /easy apply/i.test($('.top-card-layout__cta-container').text()));

    const recruiter = $('.message-the-recruiter');
    const recruiterName = clean(recruiter.find('.base-main-card__title').text());

    const industries = criteria.industries?.split(/,\s*/).filter(Boolean) ?? [];
    const jobFunctions = criteria['job function']?.split(/,\s*|\s+and\s+/).filter(Boolean) ?? [];

    return {
        title: clean($('.top-card-layout__title, .topcard__title').first().text()),
        companyName: clean($('a.topcard__org-name-link, .topcard__flavor').first().text()),
        companyUrl: stripQuery($('a.topcard__org-name-link').attr('href')),
        companyLogo: $('.top-card-layout__card img.artdeco-entity-image').attr('data-delayed-url') || null,
        location: clean($('.topcard__flavor--bullet').first().text()),
        postedTimeAgo: clean($('.posted-time-ago__text').first().text()),
        applicantsText,
        applicantsCount: parseApplicants(applicantsText),
        salary: clean($('.salary.compensation__salary, .compensation__salary').first().text()),
        seniorityLevel: criteria['seniority level'] ?? null,
        employmentType: criteria['employment type'] ?? null,
        jobFunctions,
        industries,
        descriptionText,
        descriptionHtml,
        emailsInDescription: [...new Set(descriptionText?.match(EMAIL_RE) ?? [])],
        applyType: isOffsite ? 'external' : easyApply ? 'easy_apply' : 'unknown',
        applyUrl: externalApply,
        recruiterName,
        recruiterTitle: clean(recruiter.find('.base-main-card__subtitle').text()),
        recruiterProfileUrl: recruiterName ? stripQuery(recruiter.find('a').first().attr('href')) : null,
        isClosed: /no longer accepting applications/i.test($('.closed-job, .top-card-layout__entity-info').text()),
    };
}
