/* Copyright (c) 2026 RV
 *
 * Engine test suite — plain Node, no framework. Run: node tests/test_engine.js
 *
 * Known-answer checks against the official QRO / ATO tables, plus
 * behavioural invariants (cash vs deduction rules, reconciliation
 * identities) from the design plan.
 */

const assert = require('assert');
const E = require('../static/engine.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected, tol = 0.01) {
  try {
    if (typeof expected === 'number') {
      assert.ok(Math.abs(actual - expected) <= tol,
        `expected ~${expected}, got ${actual}`);
    } else {
      assert.deepStrictEqual(actual, expected);
    }
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err.message}`);
  }
}

function checkTrue(name, cond, msg) {
  try {
    assert.ok(cond, msg);
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${msg}`);
  }
}

// =====================================================================
// QLD transfer duty — QRO standard table
// =====================================================================

check('duty $5,000', E.transferDutyQLD(5000).duty, 0);
check('duty $5,001', E.transferDutyQLD(5001).duty, 1.50);
check('duty $75,000', E.transferDutyQLD(75000).duty, 1050);
check('duty $540,000', E.transferDutyQLD(540000).duty, 17325);
check('duty $750,000', E.transferDutyQLD(750000).duty, 26775);
check('duty $1,000,000', E.transferDutyQLD(1000000).duty, 38025);
check('duty $1,000,001', E.transferDutyQLD(1000001).duty, 38030.75);

// =====================================================================
// QLD land tax — individuals, AU-wide aggregation
// =====================================================================

check('land tax $599,999', E.landTaxQLD(599999, 'sole').landTax, 0);
check('land tax $600,000', E.landTaxQLD(600000, 'sole').landTax, 500);
check('land tax $680,000', E.landTaxQLD(680000, 'sole').landTax, 1300);
check('land tax $1,000,000', E.landTaxQLD(1000000, 'sole').landTax, 4500);
check('land tax $1,500,000', E.landTaxQLD(1500000, 'sole').landTax, 12750);
checkTrue('joint ownership returns warning',
  E.landTaxQLD(1400000, 'joint_50_50').warning !== null,
  'joint assessment should flag its approximation');


// =====================================================================
// Marginal rates (bracket + 2% Medicare)
// =====================================================================

check('marginal $18,200', E.marginalRate(18200).combinedMarginalRate, 0.02);
check('marginal $45,000', E.marginalRate(45000).combinedMarginalRate, 0.17);
check('marginal $135,000', E.marginalRate(135000).combinedMarginalRate, 0.32);
check('marginal $190,000', E.marginalRate(190000).combinedMarginalRate, 0.39);
check('marginal $190,001', E.marginalRate(190001).combinedMarginalRate, 0.47);

// Income tax estimate 2026-27 rates: $150,000
// 18200x0 + (45000-18200)x.15 + (135000-45000)x.30 + 15000x.37 = 36,570
const it = E.incomeTaxEstimate(150000);
check('income tax $150k', it.incomeTax, 36570);
check('medicare $150k', it.medicareLevy, 3000);

// =====================================================================
// LMI bands
// =====================================================================

check('LMI at 80% LVR', E.lmiEstimate(600000, 0.80).premium, 0);
check('LMI at 85% LVR', E.lmiEstimate(637500, 0.85).premium, 637500 * 0.0031, 1);
check('LMI at 90% LVR', E.lmiEstimate(675000, 0.90).premium, 675000 * 0.0104, 1);
check('LMI at 95% LVR', E.lmiEstimate(712500, 0.95).premium, 712500 * 0.0215, 1);
checkTrue('LMI warns above 95%',
  E.lmiEstimate(720000, 0.96).warning !== null);

// =====================================================================
// Loan maths
// =====================================================================

// $600k at 6.5% over 30 years: M = P·r/(1-(1+r)^-n) = $3,792.41
check('P&I payment 600k/30y/6.5%', E.loanPayment(600000, 0.065, 30), 3792.41, 0.5);

// IO balance never moves
check('IO balance constant',
  E.loanBalanceAtYear(600000, 0.065, 30, 'interest_only', 5, 20), 600000);

// P&I from day one declines: balance after 5 years < start
const bal5 = E.loanBalanceAtYear(600000, 0.065, 30, 'principal_and_interest', 0, 5);
checkTrue('P&I balance declines', bal5 < 600000 && bal5 > 500000,
  `balance after 5y should be ~$558k, got ${bal5}`);

// IO intro period (5y) on a P&I loan: balance flat through IO, then drops
const bal5io = E.loanBalanceAtYear(600000, 0.065, 30, 'principal_and_interest', 5, 5);
check('IO intro: flat during IO', bal5io, 600000);
const bal6io = E.loanBalanceAtYear(600000, 0.065, 30, 'principal_and_interest', 5, 6);
checkTrue('IO intro: principal starts after IO',
  bal6io < 600000 && bal6io > 585000,
  `balance in first P&I year should be ~$590k, got ${bal6io}`);

// =====================================================================
// Upfront / funding structure
// =====================================================================

const up = E.fundingStructure(E.normalizeInputs({}));
check('default duty', up.transferDuty, 26775);
check('default IP loan at 80% LVR', up.ipLoanStart, 600000);
check('no LMI at 80% LVR', up.lmi.premium, 0);
check('required funds', up.requiredFunds,
  750000 + 26775 + 2500 + 600 + 800 + 0 + 600, 0);
checkTrue('funding covers required (no shortfall)', up.shortfall <= 0,
  `shortfall was ${up.shortfall}`);
check('initial cash zero when fully geared', up.initialCashInvested, 0);

// 90% LVR triggers capitalised LMI
const up90 = E.fundingStructure(E.normalizeInputs({ ipLvr: 0.90 }));
checkTrue('90% LVR capitalises LMI into loan',
  up90.ipLoanStart > 675000 && up90.lmi.premium > 0);

// bank-quoted LMI override wins over the estimate
const upQuote = E.fundingStructure(E.normalizeInputs({
  ipLoanAmountOverride: 594466, lmiOverride: 9758,
}));
check('quoted LMI used as-is', upQuote.lmi.premium, 9758, 0);
check('quoted LMI capitalised into loan', upQuote.ipLoanStart, 604224, 0);
checkTrue('quoted LMI flagged', upQuote.lmi.quoted === true);

// =====================================================================
// Projection invariants
// =====================================================================

const res = E.calculateAll({});
const y1 = res.rows[0];

// Year 1 numbers against a hand calculation
check('y1 effective rent', y1.effectiveRent, (620 * 52) - (2 * 620));
check('y1 IP interest (IO)', y1.ipInterest, 600000 * 0.065);
check('y1 equity interest (IO)', y1.equityLoanInterest, 200000 * 0.062);
check('y1 capital works dep', y1.capitalWorksDepreciation, 300000 * 0.025);
check('y1 plant dep (new build)', y1.plantEquipmentDepreciation, 3500);

