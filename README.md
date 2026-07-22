# Rusty Pythia

Rusty Pythia is the next-generation desktop rebuild of Pythia, targeting a Tauri + Rust shell with a reliable browser fallback path.

## Repository Layout

- Root workspace is reserved for the Rusty Pythia implementation.

## Current Runtime Wiring

- Tauri loads Rusty Pythia's bundled frontend from this repository.
- The desktop window is created inside the app shell and points at the bundled `index.html`.
- Rusty Pythia does not spawn or depend on `../PythiaJS/` at runtime.

## Run

1. Install dependencies: `npm install`
2. Start desktop app: `npm run tauri dev`
