# OpenBot download gateway

Streams one file per signed ticket over https, for files too large for the WebRTC connection (the
web client's data channel runs at about 2 MB/s through the relay). OpenBot authorizes the member and
mints the ticket; the gateway serves only what a valid ticket names, below `/data/OpenBot`.

- `downloadd.py`: the service (`serve`, and `install` as root). Python standard library only.
- `test_downloadd.py`: offline tests (`python3 scripts/download-gateway/test_downloadd.py`). It holds
  the same token vector as `src/main/download-tickets.test.ts` in the product repo.
- `nginx-downloads.conf`: step 1, port 80 only (certificate challenge and tests).
- `nginx-downloads-tls.conf`: step 2, https with a redirect. Use it once the certificate exists.

## Install

```bash
sudo python3 scripts/download-gateway/downloadd.py install      # key file, unit, service
sudo cp scripts/download-gateway/nginx-downloads.conf /etc/nginx/conf.d/openbot-downloads.conf
sudo nginx -t && sudo systemctl reload nginx
```

The unit runs as `ubuntu` and sees only `/opt/openbot/data/OpenBot` and the key file, read-only.
The script lives in `/usr/local/lib/openbot-downloads`, outside the hidden `/opt/openbot`.

## Turn it on (needs the DNS name)

1. A **DNS-only** A record `dl.delynith.com` -> `158.69.224.199` (no Cloudflare proxy).
2. `sudo certbot certonly --webroot -w /var/www/openbot-acme -d dl.delynith.com --cert-name openbot-downloads --deploy-hook "systemctl reload nginx"`
3. Replace the nginx file with `nginx-downloads-tls.conf`, `nginx -t`, reload.
4. `echo https://dl.delynith.com > /opt/openbot/data/.config/OpenBot/download-base-url`. OpenBot reads
   it on each ticket, so no restart. Remove the file to turn the feature off.

## Behaviour

- Ticket lifetime 15 minutes. One ticket names one file. Several requests inside the lifetime are
  fine, so a browser can resume with `Range`.
- Any refusal is an empty 404: expired, wrong signature, outside the folder, missing, directory.
- `Content-Disposition: attachment`, `application/octet-stream`, `nosniff`, `no-store`.
- At most 16 concurrent transfers in the service and 8 per address in nginx. Nothing is logged about
  the ticket.