// taxable result: rent - opex - ipInt - eqInt - deps (land tax 0 here)
// opex = PM 7% + letting 620/2 + 2400 + 900 + 1800 + maint 1% of 750000
const opexHand = 31000 * 0.07 + 310 + 2400 + 900 + 1800 + 7500;
check('y1 opex', y1.operatingExpenses, opexHand, 1);
const taxableHand = 31000 - opexHand - 39000 - 12400 - 7500 - 3500;
check('y1 taxable result', y1.taxablePropertyResult, taxableHand, 1);

// refund at 39% (150k income -> 37% bracket + 2% medicare)
check('y1 tax refund', y1.taxRefundOrCost, -taxableHand * 0.39, 1);

// depreciation affects tax, NOT cash: bump dep and confirm pre-tax CF unchanged
const resMoreDep = E.calculateAll({ capitalWorksBase: 400000 });
check('dep reduces taxable result', resMoreDep.rows[0].taxablePropertyResult,
  taxableHand - (400000 * 0.025 - 300000 * 0.025), 1);
check('dep does not change pre-tax CF', resMoreDep.rows[0].preTaxCashFlow,
  y1.preTaxCashFlow, 1);
check('dep changes refund, hence after-tax CF', resMoreDep.rows[0].afterTaxCashFlow,
  y1.afterTaxCashFlow + (100000 * 0.025 * 0.39), 1);

// principal is cash but NOT deductible: IO years -> P&I adds cash cost only
const y6 = res.rows[5];
checkTrue('P&I year has principal', y6.ipPrincipalRepayment > 5000);
const deltaCash = y6.preTaxCashFlow - (y6.netOperatingIncome);
checkTrue('principal is a cash outflow in pre-tax CF',
  Math.abs(deltaCash + y6.ipPrincipalRepayment + y6.equityLoanPrincipalRepayment) < 1,
  'pre-tax CF = NOI - principal repayments');
// deductions exclude principal: totalDeductions has no principal component
checkTrue('principal not in deductions',
  y6.totalDeductions < y6.totalDeductions + y6.ipPrincipalRepayment,
  'sanity: deductions are independent of principal');

// property growth compounds: value(2) = price x 1.06^2
check('compounding property value', res.rows[1].propertyValue,
  750000 * Math.pow(1.06, 2), 1);

// rent compounds independently
check('rent growth year 2', res.rows[1].weeklyRent, 620 * 1.035, 0.01);

// land tax recomputes as land value grows: force it above threshold
const resLT = E.calculateAll({ landValue: 600000, otherAuLandValue: 500000, landValueGrowthRate: 0.05 });
checkTrue('land tax appears once aggregate passes threshold',
  resLT.rows[0].landTax > 0);
checkTrue('land tax grows year over year',
  resLT.rows[1].landTax > resLT.rows[0].landTax);

// equity loan purpose percent scales the deduction only, not the cash cost
const resPct = E.calculateAll({ equityLoanPurposePercent: 0.5 });
check('equity purpose pct: cash cost unchanged', resPct.rows[0].equityLoanInterest,
  y1.equityLoanInterest, 1);
check('equity purpose pct: deduction halved', resPct.rows[0].deductibleEquityInterest,
  y1.equityLoanInterest * 0.5, 1);
check('equity purpose pct: refund scaled accordingly',
  resPct.rows[0].taxRefundOrCost,
  y1.taxRefundOrCost - (y1.equityLoanInterest * 0.5 * 0.39), 1);

// joint ownership: blended marginal rate, not a flat halving of the sole result
const resJoint = E.calculateAll({
  ownershipType: 'joint_50_50',
  owner1TaxableIncome: 45000,  // 15% + 2% = 17%
  owner2TaxableIncome: 200000, // 45% + 2% = 47%
});
check('joint: blended rate = (17% + 47%)/2', resJoint.rows[0].taxRefundOrCost,
  -taxableHand * 0.32, 1);

// cumulative position identity
for (const yr of [1, 10, 20]) {
  const r = res.rows[yr - 1];
  check(`cumulative position identity (year ${yr})`, r.cumulativePosition,
    r.netEquity + r.cumulativeAfterTaxCashFlow - res.upfront.initialCashInvested, 1);
}

// IO -> P&I transition is flagged
checkTrue('IO->P&I warning present',
  res.warnings.some((w) => w.includes('switch from interest-only')),
  'projection should warn about the P&I step-up');

// =====================================================================
// Exit analysis
// =====================================================================

const x = res.exit;
const saleRow = res.rows[x.saleYear - 1];
const sellingHand = saleRow.propertyValue * 0.025 + 1500;
check('exit selling costs', x.sellingCosts, sellingHand, 1);
const costBaseHand = 750000 + res.upfront.acquisitionCosts
  - res.rows.slice(0, x.saleYear).reduce((s, r) => s + r.capitalWorksDepreciation, 0);
check('exit cost base', x.costBase, costBaseHand, 1);
checkTrue('50% discount applies (20-year hold)', x.discountRate === 0.5);

// reconciliation: proceeds = sale - costs - CGT - both loan balances
check('exit proceeds reconcile', x.netSaleProceeds,
  x.salePrice - x.sellingCosts - x.capitalGainsTax
  - x.ipLoanBalanceAtSale - x.equityLoanBalanceAtSale, 1);
checkTrue('CGT charged only on discounted gain',
  Math.abs(x.capitalGainsTax - x.taxableCapitalGain * x.cgtRate) < 1);
checkTrue('exit carries the 2027 warning',
  x.warnings.length > 0 && x.warnings[0].includes('2027'));

// =====================================================================
// Borrowing capacity
// =====================================================================

const b = res.borrowing;
checkTrue('3% buffer makes assessment rate', b.assessmentBuffer === 0.03);
checkTrue('rent is haircut 20%', Math.abs(b.rentAssessed - 620 * 52 * 0.8) < 1);

// a bigger buffer must REDUCE capacity
const bBigBuffer = E.calculateAll({ bcBuffer: 0.04 }).borrowing;
checkTrue('bigger buffer reduces capacity', bBigBuffer.maxNewLoan < b.maxNewLoan);

// deeper rental haircut must reduce capacity
const bHaircut = E.calculateAll({ bcRentalHaircut: 0.40 }).borrowing;
checkTrue('haircut reduces capacity', bHaircut.maxNewLoan < b.maxNewLoan);

// existing PPOR debt consumes capacity
const bNoPpor = E.calculateAll({ pporLoanBalance: 0 }).borrowing;
checkTrue('no PPOR debt -> more capacity', bNoPpor.maxNewLoan > b.maxNewLoan);

// negative surplus -> zero capacity, no crash
const bBroke = E.calculateAll({
  bcOwner1GrossIncome: 30000,
  bcLivingExpensesAnnual: 80000,
}).borrowing;
check('negative surplus -> zero max loan', bBroke.maxNewLoan, 0);

