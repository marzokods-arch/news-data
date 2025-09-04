# Light News DB (v2)


This repo is a **data backend** (no UI). It:
- Discovers + ingests **hundreds+ RSS/Atom feeds**; can scale to **1,000+** using OPML imports and large seed lists
- Filters out **politics/adult/violence** (Arabic & English)
- Prioritizes **sports** every run; shards others across 5-minute cycles
- Writes a JSON API to `/docs/api/` for any downstream app/AI


## Add hundreds of feeds quickly
- Append homepages to `data/seeds/homepages.json` (any language/region/category).
- Drop OPML files into `data/opml/` — the builder will import them automatically.


## Output
- `/docs/api/latest.json` – latest combined items
- `/docs/api/categories/<cat>.json` – partitioned by category
- `/docs/api/lang/<ar|en>.json` – partitioned by language
- `/docs/api/regions/<region>.json`
- `/docs/api/days/YYYY-MM-DD.json` – daily snapshot


## Schedule
GitHub Actions runs every **5 minutes**. Sports feeds are always processed. Non-sports are divided into **5 shards** so the full set is refreshed roughly every 25 minutes (tune `SHARDS`).


## Notes
- Respects conditional GET via `ETag` and `Last-Modified` to be polite and fast.
- To hard-block politics/explicit content at source level, add substrings to `data/exclude_paths.json` and avoid politics sections.
- Use at your own risk; respect each site’s Terms.
