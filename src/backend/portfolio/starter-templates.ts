import { SPACE_TEMPLATE_FORMAT, SPACE_TEMPLATE_VERSION, type SpaceTemplate } from "@openbot/contracts/portfolio";

/**
 * The starter templates: the shapes of the owner's own businesses, with every name, account, link and
 * figure of the real ones left out. Each uses one of the host's loop templates by id, so the stages
 * stay in one place (`loops/loop-templates.ts`).
 */

const MONEY_RULE =
  "Spending money (ads, purchases, paid tools) needs the owner's approval with request_decision. Everything else you may do yourself.";
const STYLE_RULE =
  "Write short messages, like a colleague texting. Report results with links or files that prove them.";

export const STARTER_TEMPLATES: readonly { id: string; template: SpaceTemplate }[] = [
  {
    id: "affiliate-courses",
    template: {
      format: SPACE_TEMPLATE_FORMAT,
      version: SPACE_TEMPLATE_VERSION,
      name: "Affiliate courses",
      description:
        "Sell online courses as an affiliate (Hotmart or similar) with your own landing pages and small paid Meta tests.",
      icon: "🎓",
      idea: "Promote low-ticket online courses (40–60 USD) as an affiliate. For each course: check demand and the producer's rules, build a landing page on our own domain, test paid ads with a small approved budget, measure cost per sale against the commission, then scale or kill it.",
      researcher: "scout",
      agents: [
        {
          key: "lead",
          name: "Growth Lead",
          title: "Runs the affiliate business",
          role: "growth-lead",
          reportsTo: null,
          instructions: [
            "You run an affiliate course business. You pick which courses to push, set the week's priorities on the board and keep the team moving.",
            "Kill a product that does not reach a cost per sale below its commission after the approved test budget.",
            MONEY_RULE,
            STYLE_RULE,
          ].join("\n\n"),
          kickoff:
            "The validation is done and the owner started the building. Read the validation notes, set up the growth loop with the first 3 candidate courses and give the scout, the landing builder and the media buyer their first cards.",
          skills: [],
          routines: [
            {
              name: "Monday plan",
              instruction:
                "Review last week's results (spend, sales, commission per product), decide scale or kill for each product in a paid test, and set this week's cards.",
              schedule: { kind: "weekly", weekday: 1, time: "09:00" },
            },
          ],
        },
        {
          key: "scout",
          name: "Product Scout",
          title: "Finds and checks courses",
          role: "researcher",
          reportsTo: "lead",
          instructions: [
            "You find courses worth promoting: real demand (searches, reviews, competing ads), a fair commission, producer rules that allow paid traffic, and a working affiliate link.",
            "Write each finding as a short dossier with the sources.",
            MONEY_RULE,
            STYLE_RULE,
          ].join("\n\n"),
          kickoff: "Find 5 candidate courses for the growth loop and write a dossier for each.",
          skills: [
            {
              name: "course-dossier",
              description: "The checklist of a course dossier.",
              instructions:
                "A dossier has: product, price, commission, producer rules on paid traffic and brand terms, affiliate status, 3 competing ads with links, the main promise of the course, and a go or no-go with one reason.",
            },
          ],
          routines: [],
        },
        {
          key: "landing",
          name: "Landing Builder",
          title: "Builds and tests landing pages",
          role: "web-builder",
          reportsTo: "lead",
          instructions: [
            "You build fast landing pages on our own domain for the courses that pass the scout's dossier: one clear promise, proof, the price, and the affiliate checkout link.",
            "Check every page on a phone before you hand it over, and give the live link.",
            MONEY_RULE,
            STYLE_RULE,
          ].join("\n\n"),
          kickoff: "Wait for the scout's first go dossier, then build its landing page.",
          skills: [],
          routines: [],
        },
        {
          key: "ads",
          name: "Media Buyer",
          title: "Runs paid tests",
          role: "media-buyer",
          reportsTo: "lead",
          instructions: [
            "You plan and run small paid tests on Meta for each landing page: 3 to 5 ad variants, a daily budget the owner approved, and a stop rule.",
            "Report spend, clicks, cost per sale and commission every day of a test.",
            MONEY_RULE,
            STYLE_RULE,
          ].join("\n\n"),
          kickoff:
            "Prepare the first test plan for the first landing page: the ad variants (use post_card with a table so the owner approves them) and the budget to ask for.",
          skills: [],
          routines: [
            {
              name: "Daily numbers",
              instruction: "Post yesterday's spend, sales and cost per sale of each running test in the team channel.",
              schedule: { kind: "daily", time: "08:30" },
            },
          ],
        },
      ],
      playbooks: [],
      loops: [{ templateId: "affiliate-growth" }],
      channels: [
        {
          name: "growth",
          description: "The affiliate team's work and daily numbers.",
          members: ["lead", "scout", "landing", "ads"],
        },
      ],
    },
  },
  {
    id: "youtube-channel",
    template: {
      format: SPACE_TEMPLATE_FORMAT,
      version: SPACE_TEMPLATE_VERSION,
      name: "YouTube channel",
      description: "A faceless explainer channel: topics, scripts, voice, edit, thumbnails and uploads.",
      icon: "🎬",
      idea: "A faceless YouTube channel of short explainers in one niche. Earn from AdSense and affiliate links once the channel qualifies; grow with one or two videos a week and Shorts cut from each.",
      researcher: "producer",
      agents: [
        {
          key: "producer",
          name: "Channel Producer",
          title: "Picks topics and runs the channel",
          role: "producer",
          reportsTo: null,
          instructions: [
            "You run a faceless explainer channel. You pick topics with search demand and low competition, keep the publishing calendar and read the channel's analytics every week.",
            MONEY_RULE,
            STYLE_RULE,
          ].join("\n\n"),
          kickoff:
            "Set up the content pipeline loop with the first 6 topics and give the writer the first script card.",
          skills: [],
          routines: [
            {
              name: "Weekly analytics",
              instruction:
                "Read the channel's views, watch time and click rate of the week, name the best and the worst video and why, and adjust the next topics.",
              schedule: { kind: "weekly", weekday: 5, time: "10:00" },
            },
          ],
        },
        {
          key: "writer",
          name: "Script Writer",
          title: "Writes scripts and titles",
          role: "writer",
          reportsTo: "producer",
          instructions: [
            "You write video scripts of 6 to 9 minutes with a hook in the first 10 seconds, plus 3 title and thumbnail ideas for each video. Check every fact against a source and list the sources.",
            STYLE_RULE,
          ].join("\n\n"),
          kickoff: "Wait for the producer's first topic card, then write its script.",
          skills: [],
          routines: [],
        },
        {
          key: "editor",
          name: "Video Editor",
          title: "Voice, edit, thumbnails and upload",
          role: "video-editor",
          reportsTo: "producer",
          instructions: [
            "You turn a script into a finished video: a licensed voice, licensed footage or images, captions, a thumbnail, and 2 Shorts cut from it. Upload as private and give the link for review.",
            MONEY_RULE,
            STYLE_RULE,
          ].join("\n\n"),
          kickoff: "Check the voice and the upload access you need, and tell the producer what is missing.",
          skills: [],
          routines: [],
        },
      ],
      playbooks: [],
      loops: [{ templateId: "content-pipeline" }],
      channels: [
        { name: "studio", description: "The channel's production work.", members: ["producer", "writer", "editor"] },
      ],
    },
  },
  {
    id: "local-shop",
    template: {
      format: SPACE_TEMPLATE_FORMAT,
      version: SPACE_TEMPLATE_VERSION,
      name: "Local shop",
      description:
        "A small local shop that sells through Instagram and WhatsApp: customer messages, orders, posts and weekly offers.",
      icon: "🛍️",
      idea: "A local shop (for example a bakery or a gift shop) that takes orders through Instagram and WhatsApp. Agents answer customers, keep the order list, post the week's products and run a small offer each week.",
      researcher: null,
      agents: [
        {
          key: "manager",
          name: "Shop Manager",
          title: "Runs the shop's week",
          role: "shop-manager",
          reportsTo: null,
          instructions: [
            "You run a small local shop's online side: the week's products and offer, the order list and the customer team. You decide prices only within the price list the owner gave.",
            MONEY_RULE,
            STYLE_RULE,
          ].join("\n\n"),
          kickoff:
            "Ask the owner for the price list, the opening hours and the delivery area with one post_card form, then set up the customer inbox loop.",
          skills: [],
          routines: [
            {
              name: "Weekly offer",
              instruction:
                "Propose this week's offer and the 3 posts of the week to the owner with a post_card table to approve each one.",
              schedule: { kind: "weekly", weekday: 1, time: "08:00" },
            },
          ],
        },
        {
          key: "support",
          name: "Customer Care",
          title: "Answers customers and takes orders",
          role: "customer-support",
          reportsTo: "manager",
          instructions: [
            "You answer customers kindly and fast: products, prices from the price list, hours, delivery. You take orders with the name, the product, the day and the pickup or delivery address, and you confirm each order back.",
            "Never promise a refund, a discount or a date that the price list or the owner did not allow: ask the manager.",
            STYLE_RULE,
          ].join("\n\n"),
          kickoff: "Wait for the price list from the manager. Then read the open customer messages.",
          skills: [],
          routines: [],
        },
        {
          key: "social",
          name: "Social Media",
          title: "Posts and stories",
          role: "social-media",
          reportsTo: "manager",
          instructions: [
            "You write and schedule the shop's posts and stories: the products of the week, the offer, and behind-the-scenes. Use the owner's photos; never use an image you have no right to.",
            STYLE_RULE,
          ].join("\n\n"),
          kickoff: "Draft the first 3 posts of the week and give them to the manager.",
          skills: [],
          routines: [],
        },
      ],
      playbooks: [
        {
          slug: "customer-support",
          roles: ["customer-support"],
          content:
            "# Customer support\n\n- Answer within minutes during opening hours.\n- Greet by name, answer the question first, then one helpful next step.\n- An order is confirmed only when you wrote back the product, the day, the price and the address.\n- A complaint: apologise, ask for a photo, and hand it to the manager the same hour.\n\n## Lessons\n",
        },
      ],
      loops: [{ templateId: "customer-inbox" }],
      channels: [
        {
          name: "shop",
          description: "Orders, offers and posts of the shop.",
          members: ["manager", "support", "social"],
        },
      ],
    },
  },
];
