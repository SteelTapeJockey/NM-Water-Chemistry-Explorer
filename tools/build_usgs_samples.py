"""Build data/usgs-samples.js: New Mexico USGS water samples since 2024-03-11, from the USGS Samples API.

Why: on 2024-03-11 the Water Quality Portal's standard (WQX 2.2) services stopped receiving new or corrected USGS
samples. The explorer reads those services, so USGS results after that date come from this snapshot instead.

How: the Samples API is slow and often times out, so the script works in pieces of one county and one month, six
requests at once, trying each piece up to four times. Each piece's fetch date is recorded in the manifest.
On every run:
  - pieces never fetched are fetched;
  - pieces in the latest --refresh-months months (default 3) are re-fetched once they are over 20 days old, which
    picks up late and revised results;
  - every other piece is carried over from the previous snapshot (data/usgs-samples.js), so nothing is fetched twice.
If a re-fetch fails, the earlier copy is kept. With --max-minutes the script stops starting new pieces in time to
save its work; the next run continues, so the first full build (about 1,100 pieces) takes a few runs.
Fetched pieces are also kept in --work, so a run stopped part-way loses nothing.

Output (only replaced when the checks pass):
  data/usgs-samples.js            rows in WQP column names (dictionary-encoded), loaded by the explorer
  data/usgs-samples-manifest.json build date, range, totals, rows per month, fetch date of every piece, pieces missing

Usage:
  python tools/build_usgs_samples.py [--site .] [--work .usgs-pieces] [--refresh-months 3] [--max-minutes 300]
                                     [--only 2024-04:001]
The USGS API key is read from the USGS_API_KEY environment variable (optional; raises the hourly request limit).
Exit codes: 0 done; 3 the new snapshot has far fewer rows than the previous one (outputs left unchanged).
Uses only the Python standard library.
"""
import argparse, csv, datetime as dt, gzip, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

API = 'https://api.waterdata.usgs.gov/samples-data/results/basicphyschem'
START = dt.date(2024, 3, 11)                      # first day missing from WQP's standard services
# New Mexico's 33 counties by FIPS code. Mostly odd numbers, but Cibola is 006 and Los Alamos 028.
COUNTIES = ['001', '003', '005', '006', '007', '009', '011', '013', '015', '017', '019', '021', '023', '025', '027', '028', '029', '031', '033', '035', '037', '039', '041', '043', '045', '047', '049', '051', '053', '055', '057', '059', '061']
TIMEOUT, TRIES, WORKERS = 300, 4, 6
STALE_DAYS = 20                                   # re-fetch a recent piece once it is this old
DROP_LIMIT = 0.9                                  # stop if a new snapshot has under 90% of the previous one's rows
csv.field_size_limit(10**9)

# Samples API (WQX 3.0) column -> WQP (WQX 2.2) column used by the explorer. Site columns are kept as well, because
# sites first sampled after March 2024 are not in WQP's standard site list.
MAP = [
    ('Org_Identifier', 'OrganizationIdentifier'), ('Org_FormalName', 'OrganizationFormalName'),
    ('Activity_ActivityIdentifier', 'ActivityIdentifier'), ('Activity_TypeCode', 'ActivityTypeCode'),
    ('Activity_Media', 'ActivityMediaName'), ('Activity_MediaSubdivision', 'ActivityMediaSubdivisionName'),
    ('Activity_StartDate', 'ActivityStartDate'), ('Activity_StartTime', 'ActivityStartTime/Time'),
    ('Activity_StartTimeZone', 'ActivityStartTime/TimeZoneCode'),
    ('Location_Identifier', 'MonitoringLocationIdentifier'), ('Location_Name', 'MonitoringLocationName'),
    ('Location_Type', 'MonitoringLocationTypeName'), ('Location_Latitude', 'LatitudeMeasure'),
    ('Location_Longitude', 'LongitudeMeasure'), ('Location_HorzCoordReferenceSystemDatum', 'HorizontalCoordinateReferenceSystemDatumName'),
    ('Location_CountyName', 'CountyName'), ('Location_CountyCode', 'CountyCode'), ('Location_HUCEightDigitCode', 'HUCEightDigitCode'),
    ('Result_ResultDetectionCondition', 'ResultDetectionConditionText'), ('Result_Characteristic', 'CharacteristicName'),
    ('Result_SampleFraction', 'ResultSampleFractionText'), ('Result_MethodSpeciation', 'MethodSpeciationName'),
    ('Result_Measure', 'ResultMeasureValue'), ('Result_MeasureUnit', 'ResultMeasure/MeasureUnitCode'),
    ('Result_MeasureStatusIdentifier', 'ResultStatusIdentifier'), ('Result_MeasureType', 'ResultValueTypeName'),
    ('Result_WeightBasis', 'ResultWeightBasisText'), ('Result_MeasureTemperatureBasis', 'ResultTemperatureBasisText'),
    ('DataQuality_ResultComment', 'ResultCommentText'),
    ('ResultAnalyticalMethod_Identifier', 'ResultAnalyticalMethod/MethodIdentifier'),
    ('ResultAnalyticalMethod_IdentifierContext', 'ResultAnalyticalMethod/MethodIdentifierContext'),
    ('ResultAnalyticalMethod_Name', 'ResultAnalyticalMethod/MethodName'),
    ('LabInfo_AnalysisStartDate', 'AnalysisStartDate'), ('LabInfo_LaboratoryComment', 'ResultLaboratoryCommentText'),
    ('USGSpcode', 'USGSPCode'),
]
# WQP's standard file has one detection limit per row: the censoring level (A) when given, otherwise the reporting limit (B)
DL_COLS = ['DetectionQuantitationLimitTypeName', 'DetectionQuantitationLimitMeasure/MeasureValue', 'DetectionQuantitationLimitMeasure/MeasureUnitCode']
OUT_COLS = [w for _, w in MAP] + DL_COLS + ['ProviderName']
I_SITE, I_DATE, I_COUNTY = OUT_COLS.index('MonitoringLocationIdentifier'), OUT_COLS.index('ActivityStartDate'), OUT_COLS.index('CountyCode')


