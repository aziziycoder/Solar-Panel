'use strict';

/* ==========================================================
   SOLARIS.sim — Solar Panel Power Simulator
   script.js
   ========================================================== */

/* ---------- 1. Sozlamalar ---------- */
const CONFIG = Object.freeze({
  TICK_MS: 1000,            // simulyatsiya qadami (1 soniya)
  CHART_POINTS: 30,         // grafikda saqlanadigan nuqtalar soni
  MAX_ALLOWED_W: 1000000,   // bitta panel uchun ruxsat etilgan eng katta qiymat
  CELL_COLS: 10,
  CELL_ROWS: 6,
  BOOT_MS: 1600,            // panel ishga tushish animatsiyasi davomiyligi
  SLOWDOWN_MS: 1600,        // to'xtatilganda animatsiyalarning sekinlashish vaqti
  COUNTER_MS: 750,          // raqamlar animatsiyasi davomiyligi
  PANEL_COLORS: ['#3ab7ff', '#ffd23f', '#c084fc'],
  TOTAL_COLOR: '#39ff88',
});

const PANEL_GAUGE_C = 2 * Math.PI * 50;          // panel indikatori aylanasi uzunligi
const TOTAL_GAUGE_C = 2 * Math.PI * 88;          // umumiy indikator aylanasi
const TOTAL_GAUGE_ARC = TOTAL_GAUGE_C * 0.75;    // 270° yoy uzunligi
const TOTAL_TICKS = 36;

const STATUS_LABELS = {
  off:     { system: "TIZIM O'CHIQ", panel: "O'CHIQ",       active: "Panellar o'chiq" },
  running: { system: 'ISHLAMOQDA',   panel: 'ISHLAMOQDA',   active: 'Faol generatsiya' },
  stopped: { system: "TO'XTATILGAN", panel: "TO'XTATILGAN", active: "Simulyatsiya to'xtatilgan" },
};

/* ---------- 2. Holat (state) ---------- */
const state = {
  status: 'off',        // off | running | stopped
  intervalId: null,
  slowdownRaf: null,
  bootTimer: null,
  uptimeSec: 0,
  energyWh: 0,
  peakW: 0,
  panels: [
    { name: '1-panel', max: 500, power: 0 },
    { name: '2-panel', max: 350, power: 0 },
    { name: '3-panel', max: 700, power: 0 },
  ],
};

/* ---------- 3. DOM elementlari ---------- */
const $ = (selector) => document.querySelector(selector);

const dom = {
  body: document.body,
  array: $('#array'),
  panelsGrid: $('#panelsGrid'),
  controlPanel: $('#controlPanel'),
  inputs: [0, 1, 2].map((i) => $(`#max-${i}`)),
  errors: [0, 1, 2].map((i) => $(`#err-${i}`)),
  btnStart: $('#btnStart'),
  btnStop: $('#btnStop'),
  btnReset: $('#btnReset'),
  systemStatus: $('#systemStatus'),
  systemStatusText: $('#systemStatusText'),
  uptime: $('#uptime'),
  clock: $('#clock'),
  statTotal: $('#statTotal'),
  statMax: $('#statMax'),
  statEff: $('#statEff'),
  statEffBar: $('#statEffBar'),
  statEffCard: $('#statEffCard'),
  statActive: $('#statActive'),
  statActiveSub: $('#statActiveSub'),
  totalGauge: $('#totalGauge'),
  totalGaugeFill: $('#totalGaugeFill'),
  totalGaugeValue: $('#totalGaugeValue'),
  totalGaugeUnit: $('#totalGaugeUnit'),
  totalGaugePercent: $('#totalGaugePercent'),
  totalTicks: $('#totalTicks'),
  energyValue: $('#energyValue'),
  peakValue: $('#peakValue'),
  irradiance: $('#irradiance'),
  chartCanvas: $('#powerChart'),
  chartEmpty: $('#chartEmpty'),
  toastStack: $('#toastStack'),
};

