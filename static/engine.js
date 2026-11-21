/* Copyright (c) 2026 RV
 *
 * Property Analyser — calculation engine.
 *
 * Pure functions only: no DOM, no fetch, no mutable globals. The same file
 * runs in the browser (window.PropertyAnalyserEngine) and under Node for
 * the test suite (module.exports).
 *
 * All money values are AUD. Years are 1-based holding years (year 1 =
 * first year after settlement). Percentages are stored as decimals.
 * Full precision is kept internally; rounding happens only in the UI.
 *
 * ---------------------------------------------------------------------
 * Rate tables baked in here (labels shown in the UI):
 *
 * QLD transfer duty — QRO standard rates, investors get no home concession.
 *   https://qro.qld.gov.au/duties/transfer-duty/calculate/rates
 * QLD land tax (individuals) — aggregate Australia-wide land holdings.
 *   https://qro.qld.gov.au/land-tax/calculate/individual
 * NSW transfer duty — Revenue NSW sliding scale, 2026-27 rate year
 *   (exact per-$100, $20 minimum; first-home concessions not applied).
 *   https://www.revenue.nsw.gov.au/taxes-duties-levies-royalties/transfer-duty/understanding-transfer-duty/calculate-transfer-duty
 * NSW land tax — 2026 land tax year: $1,075,000 general / $6,571,000
 *   premium threshold (frozen); joint owners share one threshold.
 *   https://www.revenue.nsw.gov.au/taxes-duties-levies-royalties/land-tax/understanding-land-tax/thresholds-and-rates
 * VIC transfer duty — SRO general scale (non-PPR), since 1 Jul 2021.
 *   https://www.sro.vic.gov.au/about-us/rates-and-statistics/current-rates/land-transfer-duty-non-principal-place-residence-current-rates
 * VIC land tax — 2026 land tax year, SRO general scale ($50k threshold).
 *   https://www.sro.vic.gov.au/about-us/rates-and-statistics/current-rates/land-tax-current-rates
 * Income tax 2026-27 — ATO resident rates + 2% Medicare levy.
 *   https://www.ato.gov.au/about-ato/new-legislation/in-detail/individuals/
 * LMI premium bands — Helia-style public estimator, lender-specific in
 *   reality; every output using it is labelled an estimate.
 *
 * CGT note: a 2026 reform bill proposes changes from 1 July 2027 (50%
 * discount -> indexation, negative gearing limits) with grandfathering.
 * This engine implements the CURRENT law (50% discount); the UI shows a
 * standing warning on the Exit section. Verify with a tax adviser.
 * ---------------------------------------------------------------------
 */

