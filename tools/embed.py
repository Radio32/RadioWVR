#!/usr/bin/env python3
"""Packs the manager (docs/) into one gzipped page inside the firmware: web_bundle.h."""
import gzip, pathlib, re

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
out = root / "firmware" / "WvrRadio32" / "web_bundle.h"
rows = [", ".join(str(b) for b in data[i:i + 24]) for i in range(0, len(data), 24)]
out.write_text("// Made by tools/embed.py from docs/. Don't edit.\n#pragma once\n#include <stdint.h>\n"
               f"#define WEB_BUNDLE_LEN {len(data)}\nstatic const uint8_t WEB_BUNDLE[] = {{\n" + ",\n".join(rows) + "\n};\n")
print(f"web_bundle.h: {len(html)} bytes of page, {len(data)} gzipped")
