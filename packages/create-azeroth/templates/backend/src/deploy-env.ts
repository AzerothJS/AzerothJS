// `npm start` is a deploy, and NODE_ENV is what the FRAMEWORK reads for its own dev flag.
// It reads it while modules evaluate - long before `process.loadEnvFile()` runs in main.ts -
// so `.env` cannot reach it and the process environment is the only place that can. `--import`
// runs this file first; `??=` leaves an explicit value alone, so `azeroth dev`, a Dockerfile
// and a process manager all keep the mode they declared.
process.env.NODE_ENV ??= 'production';
