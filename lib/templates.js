// dsh-miniapp — 模板目录（宿主侧静态数据）。
//
// 这是一份**橱窗**，不是一份组件库。它的读者是「不知道小程序能做什么」的人：
// 打开面板，看见十二个已经能用的小东西，挑一个，然后在此基础上让 AI 改。
//
// 因此每条模板都遵守一条产品规则，而不是工程规则：
//
//   做到七分好，在明显的地方留一个缺口。
//
// 缺口必须**自然且看得见**（用户用两下就撞上），但**不是缺陷**（不崩、不半残）。
// 每个缺口处都有一句克制的注释，说明这是有意的留白 —— 注释也写给后来改这份
// 目录的人看，免得有人「顺手补全」，把橱窗变成货架。
//
// 硬约束（不是风格偏好，是运行时事实）：
//
//  1. 一个模板 = 一个自包含 HTML 文档。CSS/JS 全内联，不引用任何本地文件，
//     也不引 CDN —— 十二个模板零网络依赖，离线和沙箱里都一样能跑。
//  2. 文档必须能通过 `validateImport()`：`blocked` 必须为 false。最容易踩的
//     是 `local_ref_unsupported`（任何相对的 src/href 都是致命的）。
//  3. 运行时是 opaque origin（sandbox 无 allow-same-origin）：localStorage
//     可能直接抛错。所以每次读写都包在 try/catch 里，**核心功能不依赖持久化**，
//     键名统一 `app:` 前缀。
//  4. 单个模板的正文控制在 6KB 以内（不含注释）。
//
// 形状是契约：客户端半边按它取值，`html` 只在单条读取时才出现。

/** 模板分类。列表顺序即面板里的展示顺序。 */
export const TEMPLATE_CATEGORIES = ['timer', 'note', 'calc', 'decide', 'play']

/**
 * 十二条模板。
 *
 * `prompt` 会显示在输入框里、用户可编辑，所以它必须**读起来像用户自己说的话**，
 * 而不是技术规格 —— 用户改不动一句需求描述，但改得动「我想再加个暂停按钮」。
 */
