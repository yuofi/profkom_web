# PF-03: add or remove the HTTP/2 lines right after "    listen  443 ssl;" in an nginx server file.
# Usage: python3 add_http2.py add|remove <file>. Prints only the result, never the file.
import sys
mode, path = sys.argv[1], sys.argv[2]
text = open(path).read()
anchor = "    listen  443 ssl;\n"
block = ("    # HTTP/2 (ALPN h2) multiplexes the route's chunks and API calls in one connection\n"
         "    # instead of six at a time (PF-03). nginx >= 1.25.1 syntax; clients that offer only\n"
         "    # http/1.1 (WebSocket transports of server-local blocks) keep HTTP/1.1.\n"
         "    http2 on;\n")
if mode == "add":
    if text.count(anchor) != 1 or "http2" in text:
        sys.exit("STOP: expected exactly one '    listen  443 ssl;' and no 'http2' in " + path)
    text = text.replace(anchor, anchor + block)
elif mode == "remove":
    if text.count(anchor + block) != 1:
        sys.exit("STOP: the PF-03 lines are not where they were added in " + path)
    text = text.replace(anchor + block, anchor)
else:
    sys.exit("usage: add_http2.py add|remove <file>")
open(path, "w").write(text)
print(mode, "ok:", path)