// DTI warning fires when debt dwarfs income
checkTrue('DTI warning present',
  bBroke.warnings.some((w) => w.includes('DTI') || w.includes('borrowing capacity')));

// =====================================================================
// IRR & summary
// =====================================================================

checkTrue('IRR exists for default scenario', res.metrics.irrApproximation !== null);
checkTrue('IRR sane (0%..30%)',
  res.metrics.irrApproximation > 0 && res.metrics.irrApproximation < 0.30,
  `got ${res.metrics.irrApproximation}`);
check('break-even rent above market rent (negatively geared)', true,
  res.metrics.breakEvenWeeklyRent > 620);
checkTrue('gross yield sane', Math.abs(res.metrics.grossYield - (620 * 52) / 750000) < 0.001);

// second-hand property: P&E auto-disabled with warning
const resSecond = E.calculateAll({ isNewBuild: false });
check('second-hand: P&E deduction off', resSecond.rows[0].plantEquipmentDepreciation, 0);
checkTrue('second-hand: warning explains why',
  resSecond.warnings.some((w) => w.includes('Second-hand')));

// shortfall warning when equity + loan don't cover costs
const resShort = E.calculateAll({ equityReleased: 50000 });
checkTrue('shortfall warning fires',
  resShort.warnings.some((w) => w.includes('shortfall')));

// =====================================================================
// Investment score
// =====================================================================

// Factor weights must total exactly 100.
const wInputs = { purchasePrice: 600000, weeklyRent: 650, landValue: 360000, bedrooms: 3 };
const fullScore = E.investmentScore(wInputs, {
  medianPrice: 700000,       // ratio 0.857 -> 15
  vacancyPct: 1.2,           // -> 13
  growth5yrPct: 32,          // -> 12
  medianRent3Bed: 600,       // 650/600 = 1.083 -> 10
  approvalsRatio: 0.8,       // 0.8% of dwelling stock -> 7 (percent, not decimal)
});
const weightSum = fullScore.factors.reduce((s, f) => s + f.maxPoints, 0);
check('score weights sum to 100', weightSum, 100);
// points: yield 650*52/600k = 5.63% -> 20; +15+15+13+12+10+7 = 92
check('full-data known answer', fullScore.score, 92);
check('full band Exceptional', fullScore.band, 'Exceptional');
check('nothing missing on full data', fullScore.missing.length, 0);
checkTrue('every factor carries a rationale',
  fullScore.factors.every((f) => f.rationale && f.rationale.length > 10));

// Yield band edges: 5.63% -> 20 pts; 5.0% -> 16; 4.4% -> 8
check('yield >=5.5% scores 20', E.investmentScore({ purchasePrice: 600000, weeklyRent: 650, landValue: 0 }).factors[0].points, 20);
check('yield 5.0% scores 16', E.investmentScore({ purchasePrice: 676000, weeklyRent: 650, landValue: 0 }).factors[0].points, 16);
check('yield 4.4% scores 8', E.investmentScore({ purchasePrice: 700000, weeklyRent: 600, landValue: 0 }).factors[0].points, 8);

// Band thresholds (rescaled score -> label), boundaries inclusive
check('band 34 -> Poor', E.scoreBand(34), 'Poor');
check('band 35 -> Below Average', E.scoreBand(35), 'Below Average');
check('band 50 -> Average', E.scoreBand(50), 'Average');
check('band 65 -> Good', E.scoreBand(65), 'Good');
check('band 75 -> Strong', E.scoreBand(75), 'Strong');
check('band 90 -> Exceptional', E.scoreBand(90), 'Exceptional');
check('band 89 -> Strong', E.scoreBand(89), 'Strong');

// Rescaled scoring with partial data: null suburb, 20/35 pts -> 57 Average
const s57 = E.investmentScore({ purchasePrice: 676000, weeklyRent: 650, landValue: 220000 });
check('rescaled 20/35 -> 57', s57.score, 57);
check('band at 57', s57.band, 'Average');

// Everything bad (full suburb data) -> deep in Poor
const sBad = E.investmentScore(
  { purchasePrice: 600000, weeklyRent: 300, landValue: 100000, bedrooms: 3 },
  { medianPrice: 700000, vacancyPct: 5, growth5yrPct: -5, medianRent3Bed: 600, approvalsRatio: 2.0 });
checkTrue('all-bad scenario < 35', sBad.score < 35, `got ${sBad.score}`);
check('all-bad band', sBad.band, 'Poor');

// Missing suburb data degrades the denominator instead of throwing
const partial = E.investmentScore(wInputs, { medianPrice: 700000 });
check('partial suburb: scoredMax 50', partial.scoredMax, 50);
check('partial suburb: 4 factors missing',
  partial.missing.length, 4);
checkTrue('partial suburb: score is rescaled', partial.score === 100, `got ${partial.score}`);

// null suburb: still scores yield + land (max 35), never throws
const nullSub = E.investmentScore(wInputs, null);
check('null suburb: scoredMax 35', nullSub.scoredMax, 35);
checkTrue('null suburb: 5 missing', nullSub.missing.length === 5);
checkTrue('null suburb: no crash + score present', nullSub.score >= 0);

// rentVsMedian uses the right bedroom column
const s2bed = E.investmentScore({ purchasePrice: 600000, weeklyRent: 650, landValue: 360000, bedrooms: 2 },
  { vacancyPct: 0.8, medianRent2Bed: 620 });
const f2bed = s2bed.factors.find((f) => f.key === 'rentVsMedian');
checkTrue('bedrooms=2 reads 2-bed median', f2bed.scored && Math.abs(f2bed.value - 650 / 620) < 0.001);

// bedrooms outside 2-4 -> factor unscored
const s5bed = E.investmentScore({ purchasePrice: 600000, weeklyRent: 650, landValue: 360000, bedrooms: 5 },
  { vacancyPct: 0.8, medianRent4Bed: 620 });
checkTrue('bedrooms=5 leaves rentVsMedian unscored',
  s5bed.factors.find((f) => f.key === 'rentVsMedian').scored === false);

// calculateAll attaches a score when passed suburb data
const withScore = E.calculateAll(wInputs, { suburb: { vacancyPct: 1.0 } });
checkTrue('calculateAll exposes score', withScore.score && withScore.score.score >= 0);

// =====================================================================
// Comparable-sale derivations
// =====================================================================

const cd = E.compDerivations({ soldPrice: 450000, landM2: 600, rentEstimate: 500 }, wInputs);
check('comp $/m2', cd.perM2, 750);
check('comp implied yield', cd.impliedGrossYield, (500 * 52) / 450000, 0.0001);
check('comp price ratio vs subject', cd.priceRatio, 450000 / 600000, 0.0001);
const cdBlank = E.compDerivations({}, wInputs);
checkTrue('blank comp -> nulls, no crash',
  cdBlank.perM2 === null && cdBlank.impliedGrossYield === null && cdBlank.priceRatio === null);

