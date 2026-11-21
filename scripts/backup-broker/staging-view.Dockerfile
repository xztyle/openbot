# The staging copy's screen in a browser: x11vnc on the staging display, served by noVNC. It only
# shares the X11 socket volume with the staging display; it has no route to the staging container.
# Published on 127.0.0.1 only; staging.delynith.com (Cloudflare Access) is the way in from outside.
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      x11vnc novnc websockify python3 && rm -rf /var/lib/apt/lists/* && \
    ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html && \
    groupadd -g 1001 view && useradd -u 1001 -g 1001 -M -d /tmp view
USER 1001:1001
EXPOSE 6080
CMD ["sh", "-c", "x11vnc -display :0 -noshm -forever -shared -nopw -localhost -rfbport 5900 -quiet -bg -o /tmp/x11vnc.log && exec websockify --web /usr/share/novnc 6080 127.0.0.1:5900"]
