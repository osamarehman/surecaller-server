"""Yellow Pages of Pakistan CSVs (opendata.com.pk, PDDL) -> NDJSON for cli/directory.js on stdout.

A Telephone field can hold several numbers sharing one area code, e.g. "(92-21) 5377979-5377971".
The import's phone parser drops the ones that aren't valid today (old 7-digit Karachi numbers).
Usage: python3 scripts/yellow-pages.py yp/*.csv >> directory.ndjson
"""
import csv, json, re, sys

for f in sys.argv[1:]:
    for r in csv.DictReader(open(f, encoding='utf-8', errors='replace')):
        tel, name = (r.get('Telephone') or '').strip(), (r.get('Business Name') or '').strip()
        if not tel or not name:
            continue
        cat = (r.get('Services') or '').split(',')[0].strip()[:60] or None
        m = re.search(r'\(?\s*92\s*-\s*(\d{1,4})\s*\)?', tel)
        area, rest = (m.group(1), tel[m.end():]) if m else (None, tel)
        for g in re.split(r'\D+', rest):
            if len(g) >= 10 and g.startswith('0'): p = g
            elif len(g) >= 11 and g.startswith('92'): p = '+' + g
            elif area and 5 <= len(g) <= 8: p = '+92' + area + g
            else: continue
            print(json.dumps({'phone': p, 'name': name, 'category': cat}))
