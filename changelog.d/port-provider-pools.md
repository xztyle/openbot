### Added

- Pool the accounts of a provider: when Claude or ChatGPT (Codex) has a second plan account, turn on
  "Pool accounts" in the accounts of the provider in Server settings > Providers. Agents then use
  one account until it nears a usage limit, then move before their next work to the account whose
  limit resets first. Each account keeps a part of each limit free, so a turn does not stop at a
  limit. Select "Leave out of pool" in the menu of an account to keep it out. A saved API key is never
  in the pool. The pool is off by default, and nothing changes with one account.
- With Pool accounts on, an account that an agent picks for itself with update_profile stays until
  it hits a limit, and a Claude agent with background subagents running moves only when they end.
- Give Claude, ChatGPT (Codex) and Gemini environment variables, such as API keys and base URLs, in
  Server settings > Providers > a provider > Environment. Mark a value Sensitive to keep it
  encrypted on the server; it does not show again. With these variables the providers can send
  their requests to a proxy such as CLIProxyAPI: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for
  Claude, `OPENAI_BASE_URL` and `OPENAI_API_KEY` for ChatGPT. A change applies when the provider's
  current turns end. It works in the web app on a computer and on a phone.