def months(start, end):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        first = dt.date(y, m, 1)
        nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
        yield '%04d-%02d' % (y, m), max(first, start), min(nxt - dt.timedelta(days=1), end)
        y, m = nxt.year, nxt.month


def fetch(county, lo, hi, key):
    q = urllib.parse.urlencode({'countyFips': 'US:35:' + county, 'activityStartDateLower': lo.isoformat(),
                                'activityStartDateUpper': hi.isoformat(), 'mimeType': 'text/csv'})
    req = urllib.request.Request(API + '?' + q, headers={'X-Api-Key': key} if key else {})
    last = None
    for attempt in range(TRIES):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                text = r.read().decode('utf-8', 'replace')
            if not text.startswith('Org_Identifier'):
                raise RuntimeError('unexpected reply: ' + text[:120].replace('\n', ' '))
            return text
        except Exception as e:   # timeouts, 429/5xx gateway errors, cut-off replies
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code in (400, 401, 403, 404):
                break   # a bad request or key: retrying will not help
            if attempt < TRIES - 1:
                time.sleep(30 * (attempt + 1) ** 2)
    raise RuntimeError(str(last))


def map_csv(text):
    """Water rows of one fetched piece, in OUT_COLS order."""
    out, seen = [], set()
    for r in csv.DictReader(text.splitlines()):
        if r.get('Activity_Media') != 'Water':
            continue
        rid = r.get('Result_MeasureIdentifier')
        if rid:
            if rid in seen:
                continue
            seen.add(rid)
        o = [r.get(s, '') or '' for s, _ in MAP]
        s = 'A' if (r.get('DetectionLimit_MeasureA') or '').strip() else 'B'
        o += [r.get('DetectionLimit_Type' + s, '') or '', r.get('DetectionLimit_Measure' + s, '') or '',
              r.get('DetectionLimit_MeasureUnit' + s, '') or '', 'USGS Samples API']
        out.append(o)
    return out


