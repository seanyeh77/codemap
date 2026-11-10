from mininet.topo import Topo


class Star(Topo):
    def build(self):
        self.addSwitch("s1")
