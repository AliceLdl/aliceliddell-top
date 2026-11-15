/* 打印一段真实的局势快照，用于 README 示例。用法：node tests/sample-context.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AI = path.join(__dirname, '..', 'ai');
const G = {
  y: 2004, w: 14, phase: 'presidency', ap: 6, apMax: 8,
  pres: { name: '乔治·W·布什', party: 'R', appr: 52.4, terms: 1, honeymoon: 6,
          isPlayer: true, iss: [] },
  player: { pc: 30 },
  econ: { gdp: 2.9, unemp: 5.6, infl: 2.3, sp: 1080, debt: 7.4, def: 3.5,
          conf: 54, fuel: 1.8, fedRate: 1.75 },
  caucus: { h: { D: 205, R: 230 }, s: { D: 48, R: 52 } },
  factions: { R: { est: 62, soc: 55, fiscal: 48, pop: 40 } },
  corps: { energy: 61, defense: 66, finance: 58, tech: 46, pharma: 63 },
  world: { CN: -10, RU: -22, GB: 80, IR: -72, JP: 78 },
  tension: 34, div: 41, crises: [], shocks: {},
  platform: { published: true, issues: { econ: 5, hawk: 10 } },
  log: [{ t: '你在国会联席会议发表国情咨文，提出本届政府的年度议程。' }]
};

const sandbox = {
  console, Date, Math, JSON, Number, String, Array, Object, Error, RegExp, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { readyState: 'complete', head: { appendChild() {} }, body: { appendChild() {} },
              getElementById: () => null, createElement: () => ({ style: {} }), addEventListener() {} },
  location: { search: '' }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
sandbox.__G = G;
const engine = [
  'let G = window.__G;',
  'const UI = { tab: "main" };',
  'const COUNTRIES = [{id:"CN",cn:"中国",att:"对手"},{id:"RU",cn:"俄罗斯",att:"对手"},',
  '  {id:"GB",cn:"英国",att:"盟友"},{id:"IR",cn:"伊朗",att:"敌国"},{id:"JP",cn:"日本",att:"盟友"}];',
  'const STATES = []; const STATE_BY_ID = {};',
  'const SECTORS = [{id:"energy",cn:"能源"},{id:"defense",cn:"军工"},{id:"finance",cn:"金融"},',
  '  {id:"tech",cn:"科技"},{id:"pharma",cn:"制药"}];',
  'const ISSUES = [{k:"econ",cn:"经济与税收"},{k:"hawk",cn:"外交"}];',
  'const FACTIONS = { D: [], R: [{id:"est",cn:"建制派"},{id:"soc",cn:"社会保守派"},',
  '  {id:"fiscal",cn:"财政鹰派"},{id:"pop",cn:"民粹右翼"}] };',
  'const MONTHS_CN = []; const ERA_SHOCKS = {};',
  'function dateLabel(y,w){ return y + "年三月第2周"; }'
].join('\n');
vm.runInContext(engine, sandbox, { filename: 'engine-stub.js' });
for (const f of ['ai-glue.js', 'ai-config.js', 'ai-prompt.js', 'ai-context.js']) {
  vm.runInContext(fs.readFileSync(path.join(AI, f), 'utf8'), sandbox, { filename: f });
}
console.log(sandbox.AICTX.text('national'));
