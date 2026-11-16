### Fixed

- In the web app, when the server refuses a new agent (for example a model that is not available), the form shows the reason and you can change it and try again. Before, every failure said "The result is not confirmed" and the form stopped working.
- In a channel, an answer to an approval, a question or a browser step that fails shows why in a message. Before, the buttons came back and nothing said that the answer did not go.
- In a channel, after you answer one approval, the next approval shows with working buttons. Before, it could stay on "Sending" until you opened the channel again.
- In a busy channel, a question card keeps the options you picked and the text you typed when new messages arrive. Before, each new message reset the card.
- In the web app, an answer to an agent's question that fails shows why. Before, the question card came back with no message.
- An MCP connection that a chat uses through "Apps for this chat" now gets the values of the agent that calls it: `{{agent.id}}`, `{{agent.name}}` and the agent's own keys in Secrets. Before, every agent reached the server as the owner of the shared key, and a connection that used a key of one agent only was not offered.
- The Test and Sign in buttons of an MCP server fill its `{{secret:…}}` values and Secrets links before they connect. Before, they sent the template text, and the server refused it. A key that is missing from Secrets now gets its own message.
- When a change of model, effort or fast mode fails, the composer and the agent settings show the server's reason, for example that the agent must finish its turn before it changes provider. Before, they said only "Try again", and trying again failed the same way.
- An approval or a question that waits for you keeps its whole text when the server sends a status update. Before, an update cut a long command or question to its start, and could reset the card while you answered it. When only the start is known, as after a reload of the web app, the approval says so.
- A channel task whose agent was deleted stops and asks you to reassign it. Before, in a channel outside the General space, it waited for the deleted agent for ever, and Continue hid it with no sign.
- Continue on a stopped channel task whose agent is hidden or in another space says so, and the task stays in the list to reassign.
- The reasons of stopped channel tasks show in your language, also for tasks that stopped before this version.
- In the web app, the Permissions level of an open agent updates when someone changes it on another computer or window. Before, it kept the old level until you opened another agent.
- A second answer to a browser step that someone already finished, for example from another window, says that the step is no longer active. Before, the server logged an error and the app showed a general failure.
