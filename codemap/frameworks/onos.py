"""ONOS applications: OSGi components, their lifecycle, and the processors and listeners they register."""

import re

from ..source import lines

LIFECYCLE = {"@Activate": "activate", "@Deactivate": "deactivate", "@Modified": "modified"}
REGISTER = re.compile(r"\.(addProcessor|addListener|addPacketProcessor|register)\(\s*(\w+)")


class Onos:
    name = "onos"

    def detect(self, c):
        self.files = [f for f in c.files if f.endswith(".java") and c.imports(f, r"org\.onosproject|org\.osgi")]
        return bool(self.files)

    def apply(self, c):
        handler_of = {}                          # class name -> its process()/event() method
        for f in self.files:
            for nid in c.files[f]:
                n = c.nodes[nid]
                if n.get("kind") == "class":
                    if any(d.startswith("@Component") for d in n.get("decorators", [])):
                        c.entry(nid, "onos", "component", "OSGi")
                    for b in n.get("bases", []):
                        what = "process" if b.endswith("PacketProcessor") else "event" if b.endswith("Listener") else None
                        if what:
                            for m in c.methods(nid):
                                if c.nodes[m]["name"].endswith("." + what):
                                    c.entry(m, "onos", "callback", f"{b}.{what}()")
                                    handler_of[n["name"].rsplit(".", 1)[-1]] = m
                for d in n.get("decorators", []):
                    if d in LIFECYCLE:
                        c.entry(nid, "onos", "lifecycle", LIFECYCLE[d])
        # processor = new ReactivePacketProcessor(); packetService.addProcessor(processor, ...)
        for f in self.files:
            text = lines(c.root / f)
            fields = dict(re.findall(r"(\w+)\s*=\s*new\s+(\w+)\s*\(", "\n".join(text)))
            for nid in c.files[f]:
                n = c.nodes[nid]
                if n.get("kind") != "method":
                    continue
                for i in range(n["line"] - 1, min(n.get("end", n["line"]), len(text))):
                    for verb, var in REGISTER.findall(text[i]):
                        h = handler_of.get(fields.get(var, var))
                        if h:
                            c.edge(nid, h, "callback", f"onos.{verb}", f, i + 1)
