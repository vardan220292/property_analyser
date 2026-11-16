# Property Analyser UI Redesign Plan

## Direction
Premium fintech with real-estate intelligence (A + D).

The product should feel like a professional property-investment decision workspace: calm, precise, data-led and property-aware. Use a restrained deep-teal brand, warm neutral surfaces, clear financial hierarchy, compact but readable data tables, and contextual property research.

## Non-negotiable constraints
- Preserve all financial calculations, tax logic, assumptions, engine APIs and data models.
- Do not modify `static/engine.js` as part of visual redesign work.
- Preserve existing DOM IDs, `data-field` attributes, navigation targets, form controls, and event wiring unless a change is separately justified and regression-tested.
- Prefer CSS and existing render functions. Any HTML/JS changes must retain the existing interactions and data flow.
- No fabricated financial figures, property research, market data, or performance claims.
- Keep the work on `ui-modernisation/milestone-1-foundation`; do not merge to the default branch as part of this work.

## Design principles
1. **Financial clarity first** — prioritise property value, debt, equity, cash flow, yield, funding and tax outcomes.
2. **One visual language** — consistent page headers, section cards, KPI tiles, chart containers, tables, controls and empty states.
3. **Property context** — use property-specific identity, location, rent, yield, land and research status where the existing data supports it.
4. **Progressive disclosure** — keep advanced assumptions and secondary analysis accessible without dominating the primary workflow.
5. **Honest states** — distinguish no data, not yet configured, loading, unavailable and genuine zero values.
6. **Responsive by default** — preserve usable navigation, forms, charts and wide financial tables on laptop, tablet and mobile.
7. **Accessible interactions** — visible focus, readable contrast, semantic headings, clear labels and reduced-motion support.

## Shared design system
- Brand: deep teal / petrol, with restrained teal accents and neutral slate text.
- Surfaces: soft warm-grey application canvas, white/light cards, subtle borders and low-elevation shadows.
- Semantic colours: green for positive, red for negative, amber for caution; never rely on colour alone.
- Typography: compact editorial headings, highly legible body text, tabular numerals for money and percentages.
- Components: page intro, KPI strip, insight panel, section card, responsive table, chart frame, status chip, empty state and action group.
- Preserve the existing light/dark theme and text-scale controls.

## Page-by-page direction
| Page | Design objective |
|---|---|
| Dashboard | Portfolio command centre: financial snapshot, property-level performance, value/debt/equity outlook, model checks and recent analysis. |
| Investment Inputs | Guided, grouped assumptions with portfolio / PPOR / property context and clear advanced controls. |
| Property Intelligence | Address-first property profile, map and government-data status; compact, useful empty state before an address is selected. |
| Area & Suburb | Suburb-first research workflow; headline market indicators, evidence, comparable sales/rents and risk checks. |
| Cash Flow | Year-one cash position and recurring out-of-pocket summary before detailed annual cash-flow tables and charts. |
| Projections | Highlight year 1 / 5 / 10 / hold-period outcomes while retaining full annual projections and charts. |
| Exit & CGT | Clear sale-proceeds bridge, cost base, debt repayment and CGT explanation; never imply an estimate is a tax assessment. |
| Borrowing Capacity | Separate borrowing capacity, estimated purchase budget, funding/deposit and repayment context. |
| Scenarios & Reports | Scenario library, clear comparison selection state, side-by-side financial outcomes and report actions. |
| Actuals | Simple actuals entry plus actual-versus-projected performance, with a helpful first-entry state. |
| Client Workspace | Client-centred overview, status and property list while preserving existing client/branding actions and permissions. |

## Current implementation status (16 Nov 2026)

- Shared visual foundation: implemented; final responsive/accessibility regression pending.
- Dashboard: first pass implemented; screenshot-review contrast defect corrected with a high-contrast hero, responsive metric/action layout and refined CTA states.
- Scenarios & Reports: comparison chart empty states now explain the selection action and reduce blank-chart ambiguity.
- Cash Flow: charts and insight are prioritised above the bounded annual detail table; mobile layout stacks cleanly.
- Investment Inputs: property tabs and advanced assumption groups have clearer progressive-disclosure styling.
- Property Intelligence / Area & Suburb: shared empty-state and section treatments refined; verify live map/no-address states in browser.
- Exit & CGT: page hierarchy and exit section styling refined; the global warning remains visible and must be checked in the live navigation flow.
- Branding: replaced the missing logo asset request with an in-page RV mark and added an inline SVG favicon to eliminate the two reported asset 404s.
- Remaining pages: shared page-level styling pass applied; page-specific interaction and responsive review still required.
- Full validation: pending after these changes. Do not treat the redesign as release-ready until all 11 sections pass the validation checklist below.

## Delivery milestones
1. Shared visual foundation: tokens, typography, navigation, page rhythm, responsive behaviour and reusable empty-state patterns.
2. Dashboard.
3. Investment Inputs and Property Intelligence.
4. Area & Suburb and Cash Flow.
5. Projections and Exit & CGT.
6. Borrowing Capacity and Scenarios & Reports.
7. Actuals and Client Workspace.
8. Full regression, responsive and screenshot review across all 11 sections.

## Validation after each milestone
- Run `node tests/test_engine.js` and require zero failures.
- Run any existing server/API tests relevant to touched code.
- Confirm all 11 navigation targets still work.
- Check browser console, failed requests and HTTP errors.
- Capture all 11 sections at desktop width and at least one mobile width.
- Compare before/after screenshots and verify no financial outputs or user workflows changed.
