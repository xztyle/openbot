### Fixed

- In the web app, when the server refuses a new agent (for example a model that is not available), the form shows the reason and you can change it and try again. Before, every failure said "The result is not confirmed" and the form stopped working.
- In a channel, an answer to an approval, a question or a browser step that fails shows why in a message. Before, the buttons came back and nothing said that the answer did not go.
- In a channel, after you answer one approval, the next approval shows with working buttons. Before, it could stay on "Sending" until you opened the channel again.
- In a busy channel, a question card keeps the options you picked and the text you typed when new messages arrive. Before, each new message reset the card.
- In the web app, an answer to an agent's question that fails shows why. Before, the question card came back with no message.
- An MCP connection that a chat uses through "Apps for this chat" now gets the values of the agent that calls it: `{{agent.id}}`, `{{agent.name}}` and the agent's own keys in Secrets. Before, every agent reached the server as the owner of the shared key, and a connection that used a key of one agent only was not offered.
- The Test and Sign in buttons of an MCP server fill its `{{secret:…}}` values and Secrets links before they connect. Before, they sent the template text, and the server refused it. A key that is missing from Secrets now gets its own message.
