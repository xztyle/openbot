### Added

- The server control socket can record a CPU profile of the main process without a restart (`POST /v1/debug/cpu-profile` with `seconds`, at most 120). It writes a `.cpuprofile` file in the `debug-profiles` folder of the user data and answers its path. A stall recorder (`POST /v1/debug/stall-watch`, `GET /v1/debug/stalls`) keeps the JavaScript stack of each long task of the main thread for a limited time.