// =====================================================================
// PPOR inputs: normalize + LVR warning
// =====================================================================

const niPpor = E.normalizeInputs({ pporAddress: '12 Smith St', pporValue: '850000' });
check('pporAddress survives normalize', niPpor.pporAddress, '12 Smith St');
check('pporValue coerces from string', niPpor.pporValue, 850000);

const pporOk = E.calculateAll(E.normalizeInputs({ pporValue: 900000, equityReleased: 200000 }));
checkTrue('no PPOR LVR warning within 80%',
  !pporOk.warnings.some((w) => w.includes('80% of your PPOR')),
  pporOk.warnings.join(' | '));

const pporOver = E.calculateAll(E.normalizeInputs({ pporValue: 900000, equityReleased: 800000 }));
checkTrue('PPOR LVR warning above 80%',
  pporOver.warnings.some((w) => w.includes('80% of your PPOR')),
  pporOver.warnings.join(' | '));

const pporNoValue = E.calculateAll(E.normalizeInputs({ pporValue: 0, equityReleased: 800000 }));
checkTrue('no PPOR LVR warning when value unknown',
  !pporNoValue.warnings.some((w) => w.includes('80% of your PPOR')),
  pporNoValue.warnings.join(' | '));

// =====================================================================
// Multi-property portfolios (v3 inputs)
// =====================================================================

// -- migration: legacy flat -> properties[0], globals stay flat --
const mig = E.normalizeInputs({ purchasePrice: 700000, weeklyRent: 580, pporAddress: '12 Smith St' });
checkTrue('flat -> v3: exactly one property', mig.properties.length === 1);
check('flat -> v3: per-property key moved', mig.properties[0].purchasePrice, 700000);
check('flat -> v3: per-property rent moved', mig.properties[0].weeklyRent, 580);
check('flat -> v3: global kept flat', mig.pporAddress, '12 Smith St');
checkTrue('top-level unknown key stripped', !('bogus' in E.normalizeInputs({ bogus: 1 })));
const metaKept = E.normalizeInputs({
  pporAddress: '12 Smith St',
  pporAddressMeta: { streetName: 'Smith', lat: -27.5, lon: 151.9 },
});
checkTrue('ppor address meta survives normalize', !!metaKept.pporAddressMeta);
check('ppor address meta keeps coordinates', metaKept.pporAddressMeta.lat, -27.5);
const stripped = E.normalizeInputs({ properties: [{ bogus: 1, purchasePrice: 500000 }] });
checkTrue('property-level unknown key stripped', !('bogus' in stripped.properties[0]));
const capped = E.calculateAll({ properties: Array.from({ length: 8 }, () => ({ purchasePrice: 500000 })) });
check('cap: 8 properties in -> 6 out', capped.properties.length, 6);
check('empty properties list pads to one', E.normalizeInputs({ properties: [] }).properties.length, 1);
const flatOverride = E.calculateAll({ ipLvr: 0.9 });
check('flat override lands on properties[0]', flatOverride.properties[0].metrics.ipLvrActual, 0.9, 0.0001);

// -- ownershipStatus: only purchased properties join portfolio roll-ups --
check('ownershipStatus defaults to considering',
      E.normalizeInputs({ properties: [{}] }).properties[0].ownershipStatus, 'considering');
const ownedMixed = E.normalizeInputs({ properties: [
  { purchasePrice: 500000, weeklyRent: 450, ownershipStatus: 'purchased' },
  { purchasePrice: 800000, weeklyRent: 600, ownershipStatus: 'under_offer' },
  { purchasePrice: 900000, weeklyRent: 650 },
]});
const ownedAll = E.calculateAll(ownedMixed);
check('status passes through to outputs',
      ownedAll.properties[1].ownershipStatus, 'under_offer');
check('full result aggregates all properties',
      ownedAll.metrics.purchasePrice, 2200000, 1);
const ownedOnly = E.ownedInputs(ownedMixed);
checkTrue('ownedInputs keeps only purchased',
          ownedOnly.properties.length === 1 && ownedOnly.properties[0].purchasePrice === 500000);
const ownedResult = E.calculateAll(ownedOnly);
check('roll-ups on ownedInputs count purchased only',
      ownedResult.metrics.purchasePrice, 500000, 1);
checkTrue('ownedInputs null when nothing purchased',
          E.ownedInputs({ properties: [{ purchasePrice: 500000, ownershipStatus: 'considering' }] }) === null);
checkTrue('ownedInputs null for plain legacy inputs (all default considering)',
          E.ownedInputs({ properties: [{ purchasePrice: 500000 }] }) === null);

// -- ownerTaxSplit: investor/partner breakdown reconciles to the blended tax --
const jointInputs = E.normalizeInputs({
  ownershipType: 'joint_50_50', owner1TaxableIncome: 200000, owner2TaxableIncome: 40000,
  properties: [{ purchasePrice: 690000, weeklyRent: 725 }],
});
const jointRow = E.calculateAll(jointInputs).rows[0];
const split = E.ownerTaxSplit(jointInputs, jointRow.taxablePropertyResult, 1);
checkTrue('joint split has two owners at 50% share',
          split.share === 0.5 && split.owner2 !== null);
checkTrue('joint split sums to the engine refund',
          Math.abs(split.total - jointRow.taxRefundOrCost) < 1);
checkTrue('higher-income owner gets the larger credit (negative result)',
          split.owner1 > split.owner2);
const soleInputs = E.normalizeInputs({
  ownershipType: 'sole', owner1TaxableIncome: 90000,
  properties: [{ purchasePrice: 690000, weeklyRent: 725 }],
});
const soleRow = E.calculateAll(soleInputs).rows[0];
const soleSplit = E.ownerTaxSplit(soleInputs, soleRow.taxablePropertyResult, 1);
checkTrue('sole ownership: single owner, total equals refund',
          soleSplit.owner2 === null
          && Math.abs(soleSplit.total - soleRow.taxRefundOrCost) < 1);

// -- land tax aggregates across the portfolio, allocated by land share --
const twoLand = E.calculateAll({
  properties: [
    { purchasePrice: 750000, weeklyRent: 620, landValue: 350000, equityReleased: 200000 },
    { purchasePrice: 750000, weeklyRent: 620, landValue: 350000, equityReleased: 200000 },
  ],
});
checkTrue('land tax aggregates across properties', twoLand.rows[0].landTax > 0);
check('combined land tax on 700k aggregate', twoLand.rows[0].landTax, 1500, 1);
check('land tax allocated by land share', twoLand.properties[0].rows[0].landTax, 750, 1);
const allocSum = twoLand.properties.map((p) => p.rows[0].taxRefundOrCost).reduce((s, r) => s + r, 0);
check('tax allocations sum to portfolio assessment', allocSum, twoLand.rows[0].taxRefundOrCost, 1);

