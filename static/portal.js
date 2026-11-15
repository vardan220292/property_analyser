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
    ['#portal-home', '#portal-view', '#portal-closed'].forEach((s) =>
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
    $('#p-property-sub').textContent = 'Loading live Queensland data for ' + p.address + '…';
    api('/api/intel/property?lat=' + lat + '&lon=' + lon)
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
    const p = d.parcel || {};
    const lu = d.landUse || {};
    const rp = d.regionalPlan || {};
    const aoi = d.areasOfInterest || {};
    const flood = d.flood || {};
    const studies = flood.studies || [];
    const living = aoi.priorityLiving || [];

    const address = (activeProp() || {}).address || '';
    $('#p-property-sub').textContent = address
      ? address + ' — live Queensland Government open data'
      : 'Live Queensland Government open data';

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

  function openPresentation(d) {
    state.pid = d.id;
    state.original = JSON.parse(JSON.stringify(d.snapshot));
    state.inputs = JSON.parse(JSON.stringify(d.snapshot));
    $('#p-title').textContent = d.title || 'Property proposal';
    $('#p-adjusted').classList.toggle('hidden', !d.usingMyAdjustments);
    state.targetProp = 0;
    renderSliders();
    recalc();
    loadPropertyIntel();
    $('#p-print').classList.remove('hidden');
    show('#portal-view');
    refreshComments().catch(() => {});
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  function bindActions() {
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
    $('#p-print').addEventListener('click', async () => {
      try {
        const resp = await fetch(`/api/portal/presentation/${state.pid}/pdf`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + state.jwt,
          },
          body: JSON.stringify(buildPdfPayload()),
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
      } catch (e) {
        window.print(); // offline / network error — browser print still works
      }
    });
  }

  async function decide(action, doneMsg) {
    const body = ($('#p-comment').value || '').trim();
    try {
      await api(`/api/portal/presentation/${state.pid}/${action}`, { method: 'POST', body: { body } });
      $('#p-comment').value = '';
      msg('#p-decision-msg', doneMsg + ' — recorded');
      refreshComments().catch(() => {});
    } catch (e) { msg('#p-decision-msg', e.message); }
  }

  function msg(sel, text) {
    const el = $(sel);
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
  }

  // Figures for the server-side PDF — mirrors the cards + cash-flow table.
  function buildPdfPayload() {
    const r = state.result;
    const m = r.metrics;
    const row = r.rows[0];
    const line = (label, v) => [label, fmtMoney(v), fmtMoney(v / 12), fmtMoney(v / 26), fmtMoney(v / 52)];
    const facts = intelFacts();
    return {
      client: ($('#portal-client').textContent || '').replace('Prepared for ', ''),
      title: $('#p-title').textContent,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--pri').trim() || '#6366f1',
      cards: [
        { label: 'Purchase price', value: fmtMoney(m.purchasePrice), sub: 'cash in ' + fmtMoney(m.initialCashInvested) },
        { label: 'Portfolio rent', value: fmtMoney(state.inputs.properties.reduce((s, p) => s + (p.weeklyRent || 0), 0)) + '/wk', sub: 'gross yield ' + fmtPct(m.grossYield, 2) },
        { label: 'Weekly out-of-pocket', value: fmtMoney(Math.max(0, m.weeklyOutOfPocket)), sub: 'after tax, year 1' },
        { label: 'Year-1 tax refund', value: fmtMoney(Math.max(0, m.year1TaxRefund)), sub: 'negative gearing + depreciation' },
        { label: '10-year equity', value: fmtMoney(m.tenYearEquity), sub: 'value less all debt' },
        { label: 'Exit proceeds', value: fmtMoney(m.netSaleProceeds), sub: 'year ' + m.saleYear + ' sale, after CGT' },
      ],
      cashflow: [
        line('Gross rent', row.grossRent),
        line('Operating expenses', -row.operatingExpenses),
        line('Loan interest', -(row.ipInterest + row.equityLoanInterest)),
        line('Pre-tax cash flow', row.preTaxCashFlow),
        line('Tax refund / (cost)', row.taxRefundOrCost),
        line('After-tax cash flow', row.afterTaxCashFlow),
      ],
      propertyFacts: facts,
    };
  }

  // Parcel facts for the PDF (live QLD open data, when it loaded).
  function intelFacts() {
    const d = intelView.data;
    const prop = activeProp() || {};
    const facts = [];
    if (prop.address) facts.push({ label: 'Address', value: prop.address });
    if (!d) return facts;
    const p = d.parcel || {};
    const lu = d.landUse || {};
    const rp = d.regionalPlan || {};
    const studies = (d.flood && d.flood.studies) || [];
    const living = (d.areasOfInterest && d.areasOfInterest.priorityLiving) || [];
    const add = (label, value) => { if (value) facts.push({ label, value: String(value) }); };
    add('Lot on plan', p.lotPlan);
    add('Land area', p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : '');
    add('Tenure', p.tenure);
    add('Location', [p.locality, p.lga].filter(Boolean).join(' · '));
    add('Land use', lu.tertiary || lu.secondary || lu.primary);
    add('Regional plan', rp.name ? rp.name + (rp.version ? ' (' + rp.version + ')' : '') : '');
    add('Priority living area', living.join(', '));
    add('Flood study', studies.map((s) => s.name).join(' · '));
    return facts;
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
      setHeader(d.me, d.presentation.baName, d.presentation.branding);
      openPresentation(d.presentation);
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
