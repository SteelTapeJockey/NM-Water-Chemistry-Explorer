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
| `data/wqp-params.js` | Every Water Quality Portal parameter with New Mexico water results (2,189 names), with its parameter group and site and result counts; used by the parameter searches | yes |
| `tools/` | `build_wqp_params.py` rebuilds `data/wqp-params.js`; `build_folder.py` makes this folder from the single-file version of the explorer | no |
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

## WQP tab

- **Parameter search and group lists:** search any WQP parameter name (tritium, arsenic, "isotope"), or open a parameter group with ▶ to see the names in it. WQP files some where you might not look: tritium and carbon-14 are *Radiochemical*, and the deuterium/hydrogen ratio is *Physical*. Picking a name asks WQP which sites measured it. The map, the site count and the download can then be limited to those sites, and the download includes only the picked parameters.
- **Reported aquifer:** "Load aquifer designations" reads the aquifer and formation WQP lists for every New Mexico well and spring (about 13 MB, kept for a day). Choosing one limits the map, the count and the download. Nearly all designations are USGS; other organizations rarely give one, so their sites drop out while a choice is set.
- **Site popups:** wells and springs show the reported formation, principal aquifer, aquifer type, well depth and construction date, fetched from WQP when the popup opens. USGS sites link to their USGS Water Data page.

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

`value` and `unit` are as reported. `value_mg_L` converts mass units. `stat_value` and `stat_unit` are what the statistics and the standard comparison use: mg/L where the unit converts, otherwise the reported unit. Tritium is always in tritium units (TU); pCi/L results are converted at 1 TU = 3.19 pCi/L, and Bq/L at 1 TU = 0.118 Bq/L. Each statistic uses the most common unit in its group, and rows in other units are counted but left out.

Tritium is compared with EPA's 20,000 pCi/L (6,270 TU) and strontium-90 with 8 pCi/L, the concentrations EPA derives from its 4 mrem/yr MCL. Other added parameters have no standard. WQP rows carry `reported_aquifer` and `reported_formation`, the designations the source gives, besides `aquifer`, the location match to NMBGMR aquifer polygons.

### Duplicates and water system matching

Duplicates are removed in this order: WQP quality-control activities (blanks and spikes; field replicates are kept and labelled in `activity_type`); the same record repeated inside one source; Weaver API copies of WQP results; and the same parameter, date, value and censoring in two different sources at sites no more than 5 m apart. Different sites inside one source are never merged. The Water Quality Portal row is kept when there is one, then NMBGMR, BOR, NMED DWB, and fields the kept row lacks are filled from the removed copy. The distances are set by `XP_DUP_M` and `XP_DW_MATCH_M` in `js/app.js`.

Weaver API drinking-water samples get a water system name only when an NMED source is at the same location (within 5 m) and belongs to one system. The `pws_match` column says how each site was matched or why it was not.

The export uses the area selected in the Area tab, or all of New Mexico if none is selected.

## Updating the built-in data

- **CCR values** (once a year, after the new reports are posted): run the scripts in `ccr-pipeline/` in order: `fetch_ccr.py`, `parse_ccr.py`, `verify_ccr.py`, then `embed_ccr.py parsed.json ../data/ccr.js`. Drinking Water Watch blocks automated downloads from cloud servers, so run the fetch from your own computer.
- **Lead and copper history** (once a year): in the browser, open any Drinking Water Watch page, then for each system read `PBCUSampleSummaryResults.jsp?tinwsys_is_number=<id>&tinwsys_st_code=NM` (ids are in `data/dww-ids.js`). Keep the 90% and AL rows and write them to `data/lead-copper.js` as `{gen, s:{PWS:[[CU|PB, begin, end, samples, p90, unit, last sample, number over action level], ...]}}`. It takes about 15 minutes.
- **WQP parameter list** (now and then): `python tools/build_wqp_params.py .` from this folder downloads WQP's New Mexico summaries (a few minutes) and rewrites `data/wqp-params.js`. Which sites measured a picked parameter is always checked live, so an older list only misses parameters WQP added since.
- **Aquifers**: replace `data/aquifers.js` with a new simplified GeoJSON in the same wrapper: `(window.NMWQ_DATA = window.NMWQ_DATA || {})["aquifer-data"] = { ...FeatureCollection... };`

## Known limits

- EMNRD's server does not let other websites read it directly. The tool uses a workaround (JSONP) that could stop working if EMNRD changes its server.
- Individual lead and copper tap samples are not in the export; it uses their 90th percentile per monitoring period. A few Drinking Water Watch summaries have obvious unit errors (one copper value of 2020 mg/L); they are kept as reported.
- The layout is built for desktop screens.