// -- equity loan = one loan, shares by draw --
const twoEq = E.calculateAll({
  properties: [
    { equityReleased: 100000 },
    { equityReleased: 150000 },
  ],
});
check('equity loan interest on the 250k total', twoEq.rows[0].equityLoanInterest, 250000 * 0.062, 1);
check('equity interest share 40%', twoEq.properties[0].rows[0].equityLoanInterest, 250000 * 0.062 * 0.4, 1);
check('equity interest share 60%', twoEq.properties[1].rows[0].equityLoanInterest, 250000 * 0.062 * 0.6, 1);

// -- staggered purchases: later settlement joins the timeline --
const stag = E.calculateAll({
  projectionYears: 10,
  properties: [
    { purchasePrice: 750000, weeklyRent: 620, landValue: 350000, equityReleased: 100000 },
    { purchasePrice: 600000, weeklyRent: 500, equityReleased: 150000, purchaseYear: 2028, ipLvr: 0.7 },
  ],
});
checkTrue('staggered: year 1 excludes IP2 rent',
  Math.abs(stag.rows[0].effectiveRent - (620 * 52 - 2 * 620)) < 1);
checkTrue('staggered: year 3 includes IP2 rent',
  stag.rows[2].effectiveRent > stag.rows[1].effectiveRent + 20000);
check('staggered: y1 equity interest on 100k only', stag.rows[0].equityLoanInterest, 100000 * 0.062, 1);
check('staggered: y3 equity interest on 250k', stag.rows[2].equityLoanInterest, 250000 * 0.062, 1);
check('staggered: IP2 has 8 property-local rows', stag.properties[1].rows.length, 8);
check('staggered: IP2 first calendar year', stag.properties[1].rows[0].calendarYear, 2028);

// -- per-property exits + aggregate reconciliation --
const exitsMix = E.calculateAll({
  projectionYears: 10,
  properties: [
    { purchasePrice: 750000, weeklyRent: 620, equityReleased: 100000, saleYear: 5 },
    { purchasePrice: 600000, weeklyRent: 500, equityReleased: 150000, ipLvr: 0.7 },
  ],
});
check('aggregate saleYear = latest', exitsMix.exit.saleYear, 10);
checkTrue('per-property exits keep own sale years',
  exitsMix.properties[0].exit.saleYear === 5 && exitsMix.properties[1].exit.saleYear === 10);
checkTrue('aggregate proceeds = sum of property exits',
  Math.abs(exitsMix.exit.netSaleProceeds
    - exitsMix.properties.reduce((s, p) => s + p.exit.netSaleProceeds, 0)) < 1);
check('IP1 exit repays its 40% equity share', exitsMix.properties[0].exit.equityLoanBalanceAtSale, 100000, 1);
check('IP2 exit repays its 60% equity share', exitsMix.properties[1].exit.equityLoanBalanceAtSale, 150000, 1);

// -- borrowing: sums across properties, single unchanged --
checkTrue('borrowing: rent assessed sums both rents',
  Math.abs(twoEq.borrowing.rentAssessed - 2 * 620 * 52 * 0.8) < 1);
checkTrue('borrowing: single-IP rent assessed unchanged',
  Math.abs(res.borrowing.rentAssessed - 620 * 52 * 0.8) < 1);

// -- warnings: prefixed when multi, byte-identical when single --
const twoWarn = E.calculateAll({
  properties: [
    { equityReleased: 50000 },
    { equityReleased: 50000 },
  ],
});
checkTrue('multi: IP 1 shortfall prefixed', twoWarn.warnings.some((w) => w.startsWith('IP 1 — Funding shortfall')));
checkTrue('multi: IP 2 shortfall prefixed', twoWarn.warnings.some((w) => w.startsWith('IP 2 — Funding shortfall')));
checkTrue('multi: propertyWarnings parallel + populated',
  twoWarn.propertyWarnings.length === 2
  && twoWarn.propertyWarnings[1].some((w) => w.includes('shortfall')));
checkTrue('single: shortfall warning NOT prefixed',
  resShort.warnings.some((w) => w.startsWith('Funding shortfall')));
checkTrue('single: warning order preserved (no prefix anywhere)',
  resShort.warnings.every((w) => !w.startsWith('IP ')));

// -- per-property metrics vs portfolio metrics --
checkTrue('single: property break-even = portfolio break-even',
  Math.abs(res.properties[0].metrics.breakEvenWeeklyRent - res.metrics.breakEvenWeeklyRent) < 0.01);
checkTrue('multi: each property carries score',
  twoLand.properties.every((p) => p.score && typeof p.score.score === 'number'));

// =====================================================================
// Other deductible claims (negative gearing, per property)
// =====================================================================

const claims = E.calculateAll({ otherDeductibleClaims: 2000 });
check('claims: year1 row carries amount', claims.rows[0].otherDeductibleClaims, 2000);
check('claims: reduce taxable result by amount',
  claims.rows[0].taxablePropertyResult, res.rows[0].taxablePropertyResult - 2000);
check('claims: extra refund at 39% marginal',
  claims.rows[0].taxRefundOrCost - res.rows[0].taxRefundOrCost, 2000 * 0.39, 1);
checkTrue('claims: after-tax cash = pre-tax - claims + refund',
  Math.abs(claims.rows[0].afterTaxCashFlow
    - (claims.rows[0].preTaxCashFlow - 2000 + claims.rows[0].taxRefundOrCost)) < 0.01);
check('claims: grow with expense growth rate',
  claims.rows[2].otherDeductibleClaims, 2000 * Math.pow(1.03, 2));
checkTrue('claims: weekly out-of-pocket worsens',
  claims.metrics.weeklyOutOfPocket > res.metrics.weeklyOutOfPocket);
checkTrue('no claims: after-tax formula unchanged',
  Math.abs(res.rows[0].afterTaxCashFlow
    - (res.rows[0].preTaxCashFlow + res.rows[0].taxRefundOrCost)) < 0.01);

// -- claims across a multi-property portfolio --
const claimsMix = E.calculateAll({
  properties: [
    { otherDeductibleClaims: 1000, equityReleased: 100000 },
    { otherDeductibleClaims: 2500, equityReleased: 150000 },
  ],
});
check('claims: combined sums both properties', claimsMix.rows[0].otherDeductibleClaims, 3500);
checkTrue('claims: per-property rows carry own claims',
  Math.abs(claimsMix.properties[0].rows[0].otherDeductibleClaims - 1000) < 0.01
  && Math.abs(claimsMix.properties[1].rows[0].otherDeductibleClaims - 2500) < 0.01);
check('claims: property after-tax sums to portfolio',
  claimsMix.properties.reduce((s, p) => s + p.rows[0].afterTaxCashFlow, 0),
  claimsMix.rows[0].afterTaxCashFlow, 1);