const panelUI = [];
let tickElements = [];
let chart = null;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- 4. Yordamchi funksiyalar ---------- */
const fmtInt = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fmtPower = (v) => (v >= 10000 ? `${(v / 1000).toFixed(2)} kW` : `${fmtInt(v)} W`);
const fmtPanelPower = (v) => (v < 100 ? v.toFixed(1) : fmtInt(v));
const fmtPercent = (v) => `${Math.round(v)}%`;
const fmtEnergy = (wh) => (wh >= 1000 ? `${(wh / 1000).toFixed(3)} kWh` : `${wh.toFixed(2)} Wh`);
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDuration = (sec) =>
  `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
const fmtClock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const toPercent = (value, max) => (max > 0 ? Math.min(Math.max((value / max) * 100, 0), 100) : 0);
const sumBy = (list, key) => list.reduce((acc, item) => acc + item[key], 0);

/** Foizga qarab rang darajasi: 0–30 qizil, 31–70 sariq, 71–100 yashil */
function getLevel(percent) {
  const p = Math.round(percent);
  if (p <= 30) return 'red';
  if (p <= 70) return 'yellow';
  return 'green';
}

/* ---------- 5. Silliq raqam animatsiyasi (counter) ---------- */
const tweens = new WeakMap();

function tweenNumber(el, to, format, duration = CONFIG.COUNTER_MS) {
  const from = parseFloat(el.dataset.value) || 0;
  const running = tweens.get(el);
  if (running) cancelAnimationFrame(running);

  if (reducedMotion || Math.abs(from - to) < 0.001) {
    el.dataset.value = String(to);
    el.textContent = format(to);
    tweens.delete(el);
    return;
  }

  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = from + (to - from) * eased;
    el.dataset.value = String(value);
    el.textContent = format(value);
    if (t < 1) {
      tweens.set(el, requestAnimationFrame(step));
    } else {
      tweens.delete(el);
    }
  };
  tweens.set(el, requestAnimationFrame(step));
}

/* ---------- 6. Panellarni yaratish ---------- */
function buildPanels() {
  const fragment = document.createDocumentFragment();

  state.panels.forEach((panel, i) => {
    const card = document.createElement('article');
    card.className = 'panel-card glass';
    card.dataset.state = 'off';
    card.dataset.level = 'idle';
    card.style.setProperty('--accent', CONFIG.PANEL_COLORS[i]);

    card.innerHTML = `
      <header class="panel-card__head">
        <span class="led" aria-hidden="true"></span>
        <h3 class="panel-card__name">${panel.name.toUpperCase()}</h3>
        <span class="chip" data-role="status">${STATUS_LABELS.off.panel}</span>
      </header>

      <div class="pv" aria-hidden="true">
        <div class="pv__beam"></div>
        <div class="pv__frame">
          <div class="pv__cells"></div>
          <div class="pv__glow"></div>
          <div class="pv__flow"></div>
          <div class="pv__shine"></div>
        </div>
        <div class="pv__shadow"></div>
      </div>

      <div class="cable" aria-hidden="true">
        <span class="cable__tag">DC</span>
        <span class="cable__line"></span>
        <span class="cable__tag">INV</span>
      </div>

      <div class="panel-card__body">
        <div class="gauge">
          <svg viewBox="0 0 128 128" aria-hidden="true">
            <circle class="gauge__ticks" cx="64" cy="64" r="60"></circle>
            <circle class="gauge__track" cx="64" cy="64" r="50"></circle>
            <circle class="gauge__fill" data-role="gauge" cx="64" cy="64" r="50"></circle>
          </svg>
          <div class="gauge__center">
            <span class="gauge__percent" data-role="percent">0%</span>
            <span class="gauge__label">YUKLAMA</span>
          </div>
        </div>

        <div class="readout">
          <span class="readout__label"><b>${panel.name}</b> · joriy quvvat</span>
          <div class="readout__value" aria-live="polite">
            <span class="readout__num" data-role="power">0</span>
            <span class="readout__unit">W</span>
          </div>
          <div class="bar"><span class="bar__fill" data-role="bar"></span></div>
          <div class="readout__meta">
            <span>Maksimal quvvat</span>
            <b><span data-role="max">${fmtInt(panel.max)}</span> W</b>
          </div>
        </div>
      </div>
    `;

    // Fotovoltaik kataklar
    const cells = card.querySelector('.pv__cells');
    for (let r = 0; r < CONFIG.CELL_ROWS; r++) {
      for (let c = 0; c < CONFIG.CELL_COLS; c++) {
        const cell = document.createElement('span');
        cell.className = 'pv__cell';
        cell.style.setProperty('--d', r + c);
        cells.appendChild(cell);
      }
    }

    fragment.appendChild(card);
    panelUI.push({
      card,
      status: card.querySelector('[data-role="status"]'),
      power: card.querySelector('[data-role="power"]'),
      percent: card.querySelector('[data-role="percent"]'),
      gauge: card.querySelector('[data-role="gauge"]'),
      bar: card.querySelector('[data-role="bar"]'),
      max: card.querySelector('[data-role="max"]'),
    });
  });

  dom.panelsGrid.appendChild(fragment);
}

/* ---------- 7. Umumiy indikator shkalasi ---------- */
function buildTotalTicks() {
  const cx = 110;
  const cy = 110;
  const ns = 'http://www.w3.org/2000/svg';

  for (let i = 0; i <= TOTAL_TICKS; i++) {
    const angle = ((135 + (270 * i) / TOTAL_TICKS) * Math.PI) / 180;
    const major = i % 6 === 0;
    const r1 = 100;
    const r2 = major ? 109 : 105;

    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', (cx + r1 * Math.cos(angle)).toFixed(2));
    line.setAttribute('y1', (cy + r1 * Math.sin(angle)).toFixed(2));
    line.setAttribute('x2', (cx + r2 * Math.cos(angle)).toFixed(2));
    line.setAttribute('y2', (cy + r2 * Math.sin(angle)).toFixed(2));
    line.setAttribute('class', major ? 'tick tick--major' : 'tick');
    dom.totalTicks.appendChild(line);
    tickElements.push(line);
  }
}

/* ---------- 8. Grafik (Chart.js) ---------- */
function initChart() {
  if (typeof window.Chart === 'undefined') {
    dom.chartEmpty.textContent =
      "Grafik kutubxonasi (Chart.js) yuklanmadi. Internet aloqasini tekshiring va sahifani yangilang.";
    return;
  }

  const { Chart } = window;
  Chart.defaults.color = '#7f93b5';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";

  const panelDatasets = state.panels.map((panel, i) => ({
    label: panel.name,
    data: [],
    borderColor: CONFIG.PANEL_COLORS[i],
    backgroundColor: CONFIG.PANEL_COLORS[i],
    borderWidth: 2,
    tension: 0.35,
    pointRadius: 0,
    pointHoverRadius: 5,
    fill: false,
    order: 1,
  }));

  const totalDataset = {
    label: 'Umumiy quvvat',
    data: [],
    borderColor: CONFIG.TOTAL_COLOR,
    backgroundColor: (context) => {
      const { ctx, chartArea } = context.chart;
      if (!chartArea) return 'rgba(57, 255, 136, 0.12)';
      const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      gradient.addColorStop(0, 'rgba(57, 255, 136, 0.32)');
      gradient.addColorStop(1, 'rgba(57, 255, 136, 0)');
      return gradient;
    },
    borderWidth: 3,
    tension: 0.35,
    pointRadius: 0,
    pointHoverRadius: 6,
    fill: true,
    order: 0,
  };

  chart = new Chart(dom.chartCanvas, {
    type: 'line',
    data: { labels: [], datasets: [...panelDatasets, totalDataset] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: reducedMotion ? 0 : 500, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 18 },
        },
        tooltip: {
          backgroundColor: 'rgba(8, 15, 30, 0.94)',
          borderColor: 'rgba(0, 229, 255, 0.3)',
          borderWidth: 1,
          padding: 12,
          titleColor: '#e6f0ff',
          bodyColor: '#c9d6ee',
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${fmtPower(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { maxTicksLimit: 8, maxRotation: 0, font: { family: "'JetBrains Mono', monospace", size: 10 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
          ticks: { callback: (v) => fmtPower(v), font: { family: "'JetBrains Mono', monospace", size: 10 } },
          title: { display: true, text: 'Quvvat', color: '#4b5b78' },
        },
      },
    },
  });
}

function pushChartPoint(total) {
  if (!chart) return;
  const { labels, datasets } = chart.data;

  labels.push(fmtClock(new Date()));
  state.panels.forEach((panel, i) => datasets[i].data.push(panel.power));
  datasets[state.panels.length].data.push(total);

  if (labels.length > CONFIG.CHART_POINTS) {
    labels.shift();
    datasets.forEach((ds) => ds.data.shift());
  }

  chart.update();
  dom.chartEmpty.classList.add('is-hidden');
}

function clearChart() {
  if (!chart) return;
  chart.data.labels.length = 0;
  chart.data.datasets.forEach((ds) => {
    ds.data.length = 0;
  });
  chart.update();
  dom.chartEmpty.classList.remove('is-hidden');
}

/* ---------- 9. Kiritilgan qiymatlarni tekshirish ---------- */
function validateField(i, { silent = false } = {}) {
  const input = dom.inputs[i];
  const field = input.closest('.field');
  const raw = input.value.trim();
  let error = '';

  if (input.validity.badInput) {
    error = 'Faqat son kiriting';
  } else if (raw === '') {
    error = 'Qiymat kiritilmagan';
  } else {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      error = 'Faqat son kiriting';
    } else if (value <= 0) {
      error = "Quvvat musbat son bo'lishi kerak";
    } else if (value > CONFIG.MAX_ALLOWED_W) {
      error = `Eng katta ruxsat etilgan qiymat: ${fmtInt(CONFIG.MAX_ALLOWED_W)} W`;
    } else {
      state.panels[i].max = Math.round(value * 100) / 100;
    }
  }

  field.classList.toggle('field--error', Boolean(error));
  dom.errors[i].textContent = error;

  if (error && !silent) {
    field.classList.remove('shake');
    void field.offsetWidth; // animatsiyani qayta boshlash uchun reflow
    field.classList.add('shake');
  }
  return !error;
}

function validateAll() {
  // har bir maydon tekshirilsin (birinchi xatoda to'xtamasdan)
  return dom.inputs.map((_, i) => validateField(i)).every(Boolean);
}

function setInputsLocked(locked) {
  dom.inputs.forEach((input) => {
    input.disabled = locked;
  });
  dom.controlPanel.classList.toggle('is-locked', locked);
}

function onMaxInput(i) {
  if (state.status === 'running') return;
  if (validateField(i, { silent: true })) {
    const panel = state.panels[i];
    panel.power = Math.min(panel.power, panel.max);
    renderAll();
  }
}

/* ---------- 10. Animatsiyalarni boshqarish ---------- */
function getStageAnimations() {
  if (typeof document.getAnimations !== 'function' || typeof window.CSSAnimation === 'undefined') {
    return [];
  }
  return document.getAnimations().filter((anim) => {
    const target = anim.effect && anim.effect.target;
    return anim instanceof window.CSSAnimation && target && dom.array.contains(target);
  });
}

/** To'xtatilganda animatsiyalar asta-sekin sekinlashib to'xtaydi */
function slowDownAnimations(onDone) {
  cancelSlowdown(false);
  const animations = getStageAnimations();

  if (reducedMotion || animations.length === 0) {
    onDone();
    return;
  }

  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / CONFIG.SLOWDOWN_MS, 1);
    const rate = Math.max(1 - t, 0.0001);
    animations.forEach((anim) => {
      try { anim.playbackRate = rate; } catch (_) { /* animatsiya allaqachon tugagan */ }
    });

    if (t < 1) {
      state.slowdownRaf = requestAnimationFrame(step);
    } else {
      state.slowdownRaf = null;
      animations.forEach((anim) => {
        try { anim.pause(); } catch (_) { /* animatsiya allaqachon tugagan */ }
      });
      onDone();
    }
  };
  state.slowdownRaf = requestAnimationFrame(step);
}

function cancelSlowdown(restoreSpeed) {
  if (state.slowdownRaf) {
    cancelAnimationFrame(state.slowdownRaf);
    state.slowdownRaf = null;
  }
  if (restoreSpeed) {
    getStageAnimations().forEach((anim) => {
      try {
        anim.playbackRate = 1;
        if (anim.playState === 'paused') anim.play();
      } catch (_) { /* animatsiya allaqachon tugagan */ }
    });
  }
}

function bootPanels() {
  endBoot();
  panelUI.forEach(({ card }) => {
    void card.offsetWidth;
    card.classList.add('booting');
  });
  state.bootTimer = setTimeout(endBoot, CONFIG.BOOT_MS);
}

function endBoot() {
  clearTimeout(state.bootTimer);
  state.bootTimer = null;
  panelUI.forEach(({ card }) => card.classList.remove('booting'));
}

/* ---------- 11. Ekranni yangilash (render) ---------- */
function renderPanel(panel, i) {
  const ui = panelUI[i];
  const percent = toPercent(panel.power, panel.max);
  const level = state.status === 'off' && panel.power === 0 ? 'idle' : getLevel(percent);

  ui.card.dataset.level = level;
  ui.card.style.setProperty('--intensity', (percent / 100).toFixed(3));

  tweenNumber(ui.power, panel.power, fmtPanelPower);
  tweenNumber(ui.percent, percent, fmtPercent);

  ui.gauge.style.strokeDashoffset = String(PANEL_GAUGE_C * (1 - percent / 100));
  ui.gauge.style.opacity = percent > 0 ? '1' : '0';
  ui.bar.style.width = `${percent}%`;
  ui.max.textContent = fmtInt(panel.max);
}

function renderDashboard() {
  const total = sumBy(state.panels, 'power');
  const maxTotal = sumBy(state.panels, 'max');
  const efficiency = toPercent(total, maxTotal);
  const level = state.status === 'off' && total === 0 ? 'idle' : getLevel(efficiency);

  // Statistik kartalar
  tweenNumber(dom.statTotal, total, fmtPower);
  tweenNumber(dom.statMax, maxTotal, fmtPower);
  tweenNumber(dom.statEff, efficiency, (v) => `${v.toFixed(1)}%`);
  dom.statEffCard.dataset.level = level;
  dom.statEffBar.style.width = `${efficiency}%`;

  const active = state.status === 'running' ? state.panels.filter((p) => p.power > 0).length : 0;
  dom.statActive.textContent = `${active} / ${state.panels.length}`;
  dom.statActiveSub.textContent = STATUS_LABELS[state.status].active;

  // Katta umumiy indikator
  const useKw = total >= 10000;
  dom.totalGauge.dataset.level = level;
  dom.totalGaugeUnit.textContent = useKw ? 'kW' : 'W';
  tweenNumber(dom.totalGaugeValue, total, (v) => (useKw ? (v / 1000).toFixed(2) : fmtInt(v)));
  tweenNumber(dom.totalGaugePercent, efficiency, (v) => `${v.toFixed(1)}%`);
  dom.totalGaugeFill.style.strokeDashoffset = String(TOTAL_GAUGE_ARC * (1 - efficiency / 100));
  dom.totalGaugeFill.style.opacity = efficiency > 0 ? '1' : '0';

  const litCount = Math.round((efficiency / 100) * TOTAL_TICKS);
  tickElements.forEach((tick, i) => tick.classList.toggle('is-lit', efficiency > 0 && i <= litCount));

  // Qo'shimcha ko'rsatkichlar
  dom.energyValue.textContent = fmtEnergy(state.energyWh);
  dom.peakValue.textContent = fmtPower(state.peakW);
  dom.uptime.textContent = fmtDuration(state.uptimeSec);
  tweenNumber(dom.irradiance, efficiency * 10, fmtInt);
}

function renderAll() {
  state.panels.forEach(renderPanel);
  renderDashboard();
}

function updateStatusUI() {
  const labels = STATUS_LABELS[state.status];

  dom.systemStatus.dataset.state = state.status;
  dom.systemStatusText.textContent = labels.system;

  panelUI.forEach((ui) => {
    ui.card.dataset.state = state.status;
    ui.status.textContent = labels.panel;
  });

  dom.btnStart.disabled = state.status === 'running';
  dom.btnStop.disabled = state.status !== 'running';
}

/* ---------- 12. Simulyatsiya logikasi ---------- */
function tick(isFirst = false) {
  // Har bir panel mustaqil ravishda 0 dan max gacha tasodifiy quvvat ishlab chiqaradi
  state.panels.forEach((panel) => {
    panel.power = Math.round(Math.random() * panel.max * 10) / 10;
  });

  const total = sumBy(state.panels, 'power');

  if (!isFirst) {
    state.uptimeSec += CONFIG.TICK_MS / 1000;
    state.energyWh += (total * CONFIG.TICK_MS) / 3600000; // W * s -> Wh
  }
  state.peakW = Math.max(state.peakW, total);

  renderAll();
  pushChartPoint(total);
}

function startSimulation() {
  if (state.status === 'running') return;

  if (!validateAll()) {
    toast("Iltimos, kiritilgan qiymatlarni tekshiring", 'error');
    return;
  }

  // Bir vaqtda faqat bitta interval ishlashi kafolatlanadi
  clearInterval(state.intervalId);
  state.intervalId = null;

  const resuming = state.status === 'stopped';
  const wasSlowingDown = state.slowdownRaf !== null;

  state.status = 'running';
  setInputsLocked(true);

  if (wasSlowingDown) {
    cancelSlowdown(true);
  }
  dom.body.classList.remove('is-stopping');
  dom.body.classList.add('is-running');

  bootPanels();
  updateStatusUI();
  tick(true);
  state.intervalId = setInterval(tick, CONFIG.TICK_MS);

  toast(resuming ? 'Simulyatsiya davom ettirildi' : 'Quyosh panellari ishga tushirildi', 'success');
}

function stopSimulation() {
  if (state.status !== 'running') return;

  clearInterval(state.intervalId);
  state.intervalId = null;
  state.status = 'stopped';

  setInputsLocked(false);
  updateStatusUI();
  renderAll(); // qiymatlar oxirgi holatida qoladi

  dom.body.classList.add('is-stopping');
  slowDownAnimations(() => {
    dom.body.classList.remove('is-running', 'is-stopping');
    endBoot();
  });

  toast("Simulyatsiya to'xtatildi. Qiymatlar saqlab qolindi", 'warning');
}

function resetSimulation() {
  clearInterval(state.intervalId);
  state.intervalId = null;
  cancelSlowdown(false);
  endBoot();

  state.status = 'off';
  state.uptimeSec = 0;
  state.energyWh = 0;
  state.peakW = 0;
  state.panels.forEach((panel) => {
    panel.power = 0;
  });

  dom.body.classList.remove('is-running', 'is-stopping');
  setInputsLocked(false);
  dom.inputs.forEach((_, i) => validateField(i, { silent: true }));

  clearChart();
  updateStatusUI();
  renderAll();

  toast('Tizim qayta tiklandi. Barcha qiymatlar nolga qaytarildi', 'info');
}

/* ---------- 13. Interaktiv effektlar ---------- */
function attachRipple(button) {
  button.addEventListener('pointerdown', (event) => {
    if (button.disabled) return;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    button.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', 'status');

  const dot = document.createElement('span');
  dot.className = 'toast__dot';
  const text = document.createElement('span');
  text.textContent = message;
  el.append(dot, text);

  dom.toastStack.appendChild(el);
  while (dom.toastStack.children.length > 3) {
    dom.toastStack.firstElementChild.remove();
  }

  requestAnimationFrame(() => el.classList.add('is-visible'));
  setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 400);
  }, 2600);
}

function updateClock() {
  dom.clock.textContent = fmtClock(new Date());
}

/* ---------- 14. Ishga tushirish ---------- */
function init() {
  buildPanels();
  buildTotalTicks();
  initChart();

  dom.inputs.forEach((input, i) => {
    input.value = String(state.panels[i].max);
    input.addEventListener('input', () => onMaxInput(i));
    input.addEventListener('blur', () => validateField(i, { silent: true }));
    input.addEventListener('keydown', (event) => {
      if (['-', '+', 'e', 'E'].includes(event.key)) event.preventDefault();
      if (event.key === 'Enter') startSimulation();
    });
  });

  dom.btnStart.addEventListener('click', startSimulation);
  dom.btnStop.addEventListener('click', stopSimulation);
  dom.btnReset.addEventListener('click', resetSimulation);
  document.querySelectorAll('.btn').forEach(attachRipple);

  updateClock();
  setInterval(updateClock, 1000);

  updateStatusUI();
  renderAll();
}

init();
