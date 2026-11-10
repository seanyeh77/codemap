from os_ken.base import app_manager
from os_ken.controller import ofp_event
from os_ken.controller.handler import MAIN_DISPATCHER, set_ev_cls


class Switch(app_manager.OSKenApp):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.table = {}

    @set_ev_cls(ofp_event.EventOFPPacketIn, MAIN_DISPATCHER)
    def packet_in(self, ev):
        self.learn(ev)

    def learn(self, ev):
        self.table[ev] = 1
