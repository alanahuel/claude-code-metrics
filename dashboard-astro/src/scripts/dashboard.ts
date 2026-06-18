import * as echarts from 'echarts';

// ─── Tipos y constantes ───────────────────────────────────────────────────
type Row = [string, string, string, number, number, number, number, number, number, number];
// hour(local "YYYY-MM-DDTHH"), project, model, in, out, cw5m, cw1h, cr, msgs, cost
interface Payload {
  generated_at: string;
  last_ingest: string | null;
  tz: string;
  hourly: Row[];
  util: [string, string, number, string][]; // ts, window, utilization, resets_at
  pricing: Record<string, [number, number]>;
  currency?: { symbol: string; rate: number }; // de ~/.config/claude-metrics/config.json
  model_yield?: [string, string, string, number, number, number][]; // day, window, model, beta, r2, n_obs
}

// Colores dependientes del tema (se intercambian en modo día/noche).
const THEMES = {
  dark: {
    fg: '#e8e9f0', dim: '#aeb2c0', muted: '#6f7484', line: '#20232e',
    lineSoft: '#191c25', panel: '#111319', tipBg: 'rgba(17,19,25,0.96)',
  },
  light: {
    fg: '#1a1d27', dim: '#52596b', muted: '#8a90a0', line: '#e4e7ee',
    lineSoft: '#eef0f5', panel: '#ffffff', tipBg: 'rgba(255,255,255,0.98)',
  },
};
let THEME: 'dark' | 'light' = 'dark';
let C = THEMES.dark;
const PALETTE = ['#7c83ff', '#2dd4bf', '#f6b549', '#fb6f92', '#4cc4f5', '#b18bff', '#9fe05a', '#8a93a6'];
const FONT = "'Hanken Grotesk Variable', sans-serif";
const MONO = "'JetBrains Mono Variable', monospace";

const RANGES: Record<string, { days: number | null; gran: 'hour' | 'day' }> = {
  '24h': { days: 1, gran: 'hour' },
  '7d': { days: 7, gran: 'hour' },
  '30d': { days: 30, gran: 'day' },
  '90d': { days: 90, gran: 'day' },
  all: { days: null, gran: 'day' },
};

let DATA: Payload;
let CURRENT = '30d';
let FILTER: string | null = null; // proyecto seleccionado (filtra todo el dashboard)
let MODEL_COLORS: Record<string, string> = {};
const charts: Record<string, echarts.ECharts> = {};

// ─── Helpers de formato ─────────────────────────────────────────────────────
let CUR = { symbol: '$', rate: 1 }; // se sobrescribe con DATA.currency en boot()
const money = (n: number, dp?: number) => {
  n = n * CUR.rate;
  if (dp === undefined) dp = n >= 100 ? 2 : n >= 1 ? 3 : 4;
  return CUR.symbol + n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const tok = (n: number) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};
const shortModel = (m: string) => m.replace('claude-', '');
const pad = (n: number) => String(n).padStart(2, '0');

