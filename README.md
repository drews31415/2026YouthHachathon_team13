# BingBing Zero / 빙빙제로

React + TypeScript + Leaflet winter walking route demonstrator. Korean interface, responsive desktop/mobile layouts, keyboard accessible dialogs and location picker.

## Run

Use Node.js 24 LTS. Run `npm ci`, then `npm run dev`. Run `npm test` for 29 automated checks and `npm run build` for the static `dist/` output.

## Important data boundary

`src/core/network.ts` contains a synthetic 20-node/32-edge/6-place graph positioned around Gwanak-gu, Seoul. It is not an imported or field-verified road network. Risk weather/environment features are synthetic. The baseline is a rule system, not a trained AI model or icing probability estimator. The UI labels all of this as simulation.

`src/services/weather.ts` fetches actual Open-Meteo model data on user request, validates units, timestamps, and 24 hourly rainfall/snowfall samples. These model data are not pavement observations and never silently replace the simulation inputs.

## Files

- `src/core/engine.ts`: risk rules, bounded place search, Dijkstra routing, traversal geometry and instructions.
- `src/core/types.ts`: domain contracts corresponding to the planning ERD's conceptual objects.
- `src/core/resultLifecycle.ts`: removes routes and risk labels when analysis expires.
- `src/components/WalkingMap.tsx`: Leaflet layers, attribution, explanatory risk popups.
- `src/App.tsx`: search, settings, results, navigation walkthrough.
- `src/services/weather.test.ts`: missing/stale/incorrect weather data checks.

No user accounts, route-history storage, or server database. Route computation happens in browser memory. Only font size preference persists. Tile requests reveal viewport region/IP to the tile provider. Actual geolocation is requested only after a user click and is used to select a nearby demo place, with the uncomputed connecting route disclosed.

Full Korean feasibility, data-source, architecture, testing and handover documents are in the parent workspace's `docs/` directory.
