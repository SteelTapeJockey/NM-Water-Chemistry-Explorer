"""Build the WQP parameter list embedded in nm-water-chemistry-explorer.html (the <script id="wqp-params"> block).

It lists every parameter (WQP characteristic name) with New Mexico water results: its parameter group(s), how many
sites measured it and how many results there are. The explorer uses it for the parameter search and the lists under
each group; which sites measured a picked parameter is always checked live, so this list only needs rebuilding now and
then (it records the date it was built).

Source: WQP summary service, period-of-record profile, water samples, one request per NM county, e.g.
  https://www.waterqualitydata.us/data/summary/monitoringLocation/search?countycode=US:35:001
      &sampleMedia=Water&dataProfile=periodOfRecord&summaryYears=all&mimeType=csv&zip=yes

Usage:
  python build_wqp_params.py nm-water-chemistry-explorer.html     # download, rebuild, update the single-file page in place
  python build_wqp_params.py path/to/nm-groundwater-chemistry-explorer   # folder version: rewrites data/wqp-params.js
  python build_wqp_params.py --json wqp_params.json                # download and write the list only
Uses only the Python standard library. Takes a few minutes (about 8 MB of zipped summaries).
"""
import csv, collections, datetime, io, json, os, re, sys, time, urllib.request, zipfile
from concurrent.futures import ThreadPoolExecutor

URL = ('https://www.waterqualitydata.us/data/summary/monitoringLocation/search?countycode=US:35:{fips}'
       '&sampleMedia=Water&dataProfile=periodOfRecord&summaryYears=all&mimeType=csv&zip=yes')
COUNTIES = ['%03d' % n for n in range(1, 62, 2)]   # New Mexico's 33 counties: 001, 003 ... 061 (odd FIPS codes)
csv.field_size_limit(10**9)


def fetch(fips):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(URL.format(fips=fips), timeout=600) as r:
                data = r.read()
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                return [z.read(n).decode('utf-8') for n in z.namelist() if n.lower().endswith('.csv')]
        except Exception as e:
            if attempt == 3:
                raise RuntimeError('county %s failed: %s' % (fips, e))
            time.sleep(10 * (attempt + 1))


def build():
    sites = collections.defaultdict(set)
    res = collections.defaultdict(collections.Counter)
    with ThreadPoolExecutor(4) as ex:
        for fips, texts in zip(COUNTIES, ex.map(fetch, COUNTIES)):
            n = 0
            for t in texts:
                for r in csv.DictReader(io.StringIO(t)):
                    name = (r.get('CharacteristicName') or '').strip()
                    if not name:
                        continue
                    group = (r.get('CharacteristicType') or '').strip() or 'Not Assigned'
                    sites[name].add(r['MonitoringLocationIdentifier'])
                    res[name][group] += int(r.get('ResultCount') or 0)
                    n += 1
            print('county', fips, n, 'rows', file=sys.stderr)
    totals = collections.Counter()
    for c in res.values():
        totals.update(c)
    groups = [g for g, _ in totals.most_common()]
    gi = {g: i for i, g in enumerate(groups)}
    p = []
    for name in sorted(res, key=lambda n: (-sum(res[n].values()), n)):
        gl = []
        for g, c in res[name].most_common():
            gl += [gi[g], c]
        p.append([name, len(sites[name]), gl])
    return {'at': datetime.date.today().isoformat(), 'g': groups, 'p': p}


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    d = build()
    blob = json.dumps(d, separators=(',', ':'), ensure_ascii=False)
    print(len(d['p']), 'parameters in', len(d['g']), 'groups,', len(blob), 'bytes', file=sys.stderr)
    if args[0] == '--json':
        open(args[1], 'w', encoding='utf-8').write(blob)
        return
    path = args[0]
    if os.path.isdir(path):   # folder version (build_folder.py): the list is data/wqp-params.js
        out = os.path.join(path, 'data', 'wqp-params.js')
        open(out, 'w', encoding='utf-8').write('(window.NMWQ_DATA = window.NMWQ_DATA || {})["wqp-params"] = %s;\n' % blob)
        print('updated', out, file=sys.stderr)
        return
    html = open(path, encoding='utf-8').read()
    pat = re.compile(r'(<script id="wqp-params" type="application/json">)(.*?)(</script>)', re.S)
    if len(pat.findall(html)) != 1:
        sys.exit('could not find exactly one <script id="wqp-params"> block in ' + path)
    safe = blob.replace('</', '<\\/')   # keep "</script>" out of the block
    html = pat.sub(lambda m: m.group(1) + safe + m.group(3), html)
    open(path, 'w', encoding='utf-8').write(html)
    print('updated', path, file=sys.stderr)


if __name__ == '__main__':
    main()
