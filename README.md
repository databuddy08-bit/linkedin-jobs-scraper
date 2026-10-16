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
| Exact job-title matching ("AI Engineer" never returns "Electrical Engineer") | ✅ | ❌ LinkedIn's fuzzy search |
| Verified work type (on-site / remote / hybrid) with the exact proof phrase | ✅ | ❌ trusts LinkedIn's filter |
| Survives throttling | ✅ session rotation + exponential backoff, falls back to card data | ❌ |

## Input

```json
{
  "jobTitles": ["Software Engineer", "Data Analyst"],
  "locations": ["London", "New York", "Berlin"],
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

Job Title, Company Name, Location, **Work Type + Work Type Evidence**, Posted Date, Posted Time, Applications Count, Salary, Benefits, Contract Type, Experience Level, Sector, Job Function, Apply Type, Apply URL, Job URL, Company URL, Poster Full Name, Poster Profile URL, Emails in Description, Description (plain text and HTML), plus company logo, recruiter title, promoted / closed flags and the search that found the job.

Export as JSON, CSV, Excel, or HTML. A `RUN_SUMMARY` record shows jobs per search and why any jobs were skipped.

## Exact job titles

LinkedIn's keyword search is fuzzy: "AI Engineer" also returns "Electrical Engineer" and "Machine Learning Engineer". This actor checks every job title against your keyword before opening the job, so mismatches are skipped and **never charged**.

- **Exact phrase** (default): the title must contain your whole keyword, words in order. "AI Engineer" keeps "Senior AI Engineer" and "Applied AI Engineer", and skips "AI Software Engineer".
- **All words, any order**: every word must be in the title. "AI Engineer" also keeps "AI Software Engineer" and "Engineer, AI Platform".
- **Off**: keep everything LinkedIn returns.
- Spelling variants count as the same: Full-Stack = Fullstack = Full Stack, A.I. = AI = Artificial Intelligence, ML = Machine Learning, Sr = Senior.
- Boolean keywords such as `python AND django` require every term; queries with `OR` / `NOT` are left as you wrote them.

## Accurate work type, experience level and job type

LinkedIn **ignores the work type, experience level and job type filters for logged-out visitors**, so most scrapers return "remote" jobs that are really on-site. This actor checks every job itself:

- **Work type** is read from the job's own post, in this order: the job title, LinkedIn workplace tags (`#LI-Remote`, `#LI-Hybrid`, `#LI-Onsite`), statements about the role ("This position is remote within the US", "hybrid, 3 days a week in the office"), then general wording in the post. `workTypeEvidence` shows the exact phrase used.
- If a post never states it, `workType` is empty. It is never guessed.
- **Experience level** and **job type** are checked against what the job page shows.
- Jobs that don't match are **skipped and not charged**, and the actor keeps searching until each search reaches your requested number.
- Turn on **Include jobs that don't state it** to also get posts that don't state the detail (many employers leave seniority as "Not Applicable").
- With a single work type selected, that word is added to the LinkedIn keyword search to find matching posts faster.

### Notes
- `applyUrl` is filled when LinkedIn shows the external link to logged-out visitors; most jobs keep it behind sign-in, so `applyType` (`external` / `easy_apply`) and `jobUrl` are always provided.
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