// =====================================================================
// PPOR (home) cash flow rows
// =====================================================================

const pporRows = res.ppor.rows;
check('ppor: rows match projection window', pporRows.length, res.rows.length);
check('ppor: calendar aligned with portfolio', pporRows[3].calendarYear, res.rows[3].calendarYear);
check('ppor: y1 council rates default', pporRows[0].councilRates, 2400);
check('ppor: y1 equity interest on 200k draw', pporRows[0].equityLoanInterest, 200000 * 0.062, 1);
checkTrue('ppor: P&I loan amortises (principal repaid, interest below straight rate)',
  pporRows[0].pporLoanPrincipalRepayment > 0
  && pporRows[0].pporLoanInterest < 500000 * 0.062);
checkTrue('ppor: balance declines every year',
  pporRows.every((r, i) => i === 0 || r.pporLoanClosingBalance < pporRows[i - 1].pporLoanClosingBalance));
checkTrue('ppor: equity rows match portfolio household totals',
  pporRows.every((r, i) => Math.abs(r.equityLoanInterest - res.rows[i].equityLoanInterest) < 1
    && Math.abs(r.equityLoanPrincipalRepayment - res.rows[i].equityLoanPrincipalRepayment) < 1));
check('ppor: total outflow sums all components',
  pporRows[0].totalOutflow,
  pporRows[0].councilRates + pporRows[0].waterRates + pporRows[0].insurance
    + pporRows[0].maintenance + pporRows[0].pporLoanInterest
    + pporRows[0].pporLoanPrincipalRepayment + pporRows[0].equityLoanInterest
    + pporRows[0].equityLoanPrincipalRepayment);
checkTrue('ppor: running costs grow with expense growth',
  pporRows[1].councilRates > pporRows[0].councilRates);
checkTrue('ppor: IO repayment type keeps balance flat',
  E.pporProjection(E.normalizeInputs({ pporRepaymentType: 'interest_only' }), [])
    .every((r) => r.pporLoanPrincipalRepayment === 0));
checkTrue('ppor: multi-IP equity rows match aggregate',
  twoLand.ppor.rows.every((r, i) =>
    Math.abs(r.equityLoanInterest - twoLand.rows[i].equityLoanInterest) < 1));

// =====================================================================
// Multi-state duty + land tax (NSW, VIC) — known answers against the
// official Revenue NSW / SRO Victoria tables (checked Nov 2026)
// =====================================================================

check('NSW duty $450,000 (official worked example)',
  E.transferDuty('NSW', 450000).duty, 14437);
check('NSW duty $650,000', E.transferDuty('NSW', 650000).duty, 23437);
check('NSW duty minimum $20', E.transferDuty('NSW', 1000).duty, 20);
check('NSW premium band chain at $3.87M',
  E.transferDuty('NSW', 3870000).duty, 194137);
check('NSW land tax $1,100,000 (official worked example)',
  E.landTax('NSW', 1100000).landTax, 500);
check('NSW land tax below threshold is zero',
  E.landTax('NSW', 900000).landTax, 0);
check('NSW land tax premium base at $6,571,000',
  E.landTax('NSW', 6571000).landTax, 88036);
check('NSW land tax $7,000,000',
  E.landTax('NSW', 7000000).landTax, 96616);
check('VIC duty $25,000 chains into band 2',
  E.transferDuty('VIC', 25000).duty, 350);
check('VIC duty $500,000', E.transferDuty('VIC', 500000).duty, 25070);
check('VIC duty 5.5% flat at $1,500,000',
  E.transferDuty('VIC', 1500000).duty, 82500);
check('VIC duty $2,500,000', E.transferDuty('VIC', 2500000).duty, 142500);
check('VIC land tax $400,000', E.landTax('VIC', 400000).landTax, 1650);
check('VIC land tax flat $500 at $50,000', E.landTax('VIC', 50000).landTax, 500);
check('VIC land tax below threshold', E.landTax('VIC', 40000).landTax, 0);
check('VIC land tax $2,000,000', E.landTax('VIC', 2000000).landTax, 15150);

// -- dispatch + integration --
check('unknown state falls back to QLD',
  E.transferDuty('XX', 750000).duty, E.transferDutyQLD(750000).duty);
const rNSW = E.calculateAll({ state: 'NSW' });
const rVIC = E.calculateAll({ state: 'VIC' });
check('NSW scenario duty = NSW scale', rNSW.upfront.transferDuty, 27937);
check('VIC scenario duty = VIC scale', rVIC.upfront.transferDuty,
  E.transferDuty('VIC', 750000).duty);
checkTrue('rateLabels follow the state',
  rNSW.rateLabels.duty.startsWith('NSW') && rVIC.rateLabels.landTax.startsWith('VIC'));
checkTrue('QLD default labels unchanged',
  E.calculateAll({}).rateLabels.duty.startsWith('QLD'));
checkTrue('joint warning is QLD-only',
  !rNSW.warnings.some((w) => w.startsWith('Joint estimate:')));
const jointNSW = E.calculateAll({ state: 'NSW', ownershipType: 'joint_50_50' });
check('NSW joint: land tax on full aggregate (no split)',
  jointNSW.landTaxYear1, E.landTax('NSW', 350000 + 0).landTax);
const jointVIC = E.calculateAll({ state: 'VIC', ownershipType: 'joint_50_50' });
check('VIC joint: land tax on full aggregate',
  jointVIC.landTaxYear1, E.landTax('VIC', 350000).landTax);

check('VIC joint: land tax on full aggregate',
  jointVIC.landTaxYear1, E.landTax('VIC', 350000).landTax);

// =====================================================================
// SA / WA / TAS / NT / ACT — known answers against official tables
// =====================================================================

check('SA duty $600,000 (official worked example)', E.transferDuty('SA', 600000).duty, 26830);
check('SA duty $1,000,000 (official worked example)', E.transferDuty('SA', 1000000).duty, 48830);
check('SA land tax $1,000,000', E.landTax('SA', 1000000).landTax, 320);
check('WA duty $600,000', E.transferDuty('WA', 600000).duty, 22515);
check('WA land tax $600,000', E.landTax('WA', 600000).landTax, 750);
check('TAS duty $750,000', E.transferDuty('TAS', 750000).duty, 28935);
check('TAS duty $500,000', E.transferDuty('TAS', 500000).duty, 18247.5);
check('TAS land tax $500,000', E.landTax('TAS', 500000).landTax, 1737.5);
check('TAS land tax below $125k threshold', E.landTax('TAS', 100000).landTax, 0);
check('NT duty $500,000 (TRO formula)', E.transferDuty('NT', 500000).duty, 23928.6);
check('NT duty $600,000 (flat rate)', E.transferDuty('NT', 600000).duty, 29724.83);
check('NT has no land tax', E.landTax('NT', 5000000).landTax, 0);
check('ACT investor duty $500,000', E.transferDuty('ACT', 500000).duty, 11400);
check('ACT flat band $1,500,000 = 4.54% of total', E.transferDuty('ACT', 1500000).duty, 68100);
check('ACT land tax per-property (two $400k props)',
  E.landTax('ACT', 800000, 'sole', [400000, 400000]).landTax, 9876);
