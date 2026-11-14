/*
 * Writes a zip file (stored, not compressed: sounds hardly compress). For browsers that
 * can't write to a folder. Names are UTF-8. Up to 4 GB in all.
 */
"use strict";

var Zip = (function () {
  var table = null;
  function crc32(bytes, crc) {
    if (!table) {
      table = new Uint32Array(256);
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    crc = (crc === undefined ? 0 : crc) ^ 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function utf8(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    var u = unescape(encodeURIComponent(s)), b = new Uint8Array(u.length);
    for (var i = 0; i < u.length; i++) b[i] = u.charCodeAt(i);
    return b;
  }

  // entries: [{ name: "Doors/Slam.wav", data: Uint8Array }] -> array of Uint8Array parts (make a Blob of them)
  function build(entries, date) {
    var d = date || new Date(), parts = [], central = [], offset = 0;
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    entries.forEach(function (e) {
      var name = utf8(e.name), crc = crc32(e.data), size = e.data.length;
      if (offset + size + 30 + name.length > 0xfffffffe) throw new Error("more than 4 GB: too large for a zip");
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, e.data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
      c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + size;
    });
    var cdSize = 0;
    central.forEach(function (p) { cdSize += p.length; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return parts.concat(central, [new Uint8Array(end.buffer)]);
  }

  return { build: build, crc32: crc32 };
})();

if (typeof module !== "undefined") module.exports = Zip;
