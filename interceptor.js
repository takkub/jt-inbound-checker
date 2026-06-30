'use strict';
// NEUTERED v4.0.0 — scan flow now uses DOM automation (content.js); API verify removed.
// MD5 kept as reference; window.addEventListener for jtCheckRequest removed.
(function () {
  // Vendored MD5 — blueimp/JavaScript-MD5 (MIT License) — retained for reference
  function md5(str) {
    var utf8 = unescape(encodeURIComponent(str));
    var n = utf8.length;
    var nblk = ((n + 64) >> 9) + 1;
    var m = new Array(nblk * 16).fill(0);
    for (var i = 0; i < n; i++) m[i >> 2] |= (utf8.charCodeAt(i) & 0xff) << ((i & 3) << 3);
    m[n >> 2] |= 0x80 << ((n & 3) << 3);
    m[nblk * 16 - 2] = n << 3;

    function safeAdd(x, y) {
      var lsw = (x & 0xffff) + (y & 0xffff);
      return ((x >> 16) + (y >> 16) + (lsw >> 16)) << 16 | (lsw & 0xffff);
    }
    function rol(v, c) { return (v << c) | (v >>> (32 - c)); }
    function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var i = 0; i < m.length; i += 16) {
      var A = a, B = b, C = c, D = d;
      a=ff(a,b,c,d,m[i+0], 7,-680876936);   d=ff(d,a,b,c,m[i+1],12,-389564586);
      c=ff(c,d,a,b,m[i+2],17, 606105819);   b=ff(b,c,d,a,m[i+3],22,-1044525330);
      a=ff(a,b,c,d,m[i+4], 7,-176418897);   d=ff(d,a,b,c,m[i+5],12,1200080426);
      c=ff(c,d,a,b,m[i+6],17,-1473231341);  b=ff(b,c,d,a,m[i+7],22,-45705983);
      a=ff(a,b,c,d,m[i+8], 7,1770035416);   d=ff(d,a,b,c,m[i+9],12,-1958414417);
      c=ff(c,d,a,b,m[i+10],17,-42063);      b=ff(b,c,d,a,m[i+11],22,-1990404162);
      a=ff(a,b,c,d,m[i+12],7,1804603682);   d=ff(d,a,b,c,m[i+13],12,-40341101);
      c=ff(c,d,a,b,m[i+14],17,-1502002290); b=ff(b,c,d,a,m[i+15],22,1236535329);
      a=gg(a,b,c,d,m[i+1], 5,-165796510);   d=gg(d,a,b,c,m[i+6], 9,-1069501632);
      c=gg(c,d,a,b,m[i+11],14,643717713);   b=gg(b,c,d,a,m[i+0],20,-373897302);
      a=gg(a,b,c,d,m[i+5], 5,-701558691);   d=gg(d,a,b,c,m[i+10],9,38016083);
      c=gg(c,d,a,b,m[i+15],14,-660478335);  b=gg(b,c,d,a,m[i+4],20,-405537848);
      a=gg(a,b,c,d,m[i+9], 5,568446438);    d=gg(d,a,b,c,m[i+14],9,-1019803690);
      c=gg(c,d,a,b,m[i+3],14,-187363961);   b=gg(b,c,d,a,m[i+8],20,1163531501);
      a=gg(a,b,c,d,m[i+13],5,-1444681467);  d=gg(d,a,b,c,m[i+2], 9,-51403784);
      c=gg(c,d,a,b,m[i+7],14,1735328473);   b=gg(b,c,d,a,m[i+12],20,-1926607734);
      a=hh(a,b,c,d,m[i+5], 4,-378558);      d=hh(d,a,b,c,m[i+8],11,-2022574463);
      c=hh(c,d,a,b,m[i+11],16,1839030562);  b=hh(b,c,d,a,m[i+14],23,-35309556);
      a=hh(a,b,c,d,m[i+1], 4,-1530992060);  d=hh(d,a,b,c,m[i+4],11,1272893353);
      c=hh(c,d,a,b,m[i+7],16,-155497632);   b=hh(b,c,d,a,m[i+10],23,-1094730640);
      a=hh(a,b,c,d,m[i+13],4,681279174);    d=hh(d,a,b,c,m[i+0],11,-358537222);
      c=hh(c,d,a,b,m[i+3],16,-722521979);   b=hh(b,c,d,a,m[i+6],23,76029189);
      a=hh(a,b,c,d,m[i+9], 4,-640364487);   d=hh(d,a,b,c,m[i+12],11,-421815835);
      c=hh(c,d,a,b,m[i+15],16,530742520);   b=hh(b,c,d,a,m[i+2],23,-995338651);
      a=ii(a,b,c,d,m[i+0], 6,-198630844);   d=ii(d,a,b,c,m[i+7],10,1126891415);
      c=ii(c,d,a,b,m[i+14],15,-1416354905); b=ii(b,c,d,a,m[i+5],21,-57434055);
      a=ii(a,b,c,d,m[i+12],6,1700485571);   d=ii(d,a,b,c,m[i+3],10,-1894986606);
      c=ii(c,d,a,b,m[i+10],15,-1051523);    b=ii(b,c,d,a,m[i+1],21,-2054922799);
      a=ii(a,b,c,d,m[i+8], 6,1873313359);   d=ii(d,a,b,c,m[i+15],10,-30611744);
      c=ii(c,d,a,b,m[i+6],15,-1560198380);  b=ii(b,c,d,a,m[i+13],21,1309151649);
      a=ii(a,b,c,d,m[i+4], 6,-145523070);   d=ii(d,a,b,c,m[i+11],10,-1120210379);
      c=ii(c,d,a,b,m[i+2],15,718787259);    b=ii(b,c,d,a,m[i+9],21,-343485551);
      a = safeAdd(a, A); b = safeAdd(b, B); c = safeAdd(c, C); d = safeAdd(d, D);
    }

    var out = '';
    var s2 = [a, b, c, d];
    for (var k = 0; k < 4; k++) {
      for (var j = 0; j < 4; j++) {
        out += ('0' + ((s2[k] >>> (j << 3)) & 0xff).toString(16)).slice(-2);
      }
    }
    return out;
  }

  void md5; // suppress unused-variable warning — kept for reference only
})();