function parseHour(h: string): Date {
  // "YYYY-MM-DDTHH" en hora local.
  return new Date(`${h}:00:00`);
}
function bucketKey(d: Date, gran: 'hour' | 'day'): string {
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return gran === 'hour' ? `${s}T${pad(d.getHours())}` : s;
}
function bucketLabel(key: string, gran: 'hour' | 'day'): string {
  if (gran === 'hour') {
    const d = parseHour(key);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:00`;
  }
  const [, mm, dd] = key.split('-');
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${dd} ${months[parseInt(mm) - 1]}`;
}

// ─── Agregación ──────────────────────────────────────────────────────────────
interface Agg {
  buckets: string[];
  labels: string[];
  gran: 'hour' | 'day';
  models: string[];
  perModel: Record<string, number[]>; // coste por bucket
  tokensIn: number[]; tokensOut: number[]; tokensCache: number[];
  totalsCost: number[];
  byHour: number[]; // 0..23 coste agregado
  projects: [string, number][]; // [proyecto, coste] desc, dentro del rango
  kpi: { cost: number; msgs: number; tokens: number; days: number; top: string };
  prevCost: number;
  start: Date; end: Date;
}

interface MonthRow { month: string; cost: number; tokens: number; msgs: number; }

const MONTH_NAMES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function monthlyData(projFilter: string | null): MonthRow[] {
  const m: Record<string, MonthRow> = {};
  for (const r of DATA.hourly) {
    if (projFilter && r[1] !== projFilter) continue;
    const month = r[0].slice(0, 7); // YYYY-MM
    (m[month] ||= { month, cost: 0, tokens: 0, msgs: 0 });
    m[month].cost += r[9];
    m[month].tokens += r[3] + r[4] + r[5] + r[6] + r[7];
    m[month].msgs += r[8];
  }
  return Object.keys(m).sort().map((k) => m[k]);
}

function aggregate(rangeId: string, projFilter: string | null): Agg {
  const { days, gran } = RANGES[rangeId];
  const end = new Date();
  let start: Date;
  if (days === null) {
    start = DATA.hourly.length ? parseHour(DATA.hourly[0][0]) : new Date(end.getTime() - 86400000);
  } else {
    start = new Date(end.getTime() - days * 86400000);
  }
  const prevStart = days === null ? start : new Date(start.getTime() - days * 86400000);

  // Construye la secuencia de buckets vacíos del rango.
  const buckets: string[] = [];
  const idx: Record<string, number> = {};
  const step = gran === 'hour' ? 3600000 : 86400000;
  const cur = new Date(start);
  if (gran === 'hour') cur.setMinutes(0, 0, 0); else cur.setHours(0, 0, 0, 0);
  while (cur <= end) {
    const k = bucketKey(cur, gran);
    idx[k] = buckets.length; buckets.push(k);
    cur.setTime(cur.getTime() + step);
  }

  const modelTotals: Record<string, number> = {};
  const projectTotals: Record<string, number> = {};
  let prevCost = 0;
  const byHour = new Array(24).fill(0);
  let kCost = 0, kMsgs = 0, kTok = 0;

  for (const r of DATA.hourly) {
    const [h, project, model, ti, to, cw5, cw1, cr, msgs, cost] = r;
    const d = parseHour(h);
    const inRange = d >= start && d <= end;
    // El reparto por proyecto se calcula SIEMPRE con todos los proyectos,
    // para poder cambiar de filtro desde el propio panel.
    if (inRange) projectTotals[project] = (projectTotals[project] || 0) + cost;
    if (projFilter && project !== projFilter) continue;
    if (d >= prevStart && d < start) { prevCost += cost; continue; }
    if (!inRange) continue;
    modelTotals[model] = (modelTotals[model] || 0) + cost;
    byHour[d.getHours()] += cost;
    kCost += cost; kMsgs += msgs; kTok += ti + to + cw5 + cw1 + cr;
  }
  const projects = Object.entries(projectTotals)
    .sort((a, b) => b[1] - a[1]) as [string, number][];

  const models = Object.keys(modelTotals).sort((a, b) => modelTotals[b] - modelTotals[a]);
  const perModel: Record<string, number[]> = {};
  models.forEach((m) => (perModel[m] = new Array(buckets.length).fill(0)));
  const tokensIn = new Array(buckets.length).fill(0);
  const tokensOut = new Array(buckets.length).fill(0);
  const tokensCache = new Array(buckets.length).fill(0);
  const totalsCost = new Array(buckets.length).fill(0);

  for (const r of DATA.hourly) {
    const [h, project, model, ti, to, cw5, cw1, cr, , cost] = r;
    const d = parseHour(h);
    if (d < start || d > end) continue;
    if (projFilter && project !== projFilter) continue;
    const k = bucketKey(d, gran);
    const i = idx[k];
    if (i === undefined) continue;
    if (perModel[model]) perModel[model][i] += cost;
    tokensIn[i] += ti; tokensOut[i] += to; tokensCache[i] += cw5 + cw1 + cr;
    totalsCost[i] += cost;
  }

  MODEL_COLORS = {};
  models.forEach((m, i) => (MODEL_COLORS[m] = PALETTE[i % PALETTE.length]));

  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
  return {
    buckets, labels: buckets.map((b) => bucketLabel(b, gran)), gran, models, perModel,
    tokensIn, tokensOut, tokensCache, totalsCost, byHour, projects,
    kpi: { cost: kCost, msgs: kMsgs, tokens: kTok, days: spanDays, top: models[0] || '—' },
    prevCost, start, end,
  };
}

// ─── Tema base ECharts ───────────────────────────────────────────────────────
function baseGrid(extra = {}) {
  return { left: 50, right: 16, top: 18, bottom: 34, ...extra };
}
function tooltipBox() {
  return {
    backgroundColor: C.tipBg, borderColor: C.line, borderWidth: 1,
    textStyle: { color: C.fg, fontFamily: MONO, fontSize: 11.5 },
    padding: [9, 12], extraCssText: 'border-radius:9px;box-shadow:0 10px 30px -10px rgba(0,0,0,.45);',
  };
}
function axisCommon(isTime = false) {
  return {
    axisLine: { lineStyle: { color: C.line } },
    axisTick: { show: false },
    axisLabel: { color: C.muted, fontFamily: MONO, fontSize: 10.5, hideOverlap: true },
    splitLine: { show: !isTime, lineStyle: { color: C.lineSoft } },
  };
}

// ─── Render principal ──────────────────────────────────────────────────────
function render() {
  const a = aggregate(CURRENT, FILTER);
  renderKPIs(a);
  renderSpend(a);
  renderDonut(a);
  renderMonthly(FILTER);
  renderProjects(a);
  renderTokens(a);
  renderHour(a);
  renderUtil(a);
  renderYield();
  renderYieldByModel();
  renderModelYieldEvolution();
  renderTable(a);

  const fmt = (d: Date) =>
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  document.getElementById('rangeMeta')!.innerHTML =
    `<b>${fmt(a.start)}</b> → <b>${fmt(a.end)}</b> · ${a.buckets.length} ${a.gran === 'hour' ? 'horas' : 'días'}`;
  document.getElementById('granLabel')!.textContent =
    a.gran === 'hour' ? 'resolución horaria' : 'resolución diaria';

  // Chip de filtro por proyecto.
  const chip = document.getElementById('projFilterChip')!;
  if (FILTER) {
    chip.hidden = false;
    chip.innerHTML = `proyecto · <b>${FILTER}</b> <span class="x">✕</span>`;
    chip.onclick = () => { FILTER = null; render(); };
  } else {
    chip.hidden = true;
  }
}

function renderKPIs(a: Agg) {
  const deltaPct = a.prevCost > 0 ? ((a.kpi.cost - a.prevCost) / a.prevCost) * 100 : null;
  const dCls = deltaPct === null ? 'flat' : deltaPct > 0.5 ? 'up' : deltaPct < -0.5 ? 'down' : 'flat';
  const dArrow = deltaPct === null ? '' : deltaPct > 0.5 ? '▲' : deltaPct < -0.5 ? '▼' : '◦';
  const dTxt = deltaPct === null ? 'sin periodo previo' :
    `${dArrow} ${Math.abs(deltaPct).toFixed(1)}% vs. anterior`;
  const topColor = MODEL_COLORS[a.kpi.top] || C.muted;
  const cards = [
    { l: 'Gasto del rango', v: money(a.kpi.cost, 2), sw: '#7c83ff', delta: { cls: dCls, txt: dTxt, arrow: '' }, sub: '' },
    { l: 'Media diaria', v: money(a.kpi.cost / a.kpi.days, 2), sw: '#f6b549', sub: `${a.kpi.days} días en rango` },
    { l: 'Mensajes', v: a.kpi.msgs.toLocaleString('es'), sw: '#4cc4f5', sub: `${(a.kpi.msgs / a.kpi.days).toFixed(0)}/día` },
    { l: 'Tokens', v: tok(a.kpi.tokens), sw: '#2dd4bf', sub: 'in+out+caché' },
    { l: 'Modelo top', v: shortModel(a.kpi.top), sw: topColor, mono: false, sub: money(a.perModel[a.kpi.top] ? a.perModel[a.kpi.top].reduce((x, y) => x + y, 0) : 0, 2) },
  ];
  document.getElementById('kpis')!.innerHTML = cards.map((c) => `
    <div class="kpi">
      <div class="label"><span class="swatch" style="background:${c.sw}"></span>${c.l}</div>
      <div class="value"${c.mono === false ? ' style="font-size:21px"' : ''}>${c.v}</div>
      ${c.delta ? `<div class="delta ${c.delta.cls}">${c.delta.txt}</div>` : c.sub ? `<div class="sub">${c.sub}</div>` : ''}
    </div>`).join('');
}

function renderSpend(a: Agg) {
  const c = (charts.spend ||= echarts.init(document.getElementById('spendChart')!, undefined, { renderer: 'canvas' }));
  const series = a.models.map((m) => {
    const col = MODEL_COLORS[m];
    return {
      name: shortModel(m), type: 'line', stack: 'cost', smooth: 0.15, symbol: 'none',
      lineStyle: { width: 1, color: col }, emphasis: { focus: 'series' },
      areaStyle: {
        opacity: 0.85,
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: col + 'cc' }, { offset: 1, color: col + '10' },
        ]),
      },
      data: a.perModel[m],
    };
  });
  c.setOption({
    color: a.models.map((m) => MODEL_COLORS[m]),
    legend: { show: false, data: a.models.map(shortModel) },
    grid: baseGrid({ bottom: 50 }),
    tooltip: {
      trigger: 'axis', ...tooltipBox(),
      axisPointer: { type: 'line', lineStyle: { color: C.muted, type: 'dashed' } },
      formatter: (ps: any[]) => {
        let total = 0; ps.forEach((p) => (total += p.value || 0));
        const rows = ps.filter((p) => p.value > 0).sort((x, y) => y.value - x.value)
          .map((p) => `<div style="display:flex;justify-content:space-between;gap:18px">
            <span>${p.marker}${p.seriesName}</span><span>${money(p.value)}</span></div>`).join('');
        return `<div style="color:${C.muted};margin-bottom:5px">${ps[0].axisValue}</div>${rows}
          <div style="display:flex;justify-content:space-between;gap:18px;margin-top:5px;padding-top:5px;border-top:1px solid ${C.line};color:${C.fg}">
          <span>Total</span><span>${money(total)}</span></div>`;
      },
    },
    xAxis: { type: 'category', data: a.labels, boundaryGap: false, ...axisCommon(true) },
    yAxis: { type: 'value', ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => '$' + v } },
    dataZoom: [
      { type: 'inside', throttle: 50 },
      { type: 'slider', height: 16, bottom: 8, borderColor: C.line, fillerColor: '#7c83ff22',
        handleStyle: { color: '#7c83ff' }, moveHandleStyle: { color: C.line },
        dataBackground: { lineStyle: { color: C.line }, areaStyle: { color: C.lineSoft } },
        textStyle: { color: C.muted, fontFamily: MONO, fontSize: 9 } },
    ],
    series,
  }, true);
  renderLegend(a);
}

