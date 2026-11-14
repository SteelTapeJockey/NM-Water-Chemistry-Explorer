"""Split the single-file explorer into a folder for GitHub Pages.
usage: python3 build_folder.py nm-water-chemistry-explorer.html out_dir
writes out_dir/index.html, css/style.css, js/app.js, data/aquifers.js, data/ccr.js, data/dww-ids.js, data/lead-copper.js, data/wqp-params.js
The data files are plain scripts (not .json) so the page also works when opened straight from disk."""
import os, re, sys
src, out = sys.argv[1], sys.argv[2]
h = open(src, encoding='utf-8').read()
for d in ('css', 'js', 'data'): os.makedirs(os.path.join(out, d), exist_ok=True)
names = {'aquifer-data': 'aquifers.js', 'ccr-data': 'ccr.js', 'dww-ids': 'dww-ids.js', 'pbcu-data': 'lead-copper.js', 'wqp-params': 'wqp-params.js'}
def data(m):
    i, body = m.group(1), m.group(2).replace('<\\/', '</')
    open(os.path.join(out, 'data', names[i]), 'w', encoding='utf-8').write('(window.NMWQ_DATA = window.NMWQ_DATA || {})["%s"] = %s;\n' % (i, body.strip()))
    return '<script src="data/%s"></script>' % names[i]
h, n = re.subn(r'<script id="(aquifer-data|ccr-data|dww-ids|pbcu-data|wqp-params)" type="application/json">(.*?)</script>', data, h, flags=re.S)
assert n == 5, n
m = re.search(r'<style>(.*?)</style>', h, re.S); assert m and len(re.findall(r'<style>', h)) == 1
open(os.path.join(out, 'css', 'style.css'), 'w', encoding='utf-8').write(m.group(1).strip() + '\n')
h = h[:m.start()] + '<link rel="stylesheet" href="css/style.css">' + h[m.end():]
ms = [x for x in re.finditer(r'<script>(.*?)</script>', h, re.S)]; assert len(ms) == 1, len(ms)
open(os.path.join(out, 'js', 'app.js'), 'w', encoding='utf-8').write(ms[0].group(1).strip() + '\n')
h = h[:ms[0].start()] + '<script src="js/app.js"></script>' + h[ms[0].end():]
open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(h)
for r, _, fs in os.walk(out):
    for f in sorted(fs): print('%9d  %s' % (os.path.getsize(os.path.join(r, f)), os.path.relpath(os.path.join(r, f), out)))
