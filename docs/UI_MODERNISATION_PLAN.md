# Property Analyser — UI Modernisation Plan

**Status:** Initial visual implementations for Milestones 1–8 are on the feature branch; runtime verification and deeper workflow refinements remain pending  
**Product direction:** Premium, trustworthy Australian property-investment analysis  
**Implementation constraint:** Preserve the existing Flask + vanilla JavaScript stack and all financial behaviour.

## Goals

- Make the product feel like a polished, premium fintech application.
- Reduce navigation complexity without removing existing capabilities.
- Improve readability of financial information, data hierarchy and decision-making flows.
- Make the main analyser, client portal and public landing page feel like one product.
- Keep the interface responsive, accessible and usable in both light and dark themes.

## Design direction

- Calm, professional light interface by default; retain a carefully tuned dark theme.
- Deep navy/ink for primary text and structure, restrained blue for primary actions, green for positive outcomes and red for negative outcomes.
- Soft neutral page backgrounds, white/near-white surfaces, subtle borders and restrained shadows.
- Consistent spacing, typography, radii, control heights, focus rings and motion.
- Prefer clarity and information density over decorative gradients, excessive colour or animation.
- Use the existing theme and text-scale preferences; do not remove either.

## Proposed information architecture

Consolidate the current destinations into these primary areas while preserving every feature:

1. **Dashboard** — portfolio summary, recent activity, properties and key performance charts.
2. **Properties** — property library and individual property details.
3. **Investment Analysis** — guided inputs and purchase/finance assumptions.
4. **Financial Analytics** — cash flow, projections, exit/CGT, borrowing capacity and actuals.
5. **Market Intelligence** — suburb/area reports, property intelligence, maps and comparable sales.
6. **Scenarios** — saved scenarios, duplication and side-by-side comparison.
7. **Client Workspace** — BA workspace, client proposals and shareable portal.
8. **Reports** — printable and downloadable analysis outputs.
9. **Settings / Profile** — preferences, account and branding where applicable.

Navigation consolidation is a UX proposal, not permission to remove or silently hide existing functionality.

## Experience workstreams

### Dashboard
- Establish a clear page heading and context.
- Prioritise the existing analysed-property count, investment score, best score and clearly labelled purchase value. Do not imply purchase price is current market valuation.
- Improve property summaries, recent activity and score distribution.
- Give charts consistent legends, labels, empty states and responsive behaviour.

### Properties and investment analysis
- Create a searchable property library with useful statuses and quick actions.
- Organise property details into overview, purchase, finance, rental, intelligence, area and performance.
- Turn the current long input experience into a guided sequence with grouped fields, plain-language explanations and validation.
- Provide a persistent summary of key assumptions and calculated outcomes.
- Retain advanced controls for users who need them.

### Financial analytics
- Bring cash flow, projections, exit/CGT, borrowing capacity and actuals into one coherent analytics area.
- Support clear time-period and property/portfolio context.
- Distinguish assumptions, forecast results and actual performance.
- Make tax, debt, equity and cash-flow effects easier to interpret.

### Market intelligence
- Improve suburb snapshots, investment-score explanations and comparable-sales review.
- Make source attribution and data-as-of dates prominent.
- Present parcel, land-use, planning, flood-study and bushfire map information clearly, with caveats intact.
- Preserve the existing Queensland open-data integrations and Leaflet map behaviour.

### Scenarios and reporting
- Improve scenario discovery, naming, duplication, archiving and comparison.
- Keep comparison metrics consistent across purchase cost, funding, rent, cash flow, tax, equity and exit proceeds.
- Provide report entry points for property analysis, cash flow, projections, purchase costs, funding, area reports, comparisons and client proposals.
- Preserve current scenario persistence and PDF/report workflows.

### Client experience
- Align the client portal visual language with the main analyser.
- Improve proposal readability, assumptions, interactive adjustments, questions and decision actions.
- Preserve authentication, share-token, OTP and access-control behaviour.
- Retain BA branding and client-facing PDF output.

## Technical approach and guardrails

- Keep Flask, existing APIs, SQLite and vanilla JavaScript. No framework migration.
- Keep `static/engine.js` as the calculation source of truth.
- Treat financial formulas, tax assumptions, API contracts, persisted scenario shapes and authentication as protected.
- Make visual changes incrementally and keep each milestone reviewable.
- Prefer small CSS/JS modules only when they reduce coupling; avoid a wholesale rewrite.
- Preserve existing light/dark and text-scale preferences.

## Milestones

### 1. Design foundation — implementation complete, verification pending
- Establish shared design tokens for colour, typography, spacing, radii, shadows and focus states.
- Harmonise base surfaces, buttons, fields, tables and navigation chrome.
- Improve keyboard focus, reduced-motion handling and responsive foundations.
- Apply the shared foundation to the analyser and client portal.
- Do not change calculations or navigation structure in this milestone.