(function (global) {
  'use strict';

  // =====================================================================
  // Rate tables
  // =====================================================================

  const RATE_LABELS = {
    duty: 'QLD transfer duty — QRO standard rates (checked Nov 2026)',
    landTax: 'QLD land tax — individuals, AU-wide aggregation (checked Nov 2026)',
    incomeTax: 'ATO resident rates 2026-27 + 2% Medicare levy',
    lmi: 'LMI premium estimate — Helia-style bands (lender-specific)',
  };

  // Each band: duty = base + (value - from) rate, "per $100 or part".
  const QLD_DUTY_BANDS = [
    { from: 0, to: 5000, base: 0, rate: 0, per: 100 },
    { from: 5000, to: 75000, base: 0, rate: 0.015, per: 100 },
    { from: 75000, to: 540000, base: 1050, rate: 0.035, per: 100 },
    { from: 540000, to: 1000000, base: 17325, rate: 0.045, per: 100 },
    { from: 1000000, to: Infinity, base: 38025, rate: 0.0575, per: 100 },
  ];

  // QLD land tax, individuals. Aggregate Australia-wide holdings.
  const QLD_LAND_TAX_BANDS = [
    { from: 600000, to: 1000000, base: 500, rate: 0.01 },
    { from: 1000000, to: 3000000, base: 4500, rate: 0.0165 },
    { from: 3000000, to: 5000000, base: 37500, rate: 0.0125 },
    { from: 5000000, to: 10000000, base: 62500, rate: 0.0175 },
    { from: 10000000, to: Infinity, base: 150000, rate: 0.0225 },
  ];

  // NSW transfer duty — Revenue NSW sliding scale, 2026-27 rate year
  // (page updated Oct 2026). Exact pro-rata per $100 (no round-up), $20
  // minimum. General scale; first-home concessions NOT applied (investor).
  const NSW_DUTY_BANDS = [
    { from: 0, to: 18000, base: 0, rate: 0.0125, per: 100 },
    { from: 18000, to: 38000, base: 225, rate: 0.015, per: 100 },
    { from: 38000, to: 103000, base: 525, rate: 0.0175, per: 100 },
    { from: 103000, to: 387000, base: 1662, rate: 0.035, per: 100 },
    { from: 387000, to: 1290000, base: 11602, rate: 0.045, per: 100 },
    { from: 1290000, to: 3870000, base: 52237, rate: 0.055, per: 100 },
    { from: 3870000, to: Infinity, base: 194137, rate: 0.07, per: 100 },
  ];

  // NSW land tax — 2026 land tax year (thresholds frozen). Individuals get
  // ONE threshold for jointly owned land, so a single assessment on the
  // aggregate is exact, not an approximation like QLD's 50/50 split.
  const NSW_LAND_TAX = {
    general: 1075000,
    premium: 6571000,
    base: 100,
    rate: 0.016,
    premiumBase: 88036,   // 100 + 1.6% x (premium - general)
    premiumRate: 0.02,
  };

  // VIC land transfer duty — SRO general scale (non-PPR, since 1 Jul 2021),
  // exact percent-based. Foreign-buyer surcharge NOT applied.
  // Note the jump at $960,000: 5.5% of the WHOLE value from there up.
  const VIC_DUTY_SCALE = [
    { max: 25000 },                     // 1.4% of value
    { max: 130000, base: 350, rate: 0.024, over: 25000 },
    { max: 960000, base: 2870, rate: 0.06, over: 130000 },
    { max: 2000000, flat: 0.055 },      // 5.5% of the whole value
    { max: Infinity, base: 110000, rate: 0.065, over: 2000000 },
  ];

  // VIC land tax — 2026 land tax year (SRO general scale, applies 2024-2033).
  const VIC_LAND_TAX_BANDS = [
    { from: 50000, to: 100000, tax: 500 },
    { from: 100000, to: 300000, tax: 975 },
    { from: 300000, to: 600000, base: 1350, rate: 0.003 },
    { from: 600000, to: 1000000, base: 2250, rate: 0.006 },
    { from: 1000000, to: 1800000, base: 4650, rate: 0.009 },
    { from: 1800000, to: 3000000, base: 11850, rate: 0.0165 },
    { from: 3000000, to: Infinity, base: 31650, rate: 0.0265 },
  ];

  // SA stamp duty — Revenue SA general scale ("per $100 or part").
  const SA_DUTY_BANDS = [
    { from: 0, to: 12000, base: 0, rate: 0.01, per: 100 },
    { from: 12000, to: 30000, base: 120, rate: 0.02, per: 100 },
    { from: 30000, to: 50000, base: 480, rate: 0.03, per: 100 },
    { from: 50000, to: 100000, base: 1080, rate: 0.035, per: 100 },
    { from: 100000, to: 200000, base: 2830, rate: 0.04, per: 100 },
    { from: 200000, to: 250000, base: 6830, rate: 0.0425, per: 100 },
    { from: 250000, to: 300000, base: 8955, rate: 0.0475, per: 100 },
    { from: 300000, to: 500000, base: 11330, rate: 0.05, per: 100 },
    { from: 500000, to: Infinity, base: 21330, rate: 0.055, per: 100 },
  ];

  // SA land tax — 2026-27 general scale ("per $100 or part"), $936,000
  // threshold; assessments under $20 are not issued.
  const SA_LAND_TAX_BANDS = [
    { from: 936000, to: 1504000, base: 0, rate: 0.005, per: 100 },
    { from: 1504000, to: 2188000, base: 2840, rate: 0.01, per: 100 },
    { from: 2188000, to: 3504000, base: 9680, rate: 0.02, per: 100 },
    { from: 3504000, to: Infinity, base: 36000, rate: 0.024, per: 100 },
  ];

  // WA transfer duty — general scale (wa.gov.au, updated Jul 2026).
  const WA_DUTY_BANDS = [
    { from: 0, to: 120000, base: 0, rate: 0.019, per: 100 },
    { from: 120000, to: 150000, base: 2280, rate: 0.0285, per: 100 },
    { from: 150000, to: 360000, base: 3135, rate: 0.038, per: 100 },
    { from: 360000, to: 725000, base: 11115, rate: 0.0475, per: 100 },
    { from: 725000, to: Infinity, base: 28453, rate: 0.0515, per: 100 },
  ];

  // WA land tax — 2026-27 marginal scale, $300,000 threshold. The MRIT
  // (Perth metro, 0.14%) is NOT modelled.
  const WA_LAND_TAX_BANDS = [
    { from: 300000, to: 420000, base: 300, rate: 0 },
    { from: 420000, to: 1000000, base: 300, rate: 0.0025 },
    { from: 1000000, to: 1800000, base: 1750, rate: 0.009 },
    { from: 1800000, to: 5000000, base: 8950, rate: 0.018 },
    { from: 5000000, to: 11000000, base: 66550, rate: 0.02 },
    { from: 11000000, to: Infinity, base: 186550, rate: 0.0267 },
  ];

  // TAS property transfer duty — SRO Tasmania general scale (since
  // 21 Oct 2013; "per $100 or part").
  const TAS_DUTY_BANDS = [
    { from: 0, to: 3000, base: 50, rate: 0, per: 100 },
    { from: 3000, to: 25000, base: 50, rate: 0.0175, per: 100 },
    { from: 25000, to: 75000, base: 435, rate: 0.0225, per: 100 },
    { from: 75000, to: 200000, base: 1560, rate: 0.035, per: 100 },
    { from: 200000, to: 375000, base: 5935, rate: 0.04, per: 100 },
    { from: 375000, to: 725000, base: 12935, rate: 0.0425, per: 100 },
    { from: 725000, to: Infinity, base: 27810, rate: 0.045, per: 100 },
  ];

  // TAS land tax — scale from 1 Jul 2025, $125,000 threshold.
  const TAS_LAND_TAX_BANDS = [
    { from: 125000, to: 500000, base: 50, rate: 0.0045 },
    { from: 500000, to: Infinity, base: 1737.5, rate: 0.015 },
  ];

  // ACT conveyance duty — investor scale ("not an eligible owner
  // occupier"), from 1 Jul 2025. The final band is a flat 4.54% of the
  // TOTAL value (a real quirk: it can dip just above $1,455,000).
  const ACT_DUTY_BANDS = [
    { from: 0, to: 200000, base: 0, rate: 0.012, per: 100 },
    { from: 200000, to: 300000, base: 2400, rate: 0.022, per: 100 },
    { from: 300000, to: 500000, base: 4600, rate: 0.034, per: 100 },
    { from: 500000, to: 750000, base: 11400, rate: 0.0432, per: 100 },
    { from: 750000, to: 1000000, base: 22200, rate: 0.059, per: 100 },
    { from: 1000000, to: 1455000, base: 36950, rate: 0.064, per: 100 },
  ];

  // ACT land tax — 2026-27: fixed charge PER PROPERTY + marginal
  // valuation charge on each property's AUV (assessed per property).
  const ACT_LAND_TAX_FIXED = 1778;
  const ACT_LAND_TAX_TIERS = [
    { from: 0, to: 150000, base: 0, rate: 0.0054 },
    { from: 150000, to: 275000, base: 810, rate: 0.0064 },
    { from: 275000, to: 1000000, base: 1610, rate: 0.0124 },
    { from: 1000000, to: 2000000, base: 10600, rate: 0.0125 },
    { from: 2000000, to: Infinity, base: 23100, rate: 0.0126 },
  ];

  const TAX_BRACKETS_2026_27 = [
    { from: 0, to: 18200, rate: 0 },
    { from: 18200, to: 45000, rate: 0.15 },
    { from: 45000, to: 135000, rate: 0.30 },
    { from: 135000, to: 190000, rate: 0.37 },
    { from: 190000, to: Infinity, rate: 0.45 },
  ];

  const MEDICARE_LEVY_RATE = 0.02;

  // Approximate LMI premium as % of loan by LVR band. Estimates only.
  const LMI_BANDS = [
    { maxLvr: 0.80, rate: 0 },
    { maxLvr: 0.85, rate: 0.0031 },
    { maxLvr: 0.90, rate: 0.0104 },
    { maxLvr: 0.95, rate: 0.0215 },
    { maxLvr: Infinity, rate: 0.0385 },
  ];

  // =====================================================================
  // Default inputs — realistic QLD house scenario, every field editable.
  // v3 shape: flat GLOBAL keys + `properties` array (1..MAX_PROPERTIES).
  // Legacy flat inputs (pre-portfolio drafts/scenarios) are migrated by
  // normalizeInputs: per-property keys become properties[0].
  // =====================================================================

  const MAX_PROPERTIES = 6;

  // Per-property inputs. All of these live inside `properties[i]`.
  const DEFAULT_PROPERTY = {
    label: '',                    // UI shows "Investment property N" when blank
    address: '',
    addressMeta: null,    // {domainId, unit, street, suburb, postcode, state} from a Domain autocomplete pick
    ownershipStatus: 'considering',  // considering | under_offer | purchased — only 'purchased' counts in portfolio roll-ups
    bedrooms: 3,          // used by the rentVsMedian score factor
    purchaseYear: 2026,
    saleYear: 20,

    // Property & purchase
    purchasePrice: 750000,
    landValue: 350000,
    propertyType: 'house',
    buildYear: 2026,
    isNewBuild: true,
    legalFees: 2500,
    buildingInspectionCost: 600,
    quantitySurveyorCost: 800,
    initialRepairs: 0,
    otherAcquisitionCosts: 0,
    sellingCostRate: 0.025,
    sellingFixedCosts: 1500,
    expectedCapitalGrowthRate: 0.06,
    landValueGrowthRate: 0.05,

    // Rent & operating expenses
    weeklyRent: 620,
    annualRentGrowthRate: 0.035,
    vacancyWeeksPerYear: 2,
    propertyManagementRate: 0.07,
    propertyManagementGSTIncluded: true,
    lettingFeeWeeks: 1,
    lettingFeeIntervalYears: 2,
    renewalFeePerYear: 0,
    councilRatesAnnual: 2400,
    waterRatesAnnual: 900,
    insuranceAnnual: 1800,
    bodyCorporateAnnual: 0,
    maintenanceRate: 0.01,
    otherAnnualExpenses: 0,
    otherDeductibleClaims: 0,     // extra NG claims: repairs, accountant fees, QS schedule top-ups

    // Investment property loan
    ipLvr: 0.80,
    ipLoanAmountOverride: 0,      // 0 = derive from purchasePrice x ipLvr
    ipInterestRate: 0.065,
    ipLoanTermYears: 30,
    ipRepaymentType: 'interest_only',
    ipInterestOnlyYears: 5,
    ipLoanSetupFee: 600,
    ipLoanFeesAnnual: 0,
    cashSavings: 0,               // unborrowed cash thrown in, if any
    equityReleased: 200000,       // drawn from the PPOR top-up loan for THIS property

    // LMI
    lmiEnabled: true,
    lmiTreatment: 'capitalised',  // capitalised (added to loan) | paid_cash
    lmiAmortisationYears: 5,
    lmiOverride: 0,               // >0 = use bank-quoted premium instead of estimate

    // Depreciation (Div 43 capital works / Div 40 plant & equipment)
    capitalWorksRate: 0.025,
    capitalWorksBase: 300000,
    plantEquipmentEligible: true,  // auto-forced false for established homes
    plantEquipmentAnnualDepreciation: 3500,
    plantEquipmentYearsRemaining: 5,
  };

  const PROPERTY_KEYS = new Set(Object.keys(DEFAULT_PROPERTY));

  function defaultProperty() {
    return JSON.parse(JSON.stringify(DEFAULT_PROPERTY));
  }

  const DEFAULT_INPUTS = {
    // Meta
    scenarioName: 'Brisbane 750k House',
    notes: '',
    taxYear: '2026-27',
    state: 'QLD',
    suburbId: 0,          // links the scenario to a row in the suburbs table (portfolio-level)
    projectionYears: 20,
    includeLandTax: true,

    // PPOR & equity release (one top-up loan; per-property draws live in properties[i].equityReleased)
    pporAddress: '',
    pporAddressMeta: null, // {street, suburb, postcode, state, lat, lon} from an address pick
    pporValue: 0,         // estimated market value of the home (drives the LVR check)
    pporLoanBalance: 500000,
    pporInterestRate: 0.062,
    pporLoanTermYearsRemaining: 25,
    pporRepaymentType: 'principal_and_interest',
    pporCouncilRatesAnnual: 2400,
    pporWaterRatesAnnual: 1500,
    pporInsuranceAnnual: 1800,
    pporMaintenanceAnnual: 2000,
    equityLoanRate: 0.062,
    equityLoanTermYears: 25,
    equityLoanRepaymentType: 'interest_only',
    equityLoanPurposePercent: 1.0, // deductible share (tracing rule)

    // Tax & ownership (person-level: assessed across the whole portfolio)
    ownershipType: 'sole',        // sole | joint_50_50
    buyerType: 'resident',        // resident | foreign (foreign = duty surcharge)
    owner1TaxableIncome: 150000,
    owner2TaxableIncome: 0,
    medicareLevyRate: MEDICARE_LEVY_RATE,
    otherTaxableIncomeGrowthRate: 0.025,
    otherAuLandValue: 0,
    otherLandGrowthRate: 0.05,

    // Projection assumptions
    expenseGrowthRate: 0.03,

    // Borrowing capacity (bank-style serviceability)
    bcOwner1GrossIncome: 170000,
    bcOwner2GrossIncome: 0,
    bcOtherIncome: 0,
    bcLivingExpensesAnnual: 60000,
    bcOtherDebtRepaymentsAnnual: 0,
    bcRentalHaircut: 0.20,
    bcBuffer: 0.03,
    bcDtiWarn: 6,
    bcNewLoanRate: 0.065,         // rate used to price the "next loan" capacity

    properties: [defaultProperty()],
  };

  // =====================================================================
  // Small helpers
  // =====================================================================

  function num(v, fallback) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  }

  // Legacy flat shape (v2 drafts / scenarios) -> v3: per-property keys
  // become properties[0]. A v3 payload passes through with any stray flat
  // per-property keys dropped.
  function migrateInputs(raw) {
    if (raw && typeof raw === 'object' && Array.isArray(raw.properties)) {
      const rest = {};
      for (const k of Object.keys(raw)) {
        if (k === 'properties' || PROPERTY_KEYS.has(k)) continue;
        rest[k] = raw[k];
      }
      return Object.assign(rest, { properties: raw.properties });
    }
    const globals = {};
    const flat = {};
    for (const k of Object.keys(raw || {})) {
      if (PROPERTY_KEYS.has(k)) flat[k] = raw[k];
      else globals[k] = raw[k];
    }
    return Object.assign(globals, { properties: [flat] });
  }

  function normalizeProperty(raw) {
    const out = Object.assign({}, DEFAULT_PROPERTY);
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(raw)) {
        if (!(k in out)) continue; // ignore unknown keys
        out[k] = raw[k];
      }
    }
    for (const k of Object.keys(out)) {
      if (typeof DEFAULT_PROPERTY[k] === 'number') out[k] = num(out[k], DEFAULT_PROPERTY[k]);
    }
    return out;
  }

  function normalizeInputs(raw) {
    const shaped = migrateInputs(raw);
    const out = Object.assign({}, DEFAULT_INPUTS);
    for (const k of Object.keys(shaped)) {
      if (k === 'properties' || !(k in out)) continue; // ignore unknown keys
      out[k] = shaped[k];
    }
    for (const k of Object.keys(out)) {
      if (typeof DEFAULT_INPUTS[k] === 'number') out[k] = num(out[k], DEFAULT_INPUTS[k]);
    }
    const props = (Array.isArray(shaped.properties) ? shaped.properties : [])
      .slice(0, MAX_PROPERTIES)
      .map(normalizeProperty);
    out.properties = props.length ? props : [normalizeProperty(null)];
    return out;
  }

  // Merged flat view (globals + properties[0]) so the single-property
  // functions keep working unchanged on v3 inputs — and on legacy flat
  // payloads passed directly.
  function singleView(x) {
    if (x && Array.isArray(x.properties)) {
      const view = Object.assign({}, x);
      delete view.properties;
      return Object.assign(view, x.properties[0]);
    }
    return x;
  }

  function bandFor(value, bands, fromKey, toKey) {
    for (const b of bands) {
      // Boundary values (e.g. land value of exactly $600,000) belong to
      // the lower band — checked in ascending order.
      if (value >= (b[fromKey] || 0) && value <= b[toKey]) return b;
    }
    return bands[bands.length - 1];
  }

  // =====================================================================
  // Primitives — duty, land tax, tax rates, LMI, loans
  // =====================================================================

  function transferDutyQLD(price) {
    const p = Math.max(0, num(price, 0));
    const band = bandFor(p, QLD_DUTY_BANDS, 'from', 'to');
    // "For each $100 or part thereof" — round the delta up to whole $100s.
    const hundreds = Math.ceil(Math.max(0, p - band.from) / band.per);
    const duty = band.base + hundreds * band.per * band.rate;
    return {
      dutiableValue: p,
      duty: Math.round(duty * 100) / 100,
      bandLabel: band.to === Infinity ? 'over $1,000,000' : `up to $${band.to.toLocaleString()}`,
      sourceLabel: RATE_LABELS.duty,
    };
  }

  const JOINT_LAND_TAX_WARNING = 'Joint estimate: each owner assessed on their half-share only (other holdings ignored).';

  function landTaxQLD(aggregateLandValue, ownershipType) {
    // Joint ownership: each owner is assessed on their share of the
    // aggregate (approximation — ignores each owner's other holdings).
    const agg = Math.max(0, num(aggregateLandValue, 0));
    let warning = null;
    let tax;
    if (ownershipType === 'joint_50_50') {
      tax = landTaxOnIndividual(agg / 2) * 2;
      warning = JOINT_LAND_TAX_WARNING;
    } else {
      tax = landTaxOnIndividual(agg);
    }
    return {
      aggregateLandValue: agg,
      landTax: Math.round(tax * 100) / 100,
      effectiveRate: agg > 0 ? tax / agg : 0,
      warning,
      sourceLabel: RATE_LABELS.landTax,
    };
  }

  function landTaxOnIndividual(agg) {
    if (agg < 600000) return 0;
    const band = bandFor(agg, QLD_LAND_TAX_BANDS, 'from', 'to');
    return band.base + (agg - band.from) * band.rate;
  }

  // ---------------------------------------------------------------------
  // NSW + VIC — investor rates (no first-home/PPR concessions, no foreign
  // or absentee surcharges). Verified Nov 2026 from revenue.nsw.gov.au and
  // sro.vic.gov.au current-rates pages.
  // ---------------------------------------------------------------------

  function transferDutyNSW(price) {
    const p = Math.max(0, num(price, 0));
    const band = bandFor(p, NSW_DUTY_BANDS, 'from', 'to');
    // NSW is exact pro-rata per $100 (no "or part" rounding), $20 minimum.
    const duty = Math.max(20, band.base + (p - band.from) * band.rate);
    return {
      dutiableValue: p,
      duty: Math.round(duty * 100) / 100,
      bandLabel: band.to === Infinity ? 'over $3,870,000 (premium)' : `up to $${band.to.toLocaleString()}`,
      sourceLabel: rateLabels('NSW').duty,
    };
  }

  function landTaxNSW(aggregateLandValue, ownershipType, perPropertyValues, opts) {
    // Joint owners share one threshold — a single assessment on the
    // aggregate is exact, so ownershipType doesn't change the number.
    // Revenue NSW assesses on the 3-YEAR AVERAGE of land values; along
    // the growth path the average of the last min(3, year) values is
    // current × factor, so year 1 == current value and the average
    // catches up as the hold lengthens.
    const factor = (y, g) => {
      const n = Math.min(3, Math.max(1, y));
      let sum = 0;
      for (let i = 0; i < n; i++) sum += 1 / Math.pow(1 + g, i);
      return sum / n;
    };
    opts = opts || {};
    let value;
    if (Array.isArray(perPropertyValues) && Array.isArray(opts.years)) {
      value = perPropertyValues.reduce((s, v, i) =>
        s + Math.max(0, num(v, 0)) * factor(num(opts.years[i], 1), num((opts.growths || [])[i], 0)), 0);
    } else {
      value = Math.max(0, num(aggregateLandValue, 0)) * factor(num(opts.year, 1), num(opts.growth, 0));
    }
    let tax;
    if (value <= NSW_LAND_TAX.general) tax = 0;
    else if (value <= NSW_LAND_TAX.premium)
      tax = NSW_LAND_TAX.base + (value - NSW_LAND_TAX.general) * NSW_LAND_TAX.rate;
    else
      tax = NSW_LAND_TAX.premiumBase + (value - NSW_LAND_TAX.premium) * NSW_LAND_TAX.premiumRate;
    return {
      aggregateLandValue: value,
      landTax: Math.round(tax * 100) / 100,
      effectiveRate: value > 0 ? tax / value : 0,
      warning: null,
      sourceLabel: rateLabels('NSW').landTax,
    };
  }

  function transferDutyVIC(price) {
    const v = Math.max(0, num(price, 0));
    let duty;
    let bandLabel;
    if (v <= VIC_DUTY_SCALE[0].max) {
      duty = v * 0.014;
      bandLabel = 'up to $25,000';
    } else if (v <= VIC_DUTY_SCALE[1].max) {
      const b = VIC_DUTY_SCALE[1];
      duty = b.base + (v - b.over) * b.rate;
      bandLabel = 'up to $130,000';
    } else if (v <= VIC_DUTY_SCALE[2].max) {
      const b = VIC_DUTY_SCALE[2];
      duty = b.base + (v - b.over) * b.rate;
      bandLabel = 'up to $960,000';
    } else if (v <= VIC_DUTY_SCALE[3].max) {
      duty = v * VIC_DUTY_SCALE[3].flat;
      bandLabel = 'up to $2,000,000';
    } else {
      const b = VIC_DUTY_SCALE[4];
      duty = b.base + (v - b.over) * b.rate;
      bandLabel = 'over $2,000,000';
    }
    return {
      dutiableValue: v,
      duty: Math.round(duty * 100) / 100,
      bandLabel,
      sourceLabel: rateLabels('VIC').duty,
    };
  }

  function landTaxVIC(aggregateLandValue, ownershipType) {
    // Assessed once on the total taxable value — ownership split irrelevant.
    const agg = Math.max(0, num(aggregateLandValue, 0));
    let tax = 0;
    if (agg >= VIC_LAND_TAX_BANDS[0].from) {
      const band = bandFor(agg, VIC_LAND_TAX_BANDS, 'from', 'to');
      tax = band.tax !== undefined ? band.tax
        : band.base + (agg - band.from) * band.rate;
    }
    return {
      aggregateLandValue: agg,
      landTax: Math.round(tax * 100) / 100,
      effectiveRate: agg > 0 ? tax / agg : 0,
      warning: null,
      sourceLabel: rateLabels('VIC').landTax,
    };
  }

  // ---------------------------------------------------------------------
  // SA / WA / TAS / NT / ACT — investor rates (no concessions, no foreign
  // or absentee surcharges). Verified Nov 2026 from revenuesa.sa.gov.au,
  // wa.gov.au, sro.tas.gov.au, nt.gov.au and revenue.act.gov.au.
  // ---------------------------------------------------------------------

  // Generic per-$100 band duty. mode 'ceil' = "per $100 or part" (QLD/SA/
  // WA/TAS/ACT), 'exact' = pro-rata (NSW uses its own function).
  function dutyFromBands(p, bands, mode, min) {
    const v = Math.max(0, num(p, 0));
    const band = bandFor(v, bands, 'from', 'to');
    const delta = Math.max(0, v - band.from);
    const duty = mode === 'exact'
      ? band.base + delta * band.rate
      : band.base + Math.ceil(delta / band.per) * band.per * band.rate;
    return Math.max(min || 0, duty);
  }

  function transferDutySA(price) {
    const p = Math.max(0, num(price, 0));
    const duty = dutyFromBands(p, SA_DUTY_BANDS, 'ceil');
    return {
      dutiableValue: p,
      duty: Math.round(duty * 100) / 100,
      bandLabel: p > 500000 ? 'over $500,000' : 'general scale',
      sourceLabel: rateLabels('SA').duty,
    };
  }

  function landTaxSA(aggregateLandValue) {
    const agg = Math.max(0, num(aggregateLandValue, 0));
    let tax = 0;
    if (agg > SA_LAND_TAX_BANDS[0].from) {
      tax = dutyFromBands(agg, SA_LAND_TAX_BANDS, 'ceil');
      if (tax < 20) tax = 0;   // Revenue SA: assessments under $20 aren't issued
    }
    return {
      aggregateLandValue: agg,
      landTax: Math.round(tax * 100) / 100,
      effectiveRate: agg > 0 ? tax / agg : 0,
      warning: null,
      sourceLabel: rateLabels('SA').landTax,
    };
  }

  function transferDutyWA(price) {
    const p = Math.max(0, num(price, 0));
    const duty = dutyFromBands(p, WA_DUTY_BANDS, 'ceil');
    return {
      dutiableValue: p,
      duty: Math.round(duty * 100) / 100,
      bandLabel: p > 725000 ? 'over $725,000' : 'general scale',
      sourceLabel: rateLabels('WA').duty,
    };
  }

  function landTaxWA(aggregateLandValue) {
    const agg = Math.max(0, num(aggregateLandValue, 0));
    const band = bandFor(agg, WA_LAND_TAX_BANDS, 'from', 'to');
    const tax = agg < WA_LAND_TAX_BANDS[0].from ? 0
      : band.base + (agg - band.from) * band.rate;
    return {
      aggregateLandValue: agg,
      landTax: Math.round(tax * 100) / 100,
      effectiveRate: agg > 0 ? tax / agg : 0,
      warning: null,
      sourceLabel: rateLabels('WA').landTax,
    };
  }

  function transferDutyTAS(price) {
    const p = Math.max(0, num(price, 0));
    const duty = dutyFromBands(p, TAS_DUTY_BANDS, 'ceil');
    return {
      dutiableValue: p,
      duty: Math.round(duty * 100) / 100,
      bandLabel: p > 725000 ? 'over $725,000' : 'general scale',
      sourceLabel: rateLabels('TAS').duty,
    };
  }

  function landTaxTAS(aggregateLandValue) {
    const agg = Math.max(0, num(aggregateLandValue, 0));
    let tax = 0;
    if (agg >= TAS_LAND_TAX_BANDS[0].from) {
      const band = bandFor(agg, TAS_LAND_TAX_BANDS, 'from', 'to');
      tax = band.base + (agg - band.from) * band.rate;
    }
    return {
      aggregateLandValue: agg,
      landTax: Math.round(tax * 100) / 100,
      effectiveRate: agg > 0 ? tax / agg : 0,
      warning: null,
      sourceLabel: rateLabels('TAS').landTax,
    };
  }

  // NT: curved formula below $525k, flat percentages above. NT has NO
  // land tax — landTaxNT returns zero with an explanatory label.
  function transferDutyNT(price) {
    const v = Math.max(0, num(price, 0));
    let duty;
    let bandLabel;
    if (v <= 525000) {
      const V = v / 1000;
      duty = 0.06571441 * V * V + 15 * V;
      bandLabel = 'TRO formula, up to $525,000';
    } else if (v <= 3000000) {
      duty = v * 0.04954138;
      bandLabel = 'up to $3,000,000';
    } else if (v <= 5000000) {
      duty = v * 0.05754877;
      bandLabel = 'up to $5,000,000';
    } else {
      duty = v * 0.0595;
      bandLabel = 'over $5,000,000';
    }
    return {
      dutiableValue: v,
      duty: Math.round(duty * 100) / 100,
      bandLabel,
      sourceLabel: rateLabels('NT').duty,
    };
  }

  function landTaxNT(aggregateLandValue) {
    const agg = Math.max(0, num(aggregateLandValue, 0));
    return {
      aggregateLandValue: agg,
      landTax: 0,
      effectiveRate: 0,
      warning: null,
      sourceLabel: rateLabels('NT').landTax,
    };
  }

  function transferDutyACT(price) {
    const v = Math.max(0, num(price, 0));
    let duty;
    if (v > ACT_DUTY_BANDS[ACT_DUTY_BANDS.length - 1].to) {
      duty = v * 0.0454;   // flat % of the TOTAL value above $1,455,000
    } else {
      duty = dutyFromBands(v, ACT_DUTY_BANDS, 'ceil');
    }
    return {
      dutiableValue: v,
      duty: Math.round(duty * 100) / 100,
      bandLabel: v > 1455000 ? 'over $1,455,000 (flat 4.54% of total)' : 'investor scale',
      sourceLabel: rateLabels('ACT').duty,
    };
  }

  // ACT assesses land tax PER PROPERTY: fixed charge on each + a marginal
  // valuation charge on each property's AUV. Callers may pass an array of
  // per-property land values; otherwise the aggregate is treated as one.
  function landTaxACT(aggregateLandValue, ownershipType, perPropertyValues) {
    const vals = Array.isArray(perPropertyValues) && perPropertyValues.length
      ? perPropertyValues.map((x) => Math.max(0, num(x, 0)))
      : [Math.max(0, num(aggregateLandValue, 0))];
    let tax = vals.length * ACT_LAND_TAX_FIXED;
    for (const v of vals) {
      if (v > 0) {
        const band = bandFor(v, ACT_LAND_TAX_TIERS, 'from', 'to');
        tax += band.base + (v - band.from) * band.rate;
      }
    }
    return {
      aggregateLandValue: vals.reduce((s, v) => s + v, 0),
      landTax: Math.round(tax * 100) / 100,
      effectiveRate: aggregateLandValue > 0 ? tax / aggregateLandValue : 0,
      warning: null,
      sourceLabel: rateLabels('ACT').landTax,
    };
  }

  // ---------------------------------------------------------------------
  // State registry — engine dispatches duty/land tax by inputs.state.
  // Unknown values fall back to QLD (the original, fully-modelled state).
  // ---------------------------------------------------------------------

  const RATE_LABELS_BY_STATE = {
    NSW: {
      duty: 'NSW transfer duty — Revenue NSW scale, 2026-27 (checked Nov 2026); first-home concessions not applied',
      landTax: 'NSW land tax — 2026 land tax year, $1,075,000 threshold on 3-year averaged values (checked Nov 2026); excludes foreign-owner surcharge',
    },
    VIC: {
      duty: 'VIC land transfer duty — SRO general scale, non-PPR, since 1 Jul 2021 (checked Nov 2026)',
      landTax: 'VIC land tax — 2026 land tax year, SRO general scale, $50,000 threshold (checked Nov 2026); excludes absentee-owner surcharge',
    },
    SA: {
      duty: 'SA stamp duty — Revenue SA general scale (checked Nov 2026); first-home new-build exemption not applied',
      landTax: 'SA land tax — 2026-27 general scale, $936,000 threshold (checked Nov 2026)',
    },
    WA: {
      duty: 'WA transfer duty — general scale (checked Nov 2026); first-home concessions not applied',
      landTax: 'WA land tax — 2026-27 marginal scale, $300,000 threshold (checked Nov 2026); excludes Metropolitan Region Improvement Tax (Perth metro)',
    },
    TAS: {
      duty: 'TAS property transfer duty — SRO Tasmania general scale, since 21 Oct 2013 (checked Nov 2026)',
      landTax: 'TAS land tax — scale from 1 Jul 2025, $125,000 threshold (checked Nov 2026)',
    },
    NT: {
      duty: 'NT conveyance duty — TRO formula/percentage scale (checked Nov 2026); first-home discount not applied',
      landTax: 'Northern Territory — no land tax',
    },
    ACT: {
      duty: 'ACT conveyance duty — investor scale (not owner-occupier), from 1 Jul 2025 (checked Nov 2026)',
      landTax: 'ACT land tax — 2026-27: $1,778 fixed charge per property + marginal valuation charge on AUV (checked Nov 2026)',
    },
  };

  function rateLabels(state) {
    const s = RATE_LABELS_BY_STATE[state] ? state : 'QLD';
    return Object.assign({}, RATE_LABELS, RATE_LABELS_BY_STATE[s]);
  }

  const STATE_TABLES = {
    QLD: { name: 'Queensland', transferDuty: transferDutyQLD, landTax: landTaxQLD },
    NSW: { name: 'New South Wales', transferDuty: transferDutyNSW, landTax: landTaxNSW },
    VIC: { name: 'Victoria', transferDuty: transferDutyVIC, landTax: landTaxVIC },
    SA: { name: 'South Australia', transferDuty: transferDutySA, landTax: landTaxSA },
    WA: { name: 'Western Australia', transferDuty: transferDutyWA, landTax: landTaxWA },
    TAS: { name: 'Tasmania', transferDuty: transferDutyTAS, landTax: landTaxTAS },
    NT: { name: 'Northern Territory', transferDuty: transferDutyNT, landTax: landTaxNT },
    ACT: { name: 'ACT', transferDuty: transferDutyACT, landTax: landTaxACT },
  };

  function stateEntry(state) {
    return STATE_TABLES[state] || STATE_TABLES.QLD;
  }

  // Foreign-buyer duty surcharges (flat % of value, on top of the general
  // scale). NT and ACT have none. Land-tax surcharges NOT modelled.
  const FOREIGN_DUTY_SURCHARGE = {
    NSW: 0.09, VIC: 0.08, QLD: 0.07, SA: 0.07, WA: 0.07, TAS: 0.08,
  };

  function transferDuty(state, price, buyerType) {
    const r = stateEntry(state).transferDuty(price);
    const sur = FOREIGN_DUTY_SURCHARGE[state];
    if (buyerType === 'foreign' && sur) {
      const p = Math.max(0, num(price, 0));
      r.duty = Math.round((r.duty + p * sur) * 100) / 100;
      r.bandLabel += ` + ${(sur * 100).toFixed(0)}% foreign surcharge`;
    }
    return r;
  }

  function landTax(state, aggregateLandValue, ownershipType, perPropertyValues, opts) {
    return stateEntry(state).landTax(aggregateLandValue, ownershipType, perPropertyValues, opts);
  }

  // Financial-year registry: tax estimates are versioned by FY (the same
  // inputs can be compared across years as tables are added).
  const TAX_TABLES_BY_FY = {
    '2026-27': TAX_BRACKETS_2026_27,
  };

  function bracketsForFY(fy) {
    return TAX_TABLES_BY_FY[fy] || TAX_BRACKETS_2026_27;
  }

  function marginalRate(taxableIncome, fy) {
    const income = Math.max(0, num(taxableIncome, 0));
    const bracket = bandFor(income, bracketsForFY(fy), 'from', 'to');
    return {
      income,
      bracketRate: bracket.rate,
      medicareRate: MEDICARE_LEVY_RATE,
      combinedMarginalRate: bracket.rate + MEDICARE_LEVY_RATE,
      bracketLabel: bracket.to === Infinity ? '$190,001+' : `$${(bracket.from || 0).toLocaleString()}–$${bracket.to.toLocaleString()}`,
      sourceLabel: RATE_LABELS.incomeTax,
    };
  }

  function incomeTaxEstimate(taxableIncome, fy) {
    const income = Math.max(0, num(taxableIncome, 0));
    let tax = 0;
    let lower = 0;
    for (const b of bracketsForFY(fy)) {
      if (income > lower) {
        tax += (Math.min(income, b.to) - lower) * b.rate;
        lower = b.to;
      } else break;
    }
    const medicare = income * MEDICARE_LEVY_RATE;
    return {
      income,
      incomeTax: Math.round(tax * 100) / 100,
      medicareLevy: Math.round(medicare * 100) / 100,
      totalTax: Math.round((tax + medicare) * 100) / 100,
    };
  }

  function lmiEstimate(loanAmount, lvr) {
    const loan = Math.max(0, num(loanAmount, 0));
    const ratio = Math.max(0, num(lvr, 0));
    const band = LMI_BANDS.find((b) => ratio <= b.maxLvr);
    const premium = loan * band.rate;
    return {
      loanAmount: loan,
      lvr: ratio,
      rate: band.rate,
      premium: Math.round(premium * 100) / 100,
      capitalisedLoanAmount: Math.round((loan + premium) * 100) / 100,
      estimateLabel: RATE_LABELS.lmi,
      warning: ratio > 0.95 ? 'LVR above 95% — most lenders will decline' : null,
    };
  }

  // Standard amortising monthly repayment.
  function loanPayment(principal, annualRate, termYears) {
    const r = num(annualRate, 0) / 12;
    const n = Math.round(num(termYears, 30) * 12);
    if (n <= 0) return 0;
    if (r <= 0) return principal / n;
    return (principal * r) / (1 - Math.pow(1 + r, -n));
  }

  // Advance one loan by `months`, stepping monthly for exact interest.
  // repayment is the TOTAL monthly payment (interest + principal).
  function advanceLoan(openingBalance, annualRate, months, monthlyRepayment) {
    let balance = openingBalance;
    let interest = 0;
    let principal = 0;
    const r = annualRate / 12;
    for (let m = 0; m < months; m++) {
      const int = balance * r;
      let prin = monthlyRepayment - int;
      if (prin < 0) prin = 0;              // repayment can't cover interest
      if (prin > balance) prin = balance;  // final payment
      interest += int;
      principal += prin;
      balance -= prin;
    }
    return { interest, principal, closingBalance: balance };
  }

  // Balance after `year` holding years. P&I years step monthly with the
  // repayment sized on the opening balance over the remaining term (this
  // is how real IO->P&I conversions are priced).
  function loanBalanceAtYear(principal, annualRate, termYears, repaymentType, ioYears, year) {
    let balance = principal;
    const years = Math.max(0, Math.round(num(year, 0)));
    if (repaymentType !== 'principal_and_interest') return balance;
    const pAndIYears = termYears - ioYears;
    for (let y = ioYears + 1; y <= years; y++) {
      const remainingTerm = Math.max(1, pAndIYears - (y - ioYears) + 1);
      const repayment = loanPayment(balance, annualRate, remainingTerm);
      balance = advanceLoan(balance, annualRate, 12, repayment).closingBalance;
    }
    return balance;
  }

  // =====================================================================
  // Upfront / funding structure
  // =====================================================================

  function fundingStructure(rawInputs) {
    const inputs = singleView(rawInputs);
    const duty = transferDuty(inputs.state, inputs.purchasePrice, inputs.buyerType).duty;
    const acquisitionCosts =
      duty +
      num(inputs.legalFees, 0) +
      num(inputs.buildingInspectionCost, 0) +
      num(inputs.quantitySurveyorCost, 0) +
      num(inputs.initialRepairs, 0) +
      num(inputs.otherAcquisitionCosts, 0) +
      num(inputs.ipLoanSetupFee, 0);

    // IP loan base: explicit override or price x LVR. LVR measured on
    // price (bank practice: value, but we conservatively use price).
    const ipLoanBase = inputs.ipLoanAmountOverride > 0
      ? inputs.ipLoanAmountOverride
      : inputs.purchasePrice * inputs.ipLvr;
    const lvr = ipLoanBase / Math.max(1, inputs.purchasePrice);

    // Bank-quoted LMI wins over the band estimate when provided.
    const lmi = !inputs.lmiEnabled ? null
      : inputs.lmiOverride > 0
        ? {
            loanAmount: ipLoanBase,
            lvr,
            rate: inputs.lmiOverride / ipLoanBase,
            premium: inputs.lmiOverride,
            capitalisedLoanAmount: ipLoanBase + inputs.lmiOverride,
            warning: null,
            quoted: true,
          }
        : lmiEstimate(ipLoanBase, lvr);
    const lmiCash = lmi && inputs.lmiTreatment === 'paid_cash' ? lmi.premium : 0;
    const ipLoanStart = lmi && inputs.lmiTreatment === 'capitalised'
      ? lmi.capitalisedLoanAmount
      : ipLoanBase;

    const requiredFunds = inputs.purchasePrice + acquisitionCosts + lmiCash;
    const funding = ipLoanStart + inputs.equityReleased + inputs.cashSavings;
    const shortfall = requiredFunds - funding;
    const initialCashInvested = inputs.cashSavings + lmiCash + Math.max(0, shortfall);

    return {
      transferDuty: duty,
      acquisitionCosts,
      ipLoanBase,
      ipLoanStart,
      ipLvrActual: lvr,
      lmi,
      lmiCash,
      requiredFunds,
      funding,
      shortfall,
      initialCashInvested,
      warnings: shortfall > 0
        ? [`Funding shortfall of $${Math.round(shortfall).toLocaleString()} — increase equity release or IP loan`]
        : [],
    };
  }

  // =====================================================================
  // Annual projection
  // =====================================================================

  // Pure single-year computation. `opening` carries the two loan balances
  // in from the previous year; growth exponents use (year-1) for flows
  // (rent/expenses happen DURING the year) and (year) for the asset value
  // at end of year.
  // Pure single-property year computation, MINUS land tax and tax — both
  // are person/portfolio-level, so the caller passes the (allocated)
  // landTax in and appends taxRefundOrCost/afterTaxCashFlow afterwards.
  // eqInterest/eqPrincipal are passed in because the equity top-up loan is
  // ONE loan: the portfolio schedules it once and allocates by share.
  // Growth exponents use (year-1) for flows (rent/expenses happen DURING
  // the year) and (year) for the asset value at end of year.
  function propertyYearLines(inputs, year, opening, upfront, landTax, eqInterest, eqPrincipal) {
    const g = inputs.expectedCapitalGrowthRate;
    const rg = inputs.annualRentGrowthRate;
    const eg = inputs.expenseGrowthRate;
    const inf = (rate, y) => Math.pow(1 + rate, y - 1); // flow-year exponent

    const propertyValue = inputs.purchasePrice * Math.pow(1 + g, year);
    const landValueNow = inputs.landValue * Math.pow(1 + inputs.landValueGrowthRate, year - 1);

    // ---- income ----
    const weeklyRent = inputs.weeklyRent * inf(rg, year);
    const grossRent = weeklyRent * 52;
    const vacancyLoss = weeklyRent * num(inputs.vacancyWeeksPerYear, 0);
    const effectiveRent = grossRent - vacancyLoss;

    // ---- operating expenses ----
    const pmRate = inputs.propertyManagementRate * (inputs.propertyManagementGSTIncluded ? 1 : 1.10);
    const managementFees = effectiveRent * pmRate;
    const interval = Math.max(1, num(inputs.lettingFeeIntervalYears, 2));
    const lettingFees = (inputs.lettingFeeWeeks * weeklyRent) / interval;
    const renewalFee = inputs.renewalFeePerYear * inf(eg, year);
    const councilRates = inputs.councilRatesAnnual * inf(eg, year);
    const waterRates = inputs.waterRatesAnnual * inf(eg, year);
    const insurance = inputs.insuranceAnnual * inf(eg, year);
    const bodyCorporate = inputs.bodyCorporateAnnual * inf(eg, year);
    const maintenance = inputs.maintenanceRate * inputs.purchasePrice * Math.pow(1 + g, year - 1);
    const otherExpenses = inputs.otherAnnualExpenses * inf(eg, year);
    const otherDeductibleClaims = num(inputs.otherDeductibleClaims, 0) * inf(eg, year);
    const ipLoanFees = inputs.ipLoanFeesAnnual * inf(eg, year);

    const operatingExpenses =
      managementFees + lettingFees + renewalFee + councilRates + waterRates +
      insurance + bodyCorporate + maintenance + otherExpenses + landTax + ipLoanFees;

    // ---- IP loan (IO for ipInterestOnlyYears, then P&I over what's left) ----
    const ioYears = effectiveIoYears(inputs);
    let ipInterest = 0;
    let ipPrincipal = 0;
    if (year <= ioYears) {
      ipInterest = opening.ipBalance * inputs.ipInterestRate;
    } else {
      const pAndIYears = inputs.ipLoanTermYears - ioYears;
      const remainingTerm = Math.max(1, pAndIYears - (year - ioYears) + 1);
      const repayment = loanPayment(opening.ipBalance, inputs.ipInterestRate, remainingTerm);
      const step = advanceLoan(opening.ipBalance, inputs.ipInterestRate, 12, repayment);
      ipInterest = step.interest;
      ipPrincipal = step.principal;
    }
    const ipClosing = opening.ipBalance - ipPrincipal;

    // ---- depreciation ----
    const capitalWorksActive = inputs.purchaseYear - inputs.buildYear < 40;
    const capitalWorksDepreciation = capitalWorksActive
      ? inputs.capitalWorksBase * inputs.capitalWorksRate
      : 0;
    const plantDepreciation =
      (inputs.isNewBuild && inputs.plantEquipmentEligible && year <= inputs.plantEquipmentYearsRemaining)
        ? inputs.plantEquipmentAnnualDepreciation
        : 0;

    // ---- LMI amortisation (deductible over 5 years) ----
    const lmiAmortisation =
      upfront.lmi && upfront.lmi.premium > 0 && year <= inputs.lmiAmortisationYears
        ? upfront.lmi.premium / inputs.lmiAmortisationYears
        : 0;

    // ---- taxable property result ----
    const deductibleEquityInterest = eqInterest * inputs.equityLoanPurposePercent;
    const taxablePropertyResult =
      effectiveRent - operatingExpenses - ipInterest - deductibleEquityInterest -
      lmiAmortisation - capitalWorksDepreciation - plantDepreciation -
      otherDeductibleClaims;

    const totalDeductions =
      operatingExpenses + ipInterest + deductibleEquityInterest +
      lmiAmortisation + capitalWorksDepreciation + plantDepreciation +
      otherDeductibleClaims;

    // ---- cash flow ----
    const lmiCashThisYear = upfront.lmiCash > 0 && year === 1 ? upfront.lmiCash : 0;
    const netOperatingIncome = effectiveRent - operatingExpenses - ipInterest - eqInterest;
    const preTaxCashFlow =
      netOperatingIncome - ipPrincipal - eqPrincipal - lmiCashThisYear;

    const eqClosing = opening.eqBalance - eqPrincipal;
    const totalDebt = ipClosing + eqClosing;
    const netEquity = propertyValue - totalDebt;

    return {
      year,
      calendarYear: inputs.purchaseYear + year - 1,
      propertyValue,
      landValue: landValueNow,
      weeklyRent,
      grossRent,
      vacancyLoss,
      effectiveRent,
      managementFees,
      lettingFees,
      renewalFee,
      councilRates,
      waterRates,
      insurance,
      bodyCorporate,
      maintenance,
      landTax,
      otherExpenses,
      otherDeductibleClaims,
      ipLoanFees,
      operatingExpenses,
      netOperatingIncome,

      ipLoanOpeningBalance: opening.ipBalance,
      ipInterest,
      ipPrincipalRepayment: ipPrincipal,
      ipLoanClosingBalance: ipClosing,
      inInterestOnlyPeriod: year <= ioYears,

      equityLoanOpeningBalance: opening.eqBalance,
      equityLoanInterest: eqInterest,
      equityLoanPrincipalRepayment: eqPrincipal,
      equityLoanClosingBalance: eqClosing,

      deductibleEquityInterest,
      capitalWorksDepreciation,
      plantEquipmentDepreciation: plantDepreciation,
      lmiAmortisation,
      totalDeductions,
      taxablePropertyResult,

      preTaxCashFlow,

      totalDebt,
      netEquity,
    };
  }

  // Owner-level blended marginal rate after `yearsElapsed` of income
  // growth — shared by the negative-gearing and CGT assessments.
  function ownerBlendedRate(inputs, yearsElapsed) {
    const growth = Math.pow(1 + num(inputs.otherTaxableIncomeGrowthRate, 0), yearsElapsed);
    if (inputs.ownershipType === 'joint_50_50') {
      const s1 = marginalRate(inputs.owner1TaxableIncome * growth, inputs.taxYear);
      const s2 = marginalRate(inputs.owner2TaxableIncome * growth, inputs.taxYear);
      return 0.5 * s1.combinedMarginalRate + 0.5 * s2.combinedMarginalRate;
    }
    return marginalRate(inputs.owner1TaxableIncome * growth, inputs.taxYear).combinedMarginalRate;
  }

  // Negative gearing: negative property result -> refund (cash inflow),
  // positive -> tax cost.
  function taxOnPropertyResult(inputs, taxablePropertyResult, year) {
    return -taxablePropertyResult * ownerBlendedRate(inputs, year - 1);
  }

  // The PIA-style investor/partner breakdown: each owner's share of the
  // property result taxed at their OWN marginal rate. Sums exactly to
  // taxOnPropertyResult (the blended rate is the share-weighted average).
  function ownerTaxSplit(inputs, taxablePropertyResult, year) {
    const y = Math.max(0, num(year, 1) - 1);
    const growth = Math.pow(1 + num(inputs.otherTaxableIncomeGrowthRate, 0), y);
    const joint = inputs.ownershipType === 'joint_50_50';
    const share = joint ? 0.5 : 1;
    const s1 = marginalRate(inputs.owner1TaxableIncome * growth, inputs.taxYear);
    const owner1 = -taxablePropertyResult * share * s1.combinedMarginalRate;
    let owner2 = null;
    let s2 = null;
    if (joint) {
      s2 = marginalRate(inputs.owner2TaxableIncome * growth, inputs.taxYear);
      owner2 = -taxablePropertyResult * share * s2.combinedMarginalRate;
    }
    return {
      ownership: joint ? 'joint_50_50' : 'sole',
      share,
      owner1, owner2,
      total: owner2 === null ? owner1 : owner1 + owner2,
      rate1: s1.combinedMarginalRate, rate2: s2 ? s2.combinedMarginalRate : null,
      bracket1: s1.bracketLabel, bracket2: s2 ? s2.bracketLabel : null,
      income1: inputs.owner1TaxableIncome, income2: inputs.owner2TaxableIncome,
    };
  }

  // Single-property year: land tax on this property + other AU land,
  // equity loan scheduled in full, tax at the blended marginal rate.
  // Byte-compatible with the pre-portfolio math.
  function yearProjection(rawInputs, year, opening, upfront) {
    const inputs = singleView(rawInputs);
    const lg = inputs.landValueGrowthRate;
    const landValueNow = inputs.landValue * Math.pow(1 + lg, year - 1);
    const otherLand = inputs.otherAuLandValue * Math.pow(1 + lg, year - 1);
    const lt = landTax(inputs.state, landValueNow + otherLand, inputs.ownershipType,
      [landValueNow, otherLand],
      { years: [year, year], growths: [inputs.landValueGrowthRate, inputs.otherLandGrowthRate] });
    const landTaxDue = inputs.includeLandTax === false ? 0 : lt.landTax;

    let eqInterest = 0;
    let eqPrincipal = 0;
    if (inputs.equityLoanRepaymentType === 'principal_and_interest') {
      const remainingTerm = Math.max(1, inputs.equityLoanTermYears - year + 1);
      const repayment = loanPayment(opening.eqBalance, inputs.equityLoanRate, remainingTerm);
      const step = advanceLoan(opening.eqBalance, inputs.equityLoanRate, 12, repayment);
      eqInterest = step.interest;
      eqPrincipal = step.principal;
    } else {
      eqInterest = opening.eqBalance * inputs.equityLoanRate;
    }

    const row = propertyYearLines(inputs, year, opening, upfront, landTaxDue, eqInterest, eqPrincipal);

    const taxRefundOrCost = taxOnPropertyResult(inputs, row.taxablePropertyResult, year);
    row.taxRefundOrCost = taxRefundOrCost;
    // Claims are a real cash cost AND a deduction: they cut the taxable
    // result (bigger refund) and drain cash directly.
    row.afterTaxCashFlow = row.preTaxCashFlow - row.otherDeductibleClaims + taxRefundOrCost;
    return row;
  }

  // "P&I from day one" (ipRepaymentType) means the IO-period input is ignored.
  function effectiveIoYears(inputs) {
    return inputs.ipRepaymentType === 'principal_and_interest'
      ? 0
      : num(inputs.ipInterestOnlyYears, 0);
  }

  // True when the loan has an IO intro period and the P&I switch lands
  // inside the projection window. An IO period of 0 years is P&I from day
  // one — no step-up exists.
  function ioSwitchInsideWindow(inputs) {
    const ioYears = effectiveIoYears(inputs);
    return ioYears >= 1 && ioYears < Math.min(inputs.projectionYears, inputs.ipLoanTermYears);
  }

  function projectYears(rawInputs, upfront) {
    const inputs = singleView(rawInputs);
    upfront = upfront || fundingStructure(inputs);
    const rows = [];
    let cum = 0;
    let ipBalance = upfront.ipLoanStart;
    let eqBalance = inputs.equityReleased;
    let totalTaxRefunds = 0;
    let totalInterest = 0;

    for (let year = 1; year <= inputs.projectionYears; year++) {
      const row = yearProjection(inputs, year, { ipBalance, eqBalance }, upfront);
      row.cumulativeAfterTaxCashFlow = (rows.length
        ? rows[rows.length - 1].cumulativeAfterTaxCashFlow : 0) + row.afterTaxCashFlow;
      row.cumulativePosition =
        row.netEquity + row.cumulativeAfterTaxCashFlow - upfront.initialCashInvested;
      rows.push(row);
      ipBalance = row.ipLoanClosingBalance;
      eqBalance = row.equityLoanClosingBalance;
      totalTaxRefunds += Math.max(0, row.taxRefundOrCost);
      totalInterest += row.ipInterest + row.equityLoanInterest;
    }

    const last = rows[rows.length - 1];
    return {
      rows,
      upfront,
      totalTaxRefunds,
      totalInterest,
      totals: {
        endingPropertyValue: last.propertyValue,
        endingDebt: last.totalDebt,
        endingEquity: last.netEquity,
        totalAfterTaxCashFlow: last.cumulativeAfterTaxCashFlow,
      },
      warnings: [
        ...upfront.warnings,
        // Flag the IO -> P&I step-up if it happens inside the window.
        ...((ioSwitchInsideWindow(inputs))
          ? [`Repayments switch from interest-only to P&I in year ${effectiveIoYears(inputs) + 1} — watch the cash flow jump`]
          : []),
        // The joint land-tax split is a QLD-only approximation (every
        // other jurisdiction assesses the aggregate once — exact); flag it
        // whenever the aggregate land value crosses the threshold.
        ...((inputs.state === 'QLD' &&
              inputs.ownershipType === 'joint_50_50' && inputs.includeLandTax !== false &&
              (num(inputs.landValue, 0) + num(inputs.otherAuLandValue, 0)) >= QLD_LAND_TAX_BANDS[0].from)
          ? [JOINT_LAND_TAX_WARNING]
          : []),
      ],
    };
  }

  // =====================================================================
  // Portfolio projection — all properties on one calendar timeline
  // =====================================================================

  // Merged flat view (globals + properties[i]) for one property.
  function mergedProperty(inputs, i) {
    return singleView(Object.assign({}, inputs, { properties: [inputs.properties[i]] }));
  }

  // The equity top-up loan is ONE loan; each property owns a fixed share
  // of it (its draw / total draws) for interest, deductions and repayment.
  function equityShares(inputs) {
    const total = inputs.properties.reduce((s, p) => s + Math.max(0, num(p.equityReleased, 0)), 0);
    return inputs.properties.map((p) =>
      total > 0 ? Math.max(0, num(p.equityReleased, 0)) / total : 0);
  }

  // Portfolio timeline starts at the earliest purchase year; each
  // property joins the combined model in portfolio year offset+1.
  function purchaseOffsets(inputs) {
    const start = Math.min(...inputs.properties.map((p) => num(p.purchaseYear, 2026)));
    return inputs.properties.map((p) => Math.max(0, num(p.purchaseYear, 2026) - start));
  }

  // Land tax is assessed ONCE on all portfolio land (QLD aggregates
  // Australia-wide), then allocated pro-rata by each property's share of
  // assessable land. `landNow` covers ACTIVE properties only (inactive
  // entries are 0 and get a 0 share).
  function portfolioLandTax(inputs, landNow, portfolioYear) {
    const otherLand = inputs.otherAuLandValue * Math.pow(1 + inputs.otherLandGrowthRate, portfolioYear - 1);
    const offsets = purchaseOffsets(inputs);
    const lt = inputs.includeLandTax === false
      ? { landTax: 0, warning: null }
      : landTax(inputs.state, landNow.reduce((s, l) => s + l, 0) + otherLand,
          inputs.ownershipType, landNow.concat([otherLand]),
          {
            years: landNow.map((_, i) => portfolioYear - offsets[i]).concat([portfolioYear]),
            growths: inputs.properties.map((p) => p.landValueGrowthRate)
              .concat([inputs.otherLandGrowthRate]),
          });
    const totalLand = landNow.reduce((s, l) => s + l, 0);
    const shares = totalLand > 0 ? landNow.map((l) => l / totalLand) : landNow.map(() => 0);
    return { total: lt.landTax, shares };
  }

  const COMBINED_SUM_KEYS = [
    'propertyValue', 'landValue', 'weeklyRent', 'grossRent', 'vacancyLoss',
    'effectiveRent', 'managementFees', 'lettingFees', 'renewalFee', 'councilRates',
    'waterRates', 'insurance', 'bodyCorporate', 'maintenance', 'landTax',
    'otherExpenses', 'otherDeductibleClaims', 'ipLoanFees', 'operatingExpenses', 'netOperatingIncome',
    'ipLoanOpeningBalance', 'ipInterest', 'ipPrincipalRepayment', 'ipLoanClosingBalance',
    'equityLoanOpeningBalance', 'equityLoanInterest', 'equityLoanPrincipalRepayment',
    'equityLoanClosingBalance', 'deductibleEquityInterest', 'capitalWorksDepreciation',
    'plantEquipmentDepreciation', 'lmiAmortisation', 'totalDeductions',
    'taxablePropertyResult', 'preTaxCashFlow', 'totalDebt', 'netEquity',
  ];

  function combineLines(lines, year) {
    const out = { year, calendarYear: lines[0].calendarYear };
    for (const k of COMBINED_SUM_KEYS) out[k] = lines.reduce((s, r) => s + r[k], 0);
    out.inInterestOnlyPeriod = lines.some((r) => r.inInterestOnlyPeriod);
    return out;
  }

  function aggregateUpfront(upfronts, inputs) {
    const sum = (k) => upfronts.reduce((s, u) => s + u[k], 0);
    const totalBase = sum('ipLoanBase');
    const totalPrice = inputs.properties.reduce((s, p) => s + Math.max(0, p.purchasePrice), 0);
    return {
      transferDuty: sum('transferDuty'),
      acquisitionCosts: sum('acquisitionCosts'),
      ipLoanBase: totalBase,
      ipLoanStart: sum('ipLoanStart'),
      ipLvrActual: totalPrice > 0 ? totalBase / totalPrice : 0,
      lmi: upfronts.length === 1 ? upfronts[0].lmi : null,
      lmiCash: sum('lmiCash'),
      requiredFunds: sum('requiredFunds'),
      funding: sum('funding'),
      shortfall: sum('shortfall'),
      initialCashInvested: sum('initialCashInvested'),
      warnings: [],
    };
  }

  function projectPortfolio(inputs, upfronts) {
    const props = inputs.properties;
    const views = props.map((p, i) => mergedProperty(inputs, i));
    const shares = equityShares(inputs);
    const offsets = purchaseOffsets(inputs);
    const startYear = Math.min(...props.map((p) => num(p.purchaseYear, 2026)));
    const drawYear = offsets.map((o) => o + 1); // portfolio year the equity draw + cash land in

    const perRows = props.map(() => []);
    const rows = [];
    const ipBalances = props.map(() => 0);
    let eqBalance = 0;
    let cum = 0;
    let totalTaxRefunds = 0;
    let totalInterest = 0;

    for (let year = 1; year <= inputs.projectionYears; year++) {
      // The equity top-up loan grows as later purchases draw their share;
      // each draw accrues interest from its settlement year.
      const settled = props.reduce((s, p, i) =>
        s + (drawYear[i] <= year ? Math.max(0, num(p.equityReleased, 0)) : 0), 0);
      eqBalance = settled;

      // ONE equity top-up loan across the whole portfolio, scheduled once.
      let eqInterest = 0;
      let eqPrincipal = 0;
      if (inputs.equityLoanRepaymentType === 'principal_and_interest') {
        const remainingTerm = Math.max(1, inputs.equityLoanTermYears - year + 1);
        const repayment = loanPayment(eqBalance, inputs.equityLoanRate, remainingTerm);
        const step = advanceLoan(eqBalance, inputs.equityLoanRate, 12, repayment);
        eqInterest = step.interest;
        eqPrincipal = step.principal;
      } else {
        eqInterest = eqBalance * inputs.equityLoanRate;
      }
      const eqClosing = eqBalance - eqPrincipal;

      const active = offsets.map((o) => year > o);
      const localYears = offsets.map((o) => year - o);
      // Equity shares renormalised over DRAWN amounts: before a property
      // settles it holds no share of the top-up loan, and the settled
      // properties' shares always sum to 1.
      const activeShares = props.map((p, i) =>
        drawYear[i] <= year && settled > 0 ? Math.max(0, num(p.equityReleased, 0)) / settled : 0);
      const landNow = props.map((p, i) => active[i]
        ? p.landValue * Math.pow(1 + p.landValueGrowthRate, localYears[i] - 1)
        : 0);
      const lt = portfolioLandTax(inputs, landNow, year);

      const yearLines = props.map((p, i) => {
        if (!active[i]) return null;
        const ipOpening = localYears[i] === 1 ? upfronts[i].ipLoanStart : ipBalances[i];
        return propertyYearLines(
          views[i], localYears[i],
          { ipBalance: ipOpening, eqBalance: eqBalance * activeShares[i] },
          upfronts[i],
          lt.total * lt.shares[i],
          eqInterest * activeShares[i], eqPrincipal * activeShares[i]
        );
      });
      const activeLines = yearLines.filter(Boolean);

      // Person-level tax: ALL active properties' taxable results assessed
      // once at the blended marginal rate, then allocated pro-rata by
      // |result| so the property rows sum to the portfolio total.
      const taxableTotal = activeLines.reduce((s, r) => s + r.taxablePropertyResult, 0);
      const portfolioTax = -taxableTotal * ownerBlendedRate(inputs, year - 1);
      const absSum = activeLines.reduce((s, r) => s + Math.abs(r.taxablePropertyResult), 0);
      activeLines.forEach((r) => {
        const alloc = absSum > 0 ? portfolioTax * (Math.abs(r.taxablePropertyResult) / absSum) : 0;
        r.taxRefundOrCost = alloc;
        r.afterTaxCashFlow = r.preTaxCashFlow - r.otherDeductibleClaims + alloc;
      });

      const combined = combineLines(activeLines, year);
      combined.calendarYear = startYear + year - 1;
      combined.taxRefundOrCost = portfolioTax;
      combined.afterTaxCashFlow = activeLines.reduce((s, r) => s + r.afterTaxCashFlow, 0);
      combined.cumulativeAfterTaxCashFlow = cum + combined.afterTaxCashFlow;
      const cashToDate = props.reduce((s, p, i) =>
        s + (drawYear[i] <= year ? upfronts[i].initialCashInvested : 0), 0);
      combined.cumulativePosition =
        combined.netEquity + combined.cumulativeAfterTaxCashFlow - cashToDate;
      cum = combined.cumulativeAfterTaxCashFlow;
      rows.push(combined);
      yearLines.forEach((r, i) => {
        if (!r) return;
        perRows[i].push(r);
        ipBalances[i] = r.ipLoanClosingBalance;
      });
      totalTaxRefunds += Math.max(0, portfolioTax);
      totalInterest += combined.ipInterest + combined.equityLoanInterest;
    }

    const last = rows[rows.length - 1];
    const perTotals = perRows.map((rs) => {
      const l = rs[rs.length - 1];
      return {
        endingPropertyValue: l.propertyValue,
        endingDebt: l.totalDebt,
        endingEquity: l.netEquity,
        totalAfterTaxCashFlow: rs.reduce((s, r) => s + r.afterTaxCashFlow, 0),
      };
    });
    return {
      rows,
      upfront: aggregateUpfront(upfronts, inputs),
      perProperty: props.map((p, i) => ({
        upfront: upfronts[i],
        rows: perRows[i],
        totals: perTotals[i],
        equityShare: shares[i],
        offset: offsets[i],
      })),
      totalTaxRefunds,
      totalInterest,
      totals: {
        endingPropertyValue: last.propertyValue,
        endingDebt: last.totalDebt,
        endingEquity: last.netEquity,
        totalAfterTaxCashFlow: last.cumulativeAfterTaxCashFlow,
      },
    };
  }

  // =====================================================================
  // PPOR (home) cash flow — the home is a real property with running
  // costs and loan commitments. Pre-tax only: the home earns no income
  // and its costs aren't deductible (the deductible share of the top-up
  // interest is already assessed inside the portfolio's tax numbers).
  // Equity top-up lines reuse the portfolio's household-total schedule so
  // the two views can never disagree.
  // =====================================================================
  function pporProjection(inputs, portfolioRows) {
    const eg = num(inputs.expenseGrowthRate, 0);
    const inf = (y) => Math.pow(1 + eg, y - 1);
    const pAndI = inputs.pporRepaymentType === 'principal_and_interest';
    let balance = Math.max(0, num(inputs.pporLoanBalance, 0));
    const rows = [];
    for (let year = 1; year <= inputs.projectionYears; year++) {
      const councilRates = num(inputs.pporCouncilRatesAnnual, 0) * inf(year);
      const waterRates = num(inputs.pporWaterRatesAnnual, 0) * inf(year);
      const insurance = num(inputs.pporInsuranceAnnual, 0) * inf(year);
      const maintenance = num(inputs.pporMaintenanceAnnual, 0) * inf(year);
      let interest = 0;
      let principal = 0;
      if (balance > 0 && pAndI) {
        const remainingTerm = Math.max(1, num(inputs.pporLoanTermYearsRemaining, 25) - year + 1);
        const repayment = loanPayment(balance, inputs.pporInterestRate, remainingTerm);
        const step = advanceLoan(balance, inputs.pporInterestRate, 12, repayment);
        interest = step.interest;
        principal = step.principal;
      } else {
        interest = balance * inputs.pporInterestRate;
      }
      const closing = balance - principal;
      const port = portfolioRows[year - 1] || {};
      const eqInterest = num(port.equityLoanInterest, 0);
      const eqPrincipal = num(port.equityLoanPrincipalRepayment, 0);
      rows.push({
        year,
        calendarYear: port.calendarYear,
        councilRates,
        waterRates,
        insurance,
        maintenance,
        pporLoanOpeningBalance: balance,
        pporLoanInterest: interest,
        pporLoanPrincipalRepayment: principal,
        pporLoanClosingBalance: closing,
        pporInInterestOnly: balance > 0 && !pAndI,
        equityLoanInterest: eqInterest,
        equityLoanPrincipalRepayment: eqPrincipal,
        equityLoanDeductiblePortion: num(port.deductibleEquityInterest, 0),
        totalOutflow: councilRates + waterRates + insurance + maintenance +
          interest + principal + eqInterest + eqPrincipal,
      });
      balance = closing;
    }
    return rows;
  }

  // =====================================================================
  // Exit analysis (sale + CGT)
  // =====================================================================

  function exitAnalysis(rawInputs, projection, upfront) {
    const inputs = singleView(rawInputs);
    projection = projection || projectYears(inputs);
    upfront = upfront || projection.upfront;
    const rows = projection.rows;
    const saleYear = Math.min(inputs.saleYear, inputs.projectionYears);
    const row = rows[saleYear - 1];

    const salePrice = row.propertyValue;
    const sellingCosts = salePrice * inputs.sellingCostRate + inputs.sellingFixedCosts;

    // Cost base per s110-25 ITAA97: purchase price + incidental acquisition
    // costs. Capital works deductions CLAIMED reduce the cost base.
    const dep43Claimed = rows
      .slice(0, saleYear)
      .reduce((s, r) => s + r.capitalWorksDepreciation, 0);
    const costBase = Math.max(0,
      inputs.purchasePrice + upfront.acquisitionCosts - dep43Claimed);

    const capitalGain = salePrice - sellingCosts - costBase;
    const heldMoreThan12Months = saleYear >= 2; // full-year convention
    const discountRate = heldMoreThan12Months ? 0.5 : 0;
    const taxableGain = Math.max(0, capitalGain) * discountRate;

    // CGT is assessed on each owner at their marginal rate at sale time,
    // allocated by ownership share.
    let cgtRate;
    if (inputs.ownershipType === 'joint_50_50') {
      const r1 = marginalRate(inputs.owner1TaxableIncome * Math.pow(1 + inputs.otherTaxableIncomeGrowthRate, saleYear - 1), inputs.taxYear);
      const r2 = marginalRate(inputs.owner2TaxableIncome * Math.pow(1 + inputs.otherTaxableIncomeGrowthRate, saleYear - 1), inputs.taxYear);
      cgtRate = 0.5 * r1.combinedMarginalRate + 0.5 * r2.combinedMarginalRate;
    } else {
      cgtRate = marginalRate(inputs.owner1TaxableIncome * Math.pow(1 + inputs.otherTaxableIncomeGrowthRate, saleYear - 1), inputs.taxYear).combinedMarginalRate;
    }
    const capitalGainsTax = taxableGain * cgtRate;

    const netSaleProceeds = salePrice - sellingCosts - capitalGainsTax
      - row.ipLoanClosingBalance - row.equityLoanClosingBalance;
    const totalNetPosition = netSaleProceeds
      + row.cumulativeAfterTaxCashFlow - upfront.initialCashInvested;

    return {
      saleYear,
      calendarSaleYear: row.calendarYear,
      salePrice,
      sellingCosts,
      costBase,
      capitalWorksClaimed: dep43Claimed,
      capitalGain,
      heldMoreThan12Months,
      discountRate,
      taxableCapitalGain: taxableGain,
      cgtRate,
      capitalGainsTax,
      ipLoanBalanceAtSale: row.ipLoanClosingBalance,
      equityLoanBalanceAtSale: row.equityLoanClosingBalance,
      netSaleProceeds,
      totalNetPosition,
      warnings: [
        'CGT & negative gearing rules may change for events on/after 1 July 2027 (proposed 2026 reform, grandfathering applies to existing holdings). Confirm with a registered tax adviser.',
      ],
    };
  }

  // Per-property exits with same-year CGT stacking: a sale's marginal rate
  // is assessed on other income PLUS the taxable gains other properties
  // realise in the same calendar year. Each sale repays that property's IP
  // loan and its share of the equity top-up loan.
  function portfolioExits(inputs, projection, upfronts) {
    const props = inputs.properties;
    const pieces = props.map((p, i) => {
      const rows = projection.perProperty[i].rows;
      const saleYear = Math.min(p.saleYear, rows.length);
      const row = rows[saleYear - 1];
      const salePrice = row.propertyValue;
      const sellingCosts = salePrice * p.sellingCostRate + p.sellingFixedCosts;
      // Cost base per s110-25 ITAA97: purchase price + incidental
      // acquisition costs, less Div 43 deductions CLAIMED.
      const dep43 = rows.slice(0, saleYear).reduce((s, r) => s + r.capitalWorksDepreciation, 0);
      const costBase = Math.max(0, p.purchasePrice + upfronts[i].acquisitionCosts - dep43);
      const capitalGain = salePrice - sellingCosts - costBase;
      const discountRate = saleYear >= 2 ? 0.5 : 0; // full-year convention
      const taxableGain = Math.max(0, capitalGain) * discountRate;
      return {
        i, saleYear, row, salePrice, sellingCosts, costBase, dep43,
        capitalGain, discountRate, taxableGain, calendarSaleYear: row.calendarYear,
      };
    });

    return pieces.map((pc) => {
      const stack = pieces.reduce((s, o) =>
        s + (o.i !== pc.i && o.calendarSaleYear === pc.calendarSaleYear ? o.taxableGain : 0), 0);
      const merged = mergedProperty(inputs, pc.i);
      const growth = Math.pow(1 + num(merged.otherTaxableIncomeGrowthRate, 0), pc.saleYear - 1);
      const base1 = num(merged.owner1TaxableIncome, 0) * growth;
      let cgtRate;
      if (merged.ownershipType === 'joint_50_50') {
        const base2 = num(merged.owner2TaxableIncome, 0) * growth;
        cgtRate = 0.5 * marginalRate(base1 + stack, merged.taxYear).combinedMarginalRate
          + 0.5 * marginalRate(base2 + stack, merged.taxYear).combinedMarginalRate;
      } else {
        cgtRate = marginalRate(base1 + stack, merged.taxYear).combinedMarginalRate;
      }
      const capitalGainsTax = pc.taxableGain * cgtRate;
      const netSaleProceeds = pc.salePrice - pc.sellingCosts - capitalGainsTax
        - pc.row.ipLoanClosingBalance - pc.row.equityLoanClosingBalance;
      const cumulative = projection.perProperty[pc.i].rows
        .slice(0, pc.saleYear).reduce((s, r) => s + r.afterTaxCashFlow, 0);
      const totalNetPosition = netSaleProceeds + cumulative - upfronts[pc.i].initialCashInvested;
      return {
        saleYear: pc.saleYear,
        calendarSaleYear: pc.calendarSaleYear,
        salePrice: pc.salePrice,
        sellingCosts: pc.sellingCosts,
        costBase: pc.costBase,
        capitalWorksClaimed: pc.dep43,
        capitalGain: pc.capitalGain,
        heldMoreThan12Months: pc.saleYear >= 2,
        discountRate: pc.discountRate,
        taxableCapitalGain: pc.taxableGain,
        cgtRate,
        capitalGainsTax,
        ipLoanBalanceAtSale: pc.row.ipLoanClosingBalance,
        equityLoanBalanceAtSale: pc.row.equityLoanClosingBalance,
        netSaleProceeds,
        totalNetPosition,
        warnings: [
          'CGT & negative gearing rules may change for events on/after 1 July 2027 (proposed 2026 reform, grandfathering applies to existing holdings). Confirm with a registered tax adviser.',
        ],
      };
    });
  }

  // Portfolio-aggregate exit. For a single property this is field-for-field
  // identical to the property's own exit.
  function aggregateExit(exits) {
    const sum = (k) => exits.reduce((s, e) => s + e[k], 0);
    const lastYear = Math.max(...exits.map((e) => e.saleYear));
    const last = exits.find((e) => e.saleYear === lastYear);
    const taxable = sum('taxableCapitalGain');
    return {
      saleYear: lastYear,
      calendarSaleYear: last ? last.calendarSaleYear : null,
      salePrice: sum('salePrice'),
      sellingCosts: sum('sellingCosts'),
      costBase: sum('costBase'),
      capitalWorksClaimed: sum('capitalWorksClaimed'),
      capitalGain: sum('capitalGain'),
      heldMoreThan12Months: exits.every((e) => e.heldMoreThan12Months),
      discountRate: exits.length === 1 ? exits[0].discountRate : null,
      taxableCapitalGain: taxable,
      cgtRate: taxable > 0 ? sum('capitalGainsTax') / taxable : 0,
      capitalGainsTax: sum('capitalGainsTax'),
      ipLoanBalanceAtSale: sum('ipLoanBalanceAtSale'),
      equityLoanBalanceAtSale: sum('equityLoanBalanceAtSale'),
      netSaleProceeds: sum('netSaleProceeds'),
      totalNetPosition: sum('totalNetPosition'),
      warnings: [
        'CGT & negative gearing rules may change for events on/after 1 July 2027 (proposed 2026 reform, grandfathering applies to existing holdings). Confirm with a registered tax adviser.',
      ],
    };
  }

  // =====================================================================
  // Borrowing capacity (APRA-style serviceability estimate)
  // =====================================================================

  function borrowingCapacity(rawInputs) {
    const inputs = normalizeInputs(rawInputs);
    const views = inputs.properties.map((p, i) => mergedProperty(inputs, i));
    const buffer = num(inputs.bcBuffer, 0.03);
    const assess = (rate) => rate + buffer;

    const grossIncome =
      num(inputs.bcOwner1GrossIncome, 0) +
      num(inputs.bcOwner2GrossIncome, 0) +
      num(inputs.bcOtherIncome, 0);
    const haircut = num(inputs.bcRentalHaircut, 0.20);
    const rentAssessed = views.reduce((s, m) => s + m.weeklyRent * 52 * (1 - haircut), 0);
    const assessableIncome = grossIncome + rentAssessed;

    const living = num(inputs.bcLivingExpensesAnnual, 0);
    const otherDebt = num(inputs.bcOtherDebtRepaymentsAnnual, 0);
    const totalEquity = views.reduce((s, m) => s + Math.max(0, num(m.equityReleased, 0)), 0);

    // All loans assessed as P&I over a 30-year term at rate + buffer —
    // banks assess investment and IO loans this way regardless of the
    // actual repayment type.
    const pporRepay =
      loanPayment(inputs.pporLoanBalance, assess(inputs.pporInterestRate), 30) * 12;
    const equityRepay =
      loanPayment(totalEquity, assess(inputs.equityLoanRate), 30) * 12;
    const existingRepayments = pporRepay + equityRepay + otherDebt;

    // Every IP loan in the portfolio is assessed at its own rate + buffer.
    let proposedLoan = 0;
    let proposedRepay = 0;
    views.forEach((m) => {
      const f = fundingStructure(m);
      proposedLoan += f.ipLoanStart;
      proposedRepay += loanPayment(f.ipLoanStart, assess(m.ipInterestRate), 30) * 12;
    });

    const annualSurplus = assessableIncome - living - existingRepayments - proposedRepay;
    const monthlySurplus = annualSurplus / 12;

    // Invert the annuity formula: biggest loan whose P&I fits the surplus,
    // priced at the "next loan" rate.
    const r = assess(num(inputs.bcNewLoanRate, 0.065)) / 12;
    const n = 30 * 12;
    const maxNewLoan = monthlySurplus > 0 ? monthlySurplus * (1 - Math.pow(1 + r, -n)) / r : 0;

    const totalDebtAfter = inputs.pporLoanBalance + totalEquity + maxNewLoan;
    const dti = grossIncome > 0 ? totalDebtAfter / grossIncome : Infinity;

    return {
      assessmentBuffer: buffer,
      assessableIncome,
      rentAssessed,
      livingExpenses: living,
      existingRepayments,
      pporRepayAssessed: pporRepay,
      equityRepayAssessed: equityRepay,
      proposedLoan,
      proposedRepayAssessed: proposedRepay,
      monthlySurplus,
      annualSurplus,
      maxNewLoan,
      totalDebtAfter,
      estimatedDTI: Number.isFinite(dti) ? dti : null,
      warnings: [
        'APRA-style estimate — lenders assess differently (HEM floors, shading, policy overlays).',
        ...(dti > inputs.bcDtiWarn ? [`Total debt / income ≈ ${dti.toFixed(1)}x exceeds ${inputs.bcDtiWarn}x DTI comfort limit`] : []),
        ...(maxNewLoan <= 0 ? ['Surplus is negative at the assessed rate — no additional borrowing capacity'] : []),
      ],
    };
  }

  // Max new loan at different assessment rates, for the sensitivity chart.
  // Shifts every IP's assessed rate and the new-loan pricing rate together.
  function borrowingSensitivity(rawInputs) {
    const inputs = normalizeInputs(rawInputs);
    const out = [];
    const base = num(inputs.bcNewLoanRate, 0.065);
    for (let delta = -0.02; delta <= 0.03; delta += 0.005) {
      const variant = JSON.parse(JSON.stringify(inputs));
      variant.bcNewLoanRate = base + delta;
      variant.properties.forEach((p) => { p.ipInterestRate += delta; });
      const bc = borrowingCapacity(variant);
      out.push({ rateDelta: delta, rate: base + delta, maxNewLoan: bc.maxNewLoan });
    }
    return out;
  }

  // =====================================================================
  // Summary metrics + IRR
  // =====================================================================

  function irr(cashFlows) {
    // Bisection on NPV; returns null when no sign change (no IRR).
    const npv = (rate) =>
      cashFlows.reduce((s, cf, i) => s + cf / Math.pow(1 + rate, i), 0);
    let lo = -0.95, hi = 5;
    let fLo = npv(lo), fHi = npv(hi);
    if (fLo * fHi > 0) return null;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      const fMid = npv(mid);
      if (fLo * fMid <= 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
    }
    return (lo + hi) / 2;
  }

  // Weekly rent at which year-1 after-tax cash flow hits zero.
  function breakEvenRent(rawInputs, upfront) {
    const inputs = singleView(rawInputs);
    upfront = upfront || fundingStructure(inputs);
    let lo = 0, hi = Math.max(2000, inputs.weeklyRent * 3);
    const probe = Object.assign({}, inputs);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      probe.weeklyRent = mid;
      const p = projectYears(probe, upfront);
      if (p.rows[0].afterTaxCashFlow < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Per-property metrics — same key set as the portfolio metrics, computed
  // on the property's own rows and exit (tax/land-tax lines are allocations).
  function propertyMetrics(inputs, i, perProj, exitI) {
    const merged = mergedProperty(inputs, i);
    const upfront = perProj.upfront;
    const y1 = perProj.rows[0];
    const tenYear = perProj.rows[Math.min(10, perProj.rows.length) - 1];
    const grossYield = y1.grossRent / merged.purchasePrice;
    const netYield = (y1.effectiveRent - y1.operatingExpenses) / merged.purchasePrice;
    const cashOnCash = upfront.initialCashInvested > 0
      ? y1.afterTaxCashFlow / upfront.initialCashInvested
      : null;

    const flows = [-upfront.initialCashInvested];
    const saleYear = Math.min(merged.saleYear, perProj.rows.length);
    for (let y = 1; y <= saleYear; y++) {
      let cf = perProj.rows[y - 1].afterTaxCashFlow;
      if (y === saleYear) cf += exitI.netSaleProceeds;
      flows.push(cf);
    }

    return {
      purchasePrice: merged.purchasePrice,
      transferDuty: upfront.transferDuty,
      requiredFunds: upfront.requiredFunds,
      initialCashInvested: upfront.initialCashInvested,
      ipLoanAmount: upfront.ipLoanStart,
      ipLvrActual: upfront.ipLvrActual,
      grossYield,
      netYield,
      year1PreTaxCashFlow: y1.preTaxCashFlow,
      year1AfterTaxCashFlow: y1.afterTaxCashFlow,
      weeklyOutOfPocket: -y1.afterTaxCashFlow / 52,
      year1TaxRefund: y1.taxRefundOrCost,
      cashOnCashReturn: cashOnCash,
      tenYearEquity: tenYear.netEquity,
      tenYearWeeklyOutOfPocket: -tenYear.afterTaxCashFlow / 52,
      endingPropertyValue: perProj.totals.endingPropertyValue,
      endingEquity: perProj.totals.endingEquity,
      endingDebt: perProj.totals.endingDebt,
      totalTaxRefunds: perProj.rows.reduce((s, r) => s + Math.max(0, r.taxRefundOrCost), 0),
      totalInterestPaid: perProj.rows.reduce((s, r) => s + r.ipInterest + r.equityLoanInterest, 0),
      irrApproximation: irr(flows),
      breakEvenWeeklyRent: breakEvenRent(merged, upfront),
      saleYear,
      netSaleProceeds: exitI.netSaleProceeds,
      totalNetPosition: exitI.totalNetPosition,
    };
  }

  // Total weekly rent at which year-1 combined after-tax cash flow is zero.
  // Bisects a multiplier applied to every property's rent, so it degrades
  // exactly to the single-property break-even for a one-property portfolio.
  function portfolioBreakEven(inputs) {
    const upfronts = inputs.properties.map((p, i) => fundingStructure(mergedProperty(inputs, i)));
    let lo = 0;
    let hi = 3;
    const probe = JSON.parse(JSON.stringify(inputs));
    for (let i = 0; i < 40; i++) {
      const k = (lo + hi) / 2;
      probe.properties.forEach((p, j) => { p.weeklyRent = inputs.properties[j].weeklyRent * k; });
      const proj = projectPortfolio(probe, upfronts);
      if (proj.rows[0].afterTaxCashFlow < 0) lo = k; else hi = k;
    }
    const k = (lo + hi) / 2;
    return inputs.properties.reduce((s, p) => s + p.weeklyRent, 0) * k;
  }

  function summaryMetrics(inputs, projection, exit, exits) {
    const upfront = projection.upfront;
    const y1 = projection.rows[0];
    const tenYear = projection.rows[Math.min(10, projection.rows.length) - 1];
    const totalPrice = inputs.properties.reduce((s, p) => s + Math.max(0, p.purchasePrice), 0);
    const grossYield = totalPrice > 0 ? y1.grossRent / totalPrice : 0;
    const netYield = totalPrice > 0 ? (y1.effectiveRent - y1.operatingExpenses) / totalPrice : 0;
    const cashOnCash = upfront.initialCashInvested > 0
      ? y1.afterTaxCashFlow / upfront.initialCashInvested
      : null;

    // Portfolio IRR: cash invested lands at each property's settlement
    // year, combined after-tax flows run yearly, and each property's net
    // sale proceeds land in ITS sale year.
    const saleYear = Math.max(...exits.map((e) => e.saleYear));
    const offsets = purchaseOffsets(inputs);
    const drawYear = offsets.map((o) => o + 1);
    const startCash = projection.perProperty.reduce((s, pp, i) =>
      s + (drawYear[i] === 1 ? pp.upfront.initialCashInvested : 0), 0);
    const flows = [-startCash];
    for (let y = 1; y <= saleYear; y++) {
      let cf = projection.rows[y - 1].afterTaxCashFlow;
      projection.perProperty.forEach((pp, i) => {
        if (drawYear[i] > 1 && drawYear[i] === y) cf -= pp.upfront.initialCashInvested;
      });
      exits.forEach((e) => { if (e.saleYear === y) cf += e.netSaleProceeds; });
      flows.push(cf);
    }

    return {
      purchasePrice: totalPrice,
      transferDuty: upfront.transferDuty,
      requiredFunds: upfront.requiredFunds,
      initialCashInvested: upfront.initialCashInvested,
      ipLoanAmount: upfront.ipLoanStart,
      ipLvrActual: upfront.ipLvrActual,
      grossYield,
      netYield,
      year1PreTaxCashFlow: y1.preTaxCashFlow,
      year1AfterTaxCashFlow: y1.afterTaxCashFlow,
      weeklyOutOfPocket: -y1.afterTaxCashFlow / 52, // negative number = cost
      year1TaxRefund: y1.taxRefundOrCost,
      cashOnCashReturn: cashOnCash,
      tenYearEquity: tenYear.netEquity,
      tenYearWeeklyOutOfPocket: -tenYear.afterTaxCashFlow / 52,
      endingPropertyValue: projection.totals.endingPropertyValue,
      endingEquity: projection.totals.endingEquity,
      endingDebt: projection.totals.endingDebt,
      totalTaxRefunds: projection.totalTaxRefunds,
      totalInterestPaid: projection.totalInterest,
      irrApproximation: irr(flows),
      breakEvenWeeklyRent: portfolioBreakEven(inputs),
      saleYear,
      netSaleProceeds: exit.netSaleProceeds,
      totalNetPosition: exit.totalNetPosition,
    };
  }

  // =====================================================================
  // Investment score (PropCompare-style: transparent, editable inputs,
  // points per factor, graceful degradation when suburb data is missing)
  // =====================================================================

  function bandFromRatio(ratio) {
    if (ratio >= 0.8) return 'Strong';
    if (ratio >= 0.6) return 'Good';
    if (ratio >= 0.4) return 'Average';
    if (ratio > 0) return 'Below Average';
    return 'Poor';
  }

  function scoreBand(score) {
    if (score >= 90) return 'Exceptional';
    if (score >= 75) return 'Strong';
    if (score >= 65) return 'Good';
    if (score >= 50) return 'Average';
    if (score >= 35) return 'Below Average';
    return 'Poor';
  }

  function investmentScore(rawInputs, suburb) {
    const inputs = singleView(normalizeInputs(rawInputs));
    const price = Math.max(0, inputs.purchasePrice);
    const rentAnnual = inputs.weeklyRent * 52;
    const factors = [];
    const add = (key, label, value, display, points, maxPoints, rationale, source, scored = true) => {
      factors.push({
        key, label, value, display, points, maxPoints,
        band: bandFromRatio(maxPoints > 0 ? points / maxPoints : 0),
        rationale, source, scored,
      });
    };

    // 1. Gross yield (max 20) — needs only the calculator inputs.
    const grossYield = price > 0 ? (rentAnnual / price) * 100 : 0;
    add('grossYield', 'Gross rental yield', grossYield, grossYield.toFixed(2) + '%',
      grossYield >= 5.5 ? 20 : grossYield >= 5 ? 16 : grossYield >= 4.5 ? 12
        : grossYield >= 4 ? 8 : grossYield >= 3.5 ? 4 : 0,
      20,
      'Annual rent ÷ purchase price. Above ~5% the property largely funds itself.',
      'calculator inputs');

    // 2. Price vs suburb median (max 15).
    const median = suburb ? num(suburb.medianPrice, 0) : 0;
    if (median > 0) {
      const ratio = price / median;
      add('priceVsMedian', 'Price vs suburb median', ratio, ratio.toFixed(2) + 'x',
        ratio >= 0.75 && ratio <= 1.0 ? 15 : ratio < 0.75 ? 8
          : ratio <= 1.15 ? 10 : ratio <= 1.3 ? 5 : 2,
        15,
        'The 0.75–1.0x band historically has the most capital-growth headroom.',
        suburb && suburb.sources ? suburb.sources.medianPrice : null);
    } else {
      add('priceVsMedian', 'Price vs suburb median', null, 'no data', 0, 15,
        'Needs the suburb median sale price.', 'suburb data', false);
    }

    // 3. Land-to-value ratio (max 15) — inputs only.
    const landRatio = price > 0 ? inputs.landValue / price : 0;
    add('landToValue', 'Land-to-value ratio', landRatio, (landRatio * 100).toFixed(0) + '%',
      landRatio >= 0.6 ? 15 : landRatio >= 0.5 ? 12 : landRatio >= 0.4 ? 8
        : landRatio >= 0.3 ? 4 : 1,
      15,
      'Land appreciates, buildings depreciate — a high land share drives long-term growth.',
      'calculator inputs');

    // 4. Suburb vacancy (max 15).
    const vacancy = suburb ? num(suburb.vacancyPct, -1) : -1;
    if (vacancy >= 0) {
      add('vacancy', 'Suburb vacancy rate', vacancy, vacancy.toFixed(1) + '%',
        vacancy <= 1 ? 15 : vacancy <= 1.5 ? 13 : vacancy <= 2 ? 11
          : vacancy <= 3 ? 7 : vacancy <= 4 ? 3 : 0,
        15,
        'Under 2% signals strong rental demand — fewer empty weeks between tenants.',
        suburb && suburb.sources ? suburb.sources.vacancyPct : null);
    } else {
      add('vacancy', 'Suburb vacancy rate', null, 'no data', 0, 15,
        'Needs the suburb vacancy rate (SQM Research).', 'suburb data', false);
    }

    // 5. Suburb 5-year capital growth (max 15).
    const growth5 = suburb ? num(suburb.growth5yrPct, null) : null;
    if (growth5 !== null && growth5 !== undefined) {
      add('growth5yr', 'Suburb 5-yr capital growth', growth5, growth5.toFixed(0) + '%',
        growth5 >= 40 ? 15 : growth5 >= 30 ? 12 : growth5 >= 20 ? 9
          : growth5 >= 10 ? 6 : growth5 >= 0 ? 3 : 0,
        15,
        'Total house-price growth over the last five years.',
        suburb && suburb.sources ? suburb.sources.growth5yrPct : null);
    } else {
      add('growth5yr', 'Suburb 5-yr capital growth', null, 'no data', 0, 15,
        'Needs the suburb 5-year growth figure.', 'suburb data', false);
    }

    // 6. Entered rent vs suburb median for the bedroom count (max 10).
    const beds = Math.round(num(inputs.bedrooms, 3));
    const rentKey = beds >= 2 && beds <= 4 ? `medianRent${beds}Bed` : null;
    const medianRent = rentKey && suburb ? num(suburb[rentKey], 0) : 0;
    if (medianRent > 0) {
      const ratio = inputs.weeklyRent / medianRent;
      add('rentVsMedian', `Your rent vs suburb ${beds}-bed median`, ratio, ratio.toFixed(2) + 'x',
        ratio >= 1.05 ? 10 : ratio >= 0.95 ? 8 : ratio >= 0.85 ? 5 : 2,
        10,
        'Your rent is ' + (ratio >= 1.05 ? 'above' : ratio >= 0.85 ? 'near' : 'well below')
          + ' the suburb median — sanity-check your assumption.',
        suburb && suburb.sources ? suburb.sources[rentKey] : null);
    } else {
      add('rentVsMedian', `Your rent vs suburb median (${beds}-bed)`, null, 'no data', 0, 10,
        'Needs the suburb median rent for this bedroom count.', 'suburb data', false);
    }

    // 7. Supply pressure from building approvals (max 10).
    const approvals = suburb ? num(suburb.approvalsRatio, -1) : -1;
    if (approvals >= 0) {
      // approvalsRatio is stored as a percent of dwelling stock (1.1 = 1.1%).
      add('supplyPressure', 'Supply pressure (approvals)', approvals, approvals.toFixed(1) + '% of stock',
        approvals < 0.5 ? 10 : approvals <= 1 ? 7 : approvals <= 1.5 ? 4 : 1,
        10,
        'Annual building approvals as % of dwellings — heavy new supply caps rent and price growth.',
        suburb && suburb.sources ? suburb.sources.approvalsRatio : null);
    } else {
      add('supplyPressure', 'Supply pressure (approvals)', null, 'no data', 0, 10,
        'Needs the building-approvals ratio (estimate).', 'suburb data', false);
    }

    const scored = factors.filter((f) => f.scored);
    const pts = scored.reduce((s, f) => s + f.points, 0);
    const max = scored.reduce((s, f) => s + f.maxPoints, 0);
    const score = max > 0 ? Math.round((100 * pts) / max) : 0;
    return {
      score,
      band: scoreBand(score),
      scoredMax: max,
      factors,
      missing: factors.filter((f) => !f.scored).map((f) => f.key),
    };
  }

  // Derived metrics for one comparable sale, relative to the subject property.
  function compDerivations(comp, rawInputs) {
    const inputs = singleView(normalizeInputs(rawInputs));
    const price = Math.max(0, num(comp.soldPrice, 0));
    const land = Math.max(0, num(comp.landM2, 0));
    const rent = Math.max(0, num(comp.rentEstimate, 0));
    return {
      perM2: land > 0 ? price / land : null,
      impliedGrossYield: price > 0 && rent > 0 ? (rent * 52) / price : null,
      priceRatio: price > 0 && inputs.purchasePrice > 0 ? price / inputs.purchasePrice : null,
    };
  }

  // =====================================================================
  // Glue
  // =====================================================================

  function calculateAll(rawInputs, opts) {
    opts = opts || {};
    const inputs = normalizeInputs(rawInputs);
    const props = inputs.properties;
    const multi = props.length > 1;
    const tag = (i, msg) => (multi ? `IP ${i + 1} — ${msg}` : msg);
    const warnings = [];
    const propertyWarnings = props.map(() => []);

    // Post-2017 law: no plant & equipment deductions on second-hand homes.
    props.forEach((p, i) => {
      if (!p.isNewBuild && p.plantEquipmentEligible) {
        p.plantEquipmentEligible = false;
        const msg = 'Second-hand residential property: plant & equipment depreciation on prior owners\' assets is not deductible (post-2017 rule) — switched off.';
        propertyWarnings[i].push(msg);
        warnings.push(tag(i, msg));
      }
    });

    const views = props.map((p, i) => mergedProperty(inputs, i));
    const upfronts = views.map((m) => fundingStructure(m));

    // Per-property projection-level warnings: funding shortfall + IO->P&I.
    upfronts.forEach((u, i) => {
      u.warnings.forEach((msg) => {
        propertyWarnings[i].push(msg);
        warnings.push(tag(i, msg));
      });
      if (ioSwitchInsideWindow(views[i])) {
        const msg = `Repayments switch from interest-only to P&I in year ${effectiveIoYears(views[i]) + 1} — watch the cash flow jump`;
        propertyWarnings[i].push(msg);
        warnings.push(tag(i, msg));
      }
    });

    // Joint land-tax split warning is QLD-only (other states assess the
    // aggregate once — no split approximation to caveat).
    if (inputs.state === 'QLD' &&
        inputs.ownershipType === 'joint_50_50' && inputs.includeLandTax !== false) {
      const aggregateLand = props.reduce((s, p) => s + num(p.landValue, 0), 0)
        + num(inputs.otherAuLandValue, 0);
      if (aggregateLand >= QLD_LAND_TAX_BANDS[0].from) warnings.push(JOINT_LAND_TAX_WARNING);
    }

    const projection = projectPortfolio(inputs, upfronts);
    const pporRows = pporProjection(inputs, projection.rows);
    const exits = portfolioExits(inputs, projection, upfronts);
    const exit = aggregateExit(exits);
    const metrics = summaryMetrics(inputs, projection, exit, exits);
    const borrowing = borrowingCapacity(inputs);

    warnings.push(...exit.warnings, ...borrowing.warnings);
    upfronts.forEach((u, i) => {
      if (u.lmi && u.lmi.warning) {
        propertyWarnings[i].push(u.lmi.warning);
        warnings.push(tag(i, u.lmi.warning));
      }
    });
    if (inputs.equityLoanPurposePercent < 1) {
      warnings.push('Equity-loan interest is deductible only for the investment-purpose share (loan tracing rules). Confirm with your accountant.');
    }
    const totalEquity = props.reduce((s, p) => s + Math.max(0, num(p.equityReleased, 0)), 0);
    if (inputs.pporValue > 0 && totalEquity > inputs.pporValue * 0.8) {
      warnings.push(`Equity release of $${Math.round(totalEquity).toLocaleString()} is more than 80% of your PPOR value ($${Math.round(inputs.pporValue).toLocaleString()}) — lenders cap total lending against a home near 80% LVR; check with your bank.`);
    }

    const properties = props.map((p, i) => ({
      index: i,
      label: p.label,
      ownershipStatus: p.ownershipStatus,
      upfront: upfronts[i],
      rows: projection.perProperty[i].rows,
      totals: projection.perProperty[i].totals,
      equityShare: projection.perProperty[i].equityShare,
      exit: exits[i],
      metrics: propertyMetrics(inputs, i, projection.perProperty[i], exits[i]),
      score: investmentScore(views[i], opts.suburb || null),
    }));

    return {
      inputs,
      upfront: projection.upfront,
      metrics,
      rows: projection.rows,
      totals: projection.totals,
      ppor: { rows: pporRows },
      exit,
      borrowing,
      borrowingSensitivity: borrowingSensitivity(inputs),
      landTaxYear1: projection.rows[0].landTax,
      score: properties.length ? properties[0].score : null,
      scores: properties.map((p) => p.score),
      properties,
      propertyWarnings,
      warnings,
      rateLabels: rateLabels(inputs.state),
    };
  }

  // =====================================================================
  // Growth scenarios + buyer risk checklist
  // =====================================================================

  // The same portfolio at 3% / 5% / 7% capital growth — the "what if the
  // market under/over-performs" bands from the product spec. Pure client
  // recompute; every other assumption stays fixed.
  function growthScenarios(rawInputs) {
    const inputs = normalizeInputs(rawInputs);
    return [0.03, 0.05, 0.07].map((g) => {
      const variant = JSON.parse(JSON.stringify(inputs));
      variant.properties.forEach((p) => { p.expectedCapitalGrowthRate = g; });
      const r = calculateAll(variant);
      return {
        growth: g,
        tenYearEquity: r.metrics.tenYearEquity,
        netSaleProceeds: r.exit.netSaleProceeds,
        totalNetPosition: r.exit.totalNetPosition,
        irr: r.metrics.irrApproximation,
      };
    });
  }

  // Inputs reduced to purchased properties only — the portfolio roll-ups
  // (dashboard totals, mix chart, projections, exit) compute on this view.
  // null when nothing is purchased: callers must show an empty state rather
  // than let calculateAll pad a phantom default property (engine.js normalize).
  function ownedInputs(rawInputs) {
    const inputs = normalizeInputs(rawInputs);
    const owned = inputs.properties.filter((p) => p.ownershipStatus === 'purchased');
    if (!owned.length) return null;
    const out = JSON.parse(JSON.stringify(inputs));
    out.properties = owned;
    return out;
  }

  // Buyer due-diligence prompts derived from inputs + suburb data.
  // status: 'ok' | 'warn' | 'unknown' — unknowns are things the app has
  // no data for and MUST be verified manually before purchase.
  // Deal-level verdicts (Deal Check page phase 2): the property's own
  // numbers scored against the linked suburb row — price, yield, cash flow,
  // vacancy, rent positioning, growth. Pure; census verdicts live in the
  // server's census.py and the page blends both halves. weeklyOutOfPocket is
  // positive when you are paying. Band scores: linear between [x, score]
  // points, clamped; 100 is always best for the deal.
  function bandScore(v, points) {
    if (!Number.isFinite(v)) return null;
    if (v <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (v <= points[i][0]) {
        const x0 = points[i - 1][0], s0 = points[i - 1][1];
        const x1 = points[i][0], s1 = points[i][1];
        return x1 > x0 ? s0 + (s1 - s0) * (v - x0) / (x1 - x0) : s1;
      }
    }
    return points[points.length - 1][1];
  }

  function dealStatus(score) {
    return score >= 65 ? 'strong' : score >= 40 ? 'ok' : 'watch';
  }

  function rentMedianFor(suburb, bedrooms) {
    if (!suburb) return null;
    const b = Number(bedrooms) || 0;
    const key = b <= 2 ? 'medianRent2Bed' : (b === 3 ? 'medianRent3Bed' : 'medianRent4Bed');
    const v = Number(suburb[key]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  function dealVerdicts(rawInputs, metrics, suburb) {
    const inputs = singleView(normalizeInputs(rawInputs));
    const price = num(inputs.purchasePrice, 0);
    const rent = num(inputs.weeklyRent, 0);
    const beds = num(inputs.bedrooms, 0);
    const out = [];
    const push = (key, question, headlines, score, chips) => {
      const s = score == null ? null : Math.round(Math.max(0, Math.min(100, score)));
      out.push({ key, question, group: 'deal',
        status: s == null ? 'nodata' : dealStatus(s), score: s,
        headline: s == null ? headlines.nodata : headlines[dealStatus(s)],
        metrics: chips.filter(Boolean) });
    };
    const chip = (label, value, unit, dp, benchmark, opts) => ({
      label, value: Number.isFinite(value) ? value : null, unit, dp: dp != null ? dp : 0,
      benchmark: Number.isFinite(benchmark) ? benchmark : null, percentile: null,
      better: (opts && opts.better) || null, note: (opts && opts.note) || null,
    });

    // 1. Price vs suburb median. suburb.medianPrice may come from the user's
    // suburb table or a Valuer-General fallback (medianPriceSource set).
    const medPrice = suburb ? num(suburb.medianPrice, 0) : 0;
    const medPriceNote = 'All-dwelling median — adjust for size and condition'
      + (suburb && suburb.medianPriceSource ? ' · ' + suburb.medianPriceSource : '');
    const priceRatio = price > 0 && medPrice > 0 ? price / medPrice : null;
    push('price_vs_market', 'Are you paying a fair price for this suburb?', {
      nodata: 'Link a suburb (or set a located VIC address) to check the price.',
      strong: 'Priced at or below the suburb median — fair value.',
      ok: 'Slightly above the suburb median — pay up only for verified quality.',
      watch: 'Well above the suburb median — be clear what the premium buys.',
    }, priceRatio == null ? null : bandScore(priceRatio,
      [[0.7, 100], [0.9, 85], [1.0, 68], [1.1, 50], [1.25, 30], [1.4, 12]]),
    [chip('Purchase price', price, '$', 0),
     chip('Suburb median (all dwellings)', medPrice || null, '$', 0, null,
          { note: medPriceNote }),
     priceRatio == null ? null : chip('Price / median', priceRatio, '×', 2)]);

    // 2. Gross yield.
    const grossYield = metrics ? num(metrics.grossYield, NaN) : NaN;
    const yPct = Number.isFinite(grossYield) ? grossYield * 100 : null;
    push('gross_yield', 'Does the rent justify the price?', {
      nodata: 'Enter price and rent to score the yield.',
      strong: 'Healthy gross yield for the price paid.',
      ok: 'Middle-of-the-road yield — rent roughly services the price.',
      watch: 'Thin yield — the rent barely services the price.',
    }, yPct == null ? null : bandScore(yPct,
      [[3, 10], [3.8, 40], [4.4, 65], [5.2, 85], [6, 100]]),
    [chip('Gross yield', yPct, '%', 2, null,
          { note: 'Rent × 52 ÷ price, before costs' }),
     chip('Weekly rent', rent, '$', 0)]);

    // 3. Cash flow.
    const wop = metrics ? num(metrics.weeklyOutOfPocket, NaN) : NaN;
    push('cash_flow', 'What does it cost you to hold?', {
      nodata: 'Complete the inputs to score the holding cost.',
      strong: 'Pays for itself — little or nothing out of pocket.',
      ok: 'Modest weekly contribution required.',
      watch: 'Heavy weekly contribution — you, not the tenant, carry it.',
    }, Number.isFinite(wop) ? bandScore(wop,
      [[-30, 100], [0, 82], [15, 68], [40, 42], [80, 12], [150, 0]]) : null,
    [chip('Weekly after-tax position', wop, '$', 0, null,
          { note: 'Negative = in pocket' }),
     chip('Year-1 after-tax cash flow',
          metrics ? num(metrics.year1AfterTaxCashFlow, NaN) : NaN, '$', 0)]);

    // 4. Vacancy.
    const vacancy = suburb ? num(suburb.vacancyPct, NaN) : NaN;
    push('vacancy_risk', 'How quickly will it lease?', {
      nodata: 'Add suburb vacancy data to score lease-up risk.',
      strong: 'Tight rental market — tenants compete.',
      ok: 'Normal vacancy — lease-up is routine.',
      watch: 'Loose market — expect gaps between tenancies.',
    }, Number.isFinite(vacancy) ? bandScore(vacancy,
      [[1, 100], [2, 75], [3.5, 42], [5, 15], [7, 0]]) : null,
    [chip('Vacancy', vacancy, '%', 1, null,
          { note: 'Above ~3% landlords compete for tenants' })]);

    // 5. Rent positioning vs the suburb median for this bedroom count.
    const medRent = rentMedianFor(suburb, beds);
    const rentRatio = rent > 0 && medRent ? rent / medRent : null;
    push('rent_positioning', 'Is the rent assumption realistic?', {
      nodata: 'Add suburb rent data for this bedroom count to check the asking rent.',
      strong: 'Rent at or below the suburb median — very lettable.',
      ok: 'Asking slightly above the suburb median — condition must back it.',
      watch: 'Rent well above the suburb median — the assumption is optimistic.',
    }, rentRatio == null ? null : bandScore(rentRatio,
      [[0.85, 95], [1.0, 85], [1.15, 68], [1.3, 42], [1.5, 15]]),
    [chip('Asking rent', rent, '$', 0),
     medRent ? chip(`Suburb median rent (${beds <= 2 ? '≤2' : beds}-bed)`, medRent, '$', 0) : null,
     rentRatio == null ? null : chip('Rent / median', rentRatio, '×', 2)]);

    // 6. Growth outlook.
    const growth = suburb ? num(suburb.growth5yrPct, NaN) : NaN;
    push('growth_outlook', 'What is the growth track record?', {
      nodata: 'Add suburb growth data to score the track record.',
      strong: 'Suburb prices have grown strongly over five years.',
      ok: 'Modest historical growth.',
      watch: 'Flat or falling suburb prices over five years.',
    }, Number.isFinite(growth) ? bandScore(growth,
      [[0, 15], [4, 45], [8, 65], [12, 82], [20, 95]]) : null,
    [chip('5-yr price growth', growth, '%', 1),
     chip('Population growth', suburb ? num(suburb.populationGrowthPct, NaN) : NaN, '%', 2),
     chip('Approvals ratio', suburb ? num(suburb.approvalsRatio, NaN) : NaN, '', 2, null,
          { note: 'Approvals vs stock: <1 undersupply, >1.5 oversupply risk' })]);

    const scored = out.filter((v) => v.score != null).map((v) => v.score);
    return { verdicts: out,
      avg: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null };
  }

  function riskChecklist(rawInputs, suburb) {
    const inputs = singleView(normalizeInputs(rawInputs));
    const checks = [];
    const add = (key, label, status, detail) => checks.push({ key, label, status, detail });

    // Land share — the growth driver.
    const price = num(inputs.purchasePrice, 0);
    const landRatio = price > 0 ? inputs.landValue / price : null;
    if (landRatio === null) {
      add('landShare', 'Land share of purchase price', 'unknown', 'Enter purchase price and land value.');
    } else if (landRatio >= 0.4) {
      add('landShare', 'Land share of purchase price', 'ok',
        `Land is ${(landRatio * 100).toFixed(0)}% of the price — a strong growth driver.`);
    } else if (landRatio >= 0.25) {
      add('landShare', 'Land share of purchase price', 'warn',
        `Land is only ${(landRatio * 100).toFixed(0)}% of the price — buildings depreciate, land appreciates.`);
    } else {
      add('landShare', 'Land share of purchase price', 'warn',
        `Land is just ${(landRatio * 100).toFixed(0)}% of the price — most of your money is in the building.`);
    }

    // Capital works window (Div 43 runs 40 years from construction).
    const age = num(inputs.purchaseYear, 2026) - num(inputs.buildYear, 2026);
    if (age < 0) {
      add('capitalWorks', 'Building age / depreciation', 'ok', 'Off-the-plan or new build — full 40-year Div 43 window.');
    } else if (age < 40) {
      add('capitalWorks', 'Building age / depreciation', 'ok',
        `Built ~${inputs.buildYear} — capital works claimable for about ${40 - age} more years.`);
    } else {
      add('capitalWorks', 'Building age / depreciation', 'warn',
        'Construction older than 40 years — capital works deductions are exhausted.');
    }

    // Strata.
    if (num(inputs.bodyCorporateAnnual, 0) > 0) {
      add('strata', 'Strata / body corporate', 'warn',
        'Strata-titled: review the sinking fund balance and committee minutes before buying — special levies can be brutal.');
    } else {
      add('strata', 'Strata / body corporate', 'ok', 'No body corporate fees entered (house on its own title).');
    }

    // Loan risk.
    const lvr = num(inputs.ipLvr, 0);
    if (lvr > 0.95) {
      add('lvr', 'Loan-to-value ratio', 'warn', `${(lvr * 100).toFixed(0)}% LVR — most lenders decline above 95%; no buffer for rate rises.`);
    } else if (lvr > 0.9) {
      add('lvr', 'Loan-to-value ratio', 'warn', `${(lvr * 100).toFixed(0)}% LVR — expect LMI and a thin equity buffer if values dip.`);
    } else {
      add('lvr', 'Loan-to-value ratio', 'ok', `${(lvr * 100).toFixed(0)}% LVR.`);
    }

    // Interest-only cliff.
    const ioYears = effectiveIoYears(inputs);
    if (ioSwitchInsideWindow(inputs)) {
      add('ioCliff', 'Interest-only expiry', 'warn',
        `Repayments switch to P&I in year ${ioYears + 1} — model the repayment jump before committing.`);
    } else if (ioYears > 0) {
      add('ioCliff', 'Interest-only expiry', 'ok', `IO period ends outside the ${inputs.projectionYears}-year window.`);
    } else {
      add('ioCliff', 'Interest-only expiry', 'ok', 'P&I from day one — no repayment cliff.');
    }

    // Suburb vacancy.
    const vacancy = suburb ? num(suburb.vacancyPct, null) : null;
    if (vacancy === null || vacancy < 0) {
      add('vacancy', 'Suburb vacancy rate', 'unknown', 'Pick the suburb in Inputs (or check SQM Research) — persistent high vacancy kills rent reliability.');
    } else if (vacancy > 3) {
      add('vacancy', 'Suburb vacancy rate', 'warn', `${vacancy.toFixed(1)}% vacancy — weak rental demand; expect longer voids and softer rents.`);
    } else if (vacancy > 2) {
      add('vacancy', 'Suburb vacancy rate', 'warn', `${vacancy.toFixed(1)}% vacancy — adequate but watch the trend.`);
    } else {
      add('vacancy', 'Suburb vacancy rate', 'ok', `${vacancy.toFixed(1)}% vacancy — strong rental demand.`);
    }

    // Rent vs suburb median.
    const beds = Math.round(num(inputs.bedrooms, 3));
    const rentKey = beds >= 2 && beds <= 4 ? `medianRent${beds}Bed` : null;
    const medianRent = rentKey && suburb ? num(suburb[rentKey], 0) : 0;
    if (medianRent > 0) {
      const ratio = inputs.weeklyRent / medianRent;
      if (ratio > 1.1) {
        add('rentVsMedian', 'Rent vs suburb median', 'warn',
          `Your $${inputs.weeklyRent}/wk is ${((ratio - 1) * 100).toFixed(0)}% above the ${beds}-bed median — the assumption may be optimistic.`);
      } else if (ratio < 0.85) {
        add('rentVsMedian', 'Rent vs suburb median', 'warn',
          `Your $${inputs.weeklyRent}/wk is well below the ${beds}-bed median — check the property's condition or the comparables.`);
      } else {
        add('rentVsMedian', 'Rent vs suburb median', 'ok', `In line with the ${beds}-bed median ($${medianRent}/wk).`);
      }
    } else {
      add('rentVsMedian', 'Rent vs suburb median', 'unknown', 'Needs suburb median rent for this bedroom count.');
    }

    // Overlay risk — no data source; must be checked manually.
    add('overlays', 'Flood / bushfire / heritage overlays', 'unknown',
      'Check the council overlay map and a property report — this app has no overlay data, and an overlay can cap insurance, finance and value.');

    return { checks };
  }

  // =====================================================================
  // Exports
  // =====================================================================

  const PAEngine = {
    DEFAULT_INPUTS,
    DEFAULT_PROPERTY,
    PROPERTY_KEYS,
    MAX_PROPERTIES,
    RATE_LABELS,
    RATE_LABELS_BY_STATE,
    STATE_TABLES,
    rateLabels,
    transferDuty,
    landTax,
    normalizeInputs,
    transferDutyQLD,
    landTaxQLD,
    marginalRate,
    incomeTaxEstimate,
    ownerTaxSplit,
    lmiEstimate,
    loanPayment,
    advanceLoan,
    loanBalanceAtYear,
    fundingStructure,
    yearProjection,
    projectYears,
    pporProjection,
    exitAnalysis,
    borrowingCapacity,
    borrowingSensitivity,
    irr,
    summaryMetrics,
    investmentScore,
    scoreBand,
    compDerivations,
    growthScenarios,
    ownedInputs,
    riskChecklist,
    dealVerdicts,
    calculateAll,
  };

  global.PropertyAnalyserEngine = PAEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = PAEngine;
})(typeof window !== 'undefined' ? window : globalThis);
