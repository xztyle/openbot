### Fixed

- The host no longer drops off Signal every 30 seconds: Signal now counts a quiet host's ping answers, so it stops ending a live host's socket.
- A host whose Signal socket hangs while opening gets a new one after 30 seconds, and the host opens a new socket again every 3 minutes until Signal answers, instead of staying unreachable until a restart.