def load_previous(js):
    """Rows of the previous snapshot by piece, and its manifest."""
    if not os.path.exists(js):
        return {}, None
    try:
        t = open(js, encoding='utf-8').read()
        b = json.loads(t[t.index('] = ') + 4:].rstrip().rstrip(';'))
    except Exception as e:
        print('previous snapshot not readable (%s); fetching everything' % e, file=sys.stderr)
        return {}, None
    cols, by = b['cols'], {}
    pos = [cols.index(c) if c in cols else -1 for c in OUT_COLS]
    if pos[I_DATE] < 0 or pos[I_COUNTY] < 0:
        return {}, None
    for i in range(len(b['ix'][0]) if b['ix'] else 0):
        o = [b['dict'][j][b['ix'][j][i]] if j >= 0 else '' for j in pos]
        by.setdefault((o[I_DATE][:7], o[I_COUNTY]), []).append(o)
    return by, b.get('manifest')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='.', help='explorer folder; reads and writes its data/ folder')
    ap.add_argument('--work', default='.usgs-pieces', help='fetched pieces are kept here too')
    ap.add_argument('--refresh-months', type=int, default=3, help='re-fetch this many latest months once over %d days old' % STALE_DAYS)
    ap.add_argument('--max-minutes', type=float, default=0, help='stop starting new pieces after this long (0 = no limit)')
    ap.add_argument('--only', help='fetch just one piece, YYYY-MM:county, ignoring the previous snapshot (for testing)')
    a = ap.parse_args()
    key = os.environ.get('USGS_API_KEY', '').strip()
    today = dt.date.today()
    data = os.path.join(a.site, 'data')
    js = os.path.join(data, 'usgs-samples.js')
    all_months = list(months(START, today))
    refresh = {m for m, _, _ in all_months[-a.refresh_months:]} if a.refresh_months > 0 else set()
    prev_rows, prev_man = ({}, None) if a.only else load_previous(js)
    prev_fetched = (prev_man or {}).get('fetched', {})

    # where each piece comes from: 'work' (fetched into --work), 'prev' (carried over) or None (never fetched)
    state, fetched_at, jobs = {}, {}, []
    for m, lo, hi in all_months:
        for c in COUNTIES:
            k = m + ':' + c
            if a.only and a.only != k:
                continue
            ok = os.path.join(a.work, m, c + '.csv.gz.ok')
            if os.path.exists(ok):
                state[k], fetched_at[k] = 'work', open(ok).read().strip()[:10]
            elif k in prev_fetched:
                state[k], fetched_at[k] = 'prev', prev_fetched[k]
            age = (today - dt.date.fromisoformat(fetched_at[k])).days if k in fetched_at else None
            if a.only or k not in state or (m in refresh and age > STALE_DAYS):
                jobs.append((k, m, c, lo, hi))
    print('%d of %d pieces to fetch (%s)' % (len(jobs), len(all_months) * len(COUNTIES), 'with API key' if key else 'no API key'), file=sys.stderr)

    kept, skipped = [], []
    t_start = time.time()
    def run(job):
        k, m, c, lo, hi = job
        if a.max_minutes and time.time() - t_start > a.max_minutes * 60:
            skipped.append(k)   # out of time: left for the next run
            return
        t0 = time.time()
        try:
            text = fetch(c, lo, hi, key)
        except Exception as e:
            if k in state:
                kept.append({'piece': k, 'error': str(e)[:200]})
            print('  %s: FAILED (%s)%s' % (k, e, '; keeping the earlier copy' if k in state else ''), file=sys.stderr)
            return
        path = os.path.join(a.work, m, c + '.csv.gz')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with gzip.open(path + '.tmp', 'wt', encoding='utf-8') as f:
            f.write(text)
        os.replace(path + '.tmp', path)
        open(path + '.ok', 'w').write(today.isoformat())
        state[k], fetched_at[k] = 'work', today.isoformat()
        print('  %s: %d rows in %.0f s' % (k, text.count('\n') - 1, time.time() - t0), file=sys.stderr)
    with ThreadPoolExecutor(WORKERS) as ex:
        list(ex.map(run, jobs))

    # assemble
    rows, per_month, missing = [], {}, []
    for m, _, _ in all_months:
        n = 0
        for c in COUNTIES:
            k = m + ':' + c
            if a.only and a.only != k:
                continue
            if state.get(k) == 'work':
                with gzip.open(os.path.join(a.work, m, c + '.csv.gz'), 'rt', encoding='utf-8') as f:
                    got = map_csv(f.read())
            elif state.get(k) == 'prev':
                got = prev_rows.get((m, c), [])
            else:
                missing.append(k)
                continue
            rows += got
            n += len(got)
        per_month[m] = n
    rows.sort(key=lambda o: (o[I_SITE], o[I_DATE]))
    sites = len({o[I_SITE] for o in rows})

    if prev_man and prev_man.get('rows') and len(rows) < DROP_LIMIT * prev_man['rows']:
        print('STOPPED: %d rows, the previous snapshot had %d. Outputs left unchanged.' % (len(rows), prev_man['rows']), file=sys.stderr)
        sys.exit(3)

    # dictionary-encode each column: {manifest, cols, dict:[[values]], ix:[[indices]]}
    dicts, ixs = [], []
    for j in range(len(OUT_COLS)):
        d, ix, pos = [], [], {}
        for o in rows:
            v = o[j]
            if v not in pos:
                pos[v] = len(d)
                d.append(v)
            ix.append(pos[v])
        dicts.append(d)
        ixs.append(ix)
    manifest = {'built': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'source': API,
                'from': START.isoformat(), 'to': today.isoformat(), 'rows': len(rows), 'sites': sites,
                'rows_per_month': per_month, 'pieces': 1 if a.only else len(all_months) * len(COUNTIES),
                'missing_pieces': missing, 'refetch_failed_kept_earlier_copy': kept, 'api_key': bool(key),
                'fetched': {k: fetched_at[k] for k in sorted(fetched_at) if k in state}}
    os.makedirs(data, exist_ok=True)
    with open(js + '.tmp', 'w', encoding='utf-8') as f:
        f.write('(window.NMWQ_DATA = window.NMWQ_DATA || {})["usgs-samples"] = ')
        json.dump({'manifest': manifest, 'cols': OUT_COLS, 'dict': dicts, 'ix': ixs}, f, separators=(',', ':'), ensure_ascii=False)
        f.write(';\n')
    os.replace(js + '.tmp', js)
    mf = os.path.join(data, 'usgs-samples-manifest.json')
    with open(mf + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1)
    os.replace(mf + '.tmp', mf)
    print('wrote %s: %d rows, %d sites, %.1f MB. %d pieces missing (%d left for the next run), %d re-fetches failed (earlier copy kept)'
          % (js, len(rows), sites, os.path.getsize(js) / 1e6, len(missing), len(skipped), len(kept)), file=sys.stderr)


if __name__ == '__main__':
    main()
