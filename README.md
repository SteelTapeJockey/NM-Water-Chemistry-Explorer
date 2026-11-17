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
| `data/wqp-params.js` | Every Water Quality Portal parameter with New Mexico water results (2,195 names), with its parameter group and site and result counts; used by the parameter searches | yes |
| `tools/` | `build_wqp_params.py` rebuilds `data/wqp-params.js`; `build_usgs_samples.py` builds the USGS samples snapshot (below); `check_wqp_names.py` checks that every WQP parameter name the explorer asks for still exists; `build_folder.py` makes this folder from the single-file version of the explorer | no |
| `workflows/pages.yml` | Publishes the site with GitHub Actions and updates the USGS samples snapshot (below). On GitHub it must be at `.github/workflows/pages.yml` (see the setup steps) | yes, moved |
| `data/usgs-samples.js`, `data/usgs-samples-manifest.json` | USGS samples since March 11, 2024. Made by the workflow on GitHub, not kept in this folder | made on GitHub |
| `ccr-pipeline/` | Scripts that download and read the CCR PDFs and rebuild `data/ccr.js` | no |
| `exports/` | Sample exports made with the tool | no |

The data files are scripts rather than `.json` so the page also works when opened straight from disk, where browsers block loading local JSON.

## Where the live data comes from

Everything else is fetched when you use the tool, and kept in the browser for 24 hours:

- **Weaver API** (NM Unified Water Data API, `weaver-api.newmexicowaterdata.org`): wells and their chemistry.
- **Ocotillo API** (NMBGMR's own database, `ocotillo-api.newmexicowaterdata.org/ogcapi`): construction details and the latest trace-element and isotope results for NMBGMR wells, fetched when a well's popup opens.
- **Water Quality Portal** (USGS and EPA): sites and results.
- **NMED**: drinking water sources and ten other layers.
- **NM Office of the State Engineer**: points of diversion, water rights, well logs, districts.
- **EMNRD**: oil and gas wells, spills, facilities, mines, karst, burn severity, fire perimeters.
- **NMT / NMBGMR**: Aquifer Mapping study areas.
- **Counties** (Esri) and **HUC-8 watersheds** (USGS).

## WQP tab

- **Parameter search and group lists:** search any WQP parameter name (tritium, arsenic, "isotope"), or open a parameter group with ▶ to see the names in it. WQP files some where you might not look: tritium and carbon-14 are *Radiochemical*, and the deuterium/hydrogen ratio is *Physical*. Picking a name asks WQP which sites measured it. The map, the site count and the download can then be limited to those sites, and the download includes only the picked parameters.
- **Downloads** are WQP's own result file with each site's details added after `MonitoringLocationIdentifier`: name, type, latitude, longitude, horizontal datum (NAD83, NAD27 or WGS84, as WQP reports it) and method, county, HUC-8, elevation, well and hole depth, aquifer, formation, aquifer type and construction date. WQP's result file has only the site ID, so the tool joins these from WQP's Station records. The Results CSV buttons in a site's popup give the same file for that one site. When tritium may be in the file, three columns follow WQP's unit column: `TU_Value`, `TU_DetectionLimit` and `TU_Note` (tritium in tritium units). Downloads too big for one request ask where to save, starting in Downloads.
- **Reported aquifer:** "Load aquifer designations" reads the aquifer and formation WQP lists for every New Mexico well and spring (about 13 MB, kept for a day). Choosing one limits the map, the count and the download. Nearly all designations are USGS; other organizations rarely give one, so their sites drop out while a choice is set.
- **Site popups:** wells and springs show the reported formation, principal aquifer, aquifer type, well depth and construction date, fetched from WQP when the popup opens. USGS sites link to their USGS Water Data page.

## NMBGMR well popups

Popups for NMBGMR wells (source `NMBGMR`) add two sections from the Ocotillo API, which match the Weaver API's NMBGMR well IDs (3,010 of 3,062 NMBGMR chemistry wells are in Ocotillo's well register):

- **Well construction:** the formation the well is completed in (the NMBGMR code, with its name from the USGS aquifer-code list when the code is on it, about three quarters of wells), well and hole depth, casing diameter and depth, completion date, construction method, driller and pump. Completion dates of January 1 are shown as the year only: NM_Aquifer used January 1 when only the year was known (1,774 of 4,279 dates).
- **Trace elements and isotopes** (collapsed): the most recent result for each analyte at the well, about 30 trace elements plus δ²H, δ¹⁸O, δ¹³C and carbon-14. These are mostly not in the Water Quality Portal: of the 1,882 NMBGMR wells with iron, 1,584 have no WQP iron site within 200 m, and the pattern is the same for the other elements and the isotopes. The Weaver API has no NMBGMR fluoride at all; Ocotillo has it for 2,643 wells. The section is in the popup only, not on the map or in exports, because Ocotillo has one value per analyte per well, not the sample history.

