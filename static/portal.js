/* Copyright (c) 2026 RV
 * Client portal — deliberately separate from app.js (which is wired to
 * index.html's DOM). Reuses the engine + styles only.
 *
 * Two entry modes:
 *   /p/<token>  deep link: resolve + magic-link login, straight to the view
 *   /portal     returning client: OTP login (or saved session) + list
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'pa_portal_token';
  const $ = (s) => document.querySelector(s);

  const fmtMoney = (v, dp = 0) => new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD',
    maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(v || 0);
  const fmtPct = (v, dp = 1) => (v * 100).toFixed(dp) + '%';
  const fmtNum = (v, dp = 0) => new Intl.NumberFormat('en-AU', {
    maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(v || 0);

  const state = {
    jwt: localStorage.getItem(TOKEN_KEY) || null,
    me: null,
    original: null,     // the agent's snapshot, pristine
    inputs: null,       // working copy (slider mutations)
    result: null,
    pid: null,
    targetProp: 0,      // which property the sliders edit
    portfolio: null,    // the portfolio being browsed (deep link), if any
  };

  async function api(path, opts = {}) {
    opts.headers = Object.assign(
      state.jwt ? { Authorization: 'Bearer ' + state.jwt } : {}, opts.headers || {});
    if (opts.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const resp = await fetch(path, opts);
    const body = await resp.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (!resp.ok || !body.ok) {
      const err = new Error(body.error || resp.statusText);
      err.status = resp.status;
      throw err;
    }
    return body.data;
  }

  function show(id) {
    ['#portal-home', '#portal-view', '#portal-portfolio', '#portal-closed'].forEach((s) =>
      $(s).classList.toggle('hidden', s !== id));
    if (id === '#portal-view' && intelView.map) {
      setTimeout(() => intelView.map.invalidateSize(), 80);
    }
  }

  // ------------------------------------------------------------------
  // Presentation rendering
  // ------------------------------------------------------------------

  const SLIDERS = [
    { key: 'purchasePrice', label: 'Purchase price', min: 200000, max: 2000000, step: 5000, fmt: fmtMoney },
    { key: 'weeklyRent', label: 'Weekly rent', min: 200, max: 2000, step: 5, fmt: (v) => fmtMoney(v) + '/wk' },
    { key: 'ipInterestRate', label: 'Interest rate', min: 0.02, max: 0.12, step: 0.0005, fmt: (v) => fmtPct(v, 2) },
    { key: 'expectedCapitalGrowthRate', label: 'Capital growth', min: 0, max: 0.12, step: 0.0025, fmt: (v) => fmtPct(v, 1) + '/yr' },
  ];

  function recalc() {
    state.result = window.PropertyAnalyserEngine.calculateAll(state.inputs);
    renderCards();
    renderTable();
    renderSliderValues();
    renderCharts();
    renderWhoPays();
    renderExit();
  }

  function activeProp() {
    return state.inputs.properties[state.targetProp];
  }

  function renderSliders() {
    const box = $('#p-sliders');
    const props = state.inputs.properties;
    let html = '';
    if (props.length > 1) {
      html += `<div class="field"><label>Sliders apply to</label>
        <select id="p-target">${props.map((p, i) =>
          `<option value="${i}" ${i === state.targetProp ? 'selected' : ''}>${escapeHtml(p.label || 'Investment property ' + (i + 1))}</option>`).join('')}
        </select></div>`;
    }
    html += SLIDERS.map((s) => `
      <div class="field slider-field"><label>${s.label} <span class="unit" id="sv-${s.key}"></span></label>
        <input type="range" data-slider="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"></div>`).join('');
    box.innerHTML = html;

    box.querySelectorAll('[data-slider]').forEach((el) => {
      el.value = activeProp()[el.dataset.slider];
      el.addEventListener('input', () => {
        activeProp()[el.dataset.slider] = Number(el.value);
        recalc();
      });
    });
    const target = $('#p-target');
    if (target) target.addEventListener('change', () => {
      state.targetProp = Number(target.value);
      box.querySelectorAll('[data-slider]').forEach((el) => { el.value = activeProp()[el.dataset.slider]; });
      renderSliderValues();
      loadPropertyIntel();
    });
  }

  function renderSliderValues() {
    SLIDERS.forEach((s) => {
      const el = $('#sv-' + s.key);
      if (el) el.textContent = s.fmt(activeProp()[s.key]);
      const range = document.querySelector(`[data-slider="${s.key}"]`);
      if (range) range.value = activeProp()[s.key];
    });
  }

  // ------------------------------------------------------------------
  // Documents + hold-period charts
  // ------------------------------------------------------------------

  function renderAttachments(docs) {
    const sec = $('#p-docs-sec');
    const host = $('#p-docs');
    if (!sec || !host) return;
    const list = docs || [];
    sec.classList.toggle('hidden', !list.length);
    host.innerHTML = list.map((d) => `
      <a class="p-doc" href="/api/attachments/${d.id}/file" target="_blank" rel="noopener">
        <span>${escapeHtml(d.displayName)}</span>
        <small>${d.bytes >= 1048576 ? (d.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(d.bytes / 1024)) + ' KB'}</small>
      </a>`).join('');
  }

  const pCharts = {};
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const chartMoney = (v) => (v < 0 ? '−$' : '$') + fmtNum(Math.abs(v) / 1000) + 'k';

  function drawChart(id, config) {
    const el = document.getElementById(id);
    if (!el || !window.Chart) return;
    if (pCharts[id]) pCharts[id].destroy();
    pCharts[id] = new Chart(el, config);
  }

  function renderCharts() {
    if (!window.Chart) return;
    const rows = state.result.rows || [];
    if (!rows.length) return;
    const labels = rows.map((r) => 'Y' + r.year);
    const tick = cssVar('--chart-tick') || '#64748b';
    const grid = cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)';
    const pri = cssVar('--pri') || '#6366f1';
    drawChart('p-chart-equity', {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Property value', data: rows.map((r) => r.propertyValue), borderColor: pri, backgroundColor: pri, tension: 0.15, pointRadius: 0 },
        { label: 'Total debt', data: rows.map((r) => r.totalDebt), borderColor: '#e11d48', backgroundColor: '#e11d48', tension: 0.15, pointRadius: 0 },
        { label: 'Net equity', data: rows.map((r) => r.netEquity), borderColor: '#059669', backgroundColor: '#059669', tension: 0.15, pointRadius: 0 },
      ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: tick, usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => ' ' + ctx.dataset.label + ': ' + chartMoney(ctx.parsed.y) } } },
        scales: {
          x: { ticks: { color: tick, maxTicksLimit: 10 }, grid: { color: grid } },
          y: { ticks: { color: tick, callback: chartMoney }, grid: { color: grid } } } },
    });
    drawChart('p-chart-cash', {
      type: 'bar',
      data: { labels, datasets: [{ label: 'After-tax cash flow',
        data: rows.map((r) => r.afterTaxCashFlow),
        backgroundColor: rows.map((r) => r.afterTaxCashFlow >= 0 ? 'rgba(5,150,105,.78)' : 'rgba(225,29,72,.78)'),
        borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ' ' + chartMoney(ctx.parsed.y) + (ctx.parsed.y < 0 ? ' needed' : ' surplus') } } },
        scales: {
          x: { ticks: { color: tick, maxTicksLimit: 10 }, grid: { display: false } },
          y: { ticks: { color: tick, callback: chartMoney }, grid: { color: grid } } } },
    });
  }

  function card(label, value, sub, cls) {
    return `<div class="card"><div class="label">${label}</div>
      <div class="value ${cls || ''}">${value}</div>
      <div class="card-sub">${sub || ''}</div></div>`;
  }

  function renderCards() {
    const r = state.result;
    const m = r.metrics;
    const price = m.purchasePrice;
    const rent = state.inputs.properties.reduce((s, p) => s + (p.weeklyRent || 0), 0);
    $('#p-cards').innerHTML = [
      card('Purchase price', fmtMoney(price),
        'duty ' + fmtMoney(m.transferDuty) + ' · cash in ' + fmtMoney(m.initialCashInvested)),
      card('Portfolio rent', fmtMoney(rent) + '/wk', 'gross yield ' + fmtPct(m.grossYield, 2)),
      card('Weekly out-of-pocket', fmtMoney(Math.max(0, m.weeklyOutOfPocket)),
        'after tax, year 1'),
      card('Year-1 tax refund', fmtMoney(Math.max(0, m.year1TaxRefund)),
        'negative gearing + depreciation', 'pos'),
      card('10-year equity', fmtMoney(m.tenYearEquity),
        'value less all debt'),
      card('Exit proceeds', fmtMoney(m.netSaleProceeds),
        'year ' + m.saleYear + ' sale, after CGT'),
    ].join('');
  }

  function renderTable() {
    const row = state.result.rows[0];
    const cols = (v) => `<td>${fmtMoney(v)}</td><td>${fmtMoney(v / 12)}</td>
      <td>${fmtMoney(v / 26)}</td><td>${fmtMoney(v / 52)}</td>`;
    const line = (label, v, bold) =>
      `<tr ${bold ? 'style="font-weight:600"' : ''}><td>${label}</td>${cols(v)}</tr>`;
    $('#p-cf-sub').textContent =
      `${state.result.properties.length > 1 ? 'Whole portfolio' : 'This property'}, year 1 (${row.calendarYear}) — ` +
      `land tax ${fmtMoney(row.landTax)}, all figures after vacancy and management.`;
    $('#p-table').innerHTML = `
      <thead><tr><th>Line item</th><th>Annual</th><th>Monthly</th><th>Fortnightly</th><th>Weekly</th></tr></thead><tbody>
      ${line('Gross rent', row.grossRent)}
      ${line('Operating expenses', -row.operatingExpenses)}
      ${line('Loan interest', -(row.ipInterest + row.equityLoanInterest))}
      ${line('Pre-tax cash flow', row.preTaxCashFlow, true)}
      ${line('Tax refund / (cost)', row.taxRefundOrCost)}
      ${line('After-tax cash flow', row.afterTaxCashFlow, true)}
      </tbody>`;
  }

  // ------------------------------------------------------------------
  // Property intelligence — live Queensland open data for the client
  // ------------------------------------------------------------------

  const intelView = {
    map: null,
    parcel: null,
    marker: null,
    cache: {},
    data: null,
  };

  const INTEL_BASEMAP =
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  function esriPolygonToGeoJSON(geom) {
    if (!geom || !geom.rings || !geom.rings.length) return null;
    return {
      type: 'Polygon',
      coordinates: geom.rings.map((r) => r.map(([x, y]) => [x, y]).reverse()),
    };
  }

  function loadPropertyIntel() {
    const sec = $('#p-property-sec');
    const p = activeProp();
    const meta = (p && p.addressMeta) || {};
    const lat = Number(meta.lat);
    const lon = Number(meta.lon);
    if (!p || !p.address || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      sec.classList.add('hidden');
      return;
    }
    sec.classList.remove('hidden');
    const key = lat.toFixed(4) + ',' + lon.toFixed(4);
    if (intelView.cache[key]) {
      renderIntel(intelView.cache[key]);
      return;
    }
    const jurisdiction = String(meta.state || state.inputs.state || '').toUpperCase();
    const isVic = jurisdiction === 'VIC' || jurisdiction === 'VICTORIA';
    $('#p-property-sub').textContent = 'Loading live government property data for ' + p.address + '…';
    api((isVic ? '/api/intel/vic-property' : '/api/intel/property') + '?lat=' + lat + '&lon=' + lon)
      .then((d) => {
        intelView.cache[key] = d;
        renderIntel(d);
      })
      .catch((err) => {
        $('#p-property-sub').textContent =
          'Live property data is unavailable right now: ' + err.message;
      });
  }

  function renderIntel(d) {
    intelView.data = d;
    const address = (activeProp() || {}).address || '';
    const subLabel = address
      ? address + ' — live government open data'
      : 'Live government open data';
    $('#p-property-sub').textContent = subLabel;

    if (d && d.jurisdiction === 'VIC') { renderVicIntel(d, subLabel); return; }

    const p = d.parcel || {};
    const lu = d.landUse || {};
    const rp = d.regionalPlan || {};
    const aoi = d.areasOfInterest || {};
    const flood = d.flood || {};
    const studies = flood.studies || [];
    const living = aoi.priorityLiving || [];

    $('#p-property-cards').innerHTML = [
      card('Lot on plan', escapeHtml(p.lotPlan || 'Not found'),
        escapeHtml(p.lot ? `Lot ${p.lot} on plan ${p.plan}` : 'No cadastral parcel at this point')),
      card('Land area', p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : '—', escapeHtml(p.tenure || '')),
      card('Location', escapeHtml(p.locality || '—'),
        escapeHtml(p.lga ? p.lga + ' Council' : '')),
      card('Land use', escapeHtml(lu.tertiary || lu.secondary || lu.primary || '—'),
        escapeHtml(lu.primary || '')),
      card('Regional plan', escapeHtml(rp.name || '—'),
        escapeHtml(rp.version ? rp.version + (rp.status ? ' · ' + rp.status : '') : '')),
      card('Flood study', studies.length ? studies.length + (studies.length === 1 ? ' study' : ' studies') : 'None here',
        escapeHtml(studies.length ? studies.map((s) => s.name).join(' · ') : 'No flood study mapped over this parcel')),
      card('Priority living area', escapeHtml(living.length ? living.join(', ') : 'Not in one'),
        'Area of regional interest'),
    ].join('');

    $('#p-property-sources').innerHTML = 'Source: ' + (d.sources || []).slice(0, 3).map((s) =>
      `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`).join(' · ');

    renderIntelMap(d);
  }

  function renderVicIntel(d, subLabel) {
    const p = d.parcel || {};
    const bf = d.bushfire || {};
    const prone = bf.prone === true ? 'Yes — designated BPA'
      : bf.prone === false ? 'No' : 'Unknown';
    $('#p-property-sub').textContent = subLabel;
    $('#p-property-cards').innerHTML = [
      card('Land parcel area', p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : '—', 'Vicmap Property · CC BY 4.0'),
      card('Property reference', escapeHtml(p.propertyReference || 'Not found'), 'Vicmap property feature identifier'),
      card('Location', escapeHtml((p.councilCode ? 'Council code ' + p.councilCode : '—')), 'Victorian cadastral record'),
      card('Bushfire prone area', prone, 'CFA designated BPA · ' + (bf.prone === true ? 'construction rules apply' : 'check before purchase')),
    ].join('');

    $('#p-property-sources').innerHTML = 'Source: ' + (d.sources || []).slice(0, 3).map((s) =>
      `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`).join(' · ');

    renderIntelMap(d);
  }

  function renderIntelMap(d) {
    const el = document.getElementById('p-property-map');
    if (!el || !window.L) return;
    if (!intelView.map) {
      intelView.map = L.map(el, { zoomControl: true, attributionControl: true });
      L.tileLayer(INTEL_BASEMAP, { maxZoom: 19, attribution: 'Imagery &copy; Esri' })
        .addTo(intelView.map);
      intelView.parcel = L.layerGroup();
    }
    setTimeout(() => intelView.map.invalidateSize(), 60);
    intelView.parcel.clearLayers();
    if (intelView.marker) intelView.map.removeLayer(intelView.marker);

    const { lat, lon } = d.coords;
    intelView.marker = L.circleMarker([lat, lon], {
      radius: 7, color: '#e11d48', weight: 3, fillColor: '#e11d48', fillOpacity: 0.35,
    }).addTo(intelView.map);

    const poly = esriPolygonToGeoJSON(d.parcelGeometry);
    if (poly) {
      const layer = L.geoJSON(poly, { style: { color: '#818cf8', weight: 3, fillOpacity: 0.12 } });
      intelView.parcel.addLayer(layer);
      intelView.map.fitBounds(layer.getBounds().pad(0.35));
    } else {
      intelView.map.setView([lat, lon], 18);
    }
  }

  async function refreshComments() {    const d = await api('/api/portal/presentation/' + state.pid);
    $('#p-comments').innerHTML = (d.events || []).length
      ? d.events.map((e) => {
        if (e.type === 'comment') {
          return `<div class="p-comment"><span class="p-comment-meta">comment · ${e.created_at.slice(0, 16).replace('T', ' ')}</span>${escapeHtml(e.body)}</div>`;
        }
        return `<div class="p-comment p-decision ${e.type === 'approved' ? 'pos' : 'warn'}">
          ${e.type === 'approved' ? 'Approved' : 'Changes requested'} · ${e.created_at.slice(0, 10)}${e.body ? ' — ' + escapeHtml(e.body) : ''}</div>`;
      }).join('')
      : '<div class="hint">No comments yet.</div>';
  }

  // ------------------------------------------------------------------
  // Portfolio view — one link, several properties
  // ------------------------------------------------------------------

  function pfBadge(decision) {
    if (decision === 'approved') return '<span class="badge pf-badge pos">approved</span>';
    if (decision === 'changes_requested') return '<span class="badge pf-badge warn">changes requested</span>';
    return '<span class="badge pf-badge">open</span>';
  }

  function renderPortfolio() {
    const pf = state.portfolio;
    if (!pf) return;
    $('#pf-title').textContent = pf.title || 'Your properties';
    const items = pf.items || [];
    const n = { approved: 0, changes_requested: 0 };
    items.forEach((i) => { if (n[i.decision] != null) n[i.decision] += 1; });
    $('#pf-rollup').textContent =
      `${items.length} propert${items.length === 1 ? 'y' : 'ies'} · ` +
      `${n.approved} approved · ${n.changes_requested} changes requested · ` +
      `${items.length - n.approved - n.changes_requested} to decide`;
    $('#pf-items').innerHTML = items.map((i) => {
      const chips = [];
      if (i.summary && i.summary.purchasePrice) chips.push(fmtMoney(i.summary.purchasePrice));
      if (i.summary && i.summary.weeklyRent) chips.push(fmtMoney(i.summary.weeklyRent) + '/wk');
      return `
        <div class="portal-item" data-pf-pid="${i.presentationId}">
          <div>
            <div class="portal-item-title">${escapeHtml(i.label || i.title)}</div>
            <div class="hint">${chips.length ? chips.join(' · ') + ' · ' : ''}open the full analysis →</div>
          </div>
          ${pfBadge(i.decision)}
        </div>`;
    }).join('');
    $('#pf-items').querySelectorAll('[data-pf-pid]').forEach((el) =>
      el.addEventListener('click', () => openPortfolioItem(Number(el.dataset.pfPid))));
  }

  function openPortfolio(pf) {
    state.portfolio = pf;
    state.pid = null;
    $('#p-print').classList.add('hidden');
    renderPortfolio();
    show('#portal-portfolio');
  }

  async function openPortfolioItem(pid) {
    try {
      const d = await api('/api/portal/presentation/' + pid);
      openPresentation(d);
    } catch (e) { msg('#pf-rollup', e.message); }
  }

  // A decision landed on the currently open item — reflect it in the
  // portfolio list so the roll-up is fresh when the client goes back.
  function updatePortfolioDecision(pid, decision) {
    if (!state.portfolio) return;
    const item = (state.portfolio.items || []).find((i) => i.presentationId === pid);
    if (item) item.decision = decision;
    renderPortfolio();
  }

  function openPresentation(d) {
    state.pid = d.id;
    state.attachments = d.attachments || [];
    state.original = JSON.parse(JSON.stringify(d.snapshot));
    state.inputs = JSON.parse(JSON.stringify(d.snapshot));
    // AI research payload rides the snapshot — kept out of model inputs
    state.extras = state.inputs.extras || null;
    delete state.inputs.extras;
    state.baseProjectionYears = state.inputs.projectionYears || 20;
    $('#p-title').textContent = d.title || 'Property proposal';
    $('#p-adjusted').classList.toggle('hidden', !d.usingMyAdjustments);
    $('#p-back').classList.toggle('hidden', !state.portfolio);
    state.targetProp = 0;
    renderAttachments(d.attachments);
    loadEvidence();
    renderSliders();
    recalc();
    loadPropertyIntel();
    $('#p-print').classList.remove('hidden');
    show('#portal-view');
    refreshComments().catch(() => {});
  }

  // ------------------------------------------------------------------
  // Report section picker (modular reports — keys mirror _SECTION_ORDER
  // in report.py and REPORT_SECTIONS in app.js)
  // ------------------------------------------------------------------

  const REPORT_SECTIONS = [
    { group: 'Core numbers', items: [
      ['cashflow', 'Cash flow — first year'],
      ['whoPays', 'Who pays the cost?'],
      ['projections', 'Projections over the hold'],
      ['exit', 'Exit & CGT'],
      ['properties', 'Per-property breakdown'],
    ] },
    { group: 'Intelligence', items: [
      ['propertyIntel', 'Property intelligence (parcel, zoning, hazards)'],
      ['dealCheck', 'Deal Check verdicts'],
      ['checks', 'Due-diligence checklist'],
      ['replacement', 'Replacement value'],
      ['listingCheck', 'Listing check'],
      ['areaSignals', 'Area signals'],
    ] },
    { group: 'Evidence & area', items: [
      ['rentalEvidence', 'Rental evidence'],
      ['salesEvidence', 'Sales evidence'],
      ['suburb', 'Suburb snapshot'],
    ] },
    { group: 'Attachments', items: [
      ['documents', 'Attached documents'],
    ] },
  ];

  function savedReportSections() {
    try {
      const v = JSON.parse(localStorage.getItem('pa_report_sections') || '[]');
      return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
    } catch (e) { return []; }
  }

  function closePortalReportDialog() {
    $('#report-dialog').classList.add('hidden');
  }

  function openPortalReportDialog() {
    const saved = savedReportSections();
    $('#report-dialog-groups').innerHTML = REPORT_SECTIONS.map((g) => `
      <div class="report-dialog-group">
        <div class="report-dialog-group-label">${g.group}</div>
        ${g.items.map(([key, label]) => `
          <label class="report-dialog-check"><input type="checkbox" data-report-section="${key}"
            ${!saved.length || saved.includes(key) ? 'checked' : ''}><span>${label}</span></label>`).join('')}
      </div>`).join('');
    $('#report-dialog').classList.remove('hidden');
  }

  function wirePortalReportDialog() {
    const overlay = $('#report-dialog');
    if (!overlay) return;
    $('#report-dialog-x').addEventListener('click', closePortalReportDialog);
    $('#report-dialog-cancel').addEventListener('click', closePortalReportDialog);
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) closePortalReportDialog(); });
    $('#report-dialog-select-all').addEventListener('click', () => {
      overlay.querySelectorAll('input[data-report-section]').forEach((cb) => { cb.checked = true; });
    });
    $('#report-dialog-download').addEventListener('click', async () => {
      const keys = [...overlay.querySelectorAll('input[data-report-section]:checked')]
        .map((cb) => cb.dataset.reportSection);
      if (!keys.length) { msg('#report-dialog-msg', 'Pick at least one section'); return; }
      localStorage.setItem('pa_report_sections', JSON.stringify(keys));
      closePortalReportDialog();
      try {
        await downloadPortalReport(keys);
      } catch (e) {
        window.print(); // offline / network error — browser print still works
      }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) closePortalReportDialog();
    });
  }

  async function downloadPortalReport(sections) {
    const payload = buildReportPayload();
    if (Array.isArray(sections) && sections.length) payload.sections = sections;
    const resp = await fetch(`/api/portal/presentation/${state.pid}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + state.jwt,
      },
      body: JSON.stringify(payload),
    });
    if ((resp.headers.get('Content-Type') || '').includes('pdf')) {
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ($('#p-title').textContent || 'proposal').replace(/[^\w -]/g, '') + '.pdf';
      a.click();
      URL.revokeObjectURL(a.href);
    } else {
      // WeasyPrint not installed server-side — open the print HTML.
      const html = await resp.text();
      const w = window.open('', '_blank');
      w.document.write(html);
      w.document.close();
    }
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  function bindActions() {
    wirePortalReportDialog();
    $('#p-reset').addEventListener('click', () => {
      state.inputs = JSON.parse(JSON.stringify(state.original));
      state.targetProp = 0;
      renderSliders();
      recalc();
      msg('#p-save-msg', "Back to the agent's numbers (not saved)");
    });
    $('#p-save').addEventListener('click', async () => {
      try {
        await api(`/api/portal/presentation/${state.pid}/adjustments`,
          { method: 'PUT', body: { inputs: state.inputs } });
        $('#p-adjusted').classList.remove('hidden');
        msg('#p-save-msg', 'Saved — your agent can see these numbers');
      } catch (e) { msg('#p-save-msg', e.message); }
    });
    $('#p-approve').addEventListener('click', () => decide('approve', 'Approved'));
    $('#p-changes').addEventListener('click', () => decide('request-changes', 'Changes requested'));
    $('#p-back').addEventListener('click', () => {
      state.pid = null;
      $('#p-print').classList.add('hidden');
      renderPortfolio();
      show('#portal-portfolio');
    });
    $('#p-horizon').addEventListener('change', (ev) => {
      // The engine computes year-by-year, so re-running at a longer horizon
      // and slicing is equivalent — exit stays tied to the sale year.
      state.inputs.projectionYears = Number(ev.target.value) || 20;
      recalc();
    });
    $('#p-comment').addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !ev.target.value.trim()) return;
      const body = ev.target.value.trim();
      ev.target.value = '';
      api(`/api/portal/presentation/${state.pid}/comment`, { method: 'POST', body: { body } })
        .then(refreshComments).catch((e) => msg('#p-decision-msg', e.message));
    });
    $('#portal-logout').addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      location.href = '/portal';
    });
    $('#p-print').addEventListener('click', openPortalReportDialog);
  }

  async function decide(action, doneMsg) {
    const body = ($('#p-comment').value || '').trim();
    try {
      await api(`/api/portal/presentation/${state.pid}/${action}`, { method: 'POST', body: { body } });
      $('#p-comment').value = '';
      msg('#p-decision-msg', doneMsg + ' — recorded');
      updatePortfolioDecision(state.pid, action === 'approve' ? 'approved' : 'changes_requested');
      refreshComments().catch(() => {});
    } catch (e) { msg('#p-decision-msg', e.message); }
  }

  function msg(sel, text) {
    const el = $(sel);
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
  }

  // Figures for the server-side report pack — engine outputs the server
  // cannot compute, kept numeric (server formats and renders).
  function buildReportPayload() {
    const E = window.PropertyAnalyserEngine;
    const r = state.result;
    const horizon = Number(state.inputs.projectionYears) || 20;
    const rows = r.rows.slice(0, horizon).map((row) => ({
      year: row.year,
      calendarYear: row.calendarYear,
      grossRent: row.grossRent,
      effectiveRent: row.effectiveRent,
      ipInterest: row.ipInterest,
      equityLoanInterest: row.equityLoanInterest,
      ipPrincipalRepayment: row.ipPrincipalRepayment,
      equityLoanPrincipalRepayment: row.equityLoanPrincipalRepayment,
      operatingExpenses: row.operatingExpenses,
      otherDeductibleClaims: row.otherDeductibleClaims,
      capitalWorksDepreciation: row.capitalWorksDepreciation,
      plantEquipmentDepreciation: row.plantEquipmentDepreciation,
      taxablePropertyResult: row.taxablePropertyResult,
      preTaxCashFlow: row.preTaxCashFlow,
      taxRefundOrCost: row.taxRefundOrCost,
      afterTaxCashFlow: row.afterTaxCashFlow,
      cumulativeAfterTaxCashFlow: row.cumulativeAfterTaxCashFlow,
    }));
    const year1 = rows[0] || {};
    const prop = state.inputs.properties[0] || {};
    const propSections = (r.properties || []).map((p) => {
      const raw = state.inputs.properties[p.index] || {};
      const row0 = (p.rows && p.rows[0]) || {};
      return {
        label: raw.label || p.label,
        address: raw.address || '',
        metrics: { purchasePrice: p.metrics.purchasePrice,
                   grossYield: p.metrics.grossYield, netYield: p.metrics.netYield,
                   year1AfterTaxCashFlow: p.metrics.year1AfterTaxCashFlow,
                   weeklyOutOfPocket: p.metrics.weeklyOutOfPocket,
                   tenYearEquity: p.metrics.tenYearEquity,
                   irrApproximation: p.metrics.irrApproximation },
        year1: { grossRent: row0.grossRent, vacancyLoss: row0.vacancyLoss,
                 effectiveRent: row0.effectiveRent, managementFees: row0.managementFees,
                 operatingExpenses: row0.operatingExpenses, landTax: row0.landTax,
                 ipInterest: row0.ipInterest, equityLoanInterest: row0.equityLoanInterest,
                 ipPrincipalRepayment: row0.ipPrincipalRepayment,
                 equityLoanPrincipalRepayment: row0.equityLoanPrincipalRepayment,
                 capitalWorksDepreciation: row0.capitalWorksDepreciation,
                 plantEquipmentDepreciation: row0.plantEquipmentDepreciation,
                 otherDeductibleClaims: row0.otherDeductibleClaims,
                 taxablePropertyResult: row0.taxablePropertyResult,
                 taxRefundOrCost: row0.taxRefundOrCost,
                 afterTaxCashFlow: row0.afterTaxCashFlow,
                 preTaxCashFlow: row0.preTaxCashFlow },
        exit: { saleYear: p.exit.saleYear, calendarSaleYear: p.exit.calendarSaleYear,
                salePrice: p.exit.salePrice, capitalGainsTax: p.exit.capitalGainsTax,
                netSaleProceeds: p.exit.netSaleProceeds,
                totalNetPosition: p.exit.totalNetPosition },
      };
    });
    return {
      client: ($('#portal-client').textContent || '').replace('Prepared for ', ''),
      title: $('#p-title').textContent,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--pri').trim() || '#6366f1',
      metrics: { purchasePrice: r.metrics.purchasePrice,
                 grossYield: r.metrics.grossYield, netYield: r.metrics.netYield,
                 irrApproximation: r.metrics.irrApproximation,
                 tenYearEquity: r.metrics.tenYearEquity,
                 netSaleProceeds: r.metrics.netSaleProceeds },
      funding: E.fundingStructure(state.inputs),
      loan: { rate: state.inputs.ipInterestRate },
      year1,
      taxSplit: E.ownerTaxSplit(state.inputs,
        year1.taxablePropertyResult || 0, 1),
      years: rows,
      horizon: rows.length,
      propertySections: propSections,
      exit: r.exit,
      checks: E.riskChecklist(state.inputs, null).checks,
      replacement: { landValue: state.inputs.landValue,
                     capitalWorksBase: state.inputs.capitalWorksBase },
      preTaxSeries: rows.map((row) => row.preTaxCashFlow),
      cashSeries: rows.map((row) => row.afterTaxCashFlow),
      subject: { price: prop.purchasePrice, weeklyRent: prop.weeklyRent,
                 landValue: prop.landValue, bedrooms: prop.bedrooms,
                 address: prop.address },
      // transient AI research shared by the BA rides the presentation
      // snapshot and is rendered by the server's report sections
      ...((state.extras) || {}),
    };
  }

  // ------------------------------------------------------------------
  // Evidence — sales/rental comparables, suburb data, who pays
  // ------------------------------------------------------------------

  const evidenceCache = {};

  function whoPaysSegments(y1) {
    const totalCost = (y1.ipInterest + y1.equityLoanInterest + y1.ipPrincipalRepayment
      + y1.equityLoanPrincipalRepayment + y1.operatingExpenses + y1.otherDeductibleClaims);
    const tenant = Math.min(Math.max(0, y1.effectiveRent), totalCost);
    const taxman = Math.max(0, y1.taxRefundOrCost);
    return [
      { label: 'Tenant', value: tenant, color: '#22c55e' },
      { label: 'Taxman', value: taxman, color: '#818cf8' },
      { label: 'You', value: totalCost - tenant - taxman, color: '#e11d48' },
    ];
  }

  function rowCost(r) {
    return (r.ipInterest + r.equityLoanInterest + r.ipPrincipalRepayment
      + r.equityLoanPrincipalRepayment + r.operatingExpenses + r.otherDeductibleClaims);
  }

  function renderWhoPays() {
    const host = $('#p-whopays');
    const rows = state.result.rows || [];
    if (host) {
      const y1 = rows[0];
      if (!y1) { host.innerHTML = ''; }
      else {
        const segs = whoPaysSegments(y1);
        const total = segs.reduce((s, x) => s + Math.abs(x.value), 0) || 1;
        host.innerHTML = '<div class="stack">' + segs.map((s) => {
          const pctv = Math.abs(s.value) / total * 100;
          if (pctv < 0.5) return '';
          return `<div class="seg" style="width:${pctv.toFixed(1)}%;background:${s.color}"><span>${s.label} ${pctv.toFixed(0)}%</span></div>`;
        }).join('') + '</div><div class="stack-cap">First year — how the holding cost is shared</div>';
      }
    }

    // Per-year stacked chart + data table, mirroring the PIA pack.
    const canvas = $('#p-chart-whopays');
    const table = $('#p-whopays-table');
    if (table && rows.length) {
      const money = (v) => fmtMoney(v);
      table.innerHTML = `
        <table class="ev-table"><thead><tr><th>Year</th><th>Tenant pays</th>
        <th>Taxman pays</th><th>You pay</th></tr></thead><tbody>
        ${rows.map((r) => {
          const segs = whoPaysSegments(r);
          return `<tr><td>Y${r.year}</td>
            <td>${money(segs[0].value)}</td><td>${money(segs[1].value)}</td>
            <td>${money(segs[2].value)}</td></tr>`;
        }).join('')}
        </tbody></table>`;
    }
    if (!canvas || !window.Chart || !rows.length) return;
    const tick = cssVar('--chart-tick') || '#64748b';
    const grid = cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)';
    const share = (fn) => rows.map((r) => {
      const segs = whoPaysSegments(r);
      const total = segs.reduce((s, x) => s + Math.abs(x.value), 0) || 1;
      return Math.abs(fn(segs)) / total * 100;
    });
    const datasets = [
      { label: 'Tenant', data: share((s) => s[0].value), backgroundColor: '#22c55e' },
      { label: 'Taxman', data: share((s) => s[1].value), backgroundColor: '#818cf8' },
      { label: 'You', data: share((s) => Math.max(0, s[2].value)), backgroundColor: '#e11d48' },
    ];
    if (pCharts['p-chart-whopays']) pCharts['p-chart-whopays'].destroy();
    pCharts['p-chart-whopays'] = new Chart(canvas, {
      type: 'bar',
      data: { labels: rows.map((r) => 'Y' + r.year), datasets },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: tick, usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(1) + '%' } } },
        scales: {
          x: { stacked: true, ticks: { color: tick, maxTicksLimit: 16 }, grid: { display: false } },
          y: { stacked: true, max: 100, ticks: { color: tick, callback: (v) => v + '%' }, grid: { color: grid } } } },
    });
  }

  function renderExit() {
    const sec = $('#p-exit-sec');
    const host = $('#p-exit');
    const sub = $('#p-exit-sub');
    if (!sec || !host) return;
    // Exit stays tied to the scenario's assumed sale year — the horizon
    // selector only scales the cash-flow view, never the sale assumption.
    const base = Number(state.baseProjectionYears) || 20;
    let x = state.result.exit;
    if (Number(state.inputs.projectionYears) !== base && window.PropertyAnalyserEngine) {
      const inputs = JSON.parse(JSON.stringify(state.inputs));
      inputs.projectionYears = base;
      x = window.PropertyAnalyserEngine.calculateAll(inputs).exit;
    }
    if (!x || !x.saleYear) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    if (sub) {
      sub.textContent = `Sale in year ${x.saleYear} (${x.calendarSaleYear}) — after selling costs, `
        + `CGT${x.heldMoreThan12Months ? ' with the 50% discount' : ''} and loan payouts. `
        + 'The sale year is an assumption in the agent\'s numbers.';
    }
    const row = (k, v, strong) => `<div${strong ? ' class="ev-strong"' : ''}><span class="k">${k}</span> <strong>${v}</strong></div>`;
    host.innerHTML = [
      row('Sale price (year ' + x.saleYear + ')', fmtMoney(x.salePrice)),
      row('Selling costs', '−' + fmtMoney(x.sellingCosts)),
      row('Capital gain', fmtMoney(x.capitalGain)),
      row('CGT' + (x.heldMoreThan12Months ? ' (50% discount)' : ''), '−' + fmtMoney(x.capitalGainsTax)),
      row('Loan payout at sale', '−' + fmtMoney((x.ipLoanBalanceAtSale || 0) + (x.equityLoanBalanceAtSale || 0))),
      row('Net sale proceeds', fmtMoney(x.netSaleProceeds), true),
      row('Total net position (incl. cash flow)', fmtMoney(x.totalNetPosition), true),
    ].join('');
  }

  function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  function renderEvidence(ev) {
    const sec = $('#p-evidence-sec');
    const host = $('#p-evidence');
    if (!sec || !host) return;
    ev = ev || {};
    const subject = state.inputs.properties[0] || {};
    const bits = [];

    if (ev.whoPays !== false) {
      bits.push('<h2>Who pays the cost?</h2><div id="p-whopays"></div>');
    }
    if (ev.rentals && ev.rentals.length) {
      const rents = ev.rentals.map((r) => r.rentWeekly).filter((x) => x > 0);
      const med = median(rents);
      const pos = subject.weeklyRent && subject.weeklyRent > med ? 'above market' : 'in line with market';
      bits.push(`
        <h3>Rental evidence</h3>
        <table class="ev-table"><thead><tr><th>Comparable rental</th><th>Rent/week</th><th>Beds</th></tr></thead><tbody>
        ${ev.rentals.map((r) => `<tr><td>${escapeHtml(r.address)}</td><td>${fmtMoney(r.rentWeekly)}</td><td>${r.bedrooms ?? '—'}</td></tr>`).join('')}
        </tbody></table>
        <div class="ev-note">Median ${fmtMoney(med)}/wk across ${rents.length} comparables · subject rent ${fmtMoney(subject.weeklyRent || 0)}/wk — <strong>${pos}</strong></div>`);
    }
    if (ev.comps && ev.comps.length) {
      const prices = ev.comps.map((c) => c.soldPrice).filter((x) => x > 0);
      const med = median(prices);
      const br = ev.buyRange && ev.buyRange.low && ev.buyRange.high
        ? ` · target range ${fmtMoney(ev.buyRange.low)}–${fmtMoney(ev.buyRange.high)}` : '';
      bits.push(`
        <h3>Sales evidence</h3>
        <table class="ev-table"><thead><tr><th>Comparable sale</th><th>Sold price</th><th>Sold</th><th>Beds</th><th>Land</th></tr></thead><tbody>
        ${ev.comps.map((c) => `<tr><td>${escapeHtml(c.address)}</td><td>${fmtMoney(c.soldPrice)}</td><td>${escapeHtml(c.soldDate || '')}</td><td>${c.beds ?? '—'}</td><td>${c.landM2 ? fmtNum(c.landM2) + ' m²' : '—'}</td></tr>`).join('')}
        </tbody></table>
        <div class="ev-note">Median ${fmtMoney(med)} across ${prices.length} sales · subject ${fmtMoney(subject.purchasePrice || 0)}${br}</div>`);
    }
    if (ev.suburb) {
      const s = ev.suburb;
      const row = (k, v) => v != null && v !== '' ? `<div><span class="k">${escapeHtml(k)}</span> <strong>${escapeHtml(String(v))}</strong></div>` : '';
      bits.push(`
        <h3>Suburb snapshot${s.name ? ' · ' + escapeHtml([s.name, s.postcode, s.state].filter(Boolean).join(' ')) : ''}</h3>
        <div class="ev-grid">
        ${row('Median sale price', s.medianPrice != null ? fmtMoney(s.medianPrice) : null)}
        ${row('Median rent (3 bed)', s.medianRent3Bed != null ? fmtMoney(s.medianRent3Bed) + '/wk' : null)}
        ${row('Vacancy rate', s.vacancyPct != null ? s.vacancyPct.toFixed(1) + '%' : null)}
        ${row('5-year growth', s.growth5yrPct != null ? s.growth5yrPct.toFixed(1) + '%' : null)}
        ${row('Days on market', s.medianDaysOnMarket != null ? s.medianDaysOnMarket : null)}
        </div>`);
    }
    const ov = ev.overlays || {};
    const ovBits = [];
    if (ov.floodStudies != null) {
      ovBits.push(`Flood studies: ${ov.floodStudies.length ? escapeHtml(ov.floodStudies.join(', ')) : 'none mapped'}`);
    }
    if (ov.bushfireProne != null) {
      ovBits.push(`Bushfire prone: ${ov.bushfireProne ? 'Yes' : 'No'}`);
    }
    if (ovBits.length) bits.push(`<div class="ev-note">${ovBits.join(' · ')}</div>`);

    sec.classList.toggle('hidden', !bits.length);
    if (!bits.length) return;
    host.innerHTML = bits.join('');
    renderWhoPays();
  }

  async function loadEvidence() {
    const key = state.pid;
    if (!key) return;
    if (evidenceCache[key]) { renderEvidence(evidenceCache[key]); return; }
    try {
      const d = await api(`/api/portal/presentation/${key}/evidence`);
      evidenceCache[key] = d;
      renderEvidence(d);
      renderDealCheckPortal(d).catch(() => {});
    } catch (e) { /* evidence is best-effort */ }
  }

  // ------------------------------------------------------------------
  // Deal check — same verdict engines as the agent's app, fed by the
  // presentation snapshot and the portal's evidence payload.
  // ------------------------------------------------------------------

  function portalSuburb(evSub) {
    if (!evSub) return null;
    const v = (x) => (x == null ? null : Number(x));
    return {
      medianPrice: v(evSub.median_price),
      medianRent2Bed: v(evSub.median_rent_2bed),
      medianRent3Bed: v(evSub.median_rent_3bed),
      medianRent4Bed: v(evSub.median_rent_4bed),
      vacancyPct: v(evSub.vacancy_pct),
      growth5yrPct: v(evSub.growth_5yr_pct),
      populationGrowthPct: v(evSub.population_growth_pct),
      approvalsRatio: v(evSub.approvals_ratio),
      medianDaysOnMarket: v(evSub.median_days_on_market),
    };
  }

  function dcPill(status) {
    return status === 'strong' ? 'STRONG' : status === 'ok' ? 'OK'
      : status === 'watch' ? 'WATCH' : 'NO DATA';
  }

  function dcChipHtml(m) {
    const dp = m.dp != null ? m.dp : 1;
    const fmt = (v) => (v == null || !Number.isFinite(Number(v)) ? null
      : dp ? Number(v).toFixed(dp) : Math.round(Number(v)).toLocaleString());
    const bits = [];
    if (m.percentile != null) bits.push(m.percentile + 'th pct');
    const bm = fmt(m.benchmark);
    if (bm != null) bits.push((m.percentile != null ? 'median ' : 'suburb ')
      + bm + (m.unit === '$' ? '' : m.unit));
    const sub = bits.join(' · ') || m.note || '';
    const val = fmt(m.value);
    const shown = val == null ? '—' : (m.unit === '$' ? '$' + val : val + (m.unit || ''));
    return `<div class="dc-chip" title="${escapeHtml(m.note || '')}">
      <span class="dc-chip-label">${escapeHtml(m.label)}</span>
      <span class="dc-chip-val"><strong>${escapeHtml(shown)}</strong>
      ${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></div>`;
  }

  function dcCardHtml(v) {
    return `<div class="dc-card dc-${v.status}">
      <div class="dc-card-head">
        <span class="dc-pill">${dcPill(v.status)}</span>
        <span class="dc-card-score">${v.score != null ? v.score + '/100' : ''}</span>
      </div>
      <div class="dc-card-q">${escapeHtml(v.question)}</div>
      <div class="dc-card-headline">${escapeHtml(v.headline)}</div>
      ${(v.metrics || []).map(dcChipHtml).join('')}
    </div>`;
  }

  async function renderDealCheckPortal(ev) {
    const sec = $('#p-dealcheck-sec'), host = $('#p-dealcheck');
    if (!sec || !host) return;
    const inputs = state.inputs || {};
    const meta = ((inputs.properties || [])[0] || {}).addressMeta || {};
    const suburb = portalSuburb(ev && ev.suburb);
    const comps = ((ev || {}).comps || []).map((c) => ({
      soldPrice: c.sold_price, beds: c.beds }));
    const rentals = ((ev || {}).rentals || []).map((r) => ({
      rentWeekly: r.rent_weekly, bedrooms: r.bedrooms }));
    const st = inputs.state;
    const lat = Number(meta.lat), lon = Number(meta.lon);
    const [census, growth] = await Promise.all([
      Number.isFinite(lat) && Number.isFinite(lon)
        ? api(`/api/markets/census/point?lat=${lat}&lon=${lon}`).catch(() => null)
        : Promise.resolve(null),
      st ? api(`/api/markets/prices?state=${encodeURIComponent(st)}`)
           .then((d) => window.PropertyAnalyserEngine.stateGrowth5yr(d, st)).catch(() => null)
         : Promise.resolve(null),
    ]);
    const bundle = window.PropertyAnalyserEngine.dealCheckBundle({
      census, inputs,
      metrics: ((state.result || {}).properties || [])[0]
        ? state.result.properties[0].metrics : null,
      suburb,
      evidence: { comps, rentals, suburb,
                  stateGrowth5yr: growth && growth.pct,
                  stateGrowthLabel: growth && growth.label },
    });
    const drivers = (bundle.overall || {}).drivers || {};
    const driverBits = [
      (drivers.for || []).length ? `For: ${escapeHtml(drivers.for.join(' · '))}` : '',
      (drivers.against || []).length ? `Against: ${escapeHtml(drivers.against.join(' · '))}` : '',
    ].filter(Boolean);
    host.innerHTML = `
      <div class="dc-banner dc-${(bundle.overall || {}).status || 'nodata'}">
        <div class="dc-banner-word">${escapeHtml((bundle.overall || {}).verdictWord || '—')}</div>
        <div class="dc-banner-copy">
          <div><strong>${escapeHtml((bundle.sa2 || {}).name || 'Area not located')}</strong> — ${escapeHtml((bundle.overall || {}).headline || '')}</div>
          ${driverBits.map((b) => `<div class="dc-drivers">${b}</div>`).join('')}
        </div>
        <div class="dc-banner-score">${bundle.overall.score != null ? bundle.overall.score : '—'}<small>/100</small></div>
      </div>
      ${[['area', 'The area — census fundamentals'], ['deal', 'The deal — your numbers'],
         ['market', 'The market — local evidence']].map(([g, label]) => {
        const list = (bundle.verdicts || []).filter((v) => v.group === g);
        if (!list.length) return '';
        return `<div class="chip-row-label">${escapeHtml(label)}</div>
          <div class="dc-grid">${list.map(dcCardHtml).join('')}</div>`;
      }).join('')}
      <div class="source-note">Scored automatically from ABS census data, the numbers in this proposal and the agent's local evidence. Percentiles compare the area with all of Australia. An indication only — not financial advice.</div>`;
    sec.classList.remove('hidden');
  }

  // ------------------------------------------------------------------
  // Entry modes
  // ------------------------------------------------------------------

  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const c = (s) => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, '0');
    return '#' + c(16) + c(8) + c(0);
  }

  // BA branding: header name + tagline, logo, accent colour as the
  // portal's primary (and a darker variant for gradients).
  function applyBranding(b) {
    b = b || {};
    if (b.businessName) $('#portal-ba').textContent = b.businessName;
    if (b.tagline) {
      const el = $('#portal-tagline');
      el.textContent = b.tagline;
      el.classList.remove('hidden');
    }
    if (b.logoUrl) {
      $('#portal-logo').innerHTML =
        `<img src="${escapeHtml(b.logoUrl)}" alt="${escapeHtml(b.businessName || 'logo')}">`;
      const link = document.querySelector('link[rel="icon"]');
      if (link) link.href = b.logoUrl; // the BA's mark on the browser tab too
    }
    if (b.accentColor && /^#[0-9a-fA-F]{6}$/.test(b.accentColor)) {
      document.documentElement.style.setProperty('--pri', b.accentColor);
      document.documentElement.style.setProperty('--pri-2', shade(b.accentColor, 0.78));
    }
  }

  function setHeader(me, baName, branding) {
    $('#portal-ba').textContent = (branding && branding.businessName)
      || baName || 'Property Analyser';
    $('#portal-client').textContent = me ? 'Prepared for ' + me.displayName : '';
    $('#portal-logout').classList.toggle('hidden', !state.jwt);
    if (branding) applyBranding(branding);
  }

  async function deepLink(token) {
    try {
      const d = await api('/api/portal/resolve/' + encodeURIComponent(token));
      state.jwt = d.token;
      localStorage.setItem(TOKEN_KEY, d.token);
      if (d.portfolio) {
        setHeader(d.me, d.portfolio.baName, d.portfolio.branding);
        openPortfolio(d.portfolio);
      } else {
        setHeader(d.me, d.presentation.baName, d.presentation.branding);
        openPresentation(d.presentation);
      }
    } catch (e) {
      $('#portal-closed-msg').textContent = e.status === 429
        ? 'Too many attempts — wait a few minutes and try again.'
        : $('#portal-closed-msg').textContent;
      show('#portal-closed');
    }
  }

  async function home() {
    if (!state.jwt) return otpFlow();
    try {
      const [list, me] = await Promise.all([
        api('/api/portal/presentations'), api('/api/auth/me')]);
      setHeader(me, null);
      if (!list.length) {
        $('#otp-form').classList.remove('hidden');
        $('#portal-list').innerHTML = '<div class="hint">Nothing shared with you yet — use the link your agent sent.</div>';
        return;
      }
      $('#portal-list').innerHTML = list.map((p) => `
        <div class="portal-item" data-pid="${p.id}">
          <div><div class="portal-item-title">${escapeHtml(p.title)}</div>
            <div class="hint">from ${escapeHtml(p.baName)} · updated ${p.updatedAt.slice(0, 10)}</div></div>
          <div>Open →</div>
        </div>`).join('');
      $('#portal-list').querySelectorAll('[data-pid]').forEach((el) =>
        el.addEventListener('click', async () => {
          const d = await api('/api/portal/presentation/' + el.dataset.pid);
          setHeader(me, d.baName, d.branding);
          openPresentation(d);
        }));
    } catch (e) {
      localStorage.removeItem(TOKEN_KEY);
      state.jwt = null;
      otpFlow();
    }
  }

  function otpFlow() {
    show('#portal-home');
    $('#otp-form').classList.remove('hidden');
    let sentEmail = '';
    $('#otp-send').addEventListener('click', async () => {
      const email = $('#otp-email').value.trim();
      if (!sentEmail) {
        try {
          await api('/api/otp/request', { method: 'POST', body: { email } });
          sentEmail = email;
          $('#otp-code-row').classList.remove('hidden');
          $('#otp-send').textContent = 'Verify code';
          msg('#otp-msg', 'Code sent — check your email (and spam folder)');
        } catch (e) { msg('#otp-msg', e.message); }
      } else {
        try {
          const d = await api('/api/otp/verify', {
            method: 'POST', body: { email: sentEmail, code: $('#otp-code').value.trim() }});
          state.jwt = d.token;
          localStorage.setItem(TOKEN_KEY, d.token);
          home();
        } catch (e) { msg('#otp-msg', e.message); }
      }
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  bindActions();
  const m = location.pathname.match(/^\/p\/([^/]+)$/);
  if (m) deepLink(decodeURIComponent(m[1]));
  else home();
})();