function renderLegend(a: Agg) {
  const el = document.getElementById('modelLegend')!;
  el.innerHTML = a.models.map((m) => {
    const total = a.perModel[m].reduce((x, y) => x + y, 0);
    return `<span class="item" data-model="${shortModel(m)}">
      <i style="background:${MODEL_COLORS[m]}"></i>${shortModel(m)}
      <span class="v">${money(total, 2)}</span></span>`;
  }).join('');
  el.querySelectorAll<HTMLElement>('.item').forEach((it) => {
    it.onclick = () => {
      it.classList.toggle('off');
      charts.spend.dispatchAction({ type: 'legendToggleSelect', name: it.dataset.model });
    };
  });
}

function renderDonut(a: Agg) {
  const c = (charts.donut ||= echarts.init(document.getElementById('donutChart')!));
  const data = a.models.map((m) => ({
    name: shortModel(m), value: +a.perModel[m].reduce((x, y) => x + y, 0).toFixed(4),
    itemStyle: { color: MODEL_COLORS[m] },
  }));
  const total = a.kpi.cost;
  document.getElementById('modelTotal')!.textContent = money(total, 2);
  c.setOption({
    tooltip: {
      trigger: 'item', ...tooltipBox(),
      formatter: (p: any) => `${p.marker}${p.name}<br/><b>${money(p.value)}</b> · ${p.percent}%`,
    },
    series: [{
      type: 'pie', radius: ['58%', '82%'], center: ['50%', '52%'], avoidLabelOverlap: true,
      padAngle: 2, itemStyle: { borderRadius: 4, borderColor: C.panel, borderWidth: 2 },
      label: { show: true, position: 'outside', color: C.dim, fontFamily: MONO, fontSize: 10.5,
        formatter: (p: any) => `${p.name}\n${p.percent}%` },
      labelLine: { length: 8, length2: 8, lineStyle: { color: C.line } },
      data,
    }, {
      type: 'pie', radius: [0, 0], center: ['50%', '52%'], silent: true,
      label: { position: 'center', formatter: () => `{v|${money(total, 2)}}\n{l|total}`,
        rich: { v: { color: C.fg, fontFamily: MONO, fontSize: 19, fontWeight: 'bold' },
                l: { color: C.muted, fontSize: 11, padding: [4, 0, 0, 0] } } },
      data: [{ value: 1 }],
    }],
  }, true);
}

