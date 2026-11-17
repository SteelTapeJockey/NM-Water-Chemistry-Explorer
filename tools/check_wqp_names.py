"""Check that every WQP parameter name the explorer asks for is still in WQP's list.
WQP rejects a whole request (HTTP 400) if it contains one name it doesn't know, and it renames or retires names now and
then, so run this before uploading.   python tools/check_wqp_names.py [path to index.html or the explorer folder]
Exit code 1 if any name is missing. Uses only the Python standard library."""
import json, os, re, sys, urllib.request
path = sys.argv[1] if len(sys.argv) > 1 else '.'
files = [os.path.join(path, 'index.html'), os.path.join(path, 'js', 'app.js')] if os.path.isdir(path) else [path]
text = ''.join(open(f, encoding='utf-8').read() for f in files if os.path.exists(f))
names = set()
m = re.search(r'const CHARS = \{(.*?)\};', text, re.S)            # WQPCore.CHARS: names for "Add WQP chemistry"
if m: names |= set(re.findall(r"'([^']+)':'[a-z]+'", m.group(1)))
for m in re.finditer(r"wqp:\s*\[([^\]]*)\]", text):                  # Export tab parameters
    names |= set(re.findall(r"'([^']+)'", m.group(1)))
with urllib.request.urlopen('https://www.waterqualitydata.us/Codes/characteristicname?mimeType=json', timeout=120) as r:
    known = {c['value'] for c in json.load(r)['codes']}
bad = sorted(n for n in names if n not in known)
print('%d names checked against %d WQP names' % (len(names), len(known)))
for n in bad: print('  NOT IN WQP:', n)
sys.exit(1 if bad else 0)