## Export samples tab

Right drawer → **Export samples**. Tick one or more parameters, choose the sources, and download. Any other WQP parameter can be added with the search box above the list. Added parameters come from WQP only; the Weaver API has none of them. The workbook has these sheets:

- **Read me**: what was pulled, when, for what area, and what every column means.
- **Summary**: counts, date range, unit, minimum, median and maximum by source, water source, county and aquifer.
- **Site summary**: one row per site and parameter.
- **Samples**: one row per laboratory result, with the same columns for every source.
- **PWS summaries**: lead and copper 90th percentiles for every monitoring period (Drinking Water Watch) and Consumer Confidence Report values, kept apart from real samples.
- **Other matrices**: results reported per mass (sediment and similar).
- **Removed duplicates**: every row taken out of Samples, with the reason and the row kept instead.

### Units and standards

`value` and `unit` are as reported, except tritium: its `value`, `unit` and detection limit are always in tritium units (TU), with the original result in `result_as_reported` and `conversion_note`. `value_mg_L` converts mass units. `stat_value` and `stat_unit` are what the statistics and the standard comparison use: mg/L where the unit converts, otherwise the reported unit. Tritium is always in tritium units (TU); pCi/L results are converted at 1 TU = 3.19 pCi/L, and Bq/L at 1 TU = 0.118 Bq/L. Each statistic uses the most common unit in its group, and rows in other units are counted but left out.

**How each well's values are worked out (map, popups, wells table, summary).** Each analyte has a maximum, mean and latest value per well, from the Weaver API's summaries. Non-detects count as 0 for every source. The API already does this for NMED DWB. The explorer does it for WQP chemistry it adds. For NMBGMR, the explorer rebuilds the wells that have non-detects from their time series, because the API counts NMBGMR non-detects at their reporting limit: a well reported as "<2.5" uranium would otherwise show 2.5 mg/L. That rebuild changed 16 arsenic and 28 uranium wells that had looked over the standard. Water type, charge balance and the Piper diagram use the latest major ions only when calcium, magnesium, sodium, bicarbonate, chloride and sulfate share a sample date (potassium and carbonate only if measured that day). Before November 14, 2026, 369 wells mixed ions from different years.

**Unit fixes in the export and in WQP chemistry on the map:** calcium reported as CaCO3 × 0.4004; bicarbonate (alkalinity) reported as CaCO3 × 1.219; uranium in pCi/L at 0.67 pCi per µg. Drinking-water non-detects written as "< MRL 1 UG/L" take the unit in the text. Before November 14, 2026, the export read them as mg/L (1,000 times too high). NMBGMR non-detects, which the API marks only in its qualifier column, are exported as censored (`censored` = <). WQP results flagged "Systematic Contamination" are left off the map.

Nitrate is as N. The Weaver API serves NMBGMR nitrate converted to nitrate as NO₃ (its `conversion_factor` 4.427) but labelled plain mg/L, so the export marks those rows `speciation` = as NO3 and `value_mg_L` converts them back to as N; the map and the well window do the same.

Tritium is compared with EPA's 20,000 pCi/L (6,270 TU) and strontium-90 with 8 pCi/L, the concentrations EPA derives from its 4 mrem/yr MCL. Other added parameters have no standard. WQP rows carry `reported_aquifer` and `reported_formation`, the designations the source gives, besides `aquifer`, the location match to NMBGMR aquifer polygons.

### Duplicates and water system matching

Duplicates are removed in this order: WQP quality-control activities (blanks and spikes; field replicates are kept and labelled in `activity_type`); the same record repeated inside one source; Weaver API copies of WQP results; and the same parameter, date, value and censoring in two different sources at sites no more than 5 m apart. Different sites inside one source are never merged. The Water Quality Portal row is kept when there is one, then NMBGMR, BOR, NMED DWB, and fields the kept row lacks are filled from the removed copy. The distances are set by `XP_DUP_M` and `XP_DW_MATCH_M` in `js/app.js`.

Weaver API drinking-water samples get a water system name only when an NMED source is at the same location (within 5 m) and belongs to one system. The `pws_match` column says how each site was matched or why it was not.

The export uses the area selected in the Area tab, or all of New Mexico if none is selected.

## Updating the built-in data