function renderMonthly(projFilter: string | null) {
  const c = (charts.month ||= echarts.init(document.getElementById('monthChart')!));
  const rows = monthlyData(projFilter);
  const labels = rows.map((r) => {
    const [y, m] = r.month.split('-');
    return `${MONTH_NAMES[+m - 1]} ${y.slice(2)}`;
  });
  const nowMonth = new Date().toISOString().slice(0, 7);
  // MoM del último mes para el hint de cabecera.
  if (rows.length >= 2) {
    const last = rows[rows.length - 1].cost, prev = rows[rows.length - 2].cost;
    const d = prev > 0 ? ((last - prev) / prev) * 100 : 0;
    const el = document.getElementById('momHint');
    if (el) el.innerHTML = `<span style="color:${d >= 0 ? '#fb7185' : '#34d399'}">` +
      `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}% MoM</span>`;
  }
  c.setOption({
    grid: baseGrid({ left: 52, bottom: 28 }),
    tooltip: {
      trigger: 'axis', ...tooltipBox(),
      formatter: (ps: any[]) => {
        const i = ps[0].dataIndex; const r = rows[i];
        let delta = '';
        if (i > 0 && rows[i - 1].cost > 0) {
          const d = ((r.cost - rows[i - 1].cost) / rows[i - 1].cost) * 100;
          delta = `<div style="margin-top:4px;color:${d >= 0 ? '#fb7185' : '#34d399'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}% vs. mes previo</div>`;
        }
        return `<div style="color:${C.muted};margin-bottom:4px">${ps[0].axisValue}</div>` +
          `<b>${money(r.cost, 2)}</b><div style="color:${C.dim};font-size:11px;margin-top:2px">${tok(r.tokens)} tok · ${r.msgs} msg</div>${delta}`;
      },
    },
    xAxis: { type: 'category', data: labels, ...axisCommon(true) },
    yAxis: { type: 'value', ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => '$' + v } },
    series: [{
      type: 'bar', barWidth: '52%', data: rows.map((r) => ({
        value: +r.cost.toFixed(4),
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1,
            r.month === nowMonth
              ? [{ offset: 0, color: '#2dd4bf' }, { offset: 1, color: '#2dd4bf33' }]
              : [{ offset: 0, color: '#7c83ff' }, { offset: 1, color: '#7c83ff33' }]),
        },
      })),
      markLine: rows.length > 2 ? {
        silent: true, symbol: 'none',
        lineStyle: { color: C.muted, type: 'dashed', width: 1 },
        label: { color: C.muted, fontFamily: MONO, fontSize: 9, formatter: 'media' },
        data: [{ yAxis: +(rows.reduce((s, r) => s + r.cost, 0) / rows.length).toFixed(2) }],
      } : undefined,
    }],
  }, true);
}

function renderProjects(a: Agg) {
  const c = (charts.project ||= echarts.init(document.getElementById('projectChart')!));
  const TOP = 9;
  let items = a.projects.slice();
  if (items.length > TOP) {
    const otros = items.slice(TOP).reduce((s, [, v]) => s + v, 0);
    items = items.slice(0, TOP);
    if (otros > 0) items.push(['otros', otros]);
  }
  items.reverse(); // ECharts yAxis pinta de abajo arriba
  const fullNames = items.map(([n]) => n); // alineado con dataIndex
  const total = (a.projects.reduce((s, [, v]) => s + v, 0)) || 1;
  const names = items.map(([n]) => (n.length > 20 ? n.slice(0, 19) + '…' : n));
  document.getElementById('projHint')!.textContent =
    FILTER ? `filtrando · ${FILTER}` : `${a.projects.length} en el rango · clic para filtrar`;
  c.setOption({
    grid: { left: 8, right: 70, top: 10, bottom: 16, containLabel: true },
    tooltip: {
      trigger: 'item', ...tooltipBox(),
      formatter: (p: any) => `${fullNames[p.dataIndex]}<br/><b>${money(p.value)}</b> · ${(p.value / total * 100).toFixed(1)}%` +
        `<div style="color:${C.muted};font-size:10.5px;margin-top:3px">${fullNames[p.dataIndex] === 'otros' ? '' : 'clic para filtrar el dashboard'}</div>`,
    },
    xAxis: { type: 'value', ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => '$' + v } },
    yAxis: {
      type: 'category', data: names,
      axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
      axisLabel: { color: C.dim, fontFamily: MONO, fontSize: 11 },
      splitLine: { show: false },
    },
    series: [{
      type: 'bar', barWidth: '62%', cursor: 'pointer',
      label: {
        show: true, position: 'right', color: C.muted, fontFamily: MONO, fontSize: 10.5,
        formatter: (p: any) => `${money(p.value, 2)}  ${(p.value / total * 100).toFixed(0)}%`,
      },
      data: items.map(([name, v], i) => {
        const sel = FILTER === name;
        const dim = FILTER && !sel;
        return {
          value: +v.toFixed(4),
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: PALETTE[(items.length - 1 - i) % PALETTE.length],
            opacity: dim ? 0.3 : 1,
            borderColor: sel ? C.fg : 'transparent',
            borderWidth: sel ? 1 : 0,
          },
        };
      }),
    }],
  }, true);
  c.off('click');
  c.on('click', (p: any) => {
    const name = fullNames[p.dataIndex];
    if (!name || name === 'otros') return;
    FILTER = FILTER === name ? null : name;
    render();
  });
}

