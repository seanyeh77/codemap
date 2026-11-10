package org.example.app;

import org.onosproject.net.packet.PacketProcessor;
import org.onosproject.net.packet.PacketContext;
import org.onosproject.net.packet.PacketService;
import org.osgi.service.component.annotations.Activate;
import org.osgi.service.component.annotations.Component;
import org.osgi.service.component.annotations.Deactivate;

@Component(immediate = true)
public class AppComponent {
    private PacketService packetService;
    private ReactivePacketProcessor processor = new ReactivePacketProcessor();

    @Activate
    protected void activate() {
        packetService.addProcessor(processor, 2);
        log("started");
    }

    @Deactivate
    protected void deactivate() {
        packetService.removeProcessor(processor);
    }

    private void log(String s) {
    }

    private class ReactivePacketProcessor implements PacketProcessor {
        @Override
        public void process(PacketContext context) {
            forward(context);
        }

        private void forward(PacketContext context) {
            log("fwd");
        }
    }
}
