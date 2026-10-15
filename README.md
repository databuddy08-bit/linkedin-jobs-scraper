# LinkedIn Jobs Scraper – Multi Title × Multi Location (Full Details)

Scrape LinkedIn jobs for **many job titles across many locations in one run**, with the **full job page** for every result. No login, no cookies.

## Why this scraper

| | This actor | Typical scrapers |
|---|---|---|
| Titles × locations in one run | ✅ every title in every location | often one at a time |
| Paste LinkedIn search URLs | ✅ keeps all URL filters | ❌ |
| Full job description (HTML + clean text) | ✅ | partial |
| Seniority, employment type, industries, job function | ✅ | partial |
| Applicant count (number) | ✅ | text only |
| Recruiter name, title, profile | ✅ when shown | ❌ |
| Emails found in the description | ✅ | ❌ |
| Easy Apply vs External detection | ✅ | ✅ |
| Cross-search deduplication | ✅ a job appears once per run | ❌ duplicates billed |
| Exclude titles / companies (e.g. agencies) | ✅ | ❌ |
| Per-search and total result caps | ✅ predictable cost | per search only |
| Fast listing-only mode | ✅ | ❌ |
| Survives throttling | ✅ session rotation + exponential backoff, falls back to card data | ❌ |

## Input

```json
{
  "jobTitles": ["Software Engineer", "Data Analyst"],
  "locations": ["London", "New York", "Remote"],
  "postedWithin": "week",
  "workTypes": ["remote", "hybrid"],
  "experienceLevels": ["entry", "associate"],
  "maxResultsPerSearch": 200,
  "maxResultsTotal": 1000,
  "excludeCompanies": ["Jobot", "Hays"],
  "scrapeJobDetails": true
}
```

Filters: date posted (1h / 24h / week / month), work type, job type, experience level, Easy Apply only, under 10 applicants, company IDs, distance, sort order.

## Output (one row per unique job)

`jobId, title, companyName, companyUrl, companyLogo, location, workType, postedAt, postedTimeAgo, applicantsCount, applicantsText, salary, benefits, seniorityLevel, employmentType, jobFunctions, industries, applyType, applyUrl, jobUrl, descriptionText, descriptionHtml, emailsInDescription, recruiterName, recruiterTitle, recruiterProfileUrl, isPromoted, isClosed, searchKeywords, searchLocation, scrapedAt`

Export as JSON, CSV, Excel, or HTML. A `RUN_SUMMARY` record in the key-value store shows jobs per search.

### Notes
- `applyUrl` is filled when LinkedIn exposes the external link to logged-out visitors; LinkedIn currently keeps it behind sign-in for most jobs, so `applyType` (`external` / `easy_apply`) and `jobUrl` are always provided.
- `workType` is exact when you filter by a single work type; otherwise it is inferred from the title, location, and description.
- LinkedIn shows at most ~1,000 results per search. Split broad searches by location or date for more.
- Residential proxies give the best reliability at high volume.

## Pricing
Pay only for the jobs you get:

| Event | When it is charged |
|---|---|
| Actor start | Once per run |
| Job with full details | Each unique job saved with `scrapeJobDetails: true` |
| Job listing | Each unique job saved in fast listing-only mode |

- Duplicates and excluded jobs are **never charged**.
- Set **Max cost per run** and the actor stops cleanly when it is reached, keeping everything scraped so far.
