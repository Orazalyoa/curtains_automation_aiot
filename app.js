// ================== Smart Curtains ==================
// Позиция шторы: 0 = закрыта, 100 = полностью открыта.

const STORAGE_KEY = "smart-curtains";

const DEFAULT_STATE = {
  curtains: [
    { id: "living",  name: "Гостиная", pos: 100, target: 100, mode: "auto" },
    { id: "bedroom", name: "Спальня",  pos: 100, target: 100, mode: "auto" },
    { id: "kitchen", name: "Кухня",    pos: 100, target: 100, mode: "manual" }
  ],
  sensors: { lux: 20000, temp: 23, presence: true },
  settings: { luxNight: 50, tempHigh: 28, luxHigh: 40000, shadePos: 30 },
  schedule: [
    { id: 1, time: "07:00", room: "bedroom", pos: 100, lastRun: "" },
    { id: 2, time: "22:30", room: "all",     pos: 0,   lastRun: "" }
  ],
  moves: { date: "", count: 0 }
};

let state = loadLocal();
let log = JSON.parse(localStorage.getItem(STORAGE_KEY + "-log") || "[]");
let readings = [];          // для графика
let db = null;              // Firestore
let alerts = {};            // активные предупреждения (чтобы не повторять)

const $ = (id) => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const hhmm = (d = new Date()) => d.toTimeString().slice(0, 5);
const fmtLux = (v) => v >= 1000 ? (v / 1000).toFixed(1).replace(".0", "") + " тыс. лк" : v + " лк";

// ---------- Хранение ----------
function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && s.curtains) return { ...structuredClone(DEFAULT_STATE), ...s };
  } catch (e) {}
  return structuredClone(DEFAULT_STATE);
}

let saveTimer;
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (db) db.collection("system").doc("state").set(state).catch(cloudError);
  }, 600);
}

function addLog(text, type = "") {
  const entry = { t: Date.now(), text, type };
  log.unshift(entry);
  log = log.slice(0, 200);
  localStorage.setItem(STORAGE_KEY + "-log", JSON.stringify(log));
  if (db) db.collection("events").add(entry).catch(cloudError);
  renderLog();
}