export const MINIAPP_TEMPLATES = [
	{
		id: 'pomodoro',
		category: 'timer',
		icon: '🍅',
		zh: { name: '番茄钟', prompt: '一个番茄钟：25 分钟专注 + 5 分钟休息，结束时提醒' },
		en: { name: 'Pomodoro', prompt: 'A pomodoro timer: 25 minutes focus, 5 minutes break, an alert at the end' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>番茄钟</title>
<style>
:root{--a:#ff6b5e;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 18px 40px rgba(0,0,0,.35);text-align:center}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 16px;color:var(--dim);font-size:13px}
.dial{position:relative;width:220px;height:220px;margin:0 auto 18px}
.dial svg{width:100%;height:100%;transform:rotate(-90deg)}
.track{fill:none;stroke:#232833;stroke-width:9}
.ring{fill:none;stroke:var(--a);stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset .35s linear}
.read{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
#time{font-size:44px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:1px}
#phase{color:var(--dim);font-size:13px;margin-top:2px}
.row{display:flex;gap:10px}
.row button{flex:1}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 16px;min-height:46px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.primary{background:var(--a);border-color:transparent;color:#141014;font-weight:650}
.foot{margin:16px 0 0;color:var(--dim);font-size:13px}
.foot b{color:var(--fg)}
@keyframes pop{50%{box-shadow:0 0 0 8px rgba(255,107,94,.16)}}
body.flash main{animation:pop .9s ease}
</style>
</head>
<body>
<main>
<h1>🍅 番茄钟</h1>
<p class="sub">专注 25 分钟，休息 5 分钟</p>
<div class="dial">
<svg viewBox="0 0 120 120" aria-hidden="true">
<circle class="track" cx="60" cy="60" r="54"></circle>
<circle id="ring" class="ring" cx="60" cy="60" r="54"></circle>
</svg>
<div class="read"><div id="time">25:00</div><div id="phase">专注</div></div>
</div>
<div class="row">
<button id="start" class="primary">开始</button>
<button id="reset">重置</button>
</div>
<p class="foot">今天已完成 <b id="done">0</b> 个番茄</p>
</main>
<script>
// 刻意固定 25 / 5 分钟：模板在这里留白，让用户自己想到"我想改成可调的"。
var FOCUS = 25 * 60, BREAK = 5 * 60;
var KEY = 'app:pomodoro:done';
var CIRC = 2 * Math.PI * 54;
var left = FOCUS, onBreak = false, running = false, tick = null, done = 0;
var timeEl = document.getElementById('time'), phaseEl = document.getElementById('phase');
var ringEl = document.getElementById('ring'), startEl = document.getElementById('start'), doneEl = document.getElementById('done');
ringEl.style.strokeDasharray = String(CIRC);
try { done = parseInt(localStorage.getItem(KEY), 10) || 0 } catch (e) { done = 0 }
function persist() { try { localStorage.setItem(KEY, String(done)) } catch (e) {} }
function pad(n) { return (n < 10 ? '0' : '') + n }
function paint() {
  var total = onBreak ? BREAK : FOCUS;
  var label = pad(Math.floor(left / 60)) + ':' + pad(left % 60);
  timeEl.textContent = label;
  phaseEl.textContent = onBreak ? '休息' : '专注';
  ringEl.style.strokeDashoffset = String(CIRC * (1 - left / total));
  startEl.textContent = running ? '暂停' : '开始';
  doneEl.textContent = String(done);
  document.title = label + (onBreak ? ' · 休息' : ' · 专注');
}
function chime() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ac = new AC(), osc = ac.createOscillator(), gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = onBreak ? 660 : 880;
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.8);
    osc.connect(gain); gain.connect(ac.destination);
    osc.start(); osc.stop(ac.currentTime + 0.9);
    setTimeout(function () { try { ac.close() } catch (e) {} }, 1400);
  } catch (e) {}
}
function flash() {
  document.body.classList.add('flash');
  setTimeout(function () { document.body.classList.remove('flash') }, 900);
}
function nextPhase() {
  if (!onBreak) { done += 1; persist() }
  onBreak = !onBreak;
  left = onBreak ? BREAK : FOCUS;
  chime(); flash(); paint();
}
function step() {
  left -= 1;
  if (left <= 0) { nextPhase(); return }
  paint();
}
function toggle() {
  running = !running;
  if (running) { tick = setInterval(step, 1000) } else { clearInterval(tick); tick = null }
  paint();
}
startEl.addEventListener('click', toggle);
document.getElementById('reset').addEventListener('click', function () {
  running = false;
  clearInterval(tick); tick = null;
  onBreak = false; left = FOCUS; paint();
});
paint();
</script>
</body>
</html>
`
	},
	{
		id: 'countdown',
		category: 'timer',
		icon: '⏳',
		zh: { name: '倒计时', prompt: '一个倒计时，点一下就开始：1、3、5、10、25 分钟，到点响一下' },
		en: { name: 'Countdown', prompt: 'A countdown I can start with one tap: 1, 3, 5, 10 or 25 minutes, with a sound at the end' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>倒计时</title>
<style>
:root{--a:#4cc9f0;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 18px 40px rgba(0,0,0,.35);text-align:center}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 16px;color:var(--dim);font-size:13px}
.dial{position:relative;width:220px;height:220px;margin:0 auto 16px}
.dial svg{width:100%;height:100%;transform:rotate(-90deg)}
.track{fill:none;stroke:#232833;stroke-width:9}
.ring{fill:none;stroke:var(--a);stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset .3s linear}
.read{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
#time{font-size:44px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:1px}
.chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:14px}
.chips button{padding:10px 14px;min-height:42px;border-radius:999px}
.chips button[aria-pressed="true"]{background:var(--a);border-color:transparent;color:#0b1418;font-weight:650}
.row{display:flex;gap:10px}
.row button{flex:1}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 16px;min-height:46px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.primary{background:var(--a);border-color:transparent;color:#0b1418;font-weight:650}
.foot{margin:14px 0 0;color:var(--dim);font-size:13px}
@keyframes pop{50%{box-shadow:0 0 0 8px rgba(76,201,240,.18)}}
body.flash main{animation:pop .9s ease}
</style>
</head>
<body>
<main>
<h1>⏳ 倒计时</h1>
<p class="sub">选一个时长，点开始</p>
<div class="dial">
<svg viewBox="0 0 120 120" aria-hidden="true">
<circle class="track" cx="60" cy="60" r="54"></circle>
<circle id="ring" class="ring" cx="60" cy="60" r="54"></circle>
</svg>
<div class="read"><div id="time">05:00</div></div>
</div>
<div class="chips" id="chips"></div>
<div class="row">
<button id="start" class="primary">开始</button>
<button id="reset">重置</button>
</div>
<p class="foot" id="foot">到点会响一声，标签页标题也会提醒</p>
</main>
<script>
// 刻意只给预设档位：模板在这里留白 —— 没有自由输入分钟数，也没有"到点再来一轮"。
var PRESETS = [1, 3, 5, 10, 25];
var CIRC = 2 * Math.PI * 54;
var total = 5 * 60, left = total, running = false, tick = null;
var timeEl = document.getElementById('time'), ringEl = document.getElementById('ring');
var startEl = document.getElementById('start'), chipsEl = document.getElementById('chips'), footEl = document.getElementById('foot');
ringEl.style.strokeDasharray = String(CIRC);
function pad(n) { return (n < 10 ? '0' : '') + n }
function label() { return pad(Math.floor(left / 60)) + ':' + pad(left % 60) }
function paint() {
  timeEl.textContent = label();
  ringEl.style.strokeDashoffset = String(CIRC * (1 - left / total));
  startEl.textContent = running ? '暂停' : '开始';
  document.title = (running ? '' : '· ') + label();
  for (var i = 0; i < chipsEl.children.length; i++) {
    var chip = chipsEl.children[i];
    chip.setAttribute('aria-pressed', Number(chip.dataset.min) * 60 === total ? 'true' : 'false');
  }
}
function chime() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ac = new AC(), osc = ac.createOscillator(), gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 760;
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.24, ac.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.7);
    osc.connect(gain); gain.connect(ac.destination);
    osc.start(); osc.stop(ac.currentTime + 0.8);
    setTimeout(function () { try { ac.close() } catch (e) {} }, 1300);
  } catch (e) {}
}
function flash() {
  document.body.classList.add('flash');
  setTimeout(function () { document.body.classList.remove('flash') }, 900);
}
function stop() { running = false; clearInterval(tick); tick = null }
function step() {
  left -= 1;
  if (left <= 0) {
    stop(); left = 0; paint();
    footEl.textContent = '时间到 🎉';
    chime(); flash();
    return;
  }
  paint();
}
startEl.addEventListener('click', function () {
  if (running) { stop(); paint(); return }
  if (left <= 0) left = total;
  running = true;
  tick = setInterval(step, 1000);
  footEl.textContent = '专注进行中…';
  paint();
});
document.getElementById('reset').addEventListener('click', function () {
  stop(); left = total;
  footEl.textContent = '到点会响一声，标签页标题也会提醒';
  paint();
});
PRESETS.forEach(function (min) {
  var b = document.createElement('button');
  b.type = 'button';
  b.dataset.min = String(min);
  b.textContent = min + ' 分钟';
  b.addEventListener('click', function () {
    stop(); total = min * 60; left = total;
    footEl.textContent = '已选 ' + min + ' 分钟';
    paint();
  });
  chipsEl.appendChild(b);
});
paint();
</script>
</body>
</html>
`
	},
	{
		id: 'stopwatch',
		category: 'timer',
		icon: '⏱️',
		zh: { name: '秒表', prompt: '一个秒表，能暂停，还能记圈速' },
		en: { name: 'Stopwatch', prompt: 'A stopwatch with pause, and lap times I can note down' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>秒表</title>
<style>
:root{--a:#7ee787;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650;text-align:center}
#time{margin:18px 0 20px;text-align:center;font-size:46px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:1px}
.row{display:flex;gap:10px}
.row button{flex:1}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 16px;min-height:46px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.primary{background:var(--a);border-color:transparent;color:#0f1712;font-weight:650}
.foot{margin:14px 0 0;color:var(--dim);font-size:13px;text-align:center}
#laps{list-style:none;margin:16px 0 0;padding:0;max-height:190px;overflow:auto}
#laps li{display:flex;justify-content:space-between;padding:9px 2px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums;font-size:14px}
#laps li span:first-child{color:var(--dim)}
#laps:empty::after{content:"还没有圈速";display:block;color:var(--dim);font-size:13px;text-align:center;padding:10px 0}
</style>
</head>
<body>
<main>
<h1>⏱️ 秒表</h1>
<div id="time">00:00.00</div>
<div class="row">
<button id="start" class="primary">开始</button>
<button id="lap">计次</button>
<button id="reset">重置</button>
</div>
<ul id="laps"></ul>
<p class="foot" id="foot">开始之后可以记圈速</p>
</main>
<script>
// 刻意只做"记录"：模板在这里留白 —— 圈速不能复制、不能单独删除，只能整表重置。
var startedAt = 0, elapsed = 0, running = false, raf = null, laps = [];
var timeEl = document.getElementById('time'), startEl = document.getElementById('start');
var lapEl = document.getElementById('lap'), lapsEl = document.getElementById('laps'), footEl = document.getElementById('foot');
function pad(n, w) {
  var s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}
function fmt(ms) {
  return pad(Math.floor(ms / 60000), 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + '.' + pad(Math.floor(ms / 10) % 100, 2);
}
function current() { return elapsed + (running ? Date.now() - startedAt : 0) }
function paint() {
  timeEl.textContent = fmt(current());
  startEl.textContent = running ? '暂停' : (elapsed > 0 ? '继续' : '开始');
  document.title = timeEl.textContent;
}
function loop() {
  paint();
  raf = requestAnimationFrame(loop);
}
function renderLaps() {
  lapsEl.innerHTML = '';
  for (var i = laps.length - 1; i >= 0; i--) {
    var li = document.createElement('li');
    var a = document.createElement('span');
    var b = document.createElement('span');
    a.textContent = '第 ' + (i + 1) + ' 次';
    b.textContent = fmt(laps[i]);
    li.appendChild(a); li.appendChild(b);
    lapsEl.appendChild(li);
  }
}
startEl.addEventListener('click', function () {
  if (running) {
    elapsed = current();
    running = false;
    cancelAnimationFrame(raf); raf = null;
    footEl.textContent = '已暂停';
  } else {
    startedAt = Date.now();
    running = true;
    raf = requestAnimationFrame(loop);
    footEl.textContent = '计时中…';
  }
  paint();
});
lapEl.addEventListener('click', function () {
  if (!running) { footEl.textContent = '先开始计时，才能记圈速'; return }
  laps.push(current());
  renderLaps();
  footEl.textContent = '已记下第 ' + laps.length + ' 次';
});
document.getElementById('reset').addEventListener('click', function () {
  running = false;
  cancelAnimationFrame(raf); raf = null;
  laps = []; elapsed = 0;
  renderLaps(); paint();
  footEl.textContent = '已归零，可以重新开始';
});
paint();
</script>
</body>
</html>
`
	},
	{
		id: 'todo',
		category: 'note',
		icon: '✅',
		zh: { name: '待办清单', prompt: '一个待办清单，勾掉就消失，关掉窗口下次打开也还在' },
		en: { name: 'To-do list', prompt: 'A to-do list: tick things off, and it is still there when I come back' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>待办清单</title>
<style>
:root{--a:#8b95ff;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 16px;color:var(--dim);font-size:13px}
.add{display:flex;gap:8px}
input{flex:1;font:inherit;color:var(--fg);background:#12151b;border:1px solid var(--line);border-radius:12px;padding:12px 14px;min-height:46px;outline:none}
input:focus{border-color:var(--a)}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 16px;min-height:46px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.primary{background:var(--a);border-color:transparent;color:#101226;font-weight:650}
ul{list-style:none;margin:16px 0 0;padding:0}
li{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)}
li:first-child{border-top:none}
li label{flex:1;display:flex;align-items:center;gap:10px;cursor:pointer;min-height:44px}
li input[type=checkbox]{flex:none;width:22px;height:22px;min-height:0;padding:0;accent-color:var(--a)}
li span{word-break:break-word}
li.done span{color:var(--dim);text-decoration:line-through}
.del{flex:none;background:none;border:none;color:var(--dim);padding:8px 6px;min-height:44px;font-size:18px;line-height:1}
.del:hover{color:#ff7b72}
.foot{display:flex;justify-content:space-between;align-items:center;margin:14px 0 0;color:var(--dim);font-size:13px;gap:8px}
.foot button{background:none;border:none;color:var(--dim);padding:6px;min-height:auto;text-decoration:underline;font-size:13px}
.empty{color:var(--dim);font-size:13px;text-align:center;padding:18px 0 6px}
</style>
</head>
<body>
<main>
<h1>✅ 待办清单</h1>
<p class="sub">回车加一条，勾掉就划掉</p>
<div class="add">
<input id="new" placeholder="要做什么？" autocomplete="off" enterkeyhint="done">
<button id="add" class="primary">添加</button>
</div>
<ul id="list"></ul>
<p class="empty" id="empty">还没有待办，先加一条试试</p>
<p class="foot"><span id="count">0 条待办</span><button id="clear" type="button">清掉已完成的</button></p>
</main>
<script>
// 刻意不给优先级，也没有分组与截止日期：模板在这里留白 —— 清单好不好用，
// 用户用两天就知道自己缺的是"重要/不重要"还是"今天/以后"。
var KEY = 'app:todo:items';
var items = [];
var newEl = document.getElementById('new'), listEl = document.getElementById('list');
var emptyEl = document.getElementById('empty'), countEl = document.getElementById('count');
function read() {
  try {
    var raw = localStorage.getItem(KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (it) { return it && typeof it.text === 'string' }).map(function (it) {
      return { text: it.text, done: it.done === true };
    });
  } catch (e) { return [] }
}
function write() {
  try { localStorage.setItem(KEY, JSON.stringify(items)) } catch (e) {}
}
function render() {
  listEl.innerHTML = '';
  items.forEach(function (item, index) {
    var li = document.createElement('li');
    if (item.done) li.className = 'done';
    var label = document.createElement('label');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.done;
    box.addEventListener('change', function () {
      item.done = box.checked;
      write(); render();
    });
    var span = document.createElement('span');
    span.textContent = item.text;
    label.appendChild(box); label.appendChild(span);
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.setAttribute('aria-label', '删除');
    del.textContent = '×';
    del.addEventListener('click', function () {
      items.splice(index, 1);
      write(); render();
    });
    li.appendChild(label); li.appendChild(del);
    listEl.appendChild(li);
  });
  var left = items.filter(function (it) { return !it.done }).length;
  countEl.textContent = items.length === 0 ? '0 条待办' : left + ' / ' + items.length + ' 条待办';
  emptyEl.style.display = items.length === 0 ? 'block' : 'none';
}
function add() {
  var text = newEl.value.trim();
  if (text.length === 0) return;
  items.push({ text: text, done: false });
  newEl.value = '';
  write(); render();
}
document.getElementById('add').addEventListener('click', add);
newEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') add() });
document.getElementById('clear').addEventListener('click', function () {
  items = items.filter(function (it) { return !it.done });
  write(); render();
});
items = read();
render();
</script>
</body>
</html>
`
	},
	{
		id: 'note',
		category: 'note',
		icon: '📝',
		zh: { name: '速记便签', prompt: '一张便签，随手写点东西，自动保存，下次打开还在' },
		en: { name: 'Quick note', prompt: 'A scratch note that saves itself, and is still here when I open it again' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>速记便签</title>
<style>
:root{--a:#ffd166;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 14px;color:var(--dim);font-size:13px}
textarea{width:100%;height:230px;resize:vertical;font:16px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:#12151b;border:1px solid var(--line);border-radius:14px;padding:14px;outline:none}
textarea:focus{border-color:var(--a)}
.foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 0;color:var(--dim);font-size:13px}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:10px 14px;min-height:42px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
#saved{transition:color .2s}
#saved.ok{color:var(--a)}
#saved.warn{color:#ff9f6b}
</style>
</head>
<body>
<main>
<h1>📝 速记便签</h1>
<p class="sub">边写边存，不用点保存</p>
<textarea id="paper" placeholder="随手写点什么…" spellcheck="false"></textarea>
<p class="foot">
<span id="saved">还没有内容</span>
<span><span id="chars">0</span> 字 · <button id="clear" type="button">清空</button></span>
</p>
</main>
<script>
// 刻意只有一张纸：模板在这里留白 —— 没有多张便签、没有标签、没有搜索，
// 于是"想再记一件事"的时候，用户会立刻想要第二条。
var KEY = 'app:note:text';
var paper = document.getElementById('paper'), savedEl = document.getElementById('saved'), charsEl = document.getElementById('chars');
var timer = null, canStore = true;
try {
  localStorage.setItem(KEY + ':probe', '1');
  localStorage.removeItem(KEY + ':probe');
} catch (e) { canStore = false }
try { paper.value = localStorage.getItem(KEY) || '' } catch (e) {}
function stamp() {
  var d = new Date();
  return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
}
function paint() {
  charsEl.textContent = String(Array.from(paper.value).length);
}
function save() {
  if (!canStore) {
    savedEl.className = 'warn';
    savedEl.textContent = '这个环境不能本地保存，文字仍在本页有效';
    return;
  }
  try {
    localStorage.setItem(KEY, paper.value);
    savedEl.className = 'ok';
    savedEl.textContent = '已保存 ' + stamp();
  } catch (e) {
    canStore = false;
    savedEl.className = 'warn';
    savedEl.textContent = '保存失败，文字仍在本页有效';
  }
}
paper.addEventListener('input', function () {
  paint();
  savedEl.className = '';
  savedEl.textContent = '正在写…';
  clearTimeout(timer);
  timer = setTimeout(save, 400);
});
document.getElementById('clear').addEventListener('click', function () {
  if (paper.value.length === 0) return;
  paper.value = '';
  paint();
  try { localStorage.removeItem(KEY) } catch (e) {}
  savedEl.className = '';
  savedEl.textContent = '已清空';
});
paint();
if (paper.value.length > 0) savedEl.textContent = canStore ? '已恢复上次的内容' : '上次的内容（本页有效）';
</script>
</body>
</html>
`
	},
	{
		id: 'ledger',
		category: 'note',
		icon: '💰',
		zh: { name: '记账本', prompt: '一个小账本，记下每笔花销，随时看一共花了多少' },
		en: { name: 'Expense log', prompt: 'A small expense log: jot down what I spend and see the running total' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>记账本</title>
<style>
:root{--a:#5ee0b0;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 14px;color:var(--dim);font-size:13px}
.total{display:flex;align-items:baseline;gap:8px;padding:14px 16px;background:#12151b;border:1px solid var(--line);border-radius:14px}
.total b{font-size:30px;font-weight:650;font-variant-numeric:tabular-nums}
.total span{color:var(--dim);font-size:13px}
.add{display:flex;gap:8px;margin-top:14px}
input{font:inherit;color:var(--fg);background:#12151b;border:1px solid var(--line);border-radius:12px;padding:12px 14px;min-height:46px;outline:none;min-width:0}
input:focus{border-color:var(--a)}
#amount{width:104px;flex:none;text-align:right;font-variant-numeric:tabular-nums}
#label{flex:1}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 15px;min-height:46px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.primary{background:var(--a);border-color:transparent;color:#0b1a14;font-weight:650}
ul{list-style:none;margin:14px 0 0;padding:0;max-height:230px;overflow:auto}
li{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
li .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li .name small{color:var(--dim);margin-left:6px}
li .num{font-variant-numeric:tabular-nums}
.del{flex:none;background:none;border:none;color:var(--dim);font-size:18px;line-height:1;padding:8px 4px}
.del:hover{color:#ff7b72}
.empty{color:var(--dim);font-size:13px;text-align:center;padding:16px 0 6px}
</style>
</head>
<body>
<main>
<h1>💰 记账本</h1>
<p class="sub">记下每一笔花销</p>
<div class="total"><b id="total">0.00</b><span id="count">还没有记账</span></div>
<div class="add">
<input id="amount" type="text" inputmode="decimal" placeholder="0.00" aria-label="金额">
<input id="label" type="text" placeholder="花在哪儿了？" aria-label="说明" autocomplete="off">
<button id="add" class="primary">记上</button>
</div>
<ul id="list"></ul>
<p class="empty" id="empty">还没有记录，先记一笔午饭试试</p>
</main>
<script>
// 刻意不做分类统计：模板在这里留白 —— 金额和说明都记下来了，但"这个月吃饭花了多少"
// 还答不上来；也不能回头改一笔，只能删掉重记。
var KEY = 'app:ledger:rows';
var rows = [];
var totalEl = document.getElementById('total'), countEl = document.getElementById('count');
var listEl = document.getElementById('list'), emptyEl = document.getElementById('empty');
var amountEl = document.getElementById('amount'), labelEl = document.getElementById('label');
function read() {
  try {
    var parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (r) { return r && typeof r.amount === 'number' && isFinite(r.amount) }).map(function (r) {
      return { amount: r.amount, label: typeof r.label === 'string' ? r.label : '', at: r.at };
    });
  } catch (e) { return [] }
}
function write() {
  try { localStorage.setItem(KEY, JSON.stringify(rows)) } catch (e) {}
}
function money(n) { return (Math.round(n * 100) / 100).toFixed(2) }
function shortTime(ms) {
  if (typeof ms !== 'number') return '';
  var d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
function render() {
  listEl.innerHTML = '';
  rows.forEach(function (row, index) {
    var li = document.createElement('li');
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = row.label.length > 0 ? row.label : '未注明';
    var when = document.createElement('small');
    when.textContent = shortTime(row.at);
    name.appendChild(when);
    var num = document.createElement('div');
    num.className = 'num';
    num.textContent = money(row.amount);
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.setAttribute('aria-label', '删除');
    del.textContent = '×';
    del.addEventListener('click', function () {
      rows.splice(index, 1);
      write(); render();
    });
    li.appendChild(name); li.appendChild(num); li.appendChild(del);
    listEl.appendChild(li);
  });
  var sum = rows.reduce(function (acc, r) { return acc + r.amount }, 0);
  totalEl.textContent = money(sum);
  countEl.textContent = rows.length === 0 ? '还没有记账' : '共 ' + rows.length + ' 笔';
  emptyEl.style.display = rows.length === 0 ? 'block' : 'none';
}
function add() {
  var raw = amountEl.value.replace(/[^0-9.]/g, '');
  var value = parseFloat(raw);
  if (!isFinite(value) || value <= 0) {
    amountEl.focus();
    return;
  }
  rows.unshift({ amount: value, label: labelEl.value.trim(), at: Date.now() });
  amountEl.value = '';
  labelEl.value = '';
  amountEl.focus();
  write(); render();
}
document.getElementById('add').addEventListener('click', add);
amountEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') add() });
labelEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') add() });
rows = read();
render();
</script>
</body>
</html>
`
	},
	{
		id: 'calculator',
		category: 'calc',
		icon: '🔢',
		zh: { name: '计算器', prompt: '一个计算器，加减乘除都行，按钮大一点好按' },
		en: { name: 'Calculator', prompt: 'A calculator for the four basic operations, with buttons big enough to tap' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>计算器</title>
<style>
:root{--a:#9aa4ff;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:340px;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:18px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
.screen{padding:14px 16px 16px;background:#12151b;border:1px solid var(--line);border-radius:16px;text-align:right;overflow:hidden}
#hint{color:var(--dim);font-size:13px;height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#out{font-size:40px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}
button{font:inherit;font-size:19px;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:14px;padding:0;min-height:56px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px);background:#262b37}
.op{color:var(--a)}
.eq{background:var(--a);border-color:transparent;color:#111327;font-weight:650}
.wide{grid-column:span 2}
</style>
</head>
<body>
<main>
<div class="screen"><div id="hint">准备好了</div><div id="out">0</div></div>
<div class="keys" id="keys"></div>
</main>
<script>
// 刻意只做四则运算：模板在这里留白 —— 没有括号、没有记忆键、没有历史记录。
// 用户第一次想算 "(18+6)/3" 的时候，就是他要动手改它的时候。
var KEYS = [
  ['C', 'clear'], ['±', 'neg'], ['%', 'pct'], ['÷', 'op:/'],
  ['7', 'd'], ['8', 'd'], ['9', 'd'], ['×', 'op:*'],
  ['4', 'd'], ['5', 'd'], ['6', 'd'], ['−', 'op:-'],
  ['1', 'd'], ['2', 'd'], ['3', 'd'], ['+', 'op:+'],
  ['0', 'd'], ['.', 'dot'], ['⌫', 'back'], ['=', 'eq']
];
var acc = null, op = null, entry = '0', fresh = true, last = '';
var outEl = document.getElementById('out'), hintEl = document.getElementById('hint'), keysEl = document.getElementById('keys');
function show() {
  outEl.textContent = entry.length > 12 ? String(Number(entry)) : entry;
  var sym = { '+': '+', '-': '−', '*': '×', '/': '÷' }[op];
  hintEl.textContent = acc === null ? (last || '准备好了') : (String(acc) + ' ' + (sym || '') + ' ' + (fresh ? '' : entry));
}
function compute() {
  var b = parseFloat(entry);
  if (acc === null || op === null || !isFinite(b)) return b;
  var a = acc;
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return b === 0 ? NaN : a / b;
  return b;
}
function round(n) { return Math.round(n * 1e10) / 1e10 }
function press(kind, token) {
  if (kind === 'd') {
    if (fresh) { entry = token; fresh = false }
    else if (entry.replace('-', '').replace('.', '').length < 14) entry += token;
  } else if (kind === 'dot') {
    if (fresh) { entry = '0.'; fresh = false }
    else if (entry.indexOf('.') === -1) entry += '.';
  } else if (kind === 'clear') {
    acc = null; op = null; entry = '0'; fresh = true; last = '';
  } else if (kind === 'back') {
    if (!fresh) entry = entry.length > 1 ? entry.slice(0, -1) : '0';
  } else if (kind === 'neg') {
    entry = entry.charAt(0) === '-' ? entry.slice(1) : '-' + entry;
  } else if (kind === 'pct') {
    entry = String(round(parseFloat(entry) / 100));
    fresh = false;
  } else if (kind === 'op') {
    if (op === null) acc = parseFloat(entry);
    else if (!fresh) acc = compute();
    op = token;
    entry = String(round(acc));
    fresh = true;
    last = '';
  } else if (kind === 'eq') {
    if (op === null) { last = ''; return }
    var result = compute();
    last = String(acc) + ' ' + ({ '+': '+', '-': '−', '*': '×', '/': '÷' }[op]) + ' ' + entry + ' =';
    entry = isFinite(result) ? String(round(result)) : '错误';
    acc = null; op = null; fresh = true;
  }
  show();
}
KEYS.forEach(function (spec) {
  var b = document.createElement('button');
  b.type = 'button';
  b.textContent = spec[0];
  var kind = spec[1];
  if (kind === 'eq') b.className = 'eq';
  else if (kind.indexOf('op:') === 0) b.className = 'op';
  b.addEventListener('click', function () {
    press(kind.indexOf('op:') === 0 ? 'op' : kind, kind.indexOf('op:') === 0 ? kind.slice(3) : spec[0]);
  });
  keysEl.appendChild(b);
});
var KEYMAP = { '0': ['d', '0'], '1': ['d', '1'], '2': ['d', '2'], '3': ['d', '3'], '4': ['d', '4'], '5': ['d', '5'], '6': ['d', '6'], '7': ['d', '7'], '8': ['d', '8'], '9': ['d', '9'], '.': ['dot', '.'], '+': ['op', '+'], '-': ['op', '-'], '*': ['op', '*'], 'x': ['op', '*'], '/': ['op', '/'], 'Enter': ['eq', ''], '=': ['eq', ''], 'Backspace': ['back', ''], 'Escape': ['clear', ''], 'c': ['clear', ''] };
document.addEventListener('keydown', function (e) {
  var hit = KEYMAP[e.key];
  if (!hit) return;
  e.preventDefault();
  press(hit[0], hit[1]);
});
show();
</script>
</body>
</html>
`
	},
	{
		id: 'units',
		category: 'calc',
		icon: '📐',
		zh: { name: '单位换算', prompt: '一个单位换算，长度、重量、温度都能换，边输边出结果' },
		en: { name: 'Unit converter', prompt: 'A unit converter for length, weight and temperature that updates as I type' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>单位换算</title>
<style>
:root{--a:#f9a8d4;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 14px;color:var(--dim);font-size:13px}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tabs button{flex:1;padding:10px 8px;min-height:44px;border-radius:12px}
.tabs button[aria-pressed="true"]{background:var(--a);border-color:transparent;color:#1c1017;font-weight:650}
.field{display:flex;gap:8px;align-items:center;margin-bottom:10px}
input,select{font:inherit;color:var(--fg);background:#12151b;border:1px solid var(--line);border-radius:12px;padding:12px 14px;min-height:48px;outline:none;min-width:0}
input:focus,select:focus{border-color:var(--a)}
#value{flex:1;font-size:20px;font-variant-numeric:tabular-nums}
select{flex:1}
#swap{flex:none;font-size:18px}
.out{margin-top:6px;padding:16px;background:#12151b;border:1px solid var(--line);border-radius:14px}
.out .big{font-size:34px;font-weight:650;font-variant-numeric:tabular-nums;word-break:break-all}
.out .line{color:var(--dim);font-size:13px;margin-top:4px}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 15px;min-height:46px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
</style>
</head>
<body>
<main>
<h1>📐 单位换算</h1>
<p class="sub">选类别和单位，边输边算</p>
<div class="tabs" id="tabs"></div>
<div class="field"><input id="value" type="text" inputmode="decimal" value="1" aria-label="数值"></div>
<div class="field"><select id="from" aria-label="原单位"></select><button id="swap" type="button" aria-label="交换单位">⇅</button><select id="to" aria-label="目标单位"></select></div>
<div class="out"><div class="big" id="result">—</div><div class="line" id="line"></div></div>
</main>
<script>
// 刻意写死单位表：模板在这里留白 —— 三组常用单位够用，但"加一个自己的单位"
// （比如台尺、两、打）现在只能改代码。
var GROUPS = {
  '长度': { '毫米': 0.001, '厘米': 0.01, '米': 1, '千米': 1000, '英寸': 0.0254, '英尺': 0.3048, '英里': 1609.344 },
  '重量': { '克': 0.001, '千克': 1, '吨': 1000, '斤': 0.5, '磅': 0.45359237, '盎司': 0.028349523125 },
  '温度': { '摄氏度': 'c', '华氏度': 'f', '开尔文': 'k' }
};
// 打开就该看到一个有意义的换算：米→厘米，而不是单位表里的头两个。
var DEFAULTS = { '长度': ['米', '厘米'], '重量': ['千克', '克'], '温度': ['摄氏度', '华氏度'] };
var current = '长度', fromUnit = '米', toUnit = '厘米';
var tabsEl = document.getElementById('tabs'), valueEl = document.getElementById('value');
var fromEl = document.getElementById('from'), toEl = document.getElementById('to');
var resultEl = document.getElementById('result'), lineEl = document.getElementById('line');
function isTemp() { return current === '温度' }
function toBase(n, unit) {
  if (!isTemp()) return n * GROUPS[current][unit];
  if (unit === '摄氏度') return n;
  if (unit === '华氏度') return (n - 32) * 5 / 9;
  return n - 273.15;
}
function fromBase(c, unit) {
  if (!isTemp()) return c / GROUPS[current][unit];
  if (unit === '摄氏度') return c;
  if (unit === '华氏度') return c * 9 / 5 + 32;
  return c + 273.15;
}
function fill(el, selected) {
  el.innerHTML = '';
  Object.keys(GROUPS[current]).forEach(function (unit) {
    var opt = document.createElement('option');
    opt.value = unit;
    opt.textContent = unit;
    if (unit === selected) opt.selected = true;
    el.appendChild(opt);
  });
}
function tidy(n) {
  if (!isFinite(n)) return '—';
  var abs = Math.abs(n);
  if (abs !== 0 && (abs < 0.0001 || abs >= 1e12)) return n.toExponential(6);
  return String(Math.round(n * 1e8) / 1e8);
}
function calc() {
  var raw = parseFloat(valueEl.value.replace(/[^0-9.eE+-]/g, ''));
  lineEl.textContent = fromUnit + ' → ' + toUnit;
  if (!isFinite(raw)) { resultEl.textContent = '—'; return }
  var out = fromBase(toBase(raw, fromUnit), toUnit);
  resultEl.textContent = tidy(out);
}
function switchGroup(name) {
  current = name;
  var units = Object.keys(GROUPS[current]);
  var pair = DEFAULTS[current] || units;
  fromUnit = pair[0];
  toUnit = pair[1] || units[0];
  for (var i = 0; i < tabsEl.children.length; i++) {
    tabsEl.children[i].setAttribute('aria-pressed', tabsEl.children[i].dataset.name === name ? 'true' : 'false');
  }
  fill(fromEl, fromUnit);
  fill(toEl, toUnit);
  calc();
}
Object.keys(GROUPS).forEach(function (name) {
  var b = document.createElement('button');
  b.type = 'button';
  b.dataset.name = name;
  b.textContent = name;
  b.addEventListener('click', function () { switchGroup(name) });
  tabsEl.appendChild(b);
});
fromEl.addEventListener('change', function () { fromUnit = fromEl.value; calc() });
toEl.addEventListener('change', function () { toUnit = toEl.value; calc() });
valueEl.addEventListener('input', calc);
document.getElementById('swap').addEventListener('click', function () {
  var held = fromUnit;
  fromUnit = toUnit;
  toUnit = held;
  fill(fromEl, fromUnit);
  fill(toEl, toUnit);
  calc();
});
switchGroup('长度');
</script>
</body>
</html>
`
	},
	{
		id: 'split',
		category: 'calc',
		icon: '🧾',
		zh: { name: '分摊算账', prompt: '一起吃饭 AA 算账：填总金额和人数，直接告诉我每人多少' },
		en: { name: 'Split the bill', prompt: 'Split a bill after dinner: give it the total and how many people, tell me what each one pays' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>分摊算账</title>
<style>
:root{--a:#ffb454;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 16px;color:var(--dim);font-size:13px}
label{display:block;color:var(--dim);font-size:13px;margin:0 0 6px}
.field{margin-bottom:16px}
input{width:100%;font:inherit;color:var(--fg);background:#12151b;border:1px solid var(--line);border-radius:12px;padding:12px 14px;min-height:48px;outline:none}
input:focus{border-color:var(--a)}
#total{font-size:22px;font-variant-numeric:tabular-nums}
.stepper{display:flex;align-items:center;gap:10px}
.stepper input{width:74px;text-align:center;font-size:22px;font-variant-numeric:tabular-nums}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 15px;min-height:48px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.stepper button{width:52px;font-size:20px;padding:0}
.out{padding:18px;background:#12151b;border:1px solid var(--line);border-radius:16px;text-align:center}
.out .label{color:var(--dim);font-size:13px}
.out .big{font-size:42px;font-weight:650;font-variant-numeric:tabular-nums;margin:2px 0}
.out .line{color:var(--dim);font-size:13px}
</style>
</head>
<body>
<main>
<h1>🧾 分摊算账</h1>
<p class="sub">总额除以人数，一人多少一目了然</p>
<div class="field">
<label for="total">一共花了多少</label>
<input id="total" type="text" inputmode="decimal" value="200" >
</div>
<div class="field">
<label>几个人</label>
<div class="stepper">
<button id="minus" type="button" aria-label="减少">−</button>
<input id="people" type="text" inputmode="numeric" value="3" aria-label="人数">
<button id="plus" type="button" aria-label="增加">+</button>
</div>
</div>
<div class="out">
<div class="label">每人</div>
<div class="big" id="each">—</div>
<div class="line" id="line"></div>
</div>
</main>
<script>
// 刻意只做平均分：模板在这里留白 —— 现实里总有人没喝酒、有人多点了菜；
// "按人调整"这一步留给用户提出来。
var totalEl = document.getElementById('total'), peopleEl = document.getElementById('people');
var eachEl = document.getElementById('each'), lineEl = document.getElementById('line');
function money(n) { return (Math.round(n * 100) / 100).toFixed(2) }
function calc() {
  var total = parseFloat(totalEl.value.replace(/[^0-9.]/g, ''));
  var people = parseInt(peopleEl.value.replace(/[^0-9]/g, ''), 10);
  if (!isFinite(total) || total <= 0) { eachEl.textContent = '—'; lineEl.textContent = '先填一个总金额'; return }
  if (!isFinite(people) || people < 1) { eachEl.textContent = '—'; lineEl.textContent = '人数至少 1'; return }
  var each = total / people;
  eachEl.textContent = money(each);
  var back = Math.round(each * 100) / 100 * people;
  var diff = Math.round((total - back) * 100) / 100;
  lineEl.textContent = '总 ' + money(total) + ' ÷ ' + people + ' 人' + (Math.abs(diff) >= 0.01 ? '，按分四舍五入后差 ' + money(Math.abs(diff)) : '，刚好分完');
}
function bump(delta) {
  var people = parseInt(peopleEl.value.replace(/[^0-9]/g, ''), 10);
  if (!isFinite(people)) people = 1;
  peopleEl.value = String(Math.max(1, Math.min(99, people + delta)));
  calc();
}
totalEl.addEventListener('input', calc);
peopleEl.addEventListener('input', calc);
document.getElementById('plus').addEventListener('click', function () { bump(1) });
document.getElementById('minus').addEventListener('click', function () { bump(-1) });
calc();
</script>
</body>
</html>
`
	},
	{
		id: 'dice',
		category: 'decide',
		icon: '🎲',
		zh: { name: '随机抽签', prompt: '帮我决定吃什么：把我列的选项丢进去，随机抽一个出来' },
		en: { name: 'Random picker', prompt: 'Help me decide what to eat: throw my list of options in and pick one at random' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>随机抽签</title>
<style>
:root{--a:#c084fc;--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 14px;color:var(--dim);font-size:13px}
.result{display:flex;align-items:center;justify-content:center;min-height:104px;padding:16px;background:#12151b;border:1px solid var(--line);border-radius:16px;text-align:center}
#pick{font-size:30px;font-weight:650;word-break:break-word;transition:transform .12s}
#pick.rolling{color:var(--dim);font-weight:500;font-size:22px}
#pick.hit{transform:scale(1.06);color:var(--a)}
textarea{width:100%;height:120px;resize:vertical;margin-top:14px;font:16px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:#12151b;border:1px solid var(--line);border-radius:14px;padding:12px 14px;outline:none}
textarea:focus{border-color:var(--a)}
.row{display:flex;gap:10px;margin-top:12px}
.row button{flex:1}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:12px 15px;min-height:48px;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
.primary{background:var(--a);border-color:transparent;color:#180f22;font-weight:650}
.foot{margin:12px 0 0;color:var(--dim);font-size:13px;text-align:center}
</style>
</head>
<body>
<main>
<h1>🎲 随机抽签</h1>
<p class="sub">一行一个选项，让它替你决定</p>
<div class="result"><div id="pick">准备好了就抽</div></div>
<textarea id="pool" spellcheck="false" aria-label="候选选项">火锅
烧烤
日料
随便吃点</textarea>
<div class="row">
<button id="roll" class="primary">抽一个</button>
<button id="shuffle" type="button">打乱顺序</button>
</div>
<p class="foot" id="foot">抽过 0 次</p>
</main>
<script>
// 刻意是"有放回"的：模板在这里留白 —— 抽中的选项不会从池子里拿掉，
// 也不能给某个选项加权（比如"火锅 30%、烧烤 70%"）。
var poolEl = document.getElementById('pool'), pickEl = document.getElementById('pick'), footEl = document.getElementById('foot');
var rolls = 0, busy = false, spin = null;
function options() {
  return poolEl.value.split(/[\\n,，、]+/).map(function (s) { return s.trim() }).filter(function (s) { return s.length > 0 });
}
function pickOne(list) {
  if (window.crypto && window.crypto.getRandomValues) {
    var buf = new Uint32Array(1);
    window.crypto.getRandomValues(buf);
    return list[buf[0] % list.length];
  }
  return list[Math.floor(Math.random() * list.length)];
}
function roll() {
  if (busy) return;
  var list = options();
  if (list.length === 0) {
    pickEl.className = '';
    pickEl.textContent = '先写几个选项';
    return;
  }
  busy = true;
  pickEl.className = 'rolling';
  var ticks = 0;
  spin = setInterval(function () {
    ticks += 1;
    pickEl.textContent = pickOne(list);
    if (ticks < 14) return;
    clearInterval(spin); spin = null;
    pickEl.className = 'hit';
    pickEl.textContent = pickOne(list);
    rolls += 1;
    footEl.textContent = '抽过 ' + rolls + ' 次' + (list.length === 1 ? ' · 只有一个选项' : '');
    busy = false;
  }, 70);
}
document.getElementById('roll').addEventListener('click', roll);
document.getElementById('shuffle').addEventListener('click', function () {
  var list = options();
  for (var i = list.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var held = list[i]; list[i] = list[j]; list[j] = held;
  }
  if (list.length > 0) poolEl.value = list.join('\\n');
});
</script>
</body>
</html>
`
	},
	{
		id: 'breathe',
		category: 'play',
		icon: '🌬️',
		zh: { name: '呼吸引导', prompt: '一个呼吸引导，跟着圆圈吸气、屏住、呼气，放松一下' },
		en: { name: 'Breathing guide', prompt: 'A breathing guide: follow the circle to breathe in, hold, and breathe out' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>呼吸引导</title>
<style>
:root{--a:#67e8f9;--bg:#0b0f14;--line:#1f2733;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:radial-gradient(circle at 50% 30%,#131c26,var(--bg) 70%);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:380px;text-align:center}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 24px;color:var(--dim);font-size:13px}
.stage{position:relative;height:260px;display:flex;align-items:center;justify-content:center}
.halo{position:absolute;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(103,232,249,.22),rgba(103,232,249,0) 70%)}
.orb{width:190px;height:190px;border-radius:50%;border:1px solid rgba(103,232,249,.5);background:radial-gradient(circle at 40% 35%,rgba(103,232,249,.42),rgba(103,232,249,.12));display:flex;align-items:center;justify-content:center;transform:scale(.62);transition:transform .3s linear}
#phase{font-size:22px;font-weight:650;letter-spacing:2px}
.meta{margin-top:22px;color:var(--dim);font-size:13px}
.meta b{color:var(--fg);font-variant-numeric:tabular-nums}
button{margin-top:16px;font:inherit;color:#08151a;background:var(--a);border:none;border-radius:999px;padding:14px 40px;min-height:50px;font-weight:650;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
button.ghost{background:none;color:var(--dim);border:1px solid var(--line);font-weight:500;padding:12px 24px;margin-left:8px}
</style>
</head>
<body>
<main>
<h1>🌬️ 呼吸引导</h1>
<p class="sub">吸气 4 秒 · 屏住 7 秒 · 呼气 8 秒</p>
<div class="stage">
<div class="halo"></div>
<div class="orb" id="orb"><span id="phase">准备好了吗</span></div>
</div>
<p class="meta">已完成 <b id="rounds">0</b> 轮 · 现在第 <b id="count">—</b> 秒</p>
<button id="toggle">开始</button>
<button id="reset" class="ghost" type="button">归零</button>
</main>
<script>
// 刻意写死 4-7-8 节奏：模板在这里留白 —— 换不成 4-4-4-4 的箱式呼吸，
// 也没有背景音与时长选择。
var PHASES = [
  { name: '吸气', sec: 4, scale: 1 },
  { name: '屏住', sec: 7, scale: 1 },
  { name: '呼气', sec: 8, scale: 0.62 }
];
var index = 0, left = 0, running = false, tick = null, rounds = 0;
var orbEl = document.getElementById('orb'), phaseEl = document.getElementById('phase');
var roundsEl = document.getElementById('rounds'), countEl = document.getElementById('count'), toggleEl = document.getElementById('toggle');
function enter(i) {
  index = i;
  var phase = PHASES[i];
  left = phase.sec;
  phaseEl.textContent = phase.name;
  orbEl.style.transitionDuration = phase.name === '屏住' ? '0s' : phase.sec + 's';
  orbEl.style.transform = 'scale(' + phase.scale + ')';
  countEl.textContent = String(left);
}
function tickOnce() {
  left -= 1;
  countEl.textContent = String(Math.max(0, left));
  if (left > 0) return;
  var next = (index + 1) % PHASES.length;
  if (next === 0) {
    rounds += 1;
    roundsEl.textContent = String(rounds);
  }
  enter(next);
}
function stop() {
  running = false;
  clearInterval(tick); tick = null;
  toggleEl.textContent = '继续';
}
toggleEl.addEventListener('click', function () {
  if (running) { stop(); return }
  running = true;
  toggleEl.textContent = '暂停';
  if (left <= 0) enter(0);
  tick = setInterval(tickOnce, 1000);
});
document.getElementById('reset').addEventListener('click', function () {
  clearInterval(tick); tick = null;
  running = false;
  rounds = 0; left = 0; index = 0;
  roundsEl.textContent = '0';
  countEl.textContent = '—';
  phaseEl.textContent = '准备好了吗';
  orbEl.style.transitionDuration = '0.4s';
  orbEl.style.transform = 'scale(0.62)';
  toggleEl.textContent = '开始';
});
</script>
</body>
</html>
`
	},
	{
		id: 'palette',
		category: 'play',
		icon: '🎨',
		zh: { name: '配色板', prompt: '一个配色板，随机生成一组好看的颜色，点一下就能复制色号' },
		en: { name: 'Colour palette', prompt: 'A colour palette: generate a set of nice colours and tap one to copy its code' },
		html: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配色板</title>
<style>
:root{--bg:#0e1014;--card:#171a21;--line:#242833;--fg:#e9ecf3;--dim:#8b93a7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;padding:18px;-webkit-tap-highlight-color:transparent}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
h1{margin:0;font-size:18px;font-weight:650}
.sub{margin:6px 0 14px;color:var(--dim);font-size:13px}
.swatches{display:flex;flex-direction:column;gap:10px}
.sw{display:flex;align-items:center;gap:12px;height:64px;padding:0 14px;border-radius:14px;border:1px solid rgba(255,255,255,.12);cursor:pointer;user-select:text;transition:transform .12s}
.sw:active{transform:scale(.99)}
.sw .hex{font-weight:650;font-size:17px;letter-spacing:.5px;font-variant-numeric:tabular-nums}
.sw .tag{margin-left:auto;font-size:12px;opacity:.75}
.sw.ok{outline:2px solid #fff}
.sw.no .tag{text-decoration:underline}
.chips{display:flex;gap:8px;margin:16px 0 0}
.chips button{flex:1;padding:10px 6px;min-height:44px;border-radius:999px;font-size:14px}
.chips button[aria-pressed="true"]{background:#e9ecf3;border-color:transparent;color:#12151b;font-weight:650}
button{font:inherit;color:var(--fg);background:#20242e;border:1px solid #2c313d;border-radius:12px;padding:14px;min-height:50px;font-weight:650;cursor:pointer;touch-action:manipulation}
button:active{transform:translateY(1px)}
#again{width:100%;margin-top:12px;background:#e9ecf3;border-color:transparent;color:#12151b}
.foot{margin:10px 0 0;color:var(--dim);font-size:13px;text-align:center}
</style>
</head>
<body>
<main>
<h1>🎨 配色板</h1>
<p class="sub">点色块复制色号</p>
<div class="swatches" id="swatches"></div>
<div class="chips" id="chips"></div>
<button id="again">换一组</button>
<p class="foot" id="foot">邻近色搭配</p>
</main>
<script>
// 刻意没有"锁定"：模板在这里留白 —— 换一组会把五个颜色全换掉，
// 想留住其中一两个再微调，现在做不到。
var SCHEMES = {
  '邻近': [0, 18, -18, 36, -36],
  '互补': [0, 180, 20, 200, -20],
  '三角': [0, 120, 240, 60, 300]
};
var current = '邻近';
var swatchesEl = document.getElementById('swatches'), chipsEl = document.getElementById('chips'), footEl = document.getElementById('foot');
function toHex(r, g, b) {
  var s = '#' + [r, g, b].map(function (v) {
    var h = Math.max(0, Math.min(255, Math.round(v))).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
  return s.toUpperCase();
}
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs((h / 60) % 2 - 1));
  var m = l - c / 2;
  var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}
function build() {
  var base = Math.floor(Math.random() * 360);
  var offsets = SCHEMES[current];
  return offsets.map(function (off, i) {
    return hsl(base + off, 60 + i * 5, 62 - i * 4);
  });
}
function contrast(hex) {
  var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#12151b' : '#f7f9fc';
}
function flash(el, ok) {
  el.classList.add(ok ? 'ok' : 'no');
  setTimeout(function () { el.classList.remove('ok', 'no') }, 700);
}
function legacyCopy(text) {
  try {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (e) { return false }
}
function copy(text, el) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash(el, true) }, function () { flash(el, legacyCopy(text)) });
      return;
    }
  } catch (e) {}
  flash(el, legacyCopy(text));
}
function render() {
  var colors = build();
  swatchesEl.innerHTML = '';
  colors.forEach(function (hex) {
    var sw = document.createElement('div');
    sw.className = 'sw';
    sw.style.background = hex;
    sw.style.color = contrast(hex);
    var code = document.createElement('span');
    code.className = 'hex';
    code.textContent = hex;
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '点击复制';
    sw.appendChild(code); sw.appendChild(tag);
    sw.addEventListener('click', function () { copy(hex, sw) });
    swatchesEl.appendChild(sw);
  });
  footEl.textContent = current + '色搭配 · 一共 5 个颜色';
}
Object.keys(SCHEMES).forEach(function (name) {
  var b = document.createElement('button');
  b.type = 'button';
  b.textContent = name;
  b.setAttribute('aria-pressed', name === current ? 'true' : 'false');
  b.addEventListener('click', function () {
    current = name;
    for (var i = 0; i < chipsEl.children.length; i++) {
      chipsEl.children[i].setAttribute('aria-pressed', chipsEl.children[i].textContent === name ? 'true' : 'false');
    }
    render();
  });
  chipsEl.appendChild(b);
});
document.getElementById('again').addEventListener('click', render);
render();
</script>
</body>
</html>
`
	}
]

/**
 * 列表用的投影：**不含 `html`**。
 *
 * 挑模板的面板要显示十二条卡片，没有理由为此下载十二份完整文档 —— 正文只在
 * 用户真的选中某一条时，按 id 取一次。
 */
export const TEMPLATE_SUMMARIES = MINIAPP_TEMPLATES.map((template) => ({
	id: template.id,
	category: template.category,
	icon: template.icon,
	zh: { name: template.zh.name, prompt: template.zh.prompt },
	en: { name: template.en.name, prompt: template.en.prompt }
}))

/** 按 id 找一条模板；未知 id 返回 `undefined`（路由据此给 404）。 */
export function findTemplate(id) {
	if (typeof id !== 'string' || id.length === 0) return undefined
	return MINIAPP_TEMPLATES.find((template) => template.id === id)
}
