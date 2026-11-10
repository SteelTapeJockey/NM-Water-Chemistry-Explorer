# NM Groundwater Chemistry Explorer

A map-based tool for New Mexico groundwater chemistry. It runs entirely in the browser: there is nothing to install and no server to run.

## Open it

- **On your computer:** double-click `index.html`.
- **On GitHub Pages:** put this folder's contents in a repository, then turn on Pages (Settings → Pages → deploy from the main branch). The site opens at `index.html`.

Keep the folder structure as it is. `index.html` loads the other files by their relative paths.

## What is in the folder

| Path | What it is | Needed for the site |
|---|---|---|
| `index.html` | The page | yes |
| `css/style.css` | Styles | yes |
| `js/app.js` | All of the tool's code | yes |
| `data/aquifers.js` | NMBGMR aquifer polygons (simplified to about 50 m) | yes |
| `data/ccr.js` | Consumer Confidence Report values, 2024 and 2025, community systems | yes |
| `data/dww-ids.js` | Drinking Water Watch page numbers for each public water system | yes |
| `data/lead-copper.js` | Lead and copper 90th percentiles for every monitoring period, 875 systems, from Drinking Water Watch | yes |
| `ccr-pipeline/` | Scripts that download and read the CCR PDFs and rebuild `data/ccr.js` | no |
| `exports/` | Sample exports made with the tool | no |

The data files are scripts rather than `.json` so the page also works when opened straight from disk, where browsers block loading local JSON.

## Where the live data comes from

Everything else is fetched when you use the tool, and kept in the browser for 24 hours:

- **Weaver API** (NM Unified Water Data API): wells and their chemistry.
- **Water Quality Portal** (USGS and EPA): sites and results.
- **NMED**: drinking water sources and ten other layers.
- **NM Office of the State Engineer**: points of diversion, water rights, well logs, districts.
- **EMNRD**: oil and gas wells, spills, facilities, mines, karst, burn severity, fire perimeters.
- **NMT / NMBGMR**: Aquifer Mapping study areas.
- **Counties** (Esri) and **HUC-8 watersheds** (USGS).

## Export samples tab

Right drawer → **Export samples**. Tick one or more parameters, choose the sources, and download. The workbook has these sheets:

- **Read me**: what was pulled, when, for what area, and what every column means.
- **Summary**: counts, date range, median and maximum by source, water source, county and aquifer.
- **Site summary**: one row per site and parameter.
- **Samples**: one row per laboratory result, with the same columns for every source.
- **PWS summaries**: lead and copper 90th percentiles for every monitoring period (Drinking Water Watch) and Consumer Confidence Report values, kept apart from real samples.
- **Other matrices**: results reported per mass (sediment and similar).
- **Removed duplicates**: every row taken out of Samples, with the reason and the row kept instead.

### Duplicates and water system matching

Duplicates are removed in this order: WQP quality-control activities (blanks, spikes, replicates); the same record repeated inside one source; Weaver API copies of WQP results; and the same parameter, date, value and censoring in two different sources at sites no more than 30 m apart. Different sites inside one source are never merged. The Water Quality Portal row is kept when there is one, then NMBGMR, BOR, NMED DWB, and fields the kept row lacks are filled from the removed copy. The distances are set by `XP_DUP_M` and `XP_DW_MATCH_M` in `js/app.js`.

Weaver API drinking-water samples get a water system name only when an NMED source is at the same location (within 5 m) and belongs to one system. The `pws_match` column says how each site was matched or why it was not.

The export uses the area selected in the Area tab, or all of New Mexico if none is selected.

## Updating the built-in data

- **CCR values** (once a year, after the new reports are posted): run the scripts in `ccr-pipeline/` in order: `fetch_ccr.py`, `parse_ccr.py`, `verify_ccr.py`, then `embed_ccr.py parsed.json ../data/ccr.js`. Drinking Water Watch blocks automated downloads from cloud servers, so run the fetch from your own computer.
- **Lead and copper history** (once a year): in the browser, open any Drinking Water Watch page, then for each system read `PBCUSampleSummaryResults.jsp?tinwsys_is_number=<id>&tinwsys_st_code=NM` (ids are in `data/dww-ids.js`). Keep the 90% and AL rows and write them to `data/lead-copper.js` as `{gen, s:{PWS:[[CU|PB, begin, end, samples, p90, unit, last sample, number over action level], ...]}}`. It takes about 15 minutes.
- **Aquifers**: replace `data/aquifers.js` with a new simplified GeoJSON in the same wrapper: `(window.NMWQ_DATA = window.NMWQ_DATA || {})["aquifer-data"] = { ...FeatureCollection... };`

## Known limits

- EMNRD's server does not let other websites read it directly. The tool uses a workaround (JSONP) that could stop working if EMNRD changes its server.
- Individual lead and copper tap samples are not in the export; it uses their 90th percentile per monitoring period. A few Drinking Water Watch summaries have obvious unit errors (one copper value of 2020 mg/L); they are kept as reported.
- The layout is built for desktop screens.
