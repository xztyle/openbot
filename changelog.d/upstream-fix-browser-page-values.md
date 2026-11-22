### Fixed

- Agents pass more bot checks in the built-in browser on a server. On a server with no GPU, WebGL no
  longer names the SwiftShader software renderer, which bot checks read as headless Chrome, and
  hidden tabs report a Chrome window size and `window.chrome`.
