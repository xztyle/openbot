### Fixed

- Channels in the browser: a message box takes at most 10 files, as a message may carry. Before, a
  second pick or paste could add more, and the host then refused the message at Send. The files over
  the limit are given back, and the box says why.
- Channels and threads in the browser: a file dragged from the computer onto the conversation now
  attaches to its message box, as in a DM with an agent. Before, the browser left the app to show
  the file.
- Browser client: an iPhone photo in HEIC, picked in the Files app or dropped from a Mac, now goes up
  as a JPEG with the same name in Safari. Before, the host refused it as a file type it does not take.
- Browser client: an artifact's picture shows again after many other artifacts were shown. Before,
  once more than 120 pictures had loaded, the oldest stayed blank until the page was loaded again.
- Browser client: Open on a document in Artifacts, or under Shipped on Today, shows it in the file
  viewer, as a file in a message does. Before, it only started a download, which on an iPhone asks
  where to save it, and a failed download said nothing.