- **CCR values** (once a year, after the new reports are posted): run the scripts in `ccr-pipeline/` in order: `fetch_ccr.py`, `parse_ccr.py`, `verify_ccr.py`, then `embed_ccr.py parsed.json ../data/ccr.js`. Drinking Water Watch blocks automated downloads from cloud servers, so run the fetch from your own computer.
- **Lead and copper history** (once a year): in the browser, open any Drinking Water Watch page, then for each system read `PBCUSampleSummaryResults.jsp?tinwsys_is_number=<id>&tinwsys_st_code=NM` (ids are in `data/dww-ids.js`). Keep the 90% and AL rows and write them to `data/lead-copper.js` as `{gen, s:{PWS:[[CU|PB, begin, end, samples, p90, unit, last sample, number over action level], ...]}}`. It takes about 15 minutes.
- **Before uploading**: `python tools/check_wqp_names.py .` checks every WQP parameter name the explorer asks for against WQP's current list. WQP rejects a whole request if it contains one name it doesn't know, and it renames or retires names now and then. In November 2026 four names had gone stale, which broke "Add WQP chemistry" and the gross alpha export.
- **WQP parameter list** (now and then): `python tools/build_wqp_params.py .` from this folder downloads WQP's New Mexico summaries (a few minutes) and rewrites `data/wqp-params.js`. Which sites measured a picked parameter is always checked live, so an older list only misses parameters WQP added since.
- **Aquifers**: replace `data/aquifers.js` with a new simplified GeoJSON in the same wrapper: `(window.NMWQ_DATA = window.NMWQ_DATA || {})["aquifer-data"] = { ...FeatureCollection... };`

## Known limits

- EMNRD's server does not let other websites read it directly. The tool uses a workaround (JSONP) that could stop working if EMNRD changes its server.
- Individual lead and copper tap samples are not in the export; it uses their 90th percentile per monitoring period. A few Drinking Water Watch summaries have obvious unit errors (one copper value of 2020 mg/L); they are kept as reported.
- The layout is built for desktop screens.
- Some NMED DWB results in the Weaver API look like µg/L values labelled mg/L, e.g. arsenic 11 mg/L (well 467, 2004) and uranium 31 mg/L (well 2317, 2009). They are shown as served; check them before relying on a well's maximum.
- ISC Seven Rivers and BOR nitrate don't say whether they are as N or as NO₃; they are treated as N.
- The Weaver API's own exceedance counts (Color by → exceedances, from `nm_mcl_exceedance`) compare NMBGMR nitrate as NO₃ with the 10 mg/L as-N limit, so they overstate NMBGMR nitrate exceedances. The explorer's own exceedance counts use the corrected values.

## USGS samples after March 11, 2024

On March 11, 2024 the Water Quality Portal's standard services stopped receiving new or corrected USGS samples; USGS now publishes them through its own Samples API. The explorer reads WQP's standard services, so it has no USGS results after that date. Other organizations' WQP data are unaffected.

`tools/build_usgs_samples.py` fills the gap with a snapshot: every New Mexico USGS water sample since March 11, 2024, in WQP's column names, with each site's coordinates and datum. The Samples API is slow and often times out, so the script works one county and one month at a time, retries, keeps what it has, and carries over everything it doesn't need to re-fetch. Each piece's fetch date is in `data/usgs-samples-manifest.json`, along with any pieces still missing. The explorer does not read the snapshot yet; that comes once the first one is built.

The workflow `workflows/pages.yml` runs it on GitHub, the way the hydrograph explorer rebuilds its readings snapshot:
- every Sunday it fills in pieces never fetched and re-fetches the latest 3 months once they are over 20 days old, so in effect the snapshot refreshes monthly. The first full build (about 1,100 pieces) takes a few weekly runs; "Run workflow" on the Actions tab starts one sooner.
- a run that fails, or whose snapshot has under 90% of the previous one's rows, leaves the previous snapshot published.
- every push to `main` republishes the site with the snapshot the live site already serves.

One-time setup in the GitHub repository:
1. Put the workflow where GitHub looks for it: Add file → Create new file, name it `.github/workflows/pages.yml`, and paste in the contents of `workflows/pages.yml`. (This folder keeps it in `workflows/` because Windows tools often hide or block `.github` folders.)
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → **New repository secret**, named `USGS_API_KEY`, with your USGS API key (from api.waterdata.usgs.gov/signup). The key stays in GitHub; it is never in the page or the repository. Without it the build still runs, with a lower request limit.

To run it on your own computer instead, set the key for your account once (`setx USGS_API_KEY "your-key"` in a Windows command prompt, then open a new one) and run `python tools/build_usgs_samples.py` in this folder. Its work folder `.usgs-pieces` is listed in `.gitignore`, so it is not uploaded.
