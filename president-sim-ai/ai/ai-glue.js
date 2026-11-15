/* ============================================================================
   ai-glue.js — 与原版引擎的取数胶水（必须最先加载）
   ----------------------------------------------------------------------------
   原版引擎把核心对象写成顶层 `let G`、`const UI`、`const COUNTRIES`……
   这些是「全局词法绑定」，**不是 window 的属性**，所以扩展层里不能用
   window.G / global.G 访问（会拿到 undefined）。
   本文件里没有任何同名局部变量，直接用裸标识符读它们最稳，于是把读取
   集中到这里，供其余模块通过 AIG.xxx() 调用。
   ========================================================================== */
(function () {
  'use strict';

  function safeGet(fn, fb) { try { return fn(); } catch (e) { return fb; } }

  window.AIG = {
    g: function () { return safeGet(function () { return G; }, null); },
    ui: function () { return safeGet(function () { return UI; }, null); },
    countries: function () { return safeGet(function () { return COUNTRIES; }, []); },
    states: function () { return safeGet(function () { return STATES; }, []); },
    sectors: function () { return safeGet(function () { return SECTORS; }, []); },
    issues: function () { return safeGet(function () { return ISSUES; }, []); },
    factions: function () { return safeGet(function () { return FACTIONS; }, {}); },
    months: function () { return safeGet(function () { return MONTHS_CN; }, []); },
    eraShocks: function () { return safeGet(function () { return (typeof ERA_SHOCKS !== 'undefined' ? ERA_SHOCKS : null); }, null); },
    stateById: function (id) { return safeGet(function () { return STATE_BY_ID[id]; }, null); },
    /* 常用引擎函数（函数声明是 window 属性，这里再包一层便于统一 try/catch） */
    call: function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      var fn = window[name];
      if (typeof fn !== 'function') return undefined;
      try { return fn.apply(null, args); } catch (e) { return undefined; }
    }
  };
})();