check('ACT land tax aggregate fallback = one property',
  E.landTax('ACT', 800000).landTax, 9898);

// -- growth scenario bands --
const bands = E.growthScenarios({});
check('growth bands: three scenarios', bands.length, 3);
check('growth band rates', bands.map((b) => b.growth), [0.03, 0.05, 0.07]);
checkTrue('higher growth never lowers 10-yr equity',
  bands[0].tenYearEquity <= bands[1].tenYearEquity
  && bands[1].tenYearEquity <= bands[2].tenYearEquity);
checkTrue('higher growth raises net position at sale',
  bands[0].totalNetPosition < bands[2].totalNetPosition);

// -- risk checklist --
checkTrue('risk checklist flags overlays as unknown',
  E.riskChecklist({}, null).checks.some((c) => c.key === 'overlays' && c.status === 'unknown'));
checkTrue('high LVR warns',
  E.riskChecklist({ ipLvr: 0.97 }).checks.some((c) => c.key === 'lvr' && c.status === 'warn'));
checkTrue('strata warns',
  E.riskChecklist({ bodyCorporateAnnual: 3000 }).checks.some((c) => c.key === 'strata' && c.status === 'warn'));
checkTrue('low land share warns',
  E.riskChecklist({ purchasePrice: 750000, landValue: 100000 })
    .checks.some((c) => c.key === 'landShare' && c.status === 'warn'));

// -- FY-versioned tax tables --
check('FY dispatch: 2026-27 marginal at $150k is 37%',
  E.marginalRate(150000, '2026-27').bracketRate, 0.37);
check('unknown FY falls back to current tables',
  E.marginalRate(150000, '2030-31').combinedMarginalRate, 0.39);
checkTrue('incomeTaxEstimate honours FY',
  E.incomeTaxEstimate(150000, '2026-27').totalTax > 0);
checkTrue('CGT marginal rate honours scenario taxYear',
  E.exitAnalysis({ purchasePrice: 500000, saleYear: 2, projectionYears: 2,
                   taxYear: '2026-27' }).cgtRate > 0);

// -- NSW 3-year land tax averaging --
checkTrue('NSW year 1 assesses the current value',
  E.landTax('NSW', 1200000, 'sole', null, { year: 1, growth: 0.05 }).landTax
  === E.landTax('NSW', 1200000).landTax);
// year 3: average factor (1 + 1/1.05 + 1/1.1025) / 3 = 0.9531365
check('NSW LT year 3 uses the 3-year average',
  E.landTax('NSW', 1200000, 'sole', null, { year: 3, growth: 0.05 }).landTax, 1200.23);
check('NSW LT per-parcel averages (y1 + y3 parcels)',
  E.landTax('NSW', 2400000, 'sole', [1200000, 1200000],
    { years: [1, 3], growths: [0.05, 0.05] }).landTax, 20400.23);
check('NSW LT averaging with no growth = current value',
  E.landTax('NSW', 1200000, 'sole', null, { year: 3, growth: 0 }).landTax,
  E.landTax('NSW', 1200000).landTax);

// -- foreign buyer duty surcharge --
check('NSW foreign duty $650,000 = scale + 9% of value',
  E.transferDuty('NSW', 650000, 'foreign').duty, 81937);
check('QLD foreign duty $750,000 = scale + 7% of value',
  E.transferDuty('QLD', 750000, 'foreign').duty, 79275);
check('NT has no foreign surcharge',
  E.transferDuty('NT', 500000, 'foreign').duty, E.transferDuty('NT', 500000).duty);
check('resident default unchanged', E.transferDuty('NSW', 650000).duty, 23437);
check('foreign buyerType flows into funding',
  E.calculateAll({ state: 'NSW', buyerType: 'foreign' }).upfront.transferDuty, 95437);

// =====================================================================
// Deal verdicts (Deal Check phase 2)
// =====================================================================

{
  const SUB = { medianPrice: 650000, medianRent2Bed: 550, medianRent3Bed: 650,
                medianRent4Bed: 780, vacancyPct: 1.8, growth5yrPct: 28,
                populationGrowthPct: 2.1, approvalsRatio: 0.9 };
  const METRICS = { grossYield: 0.052, year1AfterTaxCashFlow: -3000,
                    weeklyOutOfPocket: 40 };

  const v = (inputs, metrics, suburb) => {
    const r = E.dealVerdicts(inputs, metrics, suburb);
    return Object.fromEntries(r.verdicts.map((x) => [x.key, x]));
  };

  const fair = v({ purchasePrice: 650000, weeklyRent: 650, bedrooms: 3 }, METRICS, SUB);
  check('six deal verdicts', Object.keys(fair).length, 6);
  check('all deal verdicts carry group=deal',
        E.dealVerdicts({}, METRICS, SUB).verdicts.every((x) => x.group === 'deal'), true);
  check('fair price scores strong', fair.price_vs_market.status, 'strong');
  check('yield 5.2% is strong', fair.gross_yield.status, 'strong');
  check('$40/wk out of pocket sits at the ok/watch boundary (score 42)',
        fair.cash_flow.status, 'ok'); // 40 maps exactly to 42
  check('vacancy 1.8% strong', fair.vacancy_risk.status, 'strong');
  check('rent at median is strong', fair.rent_positioning.status, 'strong');
  check('growth 28% strong', fair.growth_outlook.status, 'strong');

  const pricey = v({ purchasePrice: 950000, weeklyRent: 600, bedrooms: 3 }, METRICS, SUB);
  check('46% above median is watch', pricey.price_vs_market.status, 'watch');
  check('optimistic rent (600 vs 650 median) still lettable',
        pricey.rent_positioning.status, 'strong');
  check('dealVerdicts avg reflects mix',
        E.dealVerdicts({ purchasePrice: 650000, weeklyRent: 650 }, METRICS, SUB).avg > 50,
        true);

  const noSub = v({ purchasePrice: 650000, weeklyRent: 650, bedrooms: 3 }, METRICS, null);
  check('no suburb → data-dependent verdicts nodata',
        noSub.price_vs_market.status === 'nodata'
        && noSub.vacancy_risk.status === 'nodata'
        && noSub.growth_outlook.status === 'nodata', true);
  check('no suburb keeps input-only verdicts',
        noSub.gross_yield.status === 'strong' && noSub.cash_flow.status === 'ok', true);
  check('no suburb → avg from the two scored verdicts',
        E.dealVerdicts({ purchasePrice: 650000, weeklyRent: 650 }, METRICS, null).avg != null, true);

  const vgo = v({ purchasePrice: 720000, weeklyRent: 650, bedrooms: 3 }, METRICS,
                 { medianPrice: 650000, medianPriceSource: 'VIC Valuer-General' });
  check('VGO fallback scores the price verdict (1.11× median → ok)',
        vgo.price_vs_market.status, 'ok');
  check('VGO source surfaces in the median chip note',
        vgo.price_vs_market.metrics.some((m) =>
          (m.note || '').includes('VIC Valuer-General')), true);

  const bedMatch = v({ purchasePrice: 650000, weeklyRent: 720, bedrooms: 4 }, METRICS, SUB);
  check('4-bed uses medianRent4Bed (720 vs 780 ≈ ok band)',
        bedMatch.rent_positioning.status === 'strong'
        && bedMatch.rent_positioning.metrics.some((m) => m.label.includes('4-bed')), true);
  check('2-bed matches the ≤2 band (700 vs 550 = 1.27× → ok)',
        v({ purchasePrice: 650000, weeklyRent: 700, bedrooms: 2 }, METRICS, SUB)
          .rent_positioning.status, 'ok');

  const twoBed = v({ purchasePrice: 650000, weeklyRent: 650, bedrooms: 2 }, METRICS, SUB);
  check('2-bed price uses 0.8 bedroom factor (est. median 520k → 1.25× → watch)',
        twoBed.price_vs_market.status, 'watch');
  check('2-bed est. median chip value',
        twoBed.price_vs_market.metrics.find((m) => m.label.includes('Est. median')).value,
        520000);
  check('3-bed price factor is neutral (1.0)', fair.price_vs_market.status, 'strong');
}

