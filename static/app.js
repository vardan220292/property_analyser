/* Copyright (c) 2026 RV
 *
 * Property Analyser — frontend wiring.
 *
 * Plain JS, no framework. All calculation happens in engine.js via
 * calculateAll(); this file only moves values between the DOM and the
 * engine and renders results (cards, tables, Chart.js charts).
 *
 * Draft state persists to localStorage on every edit; explicit Save
 * writes the scenario to the server (SQLite).
 */

(function () {
  'use strict';

  const E = window.PropertyAnalyserEngine;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  const TOKEN_KEY = 'pa_token';
  const LEGACY_DRAFT_KEY = 'pa_draft_v1'; // pre-login drafts

  const state = {
    inputs: null,        // engine-normalized v3 shape: globals + properties[]
    scenarioId: null,    // null = unsaved draft
    result: null,        // calculateAll() output
    cfYear: 1,           // year selected in the Cash Flow section
    inputTab: 0,         // active Inputs tab: 'portfolio' | 'ppor' | IP index
    viewProp: -1,        // result views: -1 = portfolio, else property index
    compareIds: [],      // scenario ids ticked for comparison
    compareData: [],     // [{name, result}] for the compare view
    currentUser: null,   // {id, email, displayName} once signed in
    suburbs: [],         // reference data rows from /api/suburbs
    bankRates: [],       // investor rate rows from /api/bank-rates
    comps: [],           // comparable sales for the current scenario
    compCandidates: [],  // AI search results pending review (never persisted)
  };

  // Drafts are per user so two people on one browser don't clobber
  // each other's in-progress edits.
  const draftKey = () =>
    state.currentUser ? `pa_draft_v1_u${state.currentUser.id}` : LEGACY_DRAFT_KEY;

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function saveDraft() {
    localStorage.setItem(draftKey(), JSON.stringify({
      v: 3,
      savedAt: Date.now(),
      scenarioId: state.scenarioId,
      inputs: state.inputs,
    }));
  }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const fmtMoney = (v, dp = 0) => new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(v);
  const fmtNum = (v, dp = 0) => new Intl.NumberFormat('en-AU', {
    maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(v);
  const fmtPct = (v, dp = 2) => (v * 100).toFixed(dp) + '%';
  const signed = (v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v));

  // ------------------------------------------------------------------
  // Form <-> state binding
  // ------------------------------------------------------------------

  // Per-property fields live on the ACTIVE Inputs tab; globals apply to
  // the whole portfolio regardless of tab.
  function scopeGet(key) {
    if (E.PROPERTY_KEYS.has(key) && Number.isInteger(state.inputTab)) {
      return state.inputs.properties[state.inputTab][key];
    }
    return state.inputs[key];
  }

  function scopeSet(key, v) {
    if (E.PROPERTY_KEYS.has(key) && Number.isInteger(state.inputTab)) {
      state.inputs.properties[state.inputTab][key] = v;
    } else {
      state.inputs[key] = v;
    }
  }

  function readField(el) {
    const key = el.dataset.field;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.tagName === 'SELECT') v = el.value;
    else if (el.dataset.pct !== undefined) v = (parseFloat(el.value) || 0) / 100;
    else if (el.type === 'text') {
      // A masked number is a text box underneath — it still has to read
      // back as a number.
      v = el.hasAttribute('data-numeric') ? (parseFloat(el.value) || 0) : el.value.trim();
    } else v = parseFloat(el.value) || 0;
    scopeSet(key, v);
  }

  function writeField(el) {
    const key = el.dataset.field;
    const v = scopeGet(key);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.dataset.pct !== undefined) el.value = (v * 100).toFixed(2).replace(/\.?0+$/, '');
    else el.value = v === null || v === undefined ? '' : v;
  }

  let recalcTimer = null;
  function scheduleRecalc() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(() => {
      recalc();
      saveDraft();
    }, 150);
  }

  // "P&I from day one" makes the interest-only period input irrelevant.
  function syncIoField() {
    const repaySel = $('[data-field="ipRepaymentType"]');
    const ioField = $('[data-field="ipInterestOnlyYears"]');
    if (repaySel && ioField) ioField.disabled = repaySel.value === 'principal_and_interest';
  }

  function bindInputs() {
    $$('[data-field]').forEach((el) => {
      el.addEventListener('input', () => {
        readField(el);
        scheduleRecalc();
        // A property's name shows on the tab strip at the top of the pane
        // and in the pane title — keep both in step with the field.
        if (el.dataset.field === 'label') refreshIpLabels();
      });
    });
    const repaySel = $('[data-field="ipRepaymentType"]');
    if (repaySel) repaySel.addEventListener('change', syncIoField);
  }

  // Taxable-income inputs are masked by default; the eye button toggles.
  // The mask is CSS, not type="password": a password field on the page
  // makes Chrome treat the nearest text box (the address field) as a
  // username and offer to save the address as a password.
  function bindMaskToggles() {
    $$('.masked-wrap').forEach((wrap) => {
      const input = wrap.querySelector('input');
      const btn = wrap.querySelector('.mask-toggle');
      if (!input || !btn) return;
      const mask = () => {
        input.type = 'text';
        input.classList.add('is-masked');
      };
      const reveal = () => {
        input.type = 'number';
        input.classList.remove('is-masked');
      };
      mask();
      btn.addEventListener('click', () => {
        const val = input.value;
        const on = input.classList.contains('is-masked');
        if (on) reveal();
        else mask();
        input.value = val; // changing the type can drop the value
        wrap.classList.toggle('revealed', on);
      });
    });
  }

  function syncForm() {
    $$('[data-field]').forEach(writeField);
    const sel = $('#suburb-select');
    if (sel) sel.value = String(Number(state.inputs.suburbId) || 0);
    syncIoField();
  }

  // ------------------------------------------------------------------
  // Address autocomplete + location (Domain / Esri / Photon, proxied by
  // the backend). Two pickers: the investment property and the PPOR.
  // ------------------------------------------------------------------

  let suggestTimer = null;
  let suggestSeq = 0;
  let locateSeq = 0;

  function matchSuburb(name, postcode) {
    const n = String(name || '').trim().toLowerCase();
    const p = String(postcode || '').trim();
    return state.suburbs.find((s) =>
      s.name.trim().toLowerCase() === n && String(s.postcode).trim() === p) || null;
  }

  function hideSuggest(dd) {
    if (!dd) return;
    dd.classList.add('hidden');
    dd.innerHTML = '';
  }

  function showSuggest(dd, html) {
    if (!dd) return;
    dd.innerHTML = html;
    dd.classList.remove('hidden');
  }

  function renderSuggest(dd, items) {
    if (!items.length) {
      showSuggest(dd, '<div class="addr-hint">No address matches — check the spelling, or type the street and number and we will locate it for you.</div>');
      return;
    }
    showSuggest(dd, items.map((it, i) =>
      `<div class="addr-item" data-addr-pick="${i}">
         <div>${escapeHtml(it.address)}</div>
         <div class="sub">${escapeHtml(it.suburb)} ${escapeHtml(it.postcode)} ${escapeHtml(it.state)}${it.provider === 'photon' ? ' · approx.' : ''}</div>
       </div>`).join(''));
  }

  function metaFrom(item) {
    return {
      domainId: item.domainId, unitNumber: item.unitNumber,
      streetNumber: item.streetNumber, streetName: item.streetName,
      streetType: item.streetType, suburb: item.suburb,
      postcode: item.postcode, state: item.state,
      lat: item.lat, lon: item.lon,
    };
  }

  // One picker per address field: dropdown, debounce, pick and locate.
  function wireAddressPicker(opts) {
    const input = $(opts.inputSel);
    const dd = $(opts.dropdownSel);
    if (!input || !dd) return;
    const picker = { input, dd, items: [], onPick: opts.onPick, scope: opts.scope || 'property' };

    input.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      hideSuggest(dd);
      if (opts.onPick.manual) opts.onPick.manual(); // stale meta after manual edits
      const q = input.value.trim();
      if (q.length < 3) return;
      suggestTimer = setTimeout(() => fetchSuggest(picker, q), 300);
    });
    input.addEventListener('focusout', () => setTimeout(() => hideSuggest(dd), 120));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') hideSuggest(dd);
    });
    input.addEventListener('blur', () => settleAddress(picker));
    dd.addEventListener('mousedown', (ev) => {
      const row = ev.target.closest('[data-addr-pick]');
      if (!row) return;
      ev.preventDefault(); // keep focus so the focusout hide can't race the pick
      const item = picker.items[Number(row.dataset.addrPick)];
      if (item) opts.onPick.chosen(item);
    });
  }

  // Hints that keep the geocoder in the right place.
  //
  // The map bias must never leak between addresses: biasing one lookup with
  // another address's coordinates dragged "8 atkinson close" to Atkinson
  // Street in Mackay. Each field only ever biases on its OWN coordinates,
  // and only when the text still looks like the address they came from.
  //
  // The scenario state and suburb belong to the investment property, so the
  // PPOR never inherits them — it is a different property, quite possibly in
  // a different state. It only uses hints from its own saved match.
  function sameStreetAs(meta, q) {
    const words = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const known = [meta.streetName, meta.streetFull, meta.suburb]
      .filter(Boolean).join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!known.length || !words.length) return false;
    return words.some((w) => w.length > 3 && known.includes(w));
  }

  function biasParams(meta, q) {
    const lat = numOrNull(meta.lat);
    const lon = numOrNull(meta.lon);
    if (lat === null || lon === null) return '';
    if (!sameStreetAs(meta, q)) return '';
    return '&lat=' + lat + '&lon=' + lon;
  }

  function addressHints(scope, q) {
    const parts = [];
    if (scope === 'ppor') {
      const meta = state.inputs.pporAddressMeta || {};
      if (meta.suburb) parts.push('&suburb=' + encodeURIComponent(meta.suburb));
      parts.push(biasParams(meta, q));
      return parts.join('');
    }
    const st = (state.inputs && state.inputs.state) || '';
    if (st) parts.push('&state=' + encodeURIComponent(st));
    const meta = scopeGet('addressMeta') || {};
    const sub = meta.suburb || (currentSuburb() || {}).name;
    if (sub) parts.push('&suburb=' + encodeURIComponent(sub));
    parts.push(biasParams(meta, q));
    return parts.join('');
  }

  async function fetchSuggest(picker, q) {
    const seq = ++suggestSeq;
    try {
      const items = await api('/api/address/suggest?q=' + encodeURIComponent(q) + addressHints(picker.scope, q));
      if (seq !== suggestSeq) return; // a newer keystroke already won
      picker.items = items || [];
      renderSuggest(picker.dd, picker.items);
    } catch (err) {
      if (seq !== suggestSeq) return;
      showSuggest(picker.dd, '<div class="addr-hint">' + escapeHtml(err.message) + '</div>');
    }
  }

  // A typed address still deserves map coordinates — resolve it on blur.
  async function settleAddress(picker) {
    const q = picker.input.value.trim();
    if (q.length < 6) return;
    const seq = ++locateSeq;
    try {
      const item = await api('/api/address/locate?q=' + encodeURIComponent(q) + addressHints(picker.scope, q));
      if (seq !== locateSeq) return;
      if (!item) return;
      picker.onPick.located(item);
    } catch (err) {
      /* a partial address is not worth complaining about */
    }
  }

  function setMatched(sel, item) {
    const el = $(sel);
    if (!el) return;
    el.textContent = item ? 'Matched: ' + item.address : '';
    el.classList.toggle('hidden', !item);
  }

  // A suggestion can be street-level when the typed address had no suburb.
  // Once one is picked the label carries the suburb, so the house point can
  // be looked up properly.
  async function refineAddress(scope, text, apply) {
    if (!text || text.length < 6) return;
    try {
      const item = await api('/api/address/locate?q=' + encodeURIComponent(text)
        + addressHints(scope, text));
      if (item && item.streetNumber) apply(item);
    } catch (err) { /* keep what we have */ }
  }

  // Saved coordinates go stale: they were picked from a weaker geocoder,
  // or only ever had the street, not the house. The address text is the
  // source of truth, so re-locate anything that isn't house-accurate.
  async function refreshPropertyLocations() {
    const props = (state.inputs && state.inputs.properties) || [];
    let changed = false;
    for (const p of props) {
      const addr = String(p.address || '').trim();
      if (!addr) continue;
      const meta = p.addressMeta || {};
      const lat = numOrNull(meta.lat);
      const lon = numOrNull(meta.lon);
      if (lat !== null && lon !== null && meta.streetNumber) continue;
      try {
        const item = await api('/api/address/locate?q=' + encodeURIComponent(addr) + addressHints('property', addr));
        if (!item) continue;
        p.addressMeta = metaFrom(item);
        changed = true;
      } catch (err) { /* keep whatever we had */ }
    }
    const pporAddr = String((state.inputs && state.inputs.pporAddress) || '').trim();
    if (pporAddr) {
      const meta = state.inputs.pporAddressMeta || {};
      if (!(numOrNull(meta.lat) !== null && meta.streetNumber)) {
        try {
          const item = await api('/api/address/locate?q=' + encodeURIComponent(pporAddr) + addressHints('ppor', pporAddr));
          if (item) {
            state.inputs.pporAddressMeta = metaFrom(item);
            changed = true;
          }
        } catch (err) { /* keep whatever we had */ }
      }
    }
    if (changed) {
      scheduleRecalc();
      if (propertySectionVisible()) renderProperty();
    }
  }

  function pickPropertyAddress(item) {
    $('#address-input').value = item.address; // programmatic — fires no input event
    scopeSet('address', item.address);
    scopeSet('addressMeta', metaFrom(item));
    setMatched('#address-matched', item);
    const m = matchSuburb(item.suburb, item.postcode);
    if (m) {
      state.inputs.suburbId = m.id; // suburb stays portfolio-level (drives the area report)
      $('#suburb-select').value = String(m.id);
      toast(`Suburb set to ${m.name} — applies to the whole portfolio`);
    } else if (item.suburb) {
      toast(`${item.suburb} ${item.postcode} is not in your suburb data — add it under Area Report`);
    }
    scheduleRecalc(); // re-renders the Area Report and saves the draft
    if (propertySectionVisible()) renderProperty();
    if (!item.streetNumber) {
      refineAddress('property', $('#address-input').value, (refined) => {
        scopeSet('addressMeta', metaFrom(refined));
        setMatched('#address-matched', refined);
        scheduleRecalc();
        if (propertySectionVisible()) renderProperty();
      });
    }
  }

  function pickPporAddress(item) {
    $('#ppor-address-input').value = item.address;
    scopeSet('pporAddress', item.address);
    scopeSet('pporAddressMeta', metaFrom(item));
    setMatched('#ppor-address-matched', item);
    scheduleRecalc();
    if (!item.streetNumber) {
      refineAddress('ppor', $('#ppor-address-input').value, (refined) => {
        scopeSet('pporAddressMeta', metaFrom(refined));
        setMatched('#ppor-address-matched', refined);
        scheduleRecalc();
      });
    }
  }

  wireAddressPicker({
    inputSel: '#address-input',
    dropdownSel: '#addr-dropdown',
    onPick: {
      manual: () => {
        scopeSet('addressMeta', null); // stale after manual edits; re-set on pick
        setMatched('#address-matched', null);
      },
      chosen: (item) => {
        hideSuggest($('#addr-dropdown'));
        pickPropertyAddress(item);
      },
      located: (item) => {
        scopeSet('addressMeta', metaFrom(item));
        setMatched('#address-matched', item);
        scheduleRecalc(); // the resolved point has to be saved
        if (propertySectionVisible()) renderProperty();
      },
    },
  });

  wireAddressPicker({
    inputSel: '#ppor-address-input',
    dropdownSel: '#ppor-addr-dropdown',
    scope: 'ppor',
    onPick: {
      manual: () => {
        scopeSet('pporAddressMeta', null);
        setMatched('#ppor-address-matched', null);
      },
      chosen: (item) => {
        hideSuggest($('#ppor-addr-dropdown'));
        pickPporAddress(item);
      },
      located: (item) => {
        scopeSet('pporAddressMeta', metaFrom(item));
        setMatched('#ppor-address-matched', item);
        scheduleRecalc(); // the resolved point has to be saved
      },
    },
  });

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------

  const TITLES = {
    overview: 'Dashboard', inputs: 'Inputs', property: 'Property', area: 'Area',
    cashflow: 'Cash Flow',
    projections: 'Projections', exit: 'Exit', borrowing: 'Borrowing',
    actuals: 'Actuals', scenarios: 'Scenarios', workspace: 'Workspace',
  };

  // Responsive collapsible application navigation.
  function setupAppShell() {
    const navbar = $('.navbar'), nav = $('#nav');
    if (!navbar || !nav || $('#app-sidebar')) return;
    const sidebar = document.createElement('aside');
    sidebar.id = 'app-sidebar';
    sidebar.className = 'app-sidebar';
    sidebar.setAttribute('aria-label', 'Application navigation');
    sidebar.innerHTML = '<div class="sidebar-heading"><span class="sidebar-heading-label">WORKSPACE</span><span class="sidebar-heading-rule"></span></div><div class="sidebar-nav"></div><div class="sidebar-footer"><span class="sidebar-footer-mark">PA</span><span class="sidebar-footer-copy"><strong>Property Analyser</strong><small>Investment workspace</small></span></div>';
    sidebar.querySelector('.sidebar-nav').appendChild(nav);
    navbar.insertAdjacentElement('afterend', sidebar);
    const backdrop = document.createElement('button');
    backdrop.type = 'button'; backdrop.id = 'sidebar-backdrop'; backdrop.className = 'sidebar-backdrop';
    backdrop.setAttribute('aria-label', 'Close navigation');
    sidebar.insertAdjacentElement('afterend', backdrop);
    const toggle = $('#sidebar-toggle'), prefKey = 'pa_sidebar_collapsed';
    const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
    let collapsed = false;
    try { collapsed = localStorage.getItem(prefKey) === '1'; } catch (e) {}
    const apply = () => {
      document.body.classList.toggle('sidebar-collapsed', collapsed && !isMobile());
      document.body.classList.toggle('sidebar-open', isMobile() && !collapsed);
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
        toggle.title = collapsed ? 'Expand navigation' : 'Collapse navigation';
      }
    };
    const closeMobile = () => {
      if (!isMobile()) return;
      collapsed = true; document.body.classList.remove('sidebar-open'); apply();
    };
    if (toggle) toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      try { localStorage.setItem(prefKey, collapsed ? '1' : '0'); } catch (e) {}
      apply();
    });
    backdrop.addEventListener('click', closeMobile);
    nav.addEventListener('click', ev => { if (ev.target.closest('a[data-target]')) closeMobile(); });
    window.addEventListener('resize', apply);
    if (isMobile()) collapsed = true;
    apply();
  }

  $('#nav').addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-target]');
    if (!a) return;
    Array.from(document.querySelectorAll('#nav a')).forEach((x) => x.classList.toggle('active', x === a));
    const navGroup = a.closest('details.nav-group');
    if (navGroup) navGroup.open = false;
    $$('.section-page').forEach((s) =>
      s.classList.toggle('active', s.id === 'section-' + a.dataset.target));
    document.body.classList.toggle('on-dashboard', a.dataset.target === 'overview');
    $('#page-title').textContent = TITLES[a.dataset.target];
    if (a.dataset.target === 'workspace') refreshWorkspace();
    if (a.dataset.target === 'actuals') renderActuals();
    if (a.dataset.target === 'property') renderProperty();
    if (a.dataset.target === 'overview') loadDashboard();
    // Start each workflow at its page heading instead of retaining the
    // previous section's scroll position.
    window.scrollTo(0, 0);
  });

  // ------------------------------------------------------------------
  // Announcement strip + first-run tour

  function renderAnalyticsInsight(id, items, note) {
    const host = $('#' + id);
    if (!host) return;
    host.innerHTML = '<div class="analytics-insight-head"><div><span class="page-eyebrow">KEY TAKEAWAYS</span><strong>What this means</strong></div><span>' + escapeHtml(note || 'Based on current assumptions') + '</span></div><div class="analytics-insight-grid">' +
      items.map(x => '<div class="analytics-takeaway ' + (x.tone || '') + '"><small>' + escapeHtml(x.label) + '</small><strong>' + escapeHtml(x.value) + '</strong><span>' + escapeHtml(x.detail || '') + '</span></div>').join('') + '</div>';
  }

  const QUICK_PAGES = [
    ['overview','Dashboard','Portfolio overview'],['inputs','Investment inputs','Edit assumptions'],
    ['property','Property intelligence','Map and property data'],['area','Area & suburb','Market research'],
    ['cashflow','Cash flow','Income and expenses'],['projections','Projections','Long-term outlook'],
    ['exit','Exit & CGT','Sale and capital gains'],['borrowing','Borrowing capacity','Serviceability'],
    ['scenarios','Scenarios','Compare saved cases'],['actuals','Actuals','Actual performance'],['workspace','Client workspace','Buyer agent tools']
  ];

  function wireCommandPalette() {
    const overlay=$('#command-palette'), input=$('#command-search-input'), results=$('#command-results');
    if(!overlay||!input||!results)return;
    let entries=[], active=0;
    const close=()=>{overlay.classList.add('hidden');input.value='';};
    const open=()=>{build('');overlay.classList.remove('hidden');input.focus();};
    const trigger=$('#command-open');if(trigger)trigger.addEventListener('click',open);
    function build(query) {
      const q=String(query||'').trim().toLowerCase();
      entries=[];
      QUICK_PAGES.forEach(p=>{if((p[1]+' '+p[2]).toLowerCase().includes(q))entries.push({type:'page',title:p[1],detail:p[2],target:p[0]});});
      (state.scenarioList||[]).forEach(s=>{if((s.name||'').toLowerCase().includes(q))entries.push({type:'scenario',title:s.name,detail:'Saved scenario',id:s.id});});
      (dash.items||[]).forEach(p=>{if((p.address+' '+p.suburb+' '+p.scenarioName).toLowerCase().includes(q))entries.push({type:'property',title:p.address,detail:[p.suburb,p.scenarioName].filter(Boolean).join(' · '),id:p.scenarioId,index:p.index});});
      if(!q) entries=entries.slice(0,12);
      active=0;
      results.innerHTML=entries.length?entries.slice(0,18).map((e,i)=>'<button type="button" class="command-result '+(i===0?'active':'')+'" data-command-index="'+i+'"><span class="command-result-icon">'+(e.type==='page'?'↗':e.type==='scenario'?'▤':'⌂')+'</span><span><strong>'+escapeHtml(e.title)+'</strong><small>'+escapeHtml(e.detail)+'</small></span><kbd>'+(e.type==='page'?'PAGE':e.type==='scenario'?'SCENARIO':'PROPERTY')+'</kbd></button>').join(''):'<div class="command-empty">No matching pages, properties or scenarios.</div>';
    }
    function choose(i) {
      const e=entries[i];if(!e)return;
      close();
      if(e.type==='page'){const a=document.querySelector('#nav a[data-target="'+e.target+'"]');if(a)a.click();}
      else if(e.type==='scenario')loadScenario(e.id);
      else loadScenario(e.id).then(()=>{if(Number.isInteger(e.index)){state.inputTab=e.index;setActiveTab(e.index);}const a=document.querySelector('#nav a[data-target="property"]');if(a)a.click();});
    }
    input.addEventListener('input',()=>build(input.value));
    results.addEventListener('click',ev=>{const b=ev.target.closest('[data-command-index]');if(b)choose(Number(b.dataset.commandIndex));});
    input.addEventListener('keydown',ev=>{
      if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();active=(active+(ev.key==='ArrowDown'?1:-1)+Math.min(entries.length,18))%Math.min(entries.length,18);results.querySelectorAll('.command-result').forEach((b,i)=>b.classList.toggle('active',i===active));}
      if(ev.key==='Enter'){ev.preventDefault();choose(active);}
      if(ev.key==='Escape')close();
    });
    overlay.addEventListener('mousedown',ev=>{if(ev.target===overlay)close();});
    document.addEventListener('keydown',ev=>{
      if((ev.metaKey||ev.ctrlKey)&&ev.key.toLowerCase()==='k'){ev.preventDefault();overlay.classList.contains('hidden')?open():close();}
      else if(ev.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!ev.metaKey&&!ev.ctrlKey){ev.preventDefault();open();}
      else if(ev.key==='Escape'&&!overlay.classList.contains('hidden'))close();
    });
  }

  // ------------------------------------------------------------------

  const ANNOUNCE_KEY = 'pa_announce_dismissed';

  function wireAnnouncement() {
    const bar = $('#announce');
    const close = $('#announce-close');
    if (!bar || !close) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(ANNOUNCE_KEY) === '1'; } catch (e) { /* private mode */ }
    if (!dismissed) bar.classList.remove('hidden');
    close.addEventListener('click', () => {
      bar.classList.add('hidden');
      try { localStorage.setItem(ANNOUNCE_KEY, '1'); } catch (e) { /* ignore */ }
    });
  }

  const TOUR_KEY = 'pa_tour_seen';
  const TOUR_STEPS = [
    {
      title: 'Your dashboard',
      body: 'Everything you have analysed in one place — the score, the yield and the weekly cost of holding each property.',
      target: '#dash-stats',
    },
    {
      title: 'Property data',
      body: 'Pick an address in Inputs and the Property tab pulls live Queensland Government data — parcel, planning, flood and bushfire.',
      target: '#nav a[data-target="property"]',
    },
    {
      title: 'Your properties',
      body: 'Every saved property, scored and ready to open. Save a scenario in Inputs and it appears here.',
      target: '#dash-props',
    },
    {
      title: 'Share with clients',
      body: 'Buyers\' agents can turn any scenario into a client link with the same property facts and a PDF.',
      target: '#nav-workspace',
      needsBa: true,
    },
  ];

  function wireTour() {
    document.addEventListener('click', (ev) => {
      if (ev.target.closest('#tour-next')) { tourNext(); return; }
      if (ev.target.closest('#tour-skip') || ev.target.closest('#tour-close')) { endTour(); }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && $('#tour')) endTour();
    });
  }

  function tourSteps() {
    const isBa = state.currentUser && state.currentUser.role === 'ba';
    return TOUR_STEPS.filter((s) => !s.needsBa || isBa);
  }

  function startTour() {
    let seen = false;
    try { seen = localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { /* ignore */ }
    if (seen) return;
    const steps = tourSteps();
    if (!steps.length) return;
    showTourStep(0, steps);
  }

  function showTourStep(i, steps) {
    const step = steps[i];
    const target = step.target ? document.querySelector(step.target) : null;
    const box = $('#tour');
    const tip = $('#tour-tip');
    if (!box || !tip) return;
    box.classList.remove('hidden');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let hole;
    if (target) {
      const r = target.getBoundingClientRect();
      const pad = 8;
      hole = {
        top: Math.max(0, r.top - pad),
        left: Math.max(0, r.left - pad),
        width: Math.max(24, r.width + pad * 2),
        height: Math.max(24, r.height + pad * 2),
      };
    } else {
      hole = { top: vh / 2 - 40, left: vw / 2 - 60, width: 120, height: 80 };
    }
    tip.style.top = hole.top + 'px';
    tip.style.left = hole.left + 'px';
    tip.style.width = hole.width + 'px';
    tip.style.height = hole.height + 'px';
    $('#tour-title').textContent = step.title;
    $('#tour-body').textContent = step.body;
    $('#tour-dots').innerHTML = steps.map((_, k) =>
      `<span class="${k === i ? 'on' : ''}"></span>`).join('');
    $('#tour-next').textContent = i === steps.length - 1 ? 'Done' : 'Next';

    // Park the card just below the spotlight, kept inside the viewport.
    const card = $('#tour-card');
    const cr = card.getBoundingClientRect();
    let left = hole.left;
    let top = hole.top + hole.height + 12;
    if (top + cr.height > vh - 12) top = hole.top - cr.height - 12;
    left = Math.min(Math.max(12, left), Math.max(12, vw - cr.width - 12));
    top = Math.min(Math.max(12, top), Math.max(12, vh - cr.height - 12));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function tourNext() {
    const steps = tourSteps();
    const cur = Number($('#tour') && $('#tour').dataset.step || 0);
    if (cur + 1 >= steps.length) { endTour(); return; }
    const next = cur + 1;
    $('#tour').dataset.step = String(next);
    showTourStep(next, steps);
  }

  function endTour() {
    const box = $('#tour');
    if (box) box.classList.add('hidden');
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Dashboard — the portfolio at a glance
  // ------------------------------------------------------------------

  const dash = { items: [], busy: false, details: new Map() };

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12.5 12 4l9 8.5"/><path d="M6 11v8h12v-8"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5v2a3 3 0 0 0 3 3M16 6h3v2a3 3 0 0 1-3 3M9 20h6M12 13v7"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L20 8l-4-4L4 16v4Z"/></svg>',
  };

  function dashIcon(name) { return ICONS[name] || ''; }

  function statChip(icon, tone) {
    return `<span class="stat-chip ${tone || ''}">${dashIcon(icon)}</span>`;
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 16).replace('T', ' ');
    const diff = Date.now() - d.getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    const days = Math.round(hrs / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function scoreRing(score) {
    if (score === null || score === undefined) {
      return `<div class="score-ring"><svg viewBox="0 0 44 44">
        <circle class="ring-bg" cx="22" cy="22" r="18"></circle></svg>
        <div class="ring-num">&mdash;</div></div>`;
    }
    const pct = Math.max(0, Math.min(100, score));
    const circ = 2 * Math.PI * 18;
    const off = circ * (1 - pct / 100);
    const colour = pct >= 70 ? 'var(--good)' : pct >= 50 ? 'var(--pri)' : 'var(--amber)';
    return `<div class="score-ring">
      <svg viewBox="0 0 44 44">
        <circle class="ring-bg" cx="22" cy="22" r="18"></circle>
        <circle class="ring-fg" cx="22" cy="22" r="18" stroke="${colour}"
          stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
      </svg>
      <div class="ring-num">${Math.round(pct)}</div>
    </div>`;
  }

  async function loadDashboard(force) {
    if (dash.busy) return;
    dash.busy = true;
    try {
      const list = await api('/api/scenarios');
      state.scenarioList = list;
      const wanted = list.slice(0, 12).map((s) => s.id);
      for (const s of list.slice(0, 12)) {
        if (!dash.details.has(s.id)) {
          try {
            dash.details.set(s.id, await api('/api/scenarios/' + s.id));
          } catch (e) { dash.details.set(s.id, null); }
        }
      }
      const items = [];
      list.forEach((s) => {
        const detail = dash.details.get(s.id);
        if (!detail || !detail.inputs) return;
        const suburb = state.suburbs.find((x) => x.id === Number(s.suburbId)) || null;
        let res = null;
        try { res = E.calculateAll(detail.inputs, { suburb }); } catch (e) { return; }
        const rawProps = (detail.inputs && detail.inputs.properties) || [];
        (res.properties || []).forEach((p, i) => {
          const raw = rawProps[i] || {};
          const m = p.metrics || {};
          const price = m.purchasePrice || 0;
          const weekly = m.weeklyOutOfPocket;
          const parts = [];
          if (raw.bedrooms) parts.push(`${raw.bedrooms}-bed`);
          if (price) parts.push(fmtMoney(price));
          if (m.grossYield) parts.push(`${fmtPct(m.grossYield, 2)} gross yield`);
          if (weekly !== null && weekly !== undefined) {
            parts.push(`${fmtMoney(Math.abs(weekly))}/wk ${weekly > 0 ? 'out of pocket' : 'in pocket'}`);
          }
          items.push({
            scenarioId: s.id,
            scenarioName: s.name,
            index: i,
            address: raw.address || s.address || s.name,
            suburb: (raw.addressMeta && raw.addressMeta.suburb) || (suburb ? suburb.name : ''),
            price: price,
            grossYield: m.grossYield,
            weekly: weekly,
            equity: m.tenYearEquity,
            score: p.score ? p.score.score : null,
            band: p.score ? p.score.band : '',
            summary: parts.join(' · '),
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
          });
        });
      });
      dash.items = items;
      renderDashboard(list);
    } catch (e) {
      setPropertyStatus && setPropertyStatus('');
      $('#dash-stats').innerHTML = '';
      $('#dash-activity').innerHTML = `<div class="empty-note">Could not load your portfolio: ${escapeHtml(e.message)}</div>`;
    } finally {
      dash.busy = false;
    }
  }


  function renderPortfolioSnapshot() {
    const root = $('#portfolio-kpis');
    if (!root) return;
    const result = state.result, metrics = result && result.metrics;
    const props = (result && result.properties) || [], inputs = state.inputs || {};
    const money = (v) => Number.isFinite(Number(v)) ? fmtMoney(Number(v)) : '—';
    const weekly = metrics ? Number(metrics.weeklyOutOfPocket || 0) : null;
    const annual = weekly === null ? null : weekly * 52;
    const pporValue = Math.max(0, Number(inputs.pporValue) || 0);
    const pporDebt = Math.max(0, Number(inputs.pporLoanBalance) || 0);
    const totalPropertyAssets = (metrics ? Number(metrics.purchasePrice) || 0 : 0) + pporValue;
    const cards = [
      ['Total property assets', money(totalPropertyAssets), pporValue > 0 ? 'Investment properties + PPOR' : 'Investment property portfolio', 'blue'],
      ['Investment debt', metrics ? money(metrics.ipLoanAmount) : '—', 'Investment-property loan exposure', 'violet'],
      ['Cash required upfront', metrics ? money(metrics.initialCashInvested) : '—', 'Deposit and acquisition costs', 'amber'],
      ['Annual after-tax position', annual === null ? '—' : (annual > 0 ? money(annual) + ' out' : money(Math.abs(annual)) + ' surplus'), 'Year one · weekly position × 52', annual === null ? 'neutral' : annual > 0 ? 'warn' : 'good'],
      ['Gross rental yield', metrics ? fmtPct(metrics.grossYield || 0, 2) : '—', 'Combined scenario yield', 'teal'],
      ['10-year projected equity', metrics ? money(metrics.tenYearEquity) : '—', 'Projected equity at year ten', metrics && metrics.tenYearEquity >= 0 ? 'good' : 'bad']
    ];
    root.innerHTML = cards.map(x => '<div class="portfolio-kpi ' + x[3] + '"><div class="portfolio-kpi-label">' + escapeHtml(x[0]) + '</div><div class="portfolio-kpi-value">' + escapeHtml(x[1]) + '</div><div class="portfolio-kpi-note">' + escapeHtml(x[2]) + '</div></div>').join('');
    const context = $('#portfolio-snapshot-context');
    if (context) context.textContent = inputs.scenarioName || 'Unsaved scenario';
    const hero = $('#dashboard-hero-metrics');
    if (hero) {
      const count = props.length;
      const weeklyLabel = weekly === null ? '—' : (weekly > 0 ? money(weekly) + ' / week' : money(Math.abs(weekly)) + ' surplus / week');
      hero.innerHTML = [
        ['Properties in portfolio', String(count + (pporValue > 0 ? 1 : 0)), pporValue > 0 ? 'Including your PPOR' : 'Investment properties only'],
        ['Total property assets', money(totalPropertyAssets), pporValue > 0 ? 'Includes your home' : 'Before future growth'],
        ['Weekly after-tax position', weeklyLabel, 'Year-one estimate']
      ].map(item => '<div class="dashboard-hero-stat"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong><small>' + escapeHtml(item[2]) + '</small></div>').join('');
    }

    const gallery = $('#dashboard-property-gallery');
    const propertyCount = $('#dashboard-property-count');
    const portfolioHomes = [];
    if (pporValue > 0) {
      portfolioHomes.push({
        kind: 'PPOR · HOME', label: inputs.pporAddress || 'Principal place of residence',
        location: (inputs.pporAddressMeta && [inputs.pporAddressMeta.suburb, inputs.pporAddressMeta.state].filter(Boolean).join(', ')) || 'Your home',
        value: pporValue, debt: pporDebt, equity: pporValue - pporDebt,
        image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=900&q=82',
        note: 'Representative home image'
      });
    }
    props.forEach((p, i) => {
      const raw = inputs.properties && inputs.properties[i] || {}, m = p.metrics || {};
      const photoSet = [
        'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=900&q=82',
        'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=900&q=82',
        'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=900&q=82',
        'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=900&q=82'
      ];
      portfolioHomes.push({
        kind: 'INVESTMENT PROPERTY', label: raw.label || raw.address || ('Investment property ' + (i + 1)),
        location: (raw.addressMeta && [raw.addressMeta.suburb, raw.addressMeta.state].filter(Boolean).join(', ')) || raw.address || 'Location not added',
        value: Number(m.purchasePrice || raw.purchasePrice || 0),
        debt: Number(m.ipLoanAmount || 0), equity: Number(m.tenYearEquity || 0),
        yield: m.grossYield, cash: m.weeklyOutOfPocket,
        image: photoSet[i % photoSet.length], note: 'Representative property image'
      });
    });
    if (propertyCount) propertyCount.textContent = portfolioHomes.length + (portfolioHomes.length === 1 ? ' property' : ' properties');
    if (gallery) gallery.innerHTML = portfolioHomes.length ? portfolioHomes.map((p, i) =>
      '<article class="dashboard-home-card">' +
        '<div class="dashboard-home-photo"><img src="' + p.image + '" alt="Representative exterior of ' + escapeHtml(p.label) + '" loading="lazy"><span class="dashboard-home-kind">' + escapeHtml(p.kind) + '</span></div>' +
        '<div class="dashboard-home-content"><div class="dashboard-home-title">' + escapeHtml(p.label) + '</div><div class="dashboard-home-location">' + escapeHtml(p.location) + '</div>' +
        '<div class="dashboard-home-value">' + money(p.value) + '</div><div class="dashboard-home-stats">' +
        '<span><small>' + (p.kind.startsWith('PPOR') ? 'Mortgage' : 'Loan') + '</small><strong>' + money(p.debt) + '</strong></span>' +
        '<span><small>' + (p.kind.startsWith('PPOR') ? 'Current equity' : 'Projected equity') + '</small><strong>' + money(p.equity) + '</strong></span>' +
        (p.yield != null ? '<span><small>Gross yield</small><strong>' + fmtPct(p.yield, 2) + '</strong></span>' : '') +
        '</div><div class="dashboard-home-note">' + p.note + '</div></div></article>'
    ).join('') : '<div class="empty-note">Add your PPOR value or an investment property to build your portfolio view.</div>';

    const ranked = props.map((p, i) => {
      const m = p.metrics || {}, raw = inputs.properties && inputs.properties[i] || {};
      return { label: raw.label || raw.address || ('Property ' + (i + 1)), cash: Number(m.year1AfterTaxCashFlow || 0), yield: m.grossYield };
    }).sort((x, y) => y.cash - x.cash);
    const performance = $('#portfolio-performance');
    if (performance) performance.innerHTML = ranked.length ? ranked.map((p, i) =>
      '<div class="performance-row"><span class="performance-rank">' + (i + 1) + '</span><span class="performance-name">' + escapeHtml(p.label) + '</span><span class="performance-yield">' + (p.yield == null ? '—' : fmtPct(p.yield, 2)) + '</span><strong class="' + (p.cash >= 0 ? 'positive' : 'negative') + '">' + (p.cash >= 0 ? '+' : '−') + fmtMoney(Math.abs(p.cash)) + '/yr</strong></div>'
    ).join('') : '<div class="empty-note">Add an investment property to see its performance here.</div>';

    const health = $('#dashboard-health');
    if (health) {
      const lvr = metrics && Number.isFinite(Number(metrics.ipLvrActual)) ? fmtPct(metrics.ipLvrActual, 1) : '—';
      const yieldValue = metrics ? fmtPct(metrics.grossYield || 0, 2) : '—';
      const cashValue = annual === null ? '—' : (annual > 0 ? money(annual) + ' required' : money(Math.abs(annual)) + ' surplus');
      health.innerHTML = '<div class="dashboard-health-head"><strong>Portfolio health indicators</strong><span>Based on current assumptions</span></div>' +
        '<div class="dashboard-health-grid">' +
        '<div><small>Investment LVR</small><strong>' + escapeHtml(lvr) + '</strong></div>' +
        '<div><small>Gross rental yield</small><strong>' + escapeHtml(yieldValue) + '</strong></div>' +
        '<div><small>Annual after-tax cash</small><strong>' + escapeHtml(cashValue) + '</strong></div>' +
        '</div>';
    }

    const alerts = $('#portfolio-alerts'), warnings = (result && result.warnings || []).slice(0, 4);
    if (alerts) alerts.innerHTML = warnings.length ? warnings.map(w => '<div class="portfolio-alert"><span class="alert-dot"></span><span>' + escapeHtml(w) + '</span></div>').join('') : '<div class="portfolio-clear"><span>✓</span><div><strong>No calculation warnings</strong><small>Confirm assumptions with your lender and tax adviser before making decisions.</small></div></div>';
  }
  function renderDashboardMarketIntel() {
    const root = $('#dashboard-market-intel');
    if (!root) return;
    const inputs = state.inputs || {};
    const first = (inputs.properties || []).find((p) => p && p.address);
    const meta = first && first.addressMeta || {};
    const suburb = currentSuburb() || {};
    const cards = [];
    const add = (label, value, note) => cards.push(
      '<div class="dashboard-market-item"><small>' + escapeHtml(label) + '</small><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(note || '') + '</span></div>'
    );
    if (first && numOrNull(meta.lat) !== null && numOrNull(meta.lon) !== null) {
      const key = inputs.properties.indexOf(first) + ':' + Number(meta.lat).toFixed(4) + ',' + Number(meta.lon).toFixed(4);
      const intelData = intel.cache[key];
      const parcel = intelData && intelData.parcel || {};
      if (intelData && intelData.jurisdiction === 'VIC') {
        add('Land parcel area', parcel.areaSqm ? fmtNum(parcel.areaSqm) + ' m²' : 'Not returned', 'Vicmap Property · CC BY 4.0');
        add('Property reference', parcel.propertyReference || 'Not matched', 'Victorian cadastral record');
        add('Council reference', parcel.propertyNumber || 'Not available', 'Vicmap property attribute');
      } else if (intelData && parcel) {
        add('Land parcel area', parcel.areaSqm ? fmtNum(parcel.areaSqm) + ' m²' : 'Not returned', 'Queensland Government spatial data');
        add('Lot / plan', parcel.lotPlan || 'Not returned', 'Queensland cadastral record');
        add('Local government', parcel.lga || 'Not returned', 'Queensland Government');
      } else {
        add('Property parcel', 'Loading…', 'Address coordinates available');
        loadDashboardPropertyIntel(first, key);
      }
    } else {
      add('Property parcel', 'Address needed', 'Add and locate an investment property');
    }
    if (suburb.medianPrice != null) add('Suburb median sale', fmtMoney(suburb.medianPrice), 'Saved suburb reference data');
    if (suburb.medianRent3Bed != null) add('3-bed median rent', fmtMoney(suburb.medianRent3Bed) + '/wk', 'Saved suburb reference data');
    if (suburb.medianRent4Bed != null) add('4-bed median rent', fmtMoney(suburb.medianRent4Bed) + '/wk', 'Saved suburb reference data');
    if (suburb.vacancyPct != null) add('Vacancy rate', Number(suburb.vacancyPct).toFixed(1) + '%', 'Saved suburb reference data');
    if (suburb.growth5yrPct != null) add('5-year price growth', Number(suburb.growth5yrPct).toFixed(1) + '%', 'Saved suburb reference data');
    if (cards.length === 0) {
      root.innerHTML = '<div class="empty-note">No property or suburb intelligence is available yet. Add a located address and suburb market data.</div>';
      return;
    }
    root.innerHTML = cards.join('');
  }

  function loadDashboardPropertyIntel(property, key) {
    if (!property || !property.addressMeta || !key || intel.loadingKey === key) return;
    const meta = property.addressMeta;
    const lat = numOrNull(meta.lat), lon = numOrNull(meta.lon);
    if (lat === null || lon === null) return;
    intel.loadingKey = key;
    const isVic = String(meta.state || state.inputs.state || '').toUpperCase() === 'VIC';
    api((isVic ? '/api/intel/vic-property' : '/api/intel/property') + '?lat=' + lat + '&lon=' + lon)
      .then((data) => {
        intel.cache[key] = data;
        renderDashboardMarketIntel();
        if (propertySectionVisible()) renderProperty();
      })
      .catch((err) => {
        const root = $('#dashboard-market-intel');
        if (root) root.innerHTML += '<div class="dashboard-data-footnote">Property data unavailable: ' + escapeHtml(err.message) + '</div>';
      })
      .finally(() => { intel.loadingKey = null; });
  }

  function renderDashboard(list) {
    const items = dash.items;
    const scored = items.filter((i) => i.score !== null && i.score !== undefined);
    const avg = scored.length
      ? scored.reduce((s, i) => s + i.score, 0) / scored.length : null;
    const best = scored.length
      ? scored.reduce((a, b) => (b.score > a.score ? b : a)) : null;
    const week = Date.now() - 7 * 86400000;
    const thisWeek = items.filter((i) => new Date(i.updatedAt || i.createdAt || 0).getTime() > week).length;
    const cur = state.result ? state.result.metrics : null;
    const curProps = (state.result && state.result.properties) || [];
    const portfolioValue = curProps.reduce((s, p) => s + ((p.metrics && p.metrics.purchasePrice) || 0), 0);
    const avgYield = curProps.length
      ? curProps.reduce((s, p) => s + ((p.metrics && p.metrics.grossYield) || 0), 0) / curProps.length : 0;

    const stats = [
      {
        label: 'Properties analysed',
        icon: 'home',
        value: String(items.length),
        foot: thisWeek
          ? `+${thisWeek} this week`
          : (items.length ? 'Active research phase' : 'Nothing analysed yet'),
        footGood: thisWeek > 0,
      },
      {
        label: 'Avg investment score',
        icon: 'pulse',
        value: avg === null ? '—' : String(Math.round(avg)),
        bar: avg === null ? null : avg,
        foot: avg === null ? 'Needs suburb data to score' : (items.length ? 'across ' + scored.length + ' scored' : ''),
      },
      {
        label: 'Best score',
        icon: 'trophy',
        value: best ? best.score.toFixed(1) : '—',
        valueClass: best ? 'amber' : '',
        pill: best ? 'TOP' : '',
        foot: best ? best.address : 'No scored properties yet',
      },
      {
        label: 'Purchase value',
        icon: 'calendar',
        value: cur ? fmtMoney(portfolioValue) : '—',
        foot: cur
          ? `${curProps.length} propert${curProps.length === 1 ? 'y' : 'ies'} · avg yield ${fmtPct(avgYield, 2)}`
          : 'Current scenario purchase total',
      },
    ];

    $('#dash-stats').innerHTML = stats.map((s) => `
      <div class="stat-card">
        ${statChip(s.icon, s.label === 'Best score' ? 'amber' : s.label === 'Portfolio value' ? 'blue' : s.label === 'Avg investment score' ? 'green' : '')}
        <div class="stat-label">${escapeHtml(s.label)}</div>
        <div class="stat-value ${s.valueClass || ''}">${escapeHtml(s.value)}${s.pill ? ` <span class="pill">${s.pill}</span>` : ''}</div>
        ${s.bar !== null && s.bar !== undefined
          ? `<div class="stat-bar"><span style="width:${Math.max(2, Math.min(100, s.bar))}%"></span></div>` : ''}
        <div class="stat-foot">${escapeHtml(s.foot)}</div>
      </div>`).join('');

    // ---- recent activity ----
    const activity = (list || []).slice(0, 6).map((s) => {
      const created = s.createdAt && s.updatedAt && s.createdAt === s.updatedAt;
      return `<div class="activity-row">
        <span class="activity-icon">${dashIcon(created ? 'home' : 'edit')}</span>
        <span class="activity-text">
          <span class="activity-title"><a data-dash-load="${s.id}">${created ? 'Added' : 'Updated'} ${escapeHtml(s.address || s.name)}</a></span>
          <span class="activity-time">${escapeHtml(fmtWhen(s.updatedAt || s.createdAt))} · ${escapeHtml(s.name)}</span>
        </span>
      </div>`;
    }).join('');
    $('#dash-activity').innerHTML = activity
      || '<div class="empty-note">No saved properties yet — set one up in Inputs and hit Save.</div>';

    // ---- property cards ----
    $('#dash-props').innerHTML = items.map((it, i) => `
      <div class="prop-card">
        <div class="prop-hero ${i % 3 === 1 ? 'alt' : i % 3 === 2 ? 'deep' : ''}">
          <span class="prop-pin">${dashIcon('pin')}</span>
          <div class="prop-addr">${escapeHtml(it.address || it.scenarioName)}</div>
          <div class="prop-sub">${escapeHtml([it.suburb, it.scenarioName].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="prop-body">
          <div class="prop-score-row">
            ${scoreRing(it.score)}
            <div>
              <div class="score-band">${escapeHtml(it.band || 'Not scored')}</div>
              <div class="score-band-sub">Investment score · ${escapeHtml(fmtWhen(it.updatedAt || it.createdAt))}</div>
            </div>
          </div>
          <div class="prop-summary">${escapeHtml(it.summary || '')}</div>
          <div class="prop-stats">
            <div class="prop-stat"><div class="k">Purchase price</div><div class="v">${fmtMoney(it.price)}</div></div>
            <div class="prop-stat"><div class="k">Gross yield</div><div class="v">${it.grossYield === null || it.grossYield === undefined ? '—' : fmtPct(it.grossYield, 2)}</div></div>
            <div class="prop-stat"><div class="k">Weekly position</div><div class="v">${it.weekly === null || it.weekly === undefined ? '—' : (it.weekly > 0 ? 'Out of pocket ' + fmtMoney(it.weekly) : it.weekly < 0 ? 'Surplus ' + fmtMoney(Math.abs(it.weekly)) : 'Break-even')}</div></div>
            <div class="prop-stat"><div class="k">10-yr equity</div><div class="v">${it.equity === null || it.equity === undefined ? '—' : fmtMoney(it.equity)}</div></div>
          </div>
          <div class="prop-card-actions">
            <button data-dash-load="${it.scenarioId}">Open</button>
            <button class="primary" data-dash-property="${it.scenarioId}" data-dash-index="${it.index}">Analyse</button>
          </div>
        </div>
      </div>`).join('')
      || `<div class="empty-note">No properties analysed yet. Add one in <b>Inputs</b> and save it — it will show up here with its score.</div>`;

    // ---- score distribution ----
    const bins = [
      { label: '0-40', min: -0.01, max: 40 },
      { label: '41-60', min: 40, max: 60 },
      { label: '61-80', min: 60, max: 80 },
      { label: '81-100', min: 80, max: 100.01 },
    ];
    const counts = bins.map((b) => scored.filter((s) => s.score > b.min && s.score <= b.max).length);
    drawChart('chart-dash-scores', {
      type: 'bar',
      data: {
        labels: bins.map((b) => b.label),
        datasets: [{
          label: 'Properties',
          data: counts,
          backgroundColor: bins.map((_, i) => [COLORS.red, COLORS.amber, COLORS.pri, COLORS.green][i]),
          borderRadius: 6,
          maxBarThickness: 72,
        }],
      },
      options: baseOpts((v) => fmtNum(v)),
    });
    renderPortfolioSnapshot();
  }

  function wireDashboard() {
    const refresh = $('#dash-refresh');
    if (refresh) refresh.addEventListener('click', () => loadDashboard(true));
    const openInputs = () => {
      const a = document.querySelector('#nav a[data-target="inputs"]');
      if (a) a.click();
      const ip = $('#address-input');
      if (ip) setTimeout(() => ip.focus(), 250);
    };
    ['#dash-add', '#dash-add-inline'].forEach((selector) => {
      const add = $(selector);
      if (add) add.addEventListener('click', openInputs);
    });
    const scenarios = $('#dash-scenarios');
    if (scenarios) scenarios.addEventListener('click', () => {
      const a = document.querySelector('#nav a[data-target="scenarios"]');
      if (a) a.click();
    });
    document.addEventListener('click', (ev) => {
      const open = ev.target.closest('[data-dash-load]');
      if (open) {
        loadScenario(Number(open.dataset.dashLoad));
        return;
      }
      const an = ev.target.closest('[data-dash-property]');
      if (an) {
        loadScenario(Number(an.dataset.dashProperty)).then(() => {
          const idx = Number(an.dataset.dashIndex) || 0;
          if (Number.isInteger(idx) && state.inputs.properties[idx]) {
            state.inputTab = idx;
            setActiveTab(idx);
          }
          const a = document.querySelector('#nav a[data-target="property"]');
          if (a) a.click();
        });
      }
    });
  }

  // ------------------------------------------------------------------
  // Property intelligence — live Queensland open data (see qld_intel.py)
  // ------------------------------------------------------------------

  const INTEL_BASEMAPS = {
    sat: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    },
    topo: {
      url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Topo/MapServer/tile/{z}/{y}/{x}',
      attribution: '&copy; Queensland Government spatial information',
    },
  };
  const BUSHFIRE_TILES =
    'https://tiles.arcgis.com/tiles/vkTwD8kHw2woKBqV/arcgis/rest/services/Bushfire_Prone_Areas/MapServer/tile/{z}/{y}/{x}';

  const intel = {
    cache: {},      // cache key -> payload
    map: null,
    base: null,     // current basemap tile layer
    bushfire: null, // bushfire tile layer
    parcel: null,   // layer group: parcel outline
    flood: null,    // layer group: flood study extent
    marker: null,   // circle marker
    overlays: { parcel: true, bushfire: false, flood: false },
    seq: 0,
  };

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function activePropertyIndex() {
    return Number.isInteger(state.inputTab) ? state.inputTab : 0;
  }

  function propertySectionVisible() {
    const el = document.querySelector('#section-property');
    return !!el && el.classList.contains('active');
  }

  function setPropertyStatus(text) {
    const el = $('#property-status');
    if (el) el.textContent = text || '';
  }

  // ArcGIS rings are clockwise; GeoJSON wants counter-clockwise outer rings.
  function esriPolygonToGeoJSON(geom) {
    if (!geom || !geom.rings || !geom.rings.length) return null;
    const rings = geom.rings.map((r) => r.map(([x, y]) => [x, y]).reverse());
    return { type: 'Polygon', coordinates: rings };
  }

  function renderProperty() {
    const idx = activePropertyIndex();
    const p = state.inputs.properties[idx];
    if (!p) return;
    const meta = p.addressMeta || {};
    const lat = numOrNull(meta.lat);
    const lon = numOrNull(meta.lon);

    const mapWrap = $('#section-property .prop-map-wrap');
    if (mapWrap) mapWrap.classList.toggle('is-unlocated', lat === null || lon === null);
    if (lat === null || lon === null) {
      setPropertyStatus(p.address
        ? 'No map coordinates for this address — pick it from the dropdown in Inputs (or type the full address and click away) so we can locate the parcel.'
        : 'No address yet. Add one in Inputs to load available government property data.');
      $('#property-cards').innerHTML = '';
      $('#property-details').innerHTML = '';
      $('#property-sources').innerHTML = '';
      clearIntelMap();
      return;
    }

    const key = idx + ':' + lat.toFixed(4) + ',' + lon.toFixed(4);
    if (intel.cache[key]) {
      renderIntel(intel.cache[key]);
      return;
    }

    const isVic = String(meta.state || state.inputs.state || '').toUpperCase() === 'VIC';
    setPropertyStatus(isVic ? 'Loading Victorian Government property data…' : 'Loading live Queensland data…');
    const seq = ++intel.seq;
    api((isVic ? '/api/intel/vic-property' : '/api/intel/property') + '?lat=' + lat + '&lon=' + lon)
      .then((d) => {
        if (seq !== intel.seq) return;
        const keys = Object.keys(intel.cache);
        if (keys.length > 20) delete intel.cache[keys[0]];
        intel.cache[key] = d;
        renderIntel(d);
      })
      .catch((err) => {
        if (seq !== intel.seq) return;
        setPropertyStatus('Could not load Queensland data: ' + err.message);
      });
  }

  function clearIntelMap() {
    if (!intel.map) return;
    [intel.parcel, intel.flood].forEach((grp) => {
      if (grp) grp.clearLayers();
    });
    if (intel.marker) {
      intel.map.removeLayer(intel.marker);
      intel.marker = null;
    }
  }

  function intelCard(label, value, sub, cls) {
    return card(label, escapeHtml(value), sub ? escapeHtml(sub) : '', cls);
  }

  function renderVicIntel(d) {
    const p = d.parcel || {};
    const area = p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : 'Not available';
    $('#property-cards').innerHTML = [
      intelCard('Land parcel area', area, 'Vicmap cadastral polygon area'),
      intelCard('Property reference', p.propertyReference || 'Not found', 'Vicmap property feature identifier'),
      intelCard('Council reference', p.propertyNumber || '—', p.councilCode ? 'Council code ' + p.councilCode : ''),
      intelCard('Property type code', p.propertyTypeCode || '—', 'Raw Vicmap classification code'),
      intelCard('Multi-assessment', p.multiAssessment || '—', 'Vicmap property attribute'),
      intelCard('Parcel status', p.statusCode || '—', 'Vicmap status code'),
    ].join('');
    const rows = [];
    const row = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push('<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(String(v)) + '</div>'); };
    row('Property reference (PFI)', p.propertyReference);
    row('Property unique feature identifier', p.propertyUfi);
    row('Council property number', p.propertyNumber);
    row('Council code', p.councilCode);
    row('Property type code', p.propertyTypeCode);
    row('Multi-assessment flag', p.multiAssessment);
    row('Status code', p.statusCode);
    row('Parcel area', p.areaSqm == null ? null : fmtNum(p.areaSqm) + ' m²');
    $('#property-details').innerHTML = rows.length ? '<div class="kv">' + rows.join('') + '</div>' : '<div class="empty-note">No parcel attributes were returned for this point.</div>';
    const shown = state.inputs.properties[activePropertyIndex()] || {};
    setPropertyStatus((shown.address ? shown.address + ' · ' : '') + 'Vicmap Property · CC BY 4.0 · fetched ' + String(d.fetchedAt || '').replace('T', ' ').slice(0, 16) + (p.propertyReference ? '' : ' · no parcel match at this coordinate'));
    $('#property-sources').innerHTML = 'Source: ' + (d.sources || []).map((s) => '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.label) + '</a> · ' + escapeHtml(s.licence || '')).join(' · ');
    renderIntelMap(d);
  }

  function renderIntel(d) {
    if (d && d.jurisdiction === 'VIC') { renderVicIntel(d); return; }
    const p = d.parcel || {};
    const lu = d.landUse || {};
    const rp = d.regionalPlan || {};
    const aoi = d.areasOfInterest || {};
    const flood = d.flood || {};
    const studies = flood.studies || [];
    const catchments = flood.catchments || [];
    const living = aoi.priorityLiving || [];
    const agri = aoi.priorityAgricultural || [];
    const env = aoi.strategicEnvironmental || [];

    const area = p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : '—';
    const tenureSub = [p.tenure, p.surveyAccurate ? 'survey accurate' : 'positional accuracy not flagged']
      .filter(Boolean).join(' · ');

    $('#property-cards').innerHTML = [
      intelCard('Lot on plan', p.lotPlan || 'Not found',
        p.lot ? `Lot ${p.lot} on plan ${p.plan}` : 'No cadastral parcel at this point'),
      intelCard('Land area', area, tenureSub),
      intelCard('Location', p.locality || '—', p.lga ? p.lga + ' Council' : ''),
      intelCard('Land use', lu.tertiary || lu.secondary || lu.primary || '—',
        lu.primary ? `${lu.primary} · ALUM ${lu.code || ''}${lu.year ? ' (' + lu.year + ')' : ''}` : ''),
      intelCard('Regional plan', rp.name || '—',
        rp.version ? `${rp.version}${rp.status ? ' · ' + rp.status : ''}` : ''),
      intelCard('Priority living area', living.length ? living.join(', ') : 'Not in one',
        living.length ? 'Area of regional interest' : 'State planning designation'),
      intelCard('Flood study', studies.length ? studies.length + (studies.length === 1 ? ' study' : ' studies') : 'None here',
        studies.length ? studies.map((s) => s.name).join(' · ') : 'No flood study mapped over this parcel'),
      intelCard('Bushfire prone area', 'Use the overlay',
        'QFES state-wide mapping — toggle it on the map'),
    ].join('');

    const rows = [];
    const row = (k, v) => { if (v) rows.push(`<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`); };
    row('Parcel name', p.featureName);
    row('Tenure', p.tenure);
    row('Local government area', p.lga);
    row('Locality', p.locality);
    row('Parcel status', p.parcelState);
    if (p.isStrata) row('Strata lots', String(p.strataCount || ''));
    row('Volumetric lot', p.isVolumetric ? 'Yes' : 'No');
    row('Multi-parcel', p.isMulti ? 'Yes' : 'No');
    row('Priority agricultural area', agri.length ? agri.join(', ') : '');
    row('Strategic environmental area', env.length ? env.join(', ') : '');
    row('Flood catchment', catchments.join(', '));
    studies.forEach((s) => {
      row(s.kind, [s.name, s.area, s.consultant].filter(Boolean).join(' · '));
    });
    $('#property-details').innerHTML = rows.length
      ? `<div class="kv">${rows.join('')}</div>`
      : '';

    const failed = (d.errors || []).map((e) => e.layer).join(', ');
    const shown = state.inputs.properties[activePropertyIndex()] || {};
    setPropertyStatus(
      `${shown.address ? shown.address + ' · ' : ''}Queensland Government open data · fetched ${String(d.fetchedAt || '').replace('T', ' ').slice(0, 16)}`
      + (failed ? ` · unavailable: ${failed}` : ''));

    $('#property-sources').innerHTML = 'Check it yourself: ' + (d.sources || []).map((s) =>
      `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`).join(' · ');

    renderIntelMap(d);
  }

  function renderIntelMap(d) {
    const el = document.getElementById('property-map');
    if (!el || !window.L) return;

    if (!intel.map) {
      intel.map = L.map(el, { zoomControl: true, scrollWheelZoom: true });
      intel.base = L.tileLayer(INTEL_BASEMAPS.sat.url, {
        maxZoom: 19, attribution: INTEL_BASEMAPS.sat.attribution,
      }).addTo(intel.map);
      intel.bushfire = L.tileLayer(BUSHFIRE_TILES, { maxZoom: 19, opacity: 0.45 });
      intel.parcel = L.layerGroup();
      intel.flood = L.layerGroup();
      bindIntelControls();
    }
    setTimeout(() => intel.map.invalidateSize(), 60);

    intel.parcel.clearLayers();
    intel.flood.clearLayers();
    if (intel.marker) intel.map.removeLayer(intel.marker);

    const { lat, lon } = d.coords;
    const pt = [lat, lon];
    intel.marker = L.circleMarker(pt, {
      radius: 7, color: '#e11d48', weight: 3, fillColor: '#e11d48', fillOpacity: 0.35,
    }).addTo(intel.map);

    const poly = esriPolygonToGeoJSON(d.parcelGeometry);
    if (poly) {
      const layer = L.geoJSON(poly, {
        style: { color: cssVar('--pri') || '#6366f1', weight: 3, fillOpacity: 0.12 },
      });
      intel.parcel.addLayer(layer);
      intel.map.fitBounds(layer.getBounds().pad(0.35));
    } else {
      intel.map.setView(pt, 18);
    }

    const floodPoly = esriPolygonToGeoJSON(d.flood && d.flood.extent);
    if (floodPoly) {
      intel.flood.addLayer(L.geoJSON(floodPoly, {
        style: { color: '#0284c7', weight: 2, dashArray: '5 4', fillOpacity: 0.08 },
      }));
    }

    applyIntelOverlays();
  }

  function applyIntelOverlays() {
    if (!intel.map) return;
    if (intel.overlays.parcel && intel.parcel) {
      if (!intel.map.hasLayer(intel.parcel)) intel.parcel.addTo(intel.map);
    } else if (intel.parcel && intel.map.hasLayer(intel.parcel)) {
      intel.map.removeLayer(intel.parcel);
    }
    if (intel.overlays.bushfire && intel.bushfire) {
      if (!intel.map.hasLayer(intel.bushfire)) intel.bushfire.addTo(intel.map);
    } else if (intel.bushfire && intel.map.hasLayer(intel.bushfire)) {
      intel.map.removeLayer(intel.bushfire);
    }
    if (intel.overlays.flood && intel.flood) {
      if (!intel.map.hasLayer(intel.flood)) intel.flood.addTo(intel.map);
    } else if (intel.flood && intel.map.hasLayer(intel.flood)) {
      intel.map.removeLayer(intel.flood);
    }
  }

  function bindIntelControls() {
    $$('.prop-map-controls .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.base) {
          const key = btn.dataset.base;
          if (!INTEL_BASEMAPS[key]) return;
          $$('.prop-map-controls .chip[data-base]').forEach((b) =>
            b.classList.toggle('active', b === btn));
          if (intel.map && intel.base) intel.map.removeLayer(intel.base);
          const meta = INTEL_BASEMAPS[key];
          intel.base = L.tileLayer(meta.url, { maxZoom: 19, attribution: meta.attribution });
          if (intel.map) {
            intel.base.addTo(intel.map);
            intel.base.bringToBack();
          }
          return;
        }
        const ov = btn.dataset.ov;
        if (!ov) return;
        intel.overlays[ov] = !intel.overlays[ov];
        btn.classList.toggle('active', intel.overlays[ov]);
        applyIntelOverlays();
      });
    });
  }


  const charts = {};
  function drawChart(id, config) {
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (!el) return;
    charts[id] = new Chart(el, config);
  }

  // Charts inside the collapsed dashboard details panel are initially measured
  // at zero width. Resize them after the user expands the panel.
  document.querySelectorAll('.dashboard-secondary-details details').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      requestAnimationFrame(() => {
        ['chart-ov-cash', 'chart-ov-cum'].forEach((id) => {
          if (charts[id]) charts[id].resize();
        });
      });
    });
  });

  const COLORS = {
    pri: '#6366f1', red: '#f43f5e', green: '#10b981', amber: '#f59e0b',
    purple: '#8b5cf6', teal: '#14b8a6', gray: '#94a3b8', pink: '#ec4899',
  };

  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const baseOpts = (yFmt = fmtMoney) => {
    const tick = cssVar('--chart-tick') || '#64748b';
    const grid = cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)';
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: tick, boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: tick, font: { size: 11 } }, grid: { color: grid } },
        y: { ticks: { color: tick, font: { size: 11 }, callback: (v) => yFmt(v) }, grid: { color: grid } },
      },
    };
  };

  // ------------------------------------------------------------------
  // Recalculation + render dispatch
  // ------------------------------------------------------------------

  // Short source-label for the sidebar foot, by scenario state.
  const STATE_RATE_SHORT = {
    QLD: 'QRO & ATO', NSW: 'Revenue NSW & ATO', VIC: 'SRO VIC & ATO',
    SA: 'Revenue SA & ATO', WA: 'WA Treasury & ATO', TAS: 'SRO TAS & ATO',
    NT: 'NT TRO & ATO', ACT: 'ACT Revenue & ATO',
  };

  function renderRateFoot() {
    const el = document.querySelector('.sidebar-foot');
    if (!el) return;
    const st = (state.inputs && state.inputs.state) || 'QLD';
    el.innerHTML = 'AUD &middot; estimates only, not tax advice.<br>Rates: ' +
      (STATE_RATE_SHORT[st] || 'QRO & ATO') + ' (Nov 2026)';
  }


  // Decision panels — concise, data-led guidance for each major workflow.
  function decisionPanel(id, eyebrow, title, body, stats) {
    const host = document.getElementById(id);
    if (!host) return;
    let panel = host.querySelector(':scope > .decision-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'decision-panel';
      host.insertBefore(panel, host.children[1] || null);
    }
    panel.innerHTML = `
      <div class="decision-panel-copy">
        <div class="decision-eyebrow">${escapeHtml(eyebrow)}</div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(body)}</p>
      </div>
      <div class="decision-stat-grid">${(stats || []).map(s => `
        <div class="decision-stat">
          <span>${escapeHtml(s.label)}</span>
          <strong>${escapeHtml(s.value)}</strong>
          ${s.note ? `<small>${escapeHtml(s.note)}</small>` : ''}
        </div>`).join('')}</div>`;
  }

  function renderDecisionPanels() {
    if (!state.result) return;
    const m = state.result.metrics;
    const idx = activePropertyIndex();
    const p = state.inputs.properties[idx] || {};
    const propName = p.label || p.address || 'Investment property';
    const propView = viewData();
    const cashRows = propView.rows || [];
    const first = cashRows[0] || {};
    const last = cashRows[cashRows.length - 1] || {};
    const x = propView.exit || state.result.exit || {};
    const suburb = currentSuburb();

    decisionPanel('section-inputs','SETUP CHECKPOINT','Your investment at a glance',
      'A live summary of the assumptions currently driving the model. Change any input below and the figures recalculate automatically.',
      [
        {label:'Purchase price',value:fmtMoney(m.purchasePrice)},
        {label:'Cash required',value:fmtMoney(m.initialCashInvested)},
        {label:'Weekly after-tax',value:signed(m.weeklyOutOfPocket)},
        {label:'Gross yield',value:fmtPct(m.grossYield)}
      ]);

    decisionPanel('section-property','PROPERTY PROFILE',propName,
      p.address ? 'Address and government spatial layers are used to build this property view. Treat missing layers as unknown, not as a clear result.' : 'Add and locate the full property address in Investment Inputs to load parcel and Queensland spatial information.',
      [
        {label:'Address',value:p.address || 'Not entered'},
        {label:'Location match',value:(p.addressMeta && p.addressMeta.lat != null) ? 'Coordinates found' : 'Pending'},
        {label:'Map layers',value:'Parcel · flood · bushfire',note:'Availability depends on location'}
      ]);

    decisionPanel('section-area','SUBURB RESEARCH',suburb ? suburb.name + ' · ' + suburb.postcode : 'Select a suburb to begin',
      suburb ? 'Use the score as a screening aid, then validate the underlying sales, rental evidence and risk factors before making an offer.' : 'Choose the suburb in Investment Inputs. Market indicators and the investment score will appear here when reference data is available.',
      suburb ? [
        {label:'Median price',value:suburb.medianPrice ? fmtMoney(suburb.medianPrice) : 'No data'},
        {label:'3-bed rent',value:suburb.medianRent3Bed ? fmtMoney(suburb.medianRent3Bed)+'/wk' : 'No data'},
        {label:'Vacancy',value:suburb.vacancyPct != null ? suburb.vacancyPct.toFixed(1)+'%' : 'No data'},
        {label:'5-year growth',value:suburb.growth5yrPct != null ? suburb.growth5yrPct.toFixed(1)+'%' : 'No data'}
      ] : []);

    decisionPanel('section-cashflow','CASH FLOW DECISION','What does it cost to hold?',
      'Positive after-tax cash flow is a surplus; negative cash flow means cash you need to contribute. Select a year below to inspect every line item.',
      [
        {label:'Year 1 after-tax',value:signed(first.afterTaxCashFlow || 0)},
        {label:'Weekly contribution',value:fmtMoney(Math.max(0,-(first.afterTaxCashFlow || 0))/52)},
        {label:'Annual rent',value:fmtMoney(first.grossRent || 0)},
        {label:'Annual operating costs',value:fmtMoney(first.operatingExpenses || 0)}
      ]);

    decisionPanel('section-projections','LONG-TERM OUTLOOK','Where could the investment be heading?',
      'The model compares projected property value with debt over your selected holding period. These are assumptions-based projections, not forecasts.',
      [
        {label:'Ending property value',value:fmtMoney(last.propertyValue || 0)},
        {label:'Ending debt',value:fmtMoney(last.totalDebt || 0)},
        {label:'Ending equity',value:fmtMoney(last.netEquity || 0)},
        {label:'Cumulative after-tax CF',value:signed(last.cumulativeAfterTaxCashFlow || 0)}
      ]);

    decisionPanel('section-exit','EXIT CHECKPOINT','What might you walk away with?',
      'Estimated proceeds are shown after selling costs, CGT and loan payouts. Review the cost-base working and tax assumptions below before relying on the result.',
      [
        {label:'Sale price',value:fmtMoney(x.salePrice || 0)},
        {label:'Estimated CGT',value:fmtMoney(x.capitalGainsTax || 0)},
        {label:'Loan payouts',value:fmtMoney((x.ipLoanBalanceAtSale || 0)+(x.equityLoanBalanceAtSale || 0))},
        {label:'Net sale proceeds',value:fmtMoney(x.netSaleProceeds || 0)}
      ]);

    const compare = state.compareData || [];
    decisionPanel('section-scenarios','DECISION COMPARISON','Compare the trade-offs, not just the purchase price',
      'Select up to three saved scenarios below. Focus on upfront cash, ongoing contribution, equity and estimated exit position together.',
      [
        {label:'Selected scenarios',value:String(compare.length)+'/3'},
        {label:'Current scenario cash',value:fmtMoney(m.initialCashInvested)},
        {label:'Current weekly position',value:signed(m.weeklyOutOfPocket)},
        {label:'10-year equity',value:fmtMoney(m.tenYearEquity)}
      ]);
  }

  function recalc() {
    try {
      state.result = E.calculateAll(state.inputs, { suburb: currentSuburb() });
      updateInputGuide();
    } catch (err) {
      console.error('calculation failed', err);
      toast('Calculation error — check inputs');
      return;
    }
    renderRateFoot();
    renderWarnings();
    renderPortfolioSnapshot();
    renderDashboardMarketIntel();
    renderOverview();
    renderArea();
    renderCashFlow();
    renderProjections();
    renderExit();
    renderBorrowing();
    if (state.compareData.length) renderCompare();
    renderDecisionPanels();
  }

  // Warnings anchored to the input or section they concern. Anything that
  // doesn't match falls back to the banner above the tabs.
  const WARNING_ANCHORS = [
    { match: 'switch from interest-only', field: 'ipInterestOnlyYears', prop: true },
    { match: '1 July 2027', section: 'exit' },
    { match: 'APRA-style estimate', section: 'borrowing' },
    { match: 'DTI comfort limit', section: 'borrowing' },
    { match: 'Surplus is negative', section: 'borrowing' },
    { match: 'Funding shortfall', field: 'equityReleased', prop: true },
    { match: '80% of your PPOR', field: 'pporValue' },
    { match: 'loan tracing', field: 'equityLoanPurposePercent' },
    { match: 'LVR above 95%', field: 'ipLvr', prop: true },
    { match: 'half-share', field: 'ownershipType' },
    { match: 'Second-hand residential', field: 'plantEquipmentEligible', prop: true },
  ];

  const WARN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>';

  function renderWarnings() {
    const top = [];
    const byField = new Map();
    const bySection = new Map();
    const deferredProps = new Set();
    for (const w of state.result.warnings || []) {
      const a = WARNING_ANCHORS.find((x) => w.includes(x.match));
      if (a && a.field) {
        if (a.prop) {
          // Per-property warning: chip the field only when that IP's tab is
          // active; otherwise the IP tab's amber dot flags it.
          const m = w.match(/^IP (\d+) — /);
          const idx = m ? Number(m[1]) - 1 : 0;
          if (state.inputTab !== idx) { deferredProps.add(idx); continue; }
        }
        if (!byField.has(a.field)) byField.set(a.field, []);
        byField.get(a.field).push(w);
      } else if (a && a.section) {
        if (!bySection.has(a.section)) bySection.set(a.section, []);
        bySection.get(a.section).push(w);
      } else {
        top.push(w);
      }
    }

    const box = $('#warnings');
    const renderBanner = () => {
      box.classList.toggle('hidden', !top.length);
      box.innerHTML = top.map((w) => `<div class="warning-item">${escapeHtml(w)}</div>`).join('');
    };
    renderBanner();

    // clear previous inline markers
    $$('.field-warn').forEach((el) => el.remove());
    $$('.field.has-warn').forEach((el) => el.classList.remove('has-warn'));
    $$('details.advanced.has-warn').forEach((el) => el.classList.remove('has-warn'));
    $$('.section-note').forEach((el) => el.remove());
    $$('#nav a.has-warn').forEach((el) => el.classList.remove('has-warn'));

    for (const [field, msgs] of byField) {
      const input = document.querySelector(`[data-field="${field}"]`);
      const wrap = input ? input.closest('.field') : null;
      if (!wrap) { top.push(...msgs); renderBanner(); continue; }
      wrap.classList.add('has-warn');
      const chip = document.createElement('div');
      chip.className = 'field-warn';
      chip.innerHTML = msgs.map((m) => `<div class="fw-row">${WARN_SVG}<span>${escapeHtml(m)}</span></div>`).join('');
      wrap.appendChild(chip);
      const details = wrap.closest('details.advanced');
      if (details) details.classList.add('has-warn');
      const nav = $('#nav a[data-target="inputs"]');
      if (nav) nav.classList.add('has-warn');
    }

    for (const [sec, msgs] of bySection) {
      const page = document.getElementById('section-' + sec);
      if (!page) { top.push(...msgs); renderBanner(); continue; }
      const note = document.createElement('div');
      note.className = 'section-note';
      note.innerHTML = msgs.map((m) => `<div class="fw-row">${WARN_SVG}<span>${escapeHtml(m)}</span></div>`).join('');
      page.prepend(note);
      const nav = $(`#nav a[data-target="${sec}"]`);
      if (nav) nav.classList.add('has-warn');
    }

    // Amber dots on IP tabs carrying warnings; Inputs nav dot when any
    // property-level warning is deferred to a hidden tab.
    const warns = propWarnIndexes();
    $$('#prop-tabs .prop-tab[data-prop-tab]').forEach((el) => {
      const n = Number(el.dataset.propTab);
      el.classList.toggle('has-warn', Number.isInteger(n) && warns.has(n));
    });
    if (deferredProps.size) {
      const nav = $('#nav a[data-target="inputs"]');
      if (nav) nav.classList.add('has-warn');
    }
  }

  // ------------------------------------------------------------------
  // Property tabs (Inputs) + per-property view selectors
  // ------------------------------------------------------------------

  function ipLabel(p, i) { return (p && p.label) || `Investment property ${i + 1}`; }

  // The label is shown on the tab strip at the top of the Inputs pane and in
  // the pane title, so renaming a property has to redraw both.
  function refreshIpLabels() {
    buildPropTabs();
    const tab = state.inputTab;
    if (Number.isInteger(tab) && state.inputs.properties[tab]) {
      $('#ip-pane-title').textContent = ipLabel(state.inputs.properties[tab], tab);
    }
  }

  function propWarnIndexes() {
    const set = new Set();
    ((state.result && state.result.propertyWarnings) || []).forEach((list, i) => {
      if (list && list.length) set.add(i);
    });
    return set;
  }

  function buildPropTabs() {
    const bar = $('#prop-tabs');
    if (!bar) return;
    const props = state.inputs.properties;
    const warns = propWarnIndexes();
    const plain = (val, label) =>
      `<span class="prop-tab ${state.inputTab === val ? 'active' : ''}" data-prop-tab="${val}">${label}</span>`;
    const ipTabs = props.map((p, i) => {
      const remove = props.length > 1
        ? `<button class="prop-remove" data-prop-remove="${i}" title="Remove this property">×</button>`
        : '';
      return `<span class="prop-tab ${state.inputTab === i ? 'active' : ''} ${warns.has(i) ? 'has-warn' : ''}" data-prop-tab="${i}">${escapeHtml(ipLabel(p, i))}${remove}</span>`;
    }).join('');
    const atCap = props.length >= E.MAX_PROPERTIES;
    bar.innerHTML = plain('portfolio', 'Portfolio') + plain('ppor', 'PPOR') + ipTabs +
      `<button class="prop-tab prop-tab-add" data-prop-add ${atCap ? 'disabled' : ''}>+ Add property</button>`;
  }


  function updateInputGuide() {
    const host=$('#input-guide'); if(!host||!state.inputs) return;
    const props=state.inputs.properties||[], idx=Number.isInteger(state.inputTab)?state.inputTab:-1;
    const data=idx>=0?(props[idx]||{}):state.inputs;
    const fields=idx>=0?[['address','Property address'],['purchasePrice','Purchase price'],['weeklyRent','Weekly rent']]:[['state','Purchase state'],['projectionYears','Hold period'],['owner1TaxableIncome','Your taxable income']];
    const done=v=>v!==''&&v!==null&&v!==undefined&&v!==0;
    const count=fields.filter(x=>done(data[x[0]])).length, pct=Math.round(count/fields.length*100);
    const active=state.inputTab==='portfolio'?'portfolio':state.inputTab==='ppor'?'ppor':'property';
    host.innerHTML='<div class="input-guide-head"><div><div class="page-eyebrow">GUIDED SETUP</div><h2>Build your investment scenario</h2><p>Start with the essentials. Advanced assumptions stay available when you need them.</p></div><div class="guide-progress"><strong>'+pct+'%</strong><span>'+count+' of '+fields.length+' essentials set</span><i><b style="width:'+pct+'%"></b></i></div></div><div class="guide-steps"><button type="button" data-guide-step="portfolio" class="'+(active==='portfolio'?'active':'')+'"><span>01</span><strong>Portfolio</strong><small>Ownership, income &amp; hold period</small></button><button type="button" data-guide-step="ppor" class="'+(active==='ppor'?'active':'')+'"><span>02</span><strong>Home &amp; equity</strong><small>PPOR value and funding</small></button><button type="button" data-guide-step="property" class="'+(active==='property'?'active':'')+'"><span>03</span><strong>Investment property</strong><small>Address, price and rental income</small></button></div><div class="guide-checklist">'+fields.map(x=>'<span class="'+(done(data[x[0]])?'done':'')+'">'+(done(data[x[0]])?'✓':'○')+' '+x[1]+'</span>').join('')+'</div>';
    host.querySelectorAll('[data-guide-step]').forEach(btn=>btn.addEventListener('click',()=>{const step=btn.dataset.guideStep;setActiveTab(step==='portfolio'?'portfolio':step==='ppor'?'ppor':0);}));
  }

  function setActiveTab(tab) {
    state.inputTab = tab;
    const pageId = tab === 'portfolio' ? 'prop-page-portfolio'
      : tab === 'ppor' ? 'prop-page-ppor' : 'prop-page-ip';
    $$('.prop-page').forEach((p) => p.classList.toggle('active', p.id === pageId));
    if (Number.isInteger(tab) && state.inputs.properties[tab]) {
      $('#ip-pane-title').textContent = ipLabel(state.inputs.properties[tab], tab);
    }
    buildPropTabs();
    updateInputGuide();
    syncForm();       // rebind the per-property fields to the newly active IP
    renderWarnings(); // chips are transient DOM; re-anchor for the active tab
    if (propertySectionVisible()) renderProperty();
  }

  $('#prop-tabs').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-prop-add]')) { addProperty(); return; }
    const rm = ev.target.closest('[data-prop-remove]');
    if (rm) {
      ev.stopPropagation();
      removeProperty(Number(rm.dataset.propRemove));
      return;
    }
    const t = ev.target.closest('[data-prop-tab]');
    if (!t) return;
    const val = t.dataset.propTab;
    setActiveTab(val === 'portfolio' || val === 'ppor' ? val : Number(val));
  });

  function addProperty() {
    const props = state.inputs.properties;
    if (props.length >= E.MAX_PROPERTIES) {
      toast(`Up to ${E.MAX_PROPERTIES} investment properties per scenario`);
      return;
    }
    const srcIdx = Number.isInteger(state.inputTab) ? state.inputTab : props.length - 1;
    const clone = JSON.parse(JSON.stringify(props[srcIdx]));
    clone.label = '';
    clone.address = '';
    clone.addressMeta = null;
    props.push(clone);
    saveDraft();
    setActiveTab(props.length - 1);
    recalc();
    toast('Property added (duplicate) — set its address, then tweak the details');
  }

  function removeProperty(idx) {
    const props = state.inputs.properties;
    if (props.length <= 1) return;
    const label = ipLabel(props[idx], idx);
    if (!confirm(`Remove ${label} and all its inputs?`)) return;
    props.splice(idx, 1);
    if (state.viewProp === idx) state.viewProp = -1;
    else if (state.viewProp > idx) state.viewProp -= 1;
    if (Number.isInteger(state.inputTab)) {
      if (state.inputTab === idx) state.inputTab = Math.max(0, idx - 1);
      else if (state.inputTab > idx) state.inputTab -= 1;
    }
    saveDraft();
    setActiveTab(state.inputTab);
    recalc();
    toast(`${label} removed`);
  }

  // Result views: -1 = portfolio, else one property's own numbers.
  function viewData() {
    const r = state.result;
    if (state.viewProp >= 0 && r.properties[state.viewProp]) {
      const p = r.properties[state.viewProp];
      return {
        property: p,
        exit: p.exit,
        rows: p.rows,
        upfront: p.upfront,
        propInputs: r.inputs.properties[state.viewProp],
        metrics: p.metrics,
        isPortfolio: false,
      };
    }
    return {
      property: null,
      exit: r.exit,
      rows: r.rows,
      upfront: r.upfront,
      propInputs: null,
      metrics: r.metrics,
      isPortfolio: true,
    };
  }

  function fillViewSelect(sel, includePpor) {
    if (!sel) return;
    const props = state.result.properties || [];
    if (typeof state.viewProp === 'number' && state.viewProp >= props.length) state.viewProp = -1;
    const viewPpor = state.viewProp === 'ppor';
    const effective = viewPpor ? -1 : state.viewProp;
    sel.innerHTML = '<option value="-1">Portfolio (all)</option>' +
      (includePpor ? '<option value="ppor">PPOR (your home)</option>' : '') +
      props.map((p, i) =>
        `<option value="${i}" ${effective === i ? 'selected' : ''}>${escapeHtml(ipLabel(p, i))}</option>`).join('');
    sel.value = String(includePpor && viewPpor ? 'ppor' : effective);
  }

  function onViewSelectChange(v) {
    state.viewProp = v === 'ppor' ? 'ppor' : Number(v);
    renderOverview();
    renderCashFlow();
    renderProjections();
    renderExit();
  }

  function card(label, value, sub, cls) {
    return `<div class="card"><div class="label">${label}</div>
      <div class="value ${cls || ''}">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  // ------------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------------

  function renderOverview() {
    const m = state.result.metrics;
    const coc = m.cashOnCashReturn === null
      ? 'n/a (fully geared)' : fmtPct(m.cashOnCashReturn, 1);
    const wop = m.weeklyOutOfPocket;
    const legacyCards = $('#overview-cards');
    if (legacyCards) legacyCards.innerHTML =
      card('Purchase price', fmtMoney(m.purchasePrice), `Duty ${fmtMoney(m.transferDuty)}${state.inputs.buyerType === 'foreign' ? ' incl. foreign surcharge' : ''}`) +
      card('Gross yield', fmtPct(m.grossYield), `Net ${fmtPct(m.netYield)}`) +
      card('Weekly out-of-pocket', fmtMoney(Math.max(0, wop)) + (wop < 0 ? ' in' : ''), 'after tax, year 1', wop > 0 ? 'bad' : 'good') +
      card('Cash required upfront', fmtMoney(m.initialCashInvested), `Total funds ${fmtMoney(m.requiredFunds)}`) +
      card('IP loan', fmtMoney(m.ipLoanAmount), `LVR ${fmtPct(m.ipLvrActual, 1)}`) +
      card('10-year equity', fmtMoney(m.tenYearEquity), `Week ${fmtMoney(Math.max(0, m.tenYearWeeklyOutOfPocket))}`) +
      card('Cash-on-cash (yr 1)', coc, 'after-tax CF / cash in') +
      card('Borrowing capacity', fmtMoney(state.result.borrowing.maxNewLoan), 'est. max additional loan');

    renderOverviewProps();

    const rows = state.result.rows;
    const labels = rows.map((r) => 'Y' + r.year + ' · ' + r.calendarYear);
    drawChart('chart-ov-equity', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Property value', data: rows.map((r) => r.propertyValue), borderColor: COLORS.pri, backgroundColor: COLORS.pri, tension: 0.15, pointRadius: 0 },
          { label: 'Total debt', data: rows.map((r) => r.totalDebt), borderColor: COLORS.red, backgroundColor: COLORS.red, tension: 0.15, pointRadius: 0 },
          { label: 'Net equity', data: rows.map((r) => r.netEquity), borderColor: COLORS.green, backgroundColor: COLORS.green, tension: 0.15, pointRadius: 0 },
        ],
      },
      options: baseOpts(),
    });
    // Decision-useful annual cash contribution: positive means cash required,
    // negative means an after-tax surplus. This also makes the IO -> P&I step-up visible.
    drawChart('chart-ov-cash', {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Cash required (+) / surplus (−)',
          data: rows.map((r) => -r.afterTaxCashFlow),
          backgroundColor: rows.map((r) => r.afterTaxCashFlow < 0 ? COLORS.amber : COLORS.green),
          borderRadius: 5,
          maxBarThickness: 34,
        }],
      },
      options: {
        ...baseOpts((v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0)),
        plugins: { ...baseOpts().plugins, tooltip: { callbacks: { label: (ctx) => ' ' + ctx.dataset.label + ': ' + signed(ctx.parsed.y) } } },
      },
    });

    // Sale waterfall-style breakdown: sale price less costs, tax and both loans.
    const exitView = viewData();
    const x = exitView.exit;
    const exitLabels = ['Sale price', 'Selling costs', 'CGT', 'IP loan payout', 'Equity loan payout', 'Cash received'];
    const exitValues = [x.salePrice, -x.sellingCosts, -x.capitalGainsTax,
      -x.ipLoanBalanceAtSale, -x.equityLoanBalanceAtSale, x.netSaleProceeds];
    const allocationProps = (state.result.properties || []).map((p, i) => ({
      label: ipLabel(p, i),
      value: Number((p.metrics || {}).purchasePrice || 0),
    })).filter((p) => p.value > 0);
    const pporAllocation = Number(state.inputs && state.inputs.pporValue) || 0;
    if (pporAllocation > 0) allocationProps.unshift({ label: 'PPOR · Home', value: pporAllocation });
    const allocationCanvas = document.getElementById('chart-ov-allocation');
    if (allocationCanvas) {
      const allocationBox = allocationCanvas.closest('.chart-box');
      if (allocationBox) allocationBox.classList.toggle('is-empty', !allocationProps.length);
      if (allocationProps.length) {
        drawChart('chart-ov-allocation', {
          type: 'doughnut',
          data: {
            labels: allocationProps.map((p) => p.label),
            datasets: [{
              label: 'Purchase value',
              data: allocationProps.map((p) => p.value),
              backgroundColor: ['#2874d0', '#0f9b8e', '#805ad5', '#e5a12b', '#df6672', '#3b9b72'],
              borderColor: cssVar('--card') || '#ffffff',
              borderWidth: 3,
              hoverOffset: 8,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
              legend: { position: 'bottom', labels: { color: cssVar('--chart-tick') || '#64748b', usePointStyle: true, padding: 14 } },
              tooltip: { callbacks: { label: (ctx) => ' ' + ctx.label + ': ' + fmtMoney(ctx.parsed) } },
            },
          },
        });
      } else if (charts['chart-ov-allocation']) {
        charts['chart-ov-allocation'].destroy();
        delete charts['chart-ov-allocation'];
      }
    }
    drawChart('chart-ov-cum', {
      type: 'bar',
      data: {
        labels: exitLabels,
        datasets: [{
          label: 'Estimated amount',
          data: exitValues,
          backgroundColor: exitValues.map((v, i) => i === 0 ? COLORS.pri : i === 5 ? COLORS.green : COLORS.red),
          borderRadius: 5,
        }],
      },
      options: {
        ...baseOpts((v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0)),
        indexAxis: 'y',
        plugins: { ...baseOpts().plugins, legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ' ' + signed(ctx.parsed.x) } } },
        scales: {
          x: { ticks: { color: cssVar('--chart-tick') || '#64748b', callback: (v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0) }, grid: { color: cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)' } },
          y: { ticks: { color: cssVar('--chart-tick') || '#64748b' }, grid: { display: false } },
        },
      },
    });
    renderGrowthScenarios();
  }

  // 3 / 5 / 7 % capital-growth bands — same inputs, growth swapped.
  function renderGrowthScenarios() {
    const gs = E.growthScenarios(state.inputs);
    $('#growth-table').innerHTML = `
      <thead><tr><th>Capital growth</th><th>10-yr equity</th><th>Exit proceeds</th>
      <th>Net position at sale</th><th>IRR</th></tr></thead><tbody>
      ${gs.map((s) => `<tr>
        <td><strong>${(s.growth * 100).toFixed(0)}%</strong></td>
        <td>${fmtMoney(s.tenYearEquity)}</td>
        <td>${fmtMoney(s.netSaleProceeds)}</td>
        <td>${signed(s.totalNetPosition)}</td>
        <td>${s.irr == null ? '—' : (s.irr * 100).toFixed(1) + '%'}</td>
      </tr>`).join('')}
      </tbody>`;
  }

  // Per-property summary table on the Overview page.
  function renderOverviewProps() {
    const t = $('#overview-props');
    if (!t) return;
    const props = state.result.properties || [];
    const pporValue = Number(state.inputs.pporValue) || 0;
    if (!props.length && pporValue <= 0) { t.innerHTML = ''; return; }
    t.innerHTML = `
      <thead><tr><th>Property</th><th>Price</th><th>Rent (wk)</th><th>Loan / LVR</th>
      <th>Yr-1 out-of-pocket (wk)</th><th>10-yr equity</th><th>IRR</th><th>Score</th><th>Sells</th></tr></thead><tbody>
      ${props.map((p) => {
        const m = p.metrics;
        const y1 = p.rows[0] || {};
        const irrTxt = m.irrApproximation === null ? 'n/a' : fmtPct(m.irrApproximation, 1);
        const score = p.score ? `${p.score.score} <span class="sub">${escapeHtml(p.score.band)}</span>` : '—';
        return `<tr>
          <td>${escapeHtml(ipLabel(p, p.index))}</td>
          <td>${fmtMoney(m.purchasePrice)}</td>
          <td>${fmtMoney((y1.weeklyRent || 0))}</td>
          <td>${fmtMoney(m.ipLoanAmount)} @ ${fmtPct(m.ipLvrActual, 0)}</td>
          <td>${fmtMoney(Math.max(0, m.weeklyOutOfPocket))}</td>
          <td>${fmtMoney(m.tenYearEquity)}</td>
          <td>${irrTxt}</td>
          <td>${score}</td>
          <td>Y${m.saleYear}</td>
        </tr>`;
      }).join('')}
      ${pporValue > 0 ? `<tr class="portfolio-ppor-row"><td>PPOR · Home</td><td>${fmtMoney(pporValue)}</td><td>—</td><td>${fmtMoney(Number(state.inputs.pporLoanBalance)||0)}</td><td>—</td><td>${fmtMoney(pporValue-(Number(state.inputs.pporLoanBalance)||0))}</td><td>—</td><td>Home</td><td>—</td></tr>` : ''}
      </tbody>`;
  }

  // ------------------------------------------------------------------
  // Cash flow section
  // ------------------------------------------------------------------

  // PPOR cash flow: the home's own running costs + household loan
  // commitments. Pre-tax only — the deductible share of the top-up
  // interest is already assessed inside the portfolio's tax numbers.
  function renderCashFlowPpor() {
    const rows = (state.result.ppor && state.result.ppor.rows) || [];
    const sel = $('#cf-year');
    const keep = Math.min(state.cfYear, rows.length);
    sel.innerHTML = rows.map((r) => `<option value="${r.year}" ${r.year === keep ? 'selected' : ''}>Year ${r.year} (${r.calendarYear})</option>`).join('');
    state.cfYear = keep;
    const row = rows[keep - 1];

    renderAnalyticsInsight('cf-insight',[
      {label:'Effective rental income',value:fmtMoney(row.effectiveRent),detail:'After vacancy allowance'},
      {label:'Net operating income',value:fmtMoney(row.netOperatingIncome),detail:'Before loan principal'},
      {label:'After-tax cash flow',value:signed(row.afterTaxCashFlow),detail:'Year '+row.year+' · '+(row.afterTaxCashFlow>=0?'surplus':'cash contribution required'),tone:row.afterTaxCashFlow>=0?'good':'warn'},
      {label:'Total debt service',value:fmtMoney(row.ipInterest+row.equityLoanInterest+row.ipPrincipalRepayment+row.equityLoanPrincipalRepayment),detail:'Interest plus principal'}
    ],'Year '+row.year+' · '+row.calendarYear);
    const deductShare = state.result.inputs.equityLoanPurposePercent;

    $('#cf-subtitle').textContent =
      `Your home — owner-occupied, no rent. Top-up interest is deductible only for the investment share (${fmtPct(deductShare, 0)}); that refund already shows in the portfolio view.`;

    const line = (label, annual, bold) =>
      `<tr ${bold ? 'style="font-weight:600"' : ''}><td>${label}</td><td>${fmtMoney(annual)}</td><td>${fmtMoney(annual / 52)}</td></tr>`;

    $('#cf-table').innerHTML = `
      <thead><tr><th>Line item</th><th>Annual</th><th>Weekly</th></tr></thead><tbody>
      ${line('Council rates', -row.councilRates)}
      ${line('Water rates', -row.waterRates)}
      ${line('Insurance', -row.insurance)}
      ${line('Maintenance', -row.maintenance)}
      ${line('PPOR loan interest', -row.pporLoanInterest)}
      ${line('PPOR loan principal', -row.pporLoanPrincipalRepayment)}
      ${line('Equity-release loan interest', -row.equityLoanInterest)}
      ${deductShare < 1 ? line(`&nbsp;&nbsp;· deductible share (${fmtPct(deductShare, 0)}) assessed in the portfolio`, -row.equityLoanDeductiblePortion) : ''}
      ${line('Equity-release loan principal', -row.equityLoanPrincipalRepayment)}
      ${line('Total household outflow', -row.totalOutflow, true)}
      </tbody>`;

    // chart headers differ from the IP view — set them here, reset below
    $('#cf-chart-expenses-title').textContent = 'Running costs by year';
    $('#cf-chart-cash-title').textContent = 'Loan repayments: interest vs principal';

    const labels = rows.map((r) => 'Y' + r.year);
    const ds = (label, key, color) => ({
      label, data: rows.map((r) => r[key]), backgroundColor: color, stack: 'opex',
    });
    drawChart('chart-cf-expenses', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          ds('Council rates', 'councilRates', COLORS.teal),
          ds('Water rates', 'waterRates', COLORS.purple),
          ds('Insurance', 'insurance', COLORS.amber),
          ds('Maintenance', 'maintenance', COLORS.pri),
        ],
      },
      options: Object.assign(baseOpts(), { scales: { x: { stacked: true, ticks: { font: { size: 11 } } }, y: { stacked: true, ticks: { font: { size: 11 }, callback: (v) => fmtMoney(v) } } } }),
    });

    drawChart('chart-cf-cash', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Loan interest', data: rows.map((r) => r.pporLoanInterest + r.equityLoanInterest), backgroundColor: COLORS.red },
          { label: 'Loan principal', data: rows.map((r) => r.pporLoanPrincipalRepayment + r.equityLoanPrincipalRepayment), backgroundColor: COLORS.pri },
        ],
      },
      options: baseOpts(),
    });
  }

  function renderCashFlow() {
    fillViewSelect($('#cf-prop'), true);
    if (state.viewProp === 'ppor') {
      renderCashFlowPpor();
      return;
    }
    $('#cf-chart-expenses-title').textContent = 'Operating expenses by year';
    $('#cf-chart-cash-title').textContent = 'Cash flow: pre-tax vs after-tax';
    const rows = viewData().rows;
    const sel = $('#cf-year');
    const keep = Math.min(state.cfYear, rows.length);
    sel.innerHTML = rows.map((r) => `<option value="${r.year}" ${r.year === keep ? 'selected' : ''}>Year ${r.year} (${r.calendarYear})</option>`).join('');
    state.cfYear = keep;
    const row = rows[keep - 1];

    $('#cf-subtitle').textContent =
      `${row.inInterestOnlyPeriod ? 'Interest-only period' : 'P&I repayments'} · land tax ${fmtMoney(row.landTax)} · marginal refund computed on taxable result ${signed(row.taxablePropertyResult)}`;

    const line = (label, annual, weekly, bold) =>
      `<tr ${bold ? 'style="font-weight:600"' : ''}><td>${label}</td><td>${fmtMoney(annual)}</td><td>${fmtMoney(annual / 52)}</td></tr>`;

    $('#cf-table').innerHTML = `
      <thead><tr><th>Line item</th><th>Annual</th><th>Weekly</th></tr></thead><tbody>
      ${line('Gross rent', row.grossRent)}
      ${line('Less vacancy', -row.vacancyLoss)}
      ${line('Effective rent', row.effectiveRent, null, true)}
      ${line('Management fees', -row.managementFees)}
      ${line('Letting fees (amortised)', -row.lettingFees)}
      ${line('Renewal / admin fees', -row.renewalFee)}
      ${line('Council rates', -row.councilRates)}
      ${line('Water rates', -row.waterRates)}
      ${line('Insurance', -row.insurance)}
      ${line('Body corporate', -row.bodyCorporate)}
      ${line('Maintenance allowance', -row.maintenance)}
      ${line('Land tax', -row.landTax)}
      ${line('Loan fees', -row.ipLoanFees)}
      ${line('IP loan interest', -row.ipInterest)}
      ${line('Equity-release loan interest', -row.equityLoanInterest)}
      ${row.equityLoanPurposePercent < 1 ? line(`&nbsp;&nbsp;· deductible portion (${fmtPct(state.result.inputs.equityLoanPurposePercent, 0)})`, -row.deductibleEquityInterest) : ''}
      ${line('Net operating income (pre-finance)', row.netOperatingIncome, null, true)}
      ${line('IP principal repayment', -row.ipPrincipalRepayment)}
      ${line('Equity loan principal repayment', -row.equityLoanPrincipalRepayment)}
      ${line('Pre-tax cash flow', row.preTaxCashFlow, null, true)}
      ${row.otherDeductibleClaims ? line('Other deductible claims', -row.otherDeductibleClaims) : ''}
      ${line('Capital works depreciation (non-cash)', -row.capitalWorksDepreciation)}
      ${line('Plant & equipment depreciation (non-cash)', -row.plantEquipmentDepreciation)}
      ${row.lmiAmortisation ? line('LMI amortisation (non-cash)', -row.lmiAmortisation) : ''}
      ${line('Taxable property result', row.taxablePropertyResult)}
      ${line('Tax refund / (cost)', row.taxRefundOrCost, null, true)}
      ${line('After-tax cash flow', row.afterTaxCashFlow, null, true)}
      </tbody>`;

    // stacked operating expenses
    const labels = rows.map((r) => 'Y' + r.year);
    const ds = (label, key, color) => ({
      label, data: rows.map((r) => r[key]), backgroundColor: color, stack: 'opex',
    });
    drawChart('chart-cf-expenses', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          ds('Management', 'managementFees', COLORS.pri),
          ds('Maintenance', 'maintenance', COLORS.amber),
          ds('Rates & water', 'councilRates', COLORS.teal),
          ds('Insurance', 'insurance', COLORS.purple),
          ds('Body corporate', 'bodyCorporate', COLORS.pink),
          ds('Land tax', 'landTax', COLORS.red),
        ],
      },
      options: Object.assign(baseOpts(), { scales: { x: { stacked: true, ticks: { font: { size: 11 } } }, y: { stacked: true, ticks: { font: { size: 11 }, callback: (v) => fmtMoney(v) } } } }),
    });

    drawChart('chart-cf-cash', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Pre-tax', data: rows.map((r) => r.preTaxCashFlow), backgroundColor: COLORS.amber },
          { label: 'After-tax', data: rows.map((r) => r.afterTaxCashFlow), backgroundColor: COLORS.pri },
        ],
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Projections section
  // ------------------------------------------------------------------

  function renderProjections() {
    fillViewSelect($('#proj-prop'));
    const rows = viewData().rows;
    const ioEnd = rows.find((r) => !r.inInterestOnlyPeriod);

    const first=rows[0], last=rows[rows.length-1];
    renderAnalyticsInsight('proj-insight',[
      {label:'Property value growth',value:fmtMoney(last.propertyValue-first.propertyValue),detail:'Projected change over '+rows.length+' years'},
      {label:'Ending equity',value:fmtMoney(last.netEquity),detail:'Property value less debt',tone:last.netEquity>=0?'good':'warn'},
      {label:'Debt reduction',value:fmtMoney(first.totalDebt-last.totalDebt),detail:'Change in total loan balance'},
      {label:'Year-one cash flow',value:signed(first.afterTaxCashFlow),detail:'After tax',tone:first.afterTaxCashFlow>=0?'good':'warn'}
    ],'Full holding period');
    $('#proj-table').innerHTML = `
      <thead><tr>
        <th>Yr</th><th>Value</th><th>Rent</th><th>NOI</th><th>Interest</th>
        <th>Principal</th><th>After-tax CF</th><th>Cum. CF</th>
        <th>Debt</th><th>Equity</th><th>Cum. position</th>
      </tr></thead><tbody>
      ${rows.map((r) => `
        <tr class="${ioEnd && r.year === ioEnd.year ? 'io-end' : ''}">
          <td>Y${r.year} · ${r.calendarYear}</td>
          <td>${fmtMoney(r.propertyValue)}</td>
          <td>${fmtMoney(r.grossRent)}</td>
          <td>${fmtMoney(r.netOperatingIncome)}</td>
          <td>${fmtMoney(r.ipInterest + r.equityLoanInterest)}</td>
          <td>${fmtMoney(r.ipPrincipalRepayment + r.equityLoanPrincipalRepayment)}</td>
          <td>${signed(r.afterTaxCashFlow)}</td>
          <td>${signed(r.cumulativeAfterTaxCashFlow)}</td>
          <td>${fmtMoney(r.totalDebt)}</td>
          <td>${fmtMoney(r.netEquity)}</td>
          <td>${signed(r.cumulativePosition)}</td>
        </tr>`).join('')}
      </tbody>`;

    const labels = rows.map((r) => 'Y' + r.year);
    drawChart('chart-proj-value', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Property value', data: rows.map((r) => r.propertyValue), borderColor: COLORS.pri, tension: 0.15, pointRadius: 0 },
          { label: 'Total debt', data: rows.map((r) => r.totalDebt), borderColor: COLORS.red, tension: 0.15, pointRadius: 0 },
          { label: 'Net equity', data: rows.map((r) => r.netEquity), borderColor: COLORS.green, tension: 0.15, pointRadius: 0 },
        ],
      },
      options: baseOpts(),
    });
    drawChart('chart-proj-rent', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Gross rent', data: rows.map((r) => r.grossRent), borderColor: COLORS.green, tension: 0.15, pointRadius: 0 },
          { label: 'Operating expenses', data: rows.map((r) => r.operatingExpenses), borderColor: COLORS.amber, tension: 0.15, pointRadius: 0 },
          { label: 'Interest (both loans)', data: rows.map((r) => r.ipInterest + r.equityLoanInterest), borderColor: COLORS.red, tension: 0.15, pointRadius: 0 },
        ],
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Exit / CGT section
  // ------------------------------------------------------------------

  function renderExit() {
    const view = viewData();
    fillViewSelect($('#exit-prop'));
    const x = view.exit;
    const profit = x.totalNetPosition;

    renderAnalyticsInsight('exit-insight',[
      {label:'Gross capital gain',value:fmtMoney(x.capitalGain),detail:'Before CGT discount'},
      {label:'Estimated CGT',value:fmtMoney(x.capitalGainsTax),detail:'Based on entered marginal rate',tone:'warn'},
      {label:'Net sale proceeds',value:fmtMoney(x.netSaleProceeds),detail:'After selling costs, CGT and loans'},
      {label:'Total net position',value:fmtMoney(profit),detail:'Includes cumulative cash flow and initial cash',tone:profit>=0?'good':'warn'}
    ],'Sale year '+x.saleYear);
    const sellingSub = view.propInputs
      ? `${fmtPct(view.propInputs.sellingCostRate, 1)} + fixed`
      : 'combined across properties';
    const purchasePrice = view.propInputs ? view.propInputs.purchasePrice : view.metrics.purchasePrice;
    // Per-property rows carry no cumulative column — sum the yearly flows.
    const cumAtSale = view.propInputs
      ? view.rows.slice(0, x.saleYear).reduce((s, r) => s + r.afterTaxCashFlow, 0)
      : view.rows[x.saleYear - 1].cumulativeAfterTaxCashFlow;

    $('#exit-cards').innerHTML =
      card(`Sale price (year ${x.saleYear}, ${x.calendarSaleYear})`, fmtMoney(x.salePrice)) +
      card('Selling costs', fmtMoney(x.sellingCosts), sellingSub) +
      card('Capital gain', fmtMoney(x.capitalGain), `Cost base ${fmtMoney(x.costBase)}`) +
      card('CGT', fmtMoney(x.capitalGainsTax), `50% discount applied: ${x.discountRate ? 'yes' : 'no'} · rate ${fmtPct(x.cgtRate, 0)}`) +
      card('Net sale proceeds', fmtMoney(x.netSaleProceeds), 'after costs, CGT & loans') +
      card('Total net position', fmtMoney(profit), 'proceeds + cumulative CF − cash in', profit >= 0 ? 'good' : 'bad');

    const line = (label, v, bold) =>
      `<tr ${bold ? 'style="font-weight:600"' : ''}><td>${label}</td><td>${signed(v)}</td></tr>`;
    $('#exit-table').innerHTML = `
      <thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>
      ${line('Sale price', x.salePrice)}
      ${line('Less selling costs', -x.sellingCosts)}
      ${line('Cost base: purchase price', purchasePrice)}
      ${line('Cost base: duty & acquisition costs', view.upfront.acquisitionCosts)}
      ${line('Cost base: less capital works claimed', -x.capitalWorksClaimed)}
      ${line('Cost base total', x.costBase, true)}
      ${line('Capital gain before discount', x.capitalGain, true)}
      ${line(`Taxable gain after ${x.discountRate * 100}% discount`, x.taxableCapitalGain)}
      ${line(`CGT at ${fmtPct(x.cgtRate, 0)} marginal rate`, -x.capitalGainsTax)}
      ${line('Repay IP loan', -x.ipLoanBalanceAtSale)}
      ${line('Repay equity-release loan', -x.equityLoanBalanceAtSale)}
      ${line('Net sale proceeds', x.netSaleProceeds, true)}
      ${line('Plus cumulative after-tax cash flow', cumAtSale)}
      ${line('Less initial cash invested', -view.upfront.initialCashInvested)}
      ${line('Total net position', x.totalNetPosition, true)}
      </tbody>`;
    $('#exit-note').textContent = x.warnings[0] || '';

    // Dedicated sale-proceeds chart on the Exit page (kept separate from
    // the dashboard's summary chart so it renders when this page is opened).
    drawChart('chart-exit-waterfall', {
      type: 'bar',
      data: {
        labels: ['Sale price', 'Selling costs', 'Capital gains tax', 'IP loan payout', 'Equity loan payout', 'Net sale proceeds'],
        datasets: [{
          label: 'Estimated amount',
          data: [x.salePrice, -x.sellingCosts, -x.capitalGainsTax,
            -x.ipLoanBalanceAtSale, -x.equityLoanBalanceAtSale, x.netSaleProceeds],
          backgroundColor: [COLORS.pri, COLORS.red, COLORS.amber, COLORS.red, COLORS.red, COLORS.green],
          borderRadius: 6,
        }],
      },
      options: {
        ...baseOpts((v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0)),
        indexAxis: 'y',
        plugins: { ...baseOpts().plugins, legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ' ' + signed(ctx.parsed.x) } } },
        scales: {
          x: { ticks: { color: cssVar('--chart-tick') || '#64748b', callback: (v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0) }, grid: { color: cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)' } },
          y: { ticks: { color: cssVar('--chart-tick') || '#64748b' }, grid: { display: false } },
        },
      },
    });
  }

  // ------------------------------------------------------------------
  // Borrowing section
  // ------------------------------------------------------------------

  function renderBorrowing() {
    const b = state.result.borrowing;

    renderAnalyticsInsight('borrowing-insight',[
      {label:'Monthly surplus',value:fmtMoney(b.monthlySurplus),detail:'After assessed commitments',tone:b.monthlySurplus>=0?'good':'warn'},
      {label:'Indicative new borrowing',value:fmtMoney(b.maxNewLoan),detail:'Modelled serviceability estimate',tone:b.maxNewLoan>0?'good':'warn'},
      {label:'Debt-to-income',value:b.estimatedDTI?b.estimatedDTI.toFixed(1)+'x':'—',detail:'Compare with your warning threshold',tone:b.estimatedDTI>state.result.inputs.bcDtiWarn?'warn':'good'},
      {label:'Assessment buffer',value:fmtPct(b.assessmentBuffer,1),detail:'Added to loan rates for assessment'}
    ],'Indicative only · lender policy varies');
    $('#borrowing-cards').innerHTML =
      card('Assessable income', fmtMoney(b.assessableIncome), `rent shaded: ${fmtMoney(b.rentAssessed)}`) +
      card('Living expenses', fmtMoney(b.livingExpenses)) +
      card('Existing repayments (assessed)', fmtMoney(b.existingRepayments), `PPOR ${fmtMoney(b.pporRepayAssessed)} + equity ${fmtMoney(b.equityRepayAssessed)}`) +
      card('Proposed IP repayment (assessed)', fmtMoney(b.proposedRepayAssessed), `on ${fmtMoney(b.proposedLoan)} at rate + ${fmtPct(b.assessmentBuffer, 1)}`) +
      card('Monthly surplus', fmtMoney(b.monthlySurplus), b.monthlySurplus >= 0 ? '' : 'negative — no capacity', b.monthlySurplus >= 0 ? 'good' : 'bad') +
      card('Max additional loan', fmtMoney(b.maxNewLoan), '', b.maxNewLoan > 0 ? 'good' : 'bad') +
      card('Est. DTI after purchase', b.estimatedDTI ? b.estimatedDTI.toFixed(1) + 'x' : '—', `warn above ${state.result.inputs.bcDtiWarn}x`);

    const sens = state.result.borrowingSensitivity;
    drawChart('chart-bc-sens', {
      type: 'line',
      data: {
        labels: sens.map((s) => (s.rate * 100).toFixed(2) + '%'),
        datasets: [{
          label: 'Max additional borrowing',
          data: sens.map((s) => s.maxNewLoan),
          borderColor: COLORS.pri, backgroundColor: 'rgba(37,99,235,0.1)',
          tension: 0.15, fill: true, pointRadius: 3,
        }],
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Area report: suburb data, investment score, comps, bank rates
  // ------------------------------------------------------------------

  function currentSuburb() {
    const id = Number(state.inputs.suburbId) || 0;
    return state.suburbs.find((s) => s.id === id) || null;
  }

  async function loadAreaData() {
    const [suburbs, rates] = await Promise.all([
      api('/api/suburbs').catch(() => []),
      api('/api/bank-rates').catch(() => []),
    ]);
    state.suburbs = suburbs || [];
    state.bankRates = rates || [];
    renderSuburbSelect();
    renderRatesTable();
    renderSuburbTable();
    renderRateHint();
    recalc();
  }

  function renderSuburbSelect() {
    const sel = $('#suburb-select');
    if (!sel) return;
    const cur = Number(state.inputs.suburbId) || 0;
    sel.innerHTML = '<option value="0">— not set —</option>' +
      state.suburbs.map((s) =>
        `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${escapeHtml(s.name)} ${escapeHtml(s.postcode)}</option>`
      ).join('');
  }

  function renderRateHint() {
    const el = $('#ip-rate-hint');
    if (!el) return;
    if (!state.bankRates.length) {
      el.textContent = 'No investor rates loaded yet.';
      return;
    }
    const parts = state.bankRates
      .filter((r) => r.investorIoRate)
      .map((r) => `${escapeHtml(r.bankName)} ${(r.investorIoRate * 100).toFixed(2)}%`);
    const checked = state.bankRates.find((r) => r.checkedAt);
    el.textContent = 'Advertised investor IO rates: ' + parts.join(' · ') +
      (checked ? ' (checked ' + checked.checkedAt + ')' : '');
  }

  function sourceNote(suburb, field) {
    const meta = suburb && suburb.sources && suburb.sources[field];
    if (!meta) return '';
    return `${meta.source || ''}${meta.asOf ? ' · ' + meta.asOf : ''}`;
  }

  function statCard(label, value, sub) {
    return `<div class="card stat-card"><div class="label">${label}</div>
      <div class="value">${value}</div><div class="sub">${sub || ''}</div></div>`;
  }

  function renderArea() {
    const s = currentSuburb();
    renderRiskChecklist();
    const cards = $('#area-cards');
    const links = $('#area-links');
    const score = state.result.score;

    if (!s) {
      cards.innerHTML = `<div class="card"><div class="label">No suburb selected</div>
        <div class="value" style="font-size:16px">Pick a suburb in Inputs</div>
        <div class="sub">Suburb stats, the investment score and reference links appear here.</div></div>`;
      links.innerHTML = '';
      $('#score-panel').innerHTML = '';
      $('#score-table').innerHTML = '';
      renderCompTable();
      return;
    }

    const money = (v) => (v ? fmtMoney(v) : '—');
    cards.innerHTML = [
      statCard('Median sale price', money(s.medianPrice), sourceNote(s, 'medianPrice')),
      statCard('Median rent 2-bed', s.medianRent2Bed ? fmtMoney(s.medianRent2Bed) + '/wk' : '—', sourceNote(s, 'medianRent2Bed')),
      statCard('Median rent 3-bed', s.medianRent3Bed ? fmtMoney(s.medianRent3Bed) + '/wk' : '—', sourceNote(s, 'medianRent3Bed')),
      statCard('Median rent 4-bed', s.medianRent4Bed ? fmtMoney(s.medianRent4Bed) + '/wk' : '—', sourceNote(s, 'medianRent4Bed')),
      statCard('Vacancy rate', s.vacancyPct != null ? s.vacancyPct.toFixed(1) + '%' : '—', sourceNote(s, 'vacancyPct')),
      statCard('5-yr capital growth', s.growth5yrPct != null ? s.growth5yrPct.toFixed(0) + '%' : '—', sourceNote(s, 'growth5yrPct')),
      statCard('Population growth', s.populationGrowthPct != null ? s.populationGrowthPct.toFixed(1) + '%' : '—', sourceNote(s, 'populationGrowthPct')),
      statCard('Days on market', s.medianDaysOnMarket != null ? fmtNum(s.medianDaysOnMarket) : '—', sourceNote(s, 'medianDaysOnMarket')),
    ].join('');

    const pc = encodeURIComponent(s.postcode);
    const slug = encodeURIComponent(String(s.name).toLowerCase().replace(/\s+/g, '-'));
    links.innerHTML = 'Check the source yourself: ' + [
      `<a href="https://www.realestate.com.au/suburb/${slug}-qld-${pc}" target="_blank" rel="noopener">REA suburb profile</a>`,
      `<a href="https://www.rta.qld.gov.au/property-and-land/rental-bond-and-housing-advice/median-rent-search" target="_blank" rel="noopener">RTA median rents</a>`,
      `<a href="https://sqmresearch.com.au/total-vacancy-search.php?postcode=${pc}&type=4" target="_blank" rel="noopener">SQM vacancy ${escapeHtml(s.postcode)}</a>`,
      `<a href="https://www.qld.gov.au/land-valuation" target="_blank" rel="noopener">QLD land valuation</a>`,
      `<a href="https://globe.qld.gov.au/" target="_blank" rel="noopener">QLD Globe</a>`,
    ].join(' · ');

    const bandClass = 'band-' + score.band.replace(/\s+/g, '-');
    $('#score-panel').innerHTML = `
      <div class="score-big ${bandClass}">${score.score}</div>
      <div>
        <div class="score-band ${bandClass}">${score.band}</div>
        <div class="score-note">${score.scoredMax} of 100 points scored${
          score.missing.length ? ` · ${score.missing.length} factor(s) without data` : ''}</div>
      </div>
      <div class="factors">
        ${score.factors.map((f) => `
          <div class="factor-row ${f.scored ? '' : 'unscored'}">
            <span>${f.label}</span>
            <span>${f.display}</span>
            <span>${f.scored ? f.points + '/' + f.maxPoints : '—'}</span>
            <span class="factor-bar"><span style="width:${f.maxPoints ? (f.points / f.maxPoints) * 100 : 0}%"></span></span>
          </div>`).join('')}
      </div>`;

    $('#score-table').innerHTML = `
      <thead><tr><th>Factor</th><th>Value</th><th>Points</th><th>Band</th>
      <th>Why it matters</th><th>Source</th></tr></thead><tbody>
      ${score.factors.map((f) => `<tr class="${f.scored ? '' : 'unscored'}">
        <td>${f.label}</td>
        <td>${f.display}</td>
        <td>${f.scored ? f.points + '/' + f.maxPoints : 'not scored'}</td>
        <td>${f.band}</td>
        <td>${f.rationale}</td>
        <td class="factor-src">${f.source || ''}</td>
      </tr>`).join('')}
      </tbody>`;

    renderCompTable();
  }

  function renderCompTable() {
    const t = $('#comp-table');
    if (!t) return;
    if (!state.scenarioId) {
      t.innerHTML = '<tr><td>Save the scenario first to attach comparable sales.</td></tr>';
      return;
    }
    if (!state.comps.length) {
      t.innerHTML = '<tr><td>No comparables yet — paste one from realestate.com.au above.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Address</th><th>Sold</th><th>Date</th><th>Beds</th><th>Land</th>
      <th>Rent</th><th>$/m²</th><th>Yield</th><th>vs subject</th><th></th></tr></thead><tbody>
      ${state.comps.map((c) => {
        const d = E.compDerivations(c, state.inputs);
        const label = escapeHtml(c.address || 'listing');
        return `<tr>
          <td>${c.url ? `<a class="comp-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${label}</a>` : label}</td>
          <td>${c.soldPrice ? fmtMoney(c.soldPrice) : '—'}</td>
          <td>${escapeHtml(c.soldDate || '')}</td>
          <td>${c.beds != null ? c.beds : '—'}</td>
          <td>${c.landM2 ? fmtNum(c.landM2) + ' m²' : '—'}</td>
          <td>${c.rentEstimate ? fmtMoney(c.rentEstimate) : '—'}</td>
          <td>${d.perM2 ? fmtMoney(d.perM2) : '—'}</td>
          <td>${d.impliedGrossYield ? fmtPct(d.impliedGrossYield) : '—'}</td>
          <td>${d.priceRatio ? (d.priceRatio >= 1 ? '+' : '') + fmtPct(d.priceRatio - 1) : '—'}</td>
          <td><button data-del-comp="${c.id}" class="danger">×</button></td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  async function loadComps() {
    if (!state.scenarioId) {
      state.comps = [];
      state.rentals = [];
      renderCompTable();
      renderRentalTable();
      return;
    }
    try {
      state.comps = await api(`/api/scenarios/${state.scenarioId}/comps`);
    } catch (err) {
      state.comps = [];
    }
    try {
      state.rentals = await api(`/api/scenarios/${state.scenarioId}/rentals`);
    } catch (err) {
      state.rentals = [];
    }
    renderCompTable();
    renderRentalTable();
  }

  function renderRatesTable() {
    const t = $('#rates-table');
    if (!t) return;
    if (!state.bankRates.length) {
      t.innerHTML = '<tr><td>No rates yet — add one below.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Bank</th><th>Investor IO</th><th>Investor P&amp;I</th>
      <th>Source</th><th>Checked</th><th></th></tr></thead><tbody>
      ${state.bankRates.map((r) => `<tr>
        <td>${escapeHtml(r.bankName)}</td>
        <td><input type="number" step="0.01" data-rate-io="${r.id}" value="${r.investorIoRate != null ? (r.investorIoRate * 100).toFixed(2) : ''}"></td>
        <td><input type="number" step="0.01" data-rate-pi="${r.id}" value="${r.investorPiRate != null ? (r.investorPiRate * 100).toFixed(2) : ''}"></td>
        <td><input type="text" autocomplete="off" data-rate-src="${r.id}" value="${escapeHtml(r.source || '')}"></td>
        <td>${escapeHtml(r.checkedAt || '')}</td>
        <td class="scenario-row">
          <button data-save-rate="${r.id}">Save</button>
          <button data-del-rate="${r.id}" class="danger">×</button>
        </td>
      </tr>`).join('')}
      </tbody>`;
  }

  function renderSuburbTable() {
    const t = $('#suburb-table');
    if (!t) return;
    if (!state.suburbs.length) {
      t.innerHTML = '<tr><td>No suburbs yet — add one below.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Suburb</th><th>Median price</th><th>3-bed rent</th>
      <th>Vacancy</th><th>5-yr growth</th><th></th></tr></thead><tbody>
      ${state.suburbs.map((s) => `<tr>
        <td>${escapeHtml(s.name)} ${escapeHtml(s.postcode)}</td>
        <td><input type="number" data-sub-price="${s.id}" value="${s.medianPrice != null ? s.medianPrice : ''}"></td>
        <td><input type="number" data-sub-rent3="${s.id}" value="${s.medianRent3Bed != null ? s.medianRent3Bed : ''}"></td>
        <td><input type="number" step="0.1" data-sub-vacancy="${s.id}" value="${s.vacancyPct != null ? s.vacancyPct : ''}"></td>
        <td><input type="number" step="1" data-sub-growth="${s.id}" value="${s.growth5yrPct != null ? s.growth5yrPct : ''}"></td>
        <td class="scenario-row">
          <button data-save-sub="${s.id}">Save</button>
          <button data-del-sub="${s.id}" class="danger">×</button>
        </td>
      </tr>`).join('')}
      </tbody>`;
  }

  // --- area event wiring -------------------------------------------------

  $('#suburb-select').addEventListener('change', (ev) => {
    state.inputs.suburbId = Number(ev.target.value) || 0;
    scheduleRecalc();
  });

  $('#btn-add-comp').addEventListener('click', async () => {
    if (!state.scenarioId) {
      $('#comp-msg').textContent = 'Save the scenario first.';
      return;
    }
    const body = {
      address: $('#comp-address').value.trim(),
      soldPrice: $('#comp-price').value ? Number($('#comp-price').value) : null,
      soldDate: $('#comp-date').value.trim(),
      beds: $('#comp-beds').value ? Number($('#comp-beds').value) : null,
      landM2: $('#comp-land').value ? Number($('#comp-land').value) : null,
      rentEstimate: $('#comp-rent').value ? Number($('#comp-rent').value) : null,
      url: $('#comp-url').value.trim(),
    };
    try {
      await api(`/api/scenarios/${state.scenarioId}/comps`, { method: 'POST', body: JSON.stringify(body) });
      ['#comp-address', '#comp-price', '#comp-date', '#comp-beds', '#comp-land', '#comp-rent', '#comp-url']
        .forEach((sel) => { $(sel).value = ''; });
      $('#comp-msg').textContent = 'Comparable added.';
      await loadComps();
      recalc();
    } catch (err) {
      $('#comp-msg').textContent = 'Could not add: ' + err.message;
    }
  });

  $('#comp-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-del-comp]');
    if (!btn) return;
    try {
      await api('/api/comps/' + btn.dataset.delComp, { method: 'DELETE' });
      await loadComps();
      recalc();
    } catch (err) { toast('Delete failed: ' + err.message); }
  });

  // --- AI sold-comps search ---------------------------------------------

  function renderCompSearch() {
    const box = $('#comp-search-results');
    const t = $('#comp-search-table');
    box.classList.remove('hidden');
    if (!state.compCandidates.length) {
      t.innerHTML = '<tr><td>No comparables found — try a more specific address or add one manually.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th></th><th>Address</th><th>Sold</th><th>Date</th><th>Beds</th>
      <th>Land</th><th>Rent</th><th>Confidence</th><th>Source</th></tr></thead><tbody>
      ${state.compCandidates.map((c, i) => {
        const label = escapeHtml(c.address || 'listing');
        let host = c.source || '';
        try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch (e) { /* keep source */ }
        return `<tr>
          <td><input type="checkbox" data-cand="${i}" checked></td>
          <td>${c.url ? `<a class="comp-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${label}</a>` : label}</td>
          <td>${c.soldPrice ? fmtMoney(c.soldPrice) : '—'}</td>
          <td>${escapeHtml(c.soldDate || '')}</td>
          <td>${c.beds != null ? c.beds : '—'}</td>
          <td>${c.landM2 ? fmtNum(c.landM2) + ' m²' : '—'}</td>
          <td>${c.rentEstimate ? fmtMoney(c.rentEstimate) : '—'}</td>
          <td><span class="conf-${escapeHtml(c.confidence || 'low')}">${escapeHtml(c.confidence || 'low')}</span></td>
          <td>${escapeHtml(host)}</td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  $('#btn-find-comps').addEventListener('click', async () => {
    const btn = $('#btn-find-comps');
    const hint = $('#comp-search-hint');
    if (!state.scenarioId) { hint.textContent = 'Save the scenario first.'; return; }
    const address = (state.inputs.address || '').trim();
    if (!address) { hint.textContent = 'Enter the subject address in Inputs first.'; return; }
    hint.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Searching… can take a minute';
    try {
      const data = await api('/api/comps/search', {
        method: 'POST',
        body: JSON.stringify({ address, beds: state.inputs.bedrooms || null }),
      });
      state.compCandidates = data.comps || [];
      $('#comp-search-msg').textContent = '';
      renderCompSearch();
      btn.disabled = false;
      btn.textContent = 'Find sold comps (AI)';
    } catch (err) {
      btn.textContent = 'Find sold comps (AI)';
      if (/not configured/.test(err.message)) {
        hint.textContent = 'AI comps search is off — set PA_ANTHROPIC_API_KEY in .env (needs Anthropic API credits) to enable.';
        // stays disabled until the key is added and the app restarts
      } else {
        btn.disabled = false;
        hint.textContent = 'Search failed: ' + err.message;
      }
    }
  });

  $('#btn-save-comps').addEventListener('click', async () => {
    if (!state.scenarioId) return;
    const msg = $('#comp-search-msg');
    const picked = $$('input[data-cand]').filter((cb) => cb.checked)
      .map((cb) => state.compCandidates[Number(cb.dataset.cand)])
      .filter(Boolean);
    if (!picked.length) { msg.textContent = 'Tick at least one row.'; return; }
    let saved = 0;
    for (const c of picked) {
      try {
        await api(`/api/scenarios/${state.scenarioId}/comps`, {
          method: 'POST',
          body: JSON.stringify({
            address: c.address, soldPrice: c.soldPrice, soldDate: c.soldDate,
            beds: c.beds, landM2: c.landM2, rentEstimate: c.rentEstimate,
            url: c.url, notes: 'AI search (' + (c.confidence || 'low') + ' confidence)',
          }),
        });
        saved++;
        msg.textContent = `Saving… ${saved}/${picked.length}`;
      } catch (err) {
        msg.textContent = `Saved ${saved} of ${picked.length} — ${err.message}`;
        break;
      }
    }
    if (saved) {
      state.compCandidates = [];
      $('#comp-search-results').classList.add('hidden');
      msg.textContent = `Saved ${saved} comparable${saved === 1 ? '' : 's'}.`;
      await loadComps();
      recalc();
    }
  });

  $('#btn-add-rate').addEventListener('click', async () => {
    const body = {
      bankName: $('#rate-bank').value.trim(),
      investorIoRate: $('#rate-io').value ? Number($('#rate-io').value) / 100 : null,
      investorPiRate: $('#rate-pi').value ? Number($('#rate-pi').value) / 100 : null,
      source: $('#rate-source').value.trim(),
      checkedAt: new Date().toISOString().slice(0, 7),
    };
    if (!body.bankName) { toast('Enter a bank name'); return; }
    try {
      await api('/api/bank-rates', { method: 'POST', body: JSON.stringify(body) });
      $('#rate-bank').value = ''; $('#rate-io').value = ''; $('#rate-pi').value = ''; $('#rate-source').value = '';
      await loadAreaData();
      toast('Rate added');
    } catch (err) { toast('Could not add rate: ' + err.message); }
  });

  $('#rates-table').addEventListener('click', async (ev) => {
    const save = ev.target.closest('button[data-save-rate]');
    const del = ev.target.closest('button[data-del-rate]');
    try {
      if (save) {
        const id = save.dataset.saveRate;
        const io = $(`[data-rate-io="${id}"]`).value;
        const pi = $(`[data-rate-pi="${id}"]`).value;
        const src = $(`[data-rate-src="${id}"]`).value;
        await api('/api/bank-rates/' + id, {
          method: 'PUT',
          body: JSON.stringify({
            investorIoRate: io === '' ? null : Number(io) / 100,
            investorPiRate: pi === '' ? null : Number(pi) / 100,
            source: src,
          }),
        });
        await loadAreaData();
        toast('Rate saved');
      } else if (del) {
        if (!confirm('Delete this rate row?')) return;
        await api('/api/bank-rates/' + del.dataset.delRate, { method: 'DELETE' });
        await loadAreaData();
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#btn-add-suburb').addEventListener('click', async () => {
    const body = {
      name: $('#sub-name').value.trim(),
      postcode: $('#sub-postcode').value.trim(),
      medianPrice: $('#sub-price').value ? Number($('#sub-price').value) : null,
      medianRent3Bed: $('#sub-rent3').value ? Number($('#sub-rent3').value) : null,
      vacancyPct: $('#sub-vacancy').value ? Number($('#sub-vacancy').value) : null,
      growth5yrPct: $('#sub-growth').value ? Number($('#sub-growth').value) : null,
      sources: { medianPrice: { source: 'entered manually', asOf: new Date().toISOString().slice(0, 7) } },
    };
    if (!body.name || !body.postcode) { toast('Suburb name and postcode are required'); return; }
    try {
      await api('/api/suburbs', { method: 'POST', body: JSON.stringify(body) });
      $('#sub-name').value = ''; $('#sub-postcode').value = '';
      await loadAreaData();
      toast('Suburb added');
    } catch (err) { toast('Could not add suburb: ' + err.message); }
  });

  $('#suburb-table').addEventListener('click', async (ev) => {
    const save = ev.target.closest('button[data-save-sub]');
    const del = ev.target.closest('button[data-del-sub]');
    try {
      if (save) {
        const id = save.dataset.saveSub;
        const val = (sel) => {
          const v = $(`[${sel}="${id}"]`).value;
          return v === '' ? null : Number(v);
        };
        await api('/api/suburbs/' + id, {
          method: 'PUT',
          body: JSON.stringify({
            medianPrice: val('data-sub-price'),
            medianRent3Bed: val('data-sub-rent3'),
            vacancyPct: val('data-sub-vacancy'),
            growth5yrPct: val('data-sub-growth'),
          }),
        });
        await loadAreaData();
        toast('Suburb saved');
      } else if (del) {
        if (!confirm('Delete this suburb?')) return;
        await api('/api/suburbs/' + del.dataset.delSub, { method: 'DELETE' });
        await loadAreaData();
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  // ------------------------------------------------------------------
  // Scenario CRUD
  // ------------------------------------------------------------------

  async function api(url, opts = {}) {
    const headers = Object.assign(
      { 'Content-Type': 'application/json' }, opts.headers);
    if (opts.body && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
    }
    if (getToken()) headers.Authorization = 'Bearer ' + getToken();
    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    if (resp.status === 401) {
      // Token expired/invalid — drop it and put the login screen back up.
      setToken(null);
      setCurrentUser(null);
      showLogin('Your session expired — please sign in again');
      throw new Error('authentication required');
    }
    const body = await resp.json().catch(() => ({ ok: false, error: 'bad JSON' }));
    if (!body.ok) {
      const e = new Error(body.error || 'request failed');
      if (body.fields) e.fields = body.fields;
      throw e;
    }
    return body.data;
  }

  function saveErrorText(err) {
    const detail = err.fields
      ? Object.entries(err.fields).map(([f, m]) => `${f}: ${m}`).join('; ')
      : '';
    return detail ? `${err.message} — ${detail}` : err.message;
  }

  async function refreshScenarioList() {
    const list = await api('/api/scenarios');
    state.scenarioList = list;
    const sel = $('#scenario-select');
    sel.innerHTML = '<option value="">— unsaved draft —</option>' +
      list.map((s) => `<option value="${s.id}" ${s.id === state.scenarioId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    renderScenarioTable(list);
    return list;
  }

  function renderScenarioTable(list) {
    const checked = (id) => (state.compareIds.includes(id) ? 'checked' : '');
    $('#scn-table').innerHTML = `
      <thead><tr><th>Cmp</th><th>Name</th><th>Updated</th><th></th></tr></thead><tbody>
      ${list.map((s) => `
        <tr>
          <td><input type="checkbox" data-compare="${s.id}" ${checked(s.id)}></td>
          <td>${escapeHtml(s.name)}</td>
          <td>${(s.updatedAt || '').slice(0, 16).replace('T', ' ')}</td>
          <td class="scenario-row">
            <button data-load="${s.id}">Load</button>
            <button data-dup="${s.id}">Duplicate</button>
            <button data-del="${s.id}" class="danger">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="4">No saved scenarios yet.</td></tr>'}
      </tbody>`;
  }

  async function loadScenario(sid) {
    const s = await api('/api/scenarios/' + sid);
    state.inputs = E.normalizeInputs(s.inputs);
    state.scenarioId = s.id;
    $('#scenario-name').value = s.name;
    syncForm();
    recalc();
    saveDraft();
    await loadComps();
    await refreshScenarioList();
    await refreshPropertyLocations();
    toast(`Loaded "${s.name}"`);
    return s;
  }

  $('#scn-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.load) {
        await loadScenario(btn.dataset.load);
      } else if (btn.dataset.dup) {
        await api(`/api/scenarios/${btn.dataset.dup}/duplicate`, { method: 'POST', body: '{}' });
        await refreshScenarioList();
        toast('Scenario duplicated');
      } else if (btn.dataset.del) {
        if (!confirm('Delete this scenario?')) return;
        await api('/api/scenarios/' + btn.dataset.del, { method: 'DELETE' });
        if (state.scenarioId === Number(btn.dataset.del)) state.scenarioId = null;
        await refreshScenarioList();
        toast('Scenario deleted');
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#scn-table').addEventListener('change', (ev) => {
    const cb = ev.target.closest('input[data-compare]');
    if (!cb) return;
    const id = Number(cb.dataset.compare);
    if (cb.checked) {
      if (state.compareIds.length >= 3) { cb.checked = false; toast('Compare up to 3 scenarios'); return; }
      state.compareIds.push(id);
    } else {
      state.compareIds = state.compareIds.filter((x) => x !== id);
    }
    refreshCompare();
  });

  // ------------------------------------------------------------------
  // BA Workspace (visible only to role=ba)
  // ------------------------------------------------------------------

  let wsCache = { clients: [], presentations: [] };

  async function refreshWorkspace() {
    if (!state.currentUser || state.currentUser.role !== 'ba') return;
    try {
      const [clients, presentations] = await Promise.all([
        api('/api/clients'), api('/api/presentations')]);
      wsCache = { clients, presentations };
      renderWorkspace();
      refreshBranding();
    } catch (err) { toast('Workspace: ' + err.message); }
  }

  function renderWorkspace() {
    const { clients, presentations } = wsCache;

    $('#ws-clients').innerHTML = `
      <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Proposals</th><th>Status</th></tr></thead><tbody>
      ${clients.map((c) => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.email)}</td>
          <td>${escapeHtml(c.phone || '—')}</td>
          <td>${c.presentations}</td>
          <td>${c.status}</td>
        </tr>`).join('') || '<tr><td colspan="5">No clients yet — add one above.</td></tr>'}
      </tbody>`;

    const scenarios = state.scenarioList || [];
    $('#ws-scenario').innerHTML = scenarios.length
      ? scenarios.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')
      : '<option value="">— save a scenario first —</option>';
    $('#ws-client').innerHTML = clients.length
      ? clients.map((c) => `<option value="${c.email}" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)} — ${escapeHtml(c.email)}</option>`).join('')
      : '<option value="">— add a client first —</option>';

    $('#ws-presentations').innerHTML = `
      <thead><tr><th>Title</th><th>Client</th><th>Status</th><th>Last activity</th><th>Comments</th><th></th></tr></thead><tbody>
      ${presentations.map((p) => `
        <tr>
          <td>${escapeHtml(p.title)}</td>
          <td>${escapeHtml(p.clientName)}</td>
          <td>${p.status === 'active' ? 'active' : p.status}</td>
          <td>${(p.lastActivity || p.updatedAt || '').slice(0, 16).replace('T', ' ')}</td>
          <td>${p.commentCount}</td>
          <td class="scenario-row">
            <button data-ws-activity="${p.id}">Activity</button>
            <button data-ws-rotate="${p.id}" ${p.status !== 'active' ? 'disabled' : ''}>New link</button>
            <button data-ws-revoke="${p.id}" ${p.status !== 'active' ? 'disabled' : ''} class="danger">Revoke</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6">Nothing shared yet — create a link above.</td></tr>'}
      </tbody>`;
  }

  // Comparable rentals + buyer risk checklist (Area Report).
  function renderRentalTable() {
    const t = $('#rental-table');
    if (!t) return;
    const rentals = state.rentals || [];
    if (!rentals.length) {
      t.innerHTML = '<tr><td colspan="6">No rental comps yet — paste a few nearby listings above.</td></tr>';
      $('#rental-summary').textContent = '';
      return;
    }
    const sorted = rentals.map((r) => r.rentWeekly).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const yourRent = state.result.inputs.properties[0].weeklyRent;
    const gap = yourRent - median;
    $('#rental-summary').textContent =
      `${rentals.length} rentals · median $${fmtNum(median)}/wk · your $${fmtNum(yourRent)}/wk ` +
      `is ${gap >= 0 ? 'above' : 'below'} by $${fmtNum(Math.abs(gap))}/wk`;
    t.innerHTML = `
      <thead><tr><th>Address</th><th>Rent/wk</th><th>Beds</th><th>Type</th><th>Notes</th><th></th></tr></thead><tbody>
      ${rentals.map((r) => `<tr>
        <td>${escapeHtml(r.address || '—')}</td>
        <td>${fmtMoney(r.rentWeekly)}</td>
        <td>${r.bedrooms == null ? '—' : r.bedrooms}</td>
        <td>${escapeHtml(r.propertyType || '')}</td>
        <td>${escapeHtml(r.notes || '')}</td>
        <td class="scenario-row"><button data-rental-del="${r.id}" class="danger">Delete</button></td>
      </tr>`).join('')}
      </tbody>`;
  }

  function renderRiskChecklist() {
    const box = $('#risk-list');
    if (!box) return;
    const { checks } = E.riskChecklist(state.inputs, currentSuburb());
    const icon = { ok: '✓', warn: '⚠', unknown: '·' };
    box.innerHTML = checks.map((c) => `
      <div class="risk-row risk-${c.status}">
        <span class="risk-icon">${icon[c.status] || '·'}</span>
        <span class="risk-label">${escapeHtml(c.label)}</span>
        <span class="risk-detail">${escapeHtml(c.detail)}</span>
      </div>`).join('');
  }

  $('#btn-add-rental').addEventListener('click', async () => {
    if (!state.scenarioId) { toast('Save the scenario first'); return; }
    try {
      await api(`/api/scenarios/${state.scenarioId}/rentals`, {
        method: 'POST',
        body: {
          address: $('#rental-address').value.trim(),
          rentWeekly: Number($('#rental-rent').value || 0),
          bedrooms: $('#rental-beds').value === '' ? null : Number($('#rental-beds').value),
          propertyType: $('#rental-type').value,
          notes: $('#rental-notes').value.trim(),
        },
      });
      $('#rental-address').value = ''; $('#rental-rent').value = '';
      $('#rental-beds').value = ''; $('#rental-notes').value = '';
      await loadComps();
      toast('Rental comp added');
    } catch (err) { toast('Error: ' + saveErrorText(err)); }
  });

  $('#rental-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-rental-del]');
    if (!btn) return;
    if (!confirm('Delete this rental comp?')) return;
    try {
      await api('/api/rentals/' + btn.dataset.rentalDel, { method: 'DELETE' });
      await loadComps();
      toast('Rental comp deleted');
    } catch (err) { toast('Error: ' + err.message); }
  });

  let lastShare = { pid: null, token: null };

  function showShareLink(pid, token) {
    lastShare = { pid, token };
    const url = location.origin + '/p/' + token;
    $('#ws-new-link').classList.remove('hidden');
    $('#ws-link').value = url;
    const client = wsCache.clients.find((c) => c.email === $('#ws-client').value);
    if (client) $('#ws-email').value = client.email;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    toast('Share link created and copied');
  }

  $('#ws-email-send').addEventListener('click', async () => {
    if (!lastShare.pid || !lastShare.token) return;
    try {
      const d = await api(`/api/presentations/${lastShare.pid}/email`, {
        method: 'POST',
        body: { shareToken: lastShare.token, email: $('#ws-email').value.trim() },
      });
      $('#ws-email-msg').textContent = d.sent
        ? `Sent to ${d.emailedTo}`
        : 'SMTP not configured on this server — link logged, copy it above instead';
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-add-client').addEventListener('click', async () => {
    try {
      await api('/api/clients', {
        method: 'POST',
        body: {
          email: $('#ws-client-email').value.trim(),
          name: $('#ws-client-name').value.trim(),
          phone: $('#ws-client-phone').value.trim(),
        },
      });
      $('#ws-client-email').value = ''; $('#ws-client-name').value = ''; $('#ws-client-phone').value = '';
      await refreshWorkspace();
      toast('Client added');
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-create').addEventListener('click', async () => {
    const scenarioId = Number($('#ws-scenario').value);
    const clientEmail = $('#ws-client').value;
    if (!scenarioId || !clientEmail) { toast('Save a scenario and add a client first'); return; }
    try {
      const client = wsCache.clients.find((c) => c.email === clientEmail);
      const d = await api('/api/presentations', {
        method: 'POST',
        body: {
          scenarioId,
          clientEmail,
          clientName: client ? client.name : '',
          title: $('#ws-title').value.trim() || undefined,
          expiresInDays: Number($('#ws-expiry').value || 30),
        },
      });
      showShareLink(d.id, d.shareToken);
      await refreshWorkspace();
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-presentations').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.wsActivity) {
        const d = await api('/api/presentations/' + btn.dataset.wsActivity);
        $('#ws-activity-box').classList.remove('hidden');
        $('#ws-activity-title').textContent = 'Activity — ' + d.title;
        const who = (e) => e.email === state.currentUser.email ? 'you' : (e.display_name || e.email || '').split('@')[0];
        $('#ws-events').innerHTML = d.events.map((e) => `
          <span class="k">${(e.created_at || '').slice(0, 16).replace('T', ' ')} · ${who(e)} · ${e.type}</span>
          <span class="v">${escapeHtml(e.body || '')}</span>`).join('')
          || '<span class="k">no activity yet</span><span class="v"></span>';
      } else if (btn.dataset.wsRotate) {
        if (!confirm('Generate a new link? The old one stops working.')) return;
        const d = await api(`/api/presentations/${btn.dataset.wsRotate}/rotate`, { method: 'POST', body: '{}' });
        showShareLink(d.id, d.shareToken);
        await refreshWorkspace();
      } else if (btn.dataset.wsRevoke) {
        if (!confirm('Revoke this share link? The client loses access immediately.')) return;
        await api(`/api/presentations/${btn.dataset.wsRevoke}/revoke`, { method: 'POST', body: '{}' });
        await refreshWorkspace();
        toast('Link revoked');
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  // ------------------------------------------------------------------
  // Portfolio actuals — real numbers vs the projection
  // ------------------------------------------------------------------

  let actualsCache = [];

  function renderActuals() {
    if (!state.scenarioId) {
      $('#actuals-hint').textContent = 'Save the scenario first — actuals attach to a named scenario.';
      $('#actuals-table').innerHTML = '';
      $('#act-property').innerHTML = '';
      return;
    }
    $('#actuals-hint').textContent = 'What actually happened each period. Saving the same period + property again updates it.';
    const props = state.result.inputs.properties;
    $('#act-property').innerHTML = props.map((p, i) =>
      `<option value="${i}">${escapeHtml(p.label || 'Investment property ' + (i + 1))}</option>`).join('');
    loadActuals();
  }

  async function loadActuals() {
    if (!state.scenarioId) return;
    try {
      actualsCache = await api(`/api/scenarios/${state.scenarioId}/actuals`);
      renderActualsTable();
    } catch (err) { toast('Actuals: ' + err.message); }
  }

  function renderActualsTable() {
    if (!actualsCache.length) {
      $('#actuals-table').innerHTML = '<tr><td>No periods recorded yet — save one above.</td></tr>';
      return;
    }
    const fmt = (v) => (v === null || v === undefined) ? '—' : fmtMoney(v);
    const delta = (a, p) => (a === null || p === null || p === undefined) ? '—' : signed(a - p);
    $('#actuals-table').innerHTML = `
      <thead><tr>
        <th>Property</th><th>Period</th><th>Rent actual</th><th>Rent proj.</th><th>Δ rent</th>
        <th>Exp. actual</th><th>Exp. proj.</th><th>Δ exp</th>
        <th>Loan actual</th><th>Loan proj.</th><th>Value actual</th><th>Value proj.</th><th></th>
      </tr></thead><tbody>
      ${actualsCache.map((r) => {
        const p = state.result.properties[r.propertyIndex];
        const proj = p && p.rows.find((row) => row.calendarYear === Number(r.periodStart.slice(0, 4)));
        const label = (state.result.inputs.properties[r.propertyIndex] || {}).label
          || `IP ${r.propertyIndex + 1}`;
        return `<tr>
          <td>${escapeHtml(label)}</td>
          <td>${r.periodStart} → ${r.periodEnd}</td>
          <td>${fmt(r.rentReceived)}</td>
          <td>${proj ? fmt(proj.grossRent) : '—'}</td>
          <td>${proj ? delta(r.rentReceived, proj.grossRent) : '—'}</td>
          <td>${fmt(r.expenses)}</td>
          <td>${proj ? fmt(proj.operatingExpenses) : '—'}</td>
          <td>${proj ? delta(r.expenses, proj.operatingExpenses) : '—'}</td>
          <td>${fmt(r.loanBalance)}</td>
          <td>${proj ? fmt(proj.ipLoanClosingBalance) : '—'}</td>
          <td>${fmt(r.valuation)}</td>
          <td>${proj ? fmt(proj.propertyValue) : '—'}</td>
          <td class="scenario-row"><button data-act-del="${r.id}" class="danger">Delete</button></td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  $('#act-save').addEventListener('click', async () => {
    if (!state.scenarioId) { toast('Save the scenario first'); return; }
    const opt = (v) => v === '' ? null : Number(v);
    try {
      await api(`/api/scenarios/${state.scenarioId}/actuals`, {
        method: 'POST',
        body: {
          propertyIndex: Number($('#act-property').value || 0),
          periodStart: $('#act-start').value,
          periodEnd: $('#act-end').value,
          rentReceived: Number($('#act-rent').value || 0),
          expenses: Number($('#act-expenses').value || 0),
          loanBalance: opt($('#act-loan').value),
          valuation: opt($('#act-value').value),
          notes: $('#act-notes').value.trim(),
        },
      });
      await loadActuals();
      toast('Period saved');
    } catch (err) {
      toast('Error: ' + saveErrorText(err));
    }
  });

  $('#actuals-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act-del]');
    if (!btn) return;
    if (!confirm('Delete this period?')) return;
    try {
      await api('/api/actuals/' + btn.dataset.actDel, { method: 'DELETE' });
      await loadActuals();
      toast('Period deleted');
    } catch (err) { toast('Error: ' + err.message); }
  });

  // ------------------------------------------------------------------
  // BA branding + plan
  // ------------------------------------------------------------------

  async function refreshBranding() {
    try {
      const [b, me] = await Promise.all([api('/api/branding'), api('/api/auth/me')]);
      $('#ws-brand-name').value = b.businessName || '';
      $('#ws-brand-color').value = b.accentColor || '#6366f1';
      $('#ws-brand-tagline').value = b.tagline || '';
      $('#ws-plan').textContent = me.plan || 'trial';
      $('#ws-upgrade').classList.toggle('hidden', me.plan === 'pro');
    } catch (err) { /* branding is optional UI — silent */ }
  }

  $('#ws-save-branding').addEventListener('click', async () => {
    try {
      await api('/api/branding', {
        method: 'PUT',
        body: {
          businessName: $('#ws-brand-name').value.trim(),
          accentColor: $('#ws-brand-color').value,
          tagline: $('#ws-brand-tagline').value.trim(),
        },
      });
      toast('Branding saved — clients see it on their portal');
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-upgrade').addEventListener('click', async () => {
    try {
      const d = await api('/api/billing/plan', { method: 'POST', body: { plan: 'pro' } });
      $('#ws-plan').textContent = d.plan;
      $('#ws-upgrade').classList.add('hidden');
      $('#ws-plan-msg').textContent = 'Pro active';
      toast('Upgraded to Pro');
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-logo-upload').addEventListener('click', async () => {
    const f = $('#ws-brand-logo').files[0];
    if (!f) { toast('Choose a PNG or JPG first'); return; }
    const fd = new FormData();
    fd.append('file', f);
    try {
      const resp = await fetch('/api/branding/logo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      const body = await resp.json();
      if (!body.ok) throw new Error(body.error || 'upload failed');
      $('#ws-logo-msg').textContent = 'Logo uploaded — clients see it on their portal';
      toast('Logo uploaded');
    } catch (err) {
      $('#ws-logo-msg').textContent = err.message;
      toast('Error: ' + err.message);
    }
  });

  async function refreshCompare() {
    state.compareData = [];
    for (const id of state.compareIds) {
      try {
        const s = await api('/api/scenarios/' + id);
        state.compareData.push({ name: s.name, result: E.calculateAll(s.inputs) });
      } catch (err) { console.error(err); }
    }
    renderCompare();
  }

  function renderCompare() {
    const data = state.compareData;
    if (!data.length) {
      $('#compare-table').innerHTML = '<tr><td>Tick scenarios above to compare side by side.</td></tr>';
      ['chart-cmp-equity', 'chart-cmp-oop', 'chart-cmp-value'].forEach((id) => {
        const canvas = document.getElementById(id);
        const box = canvas && canvas.closest('.chart-box');
        if (box) box.classList.add('is-empty');
        drawChart(id, { type: 'bar', data: { labels: [], datasets: [] } });
      });
      return;
    }
    ['chart-cmp-equity', 'chart-cmp-oop', 'chart-cmp-value'].forEach((id) => {
      const canvas = document.getElementById(id);
      const box = canvas && canvas.closest('.chart-box');
      if (box) box.classList.remove('is-empty');
    });
    const rows = [
      ['Purchase price', (r) => fmtMoney(r.metrics.purchasePrice)],
      ['Transfer duty', (r) => fmtMoney(r.metrics.transferDuty)],
      ['Cash required upfront', (r) => fmtMoney(r.metrics.initialCashInvested)],
      ['IP loan / LVR', (r) => `${fmtMoney(r.metrics.ipLoanAmount)} @ ${fmtPct(r.metrics.ipLvrActual, 0)}`],
      ['Gross yield', (r) => fmtPct(r.metrics.grossYield)],
      ['Net yield', (r) => fmtPct(r.metrics.netYield)],
      ['Weekly out-of-pocket (yr 1)', (r) => fmtMoney(Math.max(0, r.metrics.weeklyOutOfPocket))],
      ['Tax refund yr 1', (r) => fmtMoney(r.metrics.year1TaxRefund)],
      ['10-year equity', (r) => fmtMoney(r.metrics.tenYearEquity)],
      [`Sale-year net proceeds`, (r) => fmtMoney(r.metrics.netSaleProceeds)],
      ['Total net position', (r) => fmtMoney(r.metrics.totalNetPosition)],
      ['IRR (approx.)', (r) => (r.metrics.irrApproximation === null ? 'n/a' : fmtPct(r.metrics.irrApproximation, 1))],
    ];
    const head = '<tr><th>Metric</th>' + data.map((d) => `<th>${escapeHtml(d.name)}</th>`).join('') + '</tr>';
    $('#compare-table').innerHTML = `<thead>${head}</thead><tbody>` +
      rows.map(([label, fn]) => `<tr><td>${label}</td>${data.map((d) => `<td>${fn(d.result)}</td>`).join('')}</tr>`).join('') +
      '</tbody>';

    const names = data.map((d) => d.name);
    const palette = [COLORS.pri, COLORS.amber, COLORS.teal];
    drawChart('chart-cmp-equity', {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{ label: '10-year equity', data: data.map((d) => d.result.metrics.tenYearEquity), backgroundColor: palette }],
      },
      options: baseOpts(),
    });
    drawChart('chart-cmp-oop', {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{ label: 'Weekly out-of-pocket', data: data.map((d) => Math.max(0, d.result.metrics.weeklyOutOfPocket)), backgroundColor: palette }],
      },
      options: baseOpts(),
    });
    const maxYears = Math.max(...data.map((d) => d.result.rows.length));
    drawChart('chart-cmp-value', {
      type: 'line',
      data: {
        labels: Array.from({ length: maxYears }, (_, i) => 'Y' + (i + 1)),
        datasets: data.map((d, i) => ({
          label: d.name,
          data: d.result.rows.map((r) => r.propertyValue),
          borderColor: palette[i % 3], tension: 0.15, pointRadius: 0,
        })),
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Topbar actions
  // ------------------------------------------------------------------

  $('#btn-save').addEventListener('click', async () => {
    const name = ($('#scenario-name').value || '').trim() || 'Untitled scenario';
    try {
      if (state.scenarioId) {
        await api('/api/scenarios/' + state.scenarioId, {
          method: 'PUT',
          body: JSON.stringify({ name, inputs: state.inputs }),
        });
        toast('Scenario updated');
      } else {
        const s = await api('/api/scenarios', {
          method: 'POST',
          body: JSON.stringify({ name, inputs: state.inputs }),
        });
        state.scenarioId = s.id;
        toast('Scenario saved');
      }
      saveDraft();
      await refreshScenarioList();
      await loadComps();
    } catch (err) { toast('Save failed: ' + saveErrorText(err)); }
  });

  $('#btn-save-as').addEventListener('click', async () => {
    const base = ($('#scenario-name').value || 'Untitled').trim();
    const name = prompt('New scenario name:', base + ' (variant)');
    if (!name) return;
    try {
      const s = await api('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify({ name, inputs: state.inputs }),
      });
      state.scenarioId = s.id;
      $('#scenario-name').value = name;
      saveDraft();
      await refreshScenarioList();
      toast('Saved as new scenario');
    } catch (err) { toast('Save failed: ' + saveErrorText(err)); }
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Reset all inputs to defaults?')) return;
    state.inputs = E.normalizeInputs({});
    state.scenarioId = null;
    state.inputTab = 0;
    state.viewProp = -1;
    $('#scenario-name').value = state.inputs.scenarioName;
    $('#scenario-select').value = '';
    syncForm();
    recalc();
    setActiveTab(0);
    saveDraft();
    toast('Reset to defaults');
  });

  $('#scenario-select').addEventListener('change', async (ev) => {
    const id = ev.target.value;
    if (!id) return;
    try {
      const s = await api('/api/scenarios/' + id);
      state.inputs = E.normalizeInputs(s.inputs);
      state.scenarioId = s.id;
      state.inputTab = 0;
      state.viewProp = -1;
      $('#scenario-name').value = s.name;
      syncForm();
      recalc();
      setActiveTab(0);
      saveDraft();
      await loadComps();
    } catch (err) { toast('Load failed: ' + err.message); }
  });

  $('#cf-year').addEventListener('change', (ev) => {
    state.cfYear = Number(ev.target.value);
    renderCashFlow();
  });

  ['#cf-prop', '#proj-prop', '#exit-prop'].forEach((id) => {
    const sel = $(id);
    if (sel) sel.addEventListener('change', (ev) => onViewSelectChange(ev.target.value));
  });

  // ------------------------------------------------------------------
  // Misc
  // ------------------------------------------------------------------

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ------------------------------------------------------------------
  // UI preferences: theme + text scale (persisted)
  // ------------------------------------------------------------------

  const UI_KEY = 'pa_ui';
  const SCALE_STEPS = [0.85, 1, 1.15, 1.3];

  function loadUiPrefs() {
    try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function applyUiPrefs() {
    const p = loadUiPrefs();
    document.documentElement.dataset.theme = p.theme === 'dark' ? 'dark' : 'light';
    const scale = SCALE_STEPS.includes(p.scale) ? p.scale : 1;
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    const label = $('#scale-label');
    if (label) label.textContent = Math.round(scale * 100) + '%';
  }

  function saveUiPref(key, value) {
    const p = loadUiPrefs();
    p[key] = value;
    localStorage.setItem(UI_KEY, JSON.stringify(p));
  }

  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    saveUiPref('theme', next);
    applyUiPrefs();
    recalc(); // redraw charts so grid/tick colours follow the theme
  });

  function stepScale(dir) {
    const p = loadUiPrefs();
    const cur = SCALE_STEPS.includes(p.scale) ? p.scale : 1;
    const idx = Math.min(SCALE_STEPS.length - 1, Math.max(0, SCALE_STEPS.indexOf(cur) + dir));
    saveUiPref('scale', SCALE_STEPS[idx]);
    applyUiPrefs();
  }
  $('#btn-scale-up').addEventListener('click', () => stepScale(1));
  $('#btn-scale-down').addEventListener('click', () => stepScale(-1));

  applyUiPrefs();

  // ------------------------------------------------------------------
  // Auth session
  // ------------------------------------------------------------------

  function setCurrentUser(u) {
    state.currentUser = u;
    $('#user-chip').classList.toggle('hidden', !u);
    $('#user-avatar').classList.toggle('hidden', !u);
    $('#btn-logout').classList.toggle('hidden', !u);
    if (u) {
      $('#user-chip').textContent = u.displayName;
      $('#user-avatar').textContent = (u.displayName || u.email || '?').trim().charAt(0).toUpperCase();
      const dashUser = $('#dash-user');
      if (dashUser) dashUser.textContent = u.displayName || u.email;
    }
    $('#nav-workspace').classList.toggle('hidden', !(u && u.role === 'ba'));
    // Clients never see the analyzer — their home is the portal.
    if (u && u.role === 'client') {
      location.href = '/portal';
      return;
    }
  }

  function showLogin(msg) {
    $('#login-overlay').classList.remove('hidden');
    const err = $('#auth-error');
    err.classList.toggle('hidden', !msg);
    if (msg) err.textContent = msg;
  }

  function hideLogin() {
    $('#login-overlay').classList.add('hidden');
    $('#auth-error').classList.add('hidden');
    $('#auth-password').value = '';
  }

  // Load the user's draft, reopen the scenario they last worked on, and
  // refresh everything on screen.
  async function initUserSession() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(draftKey()));
      if (!saved && localStorage.getItem(LEGACY_DRAFT_KEY)) {
        saved = JSON.parse(localStorage.getItem(LEGACY_DRAFT_KEY));
        localStorage.removeItem(LEGACY_DRAFT_KEY);
      }
    } catch (e) { /* corrupted draft — start fresh */ }

    // Draft v2/v3 wrap inputs with bookkeeping; older drafts are bare objects.
    let draftInputs = saved, draftAt = 0, draftSid = null;
    if (saved && typeof saved === 'object' && (saved.v === 2 || saved.v === 3)) {
      draftInputs = saved.inputs;
      draftAt = saved.savedAt || 0;
      draftSid = saved.scenarioId || null;
    }

    state.inputs = E.normalizeInputs(draftInputs && typeof draftInputs === 'object' ? draftInputs : {});
    state.scenarioId = null;
    state.compareIds = [];
    state.compareData = [];
    $('#scenario-name').value = state.inputs.scenarioName;
    $('#scenario-select').value = '';
    syncForm();
    recalc();
    setActiveTab(Number.isInteger(state.inputTab)
      && state.inputTab < state.inputs.properties.length ? state.inputTab : 0);
    await loadAreaData().catch(() => {});

    if (draftSid) {
      try {
        const s = await api('/api/scenarios/' + draftSid);
        state.scenarioId = s.id;
        $('#scenario-name').value = s.name;
        if (Date.parse(s.updatedAt || '') > draftAt) {
          // Another device saved newer edits — show the server copy.
          state.inputs = E.normalizeInputs(s.inputs);
          syncForm();
          recalc();
        }
      } catch (err) { /* scenario deleted elsewhere — stay in draft */ }
    }
    await loadComps();
    await refreshScenarioList().catch(() => toast('Could not reach scenario API'));
    await refreshPropertyLocations();
  }

  async function doAuth(endpoint) {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    try {
      const resp = await fetch('/api/auth/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, password,
          role: document.querySelector('#auth-ba') && $('#auth-ba').checked ? 'ba' : undefined,
        }),
      });
      const body = await resp.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (!body.ok) throw new Error(body.error || 'failed');
      setToken(body.data.token);
      setCurrentUser(body.data);
      hideLogin();
      await initUserSession();
      loadDashboard().then(() => startTour());
      toast(`Signed in as ${body.data.displayName}`);
    } catch (err) {
      showLogin(err.message);
    }
  }

  function doLogout() {
    setToken(null);
    setCurrentUser(null);
    state.scenarioId = null;
    showLogin('Signed out');
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  function boot() {
    setupAppShell();
    wireCommandPalette();
    bindInputs();
    bindMaskToggles();
    wireDashboard();
    wireAnnouncement();
    wireTour();

    $('#btn-login').addEventListener('click', () => doAuth('login'));
    $('#btn-register').addEventListener('click', () => doAuth('register'));
    $('#btn-logout').addEventListener('click', doLogout);
    $('#auth-password').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') doAuth('login');
    });

    if (!getToken()) {
      // Client sessions live in the portal, not the analyzer.
      if (localStorage.getItem('pa_portal_token')) {
        location.href = '/portal';
        return;
      }
      showLogin();
      return;
    }
    // Existing token: verify it still names a live user before loading data.
    api('/api/auth/me')
      .then(async (me) => {
        setCurrentUser(me);
        hideLogin();
        await initUserSession();
        loadDashboard().then(() => startTour());
      })
      .catch(() => { /* 401 path already surfaced the login screen */ });
  }

  boot();
})();