// ---------- Облако (Firebase Firestore) ----------
function initCloud() {
  const cfg = window.FIREBASE_CONFIG || {};
  if (!cfg.projectId || typeof firebase === "undefined") return;
  try {
    firebase.initializeApp(cfg);
    db = firebase.firestore();
    const ref = db.collection("system").doc("state");
    ref.onSnapshot((snap) => {
      setCloud(true);
      if (snap.metadata.hasPendingWrites) return;
      if (!snap.exists) { ref.set(state); return; }
      state = { ...structuredClone(DEFAULT_STATE), ...snap.data() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderAll();
    }, cloudError);
  } catch (e) { cloudError(e); }
}
function setCloud(on) {
  $("cloudDot").classList.toggle("on", on);
  $("cloudText").textContent = on ? "Firebase подключён" : "Локально";
}
function cloudError(e) {
  console.error(e);
  setCloud(false);
}

// ---------- Управление шторами ----------
function setTarget(curtain, value, source = "Вручную") {
  value = Math.max(0, Math.min(100, Math.round(value)));
  if (curtain.target === value) return;
  curtain.target = value;
  if (state.moves.date !== today()) state.moves = { date: today(), count: 0 };
  state.moves.count++;
  const action = value === 100 ? "открыта" : value === 0 ? "закрыта" : `открыта на ${value}%`;
  addLog(`${curtain.name}: штора ${action}`, source === "Вручную" ? "" : source);
  save();
}

// Мотор: плавно двигаем штору к цели (симуляция движения)
function motorTick() {
  let changed = false;
  for (const c of state.curtains) {
    if (c.pos !== c.target) {
      const step = Math.sign(c.target - c.pos) * Math.min(2, Math.abs(c.target - c.pos));
      c.pos += step;
      changed = true;
    }
  }
  if (changed) { renderCurtains(false); renderStats(); }
}

// ---------- Автоматизация ----------
function decide() {
  const { lux, temp, presence } = state.sensors;
  const s = state.settings;
  if (lux < s.luxNight) return { pos: 0, why: "Ночь — шторы закрыты" };
  if (temp > s.tempHigh && !presence) return { pos: 0, why: "Жарко и никого нет — закрыто для экономии энергии" };
  if (lux > s.luxHigh) return { pos: s.shadePos, why: `Яркое солнце — шторы прикрыты до ${s.shadePos}%` };
  return { pos: 100, why: "Нормальное освещение — шторы открыты" };
}

function runAutomation() {
  const d = decide();
  $("ruleNow").textContent = "Сейчас: " + d.why;
  for (const c of state.curtains) {
    if (c.mode === "auto" && c.target !== d.pos) setTarget(c, d.pos, "Авто");
  }
}

// ---------- Предупреждения ----------
function checkAlerts() {
  const { lux, temp } = state.sensors;
  const rules = [
    { key: "sun",  on: lux > 70000, msg: "Очень яркое солнце: " + fmtLux(lux) },
    { key: "hot",  on: temp > 30,   msg: `Высокая температура: ${temp} °C` },
    { key: "cold", on: temp < 15,   msg: `Низкая температура: ${temp} °C` }
  ];
  for (const r of rules) {
    if (r.on && !alerts[r.key]) { toast("⚠️ " + r.msg, true); addLog(r.msg, "Тревога"); }
    alerts[r.key] = r.on;
  }
}

function toast(text, warn = false) {
  const el = document.createElement("div");
  el.className = "toast" + (warn ? " warn" : "");
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ---------- Расписание ----------
function runSchedule() {
  const now = hhmm();
  for (const item of state.schedule) {
    if (item.time === now && item.lastRun !== today()) {
      item.lastRun = today();
      const targets = item.room === "all" ? state.curtains : state.curtains.filter((c) => c.id === item.room);
      targets.forEach((c) => setTarget(c, item.pos, "Расписание"));
      toast(`Расписание ${item.time}: выполнено`);
      save();
    }
  }
}

// ---------- Симуляция датчиков ----------
function simulate() {
  if (!$("simToggle").checked) return;
  const s = state.sensors;
  s.lux = Math.max(0, Math.min(100000, Math.round((s.lux + (Math.random() - 0.45) * 8000) / 500) * 500));
  s.temp = Math.max(0, Math.min(40, Math.round((s.temp + (Math.random() - 0.48) * 1.2) * 2) / 2));
  if (Math.random() < 0.08) s.presence = !s.presence;
  onSensorsChanged();
}

function onSensorsChanged() {
  renderSensors();
  runAutomation();
  checkAlerts();
  renderStats();
  save();
}

// ---------- Отрисовка ----------
function renderCurtains(full = true) {
  const box = $("curtains");
  if (full || box.children.length !== state.curtains.length) {
    box.innerHTML = state.curtains.map((c) => `
      <div class="room" data-id="${c.id}">
        <div class="room-head"><b>${c.name}</b><span class="pos"></span></div>
        <div class="window"><div class="sun"></div><div class="rod"></div><div class="panel l"></div><div class="panel r"></div></div>
        <input type="range" min="0" max="100" step="5" value="${c.target}">
        <div class="modes">
          <button class="btn" data-act="open">Открыть</button>
          <button class="btn" data-act="close">Закрыть</button>
          <button class="btn mode" data-mode="auto">Авто</button>
        </div>
      </div>`).join("");
  }
  const sunLevel = Math.min(1, state.sensors.lux / 60000);
  for (const c of state.curtains) {
    const el = box.querySelector(`[data-id="${c.id}"]`);
    const half = (100 - c.pos) / 2;
    el.querySelector(".panel.l").style.width = half + "%";
    el.querySelector(".panel.r").style.width = half + "%";
    const moving = c.pos !== c.target;
    const p = el.querySelector(".pos");
    p.textContent = moving ? `движется… ${c.pos}%` : `открыто ${c.pos}%`;
    p.classList.toggle("moving", moving);
    el.querySelector(".window").style.filter = `brightness(${0.35 + sunLevel * 0.75})`;
    el.querySelector(".sun").style.opacity = state.sensors.lux < state.settings.luxNight ? 0 : 0.3 + sunLevel * 0.7;
    el.querySelector(".mode").classList.toggle("active", c.mode === "auto");
    const range = el.querySelector("input");
    if (document.activeElement !== range) range.value = c.target;
  }
}

function renderSensors() {
  const s = state.sensors;
  $("lux").value = s.lux;  $("luxVal").textContent = fmtLux(s.lux);
  $("temp").value = s.temp; $("tempVal").textContent = s.temp + " °C";
  $("presence").checked = s.presence;
  renderCurtains(false);
}

function renderStats() {
  const s = state.sensors;
  $("sLux").textContent = fmtLux(s.lux);
  $("sTemp").textContent = s.temp + " °C";
  const avg = state.curtains.reduce((a, c) => a + c.pos, 0) / state.curtains.length;
  $("sAvg").textContent = Math.round(avg) + " %";
  $("sMoves").textContent = state.moves.date === today() ? state.moves.count : 0;
}

function renderSettings() {
  for (const k of ["luxNight", "tempHigh", "luxHigh", "shadePos"]) $(k).value = state.settings[k];
}

function roomName(id) {
  return id === "all" ? "Все шторы" : (state.curtains.find((c) => c.id === id) || {}).name;
}

function renderSchedule() {
  $("schedRoom").innerHTML = `<option value="all">Все шторы</option>` +
    state.curtains.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  const items = [...state.schedule].sort((a, b) => a.time.localeCompare(b.time));
  $("schedList").innerHTML = items.length ? items.map((i) => `
    <li><span><b>${i.time}</b> — ${roomName(i.room)}: ${i.pos === 100 ? "открыть" : i.pos === 0 ? "закрыть" : i.pos + "%"}</span>
    <button class="x" data-del="${i.id}" title="Удалить">✕</button></li>`).join("")
    : `<li class="empty">Нет задач</li>`;
}

function renderLog() {
  $("log").innerHTML = log.length ? log.slice(0, 60).map((e) => {
    const d = new Date(e.t);
    const cls = e.type === "Тревога" ? "warn" : e.type ? "auto" : "";
    return `<li><span><time>${d.toLocaleDateString("ru-RU").slice(0, 5)} ${d.toTimeString().slice(0, 8)}</time>${e.text}</span>
      ${e.type ? `<span class="tag ${cls}">${e.type}</span>` : ""}</li>`;
  }).join("") : `<li class="empty">Событий пока нет</li>`;
}

function renderAll() {
  renderCurtains(true); renderSensors(); renderStats(); renderSettings(); renderSchedule(); renderLog(); runAutomation();
}

// ---------- График ----------
let chart;
function initChart() {
  chart = new Chart($("chart"), {
    type: "line",
    data: { labels: [], datasets: [
      { label: "Освещённость, тыс. лк", data: [], borderColor: "#e8a317", backgroundColor: "#e8a31722", fill: true, tension: .35, yAxisID: "y" },
      { label: "Температура, °C", data: [], borderColor: "#e5484d", tension: .35, yAxisID: "y1" },
      { label: "Открытие, %", data: [], borderColor: "#3b6ef5", borderDash: [4, 4], tension: .35, yAxisID: "y2" }
    ]},
    options: {
      animation: false, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, font: { size: 10 } }, grid: { display: false } },
        y:  { min: 0, max: 100, position: "left", ticks: { font: { size: 10 } } },
        y1: { min: 0, max: 40, position: "right", grid: { display: false }, ticks: { font: { size: 10 } } },
        y2: { min: 0, max: 100, display: false }
      }
    }
  });
}