function renderTokens(a: Agg) {
  const c = (charts.token ||= echarts.init(document.getElementById('tokenChart')!));
  const mk = (name: string, data: number[], color: string) => ({
    name, type: 'line', smooth: 0.15, symbol: 'none', lineStyle: { width: 1.5, color },
    areaStyle: { opacity: 0.12, color }, emphasis: { focus: 'series' }, data,
  });
  c.setOption({
    color: ['#7c83ff', '#2dd4bf', '#f6b549'],
    legend: { top: 6, right: 8, textStyle: { color: C.dim, fontFamily: MONO, fontSize: 10.5 },
      itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
    grid: baseGrid({ top: 30 }),
    tooltip: { trigger: 'axis', ...tooltipBox(),
      axisPointer: { type: 'line', lineStyle: { color: C.muted, type: 'dashed' } },
      formatter: (ps: any[]) => `<div style="color:${C.muted};margin-bottom:4px">${ps[0].axisValue}</div>` +
        ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:18px"><span>${p.marker}${p.seriesName}</span><span>${tok(p.value)}</span></div>`).join('') },
    xAxis: { type: 'category', data: a.labels, boundaryGap: false, ...axisCommon(true) },
    yAxis: { type: 'value', ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => tok(v) } },
    series: [mk('Entrada', a.tokensIn, '#7c83ff'), mk('Salida', a.tokensOut, '#2dd4bf'), mk('Caché', a.tokensCache, '#f6b549')],
  }, true);
}

function renderHour(a: Agg) {
  const c = (charts.hour ||= echarts.init(document.getElementById('hourChart')!));
  c.setOption({
    grid: baseGrid({ left: 46 }),
    tooltip: { trigger: 'axis', ...tooltipBox(),
      formatter: (ps: any[]) => `<b>${ps[0].axisValue}:00</b> — ${money(ps[0].value)}` },
    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => pad(i)), ...axisCommon(true),
      axisLabel: { ...axisCommon().axisLabel, interval: 1 } },
    yAxis: { type: 'value', ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => '$' + v } },
    series: [{
      type: 'bar', data: a.byHour, barWidth: '64%',
      itemStyle: {
        borderRadius: [3, 3, 0, 0],
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: '#7c83ff' }, { offset: 1, color: '#7c83ff44' }]),
      },
      emphasis: { itemStyle: { color: '#9aa0ff' } },
    }],
  }, true);
}

function renderUtil(a: Agg) {
  const c = (charts.util ||= echarts.init(document.getElementById('utilChart')!));
  const within = (ts: string) => { const d = new Date(ts); return d >= a.start && d <= a.end; };
  const s5: [number, number][] = [], s7: [number, number][] = [];
  for (const [ts, win, u] of DATA.util) {
    if (!within(ts)) continue;
    const t = new Date(ts).getTime();
    if (win === 'five_hour') s5.push([t, u]);
    else if (win === 'seven_day') s7.push([t, u]);
  }
  if (!s5.length && !s7.length) {
    c.clear();
    c.setOption({
      graphic: { type: 'text', left: 'center', top: 'middle',
        style: { text: 'Aún sin snapshots de % en este rango.\nEl timer los irá capturando cada 15 min.',
          fill: C.muted, fontFamily: MONO, fontSize: 12, lineHeight: 18, textAlign: 'center' } },
    }, true);
    return;
  }
  const mk = (name: string, data: [number, number][], color: string) => ({
    name, type: 'line', showSymbol: false, smooth: 0.1, lineStyle: { width: 1.6, color },
    areaStyle: { opacity: 0.1, color }, data,
  });
  c.setOption({
    color: ['#f6b549', '#4cc4f5'],
    legend: { top: 6, right: 8, textStyle: { color: C.dim, fontFamily: MONO, fontSize: 10.5 },
      itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
    grid: baseGrid({ top: 30 }),
    tooltip: { trigger: 'axis', ...tooltipBox(),
      formatter: (ps: any[]) => {
        const d = new Date(ps[0].value[0]);
        const head = `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return `<div style="color:${C.muted};margin-bottom:4px">${head}</div>` +
          ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:18px"><span>${p.marker}${p.seriesName}</span><span>${p.value[1].toFixed(0)}%</span></div>`).join('');
      } },
    xAxis: { type: 'time', ...axisCommon(true) },
    yAxis: { type: 'value', max: 100, min: 0, ...axisCommon(),
      axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => v + '%' } },
    series: [mk('Ventana 5h', s5, '#f6b549'), mk('Semanal 7d', s7, '#4cc4f5')],
  }, true);
}

// Rendimiento de tokens: cuánto % de ventana "cuestan" 100k tokens, en el tiempo.
// En cada snapshot (util=U%) sumo los tokens de la ventana móvil previa
// (5h / 7d) desde usage_hourly → %/100k = U ÷ (tokens/100k). Si sube, los
// tokens rinden peor. Es account-wide (la ventana es global, no por proyecto).
interface YieldPt { ts: number; pct100k: number; u: number; tokens: number; }
const WIN_MS: Record<string, number> = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 };
const MIN_UTIL = 2;