// =====================================================================
// Market-evidence verdicts (Deal Check phase 3)
// =====================================================================

{
  const SUB = { medianDaysOnMarket: 28, growth5yrPct: 28 };
  const EV = {
    comps: [{ soldPrice: 660000, beds: 3 }, { soldPrice: 655000, beds: 3 },
            { soldPrice: 670000, beds: 3 }],
    rentals: [{ rentWeekly: 655, bedrooms: 3 }, { rentWeekly: 645, bedrooms: 3 },
              { rentWeekly: 660, bedrooms: 3 }],
    suburb: SUB,
    stateGrowth5yr: 22.0,
    stateGrowthLabel: 'Brisbane 5-yr median growth (ABS)',
  };
  const mv = (inputs, ev) => {
    const r = E.marketVerdicts(inputs, ev);
    return Object.fromEntries(r.verdicts.map((x) => [x.key, x]));
  };
  const good = mv({ purchasePrice: 650000, weeklyRent: 650, bedrooms: 3 }, EV);
  check('four market verdicts', Object.keys(good).length, 4);
  check('all market verdicts carry group=market',
        E.marketVerdicts({}, EV).verdicts.every((x) => x.group === 'market'), true);
  check('sales median 660k vs 650k price → strong', good.comps_price.status, 'strong');
  check('lettings median 650 vs 650 rent → strong', good.comps_rent.status, 'strong');
  check('28 days on market → strong', good.days_on_market.status, 'strong');
  check('28% suburb vs 22% state → strong', good.growth_vs_state.status, 'strong');
  check('market avg is high', E.marketVerdicts(
        { purchasePrice: 650000, weeklyRent: 650, bedrooms: 3 }, EV).avg > 70, true);

  const stretch = mv({ purchasePrice: 850000, weeklyRent: 850, bedrooms: 3 },
                      { comps: EV.comps, rentals: EV.rentals,
                        suburb: { medianDaysOnMarket: 95, growth5yrPct: 2 },
                        stateGrowth5yr: 20 });
  check('paying 29% above sales median → watch', stretch.comps_price.status, 'watch');
  check('rent 30% above lettings → watch', stretch.comps_rent.status, 'watch');
  check('95 days on market → watch', stretch.days_on_market.status, 'watch');
  check('18pts below state growth → watch', stretch.growth_vs_state.status, 'watch');

  const empty = mv({ purchasePrice: 650000, weeklyRent: 650, bedrooms: 3 }, {});
  check('no evidence → all four nodata, avg null',
        Object.values(empty).every((x) => x.status === 'nodata')
        && E.marketVerdicts({}, {}).avg == null, true);

  const mixed = mv({ purchasePrice: 650000, weeklyRent: 650, bedrooms: 3 },
                   { comps: [{ soldPrice: 660000, beds: 3 }, { soldPrice: 640000, beds: 2 },
                             { soldPrice: 630000, beds: 2 }],
                     suburb: { medianDaysOnMarket: 40 } });
  check('comps work with rentals missing', mixed.comps_price.status != null
        && mixed.comps_rent.status === 'nodata', true);
  check('only 1 same-bed comp falls back to all comps (no bed tag)',
        !mixed.comps_price.metrics[0].label.includes('(3-bed)'), true);
}

// =====================================================================
// Deal Check bundle composer (shared by app, portal and PDF)
// =====================================================================

{
  const SUB = { medianPrice: 650000, medianRent3Bed: 650, vacancyPct: 1.8,
                growth5yrPct: 28, medianDaysOnMarket: 28 };
  const b = E.dealCheckBundle({
    census: { sa2: { name: 'Testville' },
              overall: { score: 60, headline: 'census-only headline' },
              verdicts: [{ key: 'rental_demand', question: 'Q1', status: 'strong',
                           score: 80, headline: 'h', metrics: [] }],
              source: 'ABS' },
    inputs: { purchasePrice: 650000, weeklyRent: 650, bedrooms: 3, state: 'QLD' },
    metrics: { grossYield: 0.052, weeklyOutOfPocket: 40 },
    suburb: SUB,
    evidence: { comps: [{ soldPrice: 660000, beds: 3 }, { soldPrice: 655000, beds: 3 },
                        { soldPrice: 670000, beds: 3 }],
                suburb: SUB, stateGrowth5yr: 22 },
  });
  check('bundle blends three lenses: 11 verdicts (1 fixture area + 6 deal + 4 market)',
        b.verdicts.length, 11);
  check('bundle overall blends lens averages (census 60, deal/market high → strong)',
        b.overall.status === 'strong' && b.overall.verdictWord === 'PASS', true);
  check('bundle groups present', ['area', 'deal', 'market'].every((g) =>
        b.verdicts.some((v) => v.group === g)), true);
  check('bundle carries sa2 + source', b.sa2.name === 'Testville' && b.source === 'ABS', true);

  const bare = E.dealCheckBundle({ inputs: { purchasePrice: 500000, weeklyRent: 500 } });
  check('bare inputs → 10 verdicts (6 deal + 4 market), overall nodata',
        bare.verdicts.length === 10 && bare.overall.status === 'nodata', true);
}

// =====================================================================
// Summary
// =====================================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