function recordReading() {
  const r = {
    t: Date.now(),
    lux: state.sensors.lux,
    temp: state.sensors.temp,
    avg: Math.round(state.curtains.reduce((a, c) => a + c.pos, 0) / state.curtains.length)
  };
  readings.push(r);
  readings = readings.slice(-40);
  chart.data.labels = readings.map((x) => new Date(x.t).toTimeString().slice(0, 8));
  chart.data.datasets[0].data = readings.map((x) => x.lux / 1000);
  chart.data.datasets[1].data = readings.map((x) => x.temp);
  chart.data.datasets[2].data = readings.map((x) => x.avg);
  chart.update();
  if (db && readings.length % 3 === 0) db.collection("readings").add(r).catch(cloudError);
}

// ---------- События интерфейса ----------
function bindEvents() {
  $("curtains").addEventListener("click", (e) => {
    const room = e.target.closest(".room"); if (!room) return;
    const c = state.curtains.find((x) => x.id === room.dataset.id);
    const act = e.target.dataset.act;
    if (e.target.dataset.mode) {
      c.mode = c.mode === "auto" ? "manual" : "auto";
      addLog(`${c.name}: режим «${c.mode === "auto" ? "Авто" : "Ручной"}»`);
      save(); runAutomation(); renderCurtains(false);
      return;
    }
    if (!act) return;
    switchToManual(c);
    setTarget(c, act === "open" ? 100 : 0);
    renderCurtains(false);
  });
  $("curtains").addEventListener("change", (e) => {
    if (e.target.type !== "range") return;
    const c = state.curtains.find((x) => x.id === e.target.closest(".room").dataset.id);
    switchToManual(c);
    setTarget(c, +e.target.value);
    renderCurtains(false);
  });

  document.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => {
    state.curtains.forEach((c) => { switchToManual(c); setTarget(c, +b.dataset.all); });
    renderCurtains(false);
  }));

  $("lux").addEventListener("input", (e) => { state.sensors.lux = +e.target.value; onSensorsChanged(); });
  $("temp").addEventListener("input", (e) => { state.sensors.temp = +e.target.value; onSensorsChanged(); });
  $("presence").addEventListener("change", (e) => {
    state.sensors.presence = e.target.checked;
    addLog(e.target.checked ? "Датчик: в комнате есть люди" : "Датчик: в комнате никого нет", "Датчик");
    onSensorsChanged();
  });

  for (const k of ["luxNight", "tempHigh", "luxHigh", "shadePos"]) {
    $(k).addEventListener("change", (e) => {
      state.settings[k] = +e.target.value;
      addLog("Изменены настройки автоматизации");
      save(); runAutomation();
    });
  }

  $("schedForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const item = { id: Date.now(), time: $("schedTime").value, room: $("schedRoom").value, pos: +$("schedPos").value, lastRun: "" };
    state.schedule.push(item);
    addLog(`Добавлена задача ${item.time} (${roomName(item.room)})`);
    save(); renderSchedule(); e.target.reset();
  });
  $("schedList").addEventListener("click", (e) => {
    const id = +e.target.dataset.del; if (!id) return;
    state.schedule = state.schedule.filter((i) => i.id !== id);
    addLog("Удалена задача из расписания");
    save(); renderSchedule();
  });

  $("clearLog").addEventListener("click", () => {
    log = []; localStorage.setItem(STORAGE_KEY + "-log", "[]"); renderLog();
  });
}

// Ручное действие выключает автоматику для этой шторы
function switchToManual(c) {
  if (c.mode === "auto") { c.mode = "manual"; addLog(`${c.name}: переключено в ручной режим`); }
}

// ---------- Запуск ----------
initChart();
bindEvents();
renderAll();
initCloud();
recordReading();
addLog("Система запущена", "Система");

setInterval(motorTick, 80);
setInterval(simulate, 3000);
setInterval(recordReading, 5000);
setInterval(() => { $("clock").textContent = hhmm(); runSchedule(); }, 1000);
