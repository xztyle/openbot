/**
 * The way out of a settings page asks the open settings form first. The server settings register
 * their unsaved-changes guard while they show; the page frame's Close, Back and Escape go through
 * `requestSettingsLeave`. One page shows at a time, so one guard is enough.
 */
type LeaveRequest = (leave: () => void) => void;

let current: LeaveRequest | null = null;

/** Puts `request` in front of every way out of the page. The returned function takes it away. */
export function registerSettingsLeaveGuard(request: LeaveRequest): () => void {
  current = request;
  return () => {
    if (current === request) current = null;
  };
}

/** Runs `leave` now, or after the open form's question when it holds unsaved changes. */
export function requestSettingsLeave(leave: () => void): void {
  if (current) current(leave);
  else leave();
}
