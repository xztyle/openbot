# Connector gateway

The connector gateway is the host's inbound HTTP door for outside systems. It serves two things:

- `/mcp`: the owner's MCP endpoint. A chat app such as Claude or ChatGPT reaches the agents with
  text tools.
- `/hooks/<route id>`: the inbox of a webhook routine. Stripe, Hotmart, YouTube or any system that
  signs with Atelier's scheme starts the routine directly.

Each path authenticates on its own. Anything else answers 404.

## Turn it on (server operator)

The gateway listens only when `OPENBOT_CONNECTOR_LISTEN` is set, as `host:port`:

| Variable | Example | Meaning |
| --- | --- | --- |
| `OPENBOT_CONNECTOR_LISTEN` | `0.0.0.0:8452` | Where the gateway listens. Use a private address and put an HTTPS proxy in front. |
| `OPENBOT_CONNECTOR_PUBLIC_URL` | `https://connect.example.com` | The public HTTPS address of the proxy. Settings build the links from it. |

Put an HTTPS reverse proxy in front, with a certificate for the public name. Keep the URL path out
of the access log: an MCP link carries its token in the path. With nginx:

```nginx
server {
  listen 443 ssl;
  server_name connect.example.com;
  # ssl_certificate ...;
  access_log off;
  client_max_body_size 300k;
  location / {
    proxy_pass http://<container address>:8452;
    proxy_set_header Host $host;
    proxy_read_timeout 70s;
  }
}
```

Restart the host after a change to the variables. Settings say when the address is not set.

## Reach the agents from a chat app

1. Open **Secrets** in the workspace. Under **Chat apps**, choose **New access link**, and name the
   app that uses it.
2. Copy the link. Atelier shows it once. It has the form
   `https://connect.example.com/mcp/atm_…`.
3. In the chat app, add a custom connector (remote MCP server) with that URL and no other
   authentication. A client that can send headers can also use `https://…/mcp` with
   `Authorization: Bearer atm_…`.

The tools:

| Tool | What it does |
| --- | --- |
| `list_agents` | The agents that take messages: id, name, role and space. |
| `send_message` | Sends a message to one agent as the owner, the same as typing it in Atelier. Answers a `deliveryId`. |
| `get_reply` | The state of a sent message and the agent's answer once it finished. It waits up to 40 seconds. |
| `read_messages` | The latest messages between the owner and one agent. |
| `list_decisions` | What waits for the owner: questions, approvals, sign-in steps, loop gates and requests held for later. |

The endpoint answers no approval and spends nothing: the owner decides those in Atelier, where the
whole card shows. It sends at most 60 messages an hour. A caller that is refused 20 times in a
minute gets 429 for the rest of that minute. Revoke a link in **Secrets** to stop it at once. At
most 10 links can exist.

## Webhook inboxes

Each webhook routine (see [Webhooks](webhooks.md)) has an inbox address
`https://connect.example.com/hooks/<route id>`. **Secrets → Webhooks into this space** lists the
routines of the space with **Copy address** and **Sender**:

| Sender | Signature | Secret to paste |
| --- | --- | --- |
| Atelier signature | `X-OpenBot-*` headers, as in [Webhooks](webhooks.md) | None: the routine's own secret. |
| Stripe | `Stripe-Signature` (`t=…,v1=…`), at most 5 minutes old | The endpoint's signing secret, `whsec_…`, from Stripe's Developers → Webhooks. |
| Hotmart | `X-HOTMART-HOTTOK`, webhook version 2.0.0 | The account's hottok, from Hotmart's webhook settings. |
| YouTube | WebSub: `X-Hub-Signature: sha1=…` | A secret you choose. Subscribe the address to `https://www.youtube.com/xml/feeds/videos.xml?channel_id=<id>` at `https://pubsubhubbub.appspot.com/subscribe` with the same `hub.secret`. The inbox answers the subscription check. |

A verified event starts the routine as a relayed one does: the event type and filters, the
receipts (the provider's event ID is the delivery ID, so a retry runs once), quiet runs and the
hourly limit apply, and the agent reads the event as data. The event types are Stripe's `type`
(such as `checkout.session.completed`), Hotmart's `event` (such as `PURCHASE_APPROVED`), and
`youtube.video` or `youtube.video.deleted`. Contact fields (email, phone, document, address, IP) are
masked before the agent reads the event; the agent reads a sale with the Hotmart helper when it
needs the buyer.

Sender secrets are encrypted with the host's secret storage. The inbox keeps the time and status
of the last request, which settings show.

To start a Loop from an event, write the routine task so that the agent moves the Loop, for
example: "A Hotmart sale arrived. Add it to the Sales loop."