### 2. Dashboard redesign — implementation complete, verification pending
- Improve dashboard hierarchy, KPI cards, property cards, activity and chart presentation.
- Preserve all existing dashboard metrics and data.

### 3. Properties and investment analysis — initial visual pass implemented; verification/refinement pending
- Added a consistent page introduction and hierarchy for investment assumptions and property intelligence.
- Refined property tabs, grouped input surfaces, field sizing, advanced controls and responsive layouts.
- Refined the property map presentation, map controls and government-evidence panels.
- Remaining refinement: a guided multi-step input flow and searchable property library require a separate interaction design pass; current inputs and property selection remain intact.

### 4. Financial analytics — visual harmonisation implemented; verification pending
- Added consistent page introductions for cash flow, projections, exit/CGT, borrowing and actuals.
- Harmonised analytics panels, selectors, tables, charts and responsive layouts.
- Existing forecast and actual-data behaviour remains unchanged.

### 5. Market intelligence — visual harmonisation implemented; verification pending
- Added a clear area-research page hierarchy.
- Refined suburb snapshot cards, investment score panel, comparable-sales search and entry forms, rental evidence, risk checklist and reference data.
- Refined property map framing, map controls and source/evidence presentation without changing data integrations.

### 6. Scenarios and reports — initial visual pass implemented; workflow verification pending
- Grouped navigation into Dashboard, Analyse, Research and Manage menus while preserving all existing destination links and access visibility.
- Added clearer scenario/comparison and client-workspace page introductions.
- Harmonised saved-scenario tables and comparison chart panels.
- Existing scenario persistence and report/PDF actions are unchanged; a dedicated report catalogue is not yet implemented.

### 7. Client experience — visual harmonisation implemented; verification pending
- Refined BA workspace cards, forms and action groups.
- Applied the shared visual language to the client portal, including proposal sections, metrics, sliders and map framing.
- Authentication, OTP, share-token, proposal adjustment and decision workflows remain unchanged.

### 8. Polish and release — initial responsive/accessibility pass implemented; full QA pending
- Added responsive navigation and mobile layout refinements for the main analyser and client portal.
- Added reduced-motion handling, stronger focus visibility and disabled-control states.
- Full browser, keyboard, contrast, performance and regression testing remains outstanding.

## Milestone 1 acceptance criteria

- Shared visual tokens are centralised and consistently applied.
- Existing theme and text-size preferences continue to work.
- Main analyser and client portal use the same foundational design language.
- Interactive controls have visible keyboard focus and clear hover/disabled states.
- Reduced-motion preferences are respected.
- Layout remains usable on desktop, tablet and mobile.
- No financial formulas, APIs, data structures, authentication or scenario behaviour are changed.
- Existing engine regression tests pass.

## Implementation notes

- Added `static/design-system.css` and loaded it after the existing stylesheet in both the analyser and client portal.
- The shared layer centralises a restrained navy/blue/neutral palette, light/dark tokens, typography, spacing, radii, focus rings and component refinements without replacing the existing stylesheet.
- Added a dashboard hero with clear actions, refined KPI layout, activity/score panels, property cards and responsive breakpoints.
- Added page-level introductions and visual refinements for Milestones 3–8 in `static/index.html` and `static/design-system.css`; grouped navigation retains every destination link, and existing DOM IDs, field bindings, API calls and calculations remain intact.
- Refined the BA workspace and client portal presentation; added responsive navigation, reduced-motion support and stronger focus/disabled states.
- Added a small navigation behaviour improvement so grouped menus close after selecting a destination.
- Renamed the dashboard KPI from “Portfolio value” to “Purchase value” because it is calculated from purchase prices, not current market valuations.
- Corrected weekly property-card display to distinguish out-of-pocket cost, surplus and break-even; included a score of exactly zero in the lowest score band.
- No financial formulas, backend routes, database schema, authentication or scenario persistence code was changed.

## Verification strategy

- Run the existing Node engine regression suite after each relevant change.
- Smoke-test login, navigation, scenario save/load, inputs, charts, property maps, actuals, portal access and PDF/print.
- Check light and dark themes at desktop, tablet and mobile widths.
- Check keyboard navigation, visible focus, reduced motion and browser console errors.
- Do not merge a milestone with broken financial calculations, lost data or weakened access controls.

## Explicit non-goals

- No migration to React, Vue or another frontend framework.
- No rewrite of the financial engine.
- No change to tax/legal assumptions as part of visual modernisation.
- No removal of existing features to simplify the interface.
