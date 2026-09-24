// ===== 增量 MD5（纯本地实现，网盘二期大文件指纹归口） =====
// 用途：网盘上传前分块计算全文件 MD5（秒传判定 + 服务端 complete 复核），浏览器原生
// crypto.subtle 不支持 MD5，故本地实现增量算法——分块 update 逐段喂入，内存恒定（每块
// 4MB 读完即弃），大文件零卡顿。window 与 Web Worker（importScripts）双环境可用。
// 算法：RFC 1321 标准 MD5（块循环 + 小端字序），无任何外部依赖
(function (scope) {
    'use strict';

    // 单块 64 字节轮函数（标准轮序常数，勿改动）
    function md5cycle(x, k) {
        var a = x[0], b = x[1], c = x[2], d = x[3];
        a = ff(a, b, c, d, k[0], 7, -680876936);
        d = ff(d, a, b, c, k[1], 12, -389564586);
        c = ff(c, d, a, b, k[2], 17, 606105819);
        b = ff(b, c, d, a, k[3], 22, -1044525330);
        a = ff(a, b, c, d, k[4], 7, -176418897);
        d = ff(d, a, b, c, k[5], 12, 1200080426);
        c = ff(c, d, a, b, k[6], 17, -1473231341);
        b = ff(b, c, d, a, k[7], 22, -45705983);
        a = ff(a, b, c, d, k[8], 7, 1770035416);
        d = ff(d, a, b, c, k[9], 12, -1958414417);
        c = ff(c, d, a, b, k[10], 17, -42063);
        b = ff(b, c, d, a, k[11], 22, -1990404162);
        a = ff(a, b, c, d, k[12], 7, 1804603682);
        d = ff(d, a, b, c, k[13], 12, -40341101);
        c = ff(c, d, a, b, k[14], 17, -1502002290);
        b = ff(b, c, d, a, k[15], 22, 1236535329);

        a = gg(a, b, c, d, k[1], 5, -165796510);
        d = gg(d, a, b, c, k[6], 9, -1069501632);
        c = gg(c, d, a, b, k[11], 14, 643717713);
        b = gg(b, c, d, a, k[0], 20, -373897302);
        a = gg(a, b, c, d, k[5], 5, -701558691);
        d = gg(d, a, b, c, k[10], 9, 38016083);
        c = gg(c, d, a, b, k[15], 14, -660478335);
        b = gg(b, c, d, a, k[4], 20, -405537848);
        a = gg(a, b, c, d, k[9], 5, 568446438);
        d = gg(d, a, b, c, k[14], 9, -1019803690);
        c = gg(c, d, a, b, k[3], 14, -187363961);
        b = gg(b, c, d, a, k[8], 20, 1163531501);
        a = gg(a, b, c, d, k[13], 5, -1444681467);
        d = gg(d, a, b, c, k[2], 9, -51403784);
        c = gg(c, d, a, b, k[7], 14, 1735328473);
        b = gg(b, c, d, a, k[12], 20, -1926607734);

        a = hh(a, b, c, d, k[5], 4, -378558);
        d = hh(d, a, b, c, k[8], 11, -2022574463);
        c = hh(c, d, a, b, k[11], 16, 1839030562);
        b = hh(b, c, d, a, k[14], 23, -35309556);
        a = hh(a, b, c, d, k[1], 4, -1530992060);
        d = hh(d, a, b, c, k[4], 11, 1272893353);
        c = hh(c, d, a, b, k[7], 16, -155497632);
        b = hh(b, c, d, a, k[10], 23, -1094730640);
        a = hh(a, b, c, d, k[13], 4, 681279174);
        d = hh(d, a, b, c, k[0], 11, -358537222);
        c = hh(c, d, a, b, k[3], 16, -722521979);
        b = hh(b, c, d, a, k[6], 23, 76029189);
        a = hh(a, b, c, d, k[9], 4, -640364487);
        d = hh(d, a, b, c, k[12], 11, -421815835);
        c = hh(c, d, a, b, k[15], 16, 530742520);
        b = hh(b, c, d, a, k[2], 23, -995338651);

        a = ii(a, b, c, d, k[0], 6, -198630844);
        d = ii(d, a, b, c, k[7], 10, 1126891415);
        c = ii(c, d, a, b, k[14], 15, -1416354905);
        b = ii(b, c, d, a, k[5], 21, -57434055);
        a = ii(a, b, c, d, k[12], 6, 1700485571);
        d = ii(d, a, b, c, k[3], 10, -1894986606);
        c = ii(c, d, a, b, k[10], 15, -1051523);
        b = ii(b, c, d, a, k[1], 21, -2054922799);
        a = ii(a, b, c, d, k[8], 6, 1873313359);
        d = ii(d, a, b, c, k[15], 10, -30611744);
        c = ii(c, d, a, b, k[6], 15, -1560198380);
        b = ii(b, c, d, a, k[13], 21, 1309151649);
        a = ii(a, b, c, d, k[4], 6, -145523070);
        d = ii(d, a, b, c, k[11], 10, -1120210379);
        c = ii(c, d, a, b, k[2], 15, 718787259);
        b = ii(b, c, d, a, k[9], 21, -343485551);

        x[0] = add32(a, x[0]);
        x[1] = add32(b, x[1]);
        x[2] = add32(c, x[2]);
        x[3] = add32(d, x[3]);
    }

    function cmn(q, a, b, x, s, t) {
        a = add32(add32(a, q), add32(x, t));
        return add32((a << s) | (a >>> (32 - s)), b);
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

    // 64 字节块 → 16 个小端 32 位字（u8: Uint8Array）
    function md5blk(u8) {
        var blks = new Array(16), i;
        for (i = 0; i < 16; i++) {
            blks[i] = u8[i * 4] | (u8[i * 4 + 1] << 8) | (u8[i * 4 + 2] << 16) | (u8[i * 4 + 3] << 24);
        }
        return blks;
    }

    function hexByte(b) { return (b < 16 ? '0' : '') + b.toString(16); }

    function IncrementalMD5() {
        this.state = [1732584193, -271733879, -1732584194, 271733878];
        this.buf = new Uint8Array(64); // 未满块残料
        this.bufLen = 0;
        this.bytes = 0; // 已喂入总字节数（填充用 64 位位长）
    }

    // 喂入任意长度 Uint8Array（分块调用，内存恒定）
    IncrementalMD5.prototype.update = function (u8) {
        var i = 0, len = u8.length;
        this.bytes += len;
        if (this.bufLen) {
            while (this.bufLen < 64 && i < len) this.buf[this.bufLen++] = u8[i++];
            if (this.bufLen === 64) {
                md5cycle(this.state, md5blk(this.buf));
                this.bufLen = 0;
            } else {
                return this; // 残料仍未满（短块）
            }
        }
        while (i + 64 <= len) {
            md5cycle(this.state, md5blk(u8.subarray(i, i + 64)));
            i += 64;
        }
        while (i < len) this.buf[this.bufLen++] = u8[i++];
        return this;
    };

    // 取十六进制指纹（最终填充在状态副本上做，实例可继续 update 不受影响）
    IncrementalMD5.prototype.hex = function () {
        var st = [this.state[0], this.state[1], this.state[2], this.state[3]];
        var rem = this.bufLen, total = this.bytes;
        // 尾块：残料 + 0x80 + 补零到 56 + 8 字节小端位长（残料≥56 时需 128 字节双块）
        var pad = new Uint8Array(rem < 56 ? 64 : 128);
        pad.set(rem ? this.buf.subarray(0, rem) : new Uint8Array(0));
        pad[rem] = 0x80;
        var bits = total * 8; // ≤2^35（文件上限 2GB），双精度无损
        var lo = bits % 0x100000000, hi = Math.floor(bits / 0x100000000);
        pad[pad.length - 8] = lo & 0xff;
        pad[pad.length - 7] = (lo >>> 8) & 0xff;
        pad[pad.length - 6] = (lo >>> 16) & 0xff;
        pad[pad.length - 5] = (lo >>> 24) & 0xff;
        pad[pad.length - 4] = hi & 0xff;
        pad[pad.length - 3] = (hi >>> 8) & 0xff;
        pad[pad.length - 2] = (hi >>> 16) & 0xff;
        pad[pad.length - 1] = (hi >>> 24) & 0xff;
        for (var off = 0; off < pad.length; off += 64) {
            md5cycle(st, md5blk(pad.subarray(off, off + 64)));
        }
        var out = '', i, w;
        for (i = 0; i < 4; i++) {
            w = st[i];
            out += hexByte(w & 0xff) + hexByte((w >>> 8) & 0xff) +
                   hexByte((w >>> 16) & 0xff) + hexByte((w >>> 24) & 0xff);
        }
        return out;
    };

    // 对外归口：MD5Stream.create() → {update(u8), hex()}
    scope.MD5Stream = { create: function () { return new IncrementalMD5(); } };
})(typeof self !== 'undefined' ? self : this);
