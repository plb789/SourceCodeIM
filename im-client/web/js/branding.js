/* 品牌信息动态拉取（阶段二百七十六扩展，后台统一归口）—— 登录页/注册页共用
 * 服务端 GET /api/branding 公开读取（无登录态，仅单位名称 + 阶段号，无敏感信息）；
 * 页面静态文案兜底：接口不可达时保持 HTML 原文不变，弱网/离线不破版。
 * 拉取成功后按元素 id 就地替换（textContent 渲染无注入面）：
 *   - brand-unit-foot    登录/注册页「安全接入」单位名称
 *   - brand-unit-about   设置页「关于-单位」单位名称（index.html 独有）
 *   - brand-copy         登录/注册页版权行「© 2026 即时通讯 · <单位>」
 *   - feature-stage-about 设置页「关于-功能阶段」阶段号（数字自动转中文大写）
 * 经 I18N.t() 归口：默认文案命中语言包反查英文（与原静态行为一致），
 * 后台自定义的单位名三层兜底回退原样显示（专有名词不翻译为合理预期）。
 *
 * 阶段号自动更新机制：服务端 branding.go 里 CURRENT_STAGE 常量统一维护，
 * 每次新增功能后改那一处，所有客户端下次刷新即可自动显示最新阶段号。
 */
(function () {
    'use strict';

    function t(s) {
        try { return (window.I18N && window.I18N.t) ? window.I18N.t(s) : s; } catch (e) { return s; }
    }

    /* numToChinese 阿拉伯数字 → 中文大写（支持 0~9999；阶段号远小于此）
     * 规则：零不结尾、连零合并、十位为 1 且无前导位时省略"一"（如 15 → 十五）
     * 示例：105 → 一百零五，295 → 二百九十五，1000 → 一千 */
    function numToChinese(n) {
        if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > 9999) return '';
        if (n === 0) return '零';
        var digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
        var units = ['', '十', '百', '千'];
        var s = String(n);
        var len = s.length;
        var out = '';
        var zeroFlag = false; // 当前是否处于"零合并"状态

        for (var i = 0; i < len; i++) {
            var d = parseInt(s[i], 10);
            var unitIdx = len - 1 - i;
            var unit = units[unitIdx];

            if (d === 0) {
                zeroFlag = true;
            } else {
                // 输出前补一个零（合并连续零）
                if (zeroFlag && out !== '') out += '零';
                // 十位为 1 且无前导位时省略"一"（如 15 → 十五 而非 一十五）
                if (d === 1 && unitIdx === 1 && out === '') {
                    out += unit; // 只输出"十"
                } else {
                    out += digits[d] + unit;
                }
                zeroFlag = false;
            }
        }
        return out;
    }

    function apply(company, stage) {
        if (company) {
            var foot = document.getElementById('brand-unit-foot');
            if (foot) foot.textContent = t(company);
            var about = document.getElementById('brand-unit-about');
            if (about) about.textContent = t(company);
            var copy = document.getElementById('brand-copy');
            if (copy) copy.textContent = t(I18N.t('© 2026 即时通讯 · ') + company);
        }
        if (typeof stage === 'number' && stage > 0) {
            var stageEl = document.getElementById('feature-stage-about');
            if (stageEl) {
                var cn = numToChinese(stage);
                stageEl.textContent = t('阶段') + cn;
            }
        }
    }

    function fetchBranding() {
        fetch('/api/branding', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
            // adminJSON 包装结构 {ok, data:{company, stage}}；异常包装回退静态文案
            if (d && d.data) apply(d.data.company, d.data.stage);
        }).catch(function () { /* 保持静态兜底文案，不打扰登录流程 */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fetchBranding);
    } else {
        fetchBranding();
    }
})();