function computeYield(): Record<'five_hour' | 'seven_day', YieldPt[]> {
  const hb: Record<string, number> = {};
  for (const r of DATA.hourly) hb[r[0]] = (hb[r[0]] || 0) + r[3] + r[4] + r[5] + r[6] + r[7];
  const buckets = Object.entries(hb)
    .map(([h, t]) => [parseHour(h).getTime(), t] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const trailing = (endMs: number, winMs: number) => {
    const lo = endMs - winMs - 3600e3; // incluye la hora más antigua solapada
    let s = 0;
    for (const [t, tk] of buckets) if (t > lo && t <= endMs) s += tk;
    return s;
  };
  const out: Record<'five_hour' | 'seven_day', YieldPt[]> = { five_hour: [], seven_day: [] };
  for (const [ts, win, u] of DATA.util) {
    if (win !== 'five_hour' && win !== 'seven_day') continue;
    if (u < MIN_UTIL) continue;
    const endMs = new Date(ts).getTime();
    const tokens = trailing(endMs, WIN_MS[win]);
    if (tokens <= 0) continue;
    out[win as 'five_hour' | 'seven_day'].push({ ts: endMs, pct100k: u / (tokens / 1e5), u, tokens });
  }
  return out;
}

function renderYield() {
  const c = (charts.yield ||= echarts.init(document.getElementById('yieldChart')!));
  const y = computeYield();
  const s5 = y.five_hour, s7 = y.seven_day;
  const statEl = document.getElementById('yieldStat')!;
  const noteEl = document.getElementById('yieldNote')!;

  if (s5.length + s7.length === 0) {
    statEl.textContent = '';
    noteEl.textContent = '';
    c.clear();
    c.setOption({
      graphic: {
        type: 'text', left: 'center', top: 'middle',
        style: {
          text: 'Acumulando… esta métrica empareja cada snapshot de % con los\ntokens de su ventana. El timer captura uno cada 15 min;\nen unos días verás la tendencia.',
          fill: C.muted, fontFamily: MONO, fontSize: 12, lineHeight: 18, textAlign: 'center',
        },
      },
    }, true);
    return;
  }

  // Resumen de tendencia para la 5h (primera mitad vs segunda mitad).
  if (s5.length >= 4) {
    const mid = Math.floor(s5.length / 2);
    const avg = (arr: YieldPt[]) => arr.reduce((s, p) => s + p.pct100k, 0) / arr.length;
    const a0 = avg(s5.slice(0, mid)), a1 = avg(s5.slice(mid));
    const d = a0 > 0 ? ((a1 - a0) / a0) * 100 : 0;
    const col = d > 1 ? '#fb7185' : d < -1 ? '#34d399' : C.muted;
    statEl.innerHTML = `5h · 100k tok ≈ <b>${a1.toFixed(2)}%</b> ` +
      `<span style="color:${C.muted}">(antes ${a0.toFixed(2)}%)</span> ` +
      `<span style="color:${col}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span>`;
    noteEl.textContent = d > 1 ? 'los tokens rinden peor que antes' : d < -1 ? 'los tokens rinden mejor que antes' : 'estable';
  } else {
    const last = s5[s5.length - 1] || s7[s7.length - 1];
    statEl.innerHTML = `100k tok ≈ <b>${last.pct100k.toFixed(2)}%</b> de la ventana`;
    noteEl.textContent = `${s5.length + s7.length} muestras · sigue acumulando para la tendencia`;
  }

  const mk = (name: string, data: YieldPt[], color: string, dashed = false) => ({
    name, type: 'line', showSymbol: true, symbolSize: 5, smooth: 0.1,
    lineStyle: { width: 1.8, color, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color }, areaStyle: dashed ? undefined : { opacity: 0.08, color },
    data: data.map((p) => [p.ts, +p.pct100k.toFixed(3)]),
  });
  c.setOption({
    color: ['#b18bff', '#4cc4f5'],
    legend: {
      top: 6, right: 8, data: ['Ventana 5h', 'Ventana 7d'],
      textStyle: { color: C.dim, fontFamily: MONO, fontSize: 10.5 }, itemWidth: 12, itemHeight: 8, icon: 'roundRect',
    },
    grid: baseGrid({ top: 30, left: 56 }),
    tooltip: {
      trigger: 'axis', ...tooltipBox(),
      formatter: (ps: any[]) => {
        const d = new Date(ps[0].value[0]);
        const head = `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const find = (n: string, arr: YieldPt[]) => {
          const p = ps.find((x) => x.seriesName === n);
          if (!p) return '';
          const yp = arr.find((q) => q.ts === p.value[0]);
          return `<div style="display:flex;justify-content:space-between;gap:18px">
            <span>${p.marker}${n}</span><span>${p.value[1]}% / 100k</span></div>` +
            (yp ? `<div style="color:${C.muted};font-size:10px;text-align:right">${tok(yp.tokens)} tok · ${yp.u.toFixed(0)}% usado</div>` : '');
        };
        return `<div style="color:${C.muted};margin-bottom:4px">${head}</div>${find('Ventana 5h', s5)}${find('Ventana 7d', s7)}`;
      },
    },
    xAxis: { type: 'time', ...axisCommon(true) },
    yAxis: {
      type: 'value', ...axisCommon(), name: '% / 100k tok', nameLocation: 'middle', nameGap: 40,
      nameTextStyle: { color: C.muted, fontFamily: MONO, fontSize: 10 },
      axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => v + '%' },
    },
    series: [mk('Ventana 5h', s5, '#b18bff'), mk('Ventana 7d', s7, '#4cc4f5', true)],
  }, true);
}

// Descompone el %/100k por modelo. La utilización es global, así que
// estimamos β_m (%/100k de cada modelo) resolviendo  U_i ≈ Σ_m x_{i,m}·β_m
// por mínimos cuadrados NO negativos (NNLS, descenso por coordenadas) sobre
// los snapshots. Neutraliza el mix: separa cuánto "pesa" cada modelo.
function nnls(X: number[][], y: number[], iters = 300): number[] {
  const n = X.length, m = n ? X[0].length : 0;
  const beta = new Array(m).fill(0);
  const colSq = new Array(m).fill(0);
  for (let j = 0; j < m; j++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][j] * X[i][j]; colSq[j] = s || 1e-9; }
  const r = y.slice();
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < m; j++) {
      let num = 0;
      for (let i = 0; i < n; i++) { r[i] += X[i][j] * beta[j]; num += X[i][j] * r[i]; }
      const bj = Math.max(0, num / colSq[j]);
      beta[j] = bj;
      for (let i = 0; i < n; i++) r[i] -= X[i][j] * bj;
    }
  }
  return beta;
}

function renderYieldByModel() {
  const c = (charts.yieldModel ||= echarts.init(document.getElementById('yieldModelChart')!));
  const noteEl = document.getElementById('yieldModelNote')!;

  // Tokens por (hora, modelo) → ventana móvil 5h por snapshot.
  const hbm: Record<number, Record<string, number>> = {};
  for (const r of DATA.hourly) {
    const ms = parseHour(r[0]).getTime();
    (hbm[ms] ||= {});
    hbm[ms][r[2]] = (hbm[ms][r[2]] || 0) + r[3] + r[4] + r[5] + r[6] + r[7];
  }
  const bucketMs = Object.keys(hbm).map(Number).sort((x, z) => x - z);
  const trailing = (endMs: number) => {
    const lo = endMs - WIN_MS.five_hour - 3600e3;
    const acc: Record<string, number> = {};
    for (const ms of bucketMs) {
      if (ms > lo && ms <= endMs) {
        for (const k in hbm[ms]) acc[k] = (acc[k] || 0) + hbm[ms][k];
      }
    }
    return acc;
  };

  const obs: { U: number; tok: Record<string, number> }[] = [];
  for (const [ts, win, u] of DATA.util) {
    if (win !== 'five_hour' || u < MIN_UTIL) continue;
    const acc = trailing(new Date(ts).getTime());
    if (Object.keys(acc).length) obs.push({ U: u, tok: acc });
  }

  const modelTok: Record<string, number> = {};
  obs.forEach((o) => { for (const k in o.tok) modelTok[k] = (modelTok[k] || 0) + o.tok[k]; });
  const models = Object.keys(modelTok).sort((a, b) => modelTok[b] - modelTok[a]);

  const MIN_OBS = 6;
  if (obs.length < MIN_OBS || models.length === 0) {
    noteEl.textContent = '';
    c.clear();
    c.setOption({
      graphic: {
        type: 'text', left: 'center', top: 'middle',
        style: {
          text: `Acumulando… (${obs.length}/${MIN_OBS} snapshots)\nSepara el %/100k por modelo en cuanto haya\nsuficientes muestras con mezcla de modelos.`,
          fill: C.muted, fontFamily: MONO, fontSize: 12, lineHeight: 18, textAlign: 'center',
        },
      },
    }, true);
    return;
  }

  // X en unidades de 100k tokens → β resulta en %/100k directamente.
  const X = obs.map((o) => models.map((m) => (o.tok[m] || 0) / 1e5));
  const y = obs.map((o) => o.U);
  const beta = nnls(X, y);

  // Calidad del ajuste (R²).
  const ybar = y.reduce((s, v) => s + v, 0) / y.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    const fit = models.reduce((s, m, j) => s + X[i][j] * beta[j], 0);
    ssRes += (y[i] - fit) ** 2; ssTot += (y[i] - ybar) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  const rows = models.map((m, j) => ({ m, beta: beta[j], color: MODEL_COLORS[m] || PALETTE[j % PALETTE.length] }))
    .filter((r) => r.beta > 0).sort((a, b) => b.beta - a.beta);
  rows.reverse();

  noteEl.innerHTML = `regresión NNLS sobre ${obs.length} snapshots · ajuste R²=${r2.toFixed(2)} · ` +
    `<span style="color:${C.muted}">menor = el modelo rinde mejor (más tokens por % de ventana)</span>`;

  c.setOption({
    grid: { left: 8, right: 70, top: 12, bottom: 16, containLabel: true },
    tooltip: {
      trigger: 'item', ...tooltipBox(),
      formatter: (p: any) => {
        const row = rows[p.dataIndex];
        const per1 = row.beta > 0 ? (1e5 / (100 / row.beta)) : 0; // tokens por 1%
        return `${shortModel(row.m)}<br/><b>${row.beta.toFixed(2)}%</b> / 100k tok` +
          `<div style="color:${C.muted};font-size:10.5px;margin-top:3px">≈ ${tok(per1)} tokens por 1% de la ventana 5h</div>`;
      },
    },
    xAxis: { type: 'value', ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => v + '%' } },
    yAxis: {
      type: 'category', data: rows.map((r) => shortModel(r.m)),
      axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
      axisLabel: { color: C.dim, fontFamily: MONO, fontSize: 11 }, splitLine: { show: false },
    },
    series: [{
      type: 'bar', barWidth: '55%',
      label: { show: true, position: 'right', color: C.dim, fontFamily: MONO, fontSize: 10.5,
        formatter: (p: any) => `${rows[p.dataIndex].beta.toFixed(2)}% / 100k` },
      data: rows.map((r) => ({ value: +r.beta.toFixed(3), itemStyle: { borderRadius: [0, 4, 4, 0], color: r.color } })),
    }],
  }, true);
}

function renderModelYieldEvolution() {
  const c = (charts.yieldEvo ||= echarts.init(document.getElementById('yieldEvoChart')!));
  const noteEl = document.getElementById('yieldEvoNote')!;
  const rows = (DATA.model_yield || []).filter((r) => r[1] === 'five_hour');

  if (rows.length === 0) {
    noteEl.textContent = '';
    c.clear();
    c.setOption({
      graphic: {
        type: 'text', left: 'center', top: 'middle',
        style: {
          text: 'Aún sin registros. Cada snapshot estampa el ratio %/100k\npor modelo con la fecha del día; en cuanto haya ≥6 snapshots\nempezarás a ver una línea por modelo evolucionando.',
          fill: C.muted, fontFamily: MONO, fontSize: 12, lineHeight: 18, textAlign: 'center',
        },
      },
    }, true);
    return;
  }

  const days = [...new Set(rows.map((r) => r[0]))].sort();
  const byModel: Record<string, Record<string, number>> = {};
  for (const [day, , model, beta] of rows) {
    (byModel[model] ||= {})[day] = beta;
  }
  const models = Object.keys(byModel).sort((a, b) => {
    const sa = Object.values(byModel[a]).reduce((s, v) => s + v, 0);
    const sb = Object.values(byModel[b]).reduce((s, v) => s + v, 0);
    return sb - sa;
  });
  const labels = days.map((d) => {
    const [, mm, dd] = d.split('-');
    const M = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return `${dd} ${M[+mm - 1]}`;
  });
  const colorFor = (m: string, i: number) => MODEL_COLORS[m] || PALETTE[i % PALETTE.length];
  const series = models.map((m, i) => ({
    name: shortModel(m), type: 'line', smooth: 0.12, connectNulls: true,
    showSymbol: true, symbolSize: 5, lineStyle: { width: 1.8, color: colorFor(m, i) },
    itemStyle: { color: colorFor(m, i) }, emphasis: { focus: 'series' },
    data: days.map((d) => (byModel[m][d] !== undefined ? +byModel[m][d].toFixed(3) : null)),
  }));
  const lastDay = days[days.length - 1];
  const r2 = rows.find((r) => r[0] === lastDay)?.[4];
  noteEl.innerHTML = `${days.length} día(s) registrados · último ajuste R²=${(r2 ?? 0).toFixed(2)} · ` +
    `<span style="color:${C.muted}">si una línea sube, los tokens de ese modelo rinden peor con el tiempo</span>`;

  c.setOption({
    color: models.map((m, i) => colorFor(m, i)),
    legend: { top: 6, right: 8, data: models.map(shortModel), textStyle: { color: C.dim, fontFamily: MONO, fontSize: 10.5 }, itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
    grid: baseGrid({ top: 30, left: 56 }),
    tooltip: {
      trigger: 'axis', ...tooltipBox(),
      valueFormatter: (v: any) => (v == null ? '—' : v + '% / 100k'),
    },
    xAxis: { type: 'category', data: labels, ...axisCommon(true) },
    yAxis: {
      type: 'value', ...axisCommon(), name: '% / 100k tok', nameLocation: 'middle', nameGap: 40,
      nameTextStyle: { color: C.muted, fontFamily: MONO, fontSize: 10 },
      axisLabel: { ...axisCommon().axisLabel, formatter: (v: number) => v + '%' },
    },
    series,
  }, true);
}

function renderTable(a: Agg) {
  const thead = document.querySelector('#detailTable thead')!;
  const tbody = document.querySelector('#detailTable tbody')!;
  thead.innerHTML = `<tr><th>${a.gran === 'hour' ? 'Hora' : 'Día'}</th><th>Gasto</th><th>Tokens</th><th>Modelo top</th></tr>`;
  const rows: string[] = [];
  for (let i = a.buckets.length - 1; i >= 0; i--) {
    const cost = a.totalsCost[i];
    if (cost <= 0) continue;
    const toks = a.tokensIn[i] + a.tokensOut[i] + a.tokensCache[i];
    let topM = '—', topV = 0;
    for (const m of a.models) { if (a.perModel[m][i] > topV) { topV = a.perModel[m][i]; topM = m; } }
    rows.push(`<tr><td>${a.labels[i]}</td><td>${money(cost)}</td><td>${tok(toks)}</td>
      <td style="color:${MODEL_COLORS[topM] || C.muted}">${shortModel(topM)}</td></tr>`);
  }
  tbody.innerHTML = rows.join('') || `<tr><td colspan="4" style="text-align:center;color:${C.muted}">sin actividad en el rango</td></tr>`;
  document.getElementById('tableHint')!.textContent = `${rows.length} ${a.gran === 'hour' ? 'horas' : 'días'} con actividad`;
}

// ─── Tema día/noche ──────────────────────────────────────────────────────────
function applyTheme(t: 'dark' | 'light', rerender = true) {
  THEME = t;
  C = THEMES[t];
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('cm-theme', t); } catch { /* ignora */ }
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = t === 'dark' ? '☀' : '☾';
  if (rerender && DATA) render();
}

function initTheme() {
  let t: 'dark' | 'light' = 'dark';
  const urlT = new URLSearchParams(location.search).get('theme');
  if (urlT === 'light' || urlT === 'dark') {
    t = urlT;
  } else {
    try {
      const saved = localStorage.getItem('cm-theme');
      if (saved === 'light' || saved === 'dark') t = saved;
      else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) t = 'light';
    } catch { /* ignora */ }
  }
  applyTheme(t, false);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.onclick = () => applyTheme(THEME === 'dark' ? 'light' : 'dark');
}

// ─── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  try {
    const res = await fetch('/api/metrics.json', { cache: 'no-store' });
    DATA = await res.json();
    if ((DATA as any).error) throw new Error((DATA as any).detail || (DATA as any).error);
    if (DATA.currency) CUR = { symbol: DATA.currency.symbol || '$', rate: DATA.currency.rate || 1 };
  } catch (e) {
    document.querySelector('.shell')!.innerHTML =
      `<div class="err">No se pudieron cargar las métricas.<br/>${String(e)}<br/><br/>
       ¿Has corrido <code>claude-metrics ingest</code>?</div>`;
    return;
  }

  const ing = DATA.last_ingest ? new Date(DATA.last_ingest) : new Date(DATA.generated_at);
  document.getElementById('updated')!.textContent =
    'actualizado ' + ing.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  document.querySelectorAll<HTMLButtonElement>('#range button').forEach((b) => {
    b.onclick = () => {
      CURRENT = b.dataset.range!;
      document.querySelectorAll('#range button').forEach((x) =>
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      render();
    };
  });

  render();
  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));
  // Refresco suave cada 2 min (relee el JSON; el timer mantiene los datos frescos).
  setInterval(async () => {
    try {
      const r = await fetch('/api/metrics.json', { cache: 'no-store' });
      const fresh = await r.json();
      if (!fresh.error) {
        DATA = fresh;
        if (DATA.currency) CUR = { symbol: DATA.currency.symbol || '$', rate: DATA.currency.rate || 1 };
        render();
      }
    } catch { /* ignora */ }
  }, 120000);
}

boot();
