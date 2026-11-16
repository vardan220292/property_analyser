# Property intelligence data sources

## Implemented in this milestone

### Victoria — Vicmap Property
- Endpoint: `GET /api/intel/vic-property?lat=<lat>&lon=<lon>`
- Source: Victorian Government Vicmap Property ArcGIS FeatureServer.
- Returns the property map polygon, PFI/property reference, UFI, council property number/code, property type/status codes, multi-assessment flag and parcel polygon area.
- The address is first geocoded by the existing address picker; the endpoint performs a point-in-polygon lookup using the saved coordinates.
- Response cache: 12 hours in-process.
- Licence: Creative Commons Attribution 4.0 International. The UI links to the DataVic source and displays the licence.
- This is cadastral information, not a title search, survey, valuation or dwelling-attribute record.

### Queensland
- Existing `GET /api/intel/property` Queensland Government spatial lookup remains unchanged.

### Dashboard
- New Market & Property Intelligence panel reads the selected investment property's cached parcel result.
- It also shows existing suburb reference values (median sale, bedroom-specific rent, vacancy and five-year growth) when those values are present in the app's suburb reference table.
- Each suburb metric displays its saved source and as-of date when that metadata exists.
- The panel deliberately labels these as saved suburb reference values; it does not imply they were freshly fetched from a government feed.

## Not yet implemented

The free Victorian government releases currently provide suburb-level sale and rental statistics, not a public address-level API for each home's sale and lease history. The following should be separate follow-on integrations:
- Import the Valuer-General Victoria annual/quarterly sales workbooks and map suburb/type medians into the suburb reference table.
- Import Homes Victoria moving annual median rent data by suburb, dwelling type and bedroom count.
- Add ABS demographic indicators by SA2/LGA.
- Add Vicmap Planning and hazard overlays as distinct layers with source dates.
- Add address-level sales/rent history only through a provider whose licence explicitly permits commercial display.

Do not present suburb medians as an individual property's sale history, rental history, valuation or rent appraisal.

## Operational notes
- The new endpoint uses the public Vicmap ArcGIS REST service and the existing `requests` dependency; no API key or new Python package is required.
- API keys are not needed for Vicmap Property.
- The in-memory cache is per process; a multi-worker deployment may make one upstream request per worker.
- Before a public commercial launch, retain the attribution and re-check dataset terms and service usage limits.
