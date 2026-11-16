#!/usr/bin/env python3
"""Packs the manager (docs/) into one gzipped page inside the firmware: web_bundle.h."""
import gzip, json, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
web = root / "docs"
html = (web / "index.html").read_text()
html = re.sub(r'<script src="[^"]+" data-web-only></script>\n?', "", html)   # the browser demo stays out
html = re.sub(r'<link [^>]*data-web-only>\n?', "", html)                       # web fonts: no internet on the WVR
html = re.sub(r'<script src="[^"]+" data-web-only></script>\n?', "", html)    # the browser demo
html = re.sub(r'<link rel="stylesheet" href="([^"?]+)(\?[^"]*)?">',
              lambda m: "<style>\n" + (web / m.group(1)).read_text() + "</style>", html)
html = re.sub(r'<script src="([^"?]+)(\?[^"]*)?"></script>',
              lambda m: "<script>\n" + (web / m.group(1)).read_text().replace("</script", "<\\/script") + "</script>", html)
data = gzip.compress(html.encode(), 9, mtime=0)
out = root / "firmware" / "RadioWVR" / "web_bundle.h"
rows = [", ".join(str(b) for b in data[i:i + 24]) for i in range(0, len(data), 24)]
out.write_text("// Made by tools/embed.py from docs/. Don't edit.\n#pragma once\n#include <stdint.h>\n"
               f"#define WEB_BUNDLE_LEN {len(data)}\nstatic const uint8_t WEB_BUNDLE[] = {{\n" + ",\n".join(rows) + "\n};\n")
print(f"web_bundle.h: {len(html)} bytes of page, {len(data)} gzipped")

# The synth's parameter table, from the one list in docs/js/synth-params.js.
src = (web / "js" / "synth-params.js").read_text()
params = json.loads(src[src.index("/*BEGIN*/") + 9:src.index("/*END*/")])
curves = {"lin": 0, "log": 1, "sq": 2, "int": 3, "list": 4}
rows = []
for p in params:
    rows.append(f'  {{ "{p["k"]}", {float(p["min"])}f, {float(p["max"])}f, {float(p["def"])}f, {curves[p["c"]]} }},')
enum = "\n".join(f"  SP_{p['k'].upper()}," for p in params)
(root / "firmware" / "RadioWVR" / "synth_params.h").write_text(
    "// Made by tools/embed.py from docs/js/synth-params.js. Don't edit.\n#pragma once\n#include <stdint.h>\n\n"
    "enum SynthCurve { SC_LIN, SC_LOG, SC_SQ, SC_INT, SC_LIST };\n"
    "struct SynthParamDef { const char* key; float min, max, def; uint8_t curve; };\n\n"
    f"enum SynthParam {{\n{enum}\n  SP_COUNT\n}};\n\n"
    "static const SynthParamDef SYNTH_PARAMS[SP_COUNT] = {\n" + "\n".join(rows) + "\n};\n")
print(f"synth_params.h: {len(params)} parameters")
