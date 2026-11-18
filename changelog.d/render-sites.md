### Added

- Publish landing pages on Render.com with the new `openbot-render-sites` skill. Agents push a landing's
  files to the user's GitHub landings repository (one folder per landing), create the static site, wait
  for the deploy, and put it on the user's own domain with a Cloudflare DNS record. The helper changes
  only the DNS records it made. Deleting a site, suspending it or removing a domain needs the user's
  request, and every change goes to an audit log.
