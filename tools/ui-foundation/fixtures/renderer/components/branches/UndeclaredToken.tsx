// A style object that reads a token nobody declares. The read is static, so it is a failure; the
// family `--openbot-file-${color}` beside it is built at runtime and is not one.
export const UndeclaredToken = (props: { color: string }) => (
  <div style={{ gap: "var(--openbot-space-7)", color: `var(--openbot-file-${props.color})` }} />
);
