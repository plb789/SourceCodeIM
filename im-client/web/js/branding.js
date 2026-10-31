/* 品牌信息动态拉取（阶段二百七十六扩展，后台统一归口）—— 登录页/注册页共用
 * 服务端 GET /api/branding 公开读取（无登录态，仅一个单位名称字符串无敏感信息）；
 * 页面静态文案兜底：接口不可达时保持 HTML 原文不变，弱网/离线不破版。
 * 拉取成功后按元素 id 就地替换（textContent 渲染无注入面）：
 *   - brand-unit-foot  登录/注册页「安全接入」单位名称
 *   - brand-unit-about 设置页「关于-单位」单位名称（index.html 独有）
 *   - brand-copy       登录/注册页版权行「© 2026 即时通讯 · <单位>」
 * 经 I18N.t() 归口：默认文案命中语言包反查英文（与原静态行为一致），
 * 后台自定义的单位名三层兜底回退原样显示（专有名词不翻译为合理预期）。
 */
(function () {
    'use strict';

    function t(s) {
        try { return (window.I18N && window.I18N.t) ? window.I18N.t(s) : s; } catch (e) { return s; }
    }

    function apply(company) {
        if (!company) return;
        var foot = document.getElementById('brand-unit-foot');
        if (foot) foot.textContent = t(company);
        var about = document.getElementById('brand-unit-about');
        if (about) about.textContent = t(company);
        var copy = document.getElementById('brand-copy');
        if (copy) copy.textContent = t('© 2026 即时通讯 · ' + company);
    }

    function fetchBranding() {
        fetch('/api/branding', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
            // adminJSON 包装结构 {ok, data:{company}}；异常包装回退静态文案
            if (d && d.data && d.data.company) apply(d.data.company);
        }).catch(function () { /* 保持静态兜底文案，不打扰登录流程 */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fetchBranding);
    } else {
        fetchBranding();
    }
})();
