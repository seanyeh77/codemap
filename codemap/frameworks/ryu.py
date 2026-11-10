"""Ryu / os-ken OpenFlow controllers and Mininet topologies."""

import re

EV = re.compile(r"^@(?:\w+\.)*set_ev_cls\(\s*([\w.]+)(?:\s*,\s*(.*))?\)\s*$", re.S)
APP_BASE = re.compile(r"(RyuApp|OSKenApp)$")


class Ryu:
    name = "ryu"

    def detect(self, c):
        self.files = [f for f in c.files if f.endswith(".py") and c.imports(f, r"ryu|os_ken")]
        return bool(self.files)

    def apply(self, c):
        fw = "os-ken" if any(c.imports(f, r"os_ken") for f in self.files) else "ryu"
        for f in self.files:
            for nid in c.files[f]:
                n = c.nodes[nid]
                if n.get("kind") == "class" and any(APP_BASE.search(b) for b in n.get("bases", [])):
                    init = next((m for m in c.methods(nid) if c.nodes[m]["name"].endswith(".__init__")), nid)
                    c.entry(init, fw, "app", n['name'])
                for d in n.get("decorators", []):
                    m = EV.match(d)
                    if m:
                        event = m.group(1).rsplit(".", 1)[-1]
                        phase = ", ".join(re.findall(r"\b(\w+_DISPATCHER)\b", m.group(2) or ""))
                        c.entry(nid, fw, "event", event + (f" ({phase})" if phase else ""))
                        # the framework calls the handler when the event comes: a callback from the event
                        c.edge(c.outside(f"{fw} event {event}"), nid, "callback", f"{fw}.set_ev_cls", f, n["line"])


class Mininet:
    name = "mininet"

    def detect(self, c):
        self.files = [f for f in c.files if f.endswith(".py") and c.imports(f, r"mininet")]
        return bool(self.files)

    def apply(self, c):
        for f in self.files:
            for nid in c.files[f]:
                n = c.nodes[nid]
                if n.get("kind") == "class" and any(re.search(r"\bTopo$", b) for b in n.get("bases", [])):
                    for m in c.methods(nid):
                        if c.nodes[m]["name"].endswith(".build"):
                            c.entry(m, "mininet", "topology", n['name'])
