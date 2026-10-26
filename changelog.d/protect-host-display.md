### Fixed

- Agents can no longer stop a Docker server by stopping its virtual display. With `OPENBOT_EXTERNAL_DISPLAY`, the display runs in another container as another user. Agents on a Linux server are also told to stop only the processes they started, never by name or pattern.
